import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

test('Antigravity 429 falls through to Zen fallback model instead of hard-failing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-zen-fallback-'))
  const dbPath = path.join(dir, 'metrics.sqlite')
  let zenRequests = []
  let nativeRequests = []
  let agwRequests = 0

  const upstream = http.createServer(async (req, res) => {
    const body = await bodyOf(req)

    if (req.url.endsWith('/messages')) {
      // Antigravity models get 429; Zen native models (qwen3.7-plus) get 200
      if (body.model === 'qwen3.7-plus') {
        nativeRequests.push(body.model)
        res.setHeader('x-account-email', 'zen-native@local')
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('event: message_start\ndata: ' + JSON.stringify({
            type: 'message_start',
            message: { usage: { input_tokens: 5 } },
          }) + '\n\n')
          res.write('event: content_block_start\ndata: ' + JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }) + '\n\n')
          res.write('event: content_block_delta\ndata: ' + JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Zen native fallback OK' },
          }) + '\n\n')
          res.write('event: message_delta\ndata: ' + JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 4 },
          }) + '\n\n')
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
          return res.end()
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({
          id: 'msg_native_fallback',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Zen native fallback OK' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 4 },
        }))
      }

      agwRequests++
      res.writeHead(429, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: 'All Antigravity accounts are rate-limited.' },
      }))
    }

    if (req.url.endsWith('/chat/completions')) {
      zenRequests.push(body.model)
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({
          choices: [{ delta: { content: 'Zen fallback OK' } }],
        }) + '\n\n')
        res.write('data: ' + JSON.stringify({
          choices: [{ finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }) + '\n\n')
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'chat_fallback',
        choices: [{
          finish_reason: 'stop',
          message: { content: 'Zen fallback OK', tool_calls: [] },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
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
      HOME: dir,
      PORT: String(proxyPort),
      ZEN_API_KEY: 'sk-test-fallback-key-123456789',
      ZEN_DB_PATH: dbPath,
      ZEN_GO_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ZEN_FREE_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ANTIGRAVITY_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ANTIGRAVITY_MODELS: 'gemini-3.8-flash-tiered,claude-opus-4-6-thinking,claude-sonnet-4-6',
      CODEX_MODELS: '',
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
        messages: [{ role: 'user', content: 'test fallback' }],
      }),
    })

    // Non-streaming: gemini-3.8-flash-tiered 429s on antigravity, falls back to glm-5
    const res = await send('gemini-3.8-flash-tiered')
    assert.equal(res.status, 200, 'should fall back to Zen, not hard-fail with 429')
    const json = await res.json()
    const textBlock = json.content?.find((b) => b.type === 'text')
    assert.equal(textBlock?.text, 'Zen fallback OK')
    assert.deepEqual(zenRequests, ['glm-5'], 'should have sent exactly one Zen request for glm-5')
    assert.equal(agwRequests, 1, 'should have tried antigravity exactly once')

    // Streaming: same behavior
    zenRequests = []
    agwRequests = 0
    const streamRes = await send('gemini-3.8-flash-tiered', true)
    assert.equal(streamRes.status, 200)
    await streamRes.text()
    assert.deepEqual(zenRequests, ['glm-5'], 'streaming should also fall back to glm-5')
    assert.equal(agwRequests, 1)

    // Claude Opus falls back to qwen3.7-plus (native Go path)
    nativeRequests = []
    agwRequests = 0
    const opusRes = await send('claude-opus-4-6-thinking')
    assert.equal(opusRes.status, 200, 'opus should also fall back')
    const opusJson = await opusRes.json()
    const opusText = opusJson.content?.find((b) => b.type === 'text')
    assert.ok(opusText?.text, 'opus should return text content')
    assert.equal(agwRequests, 1, 'opus should try antigravity once')
    assert.deepEqual(nativeRequests, ['qwen3.7-plus'], 'opus should fall back to qwen3.7-plus via native path')
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    await close(upstream)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Non-rate-limit errors on Antigravity still hard-fail (no Zen fallback)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-no-fallback-'))
  const dbPath = path.join(dir, 'metrics.sqlite')

  const upstream = http.createServer(async (req, res) => {
    await bodyOf(req)
    if (req.url.endsWith('/messages')) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'Internal server error' } }))
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
      HOME: dir,
      PORT: String(proxyPort),
      ZEN_API_KEY: 'sk-test-nofallback-key-123456789',
      ZEN_DB_PATH: dbPath,
      ZEN_GO_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ZEN_FREE_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ANTIGRAVITY_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      ANTIGRAVITY_MODELS: 'gemini-3.8-flash-tiered',
      CODEX_MODELS: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  try {
    await waitForHealth(`http://127.0.0.1:${proxyPort}/health`, child)

    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-3.8-flash-tiered',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'test no fallback' }],
      }),
    })

    assert.equal(res.status, 500, '500 errors should not trigger Zen fallback')
    await res.text()
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    await close(upstream)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
