import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-qwen-accounts-test-'))
process.env.ZEN_DB_PATH = path.join(tempDir, 'metrics.sqlite')

const {
  QwenAccountManager,
  maskToken,
  parseJwtPayload,
  QWEN_MODELS,
  DEFAULT_QWEN_MODEL,
} = await import('../lib/qwen-accounts.mjs')

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('maskToken masks sensitive tokens safely', () => {
  assert.equal(maskToken(null), '••••')
  assert.equal(maskToken('short'), '••••')
  assert.equal(maskToken('1234567890abcdef1234567890'), '12345678••••567890')
})

test('parseJwtPayload parses JWT base64url payloads', () => {
  assert.equal(parseJwtPayload(null), null)
  assert.equal(parseJwtPayload('invalid-token'), null)

  const payload = { id: 'user_123', email: 'test@example.com', exp: 1900000000 }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const dummyJwt = `header.${b64}.signature`

  const parsed = parseJwtPayload(dummyJwt)
  assert.deepEqual(parsed, payload)
})

test('QwenAccountManager saves, rotates, and rate-limits accounts', () => {
  const manager = new QwenAccountManager({
    authFile: path.join(tempDir, 'qwen-auth.json'),
    legacyFile: null,
  })
  manager.init()

  // Save account 1
  const acc1 = manager.saveAccount({
    token: 'token_one_1234567890123456',
    email: 'user1@qwen.ai',
    name: 'User 1',
  })
  assert.equal(acc1.email, 'user1@qwen.ai')
  assert.equal(acc1.name, 'User 1')
  assert.equal(manager.accounts.length, 1)

  // Save account 2
  const acc2 = manager.saveAccount({
    token: 'token_two_1234567890123456',
    email: 'user2@qwen.ai',
    name: 'User 2',
  })
  assert.equal(manager.accounts.length, 2)

  // Retrieve account
  assert.equal(manager.getAccount('user1@qwen.ai').name, 'User 1')
  assert.equal(manager.getAccount(acc2.id).email, 'user2@qwen.ai')

  // Next available account rotation
  const selected1 = manager.getNextAvailableAccount()
  const selected2 = manager.getNextAvailableAccount()
  assert.ok(selected1)
  assert.ok(selected2)

  // Sticky model affinity
  const sticky1 = manager.getNextAvailableAccount('qwen3.7-plus')
  const sticky2 = manager.getNextAvailableAccount('qwen3.7-plus')
  assert.equal(sticky1.email, sticky2.email)

  // Rate-limiting account
  manager.markRateLimited(sticky1.email, 60000, 'Test rate limit')
  assert.ok(manager.getAccount(sticky1.email).rateLimitedUntil > Date.now())

  // Next available account should pick the other non-rate-limited account
  const afterLimit = manager.getNextAvailableAccount()
  assert.notEqual(afterLimit.email, sticky1.email)

  // Clear rate limits
  manager.clearRateLimits()
  assert.equal(manager.getAccount(sticky1.email).rateLimitedUntil, null)

  // Delete account
  const deleted = manager.deleteAccount(acc1.id)
  assert.equal(deleted, true)
  assert.equal(manager.accounts.length, 1)
  assert.equal(manager.getAccount('user1@qwen.ai'), null)
})
