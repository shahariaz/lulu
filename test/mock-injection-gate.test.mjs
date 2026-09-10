import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startOrchestratorServer } from '../lib/orchestrator/api.mjs'
import { getOrchestratorDb, closeOrchestratorDb } from '../lib/orchestrator/db/index.mjs'
import {
  assertNoMockInjection,
  mockInjectionAllowed,
  MOCK_INJECTION_FIELDS,
} from '../lib/orchestrator/http/shared.mjs'

/**
 * The mock-injection gate.
 *
 * Several engines accept a `mock*` argument so tests can supply model output without a live
 * gateway. Those are legitimate test seams. Reaching them over HTTP is not: it lets a request
 * supply the answer, which defeats INVARIANT 1 (never fabricate model output).
 *
 * This was a live hole. With every gateway down, this chain produced a complete blueprint:
 *   POST /council/teardown  { mockResearch }   → planted as "sourced" research
 *   POST /council/turn      { mockReply }      → planted in the transcript
 *   POST /council/blueprint { mockBlueprint }  → a full fabricated blueprint
 * and POST /council/initialize-project then runs createDraftBaseline →
 * approveBaselineVersion({ approvedBy: 'owner' }), turning it into an immutable, SHA-locked
 * v1.0.0 baseline attributed to the owner — with no model consulted and nothing in storage
 * marking it fabricated.
 *
 * NOTE: this file must NOT set ZEN_ALLOW_MOCK_INJECTION. Its whole job is to prove the default.
 */

function withEnv(value, fn) {
  const prev = process.env.ZEN_ALLOW_MOCK_INJECTION
  try {
    if (value === undefined) delete process.env.ZEN_ALLOW_MOCK_INJECTION
    else process.env.ZEN_ALLOW_MOCK_INJECTION = value
    return fn()
  } finally {
    if (prev === undefined) delete process.env.ZEN_ALLOW_MOCK_INJECTION
    else process.env.ZEN_ALLOW_MOCK_INJECTION = prev
  }
}

test('mock injection is OFF unless explicitly enabled', () => {
  withEnv(undefined, () => assert.equal(mockInjectionAllowed(), false, 'unset must mean off'))
  withEnv('', () => assert.equal(mockInjectionAllowed(), false))
  withEnv('0', () => assert.equal(mockInjectionAllowed(), false))
  withEnv('no', () => assert.equal(mockInjectionAllowed(), false, 'only 1/true may enable it'))
  withEnv('1', () => assert.equal(mockInjectionAllowed(), true))
  withEnv('true', () => assert.equal(mockInjectionAllowed(), true))
})

test('every known mock field is rejected by default, and named in the error', () => {
  withEnv(undefined, () => {
    for (const field of MOCK_INJECTION_FIELDS) {
      assert.throws(
        () => assertNoMockInjection({ [field]: { anything: true } }),
        (err) => {
          assert.equal(err.code, 'E_MOCK_INJECTION_FORBIDDEN')
          assert.match(err.message, new RegExp(field), 'the error must name the offending field')
          return true
        },
        `${field} must be refused`,
      )
    }
  })
})

test('ordinary request bodies pass through untouched', () => {
  withEnv(undefined, () => {
    const body = { projectId: 'p1', ideaTitle: 'Real idea', nested: { ok: 1 } }
    assert.deepEqual(assertNoMockInjection(body), body)
    // A null/undefined mock field is not an injection attempt.
    assert.doesNotThrow(() => assertNoMockInjection({ mockBlueprint: null, ideaTitle: 'x' }))
  })
})

test('the HTTP surface refuses caller-supplied model output with 403', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-mockgate-'))
  const db = getOrchestratorDb(path.join(dir, 'gate.sqlite'))
  const instance = await startOrchestratorServer({ port: 0, db, skipRecovery: true })

  try {
    await withEnv(undefined, async () => {
      const started = await (await fetch(`${instance.url}/api/orchestrator/council/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectName: 'Gate', ideaDescription: 'idea' }),
      })).json()
      const sessionId = started.session.id

      // Step 1 of the historical chain must fail at the door.
      const res = await fetch(`${instance.url}/api/orchestrator/council/teardown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          productIdea: 'Gate',
          mockResearch: { competitors: [{ name: 'FAKECO' }], sources: [{ url: 'https://fake' }] },
        }),
      })

      assert.equal(res.status, 403)
      const body = await res.json()
      assert.equal(body.code, 'E_MOCK_INJECTION_FORBIDDEN')
      assert.match(body.error, /mockResearch/)

      // And nothing was persisted as a side effect of the refused request.
      const session = await (await fetch(`${instance.url}/api/orchestrator/council/${sessionId}`)).json()
      assert.ok(!session.session.marketResearch, 'refused research must not be stored')
    })
  } finally {
    await instance.close()
    closeOrchestratorDb()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
