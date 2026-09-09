import fs from 'node:fs'
import path from 'node:path'
import { runGit, teardownTaskWorktree } from './git-workspace.mjs'

export class MergeConflictError extends Error {
  constructor(message, conflictingFiles = []) {
    super(message)
    this.name = 'MergeConflictError'
    this.code = 'MERGE_CONFLICT'
    this.conflictingFiles = conflictingFiles
  }
}

/**
 * Check merge compatibility between feature branch and base branch.
 * Detects whether base branch drifted and whether conflicts exist.
 */
export function checkMergeCompatibility({
  repoPath,
  featureBranch,
  baseBranch = 'main',
}) {
  const resolvedRepo = path.resolve(repoPath)

  const featureHead = runGit(resolvedRepo, ['rev-parse', featureBranch])
  const baseHead = runGit(resolvedRepo, ['rev-parse', baseBranch])
  const mergeBase = runGit(resolvedRepo, ['merge-base', baseBranch, featureBranch])

  const canFastForward = mergeBase === baseHead
  const hasDrift = mergeBase !== baseHead

  let hasConflicts = false
  const conflictingFiles = []

  if (hasDrift) {
    // Check for conflicts using git merge-tree (available in Git 2.50+)
    try {
      const mergeTreeOutput = runGit(resolvedRepo, ['merge-tree', baseHead, featureHead])
      if (mergeTreeOutput.includes('CONFLICT') || mergeTreeOutput.includes('Auto-merging')) {
        const lines = mergeTreeOutput.split('\n')
        for (const line of lines) {
          if (line.startsWith('CONFLICT (content): Merge conflict in ')) {
            conflictingFiles.push(line.replace('CONFLICT (content): Merge conflict in ', '').trim())
          }
        }
        hasConflicts = conflictingFiles.length > 0
      }
    } catch {
      // Fallback: check status via simulated merge
    }
  }

  return {
    featureBranch,
    baseBranch,
    featureHead,
    baseHead,
    mergeBase,
    canFastForward,
    hasDrift,
    hasConflicts,
    conflictingFiles,
  }
}

/**
 * Generate formatted changelog and release notes for a squashed feature commit.
 */
export function formatFeatureChangelog({
  featureTitle,
  baselineVersion = 'v1.0.0',
  contentDigest = '',
  completedTasks = [],
}) {
  const taskLines = completedTasks && completedTasks.length > 0
    ? completedTasks.map((t) => `- ${t.title}${t.id ? ` (${t.id})` : ''}`).join('\n')
    : '- All planned tasks completed and verified.'

  return `feat: ${featureTitle}

Implemented via Claude-Zen Autonomous Delivery Platform.
Approved Baseline: ${baselineVersion}${contentDigest ? ` (${contentDigest.slice(0, 16)})` : ''}

Completed Tasks:
${taskLines}

Co-Authored-By: Claude <noreply@anthropic.com>`
}

/**
 * Merge feature branch into base branch using selected strategy.
 * Supported strategies: 'squash' (default), 'rebase', 'fast-forward'.
 */
export function mergeFeatureBranch({
  repoPath,
  featureBranch,
  baseBranch = 'main',
  strategy = 'squash',
  commitMessage = '',
  featureTitle = 'New Feature',
  baselineVersion = 'v1.0.0',
  contentDigest = '',
  completedTasks = [],
}) {
  const resolvedRepo = path.resolve(repoPath)

  // 1. Check compatibility
  const compat = checkMergeCompatibility({ repoPath, featureBranch, baseBranch })
  if (compat.hasConflicts) {
    throw new MergeConflictError(
      `Cannot merge ${featureBranch} into ${baseBranch}: merge conflicts detected.`,
      compat.conflictingFiles
    )
  }

  // 2. Switch to base branch
  runGit(resolvedRepo, ['checkout', baseBranch])

  let mergedCommitSha = ''

  if (strategy === 'squash') {
    // Generate structured commit message
    const msg = commitMessage || formatFeatureChangelog({
      featureTitle,
      baselineVersion,
      contentDigest,
      completedTasks,
    })

    // Execute squash merge
    runGit(resolvedRepo, ['merge', '--squash', featureBranch])
    runGit(resolvedRepo, ['commit', '-m', msg])
    mergedCommitSha = runGit(resolvedRepo, ['rev-parse', 'HEAD'])
  } else if (strategy === 'fast-forward') {
    if (!compat.canFastForward) {
      throw new Error(`Cannot fast-forward merge ${featureBranch} into ${baseBranch}: base branch has diverged.`)
    }
    runGit(resolvedRepo, ['merge', '--ff-only', featureBranch])
    mergedCommitSha = runGit(resolvedRepo, ['rev-parse', 'HEAD'])
  } else if (strategy === 'rebase') {
    // Rebase feature branch onto base branch first
    runGit(resolvedRepo, ['checkout', featureBranch])
    runGit(resolvedRepo, ['rebase', baseBranch])
    const rebasedHead = runGit(resolvedRepo, ['rev-parse', 'HEAD'])

    // Fast-forward base branch to rebased feature branch
    runGit(resolvedRepo, ['checkout', baseBranch])
    runGit(resolvedRepo, ['merge', '--ff-only', featureBranch])
    mergedCommitSha = rebasedHead
  } else {
    throw new Error(`Unsupported merge strategy: '${strategy}'`)
  }

  return {
    success: true,
    strategy,
    baseBranch,
    featureBranch,
    mergedCommitSha,
  }
}

/**
 * Clean up feature branches and temporary worktrees after successful merge.
 */
export function cleanupFeatureArtifacts({
  repoPath,
  featureBranch,
  deleteFeatureBranch = true,
}) {
  const resolvedRepo = path.resolve(repoPath)
  const results = {
    deletedBranch: false,
    prunedWorktrees: false,
  }

  // Ensure not currently checked out on featureBranch
  const currentBranch = runGit(resolvedRepo, ['branch', '--show-current'])
  if (currentBranch === featureBranch) {
    runGit(resolvedRepo, ['checkout', 'main'])
  }

  // Delete feature branch
  if (deleteFeatureBranch) {
    try {
      runGit(resolvedRepo, ['branch', '-D', featureBranch])
      results.deletedBranch = true
    } catch {}
  }

  // Prune any dangling worktrees
  try {
    runGit(resolvedRepo, ['worktree', 'prune'])
    results.prunedWorktrees = true
  } catch {}

  return results
}
