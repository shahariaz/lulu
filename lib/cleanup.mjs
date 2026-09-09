// Cache and state management utilities for Claude-Zen updates.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDb, clearRateLimits, clearAccountModelRateLimits } from './db.mjs'
import { codexAccountManager } from './codex-accounts.mjs'
import { antigravityAccountManager } from './antigravity-accounts.mjs'
import { zenAccountManager } from './zen-accounts.mjs'

const DEFAULT_DIR = path.join(os.homedir(), '.zen-claude')

export async function clearAllRateLimits() {
  clearRateLimits()
  clearAccountModelRateLimits()

  try {
    await codexAccountManager.init()
    codexAccountManager.resetAllLimits()
  } catch (err) {
    console.error('[Cleanup] Error resetting Codex limits:', err.message)
  }

  try {
    await antigravityAccountManager.init()
    antigravityAccountManager.resetAllLimits()
  } catch (err) {
    console.error('[Cleanup] Error resetting Antigravity limits:', err.message)
  }

  try {
    await zenAccountManager.init()
    zenAccountManager.resetAllLimits()
  } catch (err) {
    console.error('[Cleanup] Error resetting Zen limits:', err.message)
  }
}

export function clearModelCatalogs() {
  try {
    const db = getDb()
    db.prepare('DELETE FROM provider_model_catalog').run()
    return true
  } catch (err) {
    console.error('[Cleanup] Error clearing model catalogs:', err.message)
    return false
  }
}

export function truncateLogs(dir = DEFAULT_DIR) {
  const logs = [
    'proxy.log',
    'codex-gateway.log',
    'antigravity-gateway.log',
    'watchdog.log',
  ]
  const cleaned = []
  for (const file of logs) {
    const filePath = path.join(dir, file)
    try {
      if (fs.existsSync(filePath)) {
        fs.truncateSync(filePath, 0)
        cleaned.push(file)
      }
    } catch (err) {
      console.error(`[Cleanup] Error truncating ${file}:`, err.message)
    }
  }
  return cleaned
}

export function removeWatchdogLocks(dir = DEFAULT_DIR) {
  try {
    const pidFile = path.join(dir, 'watchdog.pid')
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile)
    }
    const lockDir = path.join(dir, 'watchdog.lock.d')
    if (fs.existsSync(lockDir)) {
      fs.rmSync(lockDir, { recursive: true, force: true })
    }
    // Remove any stale lock variants
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith('watchdog.lock.d.stale.')) {
          try {
            fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
          } catch {}
        }
      }
    }
    return true
  } catch (err) {
    console.error('[Cleanup] Error removing watchdog locks:', err.message)
    return false
  }
}

export async function performHardCacheClean(dir = DEFAULT_DIR) {
  await clearAllRateLimits()
  clearModelCatalogs()
  removeWatchdogLocks(dir)
  const cleanedLogs = truncateLogs(dir)
  return {
    rateLimitsCleared: true,
    modelCatalogsCleared: true,
    watchdogLocksRemoved: true,
    logsCleaned: cleanedLogs,
  }
}

// CLI runner if invoked directly
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const cmd = process.argv[2] || '--hard'
  if (cmd === '--hard') {
    performHardCacheClean().then((res) => {
      console.log('Hard cache reset complete:', JSON.stringify(res))
      process.exit(0)
    }).catch((err) => {
      console.error('Hard cache reset failed:', err)
      process.exit(1)
    })
  } else if (cmd === '--rate-limits') {
    clearAllRateLimits().then(() => {
      console.log('All rate limits reset')
      process.exit(0)
    })
  }
}
