import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  getOrchestratorDb,
  closeOrchestratorDb,
  createProject,
  createBaseline,
  approveBaseline,
  createMilestone,
  createTask,
  createTaskRun,
  getTask,
  getVerificationResults,
} from '../lib/orchestrator/db/index.mjs'
import {
  createFeatureBranch,
  provisionTaskWorktree,
  runGit,
} from '../lib/orchestrator/git-workspace.mjs'
import { transitionTask } from '../lib/orchestrator/dag-scheduler.mjs'
import {
  runVerificationChecks,
  handleVerificationOutcome,
  computeVerificationDigest,
} from '../lib/orchestrator/verifier-engine.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-verif-test-'))
  return path.join(tmpDir, 'test-verif.sqlite')
}

function createTempGitRepo(prefix = 'zen-repo-verif-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execFileSync('git', ['init', '-b', 'main', tmpDir])
  execFileSync('git', ['config', 'user.name', 'Verifier Tester'], { cwd: tmpDir })
  execFileSync('git', ['config', 'user.email', 'verifier@example.com'], { cwd: tmpDir })

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'verif-app',
    version: '1.0.0',
    scripts: { test: 'node test.js' }
  }, null, 2))
  fs.writeFileSync(path.join(tmpDir, 'test.js'), 'console.log("PASS"); process.exit(0);\n')

  execFileSync('git', ['add', '.'], { cwd: tmpDir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpDir })

  return tmpDir
}

test('runVerificationChecks passes clean test suites and records digest', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createTempGitRepo()

  const project = createProject({ name: 'App', repoPath: repo }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)
  const task = createTask({ milestoneId: milestone.id, title: 'Check Task', status: 'Automated Checks' }, db)

  createFeatureBranch(repo, 'feature-test')
  const { worktreePath } = provisionTaskWorktree(repo, 'zen/feature-test', task.id)

  const run = createTaskRun({ taskId: task.id, kind: 'VERIFICATION', role: 'VERIFIER' }, db)

  // Run passing check: node test.js
  const result = await runVerificationChecks({
    taskRunId: run.id,
    worktreePath,
    checkCommands: ['node test.js'],
  }, db)

  assert.equal(result.passed, true)
  assert.equal(result.exitCode, 0)
  assert.match(result.outputLog, /PASS/)
  assert.ok(result.verificationDigest.startsWith('sha256:'))
  assert.equal(result.dirtiedTrackedFiles.length, 0)

  // Verify saved record in database
  const verifRecords = getVerificationResults(run.id, db)
  assert.equal(verifRecords.length, 1)
  assert.equal(verifRecords[0].passed, 1)
  assert.equal(verifRecords[0].verification_digest, result.verificationDigest)

  closeOrchestratorDb()
  fs.rmSync(repo, { recursive: true, force: true })
})

test('runVerificationChecks fails if test execution dirties tracked git files', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createTempGitRepo()

  const project = createProject({ name: 'Dirty App', repoPath: repo }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)
  const task = createTask({ milestoneId: milestone.id, title: 'Dirty Test Task', status: 'Automated Checks' }, db)

  createFeatureBranch(repo, 'feature-dirty')
  const { worktreePath } = provisionTaskWorktree(repo, 'zen/feature-dirty', task.id)

  // Test script that mutates a tracked file (package.json) during test execution
  fs.writeFileSync(path.join(worktreePath, 'dirty-test.mjs'), `
    import fs from 'node:fs';
    fs.writeFileSync('package.json', 'DIRTY DATA');
    process.exit(0);
  `)
  runGit(worktreePath, ['add', 'dirty-test.mjs'])
  runGit(worktreePath, ['commit', '-m', 'add dirty test'])

  const run = createTaskRun({ taskId: task.id, kind: 'VERIFICATION', role: 'VERIFIER' }, db)

  // Execution exits 0, BUT dirties package.json -> must FAIL verification!
  const result = await runVerificationChecks({
    taskRunId: run.id,
    worktreePath,
    checkCommands: ['node dirty-test.mjs'],
  }, db)

  assert.equal(result.passed, false, 'Verification must fail if tracked files were dirtied')
  assert.equal(result.dirtiedTrackedFiles.includes('package.json'), true)
  assert.match(result.outputLog, /Verification execution dirtied tracked files: package\.json/)

  closeOrchestratorDb()
  fs.rmSync(repo, { recursive: true, force: true })
})

test('handleVerificationOutcome governs state progression and bounded repair loops', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'Repair App', repoPath: '/tmp/repair-repo' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)

  const task = createTask({
    milestoneId: milestone.id,
    title: 'Repair Task',
    status: 'Ready',
    maxRepairs: 3,
  }, db)

  // 1. Ready -> In Progress -> Automated Checks
  transitionTask(task.id, 'In Progress', {}, db)
  transitionTask(task.id, 'Automated Checks', {}, db)

  const run = createTaskRun({ taskId: task.id, kind: 'VERIFICATION', role: 'VERIFIER' }, db)

  // 2. Failed verification attempt #1 -> returns to In Progress
  let outcome = await handleVerificationOutcome({
    taskId: task.id,
    projectId: project.id,
    taskRunId: run.id,
    verificationResult: { passed: false, outputLog: 'AssertionError: 1 !== 2' },
  }, db)

  assert.equal(outcome.outcome, 'RETRY_REPAIR')
  assert.equal(outcome.task.status, 'In Progress')
  assert.equal(outcome.task.repair_attempts, 1)
  assert.equal(outcome.remainingRepairs, 2)

  // Transition back to Automated Checks for attempt #2
  transitionTask(task.id, 'Automated Checks', {}, db)

  // 3. Failed verification attempt #2 -> returns to In Progress
  outcome = await handleVerificationOutcome({
    taskId: task.id,
    projectId: project.id,
    taskRunId: run.id,
    verificationResult: { passed: false, outputLog: 'AssertionError: still failing' },
  }, db)

  assert.equal(outcome.outcome, 'RETRY_REPAIR')
  assert.equal(outcome.task.repair_attempts, 2)
  assert.equal(outcome.remainingRepairs, 1)

  // Transition back to Automated Checks for attempt #3
  transitionTask(task.id, 'Automated Checks', {}, db)

  // 4. Failed verification attempt #3 (Max reached!) -> Transitions to Blocked
  outcome = await handleVerificationOutcome({
    taskId: task.id,
    projectId: project.id,
    taskRunId: run.id,
    verificationResult: { passed: false, outputLog: 'AssertionError: third failure' },
  }, db)

  assert.equal(outcome.outcome, 'BLOCKED_REPAIR_LIMIT')
  assert.equal(outcome.task.status, 'Blocked')
  assert.equal(outcome.task.blocked_reason, 'REPAIR_LIMIT_EXCEEDED')
  assert.equal(outcome.task.repair_attempts, 3)

  // 5. Successful test run advances to Code Review
  const passTask = createTask({ milestoneId: milestone.id, title: 'Pass Task', status: 'Ready' }, db)
  transitionTask(passTask.id, 'In Progress', {}, db)
  transitionTask(passTask.id, 'Automated Checks', {}, db)

  const passRun = createTaskRun({ taskId: passTask.id, kind: 'VERIFICATION', role: 'VERIFIER' }, db)
  const passOutcome = await handleVerificationOutcome({
    taskId: passTask.id,
    projectId: project.id,
    taskRunId: passRun.id,
    verificationResult: { passed: true, verificationDigest: 'sha256:passdigest', outputLog: 'All tests passed' },
  }, db)

  assert.equal(passOutcome.outcome, 'ADVANCED_TO_REVIEW')
  assert.equal(passOutcome.task.status, 'Code Review')
  assert.equal(passOutcome.task.waiting_reason, 'RUNNING_REVIEW')

  closeOrchestratorDb()
})
