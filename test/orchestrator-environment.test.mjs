import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadOrchestratorEnvironment } from '../lib/orchestrator/environment.mjs'

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-env-'))
  fs.mkdirSync(path.join(root, 'antigravity-gateway'))
  return root
}

test('loads the existing gateway brave.env apiKey alias without exposing the alias', () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'antigravity-gateway', 'brave.env'), 'apiKey=test-brave-key\n')
  const env = {}

  const result = loadOrchestratorEnvironment({ repoRoot: root, env })

  assert.equal(env.BRAVE_API_KEY, 'test-brave-key')
  assert.equal(env.apiKey, undefined)
  assert.equal(result.braveSource, 'antigravity-gateway/brave.env')
})

test('explicit environment wins over every env file', () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, '.env'), 'BRAVE_API_KEY=dot-env-key\nZEN_REVIEWER_MODEL=reviewer\n')
  fs.writeFileSync(path.join(root, 'brave.env'), 'BRAVE_API_KEY=file-key\n')
  const env = { BRAVE_API_KEY: 'shell-key' }

  const result = loadOrchestratorEnvironment({ repoRoot: root, env })

  assert.equal(env.BRAVE_API_KEY, 'shell-key')
  assert.equal(env.ZEN_REVIEWER_MODEL, 'reviewer')
  assert.equal(result.braveSource, 'shell or .env')
})

test('root brave.env takes precedence over the gateway compatibility file', () => {
  const root = fixture()
  fs.writeFileSync(path.join(root, 'brave.env'), 'BRAVE_API_KEY=root-key\n')
  fs.writeFileSync(path.join(root, 'antigravity-gateway', 'brave.env'), 'apiKey=nested-key\n')
  const env = {}

  const result = loadOrchestratorEnvironment({ repoRoot: root, env })

  assert.equal(env.BRAVE_API_KEY, 'root-key')
  assert.equal(result.braveSource, 'brave.env')
})
