import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-agw-test-'))
process.env.ZEN_DB_PATH = path.join(tempDir, 'metrics.sqlite')
process.env.ANTIGRAVITY_ACCOUNTS_PATH = path.join(tempDir, 'accounts.json')

const { getDb, getRecentRequests } = await import('../lib/db.mjs')
const { antigravityAccountManager } = await import('../lib/antigravity-accounts.mjs')
const { AntigravityClient } = await import('../lib/antigravity-client.mjs')
const {
  findAntigravityModel,
  normalizeAntigravityModel,
  antigravityAnthropicModels,
} = await import('../lib/antigravity-models.mjs')
const {
  convertAnthropicToGoogle,
  convertGoogleToAnthropic,
  streamGoogleToAnthropic,
} = await import('../lib/anthropic-antigravity.mjs')

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

const close = (server) => new Promise((resolve) => server.close(resolve))

test('Antigravity model catalog supports Gemini 3.8 Flash, Claude Opus 4.6, Claude Sonnet 4.6 and rejects other models', () => {
  assert.equal(normalizeAntigravityModel('gemini-3.8-flash'), 'gemini-3.8-flash-tiered')
  assert.equal(normalizeAntigravityModel('gemini-3.8-flash-tiered'), 'gemini-3.8-flash-tiered')
  assert.equal(normalizeAntigravityModel('claude-opus-4-6'), 'claude-opus-4-6-thinking')
  assert.equal(normalizeAntigravityModel('claude-opus-4-6-thinking'), 'claude-opus-4-6-thinking')
  assert.equal(normalizeAntigravityModel('claude-sonnet-4-6'), 'claude-sonnet-4-6')
  assert.equal(normalizeAntigravityModel('claude-sonnet-4-6-thinking'), 'claude-sonnet-4-6')
  assert.equal(normalizeAntigravityModel('gemini-3.1-pro-high'), 'gemini-pro-agent')

  assert.equal(normalizeAntigravityModel('gpt-4o'), null)
  assert.equal(normalizeAntigravityModel('gemini-1.5-pro'), null)

  const models = antigravityAnthropicModels()
  assert.ok(models.some((m) => m.id === 'gemini-3.8-flash-tiered'))
  assert.ok(models.some((m) => m.id === 'claude-opus-4-6-thinking'))
  assert.ok(models.some((m) => m.id === 'claude-sonnet-4-6'))
})

test('AntigravityAccountManager manages accounts, sticky selection, and rate limits in SQLite', async () => {
  await antigravityAccountManager.init()
  const accId = 'agw_test_user_gmail_com'
  const { upsertAccount } = await import('../lib/db.mjs')
  upsertAccount({
    id: accId,
    provider: 'antigravity',
    email: 'test-user@gmail.com',
    name: 'Google (test-project)',
    account_id: 'test-project',
    plan_type: 'google-oauth',
    access_token: 'valid_access_token_123',
    expires_at: Date.now() + 3600000,
    status: 'active',
  })
  antigravityAccountManager.reloadFromDb()
  const setActiveResult = antigravityAccountManager.setActiveAccount(accId)
  assert.equal(setActiveResult, true)

  const list = antigravityAccountManager.listAccounts()
  assert.ok(list.some((a) => a.email === 'test-user@gmail.com'))

  const turn = await antigravityAccountManager.getAccountForTurn('gemini-3.8-flash-tiered')
  assert.ok(turn.account)
  assert.equal(turn.account.email, 'test-user@gmail.com')
  assert.equal(turn.project, 'test-project')

  // Mark rate limited
  antigravityAccountManager.markRateLimited('test-user@gmail.com', 60000, 'Quota limit', 'gemini-3.8-flash-tiered')
  const limited = antigravityAccountManager.listAccounts().find((a) => a.email === 'test-user@gmail.com')
  assert.equal(limited.status, 'partially_limited')
  assert.equal(limited.model_rate_limits[0].model, 'gemini-3.8-flash-tiered')
  assert.ok(!antigravityAccountManager.getAvailableAccounts('gemini-3.8-flash-tiered').some((a) => a.email === 'test-user@gmail.com'))
  assert.ok(antigravityAccountManager.getAvailableAccounts('claude-sonnet-4-6').some((a) => a.email === 'test-user@gmail.com'))

  // Reset limits
  antigravityAccountManager.resetAllLimits()
  const active = antigravityAccountManager.listAccounts().find((a) => a.email === 'test-user@gmail.com')
  assert.equal(active.status, 'active')
})

test('AntigravityClient executes turn against mocked Cloud Code API with streaming and failover', async () => {
  antigravityAccountManager.reloadFromDb()
  antigravityAccountManager.setActiveAccount('agw_test_user_gmail_com')
  // Mock Google Cloud Code backend
  let requestCount = 0
  const mockCloudCode = http.createServer((req, res) => {
    requestCount++
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      const isSayHello = parsed.request?.contents?.some?.((c) =>
        c.parts?.some?.((p) => p.text === 'Say hello'))

      if (req.url?.includes('streamGenerateContent')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const parts = isSayHello
          ? [{ text: 'Non-streaming answer' }]
          : [
              { thought: true, text: 'Thinking about the code...', thoughtSignature: 'sig_12345678901234567890123456789012345678901234567890' },
              { text: 'Result message' },
              { functionCall: { id: 'call_abc', name: 'Write', args: { file: 'a.txt', content: 'hello' } } },
            ]
        const ssePayload = [
          'data: ' + JSON.stringify({
            response: {
              candidates: [
                {
                  content: { parts },
                  finishReason: isSayHello ? 'STOP' : 'TOOL_USE',
                },
              ],
              usageMetadata: {
                promptTokenCount: 120,
                cachedContentTokenCount: 20,
                candidatesTokenCount: 60,
                thoughtsTokenCount: isSayHello ? 0 : 30,
              },
            },
          }) + '\n\n',
          'data: [DONE]\n\n',
        ]
        for (const line of ssePayload) res.write(line)
        res.end()
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [{ text: 'Non-streaming answer' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 25 },
        },
      }))
    })
  })

  const mockPort = await listen(mockCloudCode)
  const client = new AntigravityClient({ accountManager: antigravityAccountManager })

  // Override endpoint fallback for test
  const originalEndpoints = [...(await import('../lib/antigravity-accounts.mjs')).ANTIGRAVITY_ENDPOINT_FALLBACKS]
  const accountsModule = await import('../lib/antigravity-accounts.mjs')
  accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.length = 0
  accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.push(`http://127.0.0.1:${mockPort}`)

  try {
    // Streaming turn
    const streamResult = await client.executeTurn({
      model: 'gemini-3.8-flash-tiered',
      messages: [{ role: 'user', content: 'Write file' }],
      stream: true,
    })

    assert.equal(streamResult.type, 'stream')
    assert.equal(streamResult.accountEmail, 'test-user@gmail.com')

    const events = []
    for await (const ev of streamResult.generator) {
      events.push(ev)
    }

    assert.ok(events.some((e) => e.type === 'message_start'))
    assert.ok(events.some((e) => e.type === 'content_block_start' && e.content_block?.type === 'thinking'))
    assert.ok(events.some((e) => e.type === 'content_block_start' && e.content_block?.type === 'text'))
    assert.ok(events.some((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use'))
    assert.ok(events.some((e) => e.type === 'message_delta'))
    assert.ok(events.some((e) => e.type === 'message_stop'))

    // Non-streaming turn
    const jsonResult = await client.executeTurn({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Say hello' }],
      stream: false,
    })
    assert.equal(jsonResult.type, 'json')
    assert.equal(jsonResult.data.content[0].text, 'Non-streaming answer')
  } finally {
    accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.length = 0
    accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.push(...originalEndpoints)
    await close(mockCloudCode)
  }
})

test('AntigravityClient preserves non-rate-limit upstream errors', async () => {
  const mockCloudCode = http.createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Unknown model' } }))
  })
  const mockPort = await listen(mockCloudCode)
  const accountsModule = await import('../lib/antigravity-accounts.mjs')
  const originalEndpoints = [...accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS]
  accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.length = 0
  accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.push(`http://127.0.0.1:${mockPort}`)
  const accountManager = {
    accounts: [{}],
    async init() {},
    async getAccountForTurn() {
      return { account: { email: 'test@example.com' }, token: 'token', project: 'project' }
    },
    markRateLimited() {
      assert.fail('404 must not be recorded as a rate limit')
    },
  }

  try {
    const client = new AntigravityClient({ accountManager })
    await assert.rejects(
      client.executeTurn({ model: 'claude-opus-4-6-thinking', messages: [{ role: 'user', content: 'Hello' }] }),
      (error) => error.statusCode === 404 && /Unknown model/.test(error.message),
    )
  } finally {
    accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.length = 0
    accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.push(...originalEndpoints)
    await close(mockCloudCode)
  }
})

test('AntigravityClient tries each account once and succeeds on the next account after 429', async () => {
  const seenTokens = []
  const mockCloudCode = http.createServer((req, res) => {
    const token = req.headers.authorization
    seenTokens.push(token)
    if (token === 'Bearer token-a') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      return res.end(JSON.stringify({ error: { message: 'quota exhausted' } }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ text: 'fallback account worked' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
      },
    }))
  })
  const mockPort = await listen(mockCloudCode)
  const accountsModule = await import('../lib/antigravity-accounts.mjs')
  const originalEndpoints = [...accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS]
  accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.length = 0
  // Both entries represent the same account quota. A 429 must rotate the
  // account immediately instead of replaying the payload on endpoint two.
  accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.push(
    `http://127.0.0.1:${mockPort}`,
    `http://127.0.0.1:${mockPort}`,
  )
  const accounts = [{ email: 'a@example.com' }, { email: 'b@example.com' }]
  const limited = []
  const accountManager = {
    accounts,
    async init() {},
    reloadFromDb() {},
    async getAccountForTurn(_model, { excludeEmails } = {}) {
      const account = accounts.find((item) => !excludeEmails?.has(item.email))
      return account
        ? { account, token: account === accounts[0] ? 'token-a' : 'token-b', project: 'project' }
        : { account: null, error: 'all exhausted' }
    },
    markRateLimited(email) { limited.push(email) },
  }

  try {
    const result = await new AntigravityClient({ accountManager }).executeTurn({
      model: 'custom-fallback-model',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(result.accountEmail, 'b@example.com')
    assert.deepEqual(seenTokens, ['Bearer token-a', 'Bearer token-b'])
    assert.deepEqual(limited, ['a@example.com'])
  } finally {
    accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.length = 0
    accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.push(...originalEndpoints)
    await close(mockCloudCode)
  }
})

test('AntigravityClient waits for a short all-account cooldown and retries', async () => {
  let selectionCount = 0
  let requests = 0
  const accountManager = {
    accounts: [{ email: 'cooling@example.com' }],
    async init() {},
    reloadFromDb() {},
    async getAccountForTurn() {
      selectionCount++
      if (selectionCount === 1) return { account: { email: 'cooling@example.com' }, token: 'token', project: 'project' }
      if (selectionCount === 2) return { account: null, waitMs: 5, error: 'cooling down' }
      return { account: { email: 'cooling@example.com' }, token: 'token', project: 'project' }
    },
    markRateLimited() {},
  }
  const mockCloudCode = http.createServer((_req, res) => {
    requests++
    if (requests === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' })
      return res.end(JSON.stringify({ error: { message: 'quota exhausted' } }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ text: 'after cooldown' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      },
    }))
  })
  const mockPort = await listen(mockCloudCode)
  const accountsModule = await import('../lib/antigravity-accounts.mjs')
  const originalEndpoints = [...accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS]
  accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.length = 0
  accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.push(`http://127.0.0.1:${mockPort}`)
  try {
    const result = await new AntigravityClient({ accountManager }).executeTurn({
      model: 'custom-fallback-model',
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(result.data.content[0].text, 'after cooldown')
    assert.equal(requests, 2)
  } finally {
    accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.length = 0
    accountsModule.ANTIGRAVITY_ENDPOINT_FALLBACKS.push(...originalEndpoints)
    await close(mockCloudCode)
  }
})
