import test from 'node:test'
import assert from 'node:assert/strict'
import { budgetAnthropicRequest, DEFAULT_ANTIGRAVITY_MAX_INPUT_CHARS } from '../lib/input-budget.mjs'

test('Antigravity input budgeting keeps the newest context under the provider limit', () => {
  const request = {
    model: 'gemini-3.8-flash-tiered',
    system: 'system '.repeat(20000),
    messages: [
      { role: 'user', content: 'old '.repeat(80000) },
      { role: 'assistant', content: 'older '.repeat(80000) },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'result '.repeat(80000) }] },
      { role: 'user', content: 'new '.repeat(80000) + ' KEEP_THIS_NEWEST' },
    ],
  }
  const result = budgetAnthropicRequest(request, { maxChars: 120000, fieldMax: 50000 })
  assert.equal(result.truncated, true)
  assert.ok(result.finalChars <= 120000)
  assert.match(JSON.stringify(result.body.messages), /KEEP_THIS_NEWEST/)
  assert.doesNotMatch(JSON.stringify(result.body.messages), /old old old/)
  assert.equal(request.messages.length, 4, 'the caller body is not mutated')
})

test('default Antigravity budget limits large transcripts to about 100k tokens', () => {
  const result = budgetAnthropicRequest({
    system: 'system',
    messages: [
      { role: 'user', content: 'old '.repeat(150000) },
      { role: 'assistant', content: 'older '.repeat(150000) },
      { role: 'user', content: 'new '.repeat(150000) + ' KEEP_LATEST' },
    ],
  })
  assert.ok(result.finalChars <= DEFAULT_ANTIGRAVITY_MAX_INPUT_CHARS)
  assert.match(JSON.stringify(result.body), /KEEP_LATEST/)
})
