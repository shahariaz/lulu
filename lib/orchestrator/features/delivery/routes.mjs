import fs from 'node:fs'
import path from 'node:path'
import {
  getProject, getTask, listTaskRuns, getVerificationResults, getReviewRecords,
  getAcceptanceRecord, createTaskRun, completeTaskRun, recordAcceptance, recordAuditLog,
  setTaskWorktree,
} from '../../db/index.mjs'
import {
  createFeatureBranch, provisionTaskWorktree, integrateTaskCommit, teardownTaskWorktree, runGit,
} from '../../git-workspace.mjs'
import { claimTaskForExecution, transitionTask } from '../../dag-scheduler.mjs'
import { executeWorkerTask } from '../../worker-harness.mjs'
import { runVerificationChecks, handleVerificationOutcome } from '../../verifier-engine.mjs'
import { runSpecialistReview } from '../../review-engine.mjs'
import { runE2ESuite, recordQAResult } from '../../qa-engine.mjs'
import { startPreviewServer, stopPreviewServer, getPreviewStatus } from '../../preview-manager.mjs'
import { readJson, json, projectForTask } from '../../http/shared.mjs'
import { broadcastOrchestratorEvent } from '../../http/event-bus.mjs'

function taskDetails(task, db) {
  const runs = listTaskRuns(task.id, db)
  const workerRun = runs.find((run) => run.kind === 'WORKER' && run.candidate_commit_sha) || null
  const verificationRun = [...runs].reverse().find((run) => run.kind === 'VERIFICATION') || null
  const reviewRun = [...runs].reverse().find((run) => run.kind === 'REVIEW') || null
  let diffPatch = null
  if (task.worktree_path && workerRun?.base_commit_sha && workerRun?.candidate_commit_sha) {
    try { diffPatch = runGit(task.worktree_path, ['diff', workerRun.base_commit_sha, workerRun.candidate_commit_sha, '--']) } catch {}
  }
  return {
    task, runs, candidateCommitSha: workerRun?.candidate_commit_sha || null, diffPatch,
    verificationResult: verificationRun ? getVerificationResults(verificationRun.id, db).at(-1) || null : null,
    reviewRecord: reviewRun ? getReviewRecords(reviewRun.id, db)[0] || null : null,
    acceptanceRecord: getAcceptanceRecord(task.id, db) || null,
  }
}

function integrateAcceptedTask({ task, project, candidateCommitSha, featureBranch, acceptedBy, automatic }, db) {
  const branch = featureBranch || runGit(task.worktree_path, ['branch', '--show-current'])
  const candidate = candidateCommitSha || runGit(task.worktree_path, ['rev-parse', 'HEAD'])
  stopPreviewServer(task.id)
  const integration = integrateTaskCommit(project.repo_path, branch, task.id, candidate)
  teardownTaskWorktree(project.repo_path, task.id, { force: false })
  const doneTask = transitionTask(task.id, 'Done', { actor: acceptedBy, automatic, details: { projectId: project.id, integratedCommitSha: integration.integratedCommitSha } }, db)
  const acceptance = recordAcceptance({ taskId: task.id, candidateCommitSha: candidate, acceptedBy, integratedCommitSha: integration.integratedCommitSha, integratedAt: Date.now() }, db)
  broadcastOrchestratorEvent('task_accepted', { projectId: project.id, taskId: task.id, candidateCommitSha: candidate, integratedCommitSha: integration.integratedCommitSha, automatic })
  return { success: true, task: doneTask, integration, acceptance }
}

export function registerDeliveryRoutes(app, { db }) {
  app.get('/api/orchestrator/tasks/:taskId', (c) => {
    const task = getTask(c.req.param('taskId'), db)
    return task ? json(c, taskDetails(task, db)) : json(c, { error: 'Task not found' }, 404)
  })

  app.post('/api/orchestrator/tasks/:taskId/claim', async (c) => {
    const taskId = c.req.param('taskId'); const body = await readJson(c); const task = getTask(taskId, db)
    if (!task) return json(c, { error: 'Task not found' }, 404)
    const project = getProject(body.projectId, db)
    if (!project) return json(c, { error: 'Project not found' }, 404)
    const featureSlug = body.featureSlug || `feat-${taskId}`
    createFeatureBranch(project.repo_path, featureSlug)
    const { worktreePath } = provisionTaskWorktree(project.repo_path, `zen/${featureSlug}`, taskId)
    // `automatic` marks a claim the orchestrator initiated rather than the owner. Today /claim
    // is only reached by an explicit request, so this is false; a future auto-dispatcher
    // (worker-pool / swarm) must pass true so GUIDED mode still requires an owner click.
    const claimed = claimTaskForExecution(taskId, project.id, db, { automatic: body.automatic === true })
    db.prepare('UPDATE tasks SET worktree_path = ?, updated_at = ? WHERE id = ?').run(worktreePath, Date.now(), taskId)
    broadcastOrchestratorEvent('task_claimed', { projectId: project.id, taskId, status: 'In Progress', worktreePath })
    return json(c, { task: { ...claimed, worktree_path: worktreePath }, worktreePath })
  })

  app.post('/api/orchestrator/tasks/:taskId/execute', async (c) => {
    const taskId = c.req.param('taskId'); const body = await readJson(c); const task = getTask(taskId, db)
    if (!task) return json(c, { error: 'Task not found' }, 404)
    const worktreePath = task.worktree_path || body.worktreePath
    if (!worktreePath) throw new Error('Task has no provisioned worktree. Claim it first.')
    if (!task.worktree_path) setTaskWorktree(taskId, worktreePath, db)
    let mockAction = null
    if (Array.isArray(body.mockFiles)) mockAction = async ({ worktreePath: target }) => {
      for (const file of body.mockFiles) {
        const full = path.join(target, file.path); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, file.content || '', 'utf8')
      }
    }
    if (task.status === 'Ready') transitionTask(taskId, 'In Progress', { actor: 'owner' }, db)
    const workerResult = await executeWorkerTask({ taskId, projectId: body.projectId, worktreePath, scopePaths: task.scope_paths, mockAction }, db)
    transitionTask(taskId, 'Automated Checks', { waitingReason: 'RUNNING_VERIFICATION', actor: 'worker', automatic: true }, db)
    broadcastOrchestratorEvent('worker_completed', { projectId: body.projectId, taskId, candidateCommitSha: workerResult.candidateCommitSha, status: 'Automated Checks' })
    return json(c, { workerResult, task: getTask(taskId, db) })
  })

  app.post('/api/orchestrator/tasks/:taskId/verify', async (c) => {
    const taskId = c.req.param('taskId'); const body = await readJson(c); const task = getTask(taskId, db)
    if (!task) return json(c, { error: 'Task not found' }, 404)
    const run = createTaskRun({ taskId, kind: 'VERIFICATION', role: 'VERIFIER' }, db)
    const verifResult = await runVerificationChecks({ taskRunId: run.id, worktreePath: task.worktree_path, checkCommands: body.checkCommands || ['npm test'] }, db)
    completeTaskRun(run.id, { status: verifResult.passed ? 'SUCCEEDED' : 'FAILED' }, db)
    const outcome = await handleVerificationOutcome({ taskId, projectId: body.projectId, taskRunId: run.id, verificationResult: verifResult }, db)
    broadcastOrchestratorEvent('verification_completed', { projectId: body.projectId, taskId, passed: verifResult.passed, exitCode: verifResult.exitCode, outcome: outcome.outcome })
    return json(c, { verifResult, outcome })
  })

  app.post('/api/orchestrator/tasks/:taskId/review', async (c) => {
    const taskId = c.req.param('taskId'); const body = await readJson(c); const task = getTask(taskId, db)
    if (!task) return json(c, { error: 'Task not found' }, 404)
    const run = createTaskRun({ taskId, kind: 'REVIEW', role: 'REVIEWER', model: body.model || 'specialist-strong', provider: body.provider || 'codex' }, db)
    const reviewResult = await runSpecialistReview({
      taskId, projectId: body.projectId, taskRunId: run.id, worktreePath: task.worktree_path,
      baseCommitSha: body.baseCommitSha || runGit(task.worktree_path, ['rev-parse', 'HEAD~1']),
      candidateCommitSha: body.candidateCommitSha || runGit(task.worktree_path, ['rev-parse', 'HEAD']),
      verificationDigest: body.verificationDigest || 'sha256:verified',
      reviewRunner: body.mockReview ? async () => body.mockReview : null,
    }, db)
    if (reviewResult.status === 'PENDING_SPECIALIST_UNAVAILABLE') {
      completeTaskRun(run.id, { status: 'FAILED' }, db)
      broadcastOrchestratorEvent('review_unavailable', { projectId: body.projectId, taskId, reason: reviewResult.reason })
      return json(c, { error: 'Specialist reviewer unavailable', code: 'SPECIALIST_UNAVAILABLE', reason: reviewResult.reason, task: reviewResult.task }, 503)
    }
    completeTaskRun(run.id, { status: 'SUCCEEDED' }, db)
    broadcastOrchestratorEvent('review_completed', { projectId: body.projectId, taskId, verdict: reviewResult.reviewRecord.verdict, outcome: reviewResult.outcome.outcome })
    return json(c, reviewResult)
  })

  app.post('/api/orchestrator/tasks/:taskId/qa', async (c) => {
    const taskId = c.req.param('taskId'); const body = await readJson(c); const task = getTask(taskId, db)
    if (!task) return json(c, { error: 'Task not found' }, 404)
    const acceptanceCriteria = body.acceptanceCriteria || task.acceptance_criteria || []
    const previewUrl = body.previewUrl || getPreviewStatus(taskId)?.url
    if (!previewUrl) return json(c, { error: 'No preview is running for this task. Start one first via /preview/start.', code: 'E_NO_PREVIEW' }, 400)
    const run = createTaskRun({ taskId, kind: 'VERIFICATION', role: 'QA', model: body.model || null, provider: body.provider || null }, db)
    try {
      const result = await runE2ESuite({ taskId, previewUrl, acceptanceCriteria, ...(body.model ? { model: body.model } : {}) })
      const stored = recordQAResult({ taskRunId: run.id, previewUrl, result }, db)
      completeTaskRun(run.id, { status: result.passed ? 'SUCCEEDED' : 'FAILED' }, db)
      let autoAcceptance = null
      const project = projectForTask(taskId, db)
      if (result.passed && task.status === 'QA' && project?.autonomy_mode === 'AUTONOMOUS') {
        autoAcceptance = integrateAcceptedTask({ task, project, acceptedBy: 'autonomy-policy', automatic: true }, db)
      }
      broadcastOrchestratorEvent('qa_completed', { projectId: project?.id, taskId, passed: result.passed, unmet: result.findings.filter((item) => !item.met).length })
      return json(c, { verificationId: stored.id, ...result, autoAcceptance })
    } catch (err) {
      completeTaskRun(run.id, { status: 'FAILED' }, db)
      if (err.code === 'E_QA_UNAVAILABLE' || err.code === 'E_GATEWAY_UNAVAILABLE') {
        broadcastOrchestratorEvent('qa_unavailable', { taskId, reason: err.message })
        return json(c, { error: 'QA could not be performed', code: err.code, reason: err.message }, 503)
      }
      throw err
    }
  })

  app.post('/api/orchestrator/tasks/:taskId/preview/start', async (c) => {
    const taskId = c.req.param('taskId'); const body = await readJson(c); const task = getTask(taskId, db)
    if (!task) return json(c, { error: 'Task not found' }, 404)
    const session = await startPreviewServer({ taskId, worktreePath: task.worktree_path, command: body.command || null, args: body.args || [], port: body.port || null })
    broadcastOrchestratorEvent('preview_started', { taskId, port: session.port, url: session.url, tier: session.tier })
    return json(c, { session: { ...session, getLogs: undefined, logs: session.getLogs() } })
  })
  app.post('/api/orchestrator/tasks/:taskId/preview/stop', (c) => {
    const taskId = c.req.param('taskId'); const result = stopPreviewServer(taskId)
    broadcastOrchestratorEvent('preview_stopped', { taskId, result }); return json(c, { success: true, result })
  })
  app.get('/api/orchestrator/tasks/:taskId/preview/status', (c) => json(c, { session: getPreviewStatus(c.req.param('taskId')) }))

  app.post('/api/orchestrator/tasks/:taskId/accept', async (c) => {
    const taskId = c.req.param('taskId'); const body = await readJson(c); const task = getTask(taskId, db)
    if (!task) return json(c, { error: 'Task not found' }, 404)
    const project = body.repoPath ? { ...(projectForTask(taskId, db) || {}), repo_path: body.repoPath } : projectForTask(taskId, db)
    if (!project?.repo_path) throw new Error('Project repository not found for task')
    return json(c, integrateAcceptedTask({ task, project, candidateCommitSha: body.candidateCommitSha, featureBranch: body.featureBranch, acceptedBy: body.acceptedBy || 'owner', automatic: false }, db))
  })
  app.post('/api/orchestrator/tasks/:taskId/request-changes', async (c) => {
    const taskId = c.req.param('taskId'); const body = await readJson(c)
    const updated = transitionTask(taskId, 'In Progress', { blockedReason: 'OWNER_CHANGES_REQUESTED', actor: 'owner', details: { notes: body.notes || '' } }, db)
    recordAuditLog({ taskId, eventType: 'OWNER_REQUESTED_CHANGES', actor: 'owner', details: { notes: body.notes || '' } }, db)
    broadcastOrchestratorEvent('changes_requested', { taskId, notes: body.notes || '' })
    return json(c, { success: true, task: updated })
  })
}
