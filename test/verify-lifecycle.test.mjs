import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

const close = (server) => new Promise(resolve => server.close(resolve))

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

test('verification leaves an existing production proxy running', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-verify-lifecycle-'))
  const runtimeDir = path.join(tempDir, '.zen-claude')
  const binDir = path.join(tempDir, 'bin')
  const coldPidFile = path.join(tempDir, 'cold-proxy.pid')
  fs.mkdirSync(path.join(runtimeDir, 'lib'), { recursive: true })
  fs.mkdirSync(binDir)

  const proxy = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/health') return res.end('{"ok":true}')
    res.end('{"content":[{"type":"tool_use","id":"toolu_test","name":"ls","input":{}}]}')
  })
  const codex = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/dashboard' ? 'text/html' : 'application/json')
    if (req.url === '/health') return res.end('{"codex":true}')
    if (req.url === '/dashboard') return res.end('<title>Claude-Zen</title>')
    if (req.url === '/api/stats') return res.end('{"today":{}}')
    if (req.url === '/api/accounts') return res.end('[]')
    if (req.url === '/api/pool') return res.end('{}')
    if (req.url?.startsWith('/api/export')) return res.end('{}')
    res.writeHead(404)
    res.end('{}')
  })
  const antigravity = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/health') return res.end('{"antigravity":true}')
    res.writeHead(404)
    res.end('{}')
  })

  const proxyPort = await listen(proxy)
  const codexPort = await listen(codex)
  const antigravityPort = await listen(antigravity)

  fs.writeFileSync(path.join(runtimeDir, 'zen-proxy.mjs'), `import http from 'node:http'
import fs from 'node:fs'
fs.writeFileSync(process.env.TEST_COLD_PID_FILE, String(process.pid))
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(req.url === '/health' ? '{"ok":true}' : '{"content":[{"type":"text","text":"12"}]}')
})
server.listen(Number(process.env.PORT), '127.0.0.1')
`)

  fs.writeFileSync(path.join(runtimeDir, '.env'), 'ZEN_API_KEY=sk-test-test-test-test-test-test-test\\n')
  fs.writeFileSync(path.join(runtimeDir, 'lib', 'db.mjs'), `
export const getDb = () => ({})
export const getStats = () => ({ accounts_summary: { total: 0 } })
`)
  const realCurl = execFileSync('/bin/sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(binDir, 'curl'), `#!/bin/sh
case "$*" in
  *https://opencode.ai/zen/v1/messages*)
    printf '%s' '{"error":{"message":"expected test response"}}'
    ;;
  *)
    exec "$TEST_REAL_CURL" "$@"
    ;;
esac
`, { mode: 0o755 })

  try {
    const result = await run('/bin/bash', [path.join(repo, 'verify.sh')], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: tempDir,
        TMPDIR: tempDir,
        PATH: `${binDir}:${process.env.PATH}`,
        ZEN_PROXY_PORT: String(proxyPort),
        CODEX_PORT: String(codexPort),
        ANTIGRAVITY_PORT: String(antigravityPort),
        TEST_COLD_PID_FILE: coldPidFile,
        TEST_REAL_CURL: realCurl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /cold-cache replay in isolated proxy/)
    assert.match(result.stdout, /10 passed, 0 failed/)
    assert.equal(proxy.listening, true)

    const response = await fetch(`http://127.0.0.1:${proxyPort}/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })

    const coldPid = Number(fs.readFileSync(coldPidFile, 'utf8'))
    assert.throws(() => process.kill(coldPid, 0), error => error?.code === 'ESRCH')
    assert.deepEqual(
      fs.readdirSync(tempDir).filter(name => name.startsWith('claude-zen-verify.')),
      [],
    )
  } finally {
    await close(proxy)
    await close(codex)
    await close(antigravity)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
