import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  getOrchestratorDb,
  closeOrchestratorDb,
  createProject,
} from '../lib/orchestrator/db/index.mjs'
import {
  startSpecConversation,
  addSpecMessage,
  getSpecConversation,
  computeSpecDigest,
  createDraftBaseline,
  approveBaselineVersion,
  extractRequirementIds,
  analyzeSpecImpact,
  ARCHITECT_SYSTEM_PROMPT,
} from '../lib/orchestrator/spec-engine.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-spec-test-'))
  return path.join(tmpDir, 'test-spec.sqlite')
}

test('startSpecConversation initializes chat session with Architect prompt', () => {
  const conv = startSpecConversation({
    projectId: 'proj_123',
    featureTitle: 'User Authentication Flow',
    initialPrompt: 'We need OAuth2 login with Google',
  })

  assert.ok(conv.id.startsWith('conv_'))
  assert.equal(conv.projectId, 'proj_123')
  assert.equal(conv.featureTitle, 'User Authentication Flow')
  assert.equal(conv.messages.length, 2)
  assert.equal(conv.messages[0].role, 'system')
  assert.equal(conv.messages[0].content, ARCHITECT_SYSTEM_PROMPT)
  assert.equal(conv.messages[1].role, 'user')
  assert.equal(conv.messages[1].content, 'We need OAuth2 login with Google')

  // Add assistant reply
  addSpecMessage(conv.id, {
    role: 'assistant',
    content: 'Understood. What scopes and token refresh policies are required?',
  })

  const fetched = getSpecConversation(conv.id)
  assert.equal(fetched.messages.length, 3)
  assert.equal(fetched.messages[2].role, 'assistant')
})

test('createDraftBaseline computes SHA256 digest and stores draft in SQLite', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'App', repoPath: '/tmp/app' }, db)

  const specContent = `
# Feature: User Profile Service

## Requirements
- REQ-F-01: User can update display name.
- REQ-F-02: User can upload avatar image.
- REQ-NF-01: Avatar upload must be under 2MB.
  `

  const expectedDigest = computeSpecDigest(specContent)
  assert.ok(expectedDigest.startsWith('sha256:'))

  const draft = createDraftBaseline({
    projectId: project.id,
    specMarkdown: specContent,
    version: 'v1.0.0',
  }, db)

  assert.ok(draft.id.startsWith('base_'))
  assert.equal(draft.status, 'DRAFT')
  assert.equal(draft.version, 'v1.0.0')
  assert.equal(draft.content_digest, expectedDigest)

  closeOrchestratorDb()
})

test('approveBaselineVersion locks baseline and supersedes older versions', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'App V2', repoPath: '/tmp/app2' }, db)

  // Version 1
  const draft1 = createDraftBaseline({
    projectId: project.id,
    specMarkdown: '# V1 Spec\n- REQ-F-01: Feature 1',
    version: 'v1.0.0',
  }, db)

  const approved1 = approveBaselineVersion({ baselineId: draft1.id, approvedBy: 'owner' }, db)
  assert.equal(approved1.status, 'APPROVED')
  assert.equal(approved1.approved_by, 'owner')
  assert.ok(approved1.approved_at > 0)

  // Version 2
  const draft2 = createDraftBaseline({
    projectId: project.id,
    specMarkdown: '# V2 Spec\n- REQ-F-01: Feature 1\n- REQ-F-02: Feature 2',
    version: 'v1.1.0',
  }, db)

  const approved2 = approveBaselineVersion({ baselineId: draft2.id, approvedBy: 'owner' }, db)
  assert.equal(approved2.status, 'APPROVED')
  assert.equal(approved2.version, 'v1.1.0')

  // Check that Version 1 was superseded
  const dbV1 = db.prepare('SELECT status FROM requirements_baselines WHERE id = ?').get(draft1.id)
  assert.equal(dbV1.status, 'SUPERSEDED')

  closeOrchestratorDb()
})

test('extractRequirementIds and analyzeSpecImpact detect requirement deltas', () => {
  const specV1 = `
# PRD V1
- REQ-F-01: Core data model
- REQ-F-02: User API
- REQ-NF-01: Latency < 100ms
  `

  const specV2 = `
# PRD V2
- REQ-F-01: Core data model (modified description)
- REQ-F-03: New Search API
- REQ-NF-01: Latency < 100ms
  `

  const reqsV1 = extractRequirementIds(specV1)
  assert.deepEqual(reqsV1.sort(), ['REQ-F-01', 'REQ-F-02', 'REQ-NF-01'].sort())

  const impact = analyzeSpecImpact(specV1, specV2)
  assert.equal(impact.hasImpact, true)
  assert.deepEqual(impact.addedRequirements, ['REQ-F-03'])
  assert.deepEqual(impact.removedRequirements, ['REQ-F-02'])
  assert.deepEqual(impact.retainedRequirements.sort(), ['REQ-F-01', 'REQ-NF-01'].sort())
})
