import {
  getBaseline, listTasks, listEpics, listSprints, createSprint,
} from '../../db/index.mjs'
import { decomposeBaseline } from '../../dag-scheduler.mjs'
import {
  decomposeBaselineHierarchical, decomposePRDViaLLM, getEpicProgress, assignTasksToSprint,
} from '../../epic-planner.mjs'
import { scheduleConcurrentTasks } from '../../swarm-coordinator.mjs'
import { readJson, json } from '../../http/shared.mjs'
import { broadcastOrchestratorEvent } from '../../http/event-bus.mjs'

export function registerPlanningRoutes(app, { db, workerPool, mergeQueue }) {
  app.post('/api/orchestrator/baselines/:baselineId/decompose', async (c) => {
    const body = await readJson(c)
    return json(c, decomposeBaseline({ baselineId: c.req.param('baselineId'), milestoneTitle: body.milestoneTitle || 'Milestone 1: Implementation', taskDefinitions: body.taskDefinitions || [] }, db), 201)
  })
  app.get('/api/orchestrator/milestones/:milestoneId/tasks', (c) => json(c, { tasks: listTasks(c.req.param('milestoneId'), db) }))
  app.get('/api/orchestrator/projects/:projectId/epics', (c) => {
    const epics = listEpics(c.req.param('projectId'), db).map((epic) => getEpicProgress(epic.id, db))
    return json(c, { epics })
  })
  app.get('/api/orchestrator/epics/:epicId/progress', (c) => json(c, { progress: getEpicProgress(c.req.param('epicId'), db) }))
  app.post('/api/orchestrator/baselines/:baselineId/decompose-hierarchical', async (c) => {
    const baselineId = c.req.param('baselineId'); const body = await readJson(c)
    const baseline = getBaseline(baselineId, db)
    const planned = body.epicsWithTasks?.length
      ? { milestoneTitle: body.milestoneTitle, epics: body.epicsWithTasks }
      : await decomposePRDViaLLM({ baselineId, specMarkdown: baseline?.spec_markdown, mockDecomposition: body.mockDecomposition || null, db })
    return json(c, decomposeBaselineHierarchical({ baselineId, projectId: body.projectId, milestoneTitle: planned.milestoneTitle || body.milestoneTitle || 'Milestone: Hierarchical Delivery', epicsWithTasks: planned.epics }, db), 201)
  })
  app.get('/api/orchestrator/projects/:projectId/sprints', (c) => json(c, { sprints: listSprints(c.req.param('projectId'), db) }))
  app.post('/api/orchestrator/projects/:projectId/sprints', async (c) => {
    const body = await readJson(c)
    const sprint = createSprint({ projectId: c.req.param('projectId'), name: body.name, goal: body.goal || '', startDate: body.startDate || Date.now(), endDate: body.endDate || Date.now() + 14 * 86400000, status: body.status || 'PLANNED' }, db)
    return json(c, { sprint }, 201)
  })
  app.post('/api/orchestrator/sprints/:sprintId/assign-tasks', async (c) => {
    const body = await readJson(c)
    return json(c, assignTasksToSprint(c.req.param('sprintId'), body.taskIds || [], db))
  })
  app.get('/api/orchestrator/swarm/metrics', (c) => json(c, { metrics: workerPool.getPoolMetrics(), mergeQueueLength: mergeQueue.queue.length, isMergeProcessing: mergeQueue.processing }))
  app.post('/api/orchestrator/milestones/:milestoneId/schedule-swarm', async (c) => {
    const milestoneId = c.req.param('milestoneId'); const body = await readJson(c)
    const tasks = listTasks(milestoneId, db)
    const result = scheduleConcurrentTasks({
      readyTasks: tasks.filter((task) => task.status === 'Ready'),
      activeTasks: tasks.filter((task) => ['In Progress', 'Automated Checks', 'Code Review'].includes(task.status)),
      maxConcurrency: body.maxConcurrency || workerPool.maxConcurrency,
    })
    broadcastOrchestratorEvent('swarm_scheduled', { milestoneId, scheduledCount: result.schedulableTasks.length, queuedCount: result.queuedTasks.length })
    return json(c, result)
  })
  app.post('/api/orchestrator/swarm/merge-queue/enqueue', async (c) => {
    const body = await readJson(c)
    const result = await mergeQueue.enqueue({ ...body, verificationCommands: body.verificationCommands || ['npm test'], acceptedBy: body.acceptedBy || 'owner' })
    broadcastOrchestratorEvent('task_integrated_via_queue', { taskId: body.taskId, rebased: result.rebased, integratedCommitSha: result.integratedCommitSha })
    return json(c, result)
  })
}
