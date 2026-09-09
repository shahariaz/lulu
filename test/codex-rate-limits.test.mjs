import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-rate-limit-test-'))
process.env.ZEN_DB_PATH = path.join(tempDir, 'accounts.sqlite')

const { codexAccountManager } = await import('../lib/codex-accounts.mjs')

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

test('marks a Codex account unavailable from a proactive 100% usage snapshot', async () => {
  await codexAccountManager.init()
  const account = codexAccountManager.accounts[0]
  assert.ok(account, 'local Codex OAuth account is available for the isolated test database')
  const resetSeconds = Math.floor(Date.now() / 1000) + 3600

  codexAccountManager.applyRateLimitSnapshot(account.id, {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetSeconds },
      secondary: null,
      rateLimitReachedType: 'rate_limit_reached',
    },
  })

  const result = codexAccountManager.listAccounts().find((item) => item.id === account.id)
  assert.equal(result.status, 'rate_limited')
  assert.equal(result.model_rate_limits[0].used_percent, 100)
  assert.ok(result.rate_limited_until >= resetSeconds * 1000)
  assert.equal(codexAccountManager.getAvailableAccounts().length, 0)
})
