import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  getOrchestratorDb,
  closeOrchestratorDb,
  createProject,
  createBaseline,
  approveBaseline,
  getTask,
  updateTaskStatus,
  createSprint,
} from '../lib/orchestrator/db/index.mjs'
import {
  decomposeBaselineHierarchical,
  decomposePRDViaLLM,
  getEpicProgress,
  assignTasksToSprint,
  HIERARCHICAL_DECOMPOSITION_PROMPT,
} from '../lib/orchestrator/epic-planner.mjs'
import { transitionTask } from '../lib/orchestrator/dag-scheduler.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-epicplan-test-'))
  return path.join(tmpDir, 'test-epicplan.sqlite')
}

test('decomposeBaselineHierarchical creates epics, tasks, and resolves cross-epic dependencies', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'Epic Platform', repoPath: '/tmp/epic-platform' }, db)

  const baseline = createBaseline({
    projectId: project.id,
    specMarkdown: '# PRD: Microservices Platform\n- REQ-F-01: Auth\n- REQ-F-02: Billing',
    contentDigest: 'sha256:d1',
    status: 'APPROVED',
  }, db)

  const result = decomposeBaselineHierarchical({
    baselineId: baseline.id,
    projectId: project.id,
    milestoneTitle: 'Milestone 1: Service Mesh',
    epicsWithTasks: [
      {
        tempId: 'epic_auth',
        title: 'Epic 1: Authentication & Identity',
        description: 'User sessions and tokens',
        tasks: [
          {
            tempId: 't_auth_1',
            title: 'Task 1.1: Token Generator',
            scopePaths: ['src/auth/token.js'],
            linkedRequirementIds: ['REQ-F-01'],
            blockedBy: [],
          },
        ],
      },
      {
        tempId: 'epic_billing',
        title: 'Epic 2: Invoicing & Billing',
        description: 'Payment collection',
        tasks: [
          {
            tempId: 't_bill_1',
            title: 'Task 2.1: Payment Gateway',
            scopePaths: ['src/billing/pay.js'],
            linkedRequirementIds: ['REQ-F-02'],
            blockedBy: ['t_auth_1'], // Cross-epic dependency!
          },
        ],
      },
    ],
  }, db)

  assert.equal(result.epics.length, 2)
  assert.equal(result.tasks.length, 2)

  const authEpic = result.epics.find((e) => e.title.includes('Epic 1'))
  const billEpic = result.epics.find((e) => e.title.includes('Epic 2'))

  const task1 = result.tasks.find((t) => t.title.includes('Task 1.1'))
  const task2 = result.tasks.find((t) => t.title.includes('Task 2.1'))

  assert.equal(task1.epic_id, authEpic.id)
  assert.equal(task2.epic_id, billEpic.id)
  assert.deepEqual(task1.linked_requirement_ids, ['REQ-F-01'])
  assert.deepEqual(task2.linked_requirement_ids, ['REQ-F-02'])

  // Task 1 had no dependencies -> automatically Ready
  assert.equal(task1.status, 'Ready')

  // Task 2 depends on Task 1 -> Backlog
  assert.equal(task2.status, 'Backlog')
  assert.deepEqual(task2.blocked_by, [task1.id])

  closeOrchestratorDb()
})

test('getEpicProgress tracks completion percentage and auto-updates epic status', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'Progress App', repoPath: '/tmp/prog-app' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)

  const { epics, tasks } = decomposeBaselineHierarchical({
    baselineId: baseline.id,
    projectId: project.id,
    epicsWithTasks: [
      {
        tempId: 'e1',
        title: 'Core Epic',
        tasks: [
          { tempId: 't1', title: 'Task A', blockedBy: [] },
          { tempId: 't2', title: 'Task B', blockedBy: [] },
        ],
      },
    ],
  }, db)

  const epicId = epics[0].id
  const [taskA, taskB] = tasks

  // Initially: 0% complete, PLANNED
  let prog = getEpicProgress(epicId, db)
  assert.equal(prog.totalTasks, 2)
  assert.equal(prog.completedTasks, 0)
  assert.equal(prog.progressPercentage, 0)
  assert.equal(prog.status, 'PLANNED')

  // Advance Task A to Done
  transitionTask(taskA.id, 'In Progress', {}, db)
  transitionTask(taskA.id, 'Automated Checks', {}, db)
  transitionTask(taskA.id, 'Code Review', {}, db)
  transitionTask(taskA.id, 'QA', {}, db)
  transitionTask(taskA.id, 'Done', {}, db)

  // 1 out of 2 completed: 50%, IN_PROGRESS
  prog = getEpicProgress(epicId, db)
  assert.equal(prog.completedTasks, 1)
  assert.equal(prog.progressPercentage, 50)
  assert.equal(prog.status, 'IN_PROGRESS')

  // Advance Task B to Done
  transitionTask(taskB.id, 'In Progress', {}, db)
  transitionTask(taskB.id, 'Automated Checks', {}, db)
  transitionTask(taskB.id, 'Code Review', {}, db)
  transitionTask(taskB.id, 'QA', {}, db)
  transitionTask(taskB.id, 'Done', {}, db)

  // 2 out of 2 completed: 100%, COMPLETED
  prog = getEpicProgress(epicId, db)
  assert.equal(prog.completedTasks, 2)
  assert.equal(prog.progressPercentage, 100)
  assert.equal(prog.status, 'COMPLETED')

  closeOrchestratorDb()
})

test('assignTasksToSprint links tasks to sprint cleanly', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'Sprint App', repoPath: '/tmp/sprint-app' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)

  const { tasks } = decomposeBaselineHierarchical({
    baselineId: baseline.id,
    projectId: project.id,
    epicsWithTasks: [
      {
        title: 'E1',
        tasks: [
          { title: 'Task X', blockedBy: [] },
          { title: 'Task Y', blockedBy: [] },
        ],
      },
    ],
  }, db)

  const sprint = createSprint({
    projectId: project.id,
    name: 'Sprint 101',
    status: 'ACTIVE',
  }, db)

  const result = assignTasksToSprint(sprint.id, [tasks[0].id, tasks[1].id], db)
  assert.equal(result.success, true)
  assert.equal(result.assignedCount, 2)

  const tX = getTask(tasks[0].id, db)
  const tY = getTask(tasks[1].id, db)
  assert.equal(tX.sprint_id, sprint.id)
  assert.equal(tY.sprint_id, sprint.id)

  closeOrchestratorDb()
})

test('decomposePRDViaLLM preserves real requirements and feature acceptance criteria', async () => {
  const db = getOrchestratorDb(getTempDbPath())
  const project = createProject({ name: 'Structured Plan', repoPath: '/tmp/structured-plan' }, db)
  const baseline = createBaseline({
    projectId: project.id,
    specMarkdown: '# PRD\n### REQ-F-01 Event ingestion\nAccept valid events.\n### REQ-NF-01 Isolation\nRun checks without egress.',
    contentDigest: 'sha256:structured', status: 'APPROVED',
  }, db)
  const candidate = {
    milestoneTitle: 'Evidence foundation',
    epics: [{ tempId: 'epic_1', title: 'Evidence', features: [{
      tempId: 'feature_1', title: 'Safe ingestion', description: 'Ingest isolated evidence',
      acceptanceCriteria: ['Given a valid event, when submitted, then it is stored.'],
      linkedRequirementIds: ['REQ-F-01', 'REQ-NF-01'],
      tasks: [{
        tempId: 'task_1', title: 'Implement ingestion', description: 'Create the bounded handler',
        scopePaths: ['src/events.mjs'],
        acceptanceCriteria: ['Given valid input, when handled, then a durable ID is returned.'],
        linkedRequirementIds: ['REQ-F-01'], blockedBy: [],
      }],
    }]}],
  }

  const plan = await decomposePRDViaLLM({ baselineId: baseline.id, mockDecomposition: candidate, db })
  const result = decomposeBaselineHierarchical({
    baselineId: baseline.id, projectId: project.id,
    milestoneTitle: plan.milestoneTitle, epicsWithTasks: plan.epics,
  }, db)
  assert.equal(result.features.length, 1)
  assert.deepEqual(result.features[0].linked_requirement_ids, ['REQ-F-01', 'REQ-NF-01'])
  assert.deepEqual(result.tasks[0].acceptance_criteria, candidate.epics[0].features[0].tasks[0].acceptanceCriteria)
  assert.equal(result.tasks[0].feature_id, result.features[0].id)
  closeOrchestratorDb()
})

test('decomposePRDViaLLM fails closed on invented requirement IDs', async () => {
  const db = getOrchestratorDb(getTempDbPath())
  const project = createProject({ name: 'Strict Plan', repoPath: '/tmp/strict-plan' }, db)
  const baseline = createBaseline({
    projectId: project.id, specMarkdown: '# PRD\n### REQ-F-01 Real requirement\nDo the real work.',
    contentDigest: 'sha256:strict', status: 'APPROVED',
  }, db)
  await assert.rejects(() => decomposePRDViaLLM({
    baselineId: baseline.id,
    mockDecomposition: {
      epics: [{ title: 'Epic', features: [{
        title: 'Feature', acceptanceCriteria: ['It works'], linkedRequirementIds: ['REQ-F-99'],
        tasks: [{ tempId: 'task_1', title: 'Task', scopePaths: ['src/x.mjs'], acceptanceCriteria: ['It passes'], linkedRequirementIds: ['REQ-F-99'], blockedBy: [] }],
      }]}],
    }, db,
  }), /unknown requirement REQ-F-99/)
  closeOrchestratorDb()
})
