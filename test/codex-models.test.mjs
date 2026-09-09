import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-models-test-'))
process.env.ZEN_DB_PATH = path.join(tempDir, 'models.sqlite')

const models = await import('../lib/codex-models.mjs')

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

test('parses model picker reasoning variants and rejects unsupported efforts', () => {
  const catalog = models.FALLBACK_CODEX_MODELS
  assert.deepEqual(models.parseCodexModelSelection('gpt-5.6-sol@ultra', catalog), {
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    metadata: catalog[0],
    explicitEffort: true,
  })
  assert.throws(
    () => models.parseCodexModelSelection('gpt-5.4-mini@ultra', catalog),
    /does not support/,
  )
})

test('publishes base models and every supported reasoning variant', () => {
  const catalog = models.FALLBACK_CODEX_MODELS.slice(0, 1)
  const entries = models.codexAnthropicModels(catalog)
  assert.ok(entries.some((entry) => entry.id === 'gpt-5.6-sol'))
  assert.ok(entries.some((entry) => entry.id === 'gpt-5.6-sol@high'))
  assert.ok(entries.some((entry) => entry.id === 'gpt-5.6-sol@ultra'))
})

test('normalizes app-server effort objects without hidden models', () => {
  const result = models.normalizeCodexModels([
    { id: 'visible', model: 'visible', displayName: 'Visible', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
    { id: 'hidden', model: 'hidden', hidden: true, supportedReasoningEfforts: [] },
  ])
  assert.deepEqual(result.map((item) => item.model), ['visible'])
  assert.deepEqual(result[0].supportedReasoningEfforts, ['low', 'medium'])
})
