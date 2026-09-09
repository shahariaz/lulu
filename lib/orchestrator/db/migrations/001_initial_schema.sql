-- 001_initial_schema.sql: Initial relational schema for Claude-Zen Orchestrator

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  active_branch TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS requirements_baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  spec_markdown TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'SUPERSEDED')),
  approved_at INTEGER,
  approved_by TEXT
);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  baseline_id TEXT NOT NULL REFERENCES requirements_baselines(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  order_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  scope_paths_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('Backlog', 'Ready', 'In Progress', 'Automated Checks', 'Code Review', 'QA', 'Done', 'Blocked', 'Cancelled')),
  waiting_reason TEXT CHECK (waiting_reason IS NULL OR waiting_reason IN ('SPECIALIST_UNAVAILABLE', 'AWAITING_OWNER_ACCEPTANCE', 'RUNNING_VERIFICATION', 'RUNNING_REVIEW', 'REWORK_REQUIRED')),
  blocked_reason TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN ('DEPENDENCIES_UNMET', 'REPAIR_LIMIT_EXCEEDED', 'SPECIALIST_UNAVAILABLE', 'BUDGET_EXCEEDED', 'RECONCILIATION_REQUIRED', 'INTEGRATION_CONFLICT', 'OWNER_CHANGES_REQUESTED', 'PROCESS_ERROR', 'SCOPE_INVALIDATED')),
  blocked_by_json TEXT NOT NULL DEFAULT '[]',
  worktree_path TEXT,
  repair_attempts INTEGER NOT NULL DEFAULT 0,
  max_repairs INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('WORKER', 'VERIFICATION', 'REVIEW')),
  role TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  account_email TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  is_estimated INTEGER NOT NULL DEFAULT 0,
  base_commit_sha TEXT,
  candidate_commit_sha TEXT,
  diff_digest TEXT,
  process_pid INTEGER,
  process_start_time INTEGER,
  process_cmdline TEXT,
  lease_expires_at INTEGER,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'))
);

CREATE TABLE IF NOT EXISTS verification_results (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  output_log TEXT,
  verification_digest TEXT NOT NULL,
  environment_info_json TEXT NOT NULL DEFAULT '{}',
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  executed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_records (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  candidate_commit_sha TEXT NOT NULL,
  diff_digest TEXT NOT NULL,
  verification_digest TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('APPROVE', 'CHANGES_REQUESTED')),
  summary TEXT,
  findings_json TEXT NOT NULL DEFAULT '[]',
  reviewed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acceptance_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  candidate_commit_sha TEXT NOT NULL,
  accepted_by TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  integrated_commit_sha TEXT,
  integrated_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  timestamp INTEGER NOT NULL
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_baselines_project ON requirements_baselines(project_id);
CREATE INDEX IF NOT EXISTS idx_milestones_baseline ON milestones(baseline_id);
CREATE INDEX IF NOT EXISTS idx_tasks_milestone ON tasks(milestone_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_verification_task_run ON verification_results(task_run_id);
CREATE INDEX IF NOT EXISTS idx_review_records_task_run ON review_records(task_run_id);
CREATE INDEX IF NOT EXISTS idx_acceptance_records_task ON acceptance_records(task_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_project ON audit_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
