import { randomUUID } from 'node:crypto'
import { findQwenWebModel, normalizeQwenWebModel } from './qwen-models.mjs'
import { qwenWebAccountManager } from './qwen-web-accounts.mjs'

const BASE_URL = 'https://chat.qwen.ai'
const CHATS_NEW_URL = `${BASE_URL}/api/v2/chats/new`
const CHAT_COMPLETIONS_URL = `${BASE_URL}/api/v2/chat/completions`
const USER_AGENT =
  process.env.QWEN_WEB_USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0'

const BX_VERSION = '2.5.37'
const BX_UMIDTOKEN_FALLBACK = 'T2gAQbxKjwC5hjmn8NKf_HIfW96hTuaXMPwE0GUzBFMwqa-PDebJqjpOLLIOGD7I-kk='
const QWEN_SPA_VERSION = '0.2.86'

export function stripCookieInputPrefix(rawValue) {
  const trimmed = String(rawValue || '').trim()
  if (!trimmed) return ''
  const withoutBearer = trimmed.replace(/^bearer\s+/i, '')
  return withoutBearer.replace(/^cookie:\s*/i, '').trim()
}

export function buildQwenCookieHeader(rawValue) {
  const trimmed = stripCookieInputPrefix(rawValue)
  if (!trimmed) return ''
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      if (Array.isArray(arr)) {
        return arr
          .filter((item) => item && typeof item === 'object' && item.name && item.value != null)
          .map((item) => `${item.name}=${item.value}`)
          .join('; ')
      }
    } catch {}
  }
  return trimmed
}

export function extractQwenToken(rawValue) {
  const trimmed = stripCookieInputPrefix(rawValue)
  if (!trimmed) return ''
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      if (Array.isArray(arr)) {
        const item = arr.find((i) => i && i.name === 'token')
        if (item?.value) return String(item.value)
      }
    } catch {}
  }
  if (!trimmed.includes('=')) return trimmed
  const match = trimmed.match(/(?:^|;\s*)token=([^;\s]+)/)
  return match ? match[1] : ''
}

export function isWafResponse(status, contentType, bodyText) {
  if (contentType.includes('text/html')) return true
  if (status === 504 || status === 403) {
    if (/aliyun_waf|baxia|<html/i.test(bodyText)) return true
  }
  return /aliyun_waf|baxia|<html/i.test(bodyText)
}

const TOOL_BLOCK_RE = /<tool>\s*([\s\S]*?)\s*<\/tool>/g
const TOOL_CALL_TAG_RE = /<tool_call(?:\s+[^>]*)?\s*>\s*([\s\S]*?)\s*<\/tool_call>/g

export function parseLooseJsonObject(raw) {
  const trimmed = String(raw || '')
    .trim()
    .replace(/^```(?:json|javascript|js)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  try {
    return JSON.parse(trimmed)
  } catch {}
  try {
    const fixed = trimmed
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
      .replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(fixed)
  } catch {}
  return null
}

export function stripRanges(text, ranges) {
  let content = text
  const sorted = [...ranges].sort((a, b) => b.start - a.start)
  for (const range of sorted) {
    const lineStart = content.lastIndexOf('\n', range.start - 1) + 1
    const nextLineBreak = content.indexOf('\n', range.end)
    const lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak
    const beforeOnLine = content.slice(lineStart, range.start)
    const afterOnLine = content.slice(range.end, lineEnd)
    const removeWholeLine = beforeOnLine.trim() === '' && afterOnLine.trim() === ''
    const start = removeWholeLine ? lineStart : range.start
    const end =
      removeWholeLine && nextLineBreak !== -1
        ? nextLineBreak + 1
        : removeWholeLine
          ? lineEnd
          : range.end
    content = `${content.slice(0, start)}${content.slice(end)}`
  }
  return content.replace(/\n{3,}/g, '\n\n').trim()
}

export function parseToolCallsFromText(text, idSeed = 'call') {
  if (typeof text !== 'string' || (!text.includes('<tool>') && !text.includes('<tool_call'))) {
    return { content: text ?? '', toolCalls: null }
  }

  const candidates = []
  let match
  TOOL_BLOCK_RE.lastIndex = 0
  while ((match = TOOL_BLOCK_RE.exec(text)) !== null) {
    candidates.push({ raw: match[1].trim(), start: match.index, end: TOOL_BLOCK_RE.lastIndex })
  }
  TOOL_CALL_TAG_RE.lastIndex = 0
  while ((match = TOOL_CALL_TAG_RE.exec(text)) !== null) {
    candidates.push({ raw: match[1].trim(), start: match.index, end: TOOL_CALL_TAG_RE.lastIndex })
  }

  candidates.sort((a, b) => a.start - b.start)

  const toolCalls = []
  const acceptedRanges = []
  for (const candidate of candidates) {
    const parsed = parseLooseJsonObject(candidate.raw)
    const name = parsed?.name || parsed?.command || null
    if (name) {
      const args = parsed.arguments != null ? (typeof parsed.arguments === 'string' ? parseLooseJsonObject(parsed.arguments) || {} : parsed.arguments) : {}
      toolCalls.push({
        id: `${idSeed}_${toolCalls.length}`,
        type: 'tool_use',
        name,
        input: args,
      })
      acceptedRanges.push({ start: candidate.start, end: candidate.end })
    }
  }

  if (toolCalls.length === 0) {
    return { content: text, toolCalls: null }
  }

  const content = stripRanges(text, acceptedRanges)
  return { content, toolCalls }
}

export function serializeToolsToPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const lines = []
  for (const t of tools) {
    const name = t.name || t.function?.name
    if (!name) continue
    const desc = t.description || t.function?.description || ''
    const schema = t.input_schema || t.parameters || t.function?.parameters || null
    let paramsStr = ''
    try {
      if (schema) paramsStr = JSON.stringify(schema)
    } catch {}
    lines.push(`- ${name}${desc ? `: ${desc}` : ''}${paramsStr ? `\n  parameters: ${paramsStr}` : ''}`)
  }
  if (!lines.length) return ''

  return [
    'The client application provides tools. To invoke one, reply with a single line containing a <tool> block with JSON:',
    '<tool>{"name": "<tool_name>", "arguments": { ... }}</tool>',
    'Only emit the <tool> block when you actually want to call a tool; otherwise answer normally.',
    '',
    'Available tools:',
    ...lines,
  ].join('\n')
}

export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          if (part.type === 'text' && typeof part.text === 'string') return part.text
          if (part.type === 'tool_result') {
            const body = typeof part.content === 'string' ? part.content : textOfContent(part.content)
            return `[Tool Result ${part.tool_use_id || ''}]:\n${body}`
          }
          if (part.type === 'tool_use') {
            return `<tool>{"name":"${part.name}","arguments":${JSON.stringify(part.input || {})}}</tool>`
          }
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content == null ? '' : String(content)
}

export function foldAnthropicMessages(body) {
  let systemText = ''
  if (body.system) systemText = textOfContent(body.system)

  const toolsPrompt = serializeToolsToPrompt(body.tools)
  if (toolsPrompt) {
    systemText = systemText ? `${systemText}\n\n${toolsPrompt}` : toolsPrompt
  }

  let dialog = ''
  for (const msg of body.messages || []) {
    const role = msg.role === 'assistant' ? 'Assistant' : 'User'
    const text = textOfContent(msg.content)
    if (!text.trim()) continue
    dialog += (dialog ? '\n\n' : '') + `${role}: ${text}`
  }

  if (systemText) {
    return `System:\n${systemText}\n\n${dialog}`
  }
  return dialog || 'Hello'
}

function sanitizeHeader(val) {
  if (!val) return ''
  return String(val).replace(/[^\x09\x20-\x7E\x80-\xFF]/g, '')
}

export class QwenWebClient {
  constructor(accountManager = null) {
    this.accountManager = accountManager
  }

  getManager() {
    return this.accountManager || qwenWebAccountManager
  }

  buildHeaders(token, cookieHeader, chatId = null) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'User-Agent': USER_AGENT,
      Origin: BASE_URL,
      Referer: chatId ? `${BASE_URL}/c/${chatId}` : `${BASE_URL}/`,
      source: 'web',
      version: QWEN_SPA_VERSION,
      'x-request-id': randomUUID(),
      'bx-v': BX_VERSION,
      'bx-umidtoken': BX_UMIDTOKEN_FALLBACK,
    }
    if (token) headers['Authorization'] = `Bearer ${sanitizeHeader(token)}`
    if (cookieHeader) headers['Cookie'] = sanitizeHeader(cookieHeader)
    return headers
  }

  async executeTurn(body, options = {}) {
    const { onAccountSelected = null, signal = null } = options
    const requestedModel = body.model || 'qwen3.8-max'
    const modelId = normalizeQwenWebModel(requestedModel) || 'qwen3.8-max'
    const modelMeta = findQwenWebModel(modelId)

    const manager = this.getManager()
    const availableAccounts = manager ? manager.getAvailableAccounts(modelId) : []
    const maxAttempts = Math.max(1, availableAccounts.length)

    let lastError = null

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const turnSelection = manager ? await manager.getAccountForTurn(modelId) : { error: 'No manager' }
      if (turnSelection.error || !turnSelection.cookie) {
        throw new Error(turnSelection.error || 'No active Qwen Web cookies configured. Add one via `claude-zen --qwen-accounts add`.')
      }

      const account = turnSelection.account
      const rawCookie = turnSelection.cookie
      const cookieHeader = buildQwenCookieHeader(rawCookie)
      const token = extractQwenToken(rawCookie)

      if (account && onAccountSelected) onAccountSelected(account.email)

      try {
        const isStream = !!body.stream
        const prompt = foldAnthropicMessages(body)
        const hasTools = Array.isArray(body.tools) && body.tools.length > 0

        // Step 1: Create chat session
        const newChatRes = await fetch(CHATS_NEW_URL, {
          method: 'POST',
          headers: this.buildHeaders(token, cookieHeader),
          body: JSON.stringify({
            title: 'Claude-Zen Chat',
            models: [modelId],
            chat_mode: 'normal',
            chat_type: 't2t',
            timestamp: Date.now(),
          }),
          signal,
        })

        const ct1 = newChatRes.headers.get('content-type') || ''
        if (!newChatRes.ok || ct1.includes('text/html')) {
          const text = await newChatRes.text().catch(() => '')
          if (isWafResponse(newChatRes.status, ct1, text)) {
            manager?.markRateLimited(account.email, 300000, 'Qwen WAF / Session Expired', modelId)
            continue
          }
          throw new Error(`Qwen create-chat failed (${newChatRes.status}): ${text.slice(0, 300)}`)
        }

        const newChatData = await newChatRes.json()
        const chatId = newChatData?.data?.id
        if (!chatId) {
          const detail = newChatData?.msg || newChatData?.message || (newChatData?.data ? JSON.stringify(newChatData.data) : JSON.stringify(newChatData))
          throw new Error(`Qwen create-chat failed: ${detail}. Ensure your cookie contains a valid "token=..." or Bearer token from chat.qwen.ai.`)
        }

        // Step 2: Send completion request
        const enableThinking = modelMeta?.supportsThinking ?? (modelId === 'qwen3.8-max')
        const completionPayload = {
          stream: true,
          incremental_output: true,
          chat_id: chatId,
          chat_mode: 'normal',
          model: modelId,
          parent_id: null,
          messages: [
            {
              fid: randomUUID(),
              parentId: null,
              childrenIds: [],
              role: 'user',
              content: prompt,
              user_action: 'chat',
              files: [],
              timestamp: Math.floor(Date.now() / 1000),
              models: [modelId],
              chat_type: 't2t',
              feature_config: {
                thinking_enabled: enableThinking,
                output_schema: 'phase',
                auto_thinking: enableThinking,
                research_mode: 'normal',
                auto_search: false,
              },
              sub_chat_type: 't2t',
              parent_id: null,
            },
          ],
        }

        const completionUrl = `${CHAT_COMPLETIONS_URL}?chat_id=${chatId}`
        const upstream = await fetch(completionUrl, {
          method: 'POST',
          headers: this.buildHeaders(token, cookieHeader, chatId),
          body: JSON.stringify(completionPayload),
          signal,
        })

        const ct2 = upstream.headers.get('content-type') || ''
        if (!upstream.ok || ct2.includes('text/html') || ct2.includes('application/json')) {
          const text = await upstream.text().catch(() => '')
          let isBlocked = !upstream.ok || ct2.includes('text/html') || isWafResponse(upstream.status, ct2, text)
          let errorMsg = text.slice(0, 300)
          try {
            const parsed = JSON.parse(text)
            if (parsed.ret && Array.isArray(parsed.ret) && parsed.ret.includes('FAIL_SYS_USER_VALIDATE')) {
              isBlocked = true
              errorMsg = 'Alibaba WAF anti-bot challenge (RGV587). Please provide the full untruncated Cookie jar including tfstk & ssxmod_itna2.'
            } else if (parsed.success === false && parsed.data?.code) {
              isBlocked = true
              errorMsg = `Qwen error: ${parsed.data.code}`
            }
          } catch {}

          if (isBlocked || upstream.status === 429) {
            manager?.markRateLimited(account.email, 300000, errorMsg, modelId)
            throw new Error(`Qwen completion blocked: ${errorMsg}`)
          }
        }

        if (isStream) {
          return {
            type: 'stream',
            accountEmail: account.email,
            model: modelId,
            generator: this.streamAnthropicEvents(upstream, modelId, hasTools, signal),
          }
        } else {
          return await this.collectAnthropicResponse(upstream, modelId, hasTools)
        }
      } catch (err) {
        lastError = err
        if (account && /waf|session|cookie|401|403|429/i.test(err.message)) {
          manager?.markRateLimited(account.email, 300000, err.message, modelId)
          continue
        }
        throw err
      }
    }

    throw lastError || new Error('All Qwen Web accounts failed or rate-limited')
  }

  async *streamAnthropicEvents(upstream, modelId, hasTools, signal) {
    const messageId = `msg_qwen_${Date.now()}`
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    }

    let blockIndex = 0
    let currentBlockType = null // 'thinking' | 'text'
    let accumulatedAnswer = ''
    let accumulatedThinking = ''

    const reader = upstream.body?.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    if (!reader) {
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 },
      }
      yield { type: 'message_stop' }
      return
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (signal?.aborted) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue

          let parsed
          try {
            parsed = JSON.parse(payload)
          } catch {
            continue
          }

          const delta = parsed?.choices?.[0]?.delta
          if (!delta) continue
          const phase = delta.phase
          const content = typeof delta.content === 'string' ? delta.content : ''
          if (!content) continue

          if (phase === 'think' || phase === 'thinking_summary') {
            accumulatedThinking += content
            if (currentBlockType !== 'thinking') {
              if (currentBlockType === 'text') {
                yield { type: 'content_block_stop', index: blockIndex }
                blockIndex++
              }
              currentBlockType = 'thinking'
              yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'thinking', thinking: '' },
              }
            }
            yield {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'thinking_delta', thinking: content },
            }
          } else if (phase === 'answer' || phase == null) {
            accumulatedAnswer += content
            if (!hasTools) {
              if (currentBlockType !== 'text') {
                if (currentBlockType === 'thinking') {
                  yield { type: 'content_block_stop', index: blockIndex }
                  blockIndex++
                }
                currentBlockType = 'text'
                yield {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'text', text: '' },
                }
              }
              yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: content },
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock?.()
    }

    if (currentBlockType) {
      yield { type: 'content_block_stop', index: blockIndex }
      blockIndex++
      currentBlockType = null
    }

    let finishReason = 'end_turn'

    if (hasTools) {
      const { content: cleanText, toolCalls } = parseToolCallsFromText(accumulatedAnswer, `call_${Date.now()}`)
      if (cleanText) {
        yield {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: '' },
        }
        yield {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: cleanText },
        }
        yield { type: 'content_block_stop', index: blockIndex }
        blockIndex++
      }

      if (toolCalls && toolCalls.length > 0) {
        finishReason = 'tool_use'
        for (const tool of toolCalls) {
          yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: tool.id,
              name: tool.name,
              input: {},
            },
          }
          yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(tool.input || {}),
            },
          }
          yield { type: 'content_block_stop', index: blockIndex }
          blockIndex++
        }
      }
    } else if (!accumulatedAnswer && !accumulatedThinking) {
      yield {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: 'OK' },
      }
      yield { type: 'content_block_stop', index: blockIndex }
    }

    const estTokens = Math.max(1, Math.ceil((accumulatedAnswer.length + accumulatedThinking.length) / 4))
    yield {
      type: 'message_delta',
      delta: { stop_reason: finishReason, stop_sequence: null },
      usage: { output_tokens: estTokens },
    }
    yield { type: 'message_stop' }
  }

  async collectAnthropicResponse(upstream, modelId, hasTools) {
    const reader = upstream.body?.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let answerText = ''
    let thinkingText = ''

    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const delta = JSON.parse(payload)?.choices?.[0]?.delta
              if (!delta) continue
              if (delta.phase === 'think' || delta.phase === 'thinking_summary') {
                thinkingText += delta.content || ''
              } else if (delta.phase === 'answer' || delta.phase == null) {
                answerText += delta.content || ''
              }
            } catch {}
          }
        }
      } finally {
        reader.releaseLock?.()
      }
    }

    const content = []
    if (thinkingText) {
      content.push({ type: 'thinking', thinking: thinkingText })
    }

    let stopReason = 'end_turn'
    if (hasTools) {
      const { content: cleanText, toolCalls } = parseToolCallsFromText(answerText, `call_${Date.now()}`)
      if (cleanText) content.push({ type: 'text', text: cleanText })
      if (toolCalls && toolCalls.length) {
        stopReason = 'tool_use'
        for (const tool of toolCalls) {
          content.push({
            type: 'tool_use',
            id: tool.id,
            name: tool.name,
            input: tool.input || {},
          })
        }
      }
    } else {
      content.push({ type: 'text', text: answerText || 'OK' })
    }

    const outputTokens = Math.max(1, Math.ceil((answerText.length + thinkingText.length) / 4))
    return {
      type: 'json',
      response: {
        id: `msg_qwen_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: modelId,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: outputTokens },
      },
    }
  }
}

export const qwenWebClient = new QwenWebClient()
