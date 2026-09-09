import crypto from 'node:crypto'
import {
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_HEADERS,
  antigravityAccountManager,
} from './antigravity-accounts.mjs'
import {
  convertAnthropicToGoogle,
  convertGoogleToAnthropic,
  streamGoogleToAnthropic,
} from './anthropic-antigravity.mjs'
import {
  getModelFamily,
  impliedAntigravityReasoningEffort,
  isThinkingModel,
  normalizeAntigravityModel,
} from './antigravity-models.mjs'

// How long to wait for the upstream Google API before giving up
const UPSTREAM_TIMEOUT_MS = Number(process.env.ANTIGRAVITY_TIMEOUT_MS || 120_000)
const DEFAULT_COOLDOWN_MS = Number(process.env.ANTIGRAVITY_DEFAULT_COOLDOWN_MS || 60_000)
const MAX_WAIT_BEFORE_ERROR_MS = Number(process.env.ANTIGRAVITY_MAX_WAIT_MS || 120_000)

// Connection errors that are safe to retry with the next endpoint
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])

export function deriveSessionId(body) {
  const firstMsg = body.messages?.[0]?.content
  const text = typeof firstMsg === 'string' ? firstMsg : JSON.stringify(firstMsg || body.system || 'default-session')
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
  return `session-${hash}`
}

export function parseResetTime(response, errorText = '') {
  // Check Retry-After header
  const retryAfter = response.headers?.get?.('retry-after')
  if (retryAfter) {
    const sec = Number(retryAfter)
    if (!Number.isNaN(sec) && sec > 0) return sec * 1000
    const date = Date.parse(retryAfter)
    if (!Number.isNaN(date) && date > Date.now()) return date - Date.now()
  }

  // Check error message for reset times or durations
  const text = String(errorText)
  const durationMatch = text.match(/try again in ([0-9]+(?:\.[0-9]+)?)\s*(s|sec|seconds|m|min|minutes|h|hours|ms)?/i)
  if (durationMatch) {
    const val = Number(durationMatch[1])
    const unit = (durationMatch[2] || 's').toLowerCase()
    if (unit.startsWith('m') && !unit.startsWith('ms')) return val * 60 * 1000
    if (unit.startsWith('h')) return val * 3600 * 1000
    if (unit === 'ms') return val
    return val * 1000
  }

  return DEFAULT_COOLDOWN_MS
}

function sleepWithSignal(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer = null
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const error = new Error('Client disconnected')
      error.statusCode = 499
      reject(error)
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function isRetryableError(err) {
  if (!err) return false
  const code = err.code || err.cause?.code || ''
  return RETRYABLE_ERROR_CODES.has(code) || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network/i.test(String(err.message || ''))
}

function quotaError(response, errorText) {
  return response.status === 429 ||
    /RESOURCE_EXHAUSTED|QUOTA_EXCEEDED|rate.?limit(?:ed| exceeded)?|quota (?:exhausted|exceeded)/i.test(String(errorText))
}

function rateLimitReason(status, errorText) {
  let detail = String(errorText || '').trim()
  try {
    const parsed = JSON.parse(detail)
    detail = parsed?.error?.message || parsed?.error?.status || detail
  } catch {}
  return `Antigravity ${status}: ${detail || 'quota limit reached'}`.slice(0, 300)
}

export class AntigravityClient {
  constructor({ accountManager = antigravityAccountManager } = {}) {
    this.accountManager = accountManager
  }

  buildHeaders(token, model, isStream = false) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...ANTIGRAVITY_HEADERS,
    }
    const family = getModelFamily(model)
    if (family === 'claude' && isThinkingModel(model)) {
      headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
    }
    if (isStream) {
      headers.Accept = 'text/event-stream'
    }
    return headers
  }

  /**
   * Execute a turn against the Google Cloud Code API.
   *
   * @param {object} body         - Anthropic Messages API request body
   * @param {object} opts
   * @param {function} opts.onAccountSelected - called with the account email once chosen
   * @param {AbortSignal} opts.signal         - abort signal from the client connection
   */
  async executeTurn(body, { onAccountSelected = null, signal = null } = {}) {
    const requestedModel = body.model || 'gemini-3.8-flash-tiered'
    const impliedEffort = impliedAntigravityReasoningEffort(requestedModel)
    const model = normalizeAntigravityModel(requestedModel) || requestedModel
    body.model = model
    if (impliedEffort && !body.claude_zen?.reasoning_effort && !body.output_config?.effort && !body.effort) {
      body.output_config = { ...(body.output_config || {}), effort: impliedEffort }
    }
    const isStream = !!body.stream
    const isThinking = isThinkingModel(model)

    await this.accountManager.init()
    // Don't cache maxAttempts — account count can change after markRateLimited
    // reloads the DB. Re-read on each iteration so we always try all accounts.
    let attempt = 0
    const attemptedEmails = new Set()

    for (;;) {
      // Abort immediately if the client is already gone
      if (signal?.aborted) {
        const err = new Error('Client disconnected')
        err.statusCode = 499
        throw err
      }

      // Always force a DB reload before picking an account so newly-added
      // accounts are visible immediately and rate-limit state is always fresh.
      this.accountManager.reloadFromDb?.()
      this._lastDbRefresh = Date.now()  // sync the throttle timer

      const turnSelection = await this.accountManager.getAccountForTurn(model, {
        excludeEmails: attemptedEmails,
      })
      if (!turnSelection.account) {
        const waitMs = Number(turnSelection.waitMs || 0)
        // Match the upstream gateway: short model-specific cooldowns are
        // waited out instead of being surfaced as a terminal 429. Clear the
        // per-turn exclusions because those accounts may be available again.
        if (attempt > 0 && this.accountManager.accounts.length > 0 && waitMs > 0 && waitMs <= MAX_WAIT_BEFORE_ERROR_MS) {
          console.warn(`[AntigravityClient] All accounts are cooling down for ${model}; waiting ${Math.ceil(waitMs / 1000)}s...`)
          await sleepWithSignal(waitMs, signal)
          attemptedEmails.clear()
          attempt = 0
          continue
        }
        // No accounts available — if we've already tried at least once, give up
        if (attempt > 0) {
          const error = new Error(turnSelection.error || 'All Antigravity accounts are rate-limited')
          error.statusCode = 429
          throw error
        }
        // First attempt with no accounts at all — hard stop
        const error = new Error(turnSelection.error || 'No Antigravity accounts configured')
        error.statusCode = 429
        throw error
      }

      const maxAttempts = Math.max(1, this.accountManager.accounts.length)
      if (attempt >= maxAttempts) {
        const error = new Error('All available Antigravity accounts are rate-limited for this model.')
        error.statusCode = 429
        throw error
      }
      attempt++

      const { account, token, project } = turnSelection
      attemptedEmails.add(account.email)
      const googleRequest = convertAnthropicToGoogle(body)
      googleRequest.sessionId = deriveSessionId(body)

      const payload = {
        project,
        model,
        request: googleRequest,
        userAgent: 'antigravity',
        requestId: `agent-${crypto.randomUUID()}`,
      }

      let lastError = null

      for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        if (signal?.aborted) break
        try {
          const url = (isStream || isThinking)
            ? `${endpoint}/v1internal:streamGenerateContent?alt=sse`
            : `${endpoint}/v1internal:generateContent`

          // Each request gets its own abort controller so we can time it out
          // independently and also cancel it when the client disconnects.
          const ac = new AbortController()
          const timeoutId = setTimeout(() => ac.abort(new Error('Upstream timeout')), UPSTREAM_TIMEOUT_MS)
          // If the caller's signal fires, propagate to our controller
          const onCallerAbort = () => ac.abort(new Error('Client disconnected'))
          signal?.addEventListener('abort', onCallerAbort, { once: true })

          let response
          try {
            response = await fetch(url, {
              method: 'POST',
              headers: this.buildHeaders(token, model, isStream || isThinking),
              body: JSON.stringify(payload),
              signal: ac.signal,
            })
          } finally {
            clearTimeout(timeoutId)
            signal?.removeEventListener('abort', onCallerAbort)
          }

          if (!response.ok) {
            const errorText = await response.text()
            if (response.status === 401) {
              this.accountManager?.tokenCache?.delete?.(account.email)
              continue
            }
            if (quotaError(response, errorText)) {
              const resetMs = parseResetTime(response, errorText)
              lastError = {
                is429: true,
                resetMs,
                message: errorText,
                reason: rateLimitReason(response.status, errorText),
              }
              // Alternate endpoints share the same account quota. Retrying the
              // same large payload there only amplifies token-per-minute load.
              break
            }
            lastError = new Error(`Cloud Code API error (${response.status}): ${errorText}`)
            lastError.statusCode = response.status
            continue
          }

          onAccountSelected?.(account.email)

          if (isStream) {
            return {
              type: 'stream',
              accountEmail: account.email,
              // Pass the client's signal so the generator stops when they disconnect
              generator: streamGoogleToAnthropic(response.body, model, { signal }),
            }
          }

          if (isThinking) {
            // Parse SSE response for thinking models — accumulate tool input
            // JSON as a string first, then parse once at the end (fixes the
            // overwrite-on-each-delta bug for large tool arguments).
            let finalData = null
            const toolInputAccumulators = new Map() // blockIndex -> jsonStr

            for await (const chunk of streamGoogleToAnthropic(response.body, model, { signal })) {
              if (signal?.aborted) break

              if (chunk.type === 'message_start') {
                finalData = { ...chunk.message, content: [] }
              } else if (chunk.type === 'content_block_start') {
                if (!finalData) finalData = { id: 'msg_unknown', type: 'message', role: 'assistant', model, content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }
                finalData.content.push({ ...chunk.content_block })
                if (chunk.content_block.type === 'tool_use') {
                  toolInputAccumulators.set(chunk.index, '')
                }
              } else if (chunk.type === 'content_block_delta') {
                if (!finalData) continue
                // Apply delta to the block at the specified index, not just the last block
                const block = finalData.content[chunk.index] ?? finalData.content[finalData.content.length - 1]
                if (!block) continue
                const { delta } = chunk
                if (delta?.type === 'text_delta') {
                  block.text = (block.text || '') + delta.text
                } else if (delta?.type === 'thinking_delta') {
                  block.thinking = (block.thinking || '') + delta.thinking
                } else if (delta?.type === 'signature_delta') {
                  block.signature = delta.signature
                } else if (delta?.type === 'input_json_delta') {
                  // Accumulate by block index — parse once at content_block_stop
                  const prev = toolInputAccumulators.get(chunk.index) ?? ''
                  toolInputAccumulators.set(chunk.index, prev + (delta.partial_json || ''))
                }
              } else if (chunk.type === 'content_block_stop') {
                if (!finalData) continue
                // Parse accumulated JSON for tool_use blocks using index
                if (toolInputAccumulators.has(chunk.index)) {
                  const block = finalData.content[chunk.index]
                  if (block?.type === 'tool_use') {
                    try {
                      block.input = JSON.parse(toolInputAccumulators.get(chunk.index) || '{}')
                    } catch {
                      block.input = {}
                    }
                  }
                  toolInputAccumulators.delete(chunk.index)
                }
              } else if (chunk.type === 'message_delta') {
                if (finalData) {
                  finalData.stop_reason = chunk.delta.stop_reason || finalData.stop_reason
                  if (finalData.usage) {
                    finalData.usage.output_tokens = chunk.usage?.output_tokens || finalData.usage.output_tokens
                    finalData.usage.reasoning_tokens = chunk.usage?.reasoning_tokens || 0
                  }
                }
              }
            }

            if (signal?.aborted) {
              const err = new Error('Client disconnected')
              err.statusCode = 499
              throw err
            }

            // Guard: if the stream emitted nothing, return a safe empty response
            if (!finalData) {
              finalData = {
                id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
                type: 'message',
                role: 'assistant',
                model,
                content: [{ type: 'text', text: '' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 },
              }
            }

            return {
              type: 'json',
              accountEmail: account.email,
              data: finalData,
            }
          }

          const json = await response.json()
          const anthropicResponse = convertGoogleToAnthropic(json, model)
          return {
            type: 'json',
            accountEmail: account.email,
            data: anthropicResponse,
          }
        } catch (endpointError) {
          // Propagate client-disconnect and abort errors immediately
          if (endpointError?.name === 'AbortError' || endpointError?.statusCode === 499) {
            if (signal?.aborted) {
              const err = new Error('Client disconnected')
              err.statusCode = 499
              throw err
            }
            // Otherwise it was our timeout — treat as a retryable endpoint error
            lastError = new Error(`Upstream request timed out after ${UPSTREAM_TIMEOUT_MS}ms`)
            lastError.isTimeout = true
          } else if (isRetryableError(endpointError)) {
            console.warn(`[AntigravityClient] Connection error on ${endpoint}: ${endpointError.message} — trying next endpoint`)
            lastError = endpointError
          } else {
            lastError = endpointError
          }
        }
      }

      if (lastError?.is429) {
        console.warn(`[AntigravityClient] Account ${account.email} rate-limited for ${model}. Rotating...`)
        console.warn(`[AntigravityClient] ${lastError.reason}`)
        this.accountManager.markRateLimited(account.email, lastError.resetMs || 60000, lastError.reason, model)
        continue
      }

      if (lastError) {
        console.error(`[AntigravityClient] Account ${account.email} error:`, lastError.message)
        throw lastError
      }
    }

    const error = new Error('All available Antigravity accounts are rate-limited for this model.')
    error.statusCode = 429
    throw error
  }
}

export const antigravityClient = new AntigravityClient()
