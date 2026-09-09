import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  inspectRepository,
  createFeatureBranch,
  provisionTaskWorktree,
  integrateTaskCommit,
  teardownTaskWorktree,
  runGit,
} from '../lib/orchestrator/git-workspace.mjs'

function createTempGitRepo(prefix = 'zen-git-test-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execFileSync('git', ['init', '-b', 'main', tmpDir])
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })

  // Initial package.json and README
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'test-app',
    version: '1.0.0',
    scripts: { test: 'node --test', lint: 'eslint .' }
  }, null, 2))
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test App\n')

  execFileSync('git', ['add', '.'], { cwd: tmpDir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpDir })

  return tmpDir
}

test('inspectRepository accurately detects git status, runtime, and cleanliness', () => {
  const repo = createTempGitRepo()

  // 1. Clean repo
  const cleanInfo = inspectRepository(repo)
  assert.equal(cleanInfo.isClean, true)
  assert.equal(cleanInfo.uncommittedFiles.length, 0)
  assert.equal(cleanInfo.currentBranch, 'main')
  assert.ok(cleanInfo.headCommitSha.length >= 40)
  assert.equal(cleanInfo.runtime, 'node')
  assert.equal(cleanInfo.packageManager, 'npm')
  assert.equal(cleanInfo.testCommand, 'npm test')
  assert.equal(cleanInfo.lintCommand, 'npm run lint')

  // 2. Dirty repo
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'uncommitted')
  const dirtyInfo = inspectRepository(repo)
  assert.equal(dirtyInfo.isClean, false)
  assert.equal(dirtyInfo.uncommittedFiles.length, 1)

  // 3. Non-git directory
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'))
  assert.throws(() => {
    inspectRepository(nonGitDir)
  }, /not a valid git repository/)

  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(nonGitDir, { recursive: true, force: true })
})

test('createFeatureBranch provisions feature branch without altering working tree', () => {
  const repo = createTempGitRepo()
  const headSha = runGit(repo, ['rev-parse', 'HEAD'])

  const result = createFeatureBranch(repo, 'auth-flow', headSha)
  assert.equal(result.featureBranch, 'zen/auth-flow')
  assert.equal(result.baseCommitSha, headSha)

  // Verify branch exists in git refs
  const branchHead = runGit(repo, ['rev-parse', 'zen/auth-flow'])
  assert.equal(branchHead, headSha)

  // Main working tree is still on main
  const current = runGit(repo, ['branch', '--show-current'])
  assert.equal(current, 'main')

  // Calling createFeatureBranch again is idempotent
  const secondResult = createFeatureBranch(repo, 'auth-flow')
  assert.equal(secondResult.featureBranch, 'zen/auth-flow')

  fs.rmSync(repo, { recursive: true, force: true })
})

test('provisionTaskWorktree isolates agent edits from the primary working copy', () => {
  const repo = createTempGitRepo()
  createFeatureBranch(repo, 'my-feature')

  const taskId = 'task_001'
  const worktreeResult = provisionTaskWorktree(repo, 'zen/my-feature', taskId)

  assert.ok(fs.existsSync(worktreeResult.worktreePath))
  assert.equal(worktreeResult.taskBranch, 'zen/task/task_001')

  // Modify file inside worktree
  const worktreeFile = path.join(worktreeResult.worktreePath, 'worker_output.txt')
  fs.writeFileSync(worktreeFile, 'Agent wrote this file!')

  // Check git status in worktree: dirty
  const worktreeStatus = runGit(worktreeResult.worktreePath, ['status', '--porcelain'])
  assert.match(worktreeStatus, /worker_output\.txt/)

  // Check git status in PRIMARY repository: completely clean!
  const mainStatus = runGit(repo, ['status', '--porcelain'])
  assert.equal(mainStatus, '', 'Primary working tree must be untouched!')
  assert.equal(fs.existsSync(path.join(repo, 'worker_output.txt')), false)

  fs.rmSync(repo, { recursive: true, force: true })
})

test('integrateTaskCommit fast-forward merges accepted candidate commit', () => {
  const repo = createTempGitRepo()
  createFeatureBranch(repo, 'feature-calc')

  const taskId = 'task_calc_1'
  const { worktreePath } = provisionTaskWorktree(repo, 'zen/feature-calc', taskId)

  // Implement feature inside worktree
  const calcFile = path.join(worktreePath, 'calc.js')
  fs.writeFileSync(calcFile, 'export function add(a, b) { return a + b; }\n')

  runGit(worktreePath, ['add', 'calc.js'])
  runGit(worktreePath, ['commit', '-m', 'feat: add calculator function'])
  const candidateCommitSha = runGit(worktreePath, ['rev-parse', 'HEAD'])

  // Fast-forward integrate candidate into feature branch
  const integration = integrateTaskCommit(repo, 'zen/feature-calc', taskId, candidateCommitSha)
  assert.equal(integration.success, true)
  assert.equal(integration.integratedCommitSha, candidateCommitSha)

  // Feature branch HEAD now matches candidate commit
  const featureHead = runGit(repo, ['rev-parse', 'zen/feature-calc'])
  assert.equal(featureHead, candidateCommitSha)

  // Primary working checkout is still on main
  assert.equal(runGit(repo, ['branch', '--show-current']), 'main')

  fs.rmSync(repo, { recursive: true, force: true })
})

test('integrateTaskCommit rejects non-fast-forward merge and preserves worktree', () => {
  const repo = createTempGitRepo()
  createFeatureBranch(repo, 'feature-conflict')

  const taskId = 'task_conf_1'
  const { worktreePath } = provisionTaskWorktree(repo, 'zen/feature-conflict', taskId)

  // Worker makes a commit in worktree
  fs.writeFileSync(path.join(worktreePath, 'worker.txt'), 'worker')
  runGit(worktreePath, ['add', 'worker.txt'])
  runGit(worktreePath, ['commit', '-m', 'worker commit'])
  const candidateSha = runGit(worktreePath, ['rev-parse', 'HEAD'])

  // Out-of-band commit on feature branch (making fast-forward impossible)
  const tmpFeatureWorktree = path.join(repo, '.zen-worktrees', 'tmp-feature')
  runGit(repo, ['worktree', 'add', tmpFeatureWorktree, 'zen/feature-conflict'])
  fs.writeFileSync(path.join(tmpFeatureWorktree, 'diverged.txt'), 'diverged')
  runGit(tmpFeatureWorktree, ['add', 'diverged.txt'])
  runGit(tmpFeatureWorktree, ['commit', '-m', 'diverged commit'])
  runGit(repo, ['worktree', 'remove', tmpFeatureWorktree])

  // Attempting fast-forward integration must throw INTEGRATION_CONFLICT
  assert.throws(() => {
    integrateTaskCommit(repo, 'zen/feature-conflict', taskId, candidateSha)
  }, (err) => {
    return err.code === 'INTEGRATION_CONFLICT' || err.message.includes('Fast-forward integration failed')
  })

  // Verify worker worktree and files are STILL PRESERVED!
  assert.equal(fs.existsSync(worktreePath), true)
  assert.equal(fs.existsSync(path.join(worktreePath, 'worker.txt')), true)

  fs.rmSync(repo, { recursive: true, force: true })
})

test('teardownTaskWorktree preserves dirty worktree unless force is specified', () => {
  const repo = createTempGitRepo()
  createFeatureBranch(repo, 'clean-feature')

  const taskId = 'task_clean_1'
  const { worktreePath } = provisionTaskWorktree(repo, 'zen/clean-feature', taskId)

  // Make worktree dirty with uncommitted changes
  fs.writeFileSync(path.join(worktreePath, 'dirty_work.txt'), 'work in progress')

  // Normal teardown must fail with WORKTREE_DIRTY
  assert.throws(() => {
    teardownTaskWorktree(repo, taskId, { force: false })
  }, (err) => err.code === 'WORKTREE_DIRTY')

  assert.equal(fs.existsSync(worktreePath), true, 'Dirty worktree must not be removed!')

  // Clean worktree by committing changes
  runGit(worktreePath, ['add', 'dirty_work.txt'])
  runGit(worktreePath, ['commit', '-m', 'commit work'])

  // Now teardown succeeds cleanly
  const result = teardownTaskWorktree(repo, taskId, { force: false })
  assert.equal(result.removed, true)
  assert.equal(fs.existsSync(worktreePath), false)

  fs.rmSync(repo, { recursive: true, force: true })
})
