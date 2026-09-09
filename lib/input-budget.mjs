// Keep translated requests comfortably below provider token-throughput limits.
// Large JSON/tool transcripts average roughly four characters per token, so
// 200 KiB is roughly 50k tokens before provider-side formatting. Keep this
// configurable because short-window provider limits are separate from quota.
export const DEFAULT_ANTIGRAVITY_MAX_INPUT_CHARS = 200 * 1024
const DEFAULT_MAX_CHARS = DEFAULT_ANTIGRAVITY_MAX_INPUT_CHARS
const DEFAULT_FIELD_MAX = 128 * 1024
const OMITTED = '\n\n[claude-zen: older input omitted to fit the provider context limit]\n\n'

function truncate(value, maxChars, keepTail = false) {
  if (typeof value !== 'string' || value.length <= maxChars) return value
  const room = Math.max(0, maxChars - OMITTED.length)
  return keepTail ? OMITTED + value.slice(-room) : value.slice(0, room) + OMITTED
}

function budgetContent(content, fieldMax) {
  if (typeof content === 'string') return truncate(content, fieldMax, true)
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (!block || typeof block !== 'object') return block
    if (block.type === 'text' && typeof block.text === 'string') {
      return { ...block, text: truncate(block.text, fieldMax, true) }
    }
    if (block.type === 'tool_result') {
      if (typeof block.content === 'string') {
        return { ...block, content: truncate(block.content, fieldMax, true) }
      }
      if (Array.isArray(block.content)) {
        return {
          ...block,
          content: block.content.map((item) => item?.type === 'text'
            ? { ...item, text: truncate(item.text, fieldMax, true) }
            : item),
        }
      }
      if (block.content && typeof block.content === 'object') {
        const encoded = JSON.stringify(block.content)
        if (encoded.length > fieldMax) return { ...block, content: truncate(encoded, fieldMax, true) }
      }
    }
    if (block.type === 'tool_use' && block.input && JSON.stringify(block.input).length > fieldMax) {
      return { ...block, input: { claude_zen_omitted: 'Oversized historical tool arguments omitted' } }
    }
    return block
  })
}

/** Bound an Anthropic request before translating it to a provider payload. */
export function budgetAnthropicRequest(input, {
  maxChars = DEFAULT_MAX_CHARS,
  fieldMax = DEFAULT_FIELD_MAX,
} = {}) {
  const body = structuredClone(input || {})
  const originalChars = JSON.stringify(body).length
  if (originalChars <= maxChars) {
    return { body, truncated: false, originalChars, finalChars: originalChars }
  }

  if (typeof body.system === 'string') body.system = truncate(body.system, fieldMax)
  else if (Array.isArray(body.system)) {
    body.system = body.system.map((block) => block?.type === 'text'
      ? { ...block, text: truncate(block.text, fieldMax) }
      : block)
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => ({
      ...message,
      content: budgetContent(message.content, fieldMax),
    }))
  }
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((tool) => ({
      ...tool,
      description: truncate(tool.description, 32 * 1024),
    }))
  }

  while (JSON.stringify(body).length > maxChars && body.messages?.length > 2) {
    body.messages.shift()
  }

  let fieldBudget = fieldMax
  while (JSON.stringify(body).length > maxChars && fieldBudget > 4096) {
    fieldBudget = Math.max(4096, Math.floor(fieldBudget / 2))
    body.messages = (body.messages || []).map((message) => ({
      ...message,
      content: budgetContent(message.content, fieldBudget),
    }))
    if (typeof body.system === 'string') body.system = truncate(body.system, fieldBudget)
    else if (Array.isArray(body.system)) {
      body.system = body.system.map((block) => block?.type === 'text'
        ? { ...block, text: truncate(block.text, fieldBudget) }
        : block)
    }
  }

  if (JSON.stringify(body).length > maxChars) {
    body.messages = (body.messages || []).map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((block) => ['image', 'document'].includes(block?.type) && block.source?.type === 'base64'
          ? { type: 'text', text: '[oversized attachment omitted]' }
          : block)
        : message.content,
    }))
  }
  while (JSON.stringify(body).length > maxChars && body.tools?.length) body.tools.pop()
  if (JSON.stringify(body).length > maxChars) body.system = '[system prompt omitted to fit provider input limit]'

  const finalChars = JSON.stringify(body).length
  return { body, truncated: true, originalChars, finalChars }
}
