import fs from 'node:fs'
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
    const { repoPath, name, forceDirty = false, initNew = false } = await readJson(c)
    if (!repoPath) throw new Error('repoPath is required')
    const resolvedPath = path.resolve(repoPath)

    if (initNew) {
      fs.mkdirSync(resolvedPath, { recursive: true })
      try {
        runGit(resolvedPath, ['rev-parse', '--is-inside-work-tree'])
      } catch {
        runGit(resolvedPath, ['init', '-b', 'main'])
        runGit(resolvedPath, ['config', 'user.name', 'Claude-Zen'])
        runGit(resolvedPath, ['config', 'user.email', 'developer@claude-zen.local'])
      }

      const readmePath = path.join(resolvedPath, 'README.md')
      if (!fs.existsSync(readmePath)) {
        const projectName = name || path.basename(resolvedPath)
        fs.writeFileSync(readmePath, `# ${projectName}\n\nInitialized with Claude-Zen delivery platform.\n`)
        runGit(resolvedPath, ['add', 'README.md'])
        runGit(resolvedPath, ['commit', '-m', 'chore: initial repository commit'])
      }

      const gitignorePath = path.join(resolvedPath, '.gitignore')
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, 'node_modules/\n.DS_Store\ndist/\n.env\n*.log\n')
        runGit(resolvedPath, ['add', '.gitignore'])
        runGit(resolvedPath, ['commit', '-m', 'chore: add .gitignore'])
      }
    }

    const inspection = inspectRepository(resolvedPath)
    if (!inspection.isClean && !forceDirty) {
      return json(c, { error: 'Repository working tree contains uncommitted changes.', uncommittedFiles: inspection.uncommittedFiles }, 400)
    }
    const project = createProject({ name: name || path.basename(resolvedPath), repoPath: inspection.repoPath, activeBranch: inspection.currentBranch }, db)
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
