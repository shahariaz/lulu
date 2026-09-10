/**
 * Shared failure type for calls to the local model gateways (:8787 / :8788 / :8789).
 *
 * INVARIANT: when a gateway cannot be reached, or returns something unusable, the orchestrator
 * MUST surface that fact. It must never substitute canned text, a default verdict, or any other
 * fabricated content that a caller could mistake for real model output.
 *
 * This exists because three engines independently grew the same bug: `catch {}` around the
 * gateway call followed by a hardcoded stand-in response, so an outage was indistinguishable
 * from a considered answer. In the reviewer's case that manufactured an APPROVE.
 */
export class GatewayUnavailableError extends Error {
  constructor(message, { gatewayUrl = null, cause = null } = {}) {
    super(message)
    this.name = 'GatewayUnavailableError'
    this.code = 'E_GATEWAY_UNAVAILABLE'
    this.gatewayUrl = gatewayUrl
    if (cause) this.cause = cause
  }
}

/**
 * POST to a gateway's /v1/messages and return the first text block.
 * Throws GatewayUnavailableError on transport failure, non-2xx, or an unusable body.
 * Never returns a fabricated string.
 */
export async function callGatewayForText({
  gatewayUrl,
  model,
  system,
  messages,
  maxTokens = 4096,
  apiKey = 'local-antigravity',
  timeoutMs = Number(process.env.ZEN_GATEWAY_TIMEOUT_MS || 120000),
}) {
  let res
  try {
    res = await fetch(`${gatewayUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new GatewayUnavailableError(
      `Gateway unreachable at ${gatewayUrl}: ${err.message}`,
      { gatewayUrl, cause: err },
    )
  }

  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 500) } catch {}
    throw new GatewayUnavailableError(
      `Gateway ${gatewayUrl} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
      { gatewayUrl },
    )
  }

  let data
  try {
    data = await res.json()
  } catch (err) {
    throw new GatewayUnavailableError(
      `Gateway ${gatewayUrl} returned a non-JSON body: ${err.message}`,
      { gatewayUrl, cause: err },
    )
  }

  const textBlock = (data.content || []).find((b) => b.type === 'text')
  if (!textBlock?.text) {
    throw new GatewayUnavailableError(
      `Gateway ${gatewayUrl} returned no text content`,
      { gatewayUrl },
    )
  }

  return { text: textBlock.text, raw: data, truncation: describeTruncation(data, maxTokens) }
}

/**
 * Decide whether a response was cut short by the token budget.
 *
 * This exists because that failure has NO reliable signal of its own. Measured against the live
 * gateway: a request with max_tokens 8192 spent 7,860 tokens on REASONING and 328 on output,
 * returned text cut off mid-sentence, and still reported `stop_reason: "end_turn"`. The only
 * symptom downstream was "malformed JSON", which sends you looking at the prompt or the parser
 * rather than at the budget.
 *
 * max_tokens is shared between reasoning and output on these models, and reasoning scales with
 * task complexity — so a schema that works in a small test can silently starve its own answer
 * in production.
 *
 * Returns { likely, used, limit, reasoningTokens, outputTokens, reason }.
 */
export function describeTruncation(data, maxTokens) {
  const usage = data?.usage || {}
  const outputTokens = usage.output_tokens || 0
  const reasoningTokens = usage.reasoning_tokens || 0
  const used = outputTokens + reasoningTokens

  // Within 5% of the cap (or over it) means the budget, not the model, ended the response.
  const nearCap = maxTokens > 0 && used >= maxTokens * 0.95
  const explicit = data?.stop_reason === 'max_tokens'

  return {
    likely: explicit || nearCap,
    used,
    limit: maxTokens,
    outputTokens,
    reasoningTokens,
    reason: explicit
      ? 'stop_reason was max_tokens'
      : nearCap
        ? `used ${used} of ${maxTokens} tokens (${reasoningTokens} of them on reasoning)`
        : null,
  }
}
