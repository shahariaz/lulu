import { randomUUID } from 'node:crypto'

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export class AnthropicSseWriter {
  constructor(res, { model, inputTokens = 0, messageId = null } = {}) {
    this.res = res
    this.model = model
    this.inputTokens = inputTokens
    this.messageId = messageId || `msg_${randomUUID().slice(0, 16)}`
    this.started = false
    this.ended = false
    this.nextBlockIndex = 0
    this.textBlockIndex = null
    this.sentToolCallIds = new Set()
  }

  start(inputTokens = this.inputTokens) {
    if (this.started || this.ended) return
    this.started = true
    this.inputTokens = inputTokens
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    this.res.flushHeaders?.()
    sendEvent(this.res, 'message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })
  }

  textDelta(text) {
    if (!text || this.ended) return
    this.start()
    if (this.textBlockIndex === null) {
      this.textBlockIndex = this.nextBlockIndex++
      sendEvent(this.res, 'content_block_start', {
        type: 'content_block_start',
        index: this.textBlockIndex,
        content_block: { type: 'text', text: '' },
      })
    }
    sendEvent(this.res, 'content_block_delta', {
      type: 'content_block_delta',
      index: this.textBlockIndex,
      delta: { type: 'text_delta', text },
    })
  }

  toolCalls(calls = []) {
    const unsent = calls.filter((call) => call?.id && !this.sentToolCallIds.has(call.id))
    if (!unsent.length || this.ended) return
    this.start()
    this.#closeTextBlock()
    for (const call of unsent) {
      this.sentToolCallIds.add(call.id)
      const index = this.nextBlockIndex++
      sendEvent(this.res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      })
      sendEvent(this.res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input || {}) },
      })
      sendEvent(this.res, 'content_block_stop', { type: 'content_block_stop', index })
    }
  }

  finish({ stopReason = 'end_turn', inputTokens = this.inputTokens, outputTokens = 0, toolCalls = [] } = {}) {
    if (this.ended) return
    this.start(inputTokens)
    this.toolCalls(toolCalls)
    this.#closeTextBlock()
    sendEvent(this.res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })
    sendEvent(this.res, 'message_stop', { type: 'message_stop' })
    this.ended = true
    this.res.end()
  }

  fail(message, type = 'api_error') {
    if (!this.started || this.ended) return false
    this.#closeTextBlock()
    sendEvent(this.res, 'error', {
      type: 'error',
      error: { type, message },
    })
    this.ended = true
    this.res.end()
    return true
  }

  #closeTextBlock() {
    if (this.textBlockIndex === null) return
    sendEvent(this.res, 'content_block_stop', {
      type: 'content_block_stop',
      index: this.textBlockIndex,
    })
    this.textBlockIndex = null
  }
}
