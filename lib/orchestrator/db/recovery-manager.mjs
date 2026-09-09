import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { getOrchestratorDb } from './index.mjs'

/**
 * Check whether a process PID is currently alive on the host.
 */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM' // Exists but no permission to signal
  }
}

/**
 * Retrieve process start time and command line if available.
 * Returns null if process does not exist.
 */
export function getProcessDetails(pid) {
  if (!isPidAlive(pid)) return null
  try {
    // POSIX standard ps command for start time and args
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()

    return {
      pid,
      info: output,
    }
  } catch {
    return null
  }
}

/**
 * Gracefully terminate a process group.
 * Sends SIGTERM to the process group (-pid), waits for graceMs, then SIGKILL.
 */
export function terminateProcessGroup(pid, { graceMs = 5000 } = {}) {
  if (!isPidAlive(pid)) return { terminated: true, wasRunning: false }

  try {
    // Attempt process group kill first (setpgid: true on spawn)
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      process.kill(pid, 'SIGTERM')
    }

    const start = Date.now()
    while (Date.now() - start < graceMs) {
      if (!isPidAlive(pid)) return { terminated: true, wasRunning: true }
      // Brief sleep in sync loop
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }

    if (isPidAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    }

    return { terminated: !isPidAlive(pid), wasRunning: true }
  } catch (err) {
    return { terminated: !isPidAlive(pid), error: err.message, wasRunning: true }
  }
}

/**
 * Non-destructive workspace recovery sweep on orchestrator boot.
 * Reconciles transient task runs without destroying developer/agent worktrees.
 */
export function performStartupRecovery(db = null, { gitExecutor = null } = {}) {
  const targetDb = db || getOrchestratorDb()
  const results = {
    reconciledRuns: 0,
    preservedWorktrees: 0,
    clearedLocks: 0,
    quarantinedTasks: [],
  }

  // 1. Find all task runs that were in transient states when the service crashed or stopped
  const transientRuns = targetDb.prepare(`
    SELECT r.*, t.title as task_title, t.worktree_path, t.status as task_status
    FROM task_runs r
    JOIN tasks t ON t.id = r.task_id
    WHERE r.status IN ('RUNNING', 'PENDING', 'VERIFYING', 'REVIEWING')
  `).all()

  for (const run of transientRuns) {
    const isAlive = isPidAlive(run.process_pid)
    let processTerminated = false

    if (isAlive) {
      const details = getProcessDetails(run.process_pid)
      // Verify process identity if cmdline was recorded
      if (run.process_cmdline && details && !details.info.includes(run.process_cmdline.slice(0, 20))) {
        // PID recycled by OS for another process! DO NOT kill.
      } else {
        const termResult = terminateProcessGroup(run.process_pid)
        processTerminated = termResult.terminated
      }
    }

    // 2. Mark the transient run as INTERRUPTED
    const now = Date.now()
    targetDb.prepare(`
      UPDATE task_runs
      SET status = 'INTERRUPTED', completed_at = ?
      WHERE id = ?
    `).run(now, run.id)
    results.reconciledRuns++

    // 3. Inspect the worktree directory if it exists
    if (run.worktree_path && fs.existsSync(run.worktree_path)) {
      // Clear stale index.lock if present and owning process is confirmed dead
      const indexLock = path.join(run.worktree_path, '.git', 'index.lock')
      if (fs.existsSync(indexLock) && (!isAlive || processTerminated)) {
        try {
          fs.unlinkSync(indexLock)
          results.clearedLocks++
        } catch {}
      }

      // Check if git working directory has dirty or untracked changes
      let isDirty = true
      if (gitExecutor) {
        try {
          const statusOutput = gitExecutor(run.worktree_path, ['status', '--porcelain'])
          isDirty = !!statusOutput.trim()
        } catch {
          isDirty = true
        }
      }

      // PRESERVE WORKSPACE: Do NOT run git worktree remove.
      // Transition task to Blocked with reason RECONCILIATION_REQUIRED
      targetDb.prepare(`
        UPDATE tasks
        SET status = 'Blocked',
            waiting_reason = NULL,
            blocked_reason = 'RECONCILIATION_REQUIRED',
            updated_at = ?
        WHERE id = ?
      `).run(now, run.task_id)

      results.preservedWorktrees++
      results.quarantinedTasks.push({
        taskId: run.task_id,
        runId: run.id,
        worktreePath: run.worktree_path,
        isDirty,
      })
    } else {
      // No worktree on disk; reset task to Ready if dependencies permit
      targetDb.prepare(`
        UPDATE tasks
        SET status = 'Ready',
            waiting_reason = NULL,
            blocked_reason = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(now, run.task_id)
    }
  }

  return results
}
