import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDb, upsertAccount, markAccountRateLimited, saveProviderModelCatalog, getProviderModelCatalog } from '../lib/db.mjs'
import { clearAllRateLimits, clearModelCatalogs, truncateLogs, removeWatchdogLocks, performHardCacheClean } from '../lib/cleanup.mjs'

test('cleanup module resets rate limits and clears model catalogs', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-cleanup-test-'))
  const dbPath = path.join(tmpDir, 'test-metrics.sqlite')
  process.env.ZEN_DB_PATH = dbPath
  const db = getDb(dbPath)

  t.after(() => {
    try {
      db.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  // 1. Seed accounts and rate limits
  upsertAccount({
    id: 'acc_test_1',
    provider: 'codex',
    email: 'test1@example.com',
    status: 'active',
  })
  upsertAccount({
    id: 'acc_test_2',
    provider: 'zen',
    email: 'test2@example.com',
    status: 'active',
  })

  markAccountRateLimited('test1@example.com', 'codex', 3600000, 'Test limit 1')
  markAccountRateLimited('test2@example.com', 'zen', 3600000, 'Test limit 2')

  // Verify rate limited state
  const limitedBefore = db.prepare("SELECT * FROM accounts WHERE rate_limited_until IS NOT NULL").all()
  assert.equal(limitedBefore.length, 2)

  // Seed model catalog
  saveProviderModelCatalog('codex', [{ id: 'gpt-5.6-sol' }])
  assert.ok(getProviderModelCatalog('codex'))

  // Create fake log files and watchdog lock
  const logFile = path.join(tmpDir, 'proxy.log')
  fs.writeFileSync(logFile, 'Sample log data line 1\nline 2\n')
  const pidFile = path.join(tmpDir, 'watchdog.pid')
  fs.writeFileSync(pidFile, '12345')
  const lockDir = path.join(tmpDir, 'watchdog.lock.d')
  fs.mkdirSync(lockDir)

  assert.ok(fs.statSync(logFile).size > 0)
  assert.ok(fs.existsSync(pidFile))
  assert.ok(fs.existsSync(lockDir))

  // Execute hard cache clean
  const res = await performHardCacheClean(tmpDir)
  assert.equal(res.rateLimitsCleared, true)
  assert.equal(res.modelCatalogsCleared, true)
  assert.equal(res.watchdogLocksRemoved, true)

  // Verify rate limits cleared
  const limitedAfter = db.prepare("SELECT * FROM accounts WHERE rate_limited_until IS NOT NULL").all()
  assert.equal(limitedAfter.length, 0)

  // Verify model catalog cleared
  assert.equal(getProviderModelCatalog('codex'), null)

  // Verify logs truncated
  assert.equal(fs.statSync(logFile).size, 0)

  // Verify locks removed
  assert.equal(fs.existsSync(pidFile), false)
  assert.equal(fs.existsSync(lockDir), false)
})
