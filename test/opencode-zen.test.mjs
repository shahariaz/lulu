import test from 'node:test'
import assert from 'node:assert/strict'

import { openCodeCooldownMs, openCodeIdentityHeaders } from '../lib/opencode-zen.mjs'

test('OpenCode identity headers are complete and stable for a retried turn', () => {
  const body = {
    model: 'mimo-v2.5-free',
    system: 'You are running in /tmp/example-project',
    messages: [{ role: 'user', content: 'hello' }],
  }
  const first = openCodeIdentityHeaders(body, { client: 'cli', version: '1.18.16' })
  const retry = openCodeIdentityHeaders(structuredClone(body), { client: 'cli', version: '1.18.16' })

  assert.deepEqual(retry, first)
  assert.match(first['x-opencode-project'], /^prj_[a-f0-9]{24}$/)
  assert.match(first['x-opencode-session'], /^ses_[a-f0-9]{24}$/)
  assert.match(first['x-opencode-request'], /^msg_[a-f0-9]{24}$/)
  assert.equal(first['x-opencode-client'], 'cli')
  assert.equal(first['User-Agent'], 'opencode/1.18.16')

  const nextTurn = openCodeIdentityHeaders({
    ...body,
    messages: [...body.messages, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'again' }],
  })
  assert.equal(nextTurn['x-opencode-session'], first['x-opencode-session'])
  assert.notEqual(nextTurn['x-opencode-request'], first['x-opencode-request'])
})

test('OpenCode cooldown honors upstream reset headers', () => {
  assert.equal(openCodeCooldownMs({ headers: new Headers({ 'retry-after-ms': '42000' }) }), 42000)
  assert.equal(openCodeCooldownMs({ headers: new Headers({ 'retry-after': '90' }) }), 90000)
})

test('OpenCode free-usage exhaustion gets a longer fallback cooldown', () => {
  const response = { headers: new Headers() }
  assert.equal(openCodeCooldownMs(response, 'FreeUsageLimitError: Rate limit exceeded', {
    freeLimitDefaultMs: 3_600_000,
    rateLimitDefaultMs: 60_000,
  }), 3_600_000)
  assert.equal(openCodeCooldownMs(response, 'ordinary rate limit', {
    freeLimitDefaultMs: 3_600_000,
    rateLimitDefaultMs: 60_000,
  }), 60_000)
})
