import fs from 'node:fs'
import path from 'node:path'
import {
  createProject, getBaseline, updateConversation, createSprint,
} from '../../db/index.mjs'
import { runGit } from '../../git-workspace.mjs'
import {
  startCouncilSession, executeCouncilTurn, executeCouncilDebate, generateCompetitorTeardown,
  synthesizeProductBlueprint, validateProductBlueprint, getCouncilSession, getProjectCouncilSession,
  COUNCIL_PERSONAS,
} from '../../council-engine.mjs'
import {
  startSpecConversation, addSpecMessage, generateArchitectReply, getSpecConversation,
  createDraftBaseline, approveBaselineVersion,
} from '../../spec-engine.mjs'
import { decomposePRDViaLLM, decomposeBaselineHierarchical, assignTasksToSprint } from '../../epic-planner.mjs'
import { diffRequirementsBaselines, generateSpecificationChangelog } from '../../spec-diff.mjs'
import { analyzeBaselineScopeImpact, applyScopeImpact } from '../../impact-analyzer.mjs'
import { blueprintToSpecMarkdown } from './blueprint-service.mjs'
import { readJson, json } from '../../http/shared.mjs'
import { broadcastOrchestratorEvent } from '../../http/event-bus.mjs'

export function registerProductDesignRoutes(app, { db }) {
  app.post('/api/orchestrator/council/start', async (c) => {
    const body = await readJson(c)
    const session = startCouncilSession({ projectId: body.projectId || null, projectName: body.projectName || '', ideaDescription: body.ideaDescription || '', targetPersona: body.targetPersona || 'developers' }, db)

    // Pre-warm market research in background so Phase 3 loads instantly
    if (session.ideaDescription?.trim() && !body.skipResearchPrewarm) {
      generateCompetitorTeardown({
        productIdea: session.projectName,
        ideaDescription: session.ideaDescription,
        depth: 'quick',
        sessionId: session.id,
        db,
      }).then((teardown) => {
        broadcastOrchestratorEvent('studio_research_ready', { sessionId: session.id, teardown })
      }).catch((err) => {
        console.warn(`[Studio] Background research pre-warm skipped: ${err.message}`)
      })
    }

    return json(c, { session, personas: COUNCIL_PERSONAS })
  })
  app.get('/api/orchestrator/council/:sessionId', (c) => {
    const session = getCouncilSession(c.req.param('sessionId'), db)
    return session ? json(c, { session, personas: COUNCIL_PERSONAS }) : json(c, { error: 'Council session not found' }, 404)
  })
  app.get('/api/orchestrator/projects/:projectId/council', (c) => {
    const session = getProjectCouncilSession(c.req.param('projectId'), db)
    return session ? json(c, { session, personas: COUNCIL_PERSONAS }) : json(c, { session: null, personas: COUNCIL_PERSONAS })
  })
  app.post('/api/orchestrator/council/turn', async (c) => {
    const body = await readJson(c)
    return json(c, await executeCouncilTurn({ sessionId: body.sessionId, userMessage: body.userMessage, forcedRole: body.forcedRole || null, mockReply: body.mockReply || null, db }))
  })
  app.post('/api/orchestrator/council/debate', async (c) => {
    const body = await readJson(c)
    const { sessionId, userPrompt = null } = body
    const result = await executeCouncilDebate({
      sessionId,
      userPrompt,
      onTurn: (role, turnResult) => {
        broadcastOrchestratorEvent('council_debate_turn', { sessionId, role, reply: turnResult.reply })
      },
      db,
    })
    return json(c, result)
  })
  app.post('/api/orchestrator/council/teardown', async (c) => {
    const body = await readJson(c)
    const teardown = await generateCompetitorTeardown({
      productIdea: body.productIdea, ideaDescription: body.ideaDescription || '', depth: body.depth || 'standard', sessionId: body.sessionId || null, db,
      ...(body.mockResearch ? { runner: async () => ({ exitCode: 0, stdout: JSON.stringify(body.mockResearch), stderr: '' }) } : {}),
    })
    return json(c, { teardown })
  })
  app.post('/api/orchestrator/council/blueprint', async (c) => {
    const body = await readJson(c)
    const blueprint = await synthesizeProductBlueprint({ sessionId: body.sessionId || null, ideaTitle: body.ideaTitle, ideaDescription: body.ideaDescription, transcript: body.transcript || null, marketResearch: body.marketResearch || null, mockBlueprint: body.mockBlueprint || null, db })
    return json(c, { blueprint })
  })
  app.post('/api/orchestrator/council/initialize-project', async (c) => {
    const body = await readJson(c)
    const { repoPath, projectName, blueprint, sessionId = null } = body
    if (!repoPath) throw new Error('repoPath is required')
    validateProductBlueprint(blueprint)
    const session = sessionId ? getCouncilSession(sessionId, db) : null
    const marketResearch = body.marketResearch || session?.marketResearch || null
    const resolvedPath = path.resolve(repoPath)

    if (sessionId) {
      broadcastOrchestratorEvent('studio_progress', { sessionId, stage: 'git_init', message: 'Initializing local repository...' })
    }

    fs.mkdirSync(resolvedPath, { recursive: true })
    try { runGit(resolvedPath, ['rev-parse', '--is-inside-work-tree']) }
    catch {
      runGit(resolvedPath, ['init', '-b', 'main'])
      runGit(resolvedPath, ['config', 'user.name', 'Claude-Zen Studio'])
      runGit(resolvedPath, ['config', 'user.email', 'studio@claude-zen.local'])
    }
    const project = createProject({ name: projectName || blueprint?.title || path.basename(resolvedPath), repoPath: resolvedPath, activeBranch: 'main' }, db)
    const readmePath = path.join(resolvedPath, 'README.md')
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, `# ${project.name}\n\n${blueprint.prd.executiveSummary}\n`)
      runGit(resolvedPath, ['add', 'README.md'])
      runGit(resolvedPath, ['commit', '-m', 'chore: initialize project repository from blueprint'])
    }

    if (sessionId) {
      broadcastOrchestratorEvent('studio_progress', { sessionId, stage: 'baseline', message: 'Locking requirements specification v1.0.0...' })
    }

    const specMarkdown = blueprintToSpecMarkdown(project.name, blueprint, marketResearch)
    const draft = createDraftBaseline({ projectId: project.id, specMarkdown, version: 'v1.0.0' }, db)
    const baseline = approveBaselineVersion({ baselineId: draft.id, approvedBy: 'owner' }, db)

    if (sessionId) {
      broadcastOrchestratorEvent('studio_progress', { sessionId, stage: 'decomposition', message: 'Generating hierarchical epics and dependency DAG...' })
    }

    const planned = await decomposePRDViaLLM({ baselineId: baseline.id, specMarkdown, mockDecomposition: body.mockDecomposition || null, db })

    // Preserve roadmap milestones from blueprint rather than flattening
    const roadmapMilestones = Array.isArray(blueprint?.roadmap?.milestones) && blueprint.roadmap.milestones.length > 0
      ? blueprint.roadmap.milestones.map((m, i) => ({ title: m.title || `Phase ${i + 1}`, orderIndex: i + 1 }))
      : null

    const decomposition = decomposeBaselineHierarchical({
      baselineId: baseline.id,
      projectId: project.id,
      milestoneTitle: planned.milestoneTitle || 'Milestone 1: MVP Delivery',
      epicsWithTasks: planned.epics,
      milestones: roadmapMilestones,
    }, db)

    if (sessionId && session) updateConversation(sessionId, { projectId: project.id }, db)

    // Auto-provision Sprint 1: MVP Foundation linking initial Ready tasks
    let sprint = null
    const readyTasks = (decomposition.tasks || []).filter((t) => t.status === 'Ready')
    if (readyTasks.length > 0) {
      sprint = createSprint({
        projectId: project.id,
        name: 'Sprint 1: MVP Foundation',
        goal: `Implement foundational capabilities for ${project.name}`,
        status: 'ACTIVE',
      }, db)
      assignTasksToSprint(sprint.id, readyTasks.map((t) => t.id), db)
    }

    broadcastOrchestratorEvent('project_initialized_from_blueprint', {
      projectId: project.id,
      projectName: project.name,
      baselineVersion: baseline.version,
      taskCount: decomposition.tasks.length,
      milestoneCount: (decomposition.milestones || []).length,
      sprintId: sprint?.id || null,
    })
    return json(c, { success: true, project, baseline, decomposition, sprint }, 201)
  })

  app.post('/api/orchestrator/projects/:projectId/scoping/start', async (c) => {
    const body = await readJson(c)
    const session = startSpecConversation({ projectId: c.req.param('projectId'), featureTitle: body.featureTitle || 'New Feature', initialPrompt: body.initialPrompt || '' }, db)
    if (body.initialPrompt?.trim()) await generateArchitectReply(session.id, { db })
    return json(c, { session: getSpecConversation(session.id, db) })
  })
  app.post('/api/orchestrator/scoping/:conversationId/message', async (c) => {
    const id = c.req.param('conversationId'); const body = await readJson(c)
    addSpecMessage(id, { role: body.role || 'user', content: body.content }, db)
    const reply = await generateArchitectReply(id, { db })
    return json(c, { session: reply.conversation, reply: reply.message })
  })
  app.get('/api/orchestrator/scoping/:conversationId', (c) => {
    const session = getSpecConversation(c.req.param('conversationId'), db)
    return session ? json(c, { session }) : json(c, { error: 'Specification conversation not found' }, 404)
  })
  app.post('/api/orchestrator/projects/:projectId/baselines/draft', async (c) => {
    const body = await readJson(c)
    return json(c, { draft: createDraftBaseline({ projectId: c.req.param('projectId'), specMarkdown: body.specMarkdown, version: body.version || 'v1.0.0' }, db) }, 201)
  })
  app.post('/api/orchestrator/baselines/:baselineId/approve', async (c) => {
    const body = await readJson(c)
    return json(c, { approved: approveBaselineVersion({ baselineId: c.req.param('baselineId'), approvedBy: body.approvedBy || 'owner' }, db) })
  })
  app.get('/api/orchestrator/baselines/:from/diff/:to', (c) => {
    const from = getBaseline(c.req.param('from'), db); const to = getBaseline(c.req.param('to'), db)
    if (!from || !to) return json(c, { error: 'One or both baselines not found' }, 404)
    const diffResult = diffRequirementsBaselines(from.spec_markdown, to.spec_markdown)
    return json(c, { diffResult, changelog: generateSpecificationChangelog({ versionFrom: from.version, versionTo: to.version, diffResult }) })
  })
  app.post('/api/orchestrator/baselines/scope-impact', async (c) => {
    const body = await readJson(c)
    return json(c, { report: analyzeBaselineScopeImpact({ projectId: body.projectId, previousBaselineId: body.previousBaselineId, newBaselineId: body.newBaselineId }, db) })
  })
  app.post('/api/orchestrator/baselines/apply-impact', async (c) => {
    const body = await readJson(c)
    return json(c, applyScopeImpact({ projectId: body.projectId, impactReport: body.impactReport, actor: body.actor || 'owner' }, db))
  })
}
