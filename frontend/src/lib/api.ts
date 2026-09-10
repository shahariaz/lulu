import type {
  Project, Inspection, RequirementsBaseline, Milestone, Task, VerificationResult,
  ReviewRecord, Feature, EpicProgress, WorkspacePayload, TaskDetails,
} from '../types'

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const error = new Error(data.error || data.reason || `HTTP ${res.status}: ${res.statusText}`)
    ;(error as any).code = data.code
    throw error
  }
  return data as T
}

const json = (value: unknown) => JSON.stringify(value)

export const api = {
  listProjects: () => request<{ projects: Project[] }>('/api/orchestrator/projects'),
  importProject: (repoPath: string, name?: string) => request<{ project: Project; inspection: Inspection }>('/api/orchestrator/projects', { method: 'POST', body: json({ repoPath, name, initNew: false }) }),
  createProject: (params: { repoPath: string; name?: string; initNew?: boolean; forceDirty?: boolean }) => request<{ project: Project; inspection: Inspection }>('/api/orchestrator/projects', { method: 'POST', body: json(params) }),
  getProject: (id: string) => request<WorkspacePayload>(`/api/orchestrator/projects/${id}`),
  updateAutonomy: (id: string, autonomyMode: Project['autonomy_mode']) => request<{ project: Project }>(`/api/orchestrator/projects/${id}/autonomy`, { method: 'PATCH', body: json({ autonomyMode }) }),

  startCouncil: (params: { projectName: string; ideaDescription: string; targetPersona?: string }) => request<any>('/api/orchestrator/council/start', { method: 'POST', body: json(params) }),
  getCouncil: (id: string) => request<any>(`/api/orchestrator/council/${id}`),
  getProjectCouncil: (projectId: string) => request<{ session: any; personas?: any }>(`/api/orchestrator/projects/${projectId}/council`),
  councilTurn: (sessionId: string, userMessage: string, forcedRole?: string) => request<any>('/api/orchestrator/council/turn', { method: 'POST', body: json({ sessionId, userMessage, forcedRole }) }),
  conveneDebate: (sessionId: string, userPrompt?: string) => request<any>('/api/orchestrator/council/debate', { method: 'POST', body: json({ sessionId, userPrompt }) }),
  researchMarket: (params: { sessionId: string; productIdea: string; ideaDescription: string; depth?: string }) => request<any>('/api/orchestrator/council/teardown', { method: 'POST', body: json(params) }),
  synthesizeBlueprint: (params: { sessionId: string; ideaTitle: string; ideaDescription: string; marketResearch?: unknown }) => request<any>('/api/orchestrator/council/blueprint', { method: 'POST', body: json(params) }),
  initializeProject: (params: { sessionId: string; repoPath: string; projectName: string; blueprint: unknown; marketResearch?: unknown }) => request<any>('/api/orchestrator/council/initialize-project', { method: 'POST', body: json(params) }),

  startScoping: (projectId: string, featureTitle: string, initialPrompt?: string) => request<any>(`/api/orchestrator/projects/${projectId}/scoping/start`, { method: 'POST', body: json({ featureTitle, initialPrompt }) }),
  getScoping: (id: string) => request<any>(`/api/orchestrator/scoping/${id}`),
  sendScopingMessage: (id: string, content: string, role = 'user') => request<any>(`/api/orchestrator/scoping/${id}/message`, { method: 'POST', body: json({ role, content }) }),
  draftBaseline: (projectId: string, specMarkdown: string, version = 'v1.0.0') => request<{ draft: RequirementsBaseline }>(`/api/orchestrator/projects/${projectId}/baselines/draft`, { method: 'POST', body: json({ specMarkdown, version }) }),
  approveBaseline: (id: string, approvedBy = 'owner') => request<{ approved: RequirementsBaseline }>(`/api/orchestrator/baselines/${id}/approve`, { method: 'POST', body: json({ approvedBy }) }),
  diffBaselines: (from: string, to: string) => request<any>(`/api/orchestrator/baselines/${from}/diff/${to}`),
  analyzeScopeImpact: (projectId: string, previousBaselineId: string, newBaselineId: string) => request<any>('/api/orchestrator/baselines/scope-impact', { method: 'POST', body: json({ projectId, previousBaselineId, newBaselineId }) }),
  applyScopeImpact: (projectId: string, impactReport: unknown) => request<any>('/api/orchestrator/baselines/apply-impact', { method: 'POST', body: json({ projectId, impactReport }) }),

  decomposeBaseline: (id: string, taskDefinitions: any[]) => request<{ milestone: Milestone; tasks: Task[] }>(`/api/orchestrator/baselines/${id}/decompose`, { method: 'POST', body: json({ taskDefinitions }) }),
  decomposeHierarchical: (id: string, params: unknown) => request<{ milestone: Milestone; features: Feature[]; tasks: Task[] }>(`/api/orchestrator/baselines/${id}/decompose-hierarchical`, { method: 'POST', body: json(params) }),
  listTasks: (milestoneId: string) => request<{ tasks: Task[] }>(`/api/orchestrator/milestones/${milestoneId}/tasks`),
  getTask: (taskId: string) => request<TaskDetails>(`/api/orchestrator/tasks/${taskId}`),
  listEpics: (projectId: string) => request<{ epics: EpicProgress[] }>(`/api/orchestrator/projects/${projectId}/epics`),
  getEpicProgress: (epicId: string) => request<{ progress: EpicProgress }>(`/api/orchestrator/epics/${epicId}/progress`),
  listSprints: (projectId: string) => request<any>(`/api/orchestrator/projects/${projectId}/sprints`),
  createSprint: (projectId: string, params: unknown) => request<any>(`/api/orchestrator/projects/${projectId}/sprints`, { method: 'POST', body: json(params) }),
  assignSprintTasks: (sprintId: string, taskIds: string[]) => request<any>(`/api/orchestrator/sprints/${sprintId}/assign-tasks`, { method: 'POST', body: json({ taskIds }) }),

  claimTask: (taskId: string, projectId: string, featureSlug: string) => request<any>(`/api/orchestrator/tasks/${taskId}/claim`, { method: 'POST', body: json({ projectId, featureSlug }) }),
  executeWorker: (taskId: string, projectId: string, mockFiles?: any[]) => request<any>(`/api/orchestrator/tasks/${taskId}/execute`, { method: 'POST', body: json({ projectId, mockFiles }) }),
  runVerification: (taskId: string, projectId: string, checkCommands?: string[]) => request<any>(`/api/orchestrator/tasks/${taskId}/verify`, { method: 'POST', body: json({ projectId, checkCommands }) }),
  runReview: (taskId: string, projectId: string, options: any = {}) => request<any>(`/api/orchestrator/tasks/${taskId}/review`, { method: 'POST', body: json({ projectId, ...options }) }),
  runQa: (taskId: string, params: unknown = {}) => request<any>(`/api/orchestrator/tasks/${taskId}/qa`, { method: 'POST', body: json(params) }),
  acceptTask: (taskId: string, params: { repoPath: string; candidateCommitSha: string; featureBranch: string }) => request<any>(`/api/orchestrator/tasks/${taskId}/accept`, { method: 'POST', body: json(params) }),
  requestChanges: (taskId: string, notes: string) => request<any>(`/api/orchestrator/tasks/${taskId}/request-changes`, { method: 'POST', body: json({ notes }) }),
  mergeFeature: (projectId: string, featureBranch: string, baseBranch = 'main') => request<any>(`/api/orchestrator/projects/${projectId}/merge-feature`, { method: 'POST', body: json({ featureBranch, baseBranch }) }),

  startPreview: (taskId: string) => request<any>(`/api/orchestrator/tasks/${taskId}/preview/start`, { method: 'POST', body: '{}' }),
  stopPreview: (taskId: string) => request<any>(`/api/orchestrator/tasks/${taskId}/preview/stop`, { method: 'POST', body: '{}' }),
  getPreview: (taskId: string) => request<any>(`/api/orchestrator/tasks/${taskId}/preview/status`),
  getSwarmMetrics: () => request<any>('/api/orchestrator/swarm/metrics'),
  scheduleSwarm: (milestoneId: string, maxConcurrency = 3) => request<any>(`/api/orchestrator/milestones/${milestoneId}/schedule-swarm`, { method: 'POST', body: json({ maxConcurrency }) }),
  enqueueMerge: (params: unknown) => request<any>('/api/orchestrator/swarm/merge-queue/enqueue', { method: 'POST', body: json(params) }),
}
