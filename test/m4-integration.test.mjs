import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { startOrchestratorServer } from '../lib/orchestrator/api.mjs'
import { getOrchestratorDb, closeOrchestratorDb, getTask } from '../lib/orchestrator/db/index.mjs'
import { runGit, createFeatureBranch, provisionTaskWorktree } from '../lib/orchestrator/git-workspace.mjs'

// This suite drives the HTTP API with caller-supplied mock model output. That is refused by
// default (see lib/orchestrator/http/shared.mjs — a request must never be able to fabricate
// content indistinguishable from real model output). Opt in explicitly for these tests only;
// test/mock-injection-gate.test.mjs asserts the default stays OFF.
process.env.ZEN_ALLOW_MOCK_INJECTION = '1'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-m4-db-'))
  return path.join(tmpDir, 'm4-orchestrator.sqlite')
}

function createFixtureRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-m4-repo-'))
  execFileSync('git', ['init', '-b', 'main', repoDir])
  execFileSync('git', ['config', 'user.name', 'M4 Tester'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'm4@example.com'], { cwd: repoDir })

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'm4-swarm-app',
    version: '1.0.0',
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2))
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# M4 Swarm App\n')
  fs.writeFileSync(path.join(repoDir, 'test-runner.mjs'), 'console.log("PASS"); process.exit(0);\n')

  execFileSync('git', ['add', '.'], { cwd: repoDir })
  execFileSync('git', ['commit', '-m', 'Initial baseline commit'], { cwd: repoDir })

  return repoDir
}

test('Milestone 4 End-to-End: Parallel Swarm Execution, Scope Locking, and Sequential Conflict-Free Merge Queue', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createFixtureRepo()

  const serverInfo = await startOrchestratorServer({ port: 0, db })
  const { url } = serverInfo

  try {
    // 1. Import Project
    const projRes = await fetch(`${url}/api/orchestrator/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repo, name: 'M4 Swarm Project' }),
    })
    const { project } = await projRes.json()
    assert.ok(project.id)

    // 2. Draft and Approve Baseline with 3 Tasks
    const specMarkdown = `
# M4 Swarm Architecture
- REQ-F-01: Auth service in src/auth.js
- REQ-F-02: Billing service in src/billing.js
- REQ-F-03: Secondary Auth update in src/auth.js
    `
    const draftRes = await fetch(`${url}/api/orchestrator/projects/${project.id}/baselines/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specMarkdown, version: 'v1.0.0' }),
    })
    const { draft } = await draftRes.json()

    const approveRes = await fetch(`${url}/api/orchestrator/baselines/${draft.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvedBy: 'owner' }),
    })
    const { approved } = await approveRes.json()

    // Decompose into 3 Tasks:
    // Task 1: src/auth.js (disjoint from Task 2)
    // Task 2: src/billing.js (disjoint from Task 1)
    // Task 3: src/auth.js (COLLIDES with Task 1 scope!)
    const decompRes = await fetch(`${url}/api/orchestrator/baselines/${approved.id}/decompose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        milestoneTitle: 'M4: Swarm Operations',
        taskDefinitions: [
          { tempId: 't1', title: 'Task 1: Auth Engine', scopePaths: ['src/auth.js'], blockedBy: [] },
          { tempId: 't2', title: 'Task 2: Billing Engine', scopePaths: ['src/billing.js'], blockedBy: [] },
          { tempId: 't3', title: 'Task 3: Auth Security', scopePaths: ['src/auth.js'], blockedBy: [] },
        ],
      }),
    })
    const decomp = await decompRes.json()
    assert.equal(decomp.tasks.length, 3)

    const [task1, task2, task3] = decomp.tasks
    const milestoneId = decomp.milestone.id

    // 3. Trigger Swarm Scheduler:
    // Task 1 and Task 2 have non-overlapping scopes -> Schedulable!
    // Task 3 touches src/auth.js which overlaps Task 1 -> Held in queue (SCOPE_LOCKED)!
    const schedRes = await fetch(`${url}/api/orchestrator/milestones/${milestoneId}/schedule-swarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrency: 2 }),
    })
    assert.equal(schedRes.status, 200)
    const schedData = await schedRes.json()

    assert.equal(schedData.schedulableTasks.length, 2, 'Task 1 and Task 2 should be scheduled concurrently')
    assert.equal(schedData.schedulableTasks[0].id, task1.id)
    assert.equal(schedData.schedulableTasks[1].id, task2.id)

    assert.equal(schedData.queuedTasks.length, 1, 'Task 3 must be queued due to scope collision')
    assert.equal(schedData.queuedTasks[0].task.id, task3.id)
    assert.equal(schedData.queuedTasks[0].reason, 'SCOPE_LOCKED')

    // 4. Provision Isolated Worktrees for Task 1 and Task 2 in Parallel
    const featureSlug = 'swarm-feat'
    createFeatureBranch(repo, featureSlug)

    const { worktreePath: wt1 } = provisionTaskWorktree(repo, `zen/${featureSlug}`, task1.id)
    const { worktreePath: wt2 } = provisionTaskWorktree(repo, `zen/${featureSlug}`, task2.id)

    assert.ok(fs.existsSync(wt1))
    assert.ok(fs.existsSync(wt2))
    assert.notEqual(wt1, wt2, 'Worktrees must be completely isolated')

    // 5. Worker 1 implements Auth in Worktree 1
    const execRes1 = await fetch(`${url}/api/orchestrator/tasks/${task1.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        worktreePath: wt1,
        mockFiles: [{ path: 'src/auth.js', content: 'export const auth = "v1";\n' }],
      }),
    })
    const { workerResult: res1 } = await execRes1.json()
    assert.ok(res1.candidateCommitSha)

    // 6. Worker 2 implements Billing in Worktree 2 (in parallel from SAME base!)
    const execRes2 = await fetch(`${url}/api/orchestrator/tasks/${task2.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        worktreePath: wt2,
        mockFiles: [{ path: 'src/billing.js', content: 'export const billing = "v1";\n' }],
      }),
    })
    const { workerResult: res2 } = await execRes2.json()
    assert.ok(res2.candidateCommitSha)

    // 7. Verification & Review for both tasks
    await fetch(`${url}/api/orchestrator/tasks/${task1.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, checkCommands: ['node test-runner.mjs'] }),
    })
    await fetch(`${url}/api/orchestrator/tasks/${task1.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        candidateCommitSha: res1.candidateCommitSha,
        mockReview: { verdict: 'APPROVE', summary: 'Auth approved' },
      }),
    })

    await fetch(`${url}/api/orchestrator/tasks/${task2.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, checkCommands: ['node test-runner.mjs'] }),
    })
    await fetch(`${url}/api/orchestrator/tasks/${task2.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        candidateCommitSha: res2.candidateCommitSha,
        mockReview: { verdict: 'APPROVE', summary: 'Billing approved' },
      }),
    })

    // 8. Enqueue Task 1 into Conflict-Free Merge Queue (Merges directly via fast-forward)
    const queueRes1 = await fetch(`${url}/api/orchestrator/swarm/merge-queue/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: task1.id,
        projectId: project.id,
        repoPath: repo,
        featureBranch: `zen/${featureSlug}`,
        worktreePath: wt1,
        candidateCommitSha: res1.candidateCommitSha,
        verificationCommands: ['node test-runner.mjs'],
        acceptedBy: 'owner',
      }),
    })
    assert.equal(queueRes1.status, 200)
    const qData1 = await queueRes1.json()
    assert.equal(qData1.success, true)
    assert.equal(qData1.rebased, false, 'Task 1 should merge directly without rebase')
    assert.equal(getTask(task1.id, db).status, 'Done')

    // 9. Enqueue Task 2 into Merge Queue
    // Feature branch has now moved to Task 1! Merge Queue MUST automatically rebase Task 2 and re-verify!
    const queueRes2 = await fetch(`${url}/api/orchestrator/swarm/merge-queue/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: task2.id,
        projectId: project.id,
        repoPath: repo,
        featureBranch: `zen/${featureSlug}`,
        worktreePath: wt2,
        candidateCommitSha: res2.candidateCommitSha,
        verificationCommands: ['node test-runner.mjs'],
        acceptedBy: 'owner',
      }),
    })
    assert.equal(queueRes2.status, 200)
    const qData2 = await queueRes2.json()
    assert.equal(qData2.success, true)
    assert.equal(qData2.rebased, true, 'Task 2 MUST be automatically rebased on updated feature branch')
    assert.equal(getTask(task2.id, db).status, 'Done')

    // 10. Verify Feature Branch now contains BOTH parallel services!
    runGit(repo, ['checkout', `zen/${featureSlug}`])
    assert.equal(fs.existsSync(path.join(repo, 'src', 'auth.js')), true)
    assert.equal(fs.existsSync(path.join(repo, 'src', 'billing.js')), true)

    // 11. Check Swarm Metrics endpoint
    const metricsRes = await fetch(`${url}/api/orchestrator/swarm/metrics`)
    assert.equal(metricsRes.status, 200)
    const { metrics } = await metricsRes.json()
    assert.equal(metrics.maxConcurrency, 3)
  } finally {
    await serverInfo.close()
    closeOrchestratorDb()
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
