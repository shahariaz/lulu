import http from 'node:http'
import { URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import {
  getOrchestratorDb,
  createProject,
  getProject,
  listProjects,
  createBaseline,
  getBaseline,
  getApprovedBaseline,
  listMilestones,
  getTask,
  listTasks,
  createEpic,
  getEpic,
  listEpics,
  updateEpicStatus,
  createSprint,
  getSprint,
  listSprints,
  updateSprintStatus,
  createTaskRun,
  completeTaskRun,
  getTaskRun,
  getActiveTaskRun,
  getVerificationResults,
  getReviewRecords,
  getAcceptanceRecord,
  recordAcceptance,
  recordAuditLog,
} from './db/index.mjs'
import {
  inspectRepository,
  createFeatureBranch,
  provisionTaskWorktree,
  integrateTaskCommit,
  teardownTaskWorktree,
  runGit,
} from './git-workspace.mjs'
import {
  startSpecConversation,
  addSpecMessage,
  getSpecConversation,
  createDraftBaseline,
  approveBaselineVersion,
} from './spec-engine.mjs'
import {
  decomposeBaseline,
  claimTaskForExecution,
  transitionTask,
  resolveNextReadyTasks,
} from './dag-scheduler.mjs'
import { executeWorkerTask } from './worker-harness.mjs'
import { runVerificationChecks, handleVerificationOutcome } from './verifier-engine.mjs'
import { runSpecialistReview } from './review-engine.mjs'
import { startPreviewServer, stopPreviewServer, getPreviewStatus } from './preview-manager.mjs'
import {
  decomposeBaselineHierarchical,
  getEpicProgress,
  assignTasksToSprint,
} from './epic-planner.mjs'
import {
  diffRequirementsBaselines,
  generateSpecificationChangelog,
} from './spec-diff.mjs'
import {
  analyzeBaselineScopeImpact,
  applyScopeImpact,
} from './impact-analyzer.mjs'
import { scheduleConcurrentTasks } from './swarm-coordinator.mjs'
import { ConflictFreeMergeQueue } from './merge-queue.mjs'
import { WorkerPoolManager } from './worker-pool.mjs'
import { renderDeliveryAppHtml } from './ui/app-html.mjs'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// Active Server-Sent Event (SSE) clients
const activeSseClients = new Set()

// Active Swarm Worker Pool & Merge Queue (Milestone 4)
const defaultWorkerPool = new WorkerPoolManager({ maxConcurrency: 3 })
const defaultMergeQueue = new ConflictFreeMergeQueue()

/**
 * Broadcast an event to all connected UI clients.
 */
export function broadcastOrchestratorEvent(eventType, data = {}) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
  for (const client of activeSseClients) {
    try {
      client.write(payload)
    } catch {
      activeSseClients.delete(client)
    }
  }
}

/**
 * Read request body JSON helper.
 */
export async function readJsonBody(req) {
  let data = ''
  for await (const chunk of req) {
    data += chunk
  }
  if (!data.trim()) return {}
  try {
    return JSON.parse(data)
  } catch {
    throw new Error('Invalid JSON payload')
  }
}

/**
 * Send JSON response helper.
 */
export function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/**
 * Create the Orchestrator HTTP Request Handler.
 */
export function createOrchestratorHandler({ db = null } = {}) {
  const targetDb = db || getOrchestratorDb()
  defaultMergeQueue.db = targetDb

  return async function handleOrchestratorRequest(req, res) {
    const parsedUrl = new URL(req.url, 'http://127.0.0.1')
    const { pathname } = parsedUrl

    // Origin check for security
    const origin = req.headers.origin
    if (origin && !origin.includes('127.0.0.1') && !origin.includes('localhost')) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Origin not allowed' }))
    }

    try {
      // -------------------------------------------------------------
      // Real-time Server-Sent Events (SSE) Event Stream
      // -------------------------------------------------------------
      if (req.method === 'GET' && pathname === '/api/orchestrator/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`)
        activeSseClients.add(res)

        const keepAlive = setInterval(() => {
          try {
            res.write(': keepalive\n\n')
          } catch {
            clearInterval(keepAlive)
          }
        }, 15000)
        keepAlive.unref?.()

        req.on('close', () => {
          clearInterval(keepAlive)
          activeSseClients.delete(res)
        })
        return
      }

      // -------------------------------------------------------------
      // Static Asset Serving & SPA Fallback
      // -------------------------------------------------------------
      const staticDirs = [
        process.env.ZEN_STATIC_DIR,
        path.join(import.meta.dirname, '../../dist'),
        path.join(import.meta.dirname, '../../web/dist'),
      ].filter(Boolean)

      const staticDir = staticDirs.find((d) => fs.existsSync(d)) || null

      if (staticDir && req.method === 'GET' && !pathname.startsWith('/api/')) {
        const cleanPath = pathname === '/' ? '/index.html' : pathname
        const filePath = path.join(staticDir, cleanPath)
        const ext = path.extname(filePath).toLowerCase()

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const contentType = MIME_TYPES[ext] || 'application/octet-stream'
          res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' })
          return fs.createReadStream(filePath).pipe(res)
        }

        // SPA Fallback: serve index.html for client-side routes
        const indexPath = path.join(staticDir, 'index.html')
        if (fs.existsSync(indexPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          return fs.createReadStream(indexPath).pipe(res)
        }
      }

      // Fallback UI Delivery View
      if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/delivery' || pathname === '/orchestrator')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        if (req.method === 'HEAD') return res.end()
        return res.end(renderDeliveryAppHtml())
      }

      // -------------------------------------------------------------
      // 1. Projects
      // -------------------------------------------------------------
      if (req.method === 'POST' && pathname === '/api/orchestrator/projects') {
        const body = await readJsonBody(req)
        const { repoPath, name, forceDirty = false } = body
        if (!repoPath) throw new Error('repoPath is required')

        const inspection = inspectRepository(repoPath)
        if (!inspection.isClean && !forceDirty) {
          return sendJson(res, 400, {
            error: 'Repository working tree contains uncommitted changes.',
            uncommittedFiles: inspection.uncommittedFiles,
          })
        }

        const project = createProject({
          name: name || path.basename(path.resolve(repoPath)),
          repoPath: inspection.repoPath,
          activeBranch: inspection.currentBranch,
        }, targetDb)

        return sendJson(res, 201, { project, inspection })
      }

      if (req.method === 'GET' && pathname === '/api/orchestrator/projects') {
        const projects = listProjects(targetDb)
        return sendJson(res, 200, { projects })
      }

      const projMatch = pathname.match(/^\/api\/orchestrator\/projects\/([^/]+)$/)
      if (req.method === 'GET' && projMatch) {
        const project = getProject(projMatch[1], targetDb)
        if (!project) return sendJson(res, 404, { error: 'Project not found' })
        const inspection = inspectRepository(project.repo_path)
        const baseline = getApprovedBaseline(project.id, targetDb)
        return sendJson(res, 200, { project, inspection, activeBaseline: baseline })
      }

      // -------------------------------------------------------------
      // 2. Scoping & Baselines
      // -------------------------------------------------------------
      const scopeStartMatch = pathname.match(/^\/api\/orchestrator\/projects\/([^/]+)\/scoping\/start$/)
      if (req.method === 'POST' && scopeStartMatch) {
        const projectId = scopeStartMatch[1]
        const body = await readJsonBody(req)
        const session = startSpecConversation({
          projectId,
          featureTitle: body.featureTitle || 'New Feature',
          initialPrompt: body.initialPrompt || '',
        })
        return sendJson(res, 200, { session })
      }

      const scopeMsgMatch = pathname.match(/^\/api\/orchestrator\/scoping\/([^/]+)\/message$/)
      if (req.method === 'POST' && scopeMsgMatch) {
        const conversationId = scopeMsgMatch[1]
        const body = await readJsonBody(req)
        const session = addSpecMessage(conversationId, {
          role: body.role || 'user',
          content: body.content,
        })
        return sendJson(res, 200, { session })
      }

      const draftBaseMatch = pathname.match(/^\/api\/orchestrator\/projects\/([^/]+)\/baselines\/draft$/)
      if (req.method === 'POST' && draftBaseMatch) {
        const projectId = draftBaseMatch[1]
        const body = await readJsonBody(req)
        const draft = createDraftBaseline({
          projectId,
          specMarkdown: body.specMarkdown,
          version: body.version || 'v1.0.0',
        }, targetDb)
        return sendJson(res, 201, { draft })
      }

      const approveBaseMatch = pathname.match(/^\/api\/orchestrator\/baselines\/([^/]+)\/approve$/)
      if (req.method === 'POST' && approveBaseMatch) {
        const baselineId = approveBaseMatch[1]
        const body = await readJsonBody(req)
        const approved = approveBaselineVersion({
          baselineId,
          approvedBy: body.approvedBy || 'owner',
        }, targetDb)
        return sendJson(res, 200, { approved })
      }

      // -------------------------------------------------------------
      // 3. Task Decomposition & Schedulers
      // -------------------------------------------------------------
      const decomposeMatch = pathname.match(/^\/api\/orchestrator\/baselines\/([^/]+)\/decompose$/)
      if (req.method === 'POST' && decomposeMatch) {
        const baselineId = decomposeMatch[1]
        const body = await readJsonBody(req)
        const result = decomposeBaseline({
          baselineId,
          milestoneTitle: body.milestoneTitle || 'Milestone 1: Implementation',
          taskDefinitions: body.taskDefinitions || [],
        }, targetDb)
        return sendJson(res, 201, result)
      }

      const tasksMatch = pathname.match(/^\/api\/orchestrator\/milestones\/([^/]+)\/tasks$/)
      if (req.method === 'GET' && tasksMatch) {
        const milestoneId = tasksMatch[1]
        const tasks = listTasks(milestoneId, targetDb)
        return sendJson(res, 200, { tasks })
      }

      // -------------------------------------------------------------
      // Epics, Hierarchical Planning & Sprints (Milestone 3)
      // -------------------------------------------------------------
      const projEpicsMatch = pathname.match(/^\/api\/orchestrator\/projects\/([^/]+)\/epics$/)
      if (req.method === 'GET' && projEpicsMatch) {
        const projectId = projEpicsMatch[1]
        const epics = listEpics(projectId, targetDb)
        const epicsWithProgress = epics.map((e) => getEpicProgress(e.id, targetDb))
        return sendJson(res, 200, { epics: epicsWithProgress })
      }

      const epicProgressMatch = pathname.match(/^\/api\/orchestrator\/epics\/([^/]+)\/progress$/)
      if (req.method === 'GET' && epicProgressMatch) {
        const epicId = epicProgressMatch[1]
        const progress = getEpicProgress(epicId, targetDb)
        return sendJson(res, 200, { progress })
      }

      const decompHierMatch = pathname.match(/^\/api\/orchestrator\/baselines\/([^/]+)\/decompose-hierarchical$/)
      if (req.method === 'POST' && decompHierMatch) {
        const baselineId = decompHierMatch[1]
        const body = await readJsonBody(req)
        const result = decomposeBaselineHierarchical({
          baselineId,
          projectId: body.projectId,
          milestoneTitle: body.milestoneTitle || 'Milestone: Hierarchical Delivery',
          epicsWithTasks: body.epicsWithTasks || [],
        }, targetDb)
        return sendJson(res, 201, result)
      }

      const projSprintsMatch = pathname.match(/^\/api\/orchestrator\/projects\/([^/]+)\/sprints$/)
      if (req.method === 'GET' && projSprintsMatch) {
        const projectId = projSprintsMatch[1]
        const sprints = listSprints(projectId, targetDb)
        return sendJson(res, 200, { sprints })
      }

      if (req.method === 'POST' && projSprintsMatch) {
        const projectId = projSprintsMatch[1]
        const body = await readJsonBody(req)
        const sprint = createSprint({
          projectId,
          name: body.name,
          goal: body.goal || '',
          startDate: body.startDate || Date.now(),
          endDate: body.endDate || (Date.now() + 14 * 86400000),
          status: body.status || 'PLANNED',
        }, targetDb)
        return sendJson(res, 201, { sprint })
      }

      const assignSprintMatch = pathname.match(/^\/api\/orchestrator\/sprints\/([^/]+)\/assign-tasks$/)
      if (req.method === 'POST' && assignSprintMatch) {
        const sprintId = assignSprintMatch[1]
        const body = await readJsonBody(req)
        const result = assignTasksToSprint(sprintId, body.taskIds || [], targetDb)
        return sendJson(res, 200, result)
      }

      // -------------------------------------------------------------
      // Requirements Version Diffing & Scope Impact (Milestone 3)
      // -------------------------------------------------------------
      const diffBasesMatch = pathname.match(/^\/api\/orchestrator\/baselines\/([^/]+)\/diff\/([^/]+)$/)
      if (req.method === 'GET' && diffBasesMatch) {
        const baseId1 = diffBasesMatch[1]
        const baseId2 = diffBasesMatch[2]
        const b1 = getBaseline(baseId1, targetDb)
        const b2 = getBaseline(baseId2, targetDb)
        if (!b1 || !b2) return sendJson(res, 404, { error: 'One or both baselines not found' })

        const diffResult = diffRequirementsBaselines(b1.spec_markdown, b2.spec_markdown)
        const changelog = generateSpecificationChangelog({
          versionFrom: b1.version,
          versionTo: b2.version,
          diffResult,
        })
        return sendJson(res, 200, { diffResult, changelog })
      }

      if (req.method === 'POST' && pathname === '/api/orchestrator/baselines/scope-impact') {
        const body = await readJsonBody(req)
        const report = analyzeBaselineScopeImpact({
          projectId: body.projectId,
          previousBaselineId: body.previousBaselineId,
          newBaselineId: body.newBaselineId,
        }, targetDb)
        return sendJson(res, 200, { report })
      }

      if (req.method === 'POST' && pathname === '/api/orchestrator/baselines/apply-impact') {
        const body = await readJsonBody(req)
        const result = applyScopeImpact({
          projectId: body.projectId,
          impactReport: body.impactReport,
          actor: body.actor || 'owner',
        }, targetDb)
        return sendJson(res, 200, result)
      }

      // -------------------------------------------------------------
      // Parallel Swarms & Concurrency (Milestone 4)
      // -------------------------------------------------------------
      if (req.method === 'GET' && pathname === '/api/orchestrator/swarm/metrics') {
        const metrics = defaultWorkerPool.getPoolMetrics()
        return sendJson(res, 200, {
          metrics,
          mergeQueueLength: defaultMergeQueue.queue.length,
          isMergeProcessing: defaultMergeQueue.processing,
        })
      }

      const swarmSchedMatch = pathname.match(/^\/api\/orchestrator\/milestones\/([^/]+)\/schedule-swarm$/)
      if (req.method === 'POST' && swarmSchedMatch) {
        const milestoneId = swarmSchedMatch[1]
        const body = await readJsonBody(req)
        const tasks = listTasks(milestoneId, targetDb)
        const readyTasks = tasks.filter((t) => t.status === 'Ready')
        const activeTasks = tasks.filter((t) => ['In Progress', 'Automated Checks', 'Code Review'].includes(t.status))

        const scheduleResult = scheduleConcurrentTasks({
          readyTasks,
          activeTasks,
          maxConcurrency: body.maxConcurrency || defaultWorkerPool.maxConcurrency,
        })

        broadcastOrchestratorEvent('swarm_scheduled', {
          milestoneId,
          scheduledCount: scheduleResult.schedulableTasks.length,
          queuedCount: scheduleResult.queuedTasks.length,
        })

        return sendJson(res, 200, scheduleResult)
      }

      if (req.method === 'POST' && pathname === '/api/orchestrator/swarm/merge-queue/enqueue') {
        const body = await readJsonBody(req)
        const result = await defaultMergeQueue.enqueue({
          taskId: body.taskId,
          projectId: body.projectId,
          repoPath: body.repoPath,
          featureBranch: body.featureBranch,
          worktreePath: body.worktreePath,
          candidateCommitSha: body.candidateCommitSha,
          verificationCommands: body.verificationCommands || ['npm test'],
          acceptedBy: body.acceptedBy || 'owner',
        })

        broadcastOrchestratorEvent('task_integrated_via_queue', {
          taskId: body.taskId,
          rebased: result.rebased,
          integratedCommitSha: result.integratedCommitSha,
        })

        return sendJson(res, 200, result)
      }

      // -------------------------------------------------------------
      // 4. Task Execution Lifecycle Endpoints
      // -------------------------------------------------------------
      const claimTaskMatch = pathname.match(/^\/api\/orchestrator\/tasks\/([^/]+)\/claim$/)
      if (req.method === 'POST' && claimTaskMatch) {
        const taskId = claimTaskMatch[1]
        const body = await readJsonBody(req)
        const task = getTask(taskId, targetDb)
        if (!task) return sendJson(res, 404, { error: 'Task not found' })

        const project = getProject(body.projectId, targetDb)
        if (!project) return sendJson(res, 404, { error: 'Project not found' })

        // Create feature branch if not present
        const featureSlug = body.featureSlug || `feat-${taskId}`
        createFeatureBranch(project.repo_path, featureSlug)

        // Provision isolated worktree
        const { worktreePath } = provisionTaskWorktree(project.repo_path, `zen/${featureSlug}`, taskId)

        // Claim task in state machine
        const claimed = claimTaskForExecution(taskId, project.id, targetDb)

        // Save worktree path on task
        targetDb.prepare(`UPDATE tasks SET worktree_path = ? WHERE id = ?`).run(worktreePath, taskId)

        broadcastOrchestratorEvent('task_claimed', { taskId, projectId: project.id, status: 'In Progress' })

        return sendJson(res, 200, {
          task: claimed,
          worktreePath,
          featureBranch: `zen/${featureSlug}`,
        })
      }

      const executeWorkerMatch = pathname.match(/^\/api\/orchestrator\/tasks\/([^/]+)\/execute$/)
      if (req.method === 'POST' && executeWorkerMatch) {
        const taskId = executeWorkerMatch[1]
        const body = await readJsonBody(req)
        const task = getTask(taskId, targetDb)
        if (!task) return sendJson(res, 404, { error: 'Task not found' })

        const worktreePath = body.worktreePath || task.worktree_path
        if (worktreePath && !task.worktree_path) {
          targetDb.prepare(`UPDATE tasks SET worktree_path = ? WHERE id = ?`).run(worktreePath, taskId)
        }

        let mockAction = null
        if (Array.isArray(body.mockFiles)) {
          mockAction = async ({ worktreePath: wt }) => {
            for (const f of body.mockFiles) {
              const fullPath = path.join(wt, f.path)
              fs.mkdirSync(path.dirname(fullPath), { recursive: true })
              fs.writeFileSync(fullPath, f.content || '', 'utf8')
            }
          }
        }

        if (task.status === 'Ready') {
          transitionTask(taskId, 'In Progress', { actor: 'worker' }, targetDb)
        }

        const workerResult = await executeWorkerTask({
          taskId,
          projectId: body.projectId,
          worktreePath,
          scopePaths: task.scope_paths,
          mockAction,
        }, targetDb)

        // Advance task to Automated Checks
        transitionTask(taskId, 'Automated Checks', {
          waitingReason: 'RUNNING_VERIFICATION',
          actor: 'worker',
        }, targetDb)

        broadcastOrchestratorEvent('worker_completed', { taskId, candidateCommitSha: workerResult.candidateCommitSha, status: 'Automated Checks' })

        return sendJson(res, 200, { workerResult, task: getTask(taskId, targetDb) })
      }

      const verifyMatch = pathname.match(/^\/api\/orchestrator\/tasks\/([^/]+)\/verify$/)
      if (req.method === 'POST' && verifyMatch) {
        const taskId = verifyMatch[1]
        const body = await readJsonBody(req)
        const task = getTask(taskId, targetDb)
        if (!task) return sendJson(res, 404, { error: 'Task not found' })

        // Create a task run record with kind: 'VERIFICATION'
        const verifRun = createTaskRun({
          taskId,
          kind: 'VERIFICATION',
          role: 'VERIFIER',
        }, targetDb)

        const verifResult = await runVerificationChecks({
          taskRunId: verifRun.id,
          worktreePath: task.worktree_path,
          checkCommands: body.checkCommands || ['npm test'],
        }, targetDb)

        completeTaskRun(verifRun.id, {
          status: verifResult.passed ? 'SUCCEEDED' : 'FAILED',
        }, targetDb)

        const outcome = await handleVerificationOutcome({
          taskId,
          projectId: body.projectId,
          taskRunId: verifRun.id,
          verificationResult: verifResult,
        }, targetDb)

        broadcastOrchestratorEvent('verification_completed', { taskId, passed: verifResult.passed, exitCode: verifResult.exitCode, outcome: outcome.outcome })

        return sendJson(res, 200, { verifResult, outcome })
      }

      const reviewMatch = pathname.match(/^\/api\/orchestrator\/tasks\/([^/]+)\/review$/)
      if (req.method === 'POST' && reviewMatch) {
        const taskId = reviewMatch[1]
        const body = await readJsonBody(req)
        const task = getTask(taskId, targetDb)
        if (!task) return sendJson(res, 404, { error: 'Task not found' })

        // Create a task run record with kind: 'REVIEW'
        const reviewRun = createTaskRun({
          taskId,
          kind: 'REVIEW',
          role: 'REVIEWER',
          model: body.model || 'specialist-strong',
          provider: body.provider || 'codex',
        }, targetDb)

        let reviewRunner = body.reviewRunner || null
        if (body.mockReview) {
          reviewRunner = async () => body.mockReview
        }

        const reviewResult = await runSpecialistReview({
          taskId,
          projectId: body.projectId,
          taskRunId: reviewRun.id,
          worktreePath: task.worktree_path,
          baseCommitSha: body.baseCommitSha || runGit(task.worktree_path, ['rev-parse', 'HEAD~1']),
          candidateCommitSha: body.candidateCommitSha || runGit(task.worktree_path, ['rev-parse', 'HEAD']),
          verificationDigest: body.verificationDigest || 'sha256:verified',
          reviewRunner,
        }, targetDb)

        completeTaskRun(reviewRun.id, {
          status: 'SUCCEEDED',
        }, targetDb)

        broadcastOrchestratorEvent('review_completed', { taskId, verdict: reviewResult.reviewRecord.verdict, outcome: reviewResult.outcome.outcome })

        return sendJson(res, 200, reviewResult)
      }

      // -------------------------------------------------------------
      // 5. Live Local Web Previews
      // -------------------------------------------------------------
      const prevStartMatch = pathname.match(/^\/api\/orchestrator\/tasks\/([^/]+)\/preview\/start$/)
      if (req.method === 'POST' && prevStartMatch) {
        const taskId = prevStartMatch[1]
        const body = await readJsonBody(req)
        const task = getTask(taskId, targetDb)
        if (!task) return sendJson(res, 404, { error: 'Task not found' })

        const session = await startPreviewServer({
          taskId,
          worktreePath: task.worktree_path,
          command: body.command || null,
          args: body.args || [],
          port: body.port || null,
        })

        broadcastOrchestratorEvent('preview_started', { taskId, port: session.port, url: session.url })
        return sendJson(res, 200, { session: { ...session, getLogs: undefined, logs: session.getLogs() } })
      }

      const prevStopMatch = pathname.match(/^\/api\/orchestrator\/tasks\/([^/]+)\/preview\/stop$/)
      if (req.method === 'POST' && prevStopMatch) {
        const taskId = prevStopMatch[1]
        const result = stopPreviewServer(taskId)
        broadcastOrchestratorEvent('preview_stopped', { taskId, result })
        return sendJson(res, 200, { success: true, result })
      }

      const prevStatusMatch = pathname.match(/^\/api\/orchestrator\/tasks\/([^/]+)\/preview\/status$/)
      if (req.method === 'GET' && prevStatusMatch) {
        const taskId = prevStatusMatch[1]
        const status = getPreviewStatus(taskId)
        return sendJson(res, 200, { session: status })
      }

      // -------------------------------------------------------------
      // 6. Decoupled Governance: Accept, Request Changes, Merge Feature
      // -------------------------------------------------------------
      const acceptMatch = pathname.match(/^\/api\/orchestrator\/tasks\/([^/]+)\/accept$/)
      if (req.method === 'POST' && acceptMatch) {
        const taskId = acceptMatch[1]
        const body = await readJsonBody(req)
        const task = getTask(taskId, targetDb)
        if (!task) return sendJson(res, 404, { error: 'Task not found' })

        const candidateCommitSha = body.candidateCommitSha || runGit(task.worktree_path, ['rev-parse', 'HEAD'])
        const featureBranch = body.featureBranch || `zen/${body.featureSlug || `feat-${taskId}`}`
        const repoPath = body.repoPath

        // 1. Fast-forward integrate candidate commit into feature branch
        const integration = integrateTaskCommit(repoPath, featureBranch, taskId, candidateCommitSha)

        // 2. Clean teardown of worktree
        teardownTaskWorktree(repoPath, taskId, { force: false })

        // 3. Mark task Done in state machine
        const doneTask = transitionTask(taskId, 'Done', {
          actor: body.acceptedBy || 'owner',
          details: { integratedCommitSha: integration.integratedCommitSha },
        }, targetDb)

        // 4. Record acceptance in SQLite
        const acceptance = recordAcceptance({
          taskId,
          candidateCommitSha,
          acceptedBy: body.acceptedBy || 'owner',
          integratedCommitSha: integration.integratedCommitSha,
          integratedAt: Date.now(),
        }, targetDb)

        broadcastOrchestratorEvent('task_accepted', { taskId, candidateCommitSha, integratedCommitSha: integration.integratedCommitSha })

        return sendJson(res, 200, {
          success: true,
          task: doneTask,
          integration,
          acceptance,
        })
      }

      const reqChangesMatch = pathname.match(/^\/api\/orchestrator\/tasks\/([^/]+)\/request-changes$/)
      if (req.method === 'POST' && reqChangesMatch) {
        const taskId = reqChangesMatch[1]
        const body = await readJsonBody(req)
        const updated = transitionTask(taskId, 'In Progress', {
          blockedReason: 'OWNER_CHANGES_REQUESTED',
          actor: body.requestedBy || 'owner',
          details: { notes: body.notes || '' },
        }, targetDb)

        broadcastOrchestratorEvent('changes_requested', { taskId, notes: body.notes })

        return sendJson(res, 200, { success: true, task: updated })
      }

      const mergeFeatMatch = pathname.match(/^\/api\/orchestrator\/projects\/([^/]+)\/merge-feature$/)
      if (req.method === 'POST' && mergeFeatMatch) {
        const projectId = mergeFeatMatch[1]
        const body = await readJsonBody(req)
        const project = getProject(projectId, targetDb)
        if (!project) return sendJson(res, 404, { error: 'Project not found' })

        const featureBranch = body.featureBranch
        const baseBranch = body.baseBranch || project.active_branch || 'main'

        // Check out base branch and merge feature branch
        runGit(project.repo_path, ['checkout', baseBranch])
        runGit(project.repo_path, ['merge', '--ff-only', featureBranch])
        const newBaseHead = runGit(project.repo_path, ['rev-parse', 'HEAD'])

        recordAuditLog({
          projectId,
          eventType: 'FEATURE_BRANCH_MERGED',
          actor: 'owner',
          details: { featureBranch, baseBranch, newBaseHead },
        }, targetDb)

        broadcastOrchestratorEvent('feature_merged', { projectId, featureBranch, mergedCommitSha: newBaseHead })

        return sendJson(res, 200, {
          success: true,
          baseBranch,
          mergedCommitSha: newBaseHead,
        })
      }

      // Default 404
      return sendJson(res, 404, { error: `Not found: ${req.method} ${pathname}` })
    } catch (err) {
      return sendJson(res, 400, {
        error: err.message,
        code: err.code || 'BAD_REQUEST',
      })
    }
  }
}

/**
 * Start the Orchestrator HTTP Server.
 */
export function startOrchestratorServer({ port = Number(process.env.ZEN_ORCHESTRATOR_PORT || 8900), db = null } = {}) {
  const handler = createOrchestratorHandler({ db })
  const server = http.createServer(handler)

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((cb) => server.close(cb)),
      })
    })
    server.on('error', reject)
  })
}
