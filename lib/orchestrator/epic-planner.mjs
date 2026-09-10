import {
  createMilestone,
  createEpic,
  createFeature,
  getEpic,
  listEpics,
  listProjectFeatures,
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
import { parseRequirementsMap } from './spec-diff.mjs'
import { callGatewayForText, GatewayUnavailableError } from './gateway-errors.mjs'

export const HIERARCHICAL_DECOMPOSITION_PROMPT = `You are the Lead Planning Architect for Claude-Zen.
Decompose the approved Product Requirements Document into a structured hierarchy of Epics, Features, and granular Tasks.

Rules for Hierarchical Planning:
1. Epics: Group requirements into major logical pillars (e.g. Data Layer, Core Services, API Routing, UI Components).
2. Features: Group related user-visible behavior inside each Epic. Give each feature independently verifiable acceptance criteria.
3. Tasks: Each task must be a bounded, testable unit of work assigned to a Feature.
4. Scope Paths: Explicitly declare the file paths each task is permitted to modify.
5. Linked Requirements: Link every Feature and Task only to requirement IDs that exist verbatim in the PRD.
6. Acceptance Criteria: Carry concrete Given/When/Then or equivalently checkable criteria onto every Feature and Task.
7. Dependencies: Define blockedBy using task tempIds; dependencies may cross features and epics.

Output must conform to:
{
  "milestoneTitle": "Milestone Name",
  "epics": [
    {
      "tempId": "epic_1",
      "title": "Epic Title",
      "description": "Epic Goal",
      "features": [{
        "tempId": "feature_1",
        "title": "Feature Title",
        "description": "User-visible outcome",
        "acceptanceCriteria": ["Given ..., when ..., then ..."],
        "linkedRequirementIds": ["REQ-F-01"],
        "tasks": [{
          "tempId": "t1_1",
          "title": "Task Title",
          "description": "Task details",
          "scopePaths": ["src/path.js"],
          "acceptanceCriteria": ["Given ..., when ..., then ..."],
          "linkedRequirementIds": ["REQ-F-01"],
          "blockedBy": []
        }]
      }]
    }
  ]
}`

/** `truncation` (from callGatewayForText) turns a bare parse failure into a budget diagnosis. */
function parseDecompositionJson(text, gatewayUrl, truncation = null) {
  const trimmed = String(text || '').trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  const candidate = fence?.[1] || (first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed)
  try {
    return JSON.parse(candidate)
  } catch (err) {
    const budgetNote = truncation?.likely
      ? ` The response was almost certainly truncated by the token budget — ${truncation.reason}.`
        + ' Raise ZEN_DECOMPOSITION_MAX_TOKENS; it is shared between reasoning and output.'
      : ''
    throw new GatewayUnavailableError(`Planning gateway returned malformed JSON: ${err.message}.${budgetNote}`, { gatewayUrl, cause: err })
  }
}

function validateLinkedRequirementIds(decomposition, requirementIds) {
  if (!decomposition || !Array.isArray(decomposition.epics) || decomposition.epics.length === 0) {
    throw new Error('Decomposition must contain at least one epic')
  }
  const seenTempIds = new Set()
  for (const epic of decomposition.epics) {
    if (!epic?.title || !Array.isArray(epic.features) || epic.features.length === 0) {
      throw new Error(`Epic ${epic?.title || '<untitled>'} must contain features`)
    }
    for (const feature of epic.features) {
      if (!feature?.title || !Array.isArray(feature.acceptanceCriteria) || feature.acceptanceCriteria.length === 0) {
        throw new Error(`Feature ${feature?.title || '<untitled>'} needs acceptance criteria`)
      }
      for (const id of feature.linkedRequirementIds || []) {
        if (!requirementIds.has(id)) throw new Error(`Feature ${feature.title} references unknown requirement ${id}`)
      }
      if (!Array.isArray(feature.tasks) || feature.tasks.length === 0) throw new Error(`Feature ${feature.title} must contain tasks`)
      for (const task of feature.tasks) {
        if (!task?.tempId || seenTempIds.has(task.tempId)) throw new Error(`Task tempId is missing or duplicated: ${task?.tempId || '<missing>'}`)
        seenTempIds.add(task.tempId)
        if (!task.title || !Array.isArray(task.scopePaths) || task.scopePaths.length === 0) throw new Error(`Task ${task.tempId} needs a title and scopePaths`)
        if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) throw new Error(`Task ${task.tempId} needs acceptance criteria`)
        if (!Array.isArray(task.linkedRequirementIds) || task.linkedRequirementIds.length === 0) throw new Error(`Task ${task.tempId} must link requirements`)
        for (const id of task.linkedRequirementIds) {
          if (!requirementIds.has(id)) throw new Error(`Task ${task.tempId} references unknown requirement ${id}`)
        }
      }
    }
  }
  for (const epic of decomposition.epics) {
    for (const feature of epic.features) {
      for (const task of feature.tasks) {
        for (const dependency of task.blockedBy || []) {
          if (!seenTempIds.has(dependency)) throw new Error(`Task ${task.tempId} depends on unknown tempId ${dependency}`)
        }
      }
    }
  }
  return decomposition
}

export async function decomposePRDViaLLM({
  baselineId,
  specMarkdown,
  gatewayUrl = process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788',
  model = process.env.ZEN_ARCHITECT_MODEL || 'gemini-3.8-flash-tiered',
  gatewayRunner = null,
  mockDecomposition = null,
  db = null,
}) {
  const targetDb = db || getOrchestratorDb()
  const baseline = getBaseline(baselineId, targetDb)
  if (!baseline) throw new Error(`Baseline not found: ${baselineId}`)
  if (baseline.status !== 'APPROVED') throw new Error(`Cannot decompose unapproved baseline: ${baselineId}`)
  const markdown = specMarkdown || baseline.spec_markdown
  const requirementIds = new Set(parseRequirementsMap(markdown).keys())
  if (requirementIds.size === 0) throw new Error('Approved PRD contains no parseable REQ-* identifiers')

  let candidate = mockDecomposition
  if (!candidate) {
    const messages = [{ role: 'user', content: `Approved PRD:\n\n${markdown}\n\nReturn only the required JSON decomposition.` }]
    const response = gatewayRunner
      ? await gatewayRunner({ gatewayUrl, model, system: HIERARCHICAL_DECOMPOSITION_PROMPT, messages })
      // Shares max_tokens with reasoning — see the note in council-engine.mjs. A full
      // epic/feature/task decomposition is large; 8192 truncates it mid-structure.
      : await callGatewayForText({ gatewayUrl, model, system: HIERARCHICAL_DECOMPOSITION_PROMPT, messages, maxTokens: Number(process.env.ZEN_DECOMPOSITION_MAX_TOKENS || 32000) })
    candidate = typeof response === 'string' ? parseDecompositionJson(response, gatewayUrl) :
      response?.text ? parseDecompositionJson(response.text, gatewayUrl, response.truncation) : response
  }

  try {
    return validateLinkedRequirementIds(candidate, requirementIds)
  } catch (err) {
    throw new GatewayUnavailableError(`PRD decomposition was unusable: ${err.message}`, { gatewayUrl, cause: err })
  }
}

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
  const createdFeatures = []
  const createdTasks = []
  const tempIdMap = new Map() // tempId -> database ID
  const validRequirementIds = new Set(parseRequirementsMap(baseline.spec_markdown).keys())

  const assertKnownRequirements = (ids, owner) => {
    for (const id of ids || []) {
      if (!validRequirementIds.has(id)) throw new Error(`${owner} references unknown requirement ${id}`)
    }
  }

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
    const featureDefs = Array.isArray(epicDef.features) && epicDef.features.length > 0
      ? epicDef.features
      : [{
          title: epicDef.title,
          description: epicDef.description || '',
          acceptanceCriteria: epicDef.acceptanceCriteria || [],
          linkedRequirementIds: epicDef.linkedRequirementIds || [],
          tasks: epicDef.tasks || [],
        }]
    createdEpics.push({ epic, featureDefs })
  }

  // 3. Create Features and Tasks (Pass 1: Insert records)
  const pendingDependencyTasks = []

  for (const { epic, featureDefs } of createdEpics) {
    for (let featureIndex = 0; featureIndex < featureDefs.length; featureIndex++) {
      const featureDef = featureDefs[featureIndex]
      const featureRequirementIds = featureDef.linkedRequirementIds || featureDef.linked_requirement_ids || []
      assertKnownRequirements(featureRequirementIds, `Feature ${featureDef.title}`)
      const feature = createFeature({
        epicId: epic.id,
        projectId: projectId || baseline.project_id,
        title: featureDef.title,
        description: featureDef.description || '',
        acceptanceCriteria: featureDef.acceptanceCriteria || featureDef.acceptance_criteria || [],
        linkedRequirementIds: featureRequirementIds,
        orderIndex: featureDef.orderIndex || featureIndex + 1,
      }, targetDb)
      if (featureDef.tempId) tempIdMap.set(featureDef.tempId, feature.id)
      createdFeatures.push(feature)

      for (const tDef of featureDef.tasks || []) {
        const taskRequirementIds = tDef.linkedRequirementIds || tDef.linked_requirement_ids || []
        assertKnownRequirements(taskRequirementIds, `Task ${tDef.tempId || tDef.title}`)
        const task = createTask({
          milestoneId: milestone.id,
          title: tDef.title,
          description: tDef.description || '',
          scopePaths: tDef.scopePaths || tDef.scope_paths || [],
          status: 'Backlog',
          epicId: epic.id,
          featureId: feature.id,
          sprintId: tDef.sprintId || null,
          acceptanceCriteria: tDef.acceptanceCriteria || tDef.acceptance_criteria || feature.acceptance_criteria,
          linkedRequirementIds: taskRequirementIds,
          maxRepairs: tDef.maxRepairs || 3,
        }, targetDb)

        if (tDef.tempId) tempIdMap.set(tDef.tempId, task.id)
        pendingDependencyTasks.push({
          task,
          rawBlockedBy: tDef.blockedBy || tDef.blocked_by || [],
        })
        createdTasks.push(task)
      }
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
      featureCount: createdFeatures.length,
      taskCount: createdTasks.length,
    },
  }, targetDb)

  return {
    milestone,
    epics: listEpics(projectId || baseline.project_id, targetDb),
    features: listProjectFeatures(projectId || baseline.project_id, targetDb),
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
