import {
  createMilestone,
  createEpic,
  getEpic,
  listEpics,
  updateEpicStatus,
  createSprint,
  getSprint,
  listSprints,
  createTask,
  getTask,
  listTasks,
  recordAuditLog,
  getBaseline,
  getOrchestratorDb,
} from './db/index.mjs'
import { resolveNextReadyTasks } from './dag-scheduler.mjs'

export const HIERARCHICAL_DECOMPOSITION_PROMPT = `You are the Lead Planning Architect for Claude-Zen.
Decompose the approved Product Requirements Document into a structured hierarchy of Epics and granular Tasks.

Rules for Hierarchical Planning:
1. Epics: Group requirements into major logical pillars (e.g. Data Layer, Core Services, API Routing, UI Components).
2. Tasks: Each task must be a bounded, testable unit of work assigned to an Epic.
3. Scope Paths: Explicitly declare the file paths each task is permitted to modify.
4. Linked Requirements: Explicitly link each task to one or more requirement IDs from the PRD (e.g. REQ-F-01).
5. Dependencies: Define blocked_by references (tasks can depend on tasks in the same epic or across epics).

Output must conform to:
{
  "milestoneTitle": "Milestone Name",
  "epics": [
    {
      "tempId": "epic_1",
      "title": "Epic Title",
      "description": "Epic Goal",
      "tasks": [
        {
          "tempId": "t1_1",
          "title": "Task Title",
          "description": "Task details",
          "scopePaths": ["src/path.js"],
          "linkedRequirementIds": ["REQ-F-01"],
          "blockedBy": []
        }
      ]
    }
  ]
}`

/**
 * Decompose an approved baseline into hierarchical Epics and dependency-linked Tasks.
 */
export function decomposeBaselineHierarchical({
  baselineId,
  projectId,
  milestoneTitle = 'Milestone: Hierarchical Delivery',
  epicsWithTasks = [],
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const baseline = getBaseline(baselineId, targetDb)
  if (!baseline) throw new Error(`Baseline not found: ${baselineId}`)

  if (baseline.status !== 'APPROVED') {
    throw new Error(`Cannot decompose unapproved baseline: ${baselineId}`)
  }

  // 1. Create Milestone
  const milestone = createMilestone({
    baselineId,
    title: milestoneTitle,
    orderIndex: 1,
  }, targetDb)

  const createdEpics = []
  const createdTasks = []
  const tempIdMap = new Map() // tempId -> database ID

  // 2. Create Epics
  for (let i = 0; i < epicsWithTasks.length; i++) {
    const epicDef = epicsWithTasks[i]
    const epic = createEpic({
      projectId: projectId || baseline.project_id,
      baselineId: baseline.id,
      title: epicDef.title,
      description: epicDef.description || '',
      orderIndex: i + 1,
      status: 'PLANNED',
    }, targetDb)

    if (epicDef.tempId) {
      tempIdMap.set(epicDef.tempId, epic.id)
    }
    createdEpics.push({ epic, taskDefs: epicDef.tasks || [] })
  }

  // 3. Create Tasks (Pass 1: Insert records)
  const pendingDependencyTasks = []

  for (const { epic, taskDefs } of createdEpics) {
    for (const tDef of taskDefs) {
      const task = createTask({
        milestoneId: milestone.id,
        title: tDef.title,
        description: tDef.description || '',
        scopePaths: tDef.scopePaths || tDef.scope_paths || [],
        status: 'Backlog',
        epicId: epic.id,
        sprintId: tDef.sprintId || null,
        linkedRequirementIds: tDef.linkedRequirementIds || tDef.linked_requirement_ids || [],
        maxRepairs: tDef.maxRepairs || 3,
      }, targetDb)

      if (tDef.tempId) {
        tempIdMap.set(tDef.tempId, task.id)
      }
      pendingDependencyTasks.push({
        task,
        rawBlockedBy: tDef.blockedBy || tDef.blocked_by || [],
      })
      createdTasks.push(task)
    }
  }

  // 4. Resolve Dependencies (Pass 2: Map temp IDs across epics to real database task IDs)
  for (const item of pendingDependencyTasks) {
    const realBlockedBy = item.rawBlockedBy.map((ref) => tempIdMap.get(ref) || ref)
    if (realBlockedBy.length > 0) {
      targetDb.prepare(`UPDATE tasks SET blocked_by_json = ? WHERE id = ?`).run(
        JSON.stringify(realBlockedBy),
        item.task.id
      )
      item.task.blocked_by = realBlockedBy
    }
  }

  // 5. Automatically unblock eligible initial tasks in the milestone
  resolveNextReadyTasks(milestone.id, targetDb)

  recordAuditLog({
    projectId: projectId || baseline.project_id,
    eventType: 'HIERARCHICAL_DECOMPOSITION_COMPLETED',
    actor: 'architect',
    details: {
      milestoneId: milestone.id,
      epicCount: createdEpics.length,
      taskCount: createdTasks.length,
    },
  }, targetDb)

  return {
    milestone,
    epics: listEpics(projectId || baseline.project_id, targetDb),
    tasks: listTasks(milestone.id, targetDb),
  }
}

/**
 * Calculate completion metrics and auto-update status for an Epic based on its child tasks.
 */
export function getEpicProgress(epicId, db = null) {
  const targetDb = db || getOrchestratorDb()
  const epic = getEpic(epicId, targetDb)
  if (!epic) throw new Error(`Epic not found: ${epicId}`)

  const tasks = targetDb.prepare(`SELECT * FROM tasks WHERE epic_id = ?`).all(epicId)
  const totalTasks = tasks.length
  if (totalTasks === 0) {
    return {
      epicId,
      title: epic.title,
      status: epic.status,
      totalTasks: 0,
      completedTasks: 0,
      progressPercentage: 0,
    }
  }

  const completed = tasks.filter((t) => t.status === 'Done').length
  const inProgress = tasks.filter((t) => ['In Progress', 'Automated Checks', 'Code Review', 'QA'].includes(t.status)).length
  const blocked = tasks.filter((t) => t.status === 'Blocked').length

  const progressPercentage = Math.round((completed / totalTasks) * 100)

  // Auto-update Epic status
  let newStatus = epic.status
  if (completed === totalTasks) {
    newStatus = 'COMPLETED'
  } else if (completed > 0 || inProgress > 0) {
    newStatus = 'IN_PROGRESS'
  }

  if (newStatus !== epic.status) {
    updateEpicStatus(epicId, newStatus, targetDb)
  }

  return {
    epicId,
    title: epic.title,
    status: newStatus,
    totalTasks,
    completedTasks: completed,
    inProgressTasks: inProgress,
    blockedTasks: blocked,
    progressPercentage,
  }
}

/**
 * Assign a batch of tasks to a specific sprint.
 */
export function assignTasksToSprint(sprintId, taskIds = [], db = null) {
  const targetDb = db || getOrchestratorDb()
  const sprint = getSprint(sprintId, targetDb)
  if (!sprint) throw new Error(`Sprint not found: ${sprintId}`)

  const stmt = targetDb.prepare(`UPDATE tasks SET sprint_id = ? WHERE id = ?`)
  for (const id of taskIds) {
    stmt.run(sprintId, id)
  }

  return {
    success: true,
    sprintId,
    assignedCount: taskIds.length,
  }
}
