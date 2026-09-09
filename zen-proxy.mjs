#!/usr/bin/env node
// Anthropic Messages API -> OpenCode Zen/Go bridge.
//
// Why this exists: Zen's regular /v1/messages shim mangles tool schemas
// ("tools[0].function: missing field `name`") on every free model, but the
// same models handle tools correctly on /v1/chat/completions. Claude Code
// only speaks Anthropic, so we translate in the middle.
//
//   ZEN_API_KEY=sk-... node zen-proxy.mjs
//   -> listens on http://127.0.0.1:8787


import http from 'node:http'
import { createHash } from 'node:crypto'
import { getDb, recordRequest } from './lib/db.mjs'
import { zenAccountManager } from './lib/zen-accounts.mjs'
import {
  applyNativeReasoningEffort,
  activityStatus,
  anthropicActivity,
  errorMessage,
  estimateTokens,
  isThinkingOnlyMaxTokens,
  lowerReasoningEffort,
  openAiActivity,
  reasoningEffortFor,
  upstreamAccount,
} from './lib/activity.mjs'
import { VIRTUAL_MODELS, resolveVirtualRoute, zenFallbackForRoute } from './lib/routing-profiles.mjs'
import { codexAnthropicModels, parseCodexModelSelection } from './lib/codex-models.mjs'
import { openCodeCooldownMs, openCodeIdentityHeaders } from './lib/opencode-zen.mjs'
import { qwenAccountManager, QWEN_MODELS as QWEN_CHAT_MODEL_LIST } from './lib/qwen-accounts.mjs'
import { qwenWebAccountManager } from './lib/qwen-web-accounts.mjs'
import { qwenWebClient } from './lib/qwen-web-client.mjs'

//https://opencode.ai/zen/go/v1/chat/completions

const GO_UPSTREAM = process.env.ZEN_GO_BASE_URL ?? 'https://opencode.ai/zen/go/v1'
const FREE_UPSTREAM = process.env.ZEN_FREE_BASE_URL ?? 'https://opencode.ai/zen/v1'
const ANTIGRAVITY_UPSTREAM = process.env.ANTIGRAVITY_BASE_URL ?? 'http://127.0.0.1:8788/v1'
const ANTIGRAVITY_MODELS = new Set(
  (process.env.ANTIGRAVITY_MODELS ?? 'gemini-3.8-flash-tiered,gemini-3.1-pro-low,gemini-pro-agent,claude-opus-4-6-thinking,claude-sonnet-4-6')
    .split(',').map((m) => m.trim()).filter(Boolean),
)
const CODEX_UPSTREAM = process.env.CODEX_BASE_URL ?? 'http://127.0.0.1:8789/v1'
const CODEX_MODELS = new Set(
  (process.env.CODEX_MODELS ?? 'gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini,o3,o4-mini,codex-auto-review')
    .split(',').map((m) => m.trim()).filter(Boolean),
)
const QWEN_UPSTREAM = process.env.QWEN_CHAT_BASE_URL ?? 'https://qwen.aikit.club/v1'
const QWEN_MODELS = new Set(QWEN_CHAT_MODEL_LIST)

// When every Antigravity/Codex account is rate-limited for a direct model
// request (no routing-profile fallback), fall through to a Zen model so the
// session stays alive instead of returning a hard 429 to the client.
const ZEN_FALLBACK_DEFAULT = process.env.ZEN_FALLBACK_MODEL || 'glm-5'
function zenFallbackForModel(model) {
  if (model.startsWith('claude-opus')) return process.env.ZEN_FALLBACK_MODEL_OPUS || 'qwen3.7-plus'
  if (model.startsWith('claude-sonnet')) return process.env.ZEN_FALLBACK_MODEL_SONNET || ZEN_FALLBACK_DEFAULT
  return ZEN_FALLBACK_DEFAULT
}

const API_KEY = process.env.ZEN_API_KEY
const PORT = Number(process.env.PORT ?? 8787)
const DEBUG = process.env.ZEN_DEBUG === '1'
const NATIVE_GO_MODELS = new Set(['qwen3.7-plus'])

// Claude Code asks the configured Anthropic endpoint for this catalog when it
// builds /model.  Zen exposes an OpenAI catalog instead, so provide the small
// Anthropic-shaped catalog locally.  The IDs are passed through unchanged and
// the normal routing below sends *-free models to Zen Free and the rest to Go.
const MODEL_CATALOG = [
  [VIRTUAL_MODELS.opus, 'Claude-Zen Opus (active profile)'],
  [VIRTUAL_MODELS.sonnet, 'Claude-Zen Sonnet (active profile)'],
  [VIRTUAL_MODELS.haiku, 'Claude-Zen Haiku (active profile)'],
  ['nemotron-3.5-lightning-free', 'Nemotron 3.5 Lightning Free'],
  ['ling-3.0-tiny-free', 'Ling 3.0 Tiny Free'],
  ['laguna-s-2.1-free', 'Laguna S 2.1 Free'],
  ['hy3-free', 'Hy3 Free'],
  ['nemotron-3-ultra-free', 'Nemotron 3 Ultra Free'],
  ['mimo-v2.5-free', 'MiMo V2.5 Free'],
  ['x-preview-f-free', 'Ox Alpha Free'],
  ['qwen3.7-plus', 'Qwen 3.7 Plus'],
  ['mimo-v2.5', 'MiMo V2.5'],
  ['minimax-m3', 'MiniMax M3'],
  ['kimi-k3', 'Kimi K3'],
  ['glm-5', 'GLM 5'],
  ['gemini-3.8-flash-tiered', 'Gemini 3.8 Flash (tiered)'],
  ['gemini-3.1-pro-low', 'Gemini 3.1 Pro Low (Antigravity)'],
  ['gemini-pro-agent', 'Gemini 3.1 Pro High (Antigravity)'],
  ['claude-opus-4-6-thinking', 'Claude Opus 4.6 Thinking (Antigravity)'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6 Thinking (Antigravity)'],
  ['qwen-chat:qwen3.7-plus', 'Qwen Chat (3.7 Plus)'],
  ['qwen-chat:qwen3.8-max', 'Qwen Chat (3.8 Max)'],
  ['qwen-chat:qwen-deep-research', 'Qwen Chat (Deep Research)'],
  ['qwen-web:qwen3.8-max', 'Qwen Web (3.8 Max, direct chat.qwen.ai)'],
  ['qwen-web:qwen3.7-max', 'Qwen Web (3.7 Max, direct chat.qwen.ai)'],
  ['qwen-web:qwen3.7-plus', 'Qwen Web (3.7 Plus, direct chat.qwen.ai)'],
  ['qwen-web:qwen3.6-plus', 'Qwen Web (3.6 Plus, direct chat.qwen.ai)'],
]

const anthropicModels = () => [
  ...MODEL_CATALOG.map(([id, display_name]) => ({
    type: 'model', id, display_name, created_at: '2026-01-01T00:00:00Z',
    input_modalities: ['text', 'image'], output_modalities: ['text'], max_tokens: 128000,
  })),
  ...codexAnthropicModels(),
]


getDb()
await zenAccountManager.init()
qwenAccountManager.init()
qwenWebAccountManager.init()

if (!API_KEY && zenAccountManager.accounts.length === 0) {
  console.warn('[zen-proxy] Warning: No ZEN_API_KEY set and no Zen accounts found in database. You can add accounts via Dashboard or `claude-zen --zen-accounts add`.')
}


const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')


// Some reasoning models reject a replayed assistant turn unless its
// original `reasoning_content` comes back with it. Claude Code has no such
// concept, so we stash it here and re-attach on the way back up. Keyed by
// tool_call id when the turn called tools, and by a hash of the reply text
// otherwise -- a text-only turn has no id to hang it on. Bounded so a long
// session can't grow this without limit.
const reasoningByKey = new Map()
const REASONING_MAX = 500

// Tool continuations stay on the provider/model that created the tool_use,
// even if the user activates another routing profile before tool_result.
const routeByToolCallId = new Map()
const ROUTE_AFFINITY_TTL_MS = 30 * 60 * 1000
const ROUTE_AFFINITY_MAX = 2000

function rememberToolRoute(callId, route) {
  if (!callId || !route) return
  routeByToolCallId.set(callId, { ...route, expiresAt: Date.now() + ROUTE_AFFINITY_TTL_MS })
  while (routeByToolCallId.size > ROUTE_AFFINITY_MAX) {
    routeByToolCallId.delete(routeByToolCallId.keys().next().value)
  }
}

function pinnedRouteForBody(body) {
  const ids = []
  // Only the newest client message can continue an in-flight tool call.
  // Full-history scans pinned a session to an old profile for 30 minutes.
  const newest = body.messages?.[body.messages.length - 1]
  for (const message of newest ? [newest] : []) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool_result' && block.tool_use_id) ids.push(block.tool_use_id)
    }
  }
  let pinned = null
  for (const id of ids) {
    const route = routeByToolCallId.get(id)
    if (!route) continue
    if (route.expiresAt <= Date.now()) {
      routeByToolCallId.delete(id)
      continue
    }
    if (pinned && (pinned.provider !== route.provider || pinned.model !== route.model)) {
      throw new Error('Tool results belong to different routing sessions')
    }
    pinned = route
  }
  return pinned
}

function rememberRoutesFromAnthropic(rawText, route) {
  try {
    const json = typeof rawText === 'string' ? JSON.parse(rawText) : rawText
    for (const block of json.content || []) {
      if (block?.type === 'tool_use') rememberToolRoute(block.id, route)
    }
  } catch {}
}

// Stand-in for reasoning we don't have: after a proxy restart the cache is
// empty but Claude Code still replays the whole conversation, and every turn
// then 400s. Upstream only checks the field is present, so a stub keeps the
// session alive instead of wedging it permanently.
const REASONING_STUB = '(reasoning omitted)'

const textKey = (text) =>
  'text:' + createHash('sha1').update(text).digest('hex').slice(0, 16)

function remember(key, reasoning) {
  if (!key || !reasoning) return
  reasoningByKey.set(key, reasoning)
  if (reasoningByKey.size > REASONING_MAX) {
    reasoningByKey.delete(reasoningByKey.keys().next().value)
  }
}


function rememberReasoning(toolCalls, text, reasoning) {
  if (!reasoning) return
  for (const call of toolCalls ?? []) {
    if (call.id) remember('call:' + call.id, reasoning)
  }
  if (text) remember(textKey(text), reasoning)
}


function recallReasoning(toolUses, text) {
  for (const t of toolUses) {
    const hit = reasoningByKey.get('call:' + t.id)
    if (hit) return hit
  }
  return (text && reasoningByKey.get(textKey(text))) || null
}


// Fill in every assistant turn still missing a `reasoning_content`. Returns
// false when there was nothing to fill, so the caller knows a retry is futile.
function fillReasoningStubs(payload) {
  let filled = 0
  for (const m of payload.messages) {
    if (m.role === 'assistant' && !m.reasoning_content) {
      m.reasoning_content = REASONING_STUB
      filled++
    }
  }
  return filled > 0
}

// Models already seen to demand the replay -- stub up front for those so the
// conversation doesn't burn a failed round trip on every single turn.
const demandsReasoning = new Set()


/** Anthropic request -> OpenAI request. */
function toOpenAI(body) {
  const messages = []


  if (body.system) {
    const sys = textOf(body.system)
    if (sys) messages.push({ role: 'system', content: sys })
  }


  for (const msg of body.messages ?? []) {
    const blocks = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : (msg.content ?? [])


    // tool_result blocks must each become their own OpenAI `tool` message.
    const results = blocks.filter((b) => b.type === 'tool_result')
    for (const r of results) {
      messages.push({
        role: 'tool',
        tool_call_id: r.tool_use_id,
        content: typeof r.content === 'string' ? r.content : textOf(r.content),
      })
    }


    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
    const toolUses = blocks.filter((b) => b.type === 'tool_use')


    if (toolUses.length) {
      const assistant = {
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        })),
      }
      const reasoning = recallReasoning(toolUses, text)
      if (reasoning) assistant.reasoning_content = reasoning
      messages.push(assistant)
    } else if (text || !results.length) {
      const plain = { role: msg.role, content: text }
      // A text-only assistant turn needs its reasoning replayed just the same.
      if (msg.role === 'assistant') {
        const reasoning = recallReasoning([], text)
        if (reasoning) plain.reasoning_content = reasoning
      }
      messages.push(plain)
    }
  }


  const out = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    stream: !!body.stream,
  }
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  if (body.stop_sequences) out.stop = body.stop_sequences


  if (body.tools?.length) {
    out.tools = body.tools
      // Claude Code sends server-side tool stubs with no schema; skip those.
      .filter((t) => t.name && t.input_schema)
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.input_schema,
        },
      }))
    if (!out.tools.length) delete out.tools
  }


  if (body.tool_choice) {
    const tc = body.tool_choice
    out.tool_choice =
      tc.type === 'any' ? 'required'
      : tc.type === 'tool' ? { type: 'function', function: { name: tc.name } }
      : tc.type === 'none' ? 'none'
      : 'auto'
  }


  return out
}


const STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' }


/** OpenAI (non-streaming) response -> Anthropic response. */
function toAnthropic(oai, model) {
  const choice = oai.choices?.[0] ?? {}
  const msg = choice.message ?? {}
  const content = []


  rememberReasoning(msg.tool_calls, msg.content, msg.reasoning_content)


  if (msg.content) content.push({ type: 'text', text: msg.content })


  for (const call of msg.tool_calls ?? []) {
    let input = {}
    try { input = JSON.parse(call.function.arguments || '{}') } catch {}
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
  }


  if (!content.length) {
    if (msg.reasoning_content) {
      content.push({ type: 'text', text: msg.reasoning_content })
    } else {
      content.push({ type: 'text', text: '' })
    }
  }


  return {
    id: oai.id ?? 'msg_zen',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: STOP[choice.finish_reason] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: oai.usage?.prompt_tokens ?? 0,
      output_tokens: oai.usage?.completion_tokens ?? 0,
    },
  }
}


const sse = (res, event, data) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)


/** Pipe an OpenAI SSE stream out as an Anthropic SSE stream. */
async function relayStream(upstream, res, model, onToolUse = null) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })


  const id = 'msg_' + Math.random().toString(36).slice(2)
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })


  let index = -1          // current Anthropic content block index
  let textOpen = false
  const tools = new Map() // OpenAI tool_call index -> Anthropic block index
  const toolCalls = new Map()
  const callIds = []      // tool_call ids seen, for the reasoning cache
  let reasoning = ''
  let replyText = ''      // reply text, the cache key for a tool-less turn
  let finish = 'stop'
  let usage = null


  const closeBlock = () => {
    if (index >= 0) sse(res, 'content_block_stop', { type: 'content_block_stop', index })
  }


  const decoder = new TextDecoder()
  let buf = ''


  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''


    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue


      let ev
      try { ev = JSON.parse(payload) } catch { continue }
      if (ev.usage) usage = ev.usage


      const choice = ev.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) finish = choice.finish_reason
      const delta = choice.delta ?? {}
      if (delta.reasoning_content) reasoning += delta.reasoning_content


      if (delta.content) {
        replyText += delta.content
        if (!textOpen) {
          closeBlock()
          index++
          textOpen = true
          sse(res, 'content_block_start', {
            type: 'content_block_start', index,
            content_block: { type: 'text', text: '' },
          })
        }
        sse(res, 'content_block_delta', {
          type: 'content_block_delta', index,
          delta: { type: 'text_delta', text: delta.content },
        })
      }


      for (const call of delta.tool_calls ?? []) {
        const key = call.index ?? 0
        if (!tools.has(key)) {
          closeBlock()
          textOpen = false
          index++
          tools.set(key, index)
          const id = call.id ?? `call_${key}`
          const name = call.function?.name ?? ''
          callIds.push({ id })
          toolCalls.set(key, { id, name: name || 'unknown' })
          onToolUse?.(id)
          sse(res, 'content_block_start', {
            type: 'content_block_start', index,
            content_block: {
              type: 'tool_use',
              id,
              name: call.function?.name ?? '',
              input: {},
            },
          })
        }
        if (call.function?.name && toolCalls.has(key)) {
          toolCalls.get(key).name = call.function.name
        }
        if (call.function?.arguments) {
          sse(res, 'content_block_delta', {
            type: 'content_block_delta', index: tools.get(key),
            delta: { type: 'input_json_delta', partial_json: call.function.arguments },
          })
        }
      }
    }
  }


  closeBlock()
  if (index === -1 && !replyText && reasoning) {
    index++
    sse(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })
    sse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text: reasoning },
    })
    closeBlock()
    replyText = reasoning
  }
  rememberReasoning(callIds, replyText, reasoning)
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: STOP[finish] ?? 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage?.completion_tokens ?? 0 },
  })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? estimateTokens(replyText),
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? estimateTokens(reasoning),
    toolsCalled: [...toolCalls.values()],
    stopReason: finish,
  }
}


const send = (payload, upstream, apiKey, identityHeaders = {}) =>
  fetch(`${upstream}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...identityHeaders,
    },
    body: JSON.stringify(payload),
  })

const ensureAnthropicTextContent = (rawText) => {
  try {
    const json = JSON.parse(rawText)
    if (json.content && Array.isArray(json.content)) {
      const hasText = json.content.some((b) => b.type === 'text' && b.text && b.text.trim().length > 0)
      const hasTool = json.content.some((b) => b.type === 'tool_use')
      if (!hasText && !hasTool) {
        const thinkingBlock = json.content.find((b) => b.type === 'thinking' && b.thinking)
        if (thinkingBlock && thinkingBlock.thinking && thinkingBlock.thinking.trim().length > 0) {
          json.content.push({ type: 'text', text: thinkingBlock.thinking })
          return JSON.stringify(json)
        } else {
          json.content.push({ type: 'text', text: 'OK' })
          return JSON.stringify(json)
        }
      }
    }
  } catch {}
  return rawText
}

async function relayNativeStream(upstream, res, onToolUse = null) {
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  let hasText = false
  let hasTool = false
  let thinking = ''
  let inputTokens = 0
  let outputTokens = 0
  let stopReason = null
  const toolCalls = []
  let maxIndex = -1

  const decoder = new TextDecoder()
  let buf = ''

  const emitFallbackIfNeeded = () => {
    if (!hasText && !hasTool) {
      const fallbackIndex = maxIndex + 1
      const fallbackText = thinking.trim().length > 0 ? thinking : 'OK'
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: fallbackIndex,
        content_block: { type: 'text', text: '' },
      })
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: fallbackIndex,
        delta: { type: 'text_delta', text: fallbackText },
      })
      sse(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: fallbackIndex,
      })
      hasText = true
      maxIndex = fallbackIndex
    }
  }

  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.startsWith('data:')) {
        res.write(line + '\n')
        continue
      }
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') {
        res.write(line + '\n')
        continue
      }

      let ev
      try { ev = JSON.parse(payload) } catch {
        res.write(line + '\n')
        continue
      }

      if (ev.type === 'message_start') {
        inputTokens = ev.message?.usage?.input_tokens || inputTokens
      } else if (ev.type === 'content_block_start') {
        if (ev.index != null && ev.index > maxIndex) maxIndex = ev.index
        if (ev.content_block?.type === 'text') hasText = true
        if (ev.content_block?.type === 'tool_use') {
          hasTool = true
          toolCalls.push({ id: ev.content_block.id || null, name: ev.content_block.name || 'unknown' })
          onToolUse?.(ev.content_block.id)
        }
      } else if (ev.type === 'content_block_delta') {
        if (ev.index != null && ev.index > maxIndex) maxIndex = ev.index
        if (ev.delta?.type === 'thinking_delta' && ev.delta?.thinking) {
          thinking += ev.delta.thinking
        }
      } else if (ev.type === 'message_delta' || ev.type === 'message_stop') {
        outputTokens = ev.usage?.output_tokens || outputTokens
        stopReason = ev.delta?.stop_reason || stopReason
        emitFallbackIfNeeded()
      }

      res.write(line + '\n')
    }
  }

  emitFallbackIfNeeded()
  res.end()
  return {
    inputTokens,
    outputTokens: outputTokens || estimateTokens(thinking),
    reasoningTokens: estimateTokens(thinking),
    toolsCalled: toolCalls,
    stopReason,
  }
}

/** Pipe the in-process Anthropic-shaped event generator from qwenWebClient
 *  out as a real SSE stream, tracking usage for activity recording. */
async function relayQwenWebEvents(generator, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  let inputTokens = 0
  let outputTokens = 0
  let stopReason = null
  const toolCalls = []

  for await (const event of generator) {
    sse(res, event.type, event)
    if (event.type === 'message_start') {
      inputTokens = event.message?.usage?.input_tokens || inputTokens
    } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      toolCalls.push(event.content_block.name)
    } else if (event.type === 'message_delta') {
      outputTokens = event.usage?.output_tokens || outputTokens
      stopReason = event.delta?.stop_reason || stopReason
    }
  }

  res.end()
  return { inputTokens, outputTokens, toolsCalled: toolCalls, stopReason }
}

const sendNative = (body, upstream, apiKey, identityHeaders = {}) =>
  fetch(`${upstream}/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      ...identityHeaders,
    },
    body: JSON.stringify(body),
  })


const fail = (res, status, detail) => {
  console.error(`upstream ${status}: ${detail.slice(0, 500)}`)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    type: 'error',
    error: { type: 'api_error', message: detail.slice(0, 1000) },
  }))
}

const failUnavailable = (res, detail, waitMs) => {
  const retryAfterSeconds = Math.max(1, Math.ceil((waitMs || 60000) / 1000))
  console.warn(`[zen-proxy] ${detail}`)
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'Retry-After': String(retryAfterSeconds),
  })
  res.end(JSON.stringify({
    type: 'error',
    error: { type: 'rate_limit_error', message: detail },
  }))
}


const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => resolve(d))
    req.on('error', reject)
  })


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')


  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok' }))
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      data: anthropicModels(),
      has_more: false,
      first_id: MODEL_CATALOG[0][0],
      last_id: MODEL_CATALOG[MODEL_CATALOG.length - 1][0],
    }))
  }


  // Claude Code pings this before streaming; a rough estimate is fine.
  if (url.pathname.endsWith('/count_tokens')) {
    const body = JSON.parse((await readBody(req)) || '{}')
    const chars = JSON.stringify(body.messages ?? []).length + JSON.stringify(body.system ?? '').length
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ input_tokens: Math.ceil(chars / 4) }))
  }


  if (req.method !== 'POST' || !url.pathname.includes('/messages')) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }))
  }


  const startedAt = Date.now()
  let recordActivity = null
  let activityRecorded = false

  try {
    const body = JSON.parse(await readBody(req))
    let openCodeHeaders = openCodeIdentityHeaders(body)
    const requestedModel = body.model
    const pinnedRoute = pinnedRouteForBody(body)
    const codexSelection = parseCodexModelSelection(requestedModel)
    const selectedRoute = pinnedRoute || resolveVirtualRoute(requestedModel) || (codexSelection && {
      provider: 'codex', model: codexSelection.model, reasoning_effort: codexSelection.effort,
    })
    if (selectedRoute) {
      body.model = selectedRoute.model
    }
    let route = selectedRoute || {
      provider: CODEX_MODELS.has(body.model)
        ? 'codex'
        : ANTIGRAVITY_MODELS.has(body.model)
          ? 'antigravity'
          : body.model.startsWith('qwen-chat:')
            ? 'qwen'
            : body.model.startsWith('qwen-web:')
              ? 'qwen-web'
              : 'zen',
      model: body.model,
    }
    const routeCandidates = [route]
    if (!pinnedRoute && selectedRoute?.fallback) {
      routeCandidates.push({
        tier: selectedRoute.tier,
        profileId: selectedRoute.profileId,
        profileName: selectedRoute.profileName,
        ...selectedRoute.fallback,
      })
    }
    const rememberRoute = (callId) => rememberToolRoute(callId, route)
    let effectiveEffort = ['codex', 'antigravity'].includes(route.provider)
      ? applyNativeReasoningEffort(body, route, { authoritative: !!selectedRoute })
      : reasoningEffortFor(body, route)

    // Dedicated Codex and Antigravity gateways record their own canonical
    // turns with real account identities. Zen traffic is recorded here.
    // When using the open-source Antigravity gateway or an uninstrumented upstream,
    // proxy turns are recorded here so they appear in the UI metrics dashboard.
    recordActivity = (diagnostics = {}) => {
      if (route.provider === 'codex' || activityRecorded) return
      if (route.provider === 'antigravity') {
        const isOpenSource = process.env.ANTIGRAVITY_GATEWAY_IMPL === 'opensource' ||
          process.env.ANTIGRAVITY_RECORD_PROXY_TURNS === '1'
        if (!isOpenSource && !diagnostics.force) return
      }
      activityRecorded = true
      recordRequest({
        provider: route.provider,
        model: route.model,
        accountEmail: diagnostics.accountEmail ||
          (route.provider === 'antigravity' ? 'antigravity-pool' : 'zen-primary'),
        inputTokens: diagnostics.inputTokens || estimateTokens(body),
        outputTokens: diagnostics.outputTokens || 0,
        durationMs: Date.now() - startedAt,
        status: diagnostics.status || 'success',
        errorMessage: diagnostics.errorMessage || null,
        toolsCalled: diagnostics.toolsCalled || [],
        reasoningEffort: effectiveEffort,
        reasoningTokens: diagnostics.reasoningTokens || 0,
        stopReason: diagnostics.stopReason || null,
      })
    }

    const failUpstream = async (upstream) => {
      const detail = await upstream.text()
      recordActivity({
        accountEmail: upstreamAccount(upstream, route.provider),
        status: activityStatus(upstream.status, detail),
        errorMessage: errorMessage(detail),
      })
      return fail(res, upstream.status, detail)
    }

    // Codex and Antigravity are Anthropic-native. If every account for the
    // primary route is quota-limited, retry once through the profile's
    // explicit fallback route before returning the 429 to Claude Code.
    if (routeCandidates.every((candidate) => ['codex', 'antigravity'].includes(candidate.provider))) {
      let zenFallbackModel = null
      for (let routeIndex = 0; routeIndex < routeCandidates.length; routeIndex++) {
        route = routeCandidates[routeIndex]
        body.model = route.model
        if (routeIndex > 0) {
          if (body.claude_zen) delete body.claude_zen.reasoning_effort
          if (body.output_config) delete body.output_config.effort
        }
        effectiveEffort = applyNativeReasoningEffort(body, route, {
          authoritative: !!selectedRoute || routeIndex > 0,
        })

        let upstream = await sendNative(
          body,
          route.provider === 'codex' ? CODEX_UPSTREAM : ANTIGRAVITY_UPSTREAM,
          route.provider === 'codex' ? 'codex-gateway' : 'any-value',
        )
        if (!upstream.ok) {
          const detail = await upstream.text()
          const rateLimited = upstream.status === 429 || /rate.?limit|quota|usage limit|insufficient.?balance/i.test(detail)
          if (rateLimited && routeIndex + 1 < routeCandidates.length) {
            console.warn(`[zen-proxy] ${route.provider}/${route.model} exhausted; falling back to ${routeCandidates[routeIndex + 1].provider}/${routeCandidates[routeIndex + 1].model}`)
            continue
          }
          if (rateLimited) {
            zenFallbackModel = selectedRoute?.zen_fallback?.model
              || zenFallbackForRoute(routeCandidates[0].model)
              || zenFallbackForModel(routeCandidates[0].model)
            break
          }
          recordActivity({
            accountEmail: upstreamAccount(upstream, route.provider),
            status: activityStatus(upstream.status, detail),
            errorMessage: errorMessage(detail),
          })
          return fail(res, upstream.status, detail)
        }

        let accountEmail = upstreamAccount(upstream, route.provider)
        if (body.stream) {
          const diagnostics = await relayNativeStream(upstream, res, rememberRoute)
          if (route.provider === 'antigravity') recordActivity({ ...diagnostics, accountEmail })
          return
        }

        let raw = ensureAnthropicTextContent(await upstream.text())
        if (route.provider === 'antigravity') {
          const retryEffort = isThinkingOnlyMaxTokens(raw)
            ? lowerReasoningEffort(effectiveEffort)
            : null
          if (retryEffort) {
            effectiveEffort = retryEffort
            body.output_config = { ...(body.output_config || {}), effort: retryEffort }
            upstream = await sendNative(body, ANTIGRAVITY_UPSTREAM, 'any-value')
            if (!upstream.ok) return failUpstream(upstream)
            accountEmail = upstreamAccount(upstream, route.provider)
            raw = ensureAnthropicTextContent(await upstream.text())
          }
          recordActivity({ ...anthropicActivity(raw), accountEmail })
        }
        rememberRoutesFromAnthropic(raw, route)
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
        })
        return res.end(raw)
      }

      if (zenFallbackModel) {
        console.warn(`[zen-proxy] All ${routeCandidates.map((c) => c.provider + '/' + c.model).join(' \u2192 ')} exhausted; falling back to Zen/${zenFallbackModel}`)
        body.model = zenFallbackModel
        route = { provider: 'zen', model: zenFallbackModel }
        effectiveEffort = null
        delete body.claude_zen
        delete body.output_config
        openCodeHeaders = openCodeIdentityHeaders(body)
      }
    }

    // Qwen3.7 Plus is exposed by Go as Anthropic-native. Preserve the
    // request and response instead of translating them through OpenAI.
    if (NATIVE_GO_MODELS.has(body.model)) {
      const maxAttempts = Math.max(1, zenAccountManager.getAvailableAccounts(body.model).length)
      const attemptedEmails = new Set()
      let lastUpstream = null
      let lastDetail = ''

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const turnSelection = await zenAccountManager.getAccountForTurn(body.model, { excludeEmails: attemptedEmails })
        const account = turnSelection.account
        if (!account || !turnSelection.apiKey) {
          return failUnavailable(res, turnSelection.error || 'No eligible OpenCode Zen account is available.', turnSelection.waitMs)
        }
        attemptedEmails.add(account.email)

        const upstream = await sendNative(body, GO_UPSTREAM, turnSelection.apiKey, openCodeHeaders)
        if (!upstream.ok) {
          lastUpstream = upstream
          lastDetail = await upstream.text()
          const isRateLimit = upstream.status === 429 || /rate.?limit|quota|usage limit|insufficient.?balance/i.test(lastDetail)
          if (account && isRateLimit) {
            console.warn(`[zen-proxy] Zen account ${account.email} rate-limited on ${body.model}. Rotating...`)
            const cooldownMs = openCodeCooldownMs(upstream, lastDetail)
            zenAccountManager.markRateLimited(account.email, cooldownMs, 'Quota limit reached', body.model)
            continue
          }
          recordActivity({
            accountEmail: account?.email || upstreamAccount(upstream, route.provider),
            status: activityStatus(upstream.status, lastDetail),
            errorMessage: errorMessage(lastDetail),
          })
          return fail(res, upstream.status, lastDetail)
        }

        const accountEmail = account?.email || upstreamAccount(upstream, route.provider)
        if (body.stream) {
          const diagnostics = await relayNativeStream(upstream, res, rememberRoute)
          recordActivity({ ...diagnostics, accountEmail })
          return
        }
        const raw = ensureAnthropicTextContent(await upstream.text())
        const diagnostics = anthropicActivity(raw)
        rememberRoutesFromAnthropic(raw, route)
        recordActivity({ ...diagnostics, accountEmail })
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
          'X-Account-Email': accountEmail,
        })
        return res.end(raw)
      }

      if (lastUpstream) {
        return fail(res, lastUpstream.status, lastDetail || 'All available OpenCode Zen accounts are rate-limited.')
      }
    }

    // Qwen Chat Web integration
    if (route.provider === 'qwen' || body.model.startsWith('qwen-chat:')) {
      const qwenModel = body.model.replace(/^qwen-chat:/, '')
      const qwenMaxAttempts = Math.max(1, qwenAccountManager.accounts.length)
      let qwenLastStatus = 503
      let qwenLastDetail = 'No active Qwen Chat account found. Run `qwen-agent login` or set your token in the dashboard.'

      for (let attempt = 0; attempt < qwenMaxAttempts; attempt++) {
        const account = qwenAccountManager.getNextAvailableAccount(qwenModel)
        if (!account?.accessToken) {
          return failUnavailable(res, qwenLastDetail, 5000)
        }

        const payload = toOpenAI(body)
        payload.model = qwenModel
        if (DEBUG) console.error('[zen-proxy -> qwen]', JSON.stringify(payload).slice(0, 400))

        const upstream = await send(payload, QWEN_UPSTREAM, account.accessToken)
        if (!upstream.ok) {
          const detail = await upstream.text()
          qwenLastStatus = upstream.status
          qwenLastDetail = detail
          // Retry with a different account on rate limits, server errors,
          // expired/invalid session tokens, or a daily usage cap -- the sticky
          // pick otherwise gets stuck on a single dead account for every
          // future request. qwen.aikit.club enforces its own per-token daily
          // cap (HTTP 400, code "RateLimited") independent of any real
          // chat.qwen.ai quota, so it needs the same rotate-away treatment.
          const isDailyCap = /"code"\s*:\s*"RateLimited"/i.test(detail) ||
            /upper limit for today.?s usage/i.test(detail)
          const isRetryable = upstream.status === 429 || upstream.status >= 500 || isDailyCap ||
            /session.*expired|token.*(no longer valid|invalid)|unauthorized/i.test(detail)
          if (isRetryable && attempt + 1 < qwenMaxAttempts) {
            const cooldownMs = isDailyCap ? 12 * 60 * 60 * 1000 : upstream.status === 429 ? 60000 : 300000
            const reason = isDailyCap
              ? 'Daily usage limit reached (qwen.aikit.club)'
              : upstream.status === 429 ? 'HTTP 429 rate limit' : `HTTP ${upstream.status}: ${detail.slice(0, 120)}`
            console.warn(`[zen-proxy] Qwen account ${account.email} failed (${upstream.status}); rotating...`)
            qwenAccountManager.markRateLimited(account.email, cooldownMs, reason)
            continue
          }
          recordActivity({
            accountEmail: account.email,
            status: activityStatus(upstream.status, detail),
            errorMessage: errorMessage(detail),
          })
          return fail(res, upstream.status, detail)
        }

        const accountEmail = account.email
        if (payload.stream) {
          const diagnostics = await relayStream(upstream, res, body.model, rememberRoute)
          recordActivity({ ...diagnostics, accountEmail })
          return
        }

        const json = await upstream.json()
        const diagnostics = openAiActivity(json)
        const anthropicRes = toAnthropic(json, body.model)
        rememberRoutesFromAnthropic(anthropicRes, route)
        recordActivity({
          ...diagnostics,
          accountEmail,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(anthropicRes))
      }

      return fail(res, qwenLastStatus, qwenLastDetail || 'All available Qwen Chat accounts are rate-limited or invalid.')
    }

    // Qwen Web -- direct chat.qwen.ai via a browser session cookie. Unofficial
    // (mimics the SPA's internal API), bypasses the qwen.aikit.club relay and
    // its separate daily cap entirely. See lib/qwen-web-client.mjs.
    if (route.provider === 'qwen-web' || body.model.startsWith('qwen-web:')) {
      const qwenWebModel = body.model.replace(/^qwen-web:/, '')
      let selectedEmail = null

      try {
        const result = await qwenWebClient.executeTurn(
          { ...body, model: qwenWebModel },
          { onAccountSelected: (email) => { selectedEmail = email } },
        )

        if (result.type === 'stream') {
          const diagnostics = await relayQwenWebEvents(result.generator, res)
          recordActivity({ ...diagnostics, accountEmail: result.accountEmail || selectedEmail })
          return
        }

        const anthropicRes = result.response
        rememberRoutesFromAnthropic(anthropicRes, route)
        recordActivity({
          inputTokens: anthropicRes.usage?.input_tokens,
          outputTokens: anthropicRes.usage?.output_tokens,
          stopReason: anthropicRes.stop_reason,
          accountEmail: selectedEmail,
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(anthropicRes))
      } catch (err) {
        const message = err?.message || 'Qwen Web request failed'
        recordActivity({
          accountEmail: selectedEmail,
          status: 'error',
          errorMessage: message,
        })
        if (/no .*qwen web account|cooling down|no active/i.test(message)) {
          return failUnavailable(res, message, 5000)
        }
        return fail(res, 502, message)
      }
    }

    const payload = toOpenAI(body)
    const upstreamBase = body.model.endsWith('-free') ? FREE_UPSTREAM : GO_UPSTREAM
    if (demandsReasoning.has(payload.model)) fillReasoningStubs(payload)
    if (DEBUG) console.error('->', JSON.stringify(payload).slice(0, 800))

    const maxAttempts = Math.max(1, zenAccountManager.getAvailableAccounts(body.model).length)
    const attemptedEmails = new Set()
    let lastUpstream = null
    let lastDetail = ''

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const turnSelection = await zenAccountManager.getAccountForTurn(body.model, { excludeEmails: attemptedEmails })
      const account = turnSelection.account
      if (!account || !turnSelection.apiKey) {
        return failUnavailable(res, turnSelection.error || 'No eligible OpenCode Zen account is available.', turnSelection.waitMs)
      }
      attemptedEmails.add(account.email)

      let upstream = await send(payload, upstreamBase, turnSelection.apiKey, openCodeHeaders)

      // Only some of Zen's upstream channels enforce the replay rule, so this
      // fires intermittently on identical traffic -- and always after a restart,
      // when the cache is cold and no turn can be given its real reasoning back.
      // Stub whatever is missing and retry; the retry also re-rolls the channel.
      if (upstream.status === 400) {
        const detail = await upstream.text()
        if (detail.includes('reasoning_content')) {
          const stubbed = fillReasoningStubs(payload)
          demandsReasoning.add(payload.model)
          console.error(
            `upstream 400 (reasoning replay): retrying ${payload.model}` +
            (stubbed ? ' with stubs' : ' (nothing to stub)'))
          upstream = await send(payload, upstreamBase, turnSelection.apiKey, openCodeHeaders)
        } else {
          recordActivity({
            accountEmail: account?.email || 'zen-primary',
            status: activityStatus(400, detail),
            errorMessage: errorMessage(detail),
          })
          return fail(res, 400, detail)
        }
      }

      if (!upstream.ok) {
        lastUpstream = upstream
        lastDetail = await upstream.text()
        const isRateLimit = upstream.status === 429 || /rate.?limit|quota|usage limit|insufficient.?balance/i.test(lastDetail)
        if (account && isRateLimit) {
          console.warn(`[zen-proxy] Zen account ${account.email} rate-limited on ${body.model}. Rotating...`)
          const cooldownMs = openCodeCooldownMs(upstream, lastDetail)
          zenAccountManager.markRateLimited(account.email, cooldownMs, 'Quota limit reached', body.model)
          continue
        }
        recordActivity({
          accountEmail: account?.email || upstreamAccount(upstream, route.provider),
          status: activityStatus(upstream.status, lastDetail),
          errorMessage: errorMessage(lastDetail),
        })
        return fail(res, upstream.status, lastDetail)
      }

      const accountEmail = account?.email || upstreamAccount(upstream, route.provider)
      if (payload.stream) {
        const diagnostics = await relayStream(upstream, res, body.model, rememberRoute)
        recordActivity({ ...diagnostics, accountEmail })
        return
      }

      const json = await upstream.json()
      const diagnostics = openAiActivity(json)
      const anthropicRes = toAnthropic(json, body.model)
      rememberRoutesFromAnthropic(anthropicRes, route)
      recordActivity({
        ...diagnostics,
        accountEmail,
      })
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Account-Email': accountEmail,
      })
      return res.end(JSON.stringify(anthropicRes))
    }

    if (lastUpstream) {
      return fail(res, lastUpstream.status, lastDetail || 'All available OpenCode Zen accounts are rate-limited.')
    }
  } catch (err) {
    console.error(err)
    recordActivity?.({ status: 'error', errorMessage: errorMessage(err) })
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } }))
  }
})


server.listen(PORT, '127.0.0.1', () =>
  console.error(`zen-proxy -> Go: ${GO_UPSTREAM}, free: ${FREE_UPSTREAM}  listening on http://127.0.0.1:${PORT}`))
