import test from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicSseWriter } from '../lib/anthropic-sse.mjs'

class FakeResponse {
  constructor() {
    this.status = null
    this.headers = null
    this.chunks = []
    this.flushed = false
    this.finished = false
  }

  writeHead(status, headers) {
    this.status = status
    this.headers = headers
  }

  flushHeaders() {
    this.flushed = true
  }

  write(chunk) {
    this.chunks.push(chunk)
  }

  end() {
    this.finished = true
  }
}

function events(response) {
  return response.chunks.map((chunk) => {
    const [eventLine, dataLine] = chunk.trim().split('\n')
    return {
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLine.slice('data: '.length)),
    }
  })
}

test('streams text deltas immediately with valid Anthropic block ordering', () => {
  const response = new FakeResponse()
  const writer = new AnthropicSseWriter(response, {
    model: 'gpt-5.6-sol',
    inputTokens: 12,
    messageId: 'msg_test',
  })

  writer.textDelta('first ')
  assert.equal(response.status, 200)
  assert.equal(response.flushed, true)
  assert.equal(events(response).at(-1).data.delta.text, 'first ')

  writer.textDelta('second')
  writer.toolCalls([{ id: 'call_1', name: 'read_file', input: { path: 'a.js' } }])
  writer.textDelta('after tool')
  writer.finish({ stopReason: 'tool_use', outputTokens: 9, toolCalls: [{ id: 'call_1' }] })

  const emitted = events(response)
  assert.deepEqual(emitted.map((item) => item.event), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  assert.deepEqual(
    emitted.filter((item) => item.event === 'content_block_start').map((item) => item.data.index),
    [0, 1, 2],
  )
  assert.equal(
    emitted.filter((item) => item.data?.content_block?.type === 'tool_use').length,
    1,
  )
  assert.equal(response.finished, true)
})

test('emits an Anthropic error event after a started stream fails', () => {
  const response = new FakeResponse()
  const writer = new AnthropicSseWriter(response, { model: 'gpt-5.6-sol' })

  writer.textDelta('partial')
  assert.equal(writer.fail('backend disconnected'), true)

  const emitted = events(response)
  assert.equal(emitted.at(-1).event, 'error')
  assert.equal(emitted.at(-1).data.error.message, 'backend disconnected')
  assert.equal(response.finished, true)
})
