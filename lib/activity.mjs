const clampTokenCount = (value) => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

export const estimateTokens = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text ? Math.ceil(text.length / 4) : 0
}

export function reasoningEffortFor(body = {}, route = {}) {
  return body.claude_zen?.reasoning_effort ||
    body.output_config?.effort ||
    body.effort ||
    route.reasoning_effort ||
    null
}

export function applyNativeReasoningEffort(body = {}, route = {}, { authoritative = false } = {}) {
  if (authoritative) {
    if (body.claude_zen) delete body.claude_zen.reasoning_effort
    if (body.output_config) delete body.output_config.effort
    delete body.effort
  }

  const effort = authoritative
    ? (route.reasoning_effort || null)
    : reasoningEffortFor(body, route)

  if (route.provider === 'codex') {
    body.claude_zen = { ...(body.claude_zen || {}), reasoning_effort: effort }
  } else if (route.provider === 'antigravity' && effort) {
    body.output_config = { ...(body.output_config || {}), effort }
  }
  return effort
}

export function activityStatus(status, detail = '') {
  if (Number(status) === 429 || /rate.?limit|quota|usage limit/i.test(String(detail))) {
    return 'rate_limited'
  }
  return Number(status) >= 200 && Number(status) < 400 ? 'success' : 'error'
}

export function upstreamAccount(upstream, provider) {
  const headers = upstream?.headers
  const reported = headers?.get?.('x-account-email') ||
    headers?.get?.('x-account') ||
    headers?.get?.('x-provider-account')
  if (reported) return reported
  if (provider === 'antigravity') return 'antigravity-pool'
  if (provider === 'zen') return 'zen-primary'
  return null
}

export function anthropicActivity(payload) {
  let message = payload
  if (typeof payload === 'string') {
    try {
      message = JSON.parse(payload)
    } catch {
      message = {}
    }
  }

  const content = Array.isArray(message?.content) ? message.content : []
  const toolsCalled = content
    .filter((block) => block?.type === 'tool_use')
    .map((block) => ({ id: block.id || null, name: block.name || 'unknown' }))
  const thinking = content
    .filter((block) => block?.type === 'thinking' || block?.type === 'redacted_thinking')
    .map((block) => block.thinking || block.data || '')
    .join('')

  return {
    inputTokens: clampTokenCount(message?.usage?.input_tokens ?? message?.usage?.inputTokens),
    outputTokens: clampTokenCount(message?.usage?.output_tokens ?? message?.usage?.outputTokens),
    reasoningTokens: clampTokenCount(
      message?.usage?.reasoning_tokens ??
      message?.usage?.output_tokens_details?.reasoning_tokens,
    ) || estimateTokens(thinking),
    toolsCalled,
    stopReason: message?.stop_reason || message?.stopReason || null,
  }
}

export function isThinkingOnlyMaxTokens(payload) {
  let message = payload
  if (typeof payload === 'string') {
    try {
      message = JSON.parse(payload)
    } catch {
      return false
    }
  }

  if (message?.stop_reason !== 'max_tokens' || !Array.isArray(message.content)) return false
  const hasThinking = message.content.some((block) =>
    block?.type === 'thinking' || block?.type === 'redacted_thinking')
  const hasUsefulOutput = message.content.some((block) =>
    block?.type === 'tool_use' ||
    (block?.type === 'text' && String(block.text || '').trim().length > 0))
  return hasThinking && !hasUsefulOutput
}

export function lowerReasoningEffort(effort) {
  if (effort === 'high') return 'medium'
  if (effort === 'medium') return 'low'
  return null
}

export function openAiActivity(payload) {
  const choice = payload?.choices?.[0] || {}
  const message = choice.message || {}
  const toolsCalled = (message.tool_calls || []).map((call) => ({
    id: call.id || null,
    name: call.function?.name || call.name || 'unknown',
  }))
  const reasoning = message.reasoning_content || ''

  return {
    inputTokens: clampTokenCount(payload?.usage?.prompt_tokens),
    outputTokens: clampTokenCount(payload?.usage?.completion_tokens),
    reasoningTokens: clampTokenCount(
      payload?.usage?.completion_tokens_details?.reasoning_tokens ??
      payload?.usage?.reasoning_tokens,
    ) || estimateTokens(reasoning),
    toolsCalled,
    stopReason: choice.finish_reason || null,
  }
}

export function errorMessage(value) {
  if (typeof value === 'string') return value.slice(0, 1000)
  if (value instanceof Error) return (value.message || String(value)).slice(0, 1000)
  try {
    return JSON.stringify(value).slice(0, 1000)
  } catch {
    return String(value).slice(0, 1000)
  }
}
