const BACKEND_INSTRUCTIONS = `You are the intelligence backend for Claude Code.
Claude Code is the only tool harness: it owns filesystem access, shell execution, permissions, hooks, skills, and all other side effects.
Use the dynamic tools supplied by the client. Never use Codex built-in shell, web, MCP, or computer tools. Native apply_patch is the only built-in exception and may be used only when workspace-write is enabled.
When a dynamic tool is needed, call it with structured arguments and wait for its result.
The Codex app-server sandbox mirrors Claude Code's supplied tool capabilities. When Edit or Write is supplied, workspace-write is enabled only for the stated project directory and native apply_patch may edit there. Otherwise the app-server remains read-only. Never infer that Claude Code's outer dynamic tools are unavailable from the inner sandbox label.
Use the Primary working directory stated in Claude Code's system instructions for every relative or absolute tool path. Do not write outside that directory.`

const TRUNCATION_MARKER = '\n\n[... content truncated by claude-zen to fit the Codex input limit ...]\n\n'

export function truncateTextForCodex(value, maxChars = Infinity) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text
  const limit = Math.max(0, Math.floor(maxChars))
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, limit)

  const available = limit - TRUNCATION_MARKER.length
  const headChars = Math.ceil(available / 2)
  const tailChars = available - headChars
  return text.slice(0, headChars) + TRUNCATION_MARKER + text.slice(text.length - tailChars)
}

export function codexInputCharacterCount(items = []) {
  return items.reduce((total, item) => {
    if (item?.type === 'text') return total + String(item.text || '').length
    if (item?.type === 'inputText') return total + String(item.text || '').length
    return total
  }, 0)
}

export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('')
}

export function extractClaudeWorkingDirectory(system) {
  const text = contentText(system)
  const match = text.match(/^\s*-\s*Primary working directory:\s*(.+?)\s*$/m)
  return match?.[1]?.trim() || null
}

function imageUrl(block) {
  const source = block?.source
  if (!source) return null
  if (source.type === 'url') return source.url || null
  if (source.type === 'base64' && source.media_type && source.data) {
    return `data:${source.media_type};base64,${source.data}`
  }
  return null
}

function blockDescription(block) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text') return block.text || ''
  if (block.type === 'tool_use') {
    return `[Assistant requested tool ${block.name} (call id ${block.id}) with arguments ${JSON.stringify(block.input || {})}]`
  }
  if (block.type === 'tool_result') {
    const result = typeof block.content === 'string' ? block.content : contentText(block.content)
    const status = block.is_error ? 'error' : 'result'
    return `[Tool ${status} for call id ${block.tool_use_id}]\n${result}`
  }
  if (block.type === 'image') return '[Image attached to this turn]'
  if (block.type === 'document') return '[Document attached to this turn]'
  return ''
}

export function buildCodexInstructions(body) {
  const system = contentText(body.system)
  const toolChoice = body.tool_choice
  const choiceInstruction = toolChoice?.type === 'any'
    ? 'You must call at least one supplied dynamic tool before answering.'
    : toolChoice?.type === 'tool' && toolChoice.name
      ? `Call the supplied dynamic tool named ${toolChoice.name}.`
      : toolChoice?.type === 'none'
        ? 'Do not call a tool for this turn. Answer directly.'
      : ''
  return [BACKEND_INSTRUCTIONS, system, choiceInstruction].filter(Boolean).join('\n\n')
}

export function anthropicToolsToDynamic(tools = [], toolChoice = null) {
  if (toolChoice?.type === 'none') return []
  return tools
    .filter((tool) => tool?.name)
    .map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.input_schema || { type: 'object', properties: {} },
    }))
}

export function anthropicToCodexInput(body, { maxTextChars = Infinity } = {}) {
  const transcript = []
  const images = []

  for (const message of body.messages || []) {
    const role = message.role === 'assistant' ? 'Assistant' : 'User'
    const blocks = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : (message.content || [])
    const lines = []

    for (const block of blocks) {
      const description = blockDescription(block)
      if (description) lines.push(description)
      if (block?.type === 'image') {
        const url = imageUrl(block)
        if (url) images.push({ type: 'image', url })
      }
    }

    transcript.push(`${role}:\n${lines.join('\n')}`)
  }

  const text = transcript.length
    ? `Continue this conversation as the assistant. Preserve its meaning and do not repeat the transcript.\n\n${transcript.join('\n\n')}`
    : 'Continue as the assistant.'

  return [{ type: 'text', text: truncateTextForCodex(text, maxTextChars) }, ...images]
}

export function extractToolResults(body) {
  const results = []
  for (const message of body.messages || []) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool_result' && block.tool_use_id) results.push(block)
    }
  }
  return results
}

export function toolResultContentItems(block, { maxTextChars = Infinity } = {}) {
  const content = block?.content
  if (typeof content === 'string') {
    return [{ type: 'inputText', text: truncateTextForCodex(content, maxTextChars) }]
  }
  if (!Array.isArray(content)) return [{ type: 'inputText', text: '' }]

  const items = []
  let remaining = maxTextChars
  for (const item of content) {
    if (item?.type === 'text') {
      const text = truncateTextForCodex(item.text || '', remaining)
      items.push({ type: 'inputText', text })
      if (Number.isFinite(remaining)) remaining = Math.max(0, remaining - text.length)
    }
    if (item?.type === 'image') {
      const url = imageUrl(item)
      if (url) items.push({ type: 'inputImage', imageUrl: url })
    }
  }
  return items.length ? items : [{ type: 'inputText', text: '' }]
}

export function normalizeToolArguments(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return {}
  try {
    return JSON.parse(value)
  } catch {
    return { raw: value }
  }
}

export function estimateInputTokens(body) {
  return Math.ceil((JSON.stringify(body.system || '').length + JSON.stringify(body.messages || []).length) / 4)
}

export function estimateOutputTokens(result) {
  const chars = (result.text || '').length + JSON.stringify(result.toolCalls || []).length
  return Math.ceil(chars / 4)
}
