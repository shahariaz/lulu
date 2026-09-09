import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-zen-accounts-test-'))
process.env.ZEN_DB_PATH = path.join(tempDir, 'metrics.sqlite')

const { getDb } = await import('../lib/db.mjs')
const { ZenAccountManager, maskApiKey, ZEN_FREE_MODELS, ZEN_GO_MODELS } = await import('../lib/zen-accounts.mjs')

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('maskApiKey hides sensitive characters and shows preview', () => {
  assert.equal(maskApiKey('sk-1234567890abcdef1234567890'), 'sk-12••••7890')
  assert.equal(maskApiKey('short'), '••••')
  assert.equal(maskApiKey(null), '••••')
})

test('ZenAccountManager adds, lists, and manages multiple OpenCode accounts with plan types', async () => {
  const manager = new ZenAccountManager()
  await manager.init()

  const freeAcc = manager.addAccountFromApiKey({
    apiKey: 'sk-free-account-key-1111111111111111',
    email: 'free-user@opencode.ai',
    name: 'OpenCode Free Account',
    planType: 'free',
  })
  assert.equal(freeAcc.email, 'free-user@opencode.ai')
  assert.equal(freeAcc.planType, 'free')

  const goAcc = manager.addAccountFromApiKey({
    apiKey: 'sk-go-account-key-2222222222222222',
    email: 'go-paid@opencode.ai',
    name: 'OpenCode Go Paid Account',
    planType: 'go',
  })
  assert.equal(goAcc.email, 'go-paid@opencode.ai')
  assert.equal(goAcc.planType, 'go')

  const hybridAcc = manager.addAccountFromApiKey({
    apiKey: 'sk-hybrid-account-key-3333333333333333',
    email: 'hybrid-user@opencode.ai',
    name: 'OpenCode Hybrid Account',
    planType: 'hybrid',
  })
  assert.equal(hybridAcc.email, 'hybrid-user@opencode.ai')

  const list = manager.listAccounts()
  assert.ok(list.length >= 3)
  assert.ok(list.some((a) => a.email === 'free-user@opencode.ai' && a.key_preview.startsWith('sk-fr')))
  assert.ok(list.some((a) => a.email === 'go-paid@opencode.ai' && a.key_preview.startsWith('sk-go')))
})

test('ZenAccountManager routes free models and Go paid models according to account capabilities', async () => {
  const manager = new ZenAccountManager()
  await manager.init()

  // Free model request should be able to run on free or hybrid accounts
  const freeAvailable = manager.getAvailableAccounts('nemotron-3.5-lightning-free')
  assert.ok(freeAvailable.some((a) => a.email === 'free-user@opencode.ai'))
  assert.ok(freeAvailable.some((a) => a.email === 'hybrid-user@opencode.ai'))

  // Go paid model request (e.g. qwen3.7-plus) should filter out strictly 'free' accounts
  const goAvailable = manager.getAvailableAccounts('qwen3.7-plus')
  assert.ok(goAvailable.some((a) => a.email === 'go-paid@opencode.ai'))
  assert.ok(goAvailable.some((a) => a.email === 'hybrid-user@opencode.ai'))
  assert.ok(!goAvailable.some((a) => a.email === 'free-user@opencode.ai'))
})

test('Ox Alpha Free is registered as an OpenCode Zen free model', () => {
  assert.ok(ZEN_FREE_MODELS.includes('x-preview-f-free'))
  assert.ok(!ZEN_GO_MODELS.includes('x-preview-f-free'))
})

test('ZenAccountManager handles rate-limit cooldowns, model-level limits, and automatic rotation', async () => {
  const manager = new ZenAccountManager()
  await manager.init()

  // Select account for turn
  const turn1 = await manager.getAccountForTurn('qwen3.7-plus')
  assert.ok(turn1.account)
  const initialEmail = turn1.account.email

  // Mark initial account rate limited
  manager.markRateLimited(initialEmail, 60000, 'Quota reached', 'qwen3.7-plus')

  // Next turn should auto-rotate to another available Go/Hybrid account
  const turn2 = await manager.getAccountForTurn('qwen3.7-plus')
  assert.ok(turn2.account)
  assert.notEqual(turn2.account.email, initialEmail)

  // Status should reflect rate limited
  const list = manager.listAccounts()
  const limitedAccount = list.find((a) => a.email === initialEmail)
  assert.ok(limitedAccount.model_rate_limits.some((l) => l.model === 'qwen3.7-plus'))

  // Reset limits
  manager.resetAllLimits()
  const resetList = manager.listAccounts()
  assert.ok(!resetList.find((a) => a.email === initialEmail).rate_limited_until)
})

test('ZenAccountManager excludes accounts already attempted in the same request', async () => {
  const manager = new ZenAccountManager()
  await manager.init()
  manager.resetAllLimits()

  const first = await manager.getAccountForTurn('qwen3.7-plus')
  assert.ok(first.account)
  const second = await manager.getAccountForTurn('qwen3.7-plus', {
    excludeEmails: new Set([first.account.email]),
  })
  assert.ok(second.account)
  assert.notEqual(second.account.email, first.account.email)
})

test('ZenAccountManager rejects invalid API key formats', async () => {
  const manager = new ZenAccountManager()
  await manager.init()

  assert.throws(() => {
    manager.addAccountFromApiKey({ apiKey: 'invalid-key-format' })
  }, /starting with "sk-"/)
})
