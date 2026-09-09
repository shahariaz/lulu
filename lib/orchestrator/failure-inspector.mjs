import fs from 'node:fs'
import path from 'node:path'
import {
  getTask,
  updateTaskStatus,
  recordAuditLog,
  getVerificationResults,
  getActiveTaskRun,
  getOrchestratorDb,
} from './db/index.mjs'
import { assertPathWithinWorktree } from './security-boundary.mjs'
import { transitionTask } from './dag-scheduler.mjs'

/**
 * Parse raw test/build failure logs into structured error diagnostics.
 */
export function parseFailureDiagnostics(outputLog = '') {
  if (!outputLog || typeof outputLog !== 'string') {
    return {
      hasFailure: false,
      summary: 'No logs available.',
      failingFiles: [],
      assertionDiff: null,
      errorType: null,
      stackTrace: '',
    }
  }

  const lines = outputLog.split('\n')
  const failingFiles = new Set()
  let errorType = null
  let assertionDiff = null
  let summary = ''
  const stackLines = []

  // Regex patterns
  const fileLineRegex = /(?:at\s+|in\s+|^|\(|\/)([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?/g
  const assertionDiffRegex = /(?:Expected values to be strictly equal|Expected|actual|expected|diff):\s*([\s\S]+?)(?=\n\s*at|\n\s*$)/i
  const errorTypeRegex = /\b(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|Error|Panic|FAILED|CompilationError)\b[:\s]/

  for (const line of lines) {
    const trimmed = line.trim()

    // 1. Detect Error Type
    if (!errorType) {
      const typeMatch = trimmed.match(errorTypeRegex)
      if (typeMatch) errorType = typeMatch[1]
    }

    // 2. Detect Failing Files with Line Numbers
    let match
    while ((match = fileLineRegex.exec(trimmed)) !== null) {
      const filePath = match[1]
      const lineNum = parseInt(match[2], 10)
      if (!filePath.includes('node:internal') && !filePath.includes('node_modules')) {
        failingFiles.add(`${filePath}:${lineNum}`)
      }
    }

    // 3. Collect Stack Trace Lines
    if (trimmed.startsWith('at ') || trimmed.startsWith('in ')) {
      stackLines.push(trimmed)
    }

    // 4. Extract Summary
    if (!summary && (trimmed.startsWith('AssertionError') || trimmed.startsWith('Error:') || trimmed.includes('FAIL'))) {
      summary = trimmed.slice(0, 200)
    }
  }

  // Detect Assertion Diff Block
  const diffMatch = outputLog.match(assertionDiffRegex)
  if (diffMatch) {
    assertionDiff = diffMatch[1].trim().slice(0, 500)
  }

  return {
    hasFailure: true,
    summary: summary || errorType || 'Automated verification check failed',
    errorType: errorType || 'TestFailure',
    failingFiles: Array.from(failingFiles).slice(0, 10),
    assertionDiff,
    stackTrace: stackLines.slice(0, 15).join('\n'),
  }
}

/**
 * Inject owner guidance notes into a Blocked task, reset repair attempts,
 * and transition the task back to In Progress for worker remediation.
 */
export function injectOwnerGuidance({
  taskId,
  projectId,
  guidanceNotes,
  resetRepairs = true,
  actor = 'owner',
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const task = getTask(taskId, targetDb)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  if (!guidanceNotes || !guidanceNotes.trim()) {
    throw new Error('Guidance notes are required')
  }

  // If task is Blocked, transition back to In Progress
  let updatedTask = task
  if (task.status === 'Blocked' || task.status === 'Automated Checks' || task.status === 'Code Review') {
    updatedTask = transitionTask(taskId, 'In Progress', {
      waitingReason: null,
      blockedReason: null,
      actor,
      details: { guidanceNotes: guidanceNotes.trim(), resetRepairs },
    }, targetDb)
  }

  // Reset repair attempts so worker gets full attempts with owner guidance
  if (resetRepairs) {
    targetDb.prepare(`UPDATE tasks SET repair_attempts = 0 WHERE id = ?`).run(taskId)
    updatedTask = getTask(taskId, targetDb)
  }

  recordAuditLog({
    projectId: projectId || null,
    taskId,
    eventType: 'OWNER_GUIDANCE_INJECTED',
    actor,
    details: { guidanceNotes: guidanceNotes.trim(), resetRepairs },
  }, targetDb)

  return {
    success: true,
    task: updatedTask,
    guidanceNotes: guidanceNotes.trim(),
  }
}

/**
 * Apply a manual quick-fix edit directly to a worktree file from the browser UI.
 * Enforces strict worktree path confinement.
 */
export function applyWorktreeQuickFix({
  taskId,
  worktreePath,
  filePath,
  content,
  author = 'owner',
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const task = getTask(taskId, targetDb)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  const wtPath = worktreePath || task.worktree_path
  if (!wtPath || !fs.existsSync(wtPath)) {
    throw new Error(`Worktree path does not exist: ${wtPath}`)
  }

  // Enforce path confinement
  const canonicalTarget = assertPathWithinWorktree(filePath, wtPath)

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(canonicalTarget), { recursive: true })
  fs.writeFileSync(canonicalTarget, content, 'utf8')

  const bytesWritten = Buffer.byteLength(content, 'utf8')

  recordAuditLog({
    projectId: null,
    taskId,
    eventType: 'WORKTREE_QUICK_FIX_APPLIED',
    actor: author,
    details: { filePath, bytesWritten },
  }, targetDb)

  return {
    success: true,
    filePath,
    canonicalTarget,
    bytesWritten,
  }
}
