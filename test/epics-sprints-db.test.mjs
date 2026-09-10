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
  createMilestone,
  createEpic,
  getEpic,
  listEpics,
  updateEpicStatus,
  createSprint,
  getSprint,
  listSprints,
  updateSprintStatus,
  createFeature,
  getFeature,
  listFeatures,
  listProjectFeatures,
  updateFeatureStatus,
  createTask,
  getTask,
  listTasks,
} from '../lib/orchestrator/db/index.mjs'
import { SqliteStorageRepository } from '../lib/orchestrator/db/repository.mjs'
import { getAppliedMigrations } from '../lib/orchestrator/db/migration-runner.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-epic-test-'))
  return path.join(tmpDir, 'test-epics.sqlite')
}

test('Migrations through 005 apply cleanly and record in schema_migrations', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)

  const applied = getAppliedMigrations(db)
  assert.equal(applied.length, 5)
  assert.equal(applied[0].version, 1)
  assert.equal(applied[1].version, 2)
  assert.equal(applied[1].name, 'epics_and_sprints')
  assert.equal(applied[2].name, 'features_and_acceptance')
  assert.equal(applied[3].name, 'conversations')
  assert.equal(applied[4].name, 'autonomy')

  closeOrchestratorDb()
})

test('Features and acceptance criteria round-trip and cascade with their epic', () => {
  const db = getOrchestratorDb(getTempDbPath())
  const project = createProject({ name: 'Feature App', repoPath: '/tmp/feature-app' }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: '# PRD\n### REQ-F-01: Search', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)
  const epic = createEpic({ projectId: project.id, baselineId: baseline.id, title: 'Discovery' }, db)
  const feature = createFeature({
    epicId: epic.id, projectId: project.id, title: 'Search records',
    acceptanceCriteria: ['Given records, when a query is entered, then matching records appear.'],
    linkedRequirementIds: ['REQ-F-01'],
  }, db)
  const task = createTask({
    milestoneId: milestone.id, epicId: epic.id, featureId: feature.id, title: 'Build search index',
    acceptanceCriteria: ['The index returns an exact-title match.'], linkedRequirementIds: ['REQ-F-01'],
  }, db)

  assert.deepEqual(getFeature(feature.id, db).acceptance_criteria, feature.acceptance_criteria)
  assert.deepEqual(getTask(task.id, db).acceptance_criteria, ['The index returns an exact-title match.'])
  assert.equal(listFeatures(epic.id, db).length, 1)
  assert.equal(listProjectFeatures(project.id, db).length, 1)
  assert.equal(updateFeatureStatus(feature.id, 'IN_PROGRESS', db).status, 'IN_PROGRESS')

  db.prepare('DELETE FROM epics WHERE id = ?').run(epic.id)
  assert.equal(getFeature(feature.id, db), null)
  assert.equal(getTask(task.id, db).feature_id, null)
  closeOrchestratorDb()
})

test('Epics and Sprints CRUD operations and task linkages', () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)

  const project = createProject({ name: 'Epic App', repoPath: '/tmp/epic-app' }, db)
  const baseline = createBaseline({
    projectId: project.id,
    specMarkdown: '# Epic PRD',
    contentDigest: 'sha256:d1',
    status: 'APPROVED',
  }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)

  // 1. Create Epic
  const epic1 = createEpic({
    projectId: project.id,
    baselineId: baseline.id,
    title: 'Epic 1: Auth & User Identity',
    description: 'OAuth and token management',
    orderIndex: 1,
    status: 'PLANNED',
  }, db)

  assert.ok(epic1.id.startsWith('epic_'))
  assert.equal(epic1.title, 'Epic 1: Auth & User Identity')
  assert.equal(epic1.status, 'PLANNED')

  // Update Epic Status
  const updatedEpic = updateEpicStatus(epic1.id, 'IN_PROGRESS', db)
  assert.equal(updatedEpic.status, 'IN_PROGRESS')

  const epics = listEpics(project.id, db)
  assert.equal(epics.length, 1)

  // 2. Create Sprint
  const sprint1 = createSprint({
    projectId: project.id,
    name: 'Sprint 1 - Foundation',
    goal: 'Ship core auth and tokens',
    startDate: Date.now(),
    endDate: Date.now() + 14 * 86400000,
    status: 'ACTIVE',
  }, db)

  assert.ok(sprint1.id.startsWith('sprint_'))
  assert.equal(sprint1.name, 'Sprint 1 - Foundation')
  assert.equal(sprint1.status, 'ACTIVE')

  const sprints = listSprints(project.id, db)
  assert.equal(sprints.length, 1)

  // 3. Create Task with Epic, Sprint, and Linked Requirements
  const task = createTask({
    milestoneId: milestone.id,
    title: 'Task 1.1: OAuth PKCE Handler',
    description: 'Implement Google PKCE handshake',
    scopePaths: ['src/auth/oauth.js'],
    status: 'Ready',
    epicId: epic1.id,
    sprintId: sprint1.id,
    linkedRequirementIds: ['REQ-F-01', 'REQ-F-02'],
  }, db)

  assert.ok(task.id)
  assert.equal(task.epic_id, epic1.id)
  assert.equal(task.sprint_id, sprint1.id)
  assert.deepEqual(task.linked_requirement_ids, ['REQ-F-01', 'REQ-F-02'])

  const fetchedTask = getTask(task.id, db)
  assert.equal(fetchedTask.epic_id, epic1.id)
  assert.deepEqual(fetchedTask.linked_requirement_ids, ['REQ-F-01', 'REQ-F-02'])

  closeOrchestratorDb()
})

test('SqliteStorageRepository supports epics and sprints abstract methods', async () => {
  const dbPath = getTempDbPath()
  const storage = new SqliteStorageRepository(dbPath)

  const project = await storage.createProject({ name: 'Storage App', repoPath: '/tmp/storage-app' })

  const epic = await storage.createEpic({
    projectId: project.id,
    title: 'Storage Epic',
    status: 'PLANNED',
  })
  assert.ok(epic.id)

  const epics = await storage.listEpics(project.id)
  assert.equal(epics.length, 1)

  const sprint = await storage.createSprint({
    projectId: project.id,
    name: 'Storage Sprint',
    status: 'PLANNED',
  })
  assert.ok(sprint.id)

  const sprints = await storage.listSprints(project.id)
  assert.equal(sprints.length, 1)

  closeOrchestratorDb()
})
