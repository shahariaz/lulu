import path from 'node:path'
import { runGit, integrateTaskCommit, teardownTaskWorktree } from './git-workspace.mjs'
import { runVerificationChecks } from './verifier-engine.mjs'
import { transitionTask } from './dag-scheduler.mjs'
import { createTaskRun, recordAcceptance, recordAuditLog, getOrchestratorDb } from './db/index.mjs'

export class RebaseConflictError extends Error {
  constructor(message, { taskBranch, targetBranch, details = '' } = {}) {
    super(message)
    this.name = 'RebaseConflictError'
    this.code = 'REBASE_CONFLICT'
    this.taskBranch = taskBranch
    this.targetBranch = targetBranch
    this.details = details
  }
}

/**
 * Rebase a task branch onto the latest HEAD of the target feature branch.
 */
export function rebaseTaskBranch({
  repoPath,
  worktreePath,
  taskBranch,
  targetBranch,
}) {
  const resolvedWorktree = path.resolve(worktreePath)

  try {
    // Attempt git rebase inside worktree
    runGit(resolvedWorktree, ['rebase', targetBranch])
    const newCommitSha = runGit(resolvedWorktree, ['rev-parse', 'HEAD'])

    return {
      success: true,
      newCommitSha,
      rebased: true,
    }
  } catch (err) {
    // Abort rebase on conflict to keep worktree clean
    try {
      runGit(resolvedWorktree, ['rebase', '--abort'])
    } catch {}

    throw new RebaseConflictError(
      `Rebase of ${taskBranch} onto ${targetBranch} encountered merge conflicts: ${err.message}`,
      { taskBranch, targetBranch, details: err.stderr || err.message }
    )
  }
}

/**
 * Conflict-Free Sequential Merge Queue for Parallel Swarms.
 * Serializes integration, performs automated rebasing when base advanced,
 * and re-verifies rebased commits before final fast-forward merge.
 */
export class ConflictFreeMergeQueue {
  constructor({ db = null } = {}) {
    this._db = db
    this.queue = []
    this.processing = false
  }

  get db() {
    return this._db || getOrchestratorDb()
  }

  set db(val) {
    this._db = val
  }

  /**
   * Enqueue an accepted task for integration into the feature branch.
   */
  enqueue({
    taskId,
    projectId,
    repoPath,
    featureBranch,
    worktreePath,
    candidateCommitSha,
    verificationCommands = ['npm test'],
    acceptedBy = 'owner',
  }) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        taskId,
        projectId,
        repoPath,
        featureBranch,
        worktreePath,
        candidateCommitSha,
        verificationCommands,
        acceptedBy,
        resolve,
        reject,
      })

      this.processNext()
    })
  }

  async processNext() {
    if (this.processing || this.queue.length === 0) return
    this.processing = true

    const item = this.queue.shift()

    try {
      const result = await this.integrateItem(item)
      item.resolve(result)
    } catch (err) {
      item.reject(err)
    } finally {
      this.processing = false
      // Process next item in queue
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext())
      }
    }
  }

  async integrateItem({
    taskId,
    projectId,
    repoPath,
    featureBranch,
    worktreePath,
    candidateCommitSha,
    verificationCommands,
    acceptedBy,
  }) {
    const taskBranch = `zen/task/${taskId}`
    let activeCandidateSha = candidateCommitSha

    // Check if feature branch has moved since task branched
    const featureHead = runGit(repoPath, ['rev-parse', featureBranch])
    const mergeBase = runGit(repoPath, ['merge-base', featureBranch, taskBranch])

    const needsRebase = mergeBase !== featureHead

    if (needsRebase) {
      // 1. Rebase task branch onto the latest feature branch HEAD
      const rebaseResult = rebaseTaskBranch({
        repoPath,
        worktreePath,
        taskBranch,
        targetBranch: featureBranch,
      })

      activeCandidateSha = rebaseResult.newCommitSha

      // 2. Re-verify automated tests against the rebased commit!
      const verifRun = createTaskRun({
        taskId,
        kind: 'VERIFICATION',
        role: 'VERIFIER',
      }, this.db)

      const verifResult = await runVerificationChecks({
        taskRunId: verifRun.id,
        worktreePath,
        checkCommands: verificationCommands,
      }, this.db)

      if (!verifResult.passed) {
        throw new Error(`Re-verification failed after rebasing onto ${featureBranch}: ${verifResult.outputLog}`)
      }

      recordAuditLog({
        projectId,
        taskId,
        eventType: 'TASK_REBASED_AND_REVERIFIED',
        actor: 'merge-queue',
        details: { oldSha: candidateCommitSha, newSha: activeCandidateSha },
      }, this.db)
    }

    // 3. Fast-forward merge rebased candidate into feature branch
    const integration = integrateTaskCommit(repoPath, featureBranch, taskId, activeCandidateSha)

    // 4. Clean teardown of worktree
    teardownTaskWorktree(repoPath, taskId, { force: false })

    // 5. Mark task Done in state machine
    const doneTask = transitionTask(taskId, 'Done', {
      actor: acceptedBy,
      details: { integratedCommitSha: integration.integratedCommitSha },
    }, this.db)

    // 6. Record acceptance record in SQLite
    recordAcceptance({
      taskId,
      candidateCommitSha: activeCandidateSha,
      acceptedBy,
      integratedCommitSha: integration.integratedCommitSha,
      integratedAt: Date.now(),
    }, this.db)

    return {
      success: true,
      taskId,
      integratedCommitSha: integration.integratedCommitSha,
      rebased: needsRebase,
      task: doneTask,
    }
  }
}
