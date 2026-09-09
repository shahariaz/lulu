import crypto from 'node:crypto'
import { getModelFamily, isThinkingModel, findAntigravityModel } from './antigravity-models.mjs'

const MIN_SIGNATURE_LENGTH = 50
const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator'

// Chunk size for streaming tool input JSON — keeps Claude Code's progress
// indicators alive and prevents the parser from stalling on a single huge delta
const INPUT_JSON_CHUNK_SIZE = 32

// In-memory signature caches for cross-turn tool calls and thinking blocks
const signatureByToolId = new Map()
const signatureFamilyCache = new Map()

export function cacheToolSignature(toolId, signature) {
  if (toolId && signature && signature.length >= MIN_SIGNATURE_LENGTH) {
    signatureByToolId.set(toolId, signature)
    if (signatureByToolId.size > 2000) {
      signatureByToolId.delete(signatureByToolId.keys().next().value)
    }
  }
}

export function getCachedToolSignature(toolId) {
  return signatureByToolId.get(toolId) || null
}

export function cacheThinkingSignature(signature, family) {
  if (signature && signature.length >= MIN_SIGNATURE_LENGTH && family) {
    signatureFamilyCache.set(signature, family)
    if (signatureFamilyCache.size > 2000) {
      signatureFamilyCache.delete(signatureFamilyCache.keys().next().value)
    }
  }
}

export function getCachedSignatureFamily(signature) {
  return signatureFamilyCache.get(signature) || null
}

/**
 * Sanitize schema for Google Cloud Code / Gemini / Claude API
 */
export function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} }
  const copy = JSON.parse(JSON.stringify(schema))

  function clean(node) {
    if (!node || typeof node !== 'object') return
    delete node.$schema
    delete node.default
    delete node.examples
    delete node.title
    delete node.id
    delete node.$id
    // Cloud Code's function declaration schema uses an OpenAPI subset and
    // rejects these JSON Schema-only keywords outright.
    delete node.exclusiveMinimum
    delete node.exclusiveMaximum
    delete node.propertyNames
    delete node.$ref
    delete node.$defs
    delete node.definitions
    delete node.additionalProperties
    if (typeof node.const === 'string' && !Array.isArray(node.enum)) {
      node.enum = [node.const]
    }
    delete node.const

    if (node.type === 'array' && !node.items) {
      node.items = { type: 'string' }
    }

    if (node.properties && typeof node.properties === 'object') {
      for (const [, val] of Object.entries(node.properties)) {
        clean(val)
      }
    }
    if (node.items && typeof node.items === 'object') {
      clean(node.items)
    }
    if (Array.isArray(node.allOf)) node.allOf.forEach(clean)
    if (Array.isArray(node.anyOf)) node.anyOf.forEach(clean)
    if (Array.isArray(node.oneOf)) node.oneOf.forEach(clean)
  }

  clean(copy)
  return copy
}

export function normalizeThinkingLevel(effort) {
  const value = String(effort || 'medium').toLowerCase()
  if (value === 'minimal' || value === 'low') return 'LOW'
  if (value === 'high' || value === 'xhigh' || value === 'max') return 'HIGH'
  return 'MEDIUM'
}

/**
 * Converts Anthropic message content to Google Generative AI parts
 */
export function convertContentToParts(content, isClaudeModel = false, isGeminiModel = false) {
  if (typeof content === 'string') {
    return content.trim() ? [{ text: content }] : [{ text: '.' }]
  }
  if (!Array.isArray(content)) {
    const text = String(content ?? '')
    return text.trim() ? [{ text }] : [{ text: '.' }]
  }

  const parts = []
  for (const block of content) {
    if (!block) continue

    if (block.type === 'text') {
      if (block.text && block.text.trim()) {
        parts.push({ text: block.text })
      }
    } else if (block.type === 'image') {
      if (block.source?.type === 'base64' && block.source.data) {
        parts.push({
          inlineData: {
            mimeType: block.source.media_type || 'image/png',
            data: block.source.data,
          },
        })
      } else if (block.source?.type === 'url' && block.source.url) {
        parts.push({
          fileData: {
            mimeType: block.source.media_type || 'image/jpeg',
            fileUri: block.source.url,
          },
        })
      }
    } else if (block.type === 'document') {
      if (block.source?.type === 'base64' && block.source.data) {
        parts.push({
          inlineData: {
            mimeType: block.source.media_type || 'application/pdf',
            data: block.source.data,
          },
        })
      } else if (block.source?.type === 'url' && block.source.url) {
        parts.push({
          fileData: {
            mimeType: block.source.media_type || 'application/pdf',
            fileUri: block.source.url,
          },
        })
      }
    } else if (block.type === 'tool_use') {
      const functionCall = {
        name: block.name,
        args: block.input || {},
      }
      if (isClaudeModel && block.id) {
        functionCall.id = block.id
      }
      const part = { functionCall }
      if (isGeminiModel) {
        const signature = block.thoughtSignature || getCachedToolSignature(block.id)
        part.thoughtSignature = signature || GEMINI_SKIP_SIGNATURE
      }
      parts.push(part)
    } else if (block.type === 'tool_result') {
      let responseContent = block.content
      const imageParts = []

      if (typeof responseContent === 'string') {
        responseContent = { result: responseContent }
      } else if (Array.isArray(responseContent)) {
        for (const item of responseContent) {
          if (item?.type === 'image' && item.source?.type === 'base64') {
            imageParts.push({
              inlineData: {
                mimeType: item.source.media_type || 'image/png',
                data: item.source.data,
              },
            })
          }
        }
        const texts = responseContent
          .filter((c) => c?.type === 'text')
          .map((c) => c.text || '')
          .join('\n')
        responseContent = { result: texts || (imageParts.length > 0 ? 'Image attached' : '') }
      }

      const functionResponse = {
        name: block.tool_use_id || 'unknown',
        response: responseContent || {},
      }
      if (isClaudeModel && block.tool_use_id) {
        functionResponse.id = block.tool_use_id
      }
      parts.push({ functionResponse })
      if (imageParts.length > 0) parts.push(...imageParts)
    } else if (block.type === 'thinking') {
      if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) {
        parts.push({
          text: block.thinking || '',
          thought: true,
          thoughtSignature: block.signature,
        })
      }
    }
  }

  if (parts.length === 0) {
    parts.push({ text: '.' })
  }
  return parts
}

/**
 * Converts Anthropic Messages request to Google Cloud Code format
 */
export function convertAnthropicToGoogle(anthropicRequest) {
  const { messages = [], system, max_tokens, temperature, top_p, top_k, stop_sequences, tools, thinking } = anthropicRequest
  const modelName = anthropicRequest.model || 'gemini-3.8-flash-tiered'
  const modelFamily = getModelFamily(modelName)
  const isClaudeModel = modelFamily === 'claude'
  const isGeminiModel = modelFamily === 'gemini'
  const isThinking = isThinkingModel(modelName)

  const googleRequest = {
    contents: [],
    generationConfig: {},
  }

  // Handle system prompt
  if (system) {
    let systemParts = []
    if (typeof system === 'string') {
      if (system.trim()) systemParts = [{ text: system }]
    } else if (Array.isArray(system)) {
      systemParts = system
        .filter((b) => b?.type === 'text' && b.text?.trim())
        .map((b) => ({ text: b.text }))
    }
    if (systemParts.length > 0) {
      googleRequest.systemInstruction = { parts: systemParts }
    }
  }

  // Interleaved thinking hint for Claude models with tools
  if (isClaudeModel && isThinking && tools && tools.length > 0) {
    const hint = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer.'
    if (!googleRequest.systemInstruction) {
      googleRequest.systemInstruction = { parts: [{ text: hint }] }
    } else {
      const last = googleRequest.systemInstruction.parts[googleRequest.systemInstruction.parts.length - 1]
      if (last?.text) {
        last.text = `${last.text}\n\n${hint}`
      } else {
        googleRequest.systemInstruction.parts.push({ text: hint })
      }
    }
  }

  // Convert messages
  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user'
    const parts = convertContentToParts(msg.content, isClaudeModel, isGeminiModel)
    googleRequest.contents.push({ role, parts })
  }

  // Generation config
  if (max_tokens) googleRequest.generationConfig.maxOutputTokens = Math.min(max_tokens, 65536)
  if (temperature !== undefined) googleRequest.generationConfig.temperature = temperature
  if (top_p !== undefined) googleRequest.generationConfig.topP = top_p
  if (top_k !== undefined) googleRequest.generationConfig.topK = top_k
  if (stop_sequences?.length) googleRequest.generationConfig.stopSequences = stop_sequences

  // Thinking configuration
  if (isThinking) {
    if (isClaudeModel) {
      const thinkingConfig = { include_thoughts: true }
      if (thinking?.budget_tokens) {
        thinkingConfig.thinking_budget = thinking.budget_tokens
        const currentMax = googleRequest.generationConfig.maxOutputTokens || 65536
        if (currentMax <= thinking.budget_tokens) {
          googleRequest.generationConfig.maxOutputTokens = Math.min(65536, thinking.budget_tokens + 8192)
        }
      }
      googleRequest.generationConfig.thinkingConfig = thinkingConfig
    } else if (isGeminiModel) {
      const requestedEffort = anthropicRequest.claude_zen?.reasoning_effort
        || anthropicRequest.output_config?.effort
        || anthropicRequest.effort
        || null
      googleRequest.generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: normalizeThinkingLevel(requestedEffort),
      }
      if (!googleRequest.generationConfig.maxOutputTokens) {
        googleRequest.generationConfig.maxOutputTokens = 65536
      }
    }
  }

  // Convert tools
  if (tools?.length) {
    const functionDeclarations = tools.map((tool, idx) => {
      const name = tool.name || `tool_${idx}`
      const description = tool.description || ''
      const schema = tool.input_schema || { type: 'object', properties: {} }
      return {
        name: String(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
        description,
        parameters: sanitizeSchema(schema),
      }
    })
    googleRequest.tools = [{ functionDeclarations }]
  }

  return googleRequest
}

/**
 * Converts Google Generative AI response to Anthropic Messages format
 */
export function convertGoogleToAnthropic(googleResponse, model) {
  const response = googleResponse.response || googleResponse
  const candidates = response.candidates || []
  const firstCandidate = candidates[0] || {}
  const content = firstCandidate.content || {}
  const parts = content.parts || []

  const anthropicContent = []
  let hasToolCalls = false

  for (const part of parts) {
    if (part.thought === true) {
      const signature = part.thoughtSignature || ''
      if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
        cacheThinkingSignature(signature, getModelFamily(model))
      }
      anthropicContent.push({
        type: 'thinking',
        thinking: part.text || '',
        signature,
      })
    } else if (part.text !== undefined) {
      anthropicContent.push({
        type: 'text',
        text: part.text,
      })
    } else if (part.functionCall) {
      const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`
      const toolUseBlock = {
        type: 'tool_use',
        id: toolId,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      }
      if (part.thoughtSignature && part.thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
        toolUseBlock.thoughtSignature = part.thoughtSignature
        cacheToolSignature(toolId, part.thoughtSignature)
      }
      anthropicContent.push(toolUseBlock)
      hasToolCalls = true
    }
  }

  const finishReason = firstCandidate.finishReason
  let stopReason = 'end_turn'
  if (finishReason === 'STOP') stopReason = 'end_turn'
  else if (finishReason === 'MAX_TOKENS') stopReason = 'max_tokens'
  else if (finishReason === 'TOOL_USE' || hasToolCalls) stopReason = 'tool_use'

  const usageMetadata = response.usageMetadata || {}
  const promptTokens = usageMetadata.promptTokenCount || 0
  const cachedTokens = usageMetadata.cachedContentTokenCount || 0
  const outputTokens = usageMetadata.candidatesTokenCount || 0
  const reasoningTokens = usageMetadata.thoughtsTokenCount || 0

  return {
    id: `msg_${crypto.randomBytes(16).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: anthropicContent.length > 0 ? anthropicContent : [{ type: 'text', text: '' }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, promptTokens - cachedTokens),
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      cache_read_input_tokens: cachedTokens,
      cache_creation_input_tokens: 0,
    },
  }
}

/**
 * Yield input_json_delta events in small chunks so Claude Code's progress
 * indicators stay alive and the SSE parser never sees one huge delta for
 * large tool inputs (file writes, edits, etc.).
 */
function* yieldJsonChunks(index, jsonString) {
  for (let i = 0; i < jsonString.length; i += INPUT_JSON_CHUNK_SIZE) {
    yield {
      type: 'content_block_delta',
      index,
      delta: {
        type: 'input_json_delta',
        partial_json: jsonString.slice(i, i + INPUT_JSON_CHUNK_SIZE),
      },
    }
  }
}

/**
 * Async generator for streaming Google Cloud Code SSE response to Anthropic SSE events.
 * Pass an AbortSignal to cancel the upstream stream when the client disconnects.
 */
export async function* streamGoogleToAnthropic(responseStream, originalModel, { signal = null } = {}) {
  const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`
  let hasEmittedStart = false
  let blockIndex = 0
  let currentBlockType = null
  let currentThinkingSignature = ''
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let cacheReadTokens = 0
  let stopReason = 'end_turn'

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for await (const chunk of responseStream) {
      // Bail out immediately if the client disconnected
      if (signal?.aborted) break

      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (signal?.aborted) break
        if (!line.startsWith('data:')) continue
        const jsonText = line.slice(5).trim()
        if (!jsonText || jsonText === '[DONE]') continue

        let data
        try {
          data = JSON.parse(jsonText)
        } catch {
          continue
        }

        const innerResponse = data.response || data
        const usage = innerResponse.usageMetadata
        if (usage) {
          inputTokens = usage.promptTokenCount || inputTokens
          outputTokens = usage.candidatesTokenCount || outputTokens
          reasoningTokens = usage.thoughtsTokenCount || reasoningTokens
          cacheReadTokens = usage.cachedContentTokenCount || cacheReadTokens
        }

        const candidates = innerResponse.candidates || []
        const firstCandidate = candidates[0] || {}
        const content = firstCandidate.content || {}
        const parts = content.parts || []

        if (!hasEmittedStart && parts.length > 0) {
          hasEmittedStart = true
          yield {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model: originalModel,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: Math.max(0, inputTokens - cacheReadTokens),
                output_tokens: 0,
                cache_read_input_tokens: cacheReadTokens,
                cache_creation_input_tokens: 0,
              },
            },
          }
        }

        for (const part of parts) {
          if (signal?.aborted) break

          if (part.thought === true) {
            const text = part.text || ''
            const signature = part.thoughtSignature || ''

            if (currentBlockType !== 'thinking') {
              if (currentBlockType !== null) {
                yield { type: 'content_block_stop', index: blockIndex }
                blockIndex++
              }
              currentBlockType = 'thinking'
              currentThinkingSignature = ''
              yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'thinking', thinking: '' },
              }
            }

            if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
              currentThinkingSignature = signature
              cacheThinkingSignature(signature, getModelFamily(originalModel))
            }

            yield {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'thinking_delta', thinking: text },
            }
          } else if (part.text !== undefined) {
            if (!part.text) continue

            if (currentBlockType !== 'text') {
              if (currentBlockType === 'thinking' && currentThinkingSignature) {
                yield {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'signature_delta', signature: currentThinkingSignature },
                }
                currentThinkingSignature = ''
              }
              if (currentBlockType !== null) {
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
              delta: { type: 'text_delta', text: part.text },
            }
          } else if (part.functionCall) {
            const functionCallSignature = part.thoughtSignature || ''

            if (currentBlockType === 'thinking' && currentThinkingSignature) {
              yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'signature_delta', signature: currentThinkingSignature },
              }
              currentThinkingSignature = ''
            }
            if (currentBlockType !== null) {
              yield { type: 'content_block_stop', index: blockIndex }
              blockIndex++
            }
            currentBlockType = 'tool_use'
            stopReason = 'tool_use'

            const toolId = part.functionCall.id || `toolu_${crypto.randomBytes(12).toString('hex')}`
            const toolUseBlock = {
              type: 'tool_use',
              id: toolId,
              name: part.functionCall.name,
              input: {},
            }
            if (functionCallSignature && functionCallSignature.length >= MIN_SIGNATURE_LENGTH) {
              toolUseBlock.thoughtSignature = functionCallSignature
              cacheToolSignature(toolId, functionCallSignature)
            }

            yield {
              type: 'content_block_start',
              index: blockIndex,
              content_block: toolUseBlock,
            }

            // Stream the full JSON in small chunks so Claude Code's tool
            // input parser sees a progressive stream (native feel, no stalls)
            const argsJson = JSON.stringify(part.functionCall.args || {})
            yield* yieldJsonChunks(blockIndex, argsJson)
          }
        }

        if (firstCandidate.finishReason) {
          if (firstCandidate.finishReason === 'MAX_TOKENS') stopReason = 'max_tokens'
          else if (firstCandidate.finishReason === 'STOP') stopReason = 'end_turn'
        }
      }
    }
  } catch (err) {
    // If the signal was aborted, suppress the error — the client already left
    if (signal?.aborted) return
    throw err
  }

  if (!hasEmittedStart) {
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: originalModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: Math.max(0, inputTokens - cacheReadTokens),
          output_tokens: 0,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: 0,
        },
      },
    }
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'OK' },
    }
    yield { type: 'content_block_stop', index: 0 }
  } else if (currentBlockType !== null) {
    if (currentBlockType === 'thinking' && currentThinkingSignature) {
      yield {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'signature_delta', signature: currentThinkingSignature },
      }
    }
    yield { type: 'content_block_stop', index: blockIndex }
  }

  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: 0,
    },
  }
  yield { type: 'message_stop' }
}
