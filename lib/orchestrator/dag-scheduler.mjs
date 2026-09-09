import {
  createMilestone,
  createTask,
  getTask,
  listTasks,
  updateTaskStatus,
  recordAuditLog,
  getBaseline,
  getOrchestratorDb,
} from './db/index.mjs'

export const VALID_PRODUCT_STAGES = Object.freeze([
  'Backlog',
  'Ready',
  'In Progress',
  'Automated Checks',
  'Code Review',
  'QA',
  'Done',
  'Blocked',
  'Cancelled',
])

export const ALLOWED_TRANSITIONS = Object.freeze({
  Backlog: ['Ready', 'Blocked', 'Cancelled'],
  Ready: ['In Progress', 'Blocked', 'Cancelled'],
  'In Progress': ['Automated Checks', 'Blocked', 'Cancelled'],
  'Automated Checks': ['Code Review', 'In Progress', 'Blocked', 'Cancelled'],
  'Code Review': ['QA', 'In Progress', 'Blocked', 'Cancelled'],
  QA: ['Done', 'In Progress', 'Blocked', 'Cancelled'],
  Done: ['In Progress'], // Rework if explicitly requested by owner
  Blocked: ['Ready', 'In Progress', 'Backlog', 'Cancelled'],
  Cancelled: ['Backlog', 'Ready'], // Resuming cancelled work
})

export class IllegalStateTransitionError extends Error {
  constructor(taskId, fromStatus, toStatus, reason = '') {
    super(`Illegal task state transition for ${taskId}: '${fromStatus}' -> '${toStatus}'${reason ? ` (${reason})` : ''}`)
    this.name = 'IllegalStateTransitionError'
    this.taskId = taskId
    this.fromStatus = fromStatus
    this.toStatus = toStatus
  }
}

/**
 * Decompose an approved requirements baseline into a milestone and dependency-ordered tasks.
 */
export function decomposeBaseline({
  baselineId,
  milestoneTitle = 'Milestone 1: Implementation',
  orderIndex = 1,
  taskDefinitions = [],
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const baseline = getBaseline(baselineId, targetDb)
  if (!baseline) {
    throw new Error(`Baseline not found: ${baselineId}`)
  }

  if (baseline.status !== 'APPROVED') {
    throw new Error(`Cannot decompose unapproved baseline: ${baselineId} (status: ${baseline.status})`)
  }

  // Create Milestone
  const milestone = createMilestone({
    baselineId,
    title: milestoneTitle,
    orderIndex,
  }, targetDb)

  // Map of temporary/input IDs to created database task IDs
  const idMap = new Map()
  const createdTasks = []

  // Pass 1: Create all tasks
  for (const def of taskDefinitions) {
    const task = createTask({
      milestoneId: milestone.id,
      title: def.title,
      description: def.description || '',
      scopePaths: def.scopePaths || def.scope_paths || [],
      status: 'Backlog',
      maxRepairs: def.maxRepairs || def.max_repairs || 3,
    }, targetDb)

    if (def.tempId || def.id) {
      idMap.set(def.tempId || def.id, task.id)
    }
    createdTasks.push({ task, originalBlockedBy: def.blockedBy || def.blocked_by || [] })
  }

  // Pass 2: Resolve blocked_by dependencies to real database task IDs
  for (const item of createdTasks) {
    const realBlockedBy = item.originalBlockedBy.map((ref) => idMap.get(ref) || ref)
    if (realBlockedBy.length > 0) {
      targetDb.prepare(`
        UPDATE tasks SET blocked_by_json = ? WHERE id = ?
      `).run(JSON.stringify(realBlockedBy), item.task.id)
      item.task.blocked_by = realBlockedBy
    }
  }

  // Check which initial tasks have zero dependencies and can move to Ready
  resolveNextReadyTasks(milestone.id, targetDb)

  recordAuditLog({
    projectId: baseline.project_id,
    eventType: 'BASELINE_DECOMPOSED',
    actor: 'orchestrator',
    details: { milestoneId: milestone.id, taskCount: createdTasks.length },
  }, targetDb)

  return {
    milestone,
    tasks: listTasks(milestone.id, targetDb),
  }
}

/**
 * Check whether a task's dependencies in blocked_by are all Done.
 */
export function getTaskDependencyStatus(taskId, db = null) {
  const targetDb = db || getOrchestratorDb()
  const task = getTask(taskId, targetDb)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  const blockedBy = task.blocked_by || []
  if (blockedBy.length === 0) {
    return { isSatisfied: true, pendingDependencies: [] }
  }

  const pending = []
  for (const depId of blockedBy) {
    const depTask = getTask(depId, targetDb)
    if (!depTask || depTask.status !== 'Done') {
      pending.push({
        id: depId,
        title: depTask ? depTask.title : 'Unknown Task',
        status: depTask ? depTask.status : 'Missing',
      })
    }
  }

  return {
    isSatisfied: pending.length === 0,
    pendingDependencies: pending,
  }
}

/**
 * Scan all tasks in a milestone, resolve dependencies, and advance eligible Backlog tasks to Ready.
 */
export function resolveNextReadyTasks(milestoneId, db = null) {
  const targetDb = db || getOrchestratorDb()
  const tasks = listTasks(milestoneId, targetDb)
  const unblocked = []

  for (const task of tasks) {
    if (task.status === 'Backlog') {
      const depStatus = getTaskDependencyStatus(task.id, targetDb)
      if (depStatus.isSatisfied) {
        updateTaskStatus(task.id, {
          status: 'Ready',
          waitingReason: null,
          blockedReason: null,
        }, targetDb)
        unblocked.push(task.id)
      }
    }
  }

  return unblocked
}

/**
 * Verify whether a project currently has an active writer task in progress.
 * Enforces sequential execution (one active writer per project).
 */
export function isProjectWorkspaceLocked(projectId, db = null) {
  const targetDb = db || getOrchestratorDb()
  const activeTask = targetDb.prepare(`
    SELECT t.id, t.title, t.status
    FROM tasks t
    JOIN milestones m ON m.id = t.milestone_id
    JOIN requirements_baselines b ON b.id = m.baseline_id
    WHERE b.project_id = ? AND t.status IN ('In Progress', 'Automated Checks', 'Code Review')
    LIMIT 1
  `).get(projectId)

  return activeTask || null
}

/**
 * Transition a task to In Progress if no other task is actively writing to the workspace.
 */
export function claimTaskForExecution(taskId, projectId, db = null) {
  const targetDb = db || getOrchestratorDb()
  const task = getTask(taskId, targetDb)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  if (task.status !== 'Ready') {
    throw new IllegalStateTransitionError(taskId, task.status, 'In Progress', 'Task must be in Ready status to be claimed')
  }

  // Enforce single active writer rule
  const lockedBy = isProjectWorkspaceLocked(projectId, targetDb)
  if (lockedBy && lockedBy.id !== taskId) {
    throw new Error(`Project workspace is locked by active task ${lockedBy.id} (${lockedBy.title}) in status '${lockedBy.status}'`)
  }

  return updateTaskStatus(taskId, {
    status: 'In Progress',
    waitingReason: null,
    blockedReason: null,
  }, targetDb)
}

/**
 * Transition a task through the deterministic state machine.
 * Validates allowed transitions, sets waiting/blocked reasons, and logs audits.
 */
export function transitionTask(taskId, targetStatus, {
  waitingReason = null,
  blockedReason = null,
  actor = 'orchestrator',
  details = {},
} = {}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const task = getTask(taskId, targetDb)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  if (!VALID_PRODUCT_STAGES.includes(targetStatus)) {
    throw new Error(`Invalid target product stage: '${targetStatus}'`)
  }

  if (task.status !== targetStatus) {
    const allowed = ALLOWED_TRANSITIONS[task.status] || []
    if (!allowed.includes(targetStatus)) {
      throw new IllegalStateTransitionError(taskId, task.status, targetStatus)
    }
  }

  // Update task status and reasons
  const updated = updateTaskStatus(taskId, {
    status: targetStatus,
    waitingReason,
    blockedReason,
  }, targetDb)

  // If a task reached Done, check if downstream tasks in its milestone can now be unblocked!
  if (targetStatus === 'Done') {
    resolveNextReadyTasks(task.milestone_id, targetDb)
  }

  recordAuditLog({
    projectId: details.projectId || null,
    taskId,
    eventType: 'TASK_TRANSITIONED',
    actor,
    details: {
      fromStatus: task.status,
      toStatus: targetStatus,
      waitingReason,
      blockedReason,
      ...details,
    },
  }, targetDb)

  return updated
}
