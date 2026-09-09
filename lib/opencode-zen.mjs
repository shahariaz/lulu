import { createHash } from 'node:crypto'

const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 24)

const firstUserMessage = (messages = []) =>
  messages.find((message) => message?.role === 'user') ?? messages[0] ?? null

/**
 * OpenCode Zen uses these headers to associate traffic with a normal client,
 * project, session, and request. Keep the IDs deterministic so a retry of the
 * same turn has the same identity.
 */
export function openCodeIdentityHeaders(body, {
  client = process.env.OPENCODE_CLIENT || 'cli',
  version = process.env.OPENCODE_CLIENT_VERSION || '1.18.16',
} = {}) {
  const system = JSON.stringify(body?.system ?? '')
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const projectSeed = system || 'claude-zen'
  const sessionSeed = `${projectSeed}\n${JSON.stringify(firstUserMessage(messages))}`
  const requestSeed = `${sessionSeed}\n${JSON.stringify(messages)}\n${body?.model ?? ''}`

  return {
    'x-opencode-project': `prj_${digest(projectSeed)}`,
    'x-opencode-session': `ses_${digest(sessionSeed)}`,
    'x-opencode-request': `msg_${digest(requestSeed)}`,
    'x-opencode-client': client,
    'User-Agent': `opencode/${version}`,
  }
}

const positiveNumber = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

const retryAfterMs = (headers, now) => {
  const explicitMs = positiveNumber(headers?.get?.('retry-after-ms'))
  if (explicitMs) return explicitMs

  const retryAfter = headers?.get?.('retry-after')
  const seconds = positiveNumber(retryAfter)
  if (seconds) return seconds * 1000

  const resetAt = Date.parse(retryAfter || '')
  if (Number.isFinite(resetAt) && resetAt > now) return resetAt - now

  for (const name of ['x-ratelimit-reset', 'x-rate-limit-reset', 'ratelimit-reset']) {
    const raw = headers?.get?.(name)
    const numeric = positiveNumber(raw)
    if (!numeric) continue
    const milliseconds = numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : now + numeric * 1000
    if (milliseconds > now) return milliseconds - now
  }
  return null
}

/** Prefer the upstream reset; free-tier exhaustion gets a conservative one-hour
 * fallback instead of being reopened every minute and hammered repeatedly. */
export function openCodeCooldownMs(response, detail = '', {
  now = Date.now(),
  freeLimitDefaultMs = Number(process.env.ZEN_FREE_LIMIT_COOLDOWN_MS) || 60 * 60 * 1000,
  rateLimitDefaultMs = Number(process.env.ZEN_RATE_LIMIT_COOLDOWN_MS) || 60 * 1000,
} = {}) {
  const fromHeaders = retryAfterMs(response?.headers, now)
  if (fromHeaders) return Math.max(1000, Math.ceil(fromHeaders))

  const freeLimit = /FreeUsageLimitError|free[\s_-]*(?:usage|tier)[\s_-]*limit/i.test(String(detail))
  return Math.max(1000, freeLimit ? freeLimitDefaultMs : rateLimitDefaultMs)
}
