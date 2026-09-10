import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  getOrchestratorDb,
  closeOrchestratorDb,
  createProject,
  getProject,
  listProjects,
  deleteProject,
  createBaseline,
  getBaseline,
  approveBaseline,
  createMilestone,
  listMilestones,
  createTask,
  getTask,
  listTasks,
  updateTaskStatus,
  createTaskRun,
  getTaskRun,
  completeTaskRun,
  recordVerificationResult,
  getVerificationResults,
  recordReviewRecord,
  getReviewRecords,
  recordAcceptance,
  getAcceptanceRecord,
  recordAuditLog,
  listAuditLogs,
} from '../lib/orchestrator/db/index.mjs'
import {
  runMigrations,
  getAppliedMigrations,
} from '../lib/orchestrator/db/migration-runner.mjs'
import {
  performStartupRecovery,
  isPidAlive,
} from '../lib/orchestrator/db/recovery-manager.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-db-test-'))
  return path.join(tmpDir, 'test-orchestrator.sqlite')
}

test('Migration runner initializes schema idempotently', () => {
  const dbPath = getTempDbPath()
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON;')

  // First run
  const result1 = runMigrations(db)
  assert.ok(result1.applied.length >= 1)
  assert.equal(result1.applied[0].version, 1)

  // Verify schema_migrations table
  const applied = getAppliedMigrations(db)
  assert.equal(applied.length, 5)
  assert.equal(applied[0].version, 1)
  assert.equal(applied[0].name, 'initial_schema')
  assert.equal(applied[1].version, 2)
  assert.equal(applied[1].name, 'epics_and_sprints')
  assert.equal(applied[4].version, 5)
  assert.equal(applied[4].name, 'autonomy')

  // Second run (idempotent - no new migrations applied)
  const result2 = runMigrations(db)
  assert.equal(result2.applied.length, 0)
  assert.equal(result2.totalApplied, 5)

  db.close()
})

test('Migration runner rolls back on error in migration script', () => {
  const dbPath = getTempDbPath()
  const db = new DatabaseSync(dbPath)
  const tmpMigrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-mig-test-'))

  // Valid migration 001
  fs.writeFileSync(path.join(tmpMigrationsDir, '001_good.sql'), 'CREATE TABLE test_table (id INT PRIMARY KEY);')
  runMigrations(db, tmpMigrationsDir)
  let applied = getAppliedMigrations(db)
  assert.equal(applied.length, 1)
  assert.equal(applied[0].version, 1)

  // Invalid migration 002 (syntax error) added after 001
  fs.writeFileSync(path.join(tmpMigrationsDir, '002_bad.sql'), 'CREATE TABLE broken (id INT PRIMARY KEY); INVALID SQL STATEMENT;')

  // 002 fails and rolls back
  assert.throws(() => {
    runMigrations(db, tmpMigrationsDir)
  }, /Migration 002_bad\.sql .* failed/)

  applied = getAppliedMigrations(db)
  assert.equal(applied.length, 1) // Still only version 1 applied

  // Broken table should not exist due to rollback
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='broken'`).get()
  assert.equal(tableExists, undefined)

  db.close()
})

test('Database wrapper enforces foreign keys, WAL mode, and permissions', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)

  const fk = db.prepare('PRAGMA foreign_keys;').get()
  assert.equal(fk.foreign_keys, 1)

  const journal = db.prepare('PRAGMA journal_mode;').get()
  assert.equal(journal.journal_mode, 'wal')

  const stat = fs.statSync(dbPath)
  // Owner read/write (0600)
  const mode = stat.mode & 0o777
  assert.equal(mode, 0o600)

  closeOrchestratorDb()
})

test('Project, Baseline, Milestone, and Task CRUD operations', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)

  // 1. Create Project
  const project = createProject({
    name: 'Test Project',
    repoPath: '/tmp/test-repo',
    activeBranch: 'main',
  }, db)

  assert.ok(project.id.startsWith('proj_'))
  assert.equal(project.name, 'Test Project')
  assert.equal(project.active_branch, 'main')

  // 2. Create Baseline
  const baseline = createBaseline({
    projectId: project.id,
    version: 'v1.0.0',
    specMarkdown: '# Test Feature Spec\nRequirements...',
    contentDigest: 'sha256:abc12345',
    status: 'DRAFT',
  }, db)

  assert.ok(baseline.id.startsWith('base_'))
  assert.equal(baseline.status, 'DRAFT')
  assert.equal(baseline.version, 'v1.0.0')

  // Approve Baseline
  const approved = approveBaseline(baseline.id, 'owner', db)
  assert.equal(approved.status, 'APPROVED')
  assert.ok(approved.approved_at > 0)
  assert.equal(approved.approved_by, 'owner')

  // 3. Create Milestone
  const milestone = createMilestone({
    baselineId: baseline.id,
    title: 'Milestone 1: Core Functionality',
    orderIndex: 1,
  }, db)

  assert.ok(milestone.id.startsWith('ms_'))
  assert.equal(milestone.title, 'Milestone 1: Core Functionality')

  const milestones = listMilestones(baseline.id, db)
  assert.equal(milestones.length, 1)

  // 4. Create Tasks
  const task1 = createTask({
    milestoneId: milestone.id,
    title: 'Task 1: Initial Implementation',
    description: 'Implement core function',
    scopePaths: ['src/core.js', 'test/core.test.js'],
    status: 'Backlog',
  }, db)

  assert.ok(task1.id.startsWith('tsk_'))
  assert.equal(task1.status, 'Backlog')
  assert.deepEqual(task1.scope_paths, ['src/core.js', 'test/core.test.js'])
  assert.deepEqual(task1.blocked_by, [])

  const task2 = createTask({
    milestoneId: milestone.id,
    title: 'Task 2: Dependent Task',
    description: 'Depends on task 1',
    scopePaths: ['src/extension.js'],
    status: 'Backlog',
    blockedBy: [task1.id],
  }, db)

  assert.deepEqual(task2.blocked_by, [task1.id])

  // Update Task Status
  const updatedTask1 = updateTaskStatus(task1.id, {
    status: 'In Progress',
    waitingReason: null,
    blockedReason: null,
  }, db)

  assert.equal(updatedTask1.status, 'In Progress')

  closeOrchestratorDb()
})

test('Task Runs, Verification, Review, and Acceptance flow', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)

  const project = createProject({ name: 'App', repoPath: '/tmp/app' }, db)
  const baseline = createBaseline({
    projectId: project.id,
    specMarkdown: 'Spec',
    contentDigest: 'digest',
    status: 'APPROVED',
  }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)
  const task = createTask({ milestoneId: milestone.id, title: 'Feature Task', status: 'In Progress' }, db)

  // 1. Create Task Run
  const run = createTaskRun({
    taskId: task.id,
    kind: 'WORKER',
    role: 'WORKER',
    model: 'gemini-3.8-flash',
    provider: 'antigravity',
    accountEmail: 'user@example.com',
    baseCommitSha: 'commit_base_001',
    processPid: process.pid, // current process
    processCmdline: 'node worker.mjs',
  }, db)

  assert.ok(run.id.startsWith('run_'))
  assert.equal(run.status, 'RUNNING')
  assert.equal(run.kind, 'WORKER')

  // 2. Complete Task Run
  const completedRun = completeTaskRun(run.id, {
    status: 'SUCCEEDED',
    candidateCommitSha: 'commit_cand_002',
    diffDigest: 'diff_digest_002',
    inputTokens: 1200,
    outputTokens: 400,
  }, db)

  assert.equal(completedRun.status, 'SUCCEEDED')
  assert.equal(completedRun.candidate_commit_sha, 'commit_cand_002')
  assert.equal(completedRun.input_tokens, 1200)

  // 3. Record Verification Result
  const verif = recordVerificationResult({
    taskRunId: run.id,
    command: 'npm test',
    exitCode: 0,
    outputLog: 'PASS: 5 tests passing',
    verificationDigest: 'verif_digest_003',
    environmentInfo: { node: 'v24.19.0', git: '2.55.0' },
    passed: true,
  }, db)

  assert.equal(verif.passed, 1)
  assert.equal(verif.command, 'npm test')
  assert.equal(verif.exit_code, 0)

  const verifList = getVerificationResults(run.id, db)
  assert.equal(verifList.length, 1)
  assert.equal(verifList[0].environment_info.node, 'v24.19.0')

  // 4. Record Review Record
  const review = recordReviewRecord({
    taskRunId: run.id,
    candidateCommitSha: 'commit_cand_002',
    diffDigest: 'diff_digest_002',
    verificationDigest: 'verif_digest_003',
    verdict: 'APPROVE',
    summary: 'Looks good, tests pass cleanly.',
    findings: [{ category: 'style', note: 'Clean formatting' }],
  }, db)

  assert.equal(review.verdict, 'APPROVE')
  const reviews = getReviewRecords(run.id, db)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].findings.length, 1)

  // 5. Record Acceptance Record
  const acceptance = recordAcceptance({
    taskId: task.id,
    candidateCommitSha: 'commit_cand_002',
    acceptedBy: 'owner',
    integratedCommitSha: 'commit_cand_002',
    integratedAt: Date.now(),
  }, db)

  assert.equal(acceptance.candidate_commit_sha, 'commit_cand_002')
  assert.equal(acceptance.accepted_by, 'owner')

  const fetchedAcc = getAcceptanceRecord(task.id, db)
  assert.equal(fetchedAcc.id, acceptance.id)

  // 6. Record Audit Log
  const log = recordAuditLog({
    projectId: project.id,
    taskId: task.id,
    eventType: 'TASK_ACCEPTED',
    actor: 'owner',
    details: { commit: 'commit_cand_002' },
  }, db)

  assert.equal(log.event_type, 'TASK_ACCEPTED')
  const logs = listAuditLogs(project.id, db)
  assert.equal(logs.length, 1)

  closeOrchestratorDb()
})

test('Foreign key cascading deletions clean up relational hierarchy', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)

  const project = createProject({ name: 'To Delete', repoPath: '/tmp/delete-me' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'dig', status: 'DRAFT' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)
  const task = createTask({ milestoneId: milestone.id, title: 'Task to cascade', status: 'Backlog' }, db)
  const run = createTaskRun({ taskId: task.id, kind: 'WORKER', role: 'WORKER' }, db)

  // Delete project -> should cascade delete baseline, milestone, task, run
  const deleted = deleteProject(project.id, db)
  assert.equal(deleted, true)

  assert.equal(getProject(project.id, db), undefined)
  assert.equal(getBaseline(baseline.id, db), undefined)
  assert.equal(listMilestones(baseline.id, db).length, 0)
  assert.equal(getTask(task.id, db), null)
  assert.equal(getTaskRun(run.id, db), undefined)

  closeOrchestratorDb()
})

test('Non-destructive recovery preserves dirty worktrees and reconciles transient runs', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)

  // Create temporary simulated worktree directory with untracked files
  const tmpWorktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-worktree-recov-'))
  const testFile = path.join(tmpWorktreeDir, 'uncommitted_work.txt')
  fs.writeFileSync(testFile, 'Important code written before crash!')

  // Simulate stale index.lock file
  const gitDir = path.join(tmpWorktreeDir, '.git')
  fs.mkdirSync(gitDir, { recursive: true })
  const indexLock = path.join(gitDir, 'index.lock')
  fs.writeFileSync(indexLock, 'locked')

  const project = createProject({ name: 'Crash Test', repoPath: '/tmp/crash-repo' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)

  const task = createTask({
    milestoneId: milestone.id,
    title: 'Interrupted Task',
    status: 'In Progress',
    worktreePath: tmpWorktreeDir,
  }, db)

  // Transient run that was active when crash occurred
  const run = createTaskRun({
    taskId: task.id,
    kind: 'WORKER',
    role: 'WORKER',
    processPid: 99999999, // non-existent dead PID
    processCmdline: 'node worker.mjs',
  }, db)

  assert.equal(isPidAlive(99999999), false)

  // Execute startup recovery
  const recoveryResults = performStartupRecovery(db, {
    gitExecutor: (cwd, args) => '?? uncommitted_work.txt\n',
  })

  assert.equal(recoveryResults.reconciledRuns, 1)
  assert.equal(recoveryResults.preservedWorktrees, 1)
  assert.equal(recoveryResults.clearedLocks, 1) // index.lock cleared because process was confirmed dead
  assert.equal(recoveryResults.quarantinedTasks.length, 1)

  // Verify the worktree was NOT deleted
  assert.equal(fs.existsSync(tmpWorktreeDir), true)
  assert.equal(fs.existsSync(testFile), true)
  assert.equal(fs.readFileSync(testFile, 'utf8'), 'Important code written before crash!')
  assert.equal(fs.existsSync(indexLock), false) // stale lock was cleared

  // Verify task status was preserved and quarantined with RECONCILIATION_REQUIRED
  const updatedTask = getTask(task.id, db)
  assert.equal(updatedTask.status, 'Blocked')
  assert.equal(updatedTask.blocked_reason, 'RECONCILIATION_REQUIRED')

  // Verify run status was updated to INTERRUPTED
  const updatedRun = getTaskRun(run.id, db)
  assert.equal(updatedRun.status, 'INTERRUPTED')

  // Clean up test worktree
  fs.rmSync(tmpWorktreeDir, { recursive: true, force: true })
  closeOrchestratorDb()
})

test('startOrchestratorServer runs crash recovery before accepting connections', async () => {
  const { startOrchestratorServer } = await import('../lib/orchestrator/api.mjs')
  const { getTaskRun } = await import('../lib/orchestrator/db/index.mjs')

  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)

  const project = createProject({ name: 'Boot Recovery', repoPath: '/tmp/boot-repo' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)
  const task = createTask({ milestoneId: milestone.id, title: 'Wedged Task', status: 'In Progress' }, db)

  // A run left RUNNING by a process that no longer exists — exactly what a crash leaves behind.
  const run = createTaskRun({
    taskId: task.id,
    kind: 'WORKER',
    role: 'WORKER',
    processPid: 99999999,
    processCmdline: 'node worker.mjs',
  }, db)
  assert.equal(getTaskRun(run.id, db).status, 'RUNNING')

  const instance = await startOrchestratorServer({ port: 0, db })
  try {
    // Without this wiring the run stays RUNNING forever and the board shows phantom work.
    assert.equal(getTaskRun(run.id, db).status, 'INTERRUPTED')
    assert.ok(instance.recovery, 'startup should report a recovery summary')
    assert.ok(instance.recovery.reconciledRuns >= 1)

    // No worktree on disk, so the task is returned to Ready rather than quarantined.
    assert.equal(getTask(task.id, db).status, 'Ready')
  } finally {
    await instance.close()
    closeOrchestratorDb()
  }
})
