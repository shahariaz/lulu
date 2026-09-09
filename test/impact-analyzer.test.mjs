import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  getOrchestratorDb,
  closeOrchestratorDb,
  createProject,
  createBaseline,
  approveBaseline,
  createMilestone,
  createTask,
  getTask,
  listAuditLogs,
} from '../lib/orchestrator/db/index.mjs'
import {
  analyzeBaselineScopeImpact,
  applyScopeImpact,
} from '../lib/orchestrator/impact-analyzer.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-impact-test-'))
  return path.join(tmpDir, 'test-impact.sqlite')
}

test('analyzeBaselineScopeImpact maps requirement diffs to tasks and detects affected work', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'Impact App', repoPath: '/tmp/impact-app' }, db)

  // Baseline v1.0.0
  const v1Markdown = `
# Feature: Auth Service v1
- REQ-F-01: Session Cookies
  Manage HTTP sessions with signed cookies.
- REQ-F-02: Password Hashing
  Bcrypt password storage.
  `
  const baseV1 = createBaseline({
    projectId: project.id,
    specMarkdown: v1Markdown,
    contentDigest: 'sha256:v1',
    status: 'APPROVED',
  }, db)

  const milestone = createMilestone({ baselineId: baseV1.id, title: 'M1' }, db)

  // Task 1 linked to REQ-F-01
  const task1 = createTask({
    milestoneId: milestone.id,
    title: 'Task 1: Cookie Manager',
    status: 'Done',
    linkedRequirementIds: ['REQ-F-01'],
  }, db)

  // Task 2 linked to REQ-F-02
  const task2 = createTask({
    milestoneId: milestone.id,
    title: 'Task 2: Bcrypt Hasher',
    status: 'Done',
    linkedRequirementIds: ['REQ-F-02'],
  }, db)

  // Baseline v1.1.0: REQ-F-01 is modified, REQ-F-03 is added
  const v2Markdown = `
# Feature: Auth Service v2
- REQ-F-01: Session Cookies
  Manage HTTP sessions with encrypted JWT tokens instead of cookies.
- REQ-F-02: Password Hashing
  Bcrypt password storage.
- REQ-F-03: Two-Factor Auth
  TOTP 2FA verification.
  `
  const baseV2 = createBaseline({
    projectId: project.id,
    specMarkdown: v2Markdown,
    contentDigest: 'sha256:v2',
    version: 'v1.1.0',
    status: 'APPROVED',
  }, db)

  // Analyze Scope Impact
  const report = analyzeBaselineScopeImpact({
    projectId: project.id,
    previousBaselineId: baseV1.id,
    newBaselineId: baseV2.id,
  }, db)

  assert.equal(report.hasImpact, true)
  assert.equal(report.previousBaselineVersion, 'v1.0.0')
  assert.equal(report.newBaselineVersion, 'v1.1.0')

  // Affected Tasks: Task 1 must be flagged
  assert.equal(report.affectedTasks.length, 1)
  assert.equal(report.affectedTasks[0].taskId, task1.id)
  assert.match(report.affectedTasks[0].reason, /REQ-F-01 was modified/)

  // Unaffected Tasks: Task 2 must be unaffected
  assert.equal(report.unaffectedTasks.length, 1)
  assert.equal(report.unaffectedTasks[0].taskId, task2.id)

  // Uncovered New Requirements: REQ-F-03 must be identified
  assert.equal(report.uncoveredNewRequirements.length, 1)
  assert.equal(report.uncoveredNewRequirements[0].id, 'REQ-F-03')

  // Apply Scope Impact
  const applyResult = applyScopeImpact({
    projectId: project.id,
    impactReport: report,
    actor: 'owner',
  }, db)

  assert.equal(applyResult.success, true)
  assert.equal(applyResult.affectedCount, 1)

  // Verify Task 1 is flagged with REWORK_REQUIRED
  const updatedTask1 = getTask(task1.id, db)
  assert.equal(updatedTask1.waiting_reason, 'REWORK_REQUIRED')

  // Task 2 waiting_reason remains null
  const updatedTask2 = getTask(task2.id, db)
  assert.equal(updatedTask2.waiting_reason, null)

  // Verify Audit Log
  const logs = listAuditLogs(project.id, db)
  const impactLog = logs.find((l) => l.event_type === 'SCOPE_IMPACT_APPLIED')
  assert.ok(impactLog)
  assert.equal(impactLog.details.affectedCount, 1)

  closeOrchestratorDb()
})
