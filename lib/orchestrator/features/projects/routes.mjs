import path from 'node:path'
import {
  createProject, getProject, listProjects, getApprovedBaseline, listBaselines,
  listProjectMilestones, listProjectTasks, listProjectFeatures, listEpics,
  updateProjectAutonomyMode, recordAuditLog,
} from '../../db/index.mjs'
import { inspectRepository, runGit } from '../../git-workspace.mjs'
import { json, readJson } from '../../http/shared.mjs'
import { broadcastOrchestratorEvent } from '../../http/event-bus.mjs'

export function registerProjectRoutes(app, { db }) {
  app.post('/api/orchestrator/projects', async (c) => {
    const { repoPath, name, forceDirty = false } = await readJson(c)
    if (!repoPath) throw new Error('repoPath is required')
    const inspection = inspectRepository(repoPath)
    if (!inspection.isClean && !forceDirty) return json(c, { error: 'Repository working tree contains uncommitted changes.', uncommittedFiles: inspection.uncommittedFiles }, 400)
    const project = createProject({ name: name || path.basename(path.resolve(repoPath)), repoPath: inspection.repoPath, activeBranch: inspection.currentBranch }, db)
    return json(c, { project, inspection }, 201)
  })

  app.get('/api/orchestrator/projects', (c) => json(c, { projects: listProjects(db) }))

  app.get('/api/orchestrator/projects/:projectId', (c) => {
    const project = getProject(c.req.param('projectId'), db)
    if (!project) return json(c, { error: 'Project not found' }, 404)
    return json(c, {
      project, inspection: inspectRepository(project.repo_path),
      activeBaseline: getApprovedBaseline(project.id, db), baselines: listBaselines(project.id, db),
      milestones: listProjectMilestones(project.id, db), epics: listEpics(project.id, db),
      features: listProjectFeatures(project.id, db), tasks: listProjectTasks(project.id, db),
    })
  })

  app.patch('/api/orchestrator/projects/:projectId/autonomy', async (c) => {
    const { autonomyMode } = await readJson(c)
    const project = updateProjectAutonomyMode(c.req.param('projectId'), autonomyMode, db)
    if (!project) return json(c, { error: 'Project not found' }, 404)
    broadcastOrchestratorEvent('autonomy_changed', { projectId: project.id, autonomyMode: project.autonomy_mode })
    return json(c, { project })
  })

  app.post('/api/orchestrator/projects/:projectId/merge-feature', async (c) => {
    const projectId = c.req.param('projectId')
    const project = getProject(projectId, db)
    if (!project) return json(c, { error: 'Project not found' }, 404)
    const body = await readJson(c)
    const featureBranch = body.featureBranch
    const baseBranch = body.baseBranch || project.active_branch || 'main'
    if (!featureBranch) throw new Error('featureBranch is required')
    runGit(project.repo_path, ['checkout', baseBranch])
    runGit(project.repo_path, ['merge', '--ff-only', featureBranch])
    const mergedCommitSha = runGit(project.repo_path, ['rev-parse', 'HEAD'])
    recordAuditLog({ projectId, eventType: 'FEATURE_BRANCH_MERGED', actor: 'owner', details: { featureBranch, baseBranch, newBaseHead: mergedCommitSha } }, db)
    broadcastOrchestratorEvent('feature_merged', { projectId, featureBranch, mergedCommitSha })
    return json(c, { success: true, baseBranch, mergedCommitSha })
  })
}
