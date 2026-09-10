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
 *
 * NOT every POST is an agent turn. Claude Code also issues auxiliary calls on the same
 * endpoint — as of 2.1.231 it generates a conversation title before doing any work. Those
 * calls declare NO tools, whereas a real agent turn always offers the session's tool set.
 * `isAgentTurn` uses that to keep `turnCount` counting only the turns a harness cares about,
 * so an added auxiliary call in a future CLI release does not shift turn numbering and
 * silently break every multi-turn assertion.
 */
function isAgentTurn(body) {
  return Array.isArray(body?.tools) && body.tools.length > 0
}

function createMockAnthropicServer({ onTurn = null } = {}) {
  let turnCount = 0
  const recordedRequests = []
  const auxiliaryRequests = []

  const server = http.createServer(async (req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200)
      return res.end()
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      let rawBody = ''
      for await (const chunk of req) {
        rawBody += chunk
      }

      let parsedBody = {}
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {}

      const record = { headers: req.headers, body: parsedBody }
      if (isAgentTurn(parsedBody)) {
        turnCount++
        record.turn = turnCount
        recordedRequests.push(record)
      } else {
        auxiliaryRequests.push(record)
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      // Auxiliary (non-agent) calls always get the simple default reply — they are not part
      // of the turn script under test.
      if (onTurn && record.turn) {
        onTurn(record.turn, req, res, parsedBody)
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
        getAuxiliaryRequests: () => auxiliaryRequests,
        close: () => new Promise((cb) => server.close(cb)),
      })
    })
  })
}

/**
 * Spawn the headless CLI, collect its NDJSON event stream, and ALWAYS resolve.
 *
 * The bare `child.on('close')` promise these tests used before had no timeout: a CLI that
 * never exited hung the test, and because node:test keeps the process alive while the mock
 * server handle is open, it hung the ENTIRE suite with no output. That is why the full suite
 * could not be run to completion.
 */
function runClaudeCli(args, { cwd, env, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const events = []
    let stdoutData = ''
    let stderrData = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString()
      const lines = stdoutData.split('\n')
      stdoutData = lines.pop() // keep the incomplete trailing line
      for (const line of lines) {
        if (line.trim()) {
          try { events.push(JSON.parse(line)) } catch {}
        }
      }
    })
    child.stderr.on('data', (chunk) => { stderrData += chunk.toString() })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (stdoutData.trim()) {
        try { events.push(JSON.parse(stdoutData)) } catch {}
      }
      resolve({ exitCode: code, events, stderr: stderrData, timedOut })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ exitCode: -1, events, stderr: `spawn failed: ${err.message}`, timedOut })
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

  try {
    // Pinned to the exact flag set lib/orchestrator/worker-harness.mjs spawns. If a CLI
    // upgrade breaks any of these, this test fails instead of the worker failing in production.
    const { exitCode, events, stderr, timedOut } = await runClaudeCli([
      '-p', 'Hello mock server',
      '--bare',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'dontAsk',
    ], {
      cwd: tmpWorkDir,
      env: {
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'test-mock-key-spike',
        CLAUDE_CODE_SIMPLE: '1',
      },
    })

    assert.equal(timedOut, false, 'CLI must not hang')
    assert.equal(exitCode, 0, `Claude CLI should exit 0. Stderr: ${stderr}`)

    // The load-bearing contract: ANTHROPIC_BASE_URL redirected the CLI to OUR server.
    // This indirection is what lets the worker run on pooled subscriptions instead of a
    // metered Anthropic key — if it ever silently stops working, the cost model is gone.
    const requests = mock.getRecordedRequests()
    assert.ok(requests.length >= 1, 'Mock server must receive at least one agent turn')
    assert.match(requests[0].headers['anthropic-version'] || '', /2023-06-01/)

    // Our prompt must reach the model. Search the whole turn: the CLI wraps the prompt in
    // session/system-reminder scaffolding whose exact position is not part of the contract.
    const promptReached = requests.some((r) => /Hello mock server/.test(JSON.stringify(r.body.messages)))
      || mock.getAuxiliaryRequests().some((r) => /Hello mock server/.test(JSON.stringify(r.body.messages)))
    assert.ok(promptReached, 'The user prompt must be transmitted to the gateway')

    // Structured NDJSON is what worker-harness parses for usage and progress.
    assert.ok(events.some((e) => e.type === 'system' && e.subtype === 'init'), 'Stream must emit system init event')
    const resultEvent = events.find((e) => e.type === 'result')
    assert.ok(resultEvent, 'Stream must emit a final result event')
    assert.match(resultEvent.result, /Mock response completed/)
  } finally {
    // Unconditional: a leaked HTTP server handle keeps node:test alive forever.
    await mock.close()
    fs.rmSync(tmpWorkDir, { recursive: true, force: true })
  }
})

test('Offline Harness Spike Step 3: Multi-turn tool cycle via mock server', async () => {
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-spike-multiturn-'))
  const sampleFile = path.join(tmpWorkDir, 'test.txt')
  fs.writeFileSync(sampleFile, 'Spike verification contents')

  // Agent turn 1: emit tool_use to Read test.txt
  // Agent turn 2: receives tool_result with file contents, emits final text
  const mock = await createMockAnthropicServer({
    onTurn: (turnCount, req, res) => {
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

  try {
    const { exitCode, stderr, timedOut } = await runClaudeCli([
      '-p', 'Read test file',
      '--bare',
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', 'Read',
      '--permission-mode', 'dontAsk',
    ], {
      cwd: tmpWorkDir,
      env: {
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'test-mock-key-spike',
        CLAUDE_CODE_SIMPLE: '1',
      },
    })

    assert.equal(timedOut, false, 'CLI must not hang')
    assert.equal(exitCode, 0, `Claude CLI should exit 0. Stderr: ${stderr}`)

    // The tool cycle is what makes the CLI usable as a worker: it must execute a tool locally
    // and feed the result back to the gateway as a second turn.
    const reqs = mock.getRecordedRequests()
    assert.ok(reqs.length >= 2, `Should execute a multi-turn tool handshake, saw ${reqs.length} agent turn(s)`)

    const turn2Messages = reqs[1].body.messages
    const lastUserMsg = turn2Messages[turn2Messages.length - 1]
    assert.equal(lastUserMsg.role, 'user')
    const toolResult = Array.isArray(lastUserMsg.content)
      ? lastUserMsg.content.find((b) => b.type === 'tool_result')
      : null
    assert.ok(toolResult, 'Turn 2 must contain tool_result block')
    assert.equal(toolResult.tool_use_id, 'call_read_01')
    assert.match(JSON.stringify(toolResult.content), /Spike verification contents/)
  } finally {
    await mock.close()
    fs.rmSync(tmpWorkDir, { recursive: true, force: true })
  }
})

/**
 * Step 4 pins the WORKER TOOL SET — the flags in worker-harness.mjs must yield exactly the
 * tools a worker needs, and nothing else.
 *
 * This exists because of a real defect: worker-harness previously passed
 *   --bare --tools Read,Edit,Write,Bash
 * and `--bare` silently reduced the built-in set to ["Bash","Edit","Read"], dropping Write.
 * The flag was ignored rather than rejected, so the worker could edit existing files but never
 * create one — invisible until a task needed a new file.
 *
 * It also pins --strict-mcp-config: without it the worker inherits the host's MCP servers
 * (web search and friends), silently widening its reach far past the task scope.
 */
test('Offline Harness Spike Step 4: worker flag set yields exactly Read/Edit/Write/Bash', async () => {
  const mock = await createMockAnthropicServer()
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-spike-tools-'))

  try {
    const { events, timedOut } = await runClaudeCli([
      '-p', 'list your tools',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools', 'Read,Edit,Write,Bash',
      '--strict-mcp-config',
      '--permission-mode', 'dontAsk',
    ], {
      cwd: tmpWorkDir,
      env: {
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'test-mock-key-spike',
        // Deliberately NOT setting CLAUDE_CODE_SIMPLE — it strips Write exactly like --bare.
      },
    })

    assert.equal(timedOut, false, 'CLI must not hang')

    const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
    assert.ok(init, 'CLI must emit a system init event listing its tools')

    const tools = [...(init.tools || [])].sort()
    assert.deepEqual(
      tools,
      ['Bash', 'Edit', 'Read', 'Write'],
      `Worker tool set drifted. Got: ${JSON.stringify(init.tools)}. ` +
      'Write missing usually means --bare crept back in; extra mcp__* entries mean ' +
      '--strict-mcp-config was dropped.',
    )
  } finally {
    await mock.close()
    fs.rmSync(tmpWorkDir, { recursive: true, force: true })
  }
})
