import {
  getBaseline,
  getTask,
  listTasks,
  listMilestones,
  updateTaskStatus,
  recordAuditLog,
  getOrchestratorDb,
} from './db/index.mjs'
import { diffRequirementsBaselines } from './spec-diff.mjs'
import { broadcastOrchestratorEvent } from './api.mjs'

/**
 * Analyze the impact of a baseline change on existing tasks in a project.
 */
export function analyzeBaselineScopeImpact({
  projectId,
  previousBaselineId,
  newBaselineId,
}, db = null) {
  const targetDb = db || getOrchestratorDb()

  const prevBaseline = getBaseline(previousBaselineId, targetDb)
  if (!prevBaseline) throw new Error(`Previous baseline not found: ${previousBaselineId}`)

  const newBaseline = getBaseline(newBaselineId, targetDb)
  if (!newBaseline) throw new Error(`New baseline not found: ${newBaselineId}`)

  // 1. Calculate diff between specifications
  const diffResult = diffRequirementsBaselines(prevBaseline.spec_markdown, newBaseline.spec_markdown)

  const modifiedIds = new Set(diffResult.modified.map((m) => m.id))
  const removedIds = new Set(diffResult.removed.map((r) => r.id))
  const addedIds = new Set(diffResult.added.map((a) => a.id))

  // 2. Fetch all milestones and tasks for this project
  const milestones = listMilestones(prevBaseline.id, targetDb)
  const allTasks = []
  for (const m of milestones) {
    allTasks.push(...listTasks(m.id, targetDb))
  }

  const affectedTasks = []
  const unaffectedTasks = []
  const coveredRequirements = new Set()

  // 3. Map tasks against requirement deltas
  for (const task of allTasks) {
    const linked = task.linked_requirement_ids || []
    linked.forEach((r) => coveredRequirements.add(r))

    let isAffected = false
    let impactReason = null
    const matchedModified = linked.filter((r) => modifiedIds.has(r))
    const matchedRemoved = linked.filter((r) => removedIds.has(r))

    if (matchedRemoved.length > 0) {
      isAffected = true
      impactReason = `Requirement ${matchedRemoved.join(', ')} was removed`
    } else if (matchedModified.length > 0) {
      isAffected = true
      impactReason = `Requirement ${matchedModified.join(', ')} was modified`
    }

    if (isAffected) {
      affectedTasks.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        reason: impactReason,
        affectedRequirements: [...matchedRemoved, ...matchedModified],
      })
    } else {
      unaffectedTasks.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
      })
    }
  }

  // 4. Check for uncovered added requirements
  const uncoveredNewRequirements = diffResult.added.filter((a) => !coveredRequirements.has(a.id))

  return {
    hasImpact: affectedTasks.length > 0 || uncoveredNewRequirements.length > 0,
    previousBaselineVersion: prevBaseline.version,
    newBaselineVersion: newBaseline.version,
    diffStats: diffResult.stats,
    affectedTasks,
    unaffectedTasks,
    uncoveredNewRequirements: uncoveredNewRequirements.map((r) => ({ id: r.id, title: r.title })),
  }
}

/**
 * Apply scope impact to existing tasks:
 * Flags affected tasks with waiting_reason = 'REWORK_REQUIRED'
 * and records an audit log.
 */
export function applyScopeImpact({
  projectId,
  impactReport,
  actor = 'owner',
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const updatedTasks = []

  for (const item of impactReport.affectedTasks) {
    const task = getTask(item.taskId, targetDb)
    if (!task) continue

    // If task was Done or in review stages, flag with waiting_reason = 'REWORK_REQUIRED'
    const updated = updateTaskStatus(task.id, {
      status: task.status,
      waitingReason: 'REWORK_REQUIRED',
      blockedReason: task.status === 'Blocked' ? 'SCOPE_INVALIDATED' : task.blocked_reason,
    }, targetDb)

    updatedTasks.push(updated)
  }

  recordAuditLog({
    projectId: projectId || null,
    eventType: 'SCOPE_IMPACT_APPLIED',
    actor,
    details: {
      affectedCount: impactReport.affectedTasks.length,
      affectedTaskIds: impactReport.affectedTasks.map((t) => t.taskId),
      previousVersion: impactReport.previousBaselineVersion,
      newVersion: impactReport.newBaselineVersion,
    },
  }, targetDb)

  // Broadcast real-time SSE event to UI
  try {
    broadcastOrchestratorEvent('scope_invalidated', {
      projectId,
      affectedCount: impactReport.affectedTasks.length,
      affectedTaskIds: impactReport.affectedTasks.map((t) => t.taskId),
    })
  } catch {}

  return {
    success: true,
    affectedCount: updatedTasks.length,
    updatedTasks,
  }
}
