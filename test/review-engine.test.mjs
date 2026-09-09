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
  getReviewRecords,
} from '../lib/orchestrator/db/index.mjs'
import {
  createFeatureBranch,
  provisionTaskWorktree,
  runGit,
} from '../lib/orchestrator/git-workspace.mjs'
import { transitionTask } from '../lib/orchestrator/dag-scheduler.mjs'
import {
  runSpecialistReview,
  handleReviewOutcome,
  ReviewInvalidationError,
  SPECIALIST_REVIEW_SYSTEM_PROMPT,
} from '../lib/orchestrator/review-engine.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-review-test-'))
  return path.join(tmpDir, 'test-review.sqlite')
}

function createTempGitRepo(prefix = 'zen-repo-review-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execFileSync('git', ['init', '-b', 'main', tmpDir])
  execFileSync('git', ['config', 'user.name', 'Review Tester'], { cwd: tmpDir })
  execFileSync('git', ['config', 'user.email', 'review@example.com'], { cwd: tmpDir })

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'review-app',
    version: '1.0.0',
  }, null, 2))
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Review App\n')

  execFileSync('git', ['add', '.'], { cwd: tmpDir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpDir })

  return tmpDir
}

test('runSpecialistReview advances task to QA on APPROVE verdict', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createTempGitRepo()

  const project = createProject({ name: 'App', repoPath: repo }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)
  const task = createTask({ milestoneId: milestone.id, title: 'Review Candidate Task', status: 'Code Review' }, db)

  createFeatureBranch(repo, 'feature-review')
  const { worktreePath, baseCommitSha } = provisionTaskWorktree(repo, 'zen/feature-review', task.id)

  // Candidate commit in worktree
  fs.writeFileSync(path.join(worktreePath, 'feature.js'), 'export const ready = true;\n')
  runGit(worktreePath, ['add', 'feature.js'])
  runGit(worktreePath, ['commit', '-m', 'feat: candidate commit'])
  const candidateCommitSha = runGit(worktreePath, ['rev-parse', 'HEAD'])

  const run = createTaskRun({ taskId: task.id, kind: 'REVIEW', role: 'REVIEWER' }, db)

  // Execute review with APPROVE
  const result = await runSpecialistReview({
    taskId: task.id,
    projectId: project.id,
    taskRunId: run.id,
    worktreePath,
    baseCommitSha,
    candidateCommitSha,
    verificationDigest: 'sha256:mockverifdigest',
    reviewRunner: async () => ({
      verdict: 'APPROVE',
      summary: 'Clean implementation meeting all criteria.',
      findings: [],
    }),
  }, db)

  assert.equal(result.reviewRecord.verdict, 'APPROVE')
  assert.equal(result.outcome.outcome, 'ADVANCED_TO_QA')

  // Task status should now be QA with waiting_reason AWAITING_OWNER_ACCEPTANCE
  const updatedTask = getTask(task.id, db)
  assert.equal(updatedTask.status, 'QA')
  assert.equal(updatedTask.waiting_reason, 'AWAITING_OWNER_ACCEPTANCE')

  // Review records in database
  const records = getReviewRecords(run.id, db)
  assert.equal(records.length, 1)
  assert.equal(records[0].verdict, 'APPROVE')
  assert.equal(records[0].candidate_commit_sha, candidateCommitSha)

  closeOrchestratorDb()
  fs.rmSync(repo, { recursive: true, force: true })
})

test('runSpecialistReview returns task to In Progress on CHANGES_REQUESTED verdict', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createTempGitRepo()

  const project = createProject({ name: 'App', repoPath: repo }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)
  const task = createTask({ milestoneId: milestone.id, title: 'Change Request Task', status: 'Code Review' }, db)

  createFeatureBranch(repo, 'feature-reject')
  const { worktreePath, baseCommitSha } = provisionTaskWorktree(repo, 'zen/feature-reject', task.id)

  fs.writeFileSync(path.join(worktreePath, 'buggy.js'), 'export const buggy = 1;\n')
  runGit(worktreePath, ['add', 'buggy.js'])
  runGit(worktreePath, ['commit', '-m', 'feat: candidate with bug'])
  const candidateCommitSha = runGit(worktreePath, ['rev-parse', 'HEAD'])

  const run = createTaskRun({ taskId: task.id, kind: 'REVIEW', role: 'REVIEWER' }, db)

  // Execute review with CHANGES_REQUESTED
  const result = await runSpecialistReview({
    taskId: task.id,
    projectId: project.id,
    taskRunId: run.id,
    worktreePath,
    baseCommitSha,
    candidateCommitSha,
    verificationDigest: 'sha256:mockverifdigest',
    reviewRunner: async () => ({
      verdict: 'CHANGES_REQUESTED',
      summary: 'Found potential security issue.',
      findings: [{ category: 'security', severity: 'high', file: 'buggy.js', line: 1, description: 'Unvalidated input' }],
    }),
  }, db)

  assert.equal(result.reviewRecord.verdict, 'CHANGES_REQUESTED')
  assert.equal(result.outcome.outcome, 'CHANGES_REQUESTED')

  // Task status should return to In Progress
  const updatedTask = getTask(task.id, db)
  assert.equal(updatedTask.status, 'In Progress')
  assert.equal(updatedTask.waiting_reason, null)

  closeOrchestratorDb()
  fs.rmSync(repo, { recursive: true, force: true })
})

test('runSpecialistReview invalidates and throws if worktree was altered post-verification', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createTempGitRepo()

  const project = createProject({ name: 'App', repoPath: repo }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)
  const task = createTask({ milestoneId: milestone.id, title: 'Invalidation Task', status: 'Code Review' }, db)

  createFeatureBranch(repo, 'feature-inval')
  const { worktreePath, baseCommitSha } = provisionTaskWorktree(repo, 'zen/feature-inval', task.id)

  fs.writeFileSync(path.join(worktreePath, 'f.js'), 'export const f = 1;\n')
  runGit(worktreePath, ['add', 'f.js'])
  runGit(worktreePath, ['commit', '-m', 'feat: candidate'])
  const candidateCommitSha = runGit(worktreePath, ['rev-parse', 'HEAD'])

  // Simulate human or background modification after verification
  fs.writeFileSync(path.join(worktreePath, 'f.js'), 'export const f = 2; // altered post-verification\n')

  const run = createTaskRun({ taskId: task.id, kind: 'REVIEW', role: 'REVIEWER' }, db)

  // Must throw ReviewInvalidationError
  await assert.rejects(async () => {
    await runSpecialistReview({
      taskId: task.id,
      projectId: project.id,
      taskRunId: run.id,
      worktreePath,
      baseCommitSha,
      candidateCommitSha,
      verificationDigest: 'sha256:d',
    }, db)
  }, (err) => {
    return err instanceof ReviewInvalidationError && err.code === 'E_WORKTREE_ALTERED_POST_VERIFICATION'
  })

  closeOrchestratorDb()
  fs.rmSync(repo, { recursive: true, force: true })
})

test('Specialist availability rule holds task in Code Review with SPECIALIST_UNAVAILABLE', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'App', repoPath: '/tmp/app' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)
  const task = createTask({ milestoneId: milestone.id, title: 'Specialist Quota Task', status: 'Code Review' }, db)

  const run = createTaskRun({ taskId: task.id, kind: 'REVIEW', role: 'REVIEWER' }, db)

  // Specialist unavailable
  const res = await runSpecialistReview({
    taskId: task.id,
    projectId: project.id,
    taskRunId: run.id,
    worktreePath: '/tmp/nonexistent',
    baseCommitSha: 'sha1',
    candidateCommitSha: 'sha2',
    verificationDigest: 'digest',
    isSpecialistAvailable: false,
  }, db)

  assert.equal(res.status, 'PENDING_SPECIALIST_UNAVAILABLE')

  // Task must remain in Code Review with waiting_reason = SPECIALIST_UNAVAILABLE
  const updatedTask = getTask(task.id, db)
  assert.equal(updatedTask.status, 'Code Review')
  assert.equal(updatedTask.waiting_reason, 'SPECIALIST_UNAVAILABLE')

  closeOrchestratorDb()
})
