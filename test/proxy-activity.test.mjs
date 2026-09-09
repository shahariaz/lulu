import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const repo = path.resolve(import.meta.dirname, '..')

const listen = (server, port = 0) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => resolve(server.address().port))
})

const close = (server) => new Promise((resolve) => server.close(resolve))

function reservePort() {
  const server = http.createServer()
  return listen(server).then((port) => close(server).then(() => port))
}

function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => resolve(JSON.parse(body || '{}')))
    req.on('error', reject)
  })
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode != null) throw new Error('zen-proxy exited before becoming ready')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('zen-proxy did not become ready')
}

test('records Zen provider paths while dedicated gateways own Codex and Antigravity activity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-proxy-activity-'))
  const dbPath = path.join(dir, 'metrics.sqlite')
  const upstream = http.createServer(async (req, res) => {
    const body = await bodyOf(req)

    if (body.model === 'broken-model') {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'mock upstream unavailable' } }))
    }

    if (req.url.endsWith('/chat/completions')) {
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({
          choices: [{ delta: { reasoning_content: 'consider' } }],
        }) + '\n\n')
        res.write('data: ' + JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_stream', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 18, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 3 } },
        }) + '\n\n')
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'chat_1',
        choices: [{
          finish_reason: 'stop',
          message: { content: 'done', reasoning_content: 'considered', tool_calls: [] },
        }],
        usage: { prompt_tokens: 14, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 2 } },
      }))
    }

    if (req.url.endsWith('/messages')) {
      res.setHeader('x-account-email', body.model.startsWith('gemini') ? 'agw@example.com' : 'zen-native')
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: message_start\ndata: ' + JSON.stringify({
          type: 'message_start',
          message: { usage: { input_tokens: 22 } },
        }) + '\n\n')
        res.write('event: content_block_start\ndata: ' + JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'native_tool', name: 'Bash', input: {} },
        }) + '\n\n')
        res.write('event: message_delta\ndata: ' + JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 8 },
        }) + '\n\n')
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'msg_native',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'native thought' },
          { type: 'tool_use', id: 'native_read', name: 'Read', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 7 },
      }))
    }

    res.writeHead(404)
    res.end()
  })

  const upstreamPort = await listen(upstream)
  const proxyPort = await reservePort()
  const child = spawn(process.execPath, ['zen-proxy.mjs'], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(proxyPort),
      ZEN_API_KEY: 'test-key',
      ZEN_DB_PATH: dbPath,
      ZEN_GO_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ZEN_FREE_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ANTIGRAVITY_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ANTIGRAVITY_GATEWAY_IMPL: 'custom',
      ANTIGRAVITY_MODELS: 'gemini-test',
      CODEX_MODELS: 'codex-test',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  try {
    await waitForHealth(`http://127.0.0.1:${proxyPort}/health`, child)
    const send = (model, stream = false) => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream,
        max_tokens: 50,
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: 'test' }],
      }),
    })

    const responses = [
      await send('mimo-v2.5'),
      await send('mimo-v2.5', true),
      await send('qwen3.7-plus'),
      await send('gemini-test'),
      await send('gemini-test', true),
      await send('broken-model'),
    ]
    await Promise.all(responses.map(response => response.text()))
    assert.equal(responses.at(-1).status, 503)

    for (let attempt = 0; attempt < 40; attempt++) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const count = db.prepare('SELECT COUNT(*) AS count FROM requests').get().count
      db.close()
      if (count === 4) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    const db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare('SELECT * FROM requests ORDER BY timestamp').all()
    db.close()

    assert.equal(rows.length, 4)
    assert.equal(rows.filter(row => row.provider === 'antigravity').length, 0)
    assert.equal(rows.filter(row => row.provider === 'zen').length, 4)
    assert.equal(rows.filter(row => row.status === 'error').length, 1, JSON.stringify(rows.map(row => ({ provider: row.provider, model: row.model, status: row.status, error: row.error_message }))))
    assert.ok(rows.every(row => row.duration_ms >= 0))
    assert.ok(rows.every(row => row.reasoning_effort === 'high'))
    assert.ok(rows.some(row => row.reasoning_tokens > 0))
    assert.ok(rows.some(row => row.tools_called?.includes('Read')))
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    await close(upstream)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('records Antigravity turns when running under the open-source gateway', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-proxy-agw-open-'))
  const dbPath = path.join(dir, 'metrics.sqlite')
  const upstream = http.createServer(async (req, res) => {
    const body = await bodyOf(req)
    if (req.url.endsWith('/messages')) {
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: message_start\ndata: ' + JSON.stringify({
          type: 'message_start',
          message: { usage: { input_tokens: 30 } },
        }) + '\n\n')
        res.write('event: content_block_start\ndata: ' + JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'open_tool', name: 'Bash', input: {} },
        }) + '\n\n')
        res.write('event: message_delta\ndata: ' + JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 12 },
        }) + '\n\n')
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'msg_open',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'open source response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 25, output_tokens: 10 },
      }))
    }
    res.writeHead(404)
    res.end()
  })

  const upstreamPort = await listen(upstream)
  const proxyPort = await reservePort()
  const child = spawn(process.execPath, ['zen-proxy.mjs'], {
    cwd: repo,
    env: {
      ...process.env,
      PORT: String(proxyPort),
      ZEN_API_KEY: 'test-key',
      ZEN_DB_PATH: dbPath,
      ANTIGRAVITY_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ANTIGRAVITY_GATEWAY_IMPL: 'opensource',
      ANTIGRAVITY_MODELS: 'gemini-3.8-flash-tiered',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  try {
    await waitForHealth(`http://127.0.0.1:${proxyPort}/health`, child)
    const send = (stream = false) => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tiered',
        stream,
        max_tokens: 50,
        messages: [{ role: 'user', content: 'test open-source tracking' }],
      }),
    })

    const responses = [await send(false), await send(true)]
    await Promise.all(responses.map(r => r.text()))

    for (let attempt = 0; attempt < 40; attempt++) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const count = db.prepare("SELECT COUNT(*) AS count FROM requests WHERE provider = 'antigravity'").get().count
      db.close()
      if (count === 2) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    const db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare("SELECT * FROM requests WHERE provider = 'antigravity' ORDER BY timestamp").all()
    db.close()

    assert.equal(rows.length, 2)
    assert.equal(rows[0].provider, 'antigravity')
    assert.equal(rows[0].model, 'gemini-3.8-flash-tiered')
    assert.equal(rows[0].status, 'success')
    assert.equal(rows[0].input_tokens, 25)
    assert.equal(rows[0].output_tokens, 10)
    assert.equal(rows[1].input_tokens, 30)
    assert.equal(rows[1].output_tokens, 12)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    await close(upstream)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('OpenCode rate limit is persisted and the cooled-down key is not sent again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-proxy-cooldown-'))
  const dbPath = path.join(dir, 'metrics.sqlite')
  let upstreamRequests = 0
  let receivedHeaders = null
  const upstream = http.createServer(async (req, res) => {
    upstreamRequests++
    receivedHeaders = req.headers
    await bodyOf(req)
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': '120',
    })
    res.end(JSON.stringify({ error: { message: 'FreeUsageLimitError: Rate limit exceeded' } }))
  })

  const upstreamPort = await listen(upstream)
  const proxyPort = await reservePort()
  const child = spawn(process.execPath, [path.join(repo, 'zen-proxy.mjs')], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: dir,
      PORT: String(proxyPort),
      ZEN_API_KEY: 'sk-test-cooldown-key-111111111111111111',
      ZEN_DB_PATH: dbPath,
      ZEN_FREE_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const request = () => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.5-free',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'cooldown test' }],
    }),
  })

  try {
    await waitForHealth(`http://127.0.0.1:${proxyPort}/health`, child)
    const first = await request()
    assert.equal(first.status, 429)
    await first.text()

    const second = await request()
    assert.equal(second.status, 429)
    assert.equal(second.headers.get('retry-after'), '120')
    await second.text()

    assert.equal(upstreamRequests, 1, 'cooled-down API key must not be sent upstream again')
    assert.match(receivedHeaders['x-opencode-project'], /^prj_/)
    assert.match(receivedHeaders['x-opencode-session'], /^ses_/)
    assert.match(receivedHeaders['x-opencode-request'], /^msg_/)
    assert.equal(receivedHeaders['x-opencode-client'], 'cli')
    assert.match(receivedHeaders['user-agent'], /^opencode\//)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    await close(upstream)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
