import { qwenAccountManager, DEFAULT_QWEN_MODEL } from './qwen-accounts.mjs'

export const DEFAULT_QWEN_BASE_URL = process.env.QWEN_CHAT_BASE_URL || 'https://qwen.aikit.club/v1'

/**
 * Convert Anthropic message list & system prompt to OpenAI chat format
 */
export function anthropicToOpenAiMessages({ system = '', messages = [] } = {}) {
  const result = []

  // Add system message if present
  if (system) {
    const systemText = typeof system === 'string'
      ? system
      : Array.isArray(system)
        ? system.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n\n')
        : String(system)
    if (systemText.trim()) {
      result.push({ role: 'system', content: systemText.trim() })
    }
  }

  for (const msg of messages) {
    if (!msg) continue
    const role = msg.role === 'assistant' ? 'assistant' : 'user'

    if (typeof msg.content === 'string') {
      result.push({ role, content: msg.content })
      continue
    }

    if (Array.isArray(msg.content)) {
      const textParts = []
      const toolCalls = []
      let toolResponses = []

      for (const block of msg.content) {
        if (!block) continue
        if (block.type === 'text') {
          textParts.push(block.text || '')
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
            },
          })
        } else if (block.type === 'tool_result') {
          const resContent = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c) => c?.text || JSON.stringify(c)).join('\n')
              : JSON.stringify(block.content ?? '')
          toolResponses.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: resContent,
          })
        }
      }

      if (toolResponses.length > 0) {
        // In OpenAI format, tool result messages are role: 'tool'
        for (const tr of toolResponses) {
          result.push(tr)
        }
      } else {
        const messageObj = {
          role,
          content: textParts.join('\n') || (toolCalls.length ? '' : ''),
        }
        if (toolCalls.length > 0) {
          messageObj.tool_calls = toolCalls
        }
        result.push(messageObj)
      }
    }
  }

  return result
}

/**
 * Convert Anthropic tools schema to OpenAI tools format
 */
export function anthropicToOpenAiTools(tools = []) {
  if (!Array.isArray(tools) || !tools.length) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

export class QwenClient {
  constructor({ baseUrl = DEFAULT_QWEN_BASE_URL, accountManager = qwenAccountManager } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.accountManager = accountManager
  }

  async getToken(model = null) {
    const acc = this.accountManager.getNextAvailableAccount(model)
    if (!acc?.accessToken) {
      throw new Error(
        'No active Qwen account found. Run `qwen-agent set-token <token>` or set QWEN_ACCESS_TOKEN.'
      )
    }
    return { token: acc.accessToken, account: acc }
  }

  async validateToken(token) {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return { valid: false, status: res.status }
      const data = await res.json()
      return { valid: true, models: data?.data?.map((m) => m.id) || [] }
    } catch (err) {
      return { valid: false, error: err.message }
    }
  }

  async listModels(token = null) {
    let authToken = token
    if (!authToken) {
      const auth = await this.getToken()
      authToken = auth.token
    }
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    if (!res.ok) {
      throw new Error(`Failed to list Qwen models: HTTP ${res.status}`)
    }
    const data = await res.json()
    return data?.data || []
  }

  async createChatCompletion({
    model = DEFAULT_QWEN_MODEL,
    messages = [],
    tools = undefined,
    tool_choice = undefined,
    stream = false,
    token = null,
    temperature = undefined,
    max_tokens = undefined,
  } = {}) {
    let authToken = token
    let account = null

    if (!authToken) {
      const auth = await this.getToken(model)
      authToken = auth.token
      account = auth.account
    }

    const payload = {
      model,
      messages,
      stream: Boolean(stream),
    }

    if (tools && tools.length) {
      payload.tools = tools
      payload.tool_choice = tool_choice || 'auto'
    }
    if (typeof temperature === 'number') payload.temperature = temperature
    if (typeof max_tokens === 'number') payload.max_tokens = max_tokens

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const text = await res.text()
      if (res.status === 429 && account) {
        this.accountManager.markRateLimited(account.email, 60000, 'HTTP 429 rate limit')
      }
      throw new Error(`Qwen Chat request failed (HTTP ${res.status}): ${text}`)
    }

    if (stream) {
      return res.body
    }

    return res.json()
  }

  /**
   * Helper to parse SSE stream lines and yield clean delta objects
   */
  async *iterateSseStream(readableStream) {
    const reader = readableStream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() // keep last incomplete line

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith(':')) continue
          if (trimmed === 'data: [DONE]') return

          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6)
            try {
              const parsed = JSON.parse(dataStr)
              yield parsed
            } catch {
              // ignore partial json
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}

export const qwenClient = new QwenClient()
