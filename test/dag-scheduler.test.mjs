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
  updateProjectAutonomyMode,
} from '../lib/orchestrator/db/index.mjs'
import {
  decomposeBaseline,
  getTaskDependencyStatus,
  resolveNextReadyTasks,
  claimTaskForExecution,
  isProjectWorkspaceLocked,
  transitionTask,
  IllegalStateTransitionError,
  VALID_PRODUCT_STAGES,
  isTransitionAutoAllowed,
} from '../lib/orchestrator/dag-scheduler.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-dag-test-'))
  return path.join(tmpDir, 'test-dag.sqlite')
}

test('VALID_PRODUCT_STAGES preserves all 9 visible product stages', () => {
  const expected = [
    'Backlog', 'Ready', 'In Progress', 'Automated Checks',
    'Code Review', 'QA', 'Done', 'Blocked', 'Cancelled'
  ]
  assert.deepEqual(Array.from(VALID_PRODUCT_STAGES), expected)
})

test('autonomy policy changes only the owner-click boundaries', () => {
  assert.equal(isTransitionAutoAllowed('GUIDED', 'Ready', 'In Progress'), false)
  assert.equal(isTransitionAutoAllowed('SUPERVISED', 'Ready', 'In Progress'), true)
  assert.equal(isTransitionAutoAllowed('GUIDED', 'Automated Checks', 'Code Review'), true)
  assert.equal(isTransitionAutoAllowed('SUPERVISED', 'QA', 'Done'), false)
  assert.equal(isTransitionAutoAllowed('AUTONOMOUS', 'QA', 'Done'), true)
  assert.equal(isTransitionAutoAllowed('UNKNOWN', 'Code Review', 'QA'), false)
})

test('automatic transitions enforce the persisted project autonomy mode', () => {
  const db = getOrchestratorDb(getTempDbPath())
  const project = createProject({ name: 'Policy App', repoPath: '/tmp/policy-app' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'policy', status: 'APPROVED' }, db)
  const { tasks } = decomposeBaseline({ baselineId: baseline.id, taskDefinitions: [{ tempId: 't1', title: 'Policy task' }] }, db)
  const taskId = tasks[0].id

  assert.throws(
    () => transitionTask(taskId, 'In Progress', { automatic: true }, db),
    /GUIDED mode requires owner approval/,
  )
  updateProjectAutonomyMode(project.id, 'SUPERVISED', db)
  transitionTask(taskId, 'In Progress', { automatic: true }, db)
  transitionTask(taskId, 'Automated Checks', { automatic: true }, db)
  transitionTask(taskId, 'Code Review', { automatic: true }, db)
  transitionTask(taskId, 'QA', { automatic: true }, db)
  assert.throws(
    () => transitionTask(taskId, 'Done', { automatic: true }, db),
    /SUPERVISED mode requires owner approval/,
  )
  updateProjectAutonomyMode(project.id, 'AUTONOMOUS', db)
  assert.equal(transitionTask(taskId, 'Done', { automatic: true }, db).status, 'Done')
  closeOrchestratorDb()
})

test('decomposeBaseline parses tasks and unblocks zero-dependency tasks', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'App', repoPath: '/tmp/app' }, db)

  const baseline = createBaseline({
    projectId: project.id,
    specMarkdown: 'spec',
    contentDigest: 'sha256:123',
    status: 'DRAFT',
  }, db)
  approveBaseline(baseline.id, 'owner', db)

  const result = decomposeBaseline({
    baselineId: baseline.id,
    milestoneTitle: 'M1: Foundations',
    taskDefinitions: [
      { tempId: 't1', title: 'Task 1: Core Setup', scopePaths: ['src/core.js'], blockedBy: [] },
      { tempId: 't2', title: 'Task 2: API Endpoints', scopePaths: ['src/api.js'], blockedBy: ['t1'] },
      { tempId: 't3', title: 'Task 3: Integration', scopePaths: ['src/main.js'], blockedBy: ['t2'] },
    ],
  }, db)

  assert.equal(result.tasks.length, 3)

  // Task 1 had no dependencies -> immediately Ready
  const t1 = result.tasks.find((t) => t.title.includes('Task 1'))
  assert.equal(t1.status, 'Ready')
  assert.deepEqual(t1.blocked_by, [])

  // Task 2 depends on Task 1 -> Backlog
  const t2 = result.tasks.find((t) => t.title.includes('Task 2'))
  assert.equal(t2.status, 'Backlog')
  assert.deepEqual(t2.blocked_by, [t1.id])

  // Task 3 depends on Task 2 -> Backlog
  const t3 = result.tasks.find((t) => t.title.includes('Task 3'))
  assert.equal(t3.status, 'Backlog')
  assert.deepEqual(t3.blocked_by, [t2.id])

  closeOrchestratorDb()
})

test('State transitions follow strict 9-stage lifecycle and reject illegal jumps', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'App', repoPath: '/tmp/app' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)

  const { tasks } = decomposeBaseline({
    baselineId: baseline.id,
    taskDefinitions: [
      { tempId: 't1', title: 'Task 1', blockedBy: [] }
    ],
  }, db)

  const taskId = tasks[0].id
  assert.equal(tasks[0].status, 'Ready')

  // Illegal jump: Ready -> Done directly
  assert.throws(() => {
    transitionTask(taskId, 'Done', {}, db)
  }, (err) => err instanceof IllegalStateTransitionError)

  // Illegal jump: Ready -> QA directly
  assert.throws(() => {
    transitionTask(taskId, 'QA', {}, db)
  }, (err) => err instanceof IllegalStateTransitionError)

  // Valid lifecycle progression:
  // 1. Ready -> In Progress
  let current = transitionTask(taskId, 'In Progress', {}, db)
  assert.equal(current.status, 'In Progress')

  // 2. In Progress -> Automated Checks
  current = transitionTask(taskId, 'Automated Checks', { waitingReason: 'RUNNING_VERIFICATION' }, db)
  assert.equal(current.status, 'Automated Checks')
  assert.equal(current.waiting_reason, 'RUNNING_VERIFICATION')

  // 3. Automated Checks -> Code Review
  current = transitionTask(taskId, 'Code Review', { waitingReason: 'RUNNING_REVIEW' }, db)
  assert.equal(current.status, 'Code Review')

  // 4. Code Review -> QA (Specialist Approved)
  current = transitionTask(taskId, 'QA', { waitingReason: 'AWAITING_OWNER_ACCEPTANCE' }, db)
  assert.equal(current.status, 'QA')

  // 5. QA -> Done (Owner Accepted)
  current = transitionTask(taskId, 'Done', {}, db)
  assert.equal(current.status, 'Done')

  closeOrchestratorDb()
})

test('Dependency unblocking cascades down the DAG when prerequisite reaches Done', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'App', repoPath: '/tmp/app' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)

  const { tasks } = decomposeBaseline({
    baselineId: baseline.id,
    taskDefinitions: [
      { tempId: 'step1', title: 'Step 1: Prerequisite', blockedBy: [] },
      { tempId: 'step2', title: 'Step 2: Downstream', blockedBy: ['step1'] },
    ],
  }, db)

  const step1 = tasks.find((t) => t.title.includes('Step 1'))
  const step2 = tasks.find((t) => t.title.includes('Step 2'))

  assert.equal(step1.status, 'Ready')
  assert.equal(step2.status, 'Backlog')

  // Dependency status for step2
  const depStatus = getTaskDependencyStatus(step2.id, db)
  assert.equal(depStatus.isSatisfied, false)
  assert.equal(depStatus.pendingDependencies.length, 1)
  assert.equal(depStatus.pendingDependencies[0].id, step1.id)

  // Advance step1 through lifecycle to Done
  transitionTask(step1.id, 'In Progress', {}, db)
  transitionTask(step1.id, 'Automated Checks', {}, db)
  transitionTask(step1.id, 'Code Review', {}, db)
  transitionTask(step1.id, 'QA', {}, db)

  // Step 2 is still Backlog before step1 is Done
  assert.equal(getTask(step2.id, db).status, 'Backlog')

  // Final transition of step1 to Done
  transitionTask(step1.id, 'Done', {}, db)

  // Verify step2 has been automatically unblocked to Ready!
  const updatedStep2 = getTask(step2.id, db)
  assert.equal(updatedStep2.status, 'Ready')

  closeOrchestratorDb()
})

test('Single active writer rule locks workspace to prevent concurrent writers', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const project = createProject({ name: 'App', repoPath: '/tmp/app' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)

  const { tasks } = decomposeBaseline({
    baselineId: baseline.id,
    taskDefinitions: [
      { tempId: 'taskA', title: 'Task A (Parallel candidate 1)', blockedBy: [] },
      { tempId: 'taskB', title: 'Task B (Parallel candidate 2)', blockedBy: [] },
    ],
  }, db)

  const taskA = tasks[0]
  const taskB = tasks[1]

  // Both are Ready because neither has dependencies
  assert.equal(taskA.status, 'Ready')
  assert.equal(taskB.status, 'Ready')

  // Initially workspace is not locked
  assert.equal(isProjectWorkspaceLocked(project.id, db), null)

  // Claim Task A for execution
  claimTaskForExecution(taskA.id, project.id, db)
  assert.equal(getTask(taskA.id, db).status, 'In Progress')

  // Workspace is now locked by Task A
  const lock = isProjectWorkspaceLocked(project.id, db)
  assert.ok(lock)
  assert.equal(lock.id, taskA.id)

  // Attempting to claim Task B must be rejected!
  assert.throws(() => {
    claimTaskForExecution(taskB.id, project.id, db)
  }, /Project workspace is locked by active task/)

  // Task B remains in Ready
  assert.equal(getTask(taskB.id, db).status, 'Ready')

  // Complete Task A through to Done
  transitionTask(taskA.id, 'Automated Checks', {}, db)
  transitionTask(taskA.id, 'Code Review', {}, db)
  transitionTask(taskA.id, 'QA', {}, db)
  transitionTask(taskA.id, 'Done', {}, db)

  // Workspace is unlocked
  assert.equal(isProjectWorkspaceLocked(project.id, db), null)

  // Now Task B can be claimed!
  claimTaskForExecution(taskB.id, project.id, db)
  assert.equal(getTask(taskB.id, db).status, 'In Progress')

  closeOrchestratorDb()
})

/**
 * The autonomy dial must be enforced on the REAL claim path, not just as a pure function.
 *
 * `claimTaskForExecution` previously called `updateTaskStatus` directly, so
 * `isTransitionAutoAllowed` was exercised only by unit tests while `/claim` bypassed it. That
 * made GUIDED indistinguishable from SUPERVISED as soon as anything dispatched work without a
 * human click — which is exactly what the worker-pool / swarm work will do.
 */
test('an automatic claim respects the project autonomy mode', () => {
  const db = getOrchestratorDb(getTempDbPath())
  const project = createProject({ name: 'Autonomy', repoPath: '/tmp/autonomy' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)

  const { tasks } = decomposeBaseline({
    baselineId: baseline.id,
    taskDefinitions: [
      { tempId: 'a', title: 'First task', blockedBy: [] },
      { tempId: 'b', title: 'Second task', blockedBy: [] },
    ],
  }, db)
  const [first, second] = tasks

  // GUIDED is the default: the orchestrator may not start work on its own.
  assert.throws(
    () => claimTaskForExecution(first.id, project.id, db, { automatic: true }),
    /GUIDED mode requires owner approval/,
  )
  assert.equal(getTask(first.id, db).status, 'Ready', 'a refused claim must not move the task')

  // An owner-initiated claim is still allowed in GUIDED.
  assert.equal(claimTaskForExecution(first.id, project.id, db).status, 'In Progress')

  // SUPERVISED: the orchestrator may start work by itself.
  updateProjectAutonomyMode(project.id, 'SUPERVISED', db)
  transitionTask(first.id, 'Blocked', { actor: 'test' }, db)

  assert.equal(
    claimTaskForExecution(second.id, project.id, db, { automatic: true }).status,
    'In Progress',
  )

  closeOrchestratorDb()
})

test('a claim refused by the workspace lock leaves no partial state', () => {
  const db = getOrchestratorDb(getTempDbPath())
  const project = createProject({ name: 'Lock', repoPath: '/tmp/lock' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)

  const { tasks } = decomposeBaseline({
    baselineId: baseline.id,
    taskDefinitions: [
      { tempId: 'a', title: 'First', blockedBy: [] },
      { tempId: 'b', title: 'Second', blockedBy: [] },
    ],
  }, db)
  const [first, second] = tasks

  claimTaskForExecution(first.id, project.id, db)

  // Single-active-writer: the second claim is refused, and must not half-apply. The lock check
  // and the status write are now one transaction, so there is no window where both succeed.
  assert.throws(() => claimTaskForExecution(second.id, project.id, db), /workspace is locked/)
  assert.equal(getTask(second.id, db).status, 'Ready')
  assert.equal(getTask(first.id, db).status, 'In Progress')

  closeOrchestratorDb()
})
