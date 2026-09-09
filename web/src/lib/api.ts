import type {
  Project,
  Inspection,
  RequirementsBaseline,
  Milestone,
  Task,
  TaskRun,
  VerificationResult,
  ReviewRecord,
  AcceptanceRecord,
  AuditLog,
} from '../types'

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })

  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`)
  }
  return data
}

export const api = {
  // Projects
  async listProjects(): Promise<{ projects: Project[] }> {
    return request('/api/orchestrator/projects')
  },

  async importProject(repoPath: string, name?: string): Promise<{ project: Project; inspection: Inspection }> {
    return request('/api/orchestrator/projects', {
      method: 'POST',
      body: JSON.stringify({ repoPath, name }),
    })
  },

  async getProject(id: string): Promise<{ project: Project; inspection: Inspection; activeBaseline: RequirementsBaseline | null }> {
    return request(`/api/orchestrator/projects/${id}`)
  },

  // Scoping & Baselines
  async startScoping(projectId: string, featureTitle: string, initialPrompt?: string): Promise<{ session: any }> {
    return request(`/api/orchestrator/projects/${projectId}/scoping/start`, {
      method: 'POST',
      body: JSON.stringify({ featureTitle, initialPrompt }),
    })
  },

  async sendScopingMessage(conversationId: string, content: string, role = 'user'): Promise<{ session: any }> {
    return request(`/api/orchestrator/scoping/${conversationId}/message`, {
      method: 'POST',
      body: JSON.stringify({ role, content }),
    })
  },

  async draftBaseline(projectId: string, specMarkdown: string, version = 'v1.0.0'): Promise<{ draft: RequirementsBaseline }> {
    return request(`/api/orchestrator/projects/${projectId}/baselines/draft`, {
      method: 'POST',
      body: JSON.stringify({ specMarkdown, version }),
    })
  },

  async approveBaseline(baselineId: string, approvedBy = 'owner'): Promise<{ approved: RequirementsBaseline }> {
    return request(`/api/orchestrator/baselines/${baselineId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approvedBy }),
    })
  },

  // Task Decomposition & Scheduling
  async decomposeBaseline(baselineId: string, taskDefinitions: any[]): Promise<{ milestone: Milestone; tasks: Task[] }> {
    return request(`/api/orchestrator/baselines/${baselineId}/decompose`, {
      method: 'POST',
      body: JSON.stringify({ taskDefinitions }),
    })
  },

  async listTasks(milestoneId: string): Promise<{ tasks: Task[] }> {
    return request(`/api/orchestrator/milestones/${milestoneId}/tasks`)
  },

  async claimTask(taskId: string, projectId: string, featureSlug: string): Promise<{ task: Task; worktreePath: string }> {
    return request(`/api/orchestrator/tasks/${taskId}/claim`, {
      method: 'POST',
      body: JSON.stringify({ projectId, featureSlug }),
    })
  },

  // Execution, Verification, Review
  async executeWorker(taskId: string, projectId: string, mockFiles?: any[]): Promise<{ workerResult: any; task: Task }> {
    return request(`/api/orchestrator/tasks/${taskId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ projectId, mockFiles }),
    })
  },

  async runVerification(taskId: string, projectId: string, checkCommands?: string[]): Promise<{ verifResult: VerificationResult; outcome: any }> {
    return request(`/api/orchestrator/tasks/${taskId}/verify`, {
      method: 'POST',
      body: JSON.stringify({ projectId, checkCommands }),
    })
  },

  async runReview(taskId: string, projectId: string, options: any = {}): Promise<{ reviewRecord: ReviewRecord; outcome: any }> {
    return request(`/api/orchestrator/tasks/${taskId}/review`, {
      method: 'POST',
      body: JSON.stringify({ projectId, ...options }),
    })
  },

  // Decoupled Governance: Accept, Request Changes, Merge Feature
  async acceptTask(taskId: string, params: { repoPath: string; candidateCommitSha: string; featureBranch: string }): Promise<{ success: boolean; task: Task; integration: any }> {
    return request(`/api/orchestrator/tasks/${taskId}/accept`, {
      method: 'POST',
      body: JSON.stringify(params),
    })
  },

  async requestChanges(taskId: string, notes: string): Promise<{ success: boolean; task: Task }> {
    return request(`/api/orchestrator/tasks/${taskId}/request-changes`, {
      method: 'POST',
      body: JSON.stringify({ notes }),
    })
  },

  async mergeFeature(projectId: string, featureBranch: string, baseBranch = 'main'): Promise<{ success: boolean; mergedCommitSha: string }> {
    return request(`/api/orchestrator/projects/${projectId}/merge-feature`, {
      method: 'POST',
      body: JSON.stringify({ featureBranch, baseBranch }),
    })
  },
}
