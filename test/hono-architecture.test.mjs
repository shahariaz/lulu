import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createOrchestratorApp } from '../lib/orchestrator/api.mjs'
import { getOrchestratorDb, closeOrchestratorDb } from '../lib/orchestrator/db/index.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('HTTP composition is a Hono app with feature routes and framework-free domain engines', async () => {
  const db = getOrchestratorDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zen-hono-')), 'api.sqlite'))
  const app = createOrchestratorApp({ db })
  assert.ok(app instanceof Hono)
  const response = await app.request('/api/orchestrator/projects')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { projects: [] })
  const missing = await app.request('/api/orchestrator/unknown')
  assert.equal(missing.status, 404)
  closeOrchestratorDb()
})
