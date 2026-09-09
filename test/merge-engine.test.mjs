import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  checkMergeCompatibility,
  mergeFeatureBranch,
  cleanupFeatureArtifacts,
  formatFeatureChangelog,
  MergeConflictError,
} from '../lib/orchestrator/merge-engine.mjs'
import { runGit } from '../lib/orchestrator/git-workspace.mjs'

function createTempGitRepo(prefix = 'zen-merge-test-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execFileSync('git', ['init', '-b', 'main', tmpDir])
  execFileSync('git', ['config', 'user.name', 'Merge Tester'], { cwd: tmpDir })
  execFileSync('git', ['config', 'user.email', 'merge@example.com'], { cwd: tmpDir })

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'merge-app', version: '1.0.0' }, null, 2))
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Merge App\n')
  execFileSync('git', ['add', '.'], { cwd: tmpDir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpDir })

  return tmpDir
}

test('formatFeatureChangelog embeds feature goals and task summaries', () => {
  const changelog = formatFeatureChangelog({
    featureTitle: 'Rate Limiter Service',
    baselineVersion: 'v1.0.0',
    contentDigest: 'sha256:1234567890abcdef',
    completedTasks: [
      { id: 'tsk_1', title: 'TokenBucket Class' },
      { id: 'tsk_2', title: 'Unit Test Suite' },
    ],
  })

  assert.match(changelog, /feat: Rate Limiter Service/)
  assert.match(changelog, /Approved Baseline: v1\.0\.0 \(sha256:123456789\)/)
  assert.match(changelog, /- TokenBucket Class \(tsk_1\)/)
  assert.match(changelog, /- Unit Test Suite \(tsk_2\)/)
})

test('checkMergeCompatibility detects clean fast-forward vs drifted base', () => {
  const repo = createTempGitRepo()

  // Create feature branch
  runGit(repo, ['branch', 'zen/clean-feature'])

  // Feature has not drifted yet
  const compat1 = checkMergeCompatibility({ repoPath: repo, featureBranch: 'zen/clean-feature' })
  assert.equal(compat1.canFastForward, true)
  assert.equal(compat1.hasDrift, false)

  // Advance main branch (drift)
  fs.writeFileSync(path.join(repo, 'main-update.txt'), 'main changed')
  runGit(repo, ['add', 'main-update.txt'])
  runGit(repo, ['commit', '-m', 'commit on main'])

  // Now feature has drifted from main
  const compat2 = checkMergeCompatibility({ repoPath: repo, featureBranch: 'zen/clean-feature' })
  assert.equal(compat2.canFastForward, false)
  assert.equal(compat2.hasDrift, true)

  fs.rmSync(repo, { recursive: true, force: true })
})

test('mergeFeatureBranch executes Squash & Merge with structured release notes', () => {
  const repo = createTempGitRepo()

  // Create feature branch with multiple small commits
  runGit(repo, ['checkout', '-b', 'zen/auth-service'])

  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src', 'auth.js'), 'export const auth = true;\n')
  runGit(repo, ['add', 'src/auth.js'])
  runGit(repo, ['commit', '-m', 'feat(tsk_1): auth core'])

  fs.mkdirSync(path.join(repo, 'test'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'test', 'auth.test.js'), 'test("auth", () => {});\n')
  runGit(repo, ['add', 'test/auth.test.js'])
  runGit(repo, ['commit', '-m', 'test(tsk_2): auth test'])

  // Squash merge into main
  const result = mergeFeatureBranch({
    repoPath: repo,
    featureBranch: 'zen/auth-service',
    baseBranch: 'main',
    strategy: 'squash',
    featureTitle: 'Authentication Service',
    baselineVersion: 'v1.0.0',
    completedTasks: [
      { id: 'tsk_1', title: 'Auth Core' },
      { id: 'tsk_2', title: 'Auth Test' },
    ],
  })

  assert.equal(result.success, true)
  assert.equal(result.strategy, 'squash')
  assert.equal(result.baseBranch, 'main')
  assert.ok(result.mergedCommitSha.length >= 40)

  // Verify main commit log contains squashed changelog
  const logMsg = runGit(repo, ['log', '-1', '--pretty=%B'])
  assert.match(logMsg, /feat: Authentication Service/)
  assert.match(logMsg, /- Auth Core \(tsk_1\)/)

  // Verify files exist in main working tree
  assert.equal(fs.existsSync(path.join(repo, 'src', 'auth.js')), true)
  assert.equal(fs.existsSync(path.join(repo, 'test', 'auth.test.js')), true)

  // Clean up feature artifacts
  const cleanup = cleanupFeatureArtifacts({ repoPath: repo, featureBranch: 'zen/auth-service' })
  assert.equal(cleanup.deletedBranch, true)

  fs.rmSync(repo, { recursive: true, force: true })
})

test('mergeFeatureBranch executes Rebase merge strategy cleanly', () => {
  const repo = createTempGitRepo()

  runGit(repo, ['checkout', '-b', 'zen/rebase-feat'])
  fs.writeFileSync(path.join(repo, 'rebase-file.txt'), 'rebase content')
  runGit(repo, ['add', 'rebase-file.txt'])
  runGit(repo, ['commit', '-m', 'feat: rebase file'])

  // Advance main with non-conflicting commit
  runGit(repo, ['checkout', 'main'])
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'unrelated')
  runGit(repo, ['add', 'unrelated.txt'])
  runGit(repo, ['commit', '-m', 'chore: unrelated main commit'])

  // Execute rebase merge
  const result = mergeFeatureBranch({
    repoPath: repo,
    featureBranch: 'zen/rebase-feat',
    baseBranch: 'main',
    strategy: 'rebase',
  })

  assert.equal(result.success, true)
  assert.equal(result.strategy, 'rebase')
  assert.equal(fs.existsSync(path.join(repo, 'rebase-file.txt')), true)

  fs.rmSync(repo, { recursive: true, force: true })
})
