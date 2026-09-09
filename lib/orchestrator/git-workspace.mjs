import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * Execute a git command synchronously inside a specified directory.
 */
export function runGit(cwd, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // never prompt for password/credentials in background
      },
      ...options,
    }).trim()
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : ''
    const message = stderr || err.message
    const error = new Error(`git ${args[0]} failed in ${cwd}: ${message}`)
    error.code = err.status || 1
    error.stderr = stderr
    throw error
  }
}

/**
 * Inspect a repository path and detect runtime, test commands, and git cleanliness.
 */
export function inspectRepository(repoPath) {
  const resolvedPath = path.resolve(repoPath)
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Repository directory does not exist: ${resolvedPath}`)
  }

  // 1. Verify Git Repository
  try {
    const isGit = runGit(resolvedPath, ['rev-parse', '--is-inside-work-tree'])
    if (isGit !== 'true') throw new Error()
  } catch {
    throw new Error(`Directory is not a valid git repository: ${resolvedPath}`)
  }

  // 2. Git Status and HEAD
  const statusOutput = runGit(resolvedPath, ['status', '--porcelain'])
  const uncommittedFiles = statusOutput ? statusOutput.split('\n').map((l) => l.trim()).filter(Boolean) : []
  const isClean = uncommittedFiles.length === 0

  let currentBranch = ''
  try {
    currentBranch = runGit(resolvedPath, ['branch', '--show-current'])
  } catch {}
  if (!currentBranch) {
    try {
      currentBranch = runGit(resolvedPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    } catch {}
  }

  let headCommitSha = ''
  try {
    headCommitSha = runGit(resolvedPath, ['rev-parse', 'HEAD'])
  } catch {}

  // 3. Detect Language Runtime & Test Commands
  const detectedRuntime = detectRuntime(resolvedPath)

  return {
    repoPath: resolvedPath,
    isClean,
    uncommittedFiles,
    currentBranch: currentBranch || 'HEAD',
    headCommitSha,
    runtime: detectedRuntime.runtime,
    testCommand: detectedRuntime.testCommand,
    lintCommand: detectedRuntime.lintCommand,
    packageManager: detectedRuntime.packageManager,
  }
}

/**
 * Detect runtime stack and recommended test/lint commands from package files.
 */
export function detectRuntime(targetDir) {
  // Node.js (package.json)
  const pkgJsonPath = path.join(targetDir, 'package.json')
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
      const hasTestScript = pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes('no test specified')
      const hasLintScript = pkg.scripts && pkg.scripts.lint

      let packageManager = 'npm'
      if (fs.existsSync(path.join(targetDir, 'pnpm-lock.yaml'))) packageManager = 'pnpm'
      else if (fs.existsSync(path.join(targetDir, 'yarn.lock'))) packageManager = 'yarn'

      return {
        runtime: 'node',
        packageManager,
        testCommand: hasTestScript ? `${packageManager} test` : `${packageManager} test`,
        lintCommand: hasLintScript ? `${packageManager} run lint` : null,
      }
    } catch {}
  }

  // Python (pyproject.toml, pytest, requirements.txt)
  if (fs.existsSync(path.join(targetDir, 'pyproject.toml')) ||
      fs.existsSync(path.join(targetDir, 'requirements.txt')) ||
      fs.existsSync(path.join(targetDir, 'setup.py'))) {
    return {
      runtime: 'python',
      packageManager: 'pip',
      testCommand: 'pytest',
      lintCommand: 'flake8',
    }
  }

  // Rust (Cargo.toml)
  if (fs.existsSync(path.join(targetDir, 'Cargo.toml'))) {
    return {
      runtime: 'rust',
      packageManager: 'cargo',
      testCommand: 'cargo test',
      lintCommand: 'cargo clippy',
    }
  }

  // Go (go.mod)
  if (fs.existsSync(path.join(targetDir, 'go.mod'))) {
    return {
      runtime: 'go',
      packageManager: 'go',
      testCommand: 'go test ./...',
      lintCommand: 'golangci-lint run',
    }
  }

  return {
    runtime: 'unknown',
    packageManager: null,
    testCommand: null,
    lintCommand: null,
  }
}

/**
 * Create or checkout a dedicated feature branch: zen/<feature-slug>
 */
export function createFeatureBranch(repoPath, featureSlug, baseCommitSha = null) {
  const branchName = `zen/${featureSlug}`
  const resolvedRepo = path.resolve(repoPath)

  // Verify base commit if provided
  const baseSha = baseCommitSha || runGit(resolvedRepo, ['rev-parse', 'HEAD'])

  // Check if branch already exists
  let branchExists = false
  try {
    runGit(resolvedRepo, ['rev-parse', '--verify', `refs/heads/${branchName}`])
    branchExists = true
  } catch {}

  if (!branchExists) {
    runGit(resolvedRepo, ['branch', branchName, baseSha])
  }

  return {
    featureBranch: branchName,
    baseCommitSha: baseSha,
  }
}

/**
 * Ensure .zen-worktrees/ is excluded from git status via .git/info/exclude
 * without dirtying or modifying the user's committed .gitignore file.
 */
export function ensureWorktreesIgnored(repoPath) {
  const resolvedRepo = path.resolve(repoPath)
  let gitDir = path.join(resolvedRepo, '.git')

  if (fs.existsSync(gitDir) && fs.statSync(gitDir).isFile()) {
    const content = fs.readFileSync(gitDir, 'utf8')
    const match = content.match(/gitdir:\s*(.+)/)
    if (match) gitDir = path.resolve(resolvedRepo, match[1])
  }

  const infoDir = path.join(gitDir, 'info')
  const excludePath = path.join(infoDir, 'exclude')
  if (!fs.existsSync(infoDir)) {
    fs.mkdirSync(infoDir, { recursive: true })
  }

  let currentExclude = ''
  if (fs.existsSync(excludePath)) {
    currentExclude = fs.readFileSync(excludePath, 'utf8')
  }

  if (!currentExclude.includes('.zen-worktrees')) {
    const newline = currentExclude.endsWith('\n') || !currentExclude ? '' : '\n'
    fs.writeFileSync(excludePath, `${currentExclude}${newline}.zen-worktrees/\n`, 'utf8')
  }
}

/**
 * Provision an isolated git worktree for a task.
 * Path: <repoPath>/.zen-worktrees/<taskId>
 * Branch: zen/task/<taskId> rooted at featureBranch
 */
export function provisionTaskWorktree(repoPath, featureBranch, taskId) {
  const resolvedRepo = path.resolve(repoPath)
  ensureWorktreesIgnored(resolvedRepo)
  const worktreeDir = path.join(resolvedRepo, '.zen-worktrees')
  const taskWorktreePath = path.join(worktreeDir, taskId)
  const taskBranch = `zen/task/${taskId}`

  if (!fs.existsSync(worktreeDir)) {
    fs.mkdirSync(worktreeDir, { recursive: true, mode: 0o700 })
  }

  // If worktree directory already exists, verify worktree list
  if (fs.existsSync(taskWorktreePath)) {
    const list = runGit(resolvedRepo, ['worktree', 'list', '--porcelain'])
    if (list.includes(taskWorktreePath)) {
      const currentHead = runGit(taskWorktreePath, ['rev-parse', 'HEAD'])
      return {
        worktreePath: taskWorktreePath,
        taskBranch,
        baseCommitSha: currentHead,
      }
    }
  }

  // Ensure task branch does not already exist from older runs
  try {
    runGit(resolvedRepo, ['branch', '-D', taskBranch])
  } catch {}

  // Get current HEAD of featureBranch as baseCommitSha
  const baseCommitSha = runGit(resolvedRepo, ['rev-parse', featureBranch])

  // Create isolated git worktree checked out to taskBranch
  runGit(resolvedRepo, ['worktree', 'add', '-b', taskBranch, taskWorktreePath, featureBranch])

  return {
    worktreePath: taskWorktreePath,
    taskBranch,
    baseCommitSha,
  }
}

/**
 * Fast-forward integrate an accepted task candidate commit into the feature branch.
 * Fast-forward ONLY (`git merge --ff-only`).
 */
export function integrateTaskCommit(repoPath, featureBranch, taskId, candidateCommitSha) {
  const resolvedRepo = path.resolve(repoPath)
  const taskBranch = `zen/task/${taskId}`

  // Verify candidate commit matches task branch HEAD
  const taskHead = runGit(resolvedRepo, ['rev-parse', taskBranch])
  if (taskHead !== candidateCommitSha) {
    throw new Error(`Candidate commit mismatch: expected ${candidateCommitSha}, but ${taskBranch} is at ${taskHead}`)
  }

  // Ensure featureBranch is updated via fast-forward only.
  // We can update the feature branch ref directly or merge if checked out.
  try {
    // Check if featureBranch is currently checked out in the main working tree
    const currentBranch = runGit(resolvedRepo, ['branch', '--show-current'])
    if (currentBranch === featureBranch) {
      runGit(resolvedRepo, ['merge', '--ff-only', taskBranch])
    } else {
      // Use update-ref for clean fast-forward verification
      const featureHead = runGit(resolvedRepo, ['rev-parse', featureBranch])
      const isAncestor = runGit(resolvedRepo, ['merge-base', '--is-ancestor', featureHead, candidateCommitSha], {
        // exits 0 if true, 1 if false
      }) === ''

      runGit(resolvedRepo, ['update-ref', `refs/heads/${featureBranch}`, candidateCommitSha, featureHead])
    }

    const newFeatureHead = runGit(resolvedRepo, ['rev-parse', featureBranch])
    if (newFeatureHead !== candidateCommitSha) {
      throw new Error(`Fast-forward integration failed: ${featureBranch} is at ${newFeatureHead}`)
    }

    return {
      success: true,
      featureBranch,
      integratedCommitSha: newFeatureHead,
    }
  } catch (err) {
    const error = new Error(`Fast-forward integration failed for ${taskBranch} into ${featureBranch}: ${err.message}`)
    error.code = 'INTEGRATION_CONFLICT'
    throw error
  }
}

/**
 * Non-destructive teardown of a task worktree.
 * Normal cleanup executes `git worktree remove` ONLY if the worktree is completely clean.
 * If dirty, it throws unless `force: true` is explicitly provided by the owner.
 */
export function teardownTaskWorktree(repoPath, taskId, { force = false } = {}) {
  const resolvedRepo = path.resolve(repoPath)
  const taskWorktreePath = path.join(resolvedRepo, '.zen-worktrees', taskId)

  if (!fs.existsSync(taskWorktreePath)) {
    // Already pruned
    runGit(resolvedRepo, ['worktree', 'prune'])
    return { removed: true, wasPresent: false }
  }

  // Preflight check: is worktree clean?
  if (!force) {
    const status = runGit(taskWorktreePath, ['status', '--porcelain'])
    if (status.trim()) {
      const error = new Error(`Worktree ${taskWorktreePath} contains uncommitted modifications; cannot remove without explicit force.`)
      error.code = 'WORKTREE_DIRTY'
      throw error
    }
  }

  // Remove worktree
  const removeArgs = ['worktree', 'remove']
  if (force) removeArgs.push('--force')
  removeArgs.push(taskWorktreePath)

  runGit(resolvedRepo, removeArgs)
  runGit(resolvedRepo, ['worktree', 'prune'])

  return { removed: true, wasPresent: true }
}
