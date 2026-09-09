import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  createStorageRepository,
  SqliteStorageRepository,
  PostgresStorageRepository,
} from '../lib/orchestrator/db/repository.mjs'
import { closeOrchestratorDb } from '../lib/orchestrator/db/index.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-repo-test-'))
  return path.join(tmpDir, 'test-storage.sqlite')
}

test('createStorageRepository factory selects SQLite by default or Postgres on URL', async () => {
  const sqliteRepo = createStorageRepository()
  assert.ok(sqliteRepo instanceof SqliteStorageRepository)
  const health = await sqliteRepo.healthCheck()
  assert.equal(health.engine, 'sqlite')
  assert.equal(health.status, 'healthy')

  const pgRepo = createStorageRepository({ databaseUrl: 'postgres://user:pass@localhost:5432/claude_zen' })
  assert.ok(pgRepo instanceof PostgresStorageRepository)
  const pgHealth = await pgRepo.healthCheck()
  assert.equal(pgHealth.engine, 'postgres')
  assert.equal(pgHealth.status, 'configured_for_future_migration')
  assert.equal(pgHealth.url, 'postgres://user:***@localhost:5432/claude_zen')

  closeOrchestratorDb()
})

test('SqliteStorageRepository satisfies the complete storage abstraction lifecycle', async () => {
  const dbPath = getTempDbPath()
  const storage = new SqliteStorageRepository(dbPath)

  // 1. Projects
  const project = await storage.createProject({ name: 'Abstract App', repoPath: '/tmp/abstract-app' })
  assert.ok(project.id)
  assert.equal(project.name, 'Abstract App')

  const fetchedProj = await storage.getProject(project.id)
  assert.equal(fetchedProj.id, project.id)

  const projects = await storage.listProjects()
  assert.ok(projects.length >= 1)

  // 2. Baselines
  const baseline = await storage.createBaseline({
    projectId: project.id,
    specMarkdown: '# Abstract PRD\n- REQ-F-01: Modular repo',
    contentDigest: 'sha256:digest01',
    status: 'DRAFT',
  })
  assert.ok(baseline.id)

  const approved = await storage.approveBaseline(baseline.id, 'owner')
  assert.equal(approved.status, 'APPROVED')

  const activeBase = await storage.getApprovedBaseline(project.id)
  assert.equal(activeBase.id, baseline.id)

  // 3. Milestones
  const milestone = await storage.createMilestone({
    baselineId: baseline.id,
    title: 'Milestone 1: Repository Layer',
    orderIndex: 1,
  })
  assert.ok(milestone.id)

  const milestones = await storage.listMilestones(baseline.id)
  assert.equal(milestones.length, 1)

  // 4. Tasks
  const task = await storage.createTask({
    milestoneId: milestone.id,
    title: 'Task: Abstract Data Access',
    scopePaths: ['lib/repo.js'],
    status: 'Ready',
  })
  assert.ok(task.id)

  const updatedTask = await storage.updateTaskStatus(task.id, {
    status: 'In Progress',
    waitingReason: null,
    blockedReason: null,
  })
  assert.equal(updatedTask.status, 'In Progress')

  await storage.incrementTaskRepairAttempts(task.id)
  const taskWithRepairs = await storage.getTask(task.id)
  assert.equal(taskWithRepairs.repair_attempts, 1)

  // 5. Task Runs
  const run = await storage.createTaskRun({
    taskId: task.id,
    kind: 'WORKER',
    role: 'WORKER',
    model: 'gemini-3.8-flash',
  })
  assert.ok(run.id)

  const completedRun = await storage.completeTaskRun(run.id, {
    status: 'SUCCEEDED',
    candidateCommitSha: 'commit_sha_123',
    diffDigest: 'sha256:diff_digest',
    inputTokens: 100,
    outputTokens: 50,
  })
  assert.equal(completedRun.status, 'SUCCEEDED')

  // 6. Verification Results
  const verif = await storage.recordVerificationResult({
    taskRunId: run.id,
    command: 'npm test',
    exitCode: 0,
    outputLog: 'PASS',
    verificationDigest: 'sha256:verif_digest',
    passed: true,
  })
  assert.ok(verif.id)

  const verifs = await storage.getVerificationResults(run.id)
  assert.equal(verifs.length, 1)

  // 7. Reviews
  const review = await storage.recordReviewRecord({
    taskRunId: run.id,
    candidateCommitSha: 'commit_sha_123',
    diffDigest: 'sha256:diff_digest',
    verificationDigest: 'sha256:verif_digest',
    verdict: 'APPROVE',
    summary: 'Approved cleanly.',
  })
  assert.ok(review.id)

  const reviews = await storage.getReviewRecords(run.id)
  assert.equal(reviews.length, 1)

  // 8. Acceptance
  const acceptance = await storage.recordAcceptance({
    taskId: task.id,
    candidateCommitSha: 'commit_sha_123',
    acceptedBy: 'owner',
    integratedCommitSha: 'commit_sha_123',
    integratedAt: Date.now(),
  })
  assert.ok(acceptance.id)

  const fetchedAcc = await storage.getAcceptanceRecord(task.id)
  assert.equal(fetchedAcc.candidate_commit_sha, 'commit_sha_123')

  // 9. Audit Logs
  const log = await storage.recordAuditLog({
    projectId: project.id,
    taskId: task.id,
    eventType: 'TASK_COMPLETED',
    actor: 'owner',
  })
  assert.ok(log.id)

  const logs = await storage.listAuditLogs(project.id)
  assert.equal(logs.length, 1)

  // Delete project cascades
  await storage.deleteProject(project.id)
  const deletedProj = await storage.getProject(project.id)
  assert.equal(deletedProj, undefined)

  closeOrchestratorDb()
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})
