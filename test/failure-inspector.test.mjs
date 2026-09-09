import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  parseFailureDiagnostics,
  injectOwnerGuidance,
  applyWorktreeQuickFix,
} from '../lib/orchestrator/failure-inspector.mjs'
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
import { transitionTask } from '../lib/orchestrator/dag-scheduler.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-fail-test-'))
  return path.join(tmpDir, 'test-fail.sqlite')
}

test('parseFailureDiagnostics extracts error type, assertion diff, and failing file paths', () => {
  const sampleLog = `
✖ test/calc.test.js:14:5
✖ add() calculates sums accurately (4.52ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  4 !== 5

      at TestContext.<anonymous> (file:///Users/dev/app/test/calc.test.js:18:10)
      at async Test.run (node:internal/test_runner/test:1389:7)
  `

  const diag = parseFailureDiagnostics(sampleLog)
  assert.equal(diag.hasFailure, true)
  assert.equal(diag.errorType, 'AssertionError')
  assert.ok(diag.failingFiles.some((f) => f.includes('calc.test.js:14') || f.includes('calc.test.js:18')))
  assert.match(diag.assertionDiff, /4 !== 5/)
  assert.match(diag.stackTrace, /at TestContext/)

  // Empty log
  const emptyDiag = parseFailureDiagnostics('')
  assert.equal(emptyDiag.hasFailure, false)
})

test('injectOwnerGuidance resets repair count and transitions Blocked task to In Progress', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'App', repoPath: '/tmp/app' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)

  const task = createTask({
    milestoneId: milestone.id,
    title: 'Blocked Task',
    status: 'Ready',
  }, db)

  // Move task to Blocked with REPAIR_LIMIT_EXCEEDED
  transitionTask(task.id, 'In Progress', {}, db)
  transitionTask(task.id, 'Automated Checks', {}, db)
  transitionTask(task.id, 'Blocked', { blockedReason: 'REPAIR_LIMIT_EXCEEDED' }, db)

  // Manually set repair_attempts = 3
  db.prepare(`UPDATE tasks SET repair_attempts = 3 WHERE id = ?`).run(task.id)
  assert.equal(getTask(task.id, db).repair_attempts, 3)

  // Owner injects guidance
  const result = await injectOwnerGuidance({
    taskId: task.id,
    projectId: project.id,
    guidanceNotes: 'Check index bounds on line 42 and use Math.floor.',
    resetRepairs: true,
  }, db)

  assert.equal(result.success, true)
  assert.equal(result.task.status, 'In Progress')
  assert.equal(result.task.repair_attempts, 0, 'Repair attempts must be reset')
  assert.equal(result.task.blocked_reason, null)

  // Check audit log
  const logs = listAuditLogs(project.id, db)
  const guidanceLog = logs.find((l) => l.event_type === 'OWNER_GUIDANCE_INJECTED')
  assert.ok(guidanceLog)
  assert.match(guidanceLog.details.guidanceNotes, /Math\.floor/)

  closeOrchestratorDb()
})

test('applyWorktreeQuickFix writes file in worktree and enforces path confinement', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'App', repoPath: '/tmp/app' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)

  const tmpWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-quickfix-'))
  const task = createTask({
    milestoneId: milestone.id,
    title: 'Quickfix Task',
    status: 'In Progress',
    worktreePath: tmpWorktree,
  }, db)

  // Valid quick-fix write
  const fixResult = applyWorktreeQuickFix({
    taskId: task.id,
    worktreePath: tmpWorktree,
    filePath: 'src/fix.js',
    content: 'export const fixed = true;\n',
  }, db)

  assert.equal(fixResult.success, true)
  assert.equal(fs.existsSync(path.join(tmpWorktree, 'src', 'fix.js')), true)
  assert.equal(fs.readFileSync(path.join(tmpWorktree, 'src', 'fix.js'), 'utf8'), 'export const fixed = true;\n')

  // Attempting path traversal outside worktree must be blocked!
  assert.throws(() => {
    applyWorktreeQuickFix({
      taskId: task.id,
      worktreePath: tmpWorktree,
      filePath: '../../etc/shadow',
      content: 'malicious',
    }, db)
  }, /Path traversal blocked/)

  closeOrchestratorDb()
  fs.rmSync(tmpWorktree, { recursive: true, force: true })
})
