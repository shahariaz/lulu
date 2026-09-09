import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

test('direct Antigravity mode routes through the instrumented Zen proxy', () => {
  const launcher = fs.readFileSync(path.resolve(import.meta.dirname, '../bin/claude-zen'), 'utf8')
  const branch = launcher.match(/  antigravity\)\n([\s\S]*?)\n    ;;/)?.[1]

  assert.ok(branch, 'Antigravity launcher branch exists')
  assert.match(branch, /start_antigravity/)
  assert.match(branch, /start_proxy/)
  assert.match(branch, /start_codex/)
  assert.match(branch, /ANTHROPIC_BASE_URL="http:\/\/127\.0\.0\.1:\$\{PORT\}"/)
  assert.doesNotMatch(branch, /ANTHROPIC_BASE_URL="http:\/\/127\.0\.0\.1:\$\{AGW_PORT\}"/)
})

test('Antigravity aliases select and propagate the requested gateway implementation', () => {
  const launcher = fs.readFileSync(path.resolve(import.meta.dirname, '../bin/claude-zen'), 'utf8')
  const start = fs.readFileSync(path.resolve(import.meta.dirname, '../start.sh'), 'utf8')
  const watchdog = fs.readFileSync(path.resolve(import.meta.dirname, '../watchdog.sh'), 'utf8')

  assert.match(launcher, /ant-custom\)/)
  assert.match(launcher, /ant-open\|ant-opensource\)/)
  assert.match(launcher, /ANTIGRAVITY_VARIANT_OVERRIDE/)
  assert.match(launcher, /stop_antigravity_for_switch/)
  assert.match(launcher, /ANTIGRAVITY_GATEWAY_IMPL_OVERRIDE="\$AGW_IMPL"/)
  assert.match(start, /ANTIGRAVITY_GATEWAY_IMPL_OVERRIDE:-\$\{ANTIGRAVITY_GATEWAY_IMPL:-custom\}/)
  assert.match(watchdog, /ANTIGRAVITY_GATEWAY_IMPL_OVERRIDE:-\$\{ANTIGRAVITY_GATEWAY_IMPL:-custom\}/)
})

test('Antigravity starts through the native gateway server', () => {
  const launcher = fs.readFileSync(path.resolve(import.meta.dirname, '../bin/claude-zen'), 'utf8')
  const watchdog = fs.readFileSync(path.resolve(import.meta.dirname, '../watchdog.sh'), 'utf8')
  const gateway = fs.readFileSync(path.resolve(import.meta.dirname, '../antigravity-gateway.mjs'), 'utf8')

  assert.match(launcher, /AGW_START="\$DIR\/antigravity-gateway\.mjs"/)
  assert.match(watchdog, /antigravity-gateway\.mjs/)
  assert.match(gateway, /server\.listen\(PORT, '127\.0\.0\.1'/)
})

test('installed service scripts do not depend on an interactive shell PATH for Node', () => {
  const start = fs.readFileSync(path.resolve(import.meta.dirname, '../start.sh'), 'utf8')
  const watchdog = fs.readFileSync(path.resolve(import.meta.dirname, '../watchdog.sh'), 'utf8')
  const installer = fs.readFileSync(path.resolve(import.meta.dirname, '../install.sh'), 'utf8')

  assert.match(start, /exec "\$NODE_BIN" zen-proxy\.mjs/)
  assert.match(watchdog, /nohup "\$NODE_BIN" "\$gw_script"/)
  assert.match(watchdog, /mv "\$LOCK_DIR" "\$stale_lock"/)
  assert.match(installer, /NODE_BIN=%s/)
})

test('Codex app-server resolves its executable outside an interactive shell PATH', () => {
  const bridge = fs.readFileSync(path.resolve(import.meta.dirname, '../lib/codex-app-server.mjs'), 'utf8')

  assert.match(bridge, /process\.env\.CODEX_BIN/)
  assert.match(bridge, /\/opt\/homebrew\/bin\/codex/)
  assert.match(bridge, /command = DEFAULT_CODEX_COMMAND/)
})
