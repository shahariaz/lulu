import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

import {
  getOrchestratorDb,
  closeOrchestratorDb,
  getTask,
  getApprovedBaseline,
  getVerificationResults,
  getReviewRecords,
  recordAcceptance,
  getAcceptanceRecord,
  listAuditLogs,
} from '../lib/orchestrator/db/index.mjs'
import {
  inspectRepository,
  createFeatureBranch,
  provisionTaskWorktree,
  integrateTaskCommit,
  teardownTaskWorktree,
  runGit,
} from '../lib/orchestrator/git-workspace.mjs'
import {
  startSpecConversation,
  addSpecMessage,
  createDraftBaseline,
  approveBaselineVersion,
} from '../lib/orchestrator/spec-engine.mjs'
import {
  decomposeBaseline,
  claimTaskForExecution,
  transitionTask,
  getTaskDependencyStatus,
} from '../lib/orchestrator/dag-scheduler.mjs'
import { executeWorkerTask } from '../lib/orchestrator/worker-harness.mjs'
import { runVerificationChecks, handleVerificationOutcome } from '../lib/orchestrator/verifier-engine.mjs'
import { runSpecialistReview } from '../lib/orchestrator/review-engine.mjs'
import { createProject } from '../lib/orchestrator/db/index.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-e2e-db-'))
  return path.join(tmpDir, 'e2e-orchestrator.sqlite')
}

function createFixtureRepository() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-fixture-repo-'))
  execFileSync('git', ['init', '-b', 'main', repoDir])
  execFileSync('git', ['config', 'user.name', 'Claude Zen Owner'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'owner@claude-zen.local'], { cwd: repoDir })

  // Standard Node.js package setup
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'sample-project',
    version: '1.0.0',
    type: 'module',
    scripts: {
      test: 'node --test'
    }
  }, null, 2))

  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Sample Project\nInitial baseline repository.\n')
  fs.writeFileSync(path.join(repoDir, 'test-runner.mjs'), 'console.log("Ready for tests");\n')

  execFileSync('git', ['add', '.'], { cwd: repoDir })
  execFileSync('git', ['commit', '-m', 'chore: initial repository baseline'], { cwd: repoDir })

  return repoDir
}

test('Milestone 1 End-to-End Vertical Slice: Import -> Scoping -> Baseline -> DAG -> Worktree -> Worker -> Verify -> Review -> Accept -> FF-Merge', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repoPath = createFixtureRepository()

  try {
    // =========================================================================
    // Stage 1: Repository Onboarding & Inspection
    // =========================================================================
    const inspection = inspectRepository(repoPath)
    assert.equal(inspection.isClean, true, 'Working tree must be clean initially')
    assert.equal(inspection.currentBranch, 'main')
    assert.equal(inspection.runtime, 'node')
    assert.equal(inspection.testCommand, 'npm test')
    assert.ok(inspection.headCommitSha.length >= 40)

    const project = createProject({
      name: 'E2E Target Application',
      repoPath: inspection.repoPath,
      activeBranch: inspection.currentBranch,
    }, db)
    assert.ok(project.id)

    // =========================================================================
    // Stage 2: Conversational Scoping with Architect
    // =========================================================================
    const scoping = startSpecConversation({
      projectId: project.id,
      featureTitle: 'Token Bucket Rate Limiter',
      initialPrompt: 'We need an in-memory token bucket rate limiter for API requests.',
    }, db)
    assert.ok(scoping.id)

    // Architect responds and requests clarification
    addSpecMessage(scoping.id, {
      role: 'assistant',
      content: 'Understood. What capacity and refill rate are required? Should it be thread-safe?',
    }, db)

    // User clarifies
    addSpecMessage(scoping.id, {
      role: 'user',
      content: 'Capacity 10 tokens, refill 1 token per second. Include comprehensive unit tests.',
    }, db)

    // =========================================================================
    // Stage 3: Baseline Specification Drafting & Approval
    // =========================================================================
    const specMarkdown = `
# PRD: Token Bucket Rate Limiter
## Executive Summary
Provides a thread-safe in-memory token bucket rate limiter.

## Functional Requirements
- REQ-F-01: TokenBucket class with capacity and refillRatePerSec.
- REQ-F-02: tryConsume(count) method returns true if tokens available, false otherwise.
- REQ-F-03: Refills tokens accurately based on elapsed time.

## Verification Criteria
- Automated tests pass with 100% test coverage on refill and burst consumption.
    `

    const draftBaseline = createDraftBaseline({
      projectId: project.id,
      specMarkdown,
      version: 'v1.0.0',
    }, db)
    assert.equal(draftBaseline.status, 'DRAFT')
    assert.ok(draftBaseline.content_digest.startsWith('sha256:'))

    // Owner formally approves baseline
    const approvedBaseline = approveBaselineVersion({
      baselineId: draftBaseline.id,
      approvedBy: 'owner',
    }, db)
    assert.equal(approvedBaseline.status, 'APPROVED')
    assert.equal(approvedBaseline.version, 'v1.0.0')

    const activeBaseline = getApprovedBaseline(project.id, db)
    assert.equal(activeBaseline.id, approvedBaseline.id)

    // =========================================================================
    // Stage 4: Task Decomposition into DAG
    // =========================================================================
    const decomposition = decomposeBaseline({
      baselineId: approvedBaseline.id,
      milestoneTitle: 'Milestone 1: Token Bucket Engine',
      taskDefinitions: [
        {
          tempId: 't1',
          title: 'Implement TokenBucket Class',
          description: 'Create src/token-bucket.js with capacity and refill logic.',
          scopePaths: ['src/token-bucket.js'],
          blockedBy: [],
        },
        {
          tempId: 't2',
          title: 'Add TokenBucket Unit Tests',
          description: 'Create test/token-bucket.test.js testing burst and refill.',
          scopePaths: ['test/token-bucket.test.js'],
          blockedBy: ['t1'],
        },
      ],
    }, db)

    assert.equal(decomposition.tasks.length, 2)
    const task1 = decomposition.tasks.find((t) => t.title.includes('TokenBucket Class'))
    const task2 = decomposition.tasks.find((t) => t.title.includes('Unit Tests'))

    // Task 1 has zero dependencies -> Ready
    assert.equal(task1.status, 'Ready')
    // Task 2 depends on Task 1 -> Backlog
    assert.equal(task2.status, 'Backlog')
    assert.deepEqual(task2.blocked_by, [task1.id])

    // =========================================================================
    // Stage 5: Feature Branch & Task 1 Worktree Provisioning
    // =========================================================================
    const featureSlug = 'token-bucket'
    createFeatureBranch(repoPath, featureSlug)

    // Provision worktree for Task 1
    const { worktreePath: wt1, baseCommitSha: baseSha1 } = provisionTaskWorktree(
      repoPath,
      `zen/${featureSlug}`,
      task1.id
    )
    assert.ok(fs.existsSync(wt1))

    // Claim Task 1 for execution (Single Active Writer)
    claimTaskForExecution(task1.id, project.id, db)
    assert.equal(getTask(task1.id, db).status, 'In Progress')

    // Verify owner's main checkout is completely clean and untouched
    const mainStatus = runGit(repoPath, ['status', '--porcelain'])
    assert.equal(mainStatus, '', 'Main checkout must remain clean')

    // =========================================================================
    // Stage 6: Worker Implementation of Task 1
    // =========================================================================
    const workerResult1 = await executeWorkerTask({
      taskId: task1.id,
      projectId: project.id,
      worktreePath: wt1,
      scopePaths: task1.scope_paths,
      mockAction: async ({ worktreePath }) => {
        const srcDir = path.join(worktreePath, 'src')
        fs.mkdirSync(srcDir, { recursive: true })
        fs.writeFileSync(path.join(srcDir, 'token-bucket.js'), `
export class TokenBucket {
  constructor(capacity, refillRatePerSec) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRatePerSec;
    this.lastRefill = Date.now();
  }
  refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRate);
    this.lastRefill = now;
  }
  tryConsume(count = 1) {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
}
`)
      },
    }, db)

    assert.ok(workerResult1.candidateCommitSha)
    assert.ok(workerResult1.diffDigest)
    transitionTask(task1.id, 'Automated Checks', { waitingReason: 'RUNNING_VERIFICATION' }, db)

    // =========================================================================
    // Stage 7: Automated Verification of Task 1
    // =========================================================================
    // Create simple smoke check
    const verif1 = await runVerificationChecks({
      taskRunId: workerResult1.taskRunId,
      worktreePath: wt1,
      checkCommands: ['node -e "import(\'./src/token-bucket.js\')"'],
    }, db)
    assert.equal(verif1.passed, true)

    const outcome1 = await handleVerificationOutcome({
      taskId: task1.id,
      projectId: project.id,
      taskRunId: workerResult1.taskRunId,
      verificationResult: verif1,
    }, db)
    assert.equal(outcome1.outcome, 'ADVANCED_TO_REVIEW')
    assert.equal(outcome1.task.status, 'Code Review')

    // =========================================================================
    // Stage 8: Specialist Adversarial Code Review of Task 1
    // =========================================================================
    const reviewResult1 = await runSpecialistReview({
      taskId: task1.id,
      projectId: project.id,
      taskRunId: workerResult1.taskRunId,
      worktreePath: wt1,
      baseCommitSha: baseSha1,
      candidateCommitSha: workerResult1.candidateCommitSha,
      verificationDigest: verif1.verificationDigest,
      reviewRunner: async () => ({
        verdict: 'APPROVE',
        summary: 'TokenBucket class implementation verified clean and correct.',
        findings: [],
      }),
    }, db)

    assert.equal(reviewResult1.reviewRecord.verdict, 'APPROVE')
    assert.equal(reviewResult1.outcome.task.status, 'QA')
    assert.equal(reviewResult1.outcome.task.waiting_reason, 'AWAITING_OWNER_ACCEPTANCE')

    // =========================================================================
    // Stage 9: Owner Acceptance & Fast-Forward Integration of Task 1
    // =========================================================================
    // Fast-forward integrate candidate commit into feature branch
    const intResult1 = integrateTaskCommit(
      repoPath,
      `zen/${featureSlug}`,
      task1.id,
      workerResult1.candidateCommitSha
    )
    assert.equal(intResult1.success, true)
    assert.equal(intResult1.integratedCommitSha, workerResult1.candidateCommitSha)

    // Clean teardown of worktree 1
    teardownTaskWorktree(repoPath, task1.id)
    assert.equal(fs.existsSync(wt1), false)

    // Mark Task 1 Done in database
    transitionTask(task1.id, 'Done', { actor: 'owner' }, db)
    recordAcceptance({
      taskId: task1.id,
      candidateCommitSha: workerResult1.candidateCommitSha,
      acceptedBy: 'owner',
      integratedCommitSha: workerResult1.candidateCommitSha,
      integratedAt: Date.now(),
    }, db)

    // =========================================================================
    // Stage 10: Downstream Task 2 Unblocking & Execution
    // =========================================================================
    // Verify Task 2 is now automatically unblocked to Ready!
    const updatedTask2 = getTask(task2.id, db)
    assert.equal(updatedTask2.status, 'Ready', 'Task 2 must be unblocked to Ready when Task 1 reaches Done')

    // Provision worktree for Task 2 (branched from updated feature branch)
    const { worktreePath: wt2, baseCommitSha: baseSha2 } = provisionTaskWorktree(
      repoPath,
      `zen/${featureSlug}`,
      task2.id
    )
    assert.equal(baseSha2, workerResult1.candidateCommitSha, 'Task 2 base must match Task 1 integrated commit')

    claimTaskForExecution(task2.id, project.id, db)
    assert.equal(getTask(task2.id, db).status, 'In Progress')

    // Worker implements unit tests for Task 2
    const workerResult2 = await executeWorkerTask({
      taskId: task2.id,
      projectId: project.id,
      worktreePath: wt2,
      scopePaths: task2.scope_paths,
      mockAction: async ({ worktreePath }) => {
        const testDir = path.join(worktreePath, 'test')
        fs.mkdirSync(testDir, { recursive: true })
        fs.writeFileSync(path.join(testDir, 'token-bucket.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/token-bucket.js';

test('TokenBucket consumes available tokens and rejects when empty', () => {
  const bucket = new TokenBucket(3, 1);
  assert.equal(bucket.tryConsume(2), true);
  assert.equal(bucket.tryConsume(1), true);
  assert.equal(bucket.tryConsume(1), false);
});
`)
      },
    }, db)

    assert.ok(workerResult2.candidateCommitSha)
    transitionTask(task2.id, 'Automated Checks', {}, db)

    // Automated Verification runs the new unit test!
    const verif2 = await runVerificationChecks({
      taskRunId: workerResult2.taskRunId,
      worktreePath: wt2,
      checkCommands: ['node --test test/token-bucket.test.js'],
    }, db)
    assert.equal(verif2.passed, true)

    await handleVerificationOutcome({
      taskId: task2.id,
      projectId: project.id,
      taskRunId: workerResult2.taskRunId,
      verificationResult: verif2,
    }, db)

    // Specialist Review Task 2
    const reviewResult2 = await runSpecialistReview({
      taskId: task2.id,
      projectId: project.id,
      taskRunId: workerResult2.taskRunId,
      worktreePath: wt2,
      baseCommitSha: baseSha2,
      candidateCommitSha: workerResult2.candidateCommitSha,
      verificationDigest: verif2.verificationDigest,
      reviewRunner: async () => ({
        verdict: 'APPROVE',
        summary: 'Unit test suite is isolated and passes cleanly.',
        findings: [],
      }),
    }, db)
    assert.equal(reviewResult2.reviewRecord.verdict, 'APPROVE')

    // Accept and fast-forward integrate Task 2
    integrateTaskCommit(repoPath, `zen/${featureSlug}`, task2.id, workerResult2.candidateCommitSha)
    teardownTaskWorktree(repoPath, task2.id)
    transitionTask(task2.id, 'Done', { actor: 'owner' }, db)

    // =========================================================================
    // Stage 11: Feature Branch Merge into Main
    // =========================================================================
    // All tasks in milestone are Done!
    const allTasks = [getTask(task1.id, db), getTask(task2.id, db)]
    assert.ok(allTasks.every((t) => t.status === 'Done'), 'All tasks in milestone must be Done')

    // Owner merges feature branch into main
    runGit(repoPath, ['checkout', 'main'])
    runGit(repoPath, ['merge', '--ff-only', `zen/${featureSlug}`])

    const finalMainSha = runGit(repoPath, ['rev-parse', 'HEAD'])
    assert.equal(finalMainSha, workerResult2.candidateCommitSha)

    // Verify main working copy now contains the feature and the tests!
    assert.equal(fs.existsSync(path.join(repoPath, 'src', 'token-bucket.js')), true)
    assert.equal(fs.existsSync(path.join(repoPath, 'test', 'token-bucket.test.js')), true)

    // Run the newly integrated tests in the main checkout: they PASS!
    const cleanEnv = { ...process.env }
    delete cleanEnv.NODE_TEST_CONTEXT
    const finalTestRun = execFileSync('node', ['--test', 'test/token-bucket.test.js'], {
      cwd: repoPath,
      encoding: 'utf8',
      env: cleanEnv,
    })
    assert.match(finalTestRun, /pass 1/)

    // Verify immutable audit logs
    const auditEvents = listAuditLogs(project.id, db).map((l) => l.event_type)
    assert.ok(auditEvents.includes('BASELINE_DRAFTED'))
    assert.ok(auditEvents.includes('BASELINE_APPROVED'))
    assert.ok(auditEvents.includes('BASELINE_DECOMPOSED'))
    assert.ok(auditEvents.includes('TASK_TRANSITIONED'))
  } finally {
    closeOrchestratorDb()
    fs.rmSync(repoPath, { recursive: true, force: true })
  }
})
