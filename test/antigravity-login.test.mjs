import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-login-test-'))
process.env.ZEN_DB_PATH = path.join(tempDir, 'metrics.sqlite')
process.env.ANTIGRAVITY_ACCOUNTS_PATH = path.join(tempDir, 'accounts.json')

const { antigravityAccountManager } = await import('../lib/antigravity-accounts.mjs')
const { antigravityLoginManager } = await import('../lib/antigravity-login.mjs')

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('AntigravityAccountManager adds accounts and exports to config', async () => {
  await antigravityAccountManager.init()

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2.googleapis.com') || String(url).includes('token')) {
      return new Response(JSON.stringify({ access_token: 'mock-access-tok-123', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  }

  try {
    const res = await antigravityAccountManager.addAccountFromRefreshToken({
      refreshToken: 'mock-refresh-token-12345',
      email: 'test-user-pool@gmail.com',
      projectId: 'test-project-123',
    })

    assert.equal(res.email, 'test-user-pool@gmail.com')
    assert.equal(res.projectId, 'test-project-123')

    const list = antigravityAccountManager.listAccounts()
    const found = list.find((a) => a.email === 'test-user-pool@gmail.com')
    assert.ok(found)
    assert.equal(found.account_id, 'test-project-123')

    // Remove account
    const removed = antigravityAccountManager.removeAccount('test-user-pool@gmail.com')
    assert.ok(removed)
    assert.ok(!antigravityAccountManager.listAccounts().some((a) => a.email === 'test-user-pool@gmail.com'))
  } finally {
    globalThis.fetch = realFetch
  }
})

test('AntigravityLoginManager starts, gets, and cancels login sessions', async () => {
  const session = await antigravityLoginManager.start()
  assert.ok(session.id)
  assert.equal(session.provider, 'antigravity')
  assert.equal(session.status, 'waiting')
  assert.match(session.authUrl, /accounts\.google\.com/)
  assert.match(session.authUrl, /client_id=/)

  const fetched = antigravityLoginManager.get(session.id)
  assert.ok(fetched)
  assert.equal(fetched.id, session.id)
  assert.equal(fetched.status, 'waiting')

  const cancelled = await antigravityLoginManager.cancel(session.id)
  assert.ok(cancelled)
  assert.equal(antigravityLoginManager.get(session.id).status, 'cancelled')
})
