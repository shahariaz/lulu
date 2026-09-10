import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  modelFamily,
  isMaterialModelSubstitution,
  observeEnvelope,
  contractFingerprint,
  diffContractSnapshots,
  verifyProviderContract,
  sweepProviderContracts,
} from '../lib/orchestrator/provider-contract.mjs'
import {
  getOrchestratorDb,
  closeOrchestratorDb,
  recordProviderContractSnapshot,
  getLatestProviderContractSnapshot,
} from '../lib/orchestrator/db/index.mjs'

/**
 * Provider contract drift detection.
 *
 * Contract tests prove the contract at the instant they run. These cover the hours in between:
 * a provider that changes underneath us must produce a loud, attributable diff rather than
 * quietly degraded work.
 *
 * The scenarios below are the ones measured live on this machine, not hypotheticals.
 */

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-contract-db-'))
  return getOrchestratorDb(path.join(dir, 'c.sqlite'))
}

test('routing suffixes are benign; a different model family is a real substitution', () => {
  // Measured: the zen proxy answers `gpt-5.6-sol` with `gpt-5.6-sol@low`. Benign routing.
  assert.equal(isMaterialModelSubstitution('gpt-5.6-sol', 'gpt-5.6-sol@low'), false)
  assert.equal(modelFamily('gemini-3.8-flash-tiered'), modelFamily('gemini-3.8-flash'))

  // Measured: asking that same proxy for `claude-zen-opus` also returns `gpt-5.6-sol@low`.
  // That is a different model answering, and it breaks independent review.
  assert.equal(isMaterialModelSubstitution('claude-zen-opus', 'gpt-5.6-sol@low'), true)

  // Missing information is not evidence of a breach.
  assert.equal(isMaterialModelSubstitution(null, 'anything'), false)
  assert.equal(isMaterialModelSubstitution('anything', null), false)
})

test('observeEnvelope reads the capabilities the system depends on', () => {
  const antigravity = observeEnvelope({
    requestedModel: 'gemini-3.8-flash-tiered',
    body: {
      model: 'gemini-3.8-flash-tiered',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'PONG' }],
      usage: { input_tokens: 5, output_tokens: 2, reasoning_tokens: 40 },
    },
  })
  assert.equal(antigravity.honoursRequestedModel, true)
  assert.equal(antigravity.reportsUsage, true)
  assert.equal(antigravity.reportsReasoningTokens, true)
  assert.equal(antigravity.returnsTextContent, true)

  // Measured: codex and zen report no reasoning_tokens, so truncation detection is blind there.
  const codex = observeEnvelope({
    requestedModel: 'gpt-5.6-sol',
    body: {
      model: 'gpt-5.6-sol@low',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'PONG' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    },
  })
  assert.equal(codex.reportsReasoningTokens, false)
  assert.equal(codex.honoursRequestedModel, true, 'a routing suffix must not read as substitution')
})

test('losing a capability is drift; regaining one is not', () => {
  const before = observeEnvelope({
    requestedModel: 'm',
    body: { model: 'm', content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 1 } },
  })
  const after = observeEnvelope({
    requestedModel: 'm',
    body: { model: 'm', content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 1 } },
  })

  const lost = diffContractSnapshots(before, after)
  assert.equal(lost.drifted, true)
  const reasoning = lost.changes.find((c) => c.capability === 'reportsReasoningTokens')
  assert.ok(reasoning, 'losing reasoning_tokens must be reported')
  assert.equal(reasoning.severity, 'degraded')
  assert.match(reasoning.consequence, /truncation/i, 'the diff must say what breaks')

  const regained = diffContractSnapshots(after, before)
  assert.ok(!regained.changes.some((c) => c.capability === 'reportsReasoningTokens'),
    'regaining a capability must not raise an alarm')
})

test('losing a required capability is breaking, not merely degraded', () => {
  const before = observeEnvelope({ requestedModel: 'm', body: { model: 'm', content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 1 } } })
  const after = observeEnvelope({ requestedModel: 'm', body: { model: 'm', content: [{ type: 'text' }], usage: {} } })

  const diff = diffContractSnapshots(before, after)
  const usage = diff.changes.find((c) => c.capability === 'reportsUsage')
  assert.equal(usage.severity, 'breaking')
  assert.match(usage.consequence, /fiction|unsafe/i,
    'the consequence must say that token accounting can no longer be trusted')
})

test('the fingerprint ignores churn but changes when a capability does', () => {
  const a = observeEnvelope({ requestedModel: 'm', body: { model: 'm@low', content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 2 } } })
  const b = observeEnvelope({ requestedModel: 'm', body: { model: 'm@high', content: [{ type: 'text' }], usage: { input_tokens: 9, output_tokens: 9 } } })
  assert.equal(contractFingerprint(a), contractFingerprint(b), 'token counts and routing suffixes are not capability changes')

  const c = observeEnvelope({ requestedModel: 'm', body: { model: 'm', content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 2, reasoning_tokens: 3 } } })
  assert.notEqual(contractFingerprint(a), contractFingerprint(c))
})

test('an unreachable provider is an observation, not a crash', async () => {
  const snapshot = await verifyProviderContract({ gatewayUrl: 'http://127.0.0.1:1', model: 'x' })
  assert.equal(snapshot.reachable, false)
  assert.match(snapshot.error, /unreachable/)
})

test('the sweep persists snapshots and raises drift against the previous one', async () => {
  const db = tempDb()
  try {
    const gatewayUrl = 'http://fake.test'

    // Seed a "healthy" baseline directly, as an earlier sweep would have.
    const healthy = observeEnvelope({
      requestedModel: 'm',
      body: { model: 'm', content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 1 } },
    })
    recordProviderContractSnapshot({
      ...healthy, gatewayUrl, requestedModel: 'm',
      fingerprint: contractFingerprint(healthy), observedAt: Date.now() - 60000,
    }, db)

    // Now the provider stops reporting reasoning tokens.
    const drifted = []
    await sweepProviderContracts({
      db,
      force: true, // bypass the freshness gate; this test is about drift detection
      onDrift: (d) => drifted.push(d),
      gateways: [{
        gatewayUrl,
        model: 'm',
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'PONG' }], usage: { input_tokens: 1, output_tokens: 1 } }),
        }),
      }],
    })

    assert.equal(drifted.length, 1, 'the sweep must report the regression')
    assert.ok(drifted[0].diff.changes.some((c) => c.capability === 'reportsReasoningTokens'))

    // And the new observation is now the baseline, so the next sweep compares against reality.
    const latest = getLatestProviderContractSnapshot(gatewayUrl, db)
    assert.equal(latest.reportsReasoningTokens, false)
  } finally {
    closeOrchestratorDb()
  }
})

test('a fresh snapshot is not re-verified — quota is not spent to learn nothing', async () => {
  const db = tempDb()
  try {
    const gatewayUrl = 'http://fresh.test'
    const observed = observeEnvelope({
      requestedModel: 'm',
      body: { model: 'm', content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 1 } },
    })
    recordProviderContractSnapshot({
      ...observed, gatewayUrl, requestedModel: 'm',
      fingerprint: contractFingerprint(observed), observedAt: Date.now(),
    }, db)

    let called = false
    const result = await sweepProviderContracts({
      db,
      maxAgeMs: 3600000,
      gateways: [{
        gatewayUrl,
        model: 'm',
        fetchImpl: async () => { called = true; throw new Error('should not have been called') },
      }],
    })

    assert.equal(called, false, 'a fresh gateway must not be re-verified')
    assert.equal(result.results[0].skipped, true)

    // But an expired snapshot must be.
    const expired = await sweepProviderContracts({
      db,
      maxAgeMs: 0,
      gateways: [{
        gatewayUrl,
        model: 'm',
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'PONG' }], usage: { input_tokens: 1, output_tokens: 1 } }),
        }),
      }],
    })
    assert.ok(!expired.results[0].skipped, 'a stale snapshot must be re-verified')
  } finally {
    closeOrchestratorDb()
  }
})
