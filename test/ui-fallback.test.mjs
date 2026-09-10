import test from 'node:test'
import assert from 'node:assert/strict'
import { renderUiBuildRequiredHtml } from '../lib/orchestrator/ui/build-required-html.mjs'

test('unbuilt UI tells the owner how to build instead of fabricating dashboard state', () => {
  const html = renderUiBuildRequiredHtml()
  assert.match(html, /UI not built/)
  assert.match(html, /npm run build:ui/)
  assert.doesNotMatch(html, /Live Local Preview|Git Status: Clean|npm test passing/)
})
