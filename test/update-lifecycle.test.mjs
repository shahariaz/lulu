import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { renderDashboardHtml } from '../lib/ui.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')

test('bin/claude-zen help includes update and port cleaning commands', () => {
  const res = spawnSync(path.join(ROOT, 'bin', 'claude-zen'), ['--help'], {
    encoding: 'utf8',
  })
  assert.equal(res.status, 0)
  assert.match(res.stdout, /--update \[soft\|hard\]/)
  assert.match(res.stdout, /--update-soft/)
  assert.match(res.stdout, /--update-hard/)
  assert.match(res.stdout, /--kill-ports/)
  assert.match(res.stdout, /--restart/)
})

test('clean-ports.sh executes and cleans up watchdog locks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-clean-ports-'))
  const pidFile = path.join(tmpDir, 'watchdog.pid')
  const lockDir = path.join(tmpDir, 'watchdog.lock.d')
  fs.writeFileSync(pidFile, '99999999')
  fs.mkdirSync(lockDir)

  const res = spawnSync('bash', [path.join(ROOT, 'clean-ports.sh')], {
    env: {
      ...process.env,
      CLAUDE_ZEN_DIR: tmpDir,
      ZEN_PROXY_PORT: '59987',
      ANTIGRAVITY_PORT: '59988',
      CODEX_PORT: '59989',
    },
    encoding: 'utf8',
  })

  assert.equal(res.status, 0)
  assert.match(res.stdout, /Claude-Zen Port & Process Cleanup/)
  assert.match(res.stdout, /Cleaned watchdog lock files/)
  assert.equal(fs.existsSync(pidFile), false)
  assert.equal(fs.existsSync(lockDir), false)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('update.sh soft and hard synchronize files and handle caches', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-update-dir-'))
  const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-update-bin-'))

  // 1. Soft update
  const softRes = spawnSync('bash', [path.join(ROOT, 'update.sh'), 'soft'], {
    env: {
      ...process.env,
      CLAUDE_ZEN_DIR: tmpDir,
      CLAUDE_ZEN_BIN: tmpBin,
      ZEN_PROXY_PORT: '59987',
      ANTIGRAVITY_PORT: '59988',
      CODEX_PORT: '59989',
    },
    encoding: 'utf8',
  })
  assert.equal(softRes.status, 0, `update.sh soft failed: ${softRes.stderr}`)
  assert.match(softRes.stdout, /Claude-Zen Update \(SOFT\)/)
  assert.match(softRes.stdout, /Synced codebase and UI files/)
  assert.ok(fs.existsSync(path.join(tmpDir, 'zen-proxy.mjs')))
  assert.ok(fs.existsSync(path.join(tmpDir, 'codex-gateway.mjs')))
  assert.ok(fs.existsSync(path.join(tmpDir, 'lib', 'ui.mjs')))
  assert.ok(fs.existsSync(path.join(tmpDir, 'lib', 'cleanup.mjs')))
  assert.ok(fs.existsSync(path.join(tmpBin, 'claude-zen')))

  // 2. Hard update
  const hardRes = spawnSync('bash', [path.join(ROOT, 'update.sh'), 'hard'], {
    env: {
      ...process.env,
      CLAUDE_ZEN_DIR: tmpDir,
      CLAUDE_ZEN_BIN: tmpBin,
      ZEN_PROXY_PORT: '59987',
      ANTIGRAVITY_PORT: '59988',
      CODEX_PORT: '59989',
    },
    encoding: 'utf8',
  })
  assert.equal(hardRes.status, 0, `update.sh hard failed: ${hardRes.stderr}`)
  assert.match(hardRes.stdout, /Claude-Zen Update \(HARD\)/)
  assert.match(hardRes.stdout, /Reset all account rate-limit cooldowns/)
  assert.match(hardRes.stdout, /Cleared cached provider model catalogs/)

  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(tmpBin, { recursive: true, force: true })
})

test('UI html contains cache-busting meta headers and no-cache fetch configuration', () => {
  const html = renderDashboardHtml()
  assert.match(html, /<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">/)
  assert.match(html, /<meta http-equiv="Pragma" content="no-cache">/)
  assert.match(html, /<meta http-equiv="Expires" content="0">/)
  assert.match(html, /cache: 'no-store'/)
})
