import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeWorkerEnvironment } from '../lib/orchestrator/security-boundary.mjs'

/**
 * The blanket secret filter is right for the WORKER — untrusted agent code that must never see
 * the owner's credentials. It is wrong for trusted helpers we invoke ourselves, which sometimes
 * need one specific tool credential. BRAVE_API_KEY found this: it matches the `KEY` rule, so
 * setting it did nothing, silently, and the search pool stayed at two engines while the owner
 * believed they had three.
 */
test('a named env var can be allowlisted for one spawn without opening the boundary', () => {
  const base = {
    BRAVE_API_KEY: 'brave-secret',
    SOME_OTHER_API_KEY: 'unrelated-secret',
    PATH: '/usr/bin',
  }

  const worker = sanitizeWorkerEnvironment(base)
  assert.equal(worker.BRAVE_API_KEY, undefined, 'the default must stay closed')
  assert.equal(worker.SOME_OTHER_API_KEY, undefined)

  const research = sanitizeWorkerEnvironment(base, { allowEnv: ['BRAVE_API_KEY'] })
  assert.equal(research.BRAVE_API_KEY, 'brave-secret', 'the named var must get through')
  assert.equal(research.SOME_OTHER_API_KEY, undefined,
    'allowlisting one var must not admit every other secret')
  assert.equal(research.PATH, '/usr/bin')
})

test('an explicitly sensitive key cannot be allowlisted', () => {
  // Routing around ANTHROPIC_BASE_URL would break the cost model the whole system runs on, so
  // SENSITIVE_ENV_KEYS must win over any caller that asks for one.
  const sanitized = sanitizeWorkerEnvironment(
    { ANTHROPIC_API_KEY: 'sk-real', GITHUB_TOKEN: 'ghp_real', PATH: '/usr/bin' },
    { allowEnv: ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'] },
  )

  assert.equal(sanitized.ANTHROPIC_API_KEY, undefined,
    'a named sensitive key must be unallowlistable')
  assert.equal(sanitized.GITHUB_TOKEN, undefined)
})
