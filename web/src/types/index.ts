export type TaskStatus =
  | 'Backlog'
  | 'Ready'
  | 'In Progress'
  | 'Automated Checks'
  | 'Code Review'
  | 'QA'
  | 'Done'
  | 'Blocked'
  | 'Cancelled'

export type WaitingReason =
  | 'SPECIALIST_UNAVAILABLE'
  | 'AWAITING_OWNER_ACCEPTANCE'
  | 'RUNNING_VERIFICATION'
  | 'RUNNING_REVIEW'

export type BlockedReason =
  | 'DEPENDENCIES_UNMET'
  | 'REPAIR_LIMIT_EXCEEDED'
  | 'SPECIALIST_UNAVAILABLE'
  | 'BUDGET_EXCEEDED'
  | 'RECONCILIATION_REQUIRED'
  | 'INTEGRATION_CONFLICT'
  | 'OWNER_CHANGES_REQUESTED'
  | 'PROCESS_ERROR'

export type TaskRunKind = 'WORKER' | 'VERIFICATION' | 'REVIEW'

export type TaskRunStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'INTERRUPTED'

export interface Project {
  id: string
  name: string
  repo_path: string
  active_branch: string
  created_at: number
}

export interface Inspection {
  repoPath: string
  isClean: boolean
  uncommittedFiles: string[]
  currentBranch: string
  headCommitSha: string
  runtime: string
  testCommand: string | null
  lintCommand: string | null
  packageManager: string | null
}

export interface RequirementsBaseline {
  id: string
  project_id: string
  version: string
  spec_markdown: string
  content_digest: string
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED'
  approved_at: number | null
  approved_by: string | null
}

export interface Milestone {
  id: string
  baseline_id: string
  title: string
  order_index: number
}

export interface Task {
  id: string
  milestone_id: string
  title: string
  description: string
  scope_paths: string[]
  status: TaskStatus
  waiting_reason: WaitingReason | null
  blocked_reason: BlockedReason | null
  blocked_by: string[]
  worktree_path: string | null
  repair_attempts: number
  max_repairs: number
  created_at: number
  updated_at: number
}

export interface TaskRun {
  id: string
  task_id: string
  kind: TaskRunKind
  role: string
  model: string | null
  provider: string | null
  account_email: string | null
  input_tokens: number
  output_tokens: number
  is_estimated: number
  base_commit_sha: string | null
  candidate_commit_sha: string | null
  diff_digest: string | null
  started_at: number
  completed_at: number | null
  status: TaskRunStatus
}

export interface VerificationResult {
  id: string
  task_run_id: string
  command: string
  exit_code: number
  output_log: string
  verification_digest: string
  environment_info: Record<string, any>
  passed: number
  executed_at: number
}

export interface ReviewFinding {
  category: 'correctness' | 'security' | 'regression' | 'style'
  severity: 'critical' | 'high' | 'medium' | 'low'
  file: string
  line?: number
  description: string
}

export interface ReviewRecord {
  id: string
  task_run_id: string
  candidate_commit_sha: string
  diff_digest: string
  verification_digest: string
  verdict: 'APPROVE' | 'CHANGES_REQUESTED'
  summary: string
  findings: ReviewFinding[]
  reviewed_at: number
}

export interface AcceptanceRecord {
  id: string
  task_id: string
  candidate_commit_sha: string
  accepted_by: string
  accepted_at: number
  integrated_commit_sha: string | null
  integrated_at: number | null
}

export interface AuditLog {
  id: string
  project_id: string | null
  task_id: string | null
  event_type: string
  actor: string
  details: Record<string, any>
  timestamp: number
}
