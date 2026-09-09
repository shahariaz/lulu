import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AppServerTurnSession, codexSandboxForTools } from '../lib/codex-app-server.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeClient extends EventEmitter {
  constructor() {
    super()
    this.responses = []
    this.stopped = false
  }

  respond(id, result) {
    this.responses.push({ id, result })
  }

  stop() {
    this.stopped = true
  }
}

function makeSession() {
  const client = new FakeClient()
  const registry = { pendingByToolId: new Map(), sessions: new Set() }
  const session = new AppServerTurnSession({
    client,
    threadId: 'thread_1',
    turnId: 'turn_1',
    account: { email: 'test@example.com' },
    registry,
    boundaryDelayMs: 1,
    pendingToolTtlMs: 10_000,
  })
  registry.sessions.add(session)
  return { client, registry, session }
}

function makeBudgetedSession(options = {}) {
  const client = new FakeClient()
  const registry = { pendingByToolId: new Map(), sessions: new Set() }
  const session = new AppServerTurnSession({
    client,
    threadId: 'thread_1',
    turnId: 'turn_1',
    account: { email: 'test@example.com' },
    registry,
    boundaryDelayMs: 1,
    pendingToolTtlMs: 10_000,
    ...options,
  })
  registry.sessions.add(session)
  return { client, registry, session }
}

test('enables project-scoped writes only when Claude Code supplies an editing tool', () => {
  assert.equal(codexSandboxForTools([{ name: 'Read' }, { name: 'Bash' }]), 'read-only')
  assert.equal(codexSandboxForTools([{ name: 'Read' }, { name: 'Edit' }]), 'workspace-write')
  assert.equal(codexSandboxForTools([{ name: 'Write' }]), 'workspace-write')
  assert.equal(codexSandboxForTools([{ name: 'Edit' }], 'read-only'), 'read-only')
})

test('returns a late parallel tool call at the next Claude boundary', async () => {
  const { client, session } = makeSession()
  const streamedToolCalls = []
  const firstBoundary = session.waitForBoundary({
    onToolCalls: (calls) => streamedToolCalls.push(...calls),
  })

  client.emit('tool-call', {
    rpcId: 10,
    threadId: 'thread_1',
    turnId: 'turn_1',
    callId: 'call_1',
    tool: 'read_file',
    arguments: { path: 'a.js' },
  })
  assert.deepEqual((await firstBoundary).toolCalls.map((call) => call.id), ['call_1'])
  assert.deepEqual(streamedToolCalls.map((call) => call.id), ['call_1'])

  client.emit('tool-call', {
    rpcId: 11,
    threadId: 'thread_1',
    turnId: 'turn_1',
    callId: 'call_2',
    tool: 'read_file',
    arguments: '{"path":"b.js"}',
  })
  await delay(5)

  const second = await session.resume([{
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: 'first result',
  }])
  assert.deepEqual(second.toolCalls, [{
    type: 'tool_use',
    id: 'call_2',
    name: 'read_file',
    input: { path: 'b.js' },
  }])
  assert.equal(client.responses[0].id, 10)

  const finalBoundary = session.resume([{
    type: 'tool_result',
    tool_use_id: 'call_2',
    content: 'second result',
  }])
  client.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'answer_1', delta: 'done' },
  })
  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'thread_1', turnId: 'turn_1', turn: { status: 'completed' } },
  })

  assert.equal((await finalBoundary).replyText, 'done')
  assert.equal(client.responses[1].id, 11)
  assert.equal(client.stopped, true)
})

test('forwards agent text deltas before the turn completes', async () => {
  const { client, session } = makeSession()
  const deltas = []
  const boundary = session.waitForBoundary({
    onTextDelta: (delta) => deltas.push(delta),
  })

  client.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'answer_1', delta: 'first ' },
  })
  assert.deepEqual(deltas, ['first '])

  client.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'answer_1', delta: 'second' },
  })
  assert.deepEqual(deltas, ['first ', 'second'])

  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'thread_1', turnId: 'turn_1', turn: { status: 'completed' } },
  })
  assert.equal((await boundary).replyText, 'first second')
})

test('requires results only for tool calls already exposed to Claude Code', async () => {
  const { client, session } = makeSession()
  const boundary = session.waitForBoundary()
  client.emit('tool-call', {
    rpcId: 20,
    threadId: 'thread_1',
    turnId: 'turn_1',
    callId: 'call_exposed',
    tool: 'read_file',
    arguments: {},
  })
  await boundary

  await assert.rejects(
    session.resume([]),
    /Missing tool_result for call_exposed/,
  )
  session.dispose()
})

test('truncates tool results against both per-result and cumulative input budgets', async () => {
  const { client, session } = makeBudgetedSession({
    inputChars: 100,
    maxInputChars: 260,
    maxToolResultChars: 120,
  })
  const boundary = session.waitForBoundary()
  client.emit('tool-call', {
    rpcId: 30,
    threadId: 'thread_1',
    turnId: 'turn_1',
    callId: 'call_large',
    tool: 'read_file',
    arguments: {},
  })
  await boundary

  const nextBoundary = session.resume([{
    type: 'tool_result',
    tool_use_id: 'call_large',
    content: 'head-' + 'x'.repeat(1_000) + '-tail',
  }])

  const text = client.responses[0].result.contentItems[0].text
  assert.equal(text.length, 120)
  assert.match(text, /content truncated by claude-zen/)
  assert.equal(session.inputChars, 220)
  client.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'thread_1', turnId: 'turn_1', turn: { status: 'completed' } },
  })
  assert.equal((await nextBoundary).replyText, '')
})
