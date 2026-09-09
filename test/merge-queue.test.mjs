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
} from '../lib/orchestrator/db/index.mjs'
import {
  createFeatureBranch,
  provisionTaskWorktree,
  runGit,
} from '../lib/orchestrator/git-workspace.mjs'
import {
  rebaseTaskBranch,
  ConflictFreeMergeQueue,
  RebaseConflictError,
} from '../lib/orchestrator/merge-queue.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-mqueue-test-'))
  return path.join(tmpDir, 'test-mqueue.sqlite')
}

function createTempGitRepo(prefix = 'zen-repo-queue-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execFileSync('git', ['init', '-b', 'main', tmpDir])
  execFileSync('git', ['config', 'user.name', 'Queue Tester'], { cwd: tmpDir })
  execFileSync('git', ['config', 'user.email', 'queue@example.com'], { cwd: tmpDir })

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'queue-app',
    version: '1.0.0',
    scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2))
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Queue App\n')

  execFileSync('git', ['add', '.'], { cwd: tmpDir })
  execFileSync('git', ['commit', '-m', 'Initial baseline commit'], { cwd: tmpDir })

  return tmpDir
}

test('ConflictFreeMergeQueue rebases diverged parallel task branch and integrates cleanly', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createTempGitRepo()

  const project = createProject({ name: 'Parallel App', repoPath: repo }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)

  const featureSlug = 'parallel-swarm'
  createFeatureBranch(repo, featureSlug)

  // 1. Task 1: Implements Service A
  const task1 = createTask({ milestoneId: milestone.id, title: 'Service A', status: 'QA', scopePaths: ['src/serviceA.js'] }, db)
  const { worktreePath: wt1 } = provisionTaskWorktree(repo, `zen/${featureSlug}`, task1.id)
  createTaskRun({ taskId: task1.id, kind: 'WORKER', role: 'WORKER' }, db)

  fs.mkdirSync(path.join(wt1, 'src'), { recursive: true })
  fs.writeFileSync(path.join(wt1, 'src', 'serviceA.js'), 'export const serviceA = true;\n')
  runGit(wt1, ['add', 'src/serviceA.js'])
  runGit(wt1, ['commit', '-m', 'feat: service A implementation'])
  const candidate1 = runGit(wt1, ['rev-parse', 'HEAD'])

  // 2. Task 2: Implements Service B in parallel (branched from the SAME base before Task 1 integrates)
  const task2 = createTask({ milestoneId: milestone.id, title: 'Service B', status: 'QA', scopePaths: ['src/serviceB.js'] }, db)
  const { worktreePath: wt2 } = provisionTaskWorktree(repo, `zen/${featureSlug}`, task2.id)
  createTaskRun({ taskId: task2.id, kind: 'WORKER', role: 'WORKER' }, db)

  fs.mkdirSync(path.join(wt2, 'src'), { recursive: true })
  fs.writeFileSync(path.join(wt2, 'src', 'serviceB.js'), 'export const serviceB = true;\n')
  runGit(wt2, ['add', 'src/serviceB.js'])
  runGit(wt2, ['commit', '-m', 'feat: service B implementation'])
  const candidate2 = runGit(wt2, ['rev-parse', 'HEAD'])

  // Initialize Merge Queue
  const queue = new ConflictFreeMergeQueue({ db })

  // 3. Integrate Task 1 first (direct fast-forward)
  const result1 = await queue.enqueue({
    taskId: task1.id,
    projectId: project.id,
    repoPath: repo,
    featureBranch: `zen/${featureSlug}`,
    worktreePath: wt1,
    candidateCommitSha: candidate1,
    verificationCommands: ['node -e "process.exit(0)"'],
    acceptedBy: 'owner',
  })

  assert.equal(result1.success, true)
  assert.equal(result1.rebased, false, 'Task 1 should merge directly without rebase')
  assert.equal(getTask(task1.id, db).status, 'Done')

  // Feature branch has now moved to candidate1!
  const featureHeadAfterT1 = runGit(repo, ['rev-parse', `zen/${featureSlug}`])
  assert.equal(featureHeadAfterT1, candidate1)

  // 4. Integrate Task 2 (MUST automatically rebase on Task 1, re-verify, and fast-forward!)
  const result2 = await queue.enqueue({
    taskId: task2.id,
    projectId: project.id,
    repoPath: repo,
    featureBranch: `zen/${featureSlug}`,
    worktreePath: wt2,
    candidateCommitSha: candidate2,
    verificationCommands: ['node -e "process.exit(0)"'],
    acceptedBy: 'owner',
  })

  assert.equal(result2.success, true)
  assert.equal(result2.rebased, true, 'Task 2 MUST be rebased because feature branch advanced')
  assert.equal(getTask(task2.id, db).status, 'Done')

  // Verify feature branch now contains BOTH Service A and Service B!
  runGit(repo, ['checkout', `zen/${featureSlug}`])
  assert.equal(fs.existsSync(path.join(repo, 'src', 'serviceA.js')), true)
  assert.equal(fs.existsSync(path.join(repo, 'src', 'serviceB.js')), true)

  closeOrchestratorDb()
  fs.rmSync(repo, { recursive: true, force: true })
})

test('rebaseTaskBranch catches merge conflicts, aborts cleanly, and preserves worktree', () => {
  const repo = createTempGitRepo()
  const featureSlug = 'conflict-feat'
  createFeatureBranch(repo, featureSlug)

  const taskId = 't_conflict'
  const { worktreePath } = provisionTaskWorktree(repo, `zen/${featureSlug}`, taskId)

  // Edit file on task branch
  fs.writeFileSync(path.join(worktreePath, 'shared.txt'), 'Task edited this line A')
  runGit(worktreePath, ['add', 'shared.txt'])
  runGit(worktreePath, ['commit', '-m', 'task commit'])

  // Edit SAME file conflictingly on feature branch
  runGit(repo, ['checkout', `zen/${featureSlug}`])
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'Feature branch edited this line B (conflict)')
  runGit(repo, ['add', 'shared.txt'])
  runGit(repo, ['commit', '-m', 'feature conflicting commit'])

  // Attempt rebase -> must throw RebaseConflictError
  assert.throws(() => {
    rebaseTaskBranch({
      repoPath: repo,
      worktreePath,
      taskBranch: `zen/task/${taskId}`,
      targetBranch: `zen/${featureSlug}`,
    })
  }, (err) => err instanceof RebaseConflictError)

  // Verify rebase was aborted cleanly and worktree is not stuck in rebasing state
  const isRebasing = fs.existsSync(path.join(worktreePath, '.git', 'rebase-merge')) ||
                     fs.existsSync(path.join(worktreePath, '.git', 'rebase-apply'))
  assert.equal(isRebasing, false, 'Rebase must be aborted on conflict')

  fs.rmSync(repo, { recursive: true, force: true })
})
