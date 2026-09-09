import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Helper to create an offline mock Anthropic /v1/messages HTTP server.
 * Replays valid SSE streams without making any external network requests.
 */
function createMockAnthropicServer({ onTurn = null } = {}) {
  let turnCount = 0
  const recordedRequests = []

  const server = http.createServer(async (req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200)
      return res.end()
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      turnCount++
      let rawBody = ''
      for await (const chunk of req) {
        rawBody += chunk
      }

      let parsedBody = {}
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {}

      recordedRequests.push({
        turn: turnCount,
        headers: req.headers,
        body: parsedBody,
      })

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      if (onTurn) {
        onTurn(turnCount, req, res, parsedBody)
      } else {
        // Default 1-turn response: text reply
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock1","type":"message","role":"assistant","content":[],"model":"mock-model","usage":{"input_tokens":10,"output_tokens":0}}}\n\n')
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Mock response completed."}}\n\n')
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n')
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        res.end()
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        getRecordedRequests: () => recordedRequests,
        close: () => new Promise((cb) => server.close(cb)),
      })
    })
  })
}

test('Offline Harness Spike Step 1: Validate installed Claude Code CLI binary & options', () => {
  // Test that `claude` is accessible on PATH and version matches
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim()
  assert.match(version, /^2\.1\.\d+/)

  const help = execFileSync('claude', ['--help'], { encoding: 'utf8' })
  assert.match(help, /--print/)
  assert.match(help, /--output-format/)
  assert.match(help, /stream-json/)
  assert.match(help, /--bare/)
  assert.match(help, /--permission-mode/)
  assert.match(help, /dontAsk/)
})

test('Offline Harness Spike Step 2: Headless CLI connects to mock server and emits structured NDJSON', async () => {
  const mock = await createMockAnthropicServer()
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-spike-cli-'))

  const events = []
  let stdoutData = ''
  let stderrData = ''

  const child = spawn('claude', [
    '-p', 'Hello mock server',
    '--bare',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'dontAsk',
  ], {
    cwd: tmpWorkDir,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: mock.url,
      ANTHROPIC_API_KEY: 'test-mock-key-spike',
      CLAUDE_CODE_SIMPLE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => {
    stdoutData += chunk.toString()
    const lines = stdoutData.split('\n')
    stdoutData = lines.pop() // keep uncompleted line
    for (const line of lines) {
      if (line.trim()) {
        try {
          events.push(JSON.parse(line))
        } catch {}
      }
    }
  })

  child.stderr.on('data', (chunk) => {
    stderrData += chunk.toString()
  })

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code))
  })

  // Flush any trailing line
  if (stdoutData.trim()) {
    try {
      events.push(JSON.parse(stdoutData))
    } catch {}
  }

  // Verify mock server received the request
  const requests = mock.getRecordedRequests()
  assert.equal(requests.length, 1, 'Mock server should receive exactly 1 request')
  assert.match(requests[0].headers['anthropic-version'] || '', /2023-06-01/)
  const userText = Array.isArray(requests[0].body.messages[0].content)
    ? requests[0].body.messages[0].content.map((b) => b.text || '').join(' ')
    : requests[0].body.messages[0].content
  assert.match(userText, /Hello mock server/)

  // Verify structured NDJSON stream
  assert.equal(exitCode, 0, `Claude CLI should exit with 0. Stderr: ${stderrData}`)
  assert.ok(events.length >= 1, 'Should emit structured NDJSON events')

  assert.ok(events.some((e) => e.type === 'system' && e.subtype === 'init'), 'Stream must emit system init event')
  assert.ok(events.some((e) => e.type === 'result'), 'Stream must emit final result')

  const resultEvent = events.find((e) => e.type === 'result')
  assert.match(resultEvent.result, /Mock response completed/)

  await mock.close()
  fs.rmSync(tmpWorkDir, { recursive: true, force: true })
})

test('Offline Harness Spike Step 3: Multi-turn tool cycle via mock server', async () => {
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-spike-multiturn-'))
  const sampleFile = path.join(tmpWorkDir, 'test.txt')
  fs.writeFileSync(sampleFile, 'Spike verification contents')

  // Multi-turn mock server:
  // Turn 1: emits tool_use to Read test.txt
  // Turn 2: receives tool_result with file contents, emits final text
  const mock = await createMockAnthropicServer({
    onTurn: (turnCount, req, res, body) => {
      if (turnCount === 1) {
        const inputJson = JSON.stringify({ file_path: sampleFile })
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_t1","type":"message","role":"assistant","content":[],"model":"mock-model","usage":{"input_tokens":15,"output_tokens":0}}}\n\n')
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_read_01","name":"Read","input":{}}}\n\n')
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":' + JSON.stringify(inputJson) + '}}\n\n')
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":8}}\n\n')
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        res.end()
      } else {
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_t2","type":"message","role":"assistant","content":[],"model":"mock-model","usage":{"input_tokens":30,"output_tokens":0}}}\n\n')
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"File read successfully: Spike verification contents"}}\n\n')
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":10}}\n\n')
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        res.end()
      }
    }
  })

  const child = spawn('claude', [
    '-p', 'Read test file',
    '--bare',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', 'Read',
    '--permission-mode', 'dontAsk',
  ], {
    cwd: tmpWorkDir,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: mock.url,
      ANTHROPIC_API_KEY: 'test-mock-key-spike',
      CLAUDE_CODE_SIMPLE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const events = []
  let stdoutData = ''
  child.stdout.on('data', (c) => {
    stdoutData += c.toString()
    const lines = stdoutData.split('\n')
    stdoutData = lines.pop()
    for (const l of lines) {
      if (l.trim()) {
        try { events.push(JSON.parse(l)) } catch {}
      }
    }
  })

  const exitCode = await new Promise((resolve) => child.on('close', resolve))
  if (stdoutData.trim()) {
    try { events.push(JSON.parse(stdoutData)) } catch {}
  }

  // Assertions on the multi-turn interaction
  assert.equal(exitCode, 0)
  const reqs = mock.getRecordedRequests()
  assert.equal(reqs.length, 2, 'Should execute multi-turn handshake (2 turns)')

  // Turn 2 must send tool_result back to mock server
  const turn2Messages = reqs[1].body.messages
  const lastUserMsg = turn2Messages[turn2Messages.length - 1]
  assert.equal(lastUserMsg.role, 'user')
  const toolResult = Array.isArray(lastUserMsg.content)
    ? lastUserMsg.content.find((b) => b.type === 'tool_result')
    : null
  assert.ok(toolResult, 'Turn 2 must contain tool_result block')
  assert.equal(toolResult.tool_use_id, 'call_read_01')
  assert.match(JSON.stringify(toolResult.content), /Spike verification contents/)

  await mock.close()
  fs.rmSync(tmpWorkDir, { recursive: true, force: true })
})
