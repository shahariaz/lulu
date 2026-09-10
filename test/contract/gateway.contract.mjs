import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  getOrchestratorDb,
  closeOrchestratorDb,
  createProject,
} from '../../lib/orchestrator/db/index.mjs'
import { callGatewayForText, describeTruncation } from '../../lib/orchestrator/gateway-errors.mjs'
import {
  startCouncilSession,
  executeCouncilTurn,
  researchMarket,
  synthesizeProductBlueprint,
} from '../../lib/orchestrator/council-engine.mjs'
import {
  startSpecConversation,
  generateArchitectReply,
  addSpecMessage,
  createDraftBaseline,
  approveBaselineVersion,
} from '../../lib/orchestrator/spec-engine.mjs'
import { decomposePRDViaLLM } from '../../lib/orchestrator/epic-planner.mjs'

/**
 * CONTRACT TESTS — these run against the REAL gateway. No mock seam is injected.
 *
 * WHY THIS FILE EXISTS
 *
 * Three defects shipped in this project despite a green suite, and all three had the same
 * shape: the mock was injected at exactly the boundary where the bug lived, so the test
 * exercised everything except the broken thing.
 *
 *   1. The reviewer fabricated APPROVE when the gateway failed. Every test injected
 *      `reviewRunner`, so the gateway path — and the fallback after it — had zero coverage.
 *   2. The worker could never create a file (`--bare` and CLAUDE_CODE_SIMPLE each silently
 *      strip Write; `--permission-mode dontAsk` denies it). The e2e test injected `mockAction`,
 *      so the CLI spawn was never exercised.
 *   3. Blueprint synthesis failed 100% of the time: max_tokens is shared with reasoning, and a
 *      large schema left 328 tokens for the answer. Mocks returned small payloads, so the real
 *      response SIZE was never exercised.
 *
 * The rule this file enforces: every feature that talks to a model must have at least one test
 * where the mock is NOT injected. Unit tests stay fast and hermetic; these prove the contract.
 *
 * RUNNING
 *   ./start.sh          # gateways on :8787-8789
 *   npm run test:contract
 *
 * These are NOT part of `npm test` and NOT run in CI — they need infrastructure and they spend
 * real subscription quota. Prompts are deliberately tiny for that reason.
 *
 * They SKIP with a stated reason when the gateway is down. They must never pass silently
 * without having talked to anything — that is the failure mode they exist to prevent.
 */

const GATEWAY_URL = process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788'
const MODEL = process.env.ZEN_ARCHITECT_MODEL || 'gemini-3.8-flash-tiered'

async function gatewayReachable() {
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/models`, {
      headers: { 'x-api-key': 'local-antigravity', 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(4000),
    })
    return res.status < 500
  } catch {
    return false
  }
}

const reachable = await gatewayReachable()
const skip = reachable
  ? false
  : `gateway unreachable at ${GATEWAY_URL} — start it with ./start.sh`

function tempDb(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zen-contract-${label}-`))
  return getOrchestratorDb(path.join(dir, 'contract.sqlite'))
}

// ---------------------------------------------------------------------------

test('the gateway speaks the Anthropic Messages API we depend on', { skip }, async () => {
  const res = await callGatewayForText({
    gatewayUrl: GATEWAY_URL,
    model: MODEL,
    maxTokens: 2000,
    system: 'Reply with exactly the word: PONG',
    messages: [{ role: 'user', content: 'ping' }],
  })

  assert.match(res.text, /PONG/i)

  // The shape the whole system is built on. If a gateway stops reporting usage, token
  // accounting and the truncation diagnosis both go quiet rather than loud.
  assert.ok(res.raw.usage, 'the gateway must report usage')
  assert.equal(typeof res.raw.usage.output_tokens, 'number')
  assert.ok(res.truncation, 'callGatewayForText must always report a truncation verdict')
  assert.equal(res.truncation.likely, false, 'a tiny reply must not look truncated')
})

test('max_tokens is shared with reasoning — a starved budget is detected, not silently truncated', { skip }, async () => {
  // Reproduces defect #3 deliberately: ask for a large structured answer on a small budget.
  // The point is not that it fails — it is that the failure is DIAGNOSED. Before this, a
  // budget-starved response reported stop_reason 'end_turn' and surfaced as "malformed JSON",
  // which sends you looking at the prompt instead of the budget.
  const res = await callGatewayForText({
    gatewayUrl: GATEWAY_URL,
    model: MODEL,
    maxTokens: 1200,
    system: 'Respond with ONLY a JSON object: {"items":[...]} containing 40 items, each with a 100-word "text" field.',
    messages: [{ role: 'user', content: 'Generate it for a beekeeping product.' }],
  })

  const verdict = describeTruncation(res.raw, 1200)
  if (verdict.likely) {
    assert.ok(verdict.reason, 'a truncation verdict must explain itself')
    assert.ok(
      verdict.reasoningTokens >= 0 && verdict.used >= 0,
      'the verdict must report the token split so the fix is obvious',
    )
  }
  // If the model happened to answer within budget, that is fine — the contract being pinned is
  // that usage is reported and the verdict is computable, not that this specific call truncates.
  assert.equal(typeof verdict.used, 'number')
})

test('council-engine reaches the real gateway and refuses to invent advice', { skip }, async () => {
  const db = tempDb('council')
  try {
    const session = startCouncilSession({
      projectName: 'Contract Probe',
      ideaDescription: 'A tool for tracking rainfall on small farms.',
    }, db)

    // No mockReply — this is the path that used to fall back to a hardcoded paragraph.
    const turn = await executeCouncilTurn({
      sessionId: session.id,
      userMessage: '@pm in one sentence, who is the primary user?',
      gatewayUrl: GATEWAY_URL,
      db,
    })

    assert.ok(turn.reply.content.trim().length > 0)
    assert.equal(turn.targetRole, 'pm')

    // The deleted fallbacks were verbatim strings. If any reappears, it will read like this.
    assert.doesNotMatch(turn.reply.content, /\[CPO Strategy Analysis\]|\[UX Design System\]|\[Agile Delivery Roadmap\]/,
      'a hardcoded fallback paragraph has come back')
  } finally {
    closeOrchestratorDb()
  }
})

test('spec-engine reaches the real gateway and writes only what the Architect said', { skip }, async () => {
  const db = tempDb('spec')
  try {
    const project = createProject({ name: 'Contract', repoPath: '/tmp/contract' }, db)
    const convo = startSpecConversation({
      projectId: project.id,
      featureTitle: 'Rainfall log',
      initialPrompt: 'In one sentence, what should a rainfall log store?',
    }, db)

    const before = convo.messages.length
    const result = await generateArchitectReply(convo.id, { gatewayUrl: GATEWAY_URL, db })

    assert.equal(result.success, true)
    assert.ok(result.message.content.trim().length > 0)
    assert.equal(result.conversation.messages.length, before + 1)

    // The deleted fallback used to be appended to the transcript, becoming context for later
    // turns and indistinguishable from a real reply.
    assert.doesNotMatch(result.message.content, /I have received your requirements for/,
      'the canned Architect fallback has come back')
  } finally {
    closeOrchestratorDb()
  }
})

test('blueprint synthesis produces a usable blueprint at the real output size', { skip }, async () => {
  const db = tempDb('blueprint')
  try {
    const session = startCouncilSession({
      projectName: 'Rainfall Logger',
      ideaDescription: 'Simple rainfall tracking for smallholder farms.',
    }, db)

    await executeCouncilTurn({
      sessionId: session.id,
      userMessage: '@pm one sentence on the core value.',
      gatewayUrl: GATEWAY_URL,
      db,
    })
    await researchMarket({
      ideaTitle: 'Rainfall Logger',
      ideaDescription: 'Simple rainfall tracking for smallholder farms.',
      sessionId: session.id,
      depth: 'quick',
      db,
    })

    // This is defect #3's exact path. It failed 100% of the time with the old budget, and no
    // mock-based test could have caught it because mocks return small payloads.
    const bp = await synthesizeProductBlueprint({
      sessionId: session.id,
      ideaTitle: 'Rainfall Logger',
      ideaDescription: 'Simple rainfall tracking for smallholder farms.',
      gatewayUrl: GATEWAY_URL,
      db,
    })

    assert.ok(bp.prd.requirements.length > 0, 'a blueprint must contain requirements')
    for (const req of bp.prd.requirements) {
      assert.match(req.id, /^REQ-(F|NF)-\d+$/, `requirement id ${req.id} must match the parser's format`)
      assert.ok(Array.isArray(req.acceptanceCriteria) && req.acceptanceCriteria.length > 0,
        `${req.id} must carry acceptance criteria — Phase 1 QA verifies against them`)
    }
    assert.ok(bp.architecture.databaseSchema.tables.length > 0)

    // The pre-Phase-2 template returned these fixed tables for ANY idea.
    const tables = bp.architecture.databaseSchema.tables.map((t) => t.name).sort().join(',')
    assert.notEqual(tables, 'entities,events_log,workspaces', 'the hardcoded blueprint template is back')
  } finally {
    closeOrchestratorDb()
  }
})

test('decomposition reaches the real gateway and only references real requirement ids', { skip }, async () => {
  const db = tempDb('decomp')
  try {
    const project = createProject({ name: 'Decomp', repoPath: '/tmp/decomp' }, db)
    const spec = [
      '# PRD: Rainfall Logger',
      '',
      '## REQ-F-01: Record a rainfall reading',
      'Store a millimetre reading against a date and field.',
      'Acceptance: Given a reading, when saved, then it can be retrieved by date.',
      '',
      '## REQ-NF-01: Offline capture',
      'Readings must be capturable without connectivity.',
    ].join('\n')

    const draft = createDraftBaseline({ projectId: project.id, specMarkdown: spec }, db)
    const baseline = approveBaselineVersion({ baselineId: draft.id }, db)

    const planned = await decomposePRDViaLLM({
      baselineId: baseline.id,
      specMarkdown: spec,
      gatewayUrl: GATEWAY_URL,
      db,
    })

    assert.ok(planned.epics.length > 0)

    // Every referenced id must exist in the PRD. Before Phase 2 these were fabricated as
    // `REQ-F-0${idx+1}`, which made impact-analyzer's drift detection meaningless.
    const known = new Set(['REQ-F-01', 'REQ-NF-01'])
    const referenced = planned.epics.flatMap((e) => (e.features || []).flatMap((f) => [
      ...(f.linkedRequirementIds || []),
      ...(f.tasks || []).flatMap((t) => t.linkedRequirementIds || []),
    ]))
    assert.ok(referenced.length > 0, 'the decomposition must link work back to requirements')
    for (const id of referenced) {
      assert.ok(known.has(id), `decomposition referenced unknown requirement ${id}`)
    }
  } finally {
    closeOrchestratorDb()
  }
})

test('the live gateway still meets the capability contract the system depends on', { skip }, async () => {
  const { verifyProviderContract, contractFingerprint, CONTRACT_CAPABILITIES } =
    await import('../../lib/orchestrator/provider-contract.mjs')

  const snapshot = await verifyProviderContract({ gatewayUrl: GATEWAY_URL, model: MODEL })

  assert.equal(snapshot.reachable, true, snapshot.error || '')

  // Capabilities marked required are ones the system cannot work without. If one of these
  // fails, something downstream is silently producing unreliable output right now.
  for (const [capability, meta] of Object.entries(CONTRACT_CAPABILITIES)) {
    if (!meta.required || capability === 'reachable') continue
    assert.equal(snapshot[capability], true,
      `${GATEWAY_URL} no longer provides "${capability}". ${meta.breaks}`)
  }

  assert.ok(contractFingerprint(snapshot).startsWith('sha256:'))

  // Not asserted as a failure: some gateways legitimately route elsewhere. Recorded so the
  // drift shows up in the snapshot history and in the cockpit.
  if (!snapshot.honoursRequestedModel) {
    console.warn(
      `[contract] ${GATEWAY_URL} resolved "${snapshot.requestedModel}" to `
      + `"${snapshot.resolvedModel}" — independent review must compare RESOLVED models.`,
    )
  }
})
