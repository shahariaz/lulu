import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-proxy-rotation-test-'))
process.env.ZEN_DB_PATH = path.join(tempDir, 'metrics.sqlite')

const { getDb, getRecentRequests } = await import('../lib/db.mjs')
const { zenAccountManager } = await import('../lib/zen-accounts.mjs')

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

const close = (server) => new Promise((resolve) => server.close(resolve))

test('OpenCode Zen multi-account rotation seamlessly retries turn on 429 rate limit', async () => {
  const manager = new (await import('../lib/zen-accounts.mjs')).ZenAccountManager()
  await manager.init()

  // Clean out any imported .env accounts from the test instance
  const db = getDb()
  db.prepare('DELETE FROM accounts WHERE provider = ?').run('zen')
  manager.reloadFromDb()
  manager.stickyAccountByModel.clear()

  // Add 2 accounts
  manager.addAccountFromApiKey({
    apiKey: 'sk-account-1-first-key-111111111111',
    email: 'acc1@opencode.ai',
    planType: 'hybrid',
  })
  manager.addAccountFromApiKey({
    apiKey: 'sk-account-2-second-key-222222222222',
    email: 'acc2@opencode.ai',
    planType: 'hybrid',
  })
  manager.setActiveAccount('acc1@opencode.ai')

  let requestCount = 0
  const keysReceived = []

  const mockZenUpstream = http.createServer((req, res) => {
    requestCount++
    const authHeader = req.headers.authorization || ''
    keysReceived.push(authHeader)

    if (authHeader.includes('sk-account-1')) {
      // First account hits 429 rate limit
      res.writeHead(429, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        error: { message: 'Quota exceeded for account 1. Please try again later.' },
      }))
    }

    // Second account succeeds
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl-test-123',
      choices: [{
        message: {
          role: 'assistant',
          content: 'Hello from rotated OpenCode Zen account!',
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 15, completion_tokens: 25 },
    }))
  })

  const mockPort = await listen(mockZenUpstream)

  try {
    // Simulate turn with failover loop
    const maxAttempts = manager.getAvailableAccounts('mimo-v2.5-free').length
    let finalResult = null

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const turn = await manager.getAccountForTurn('mimo-v2.5-free')
      assert.ok(turn.account)

      const upstreamRes = await fetch(`http://127.0.0.1:${mockPort}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${turn.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'mimo-v2.5-free', messages: [{ role: 'user', content: 'hi' }] }),
      })

      if (!upstreamRes.ok && upstreamRes.status === 429) {
        manager.markRateLimited(turn.account.email, 60000, 'Quota reached', 'mimo-v2.5-free')
        continue // Rotates!
      }

      finalResult = await upstreamRes.json()
      break
    }

    assert.ok(finalResult)
    assert.equal(finalResult.choices[0].message.content, 'Hello from rotated OpenCode Zen account!')
    assert.equal(requestCount, 2)
    assert.ok(keysReceived[0].includes('sk-account-1'))
    assert.ok(keysReceived[1].includes('sk-account-2'))
  } finally {
    await close(mockZenUpstream)
  }
})
