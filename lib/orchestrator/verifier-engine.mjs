import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  recordVerificationResult,
  getTask,
  incrementTaskRepairAttempts,
  updateTaskStatus,
  recordAuditLog,
  getOrchestratorDb,
} from './db/index.mjs'
import {
  spawnControlledProcess,
  validateWorkerCommand,
} from './security-boundary.mjs'
import { runGit, resolveRepoRootFromWorktree } from './git-workspace.mjs'
import { transitionTask } from './dag-scheduler.mjs'
import {
  detectContainerEngine,
  buildWorkerContainerArgs,
  resolveHostUser,
  DEFAULT_WORKER_IMAGE,
} from './container-runner.mjs'
import { resolveExecutionTier } from './worker-harness.mjs'

/**
 * Compute SHA256 digest of verification execution logs and exit codes.
 */
export function computeVerificationDigest({ commands, exitCodes, outputLogs }) {
  const payload = JSON.stringify({ commands, exitCodes, outputLogs })
  return 'sha256:' + createHash('sha256').update(payload).digest('hex')
}

/**
 * Run a single verification command inside the container tier.
 *
 * Uses the same image and mount layout as the worker (see buildWorktreeMounts) so that what is
 * verified is exactly what was built, in the same environment. Network is disabled: a test
 * suite has no business reaching the gateway, and denying egress means a compromised or
 * runaway test cannot phone home or burn subscription quota.
 */
async function runCheckInContainer({ command, args, worktreePath, timeoutMs }) {
  const detected = detectContainerEngine()
  if (!detected.available || detected.engine === 'none') {
    throw new Error(
      'ZEN_EXECUTION_TIER=container but no container engine (docker/podman) is available. ' +
      'Install Docker, or set ZEN_EXECUTION_TIER=host to verify on the host.'
    )
  }

  const repoPath = resolveRepoRootFromWorktree(worktreePath)
  const containerArgs = buildWorkerContainerArgs({
    engine: detected.engine,
    repoPath,
    taskId: path.basename(worktreePath),
    worktreePath,
    command,
    args,
    user: resolveHostUser(worktreePath),
    networkMode: 'none',
    env: { CI: 'true' },
  })

  // Never throw on a non-zero exit: a failing test suite is a verification RESULT, not an
  // infrastructure error, and the exit code and log are the artifact being digested.
  try {
    return await spawnControlledProcess(detected.engine, containerArgs, { timeoutMs })
  } catch (err) {
    return { exitCode: err.exitCode ?? 1, stdout: err.stdout || '', stderr: err.stderr || err.message }
  }
}

/**
 * Run deterministic verification checks (e.g. test and lint suites) inside the task worktree.
 */
export async function runVerificationChecks({
  taskRunId,
  worktreePath,
  checkCommands = ['npm test'],
  environmentInfo = {},
  timeoutMs = 120000,
  // Defaults to the same tier the worker used, so the code is verified in the environment it
  // was built in. Overridable per-call mainly for tests.
  tier = resolveExecutionTier(),
}, db = null) {
  const targetDb = db || getOrchestratorDb()

  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Worktree path does not exist: ${worktreePath}`)
  }

  // Preflight: Ensure worktree is in clean git state before running verification
  const preStatus = runGit(worktreePath, ['status', '--porcelain'])
  const preUntracked = preStatus.split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim())
  const preModified = preStatus.split('\n').filter((l) => !l.startsWith('?? ') && l.trim())

  if (preModified.length > 0) {
    throw new Error(`Worktree contains uncommitted tracked modifications before verification: ${preModified.join(', ')}`)
  }

  const executedCommands = []
  const exitCodes = []
  const outputLogs = []
  let allPassed = true

  // Record where verification actually ran. In the container tier the host's node version is
  // NOT what executed the tests, and recording it would make the verification artifact lie
  // about its own provenance — the reviewer reads this to know what the digest represents.
  const envInfo = tier === 'container'
    ? {
      tier,
      engine: detectContainerEngine().engine,
      image: DEFAULT_WORKER_IMAGE,
      network: 'none',
      ...environmentInfo,
    }
    : {
      tier,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ...environmentInfo,
    }

  for (const cmdStr of checkCommands) {
    // Allowlist check stays even in the container tier — defence in depth, and it gives a
    // clear rejection instead of a container spinning up to run something obviously wrong.
    validateWorkerCommand(cmdStr)
    const [command, ...args] = cmdStr.trim().split(/\s+/)

    executedCommands.push(cmdStr)

    const runResult = tier === 'container'
      ? await runCheckInContainer({ command, args, worktreePath, timeoutMs })
      : await spawnControlledProcess(command, args, {
        cwd: worktreePath,
        timeoutMs,
        env: process.env,
      })

    exitCodes.push(runResult.exitCode)
    const log = (runResult.stdout + '\n' + runResult.stderr).trim()
    outputLogs.push(log)

    if (runResult.exitCode !== 0) {
      allPassed = false
    }
  }

  // Postflight Cleanliness Check:
  // If verification altered ANY tracked file, verification MUST fail immediately!
  const postStatus = runGit(worktreePath, ['status', '--porcelain'])
  const postLines = postStatus.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  const dirtiedTrackedFiles = []

  for (const line of postLines) {
    if (line.startsWith('?? ')) continue // untracked
    const m = line.match(/^[MADRCU? ][MADRCU? ]?\s+(.+)$/)
    if (m) {
      dirtiedTrackedFiles.push(m[1].trim())
    }
  }

  if (dirtiedTrackedFiles.length > 0) {
    allPassed = false
    outputLogs.push(`ERROR: Verification execution dirtied tracked files: ${dirtiedTrackedFiles.join(', ')}`)
    exitCodes.push(1)
  }

  const verificationDigest = computeVerificationDigest({
    commands: executedCommands,
    exitCodes,
    outputLogs,
  })

  // Record result in SQLite
  const recorded = recordVerificationResult({
    taskRunId,
    command: executedCommands.join(' && '),
    exitCode: allPassed ? 0 : (exitCodes.find((c) => c !== 0) || 1),
    outputLog: outputLogs.join('\n---\n'),
    verificationDigest,
    environmentInfo: envInfo,
    passed: allPassed,
  }, targetDb)

  return {
    verificationId: recorded.id,
    passed: allPassed,
    exitCode: recorded.exit_code,
    outputLog: recorded.output_log,
    verificationDigest,
    dirtiedTrackedFiles,
  }
}

/**
 * Handle verification outcome: advance to Code Review if passed, or govern bounded repair loop if failed.
 */
export async function handleVerificationOutcome({
  taskId,
  projectId,
  taskRunId,
  verificationResult,
  onRepair = null,
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const task = getTask(taskId, targetDb)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  if (verificationResult.passed) {
    // Advanced to Code Review
    transitionTask(taskId, 'Code Review', {
      waitingReason: 'RUNNING_REVIEW',
      actor: 'verifier',
      automatic: true,
      details: { projectId, taskRunId, verificationDigest: verificationResult.verificationDigest },
    }, targetDb)

    recordAuditLog({
      projectId,
      taskId,
      eventType: 'VERIFICATION_PASSED',
      actor: 'verifier',
      details: { taskRunId, verificationDigest: verificationResult.verificationDigest },
    }, targetDb)

    return {
      outcome: 'ADVANCED_TO_REVIEW',
      task: getTask(taskId, targetDb),
    }
  }

  // Verification failed -> increment repair attempts
  const updatedTask = incrementTaskRepairAttempts(taskId, targetDb)

  if (updatedTask.repair_attempts >= updatedTask.max_repairs) {
    // Exceeded maximum allowed repair attempts -> Transition to Blocked
    transitionTask(taskId, 'Blocked', {
      blockedReason: 'REPAIR_LIMIT_EXCEEDED',
      actor: 'verifier',
      automatic: true,
      details: {
        projectId,
        taskRunId,
        repairAttempts: updatedTask.repair_attempts,
        maxRepairs: updatedTask.max_repairs,
        error: verificationResult.outputLog.slice(0, 500),
      },
    }, targetDb)

    recordAuditLog({
      projectId,
      taskId,
      eventType: 'REPAIR_LIMIT_EXCEEDED',
      actor: 'verifier',
      details: { repairAttempts: updatedTask.repair_attempts, maxRepairs: updatedTask.max_repairs },
    }, targetDb)

    return {
      outcome: 'BLOCKED_REPAIR_LIMIT',
      task: getTask(taskId, targetDb),
    }
  }

  // Return to In Progress for repair attempt
  transitionTask(taskId, 'In Progress', {
    waitingReason: null,
    blockedReason: null,
    actor: 'verifier',
    automatic: true,
    details: {
      projectId,
      taskRunId,
      repairAttempt: updatedTask.repair_attempts,
      maxRepairs: updatedTask.max_repairs,
    },
  }, targetDb)

  recordAuditLog({
    projectId,
    taskId,
    eventType: 'REPAIR_ATTEMPT_SCHEDULED',
    actor: 'verifier',
    details: { repairAttempt: updatedTask.repair_attempts, maxRepairs: updatedTask.max_repairs },
  }, targetDb)

  if (onRepair) {
    await onRepair({
      task: updatedTask,
      failureLog: verificationResult.outputLog,
      repairAttempt: updatedTask.repair_attempts,
    })
  }

  return {
    outcome: 'RETRY_REPAIR',
    task: getTask(taskId, targetDb),
    remainingRepairs: updatedTask.max_repairs - updatedTask.repair_attempts,
  }
}
