import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { runMigrations } from './migration-runner.mjs'

const DEFAULT_DB_DIR = path.join(os.homedir(), '.zen-claude')
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'zen-orchestrator.sqlite')

let dbInstance = null
let currentDbPath = null

/**
 * Get or initialize the Orchestrator SQLite Database.
 * Runs versioned migrations automatically on connection.
 */
export function getOrchestratorDb(customPath = null) {
  const dbPath = customPath || process.env.ZEN_ORCHESTRATOR_DB_PATH || DEFAULT_DB_PATH

  if (dbInstance && currentDbPath === dbPath) {
    return dbInstance
  }

  if (dbInstance) {
    try { dbInstance.close() } catch {}
    dbInstance = null
  }

  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  if (path.resolve(dir) === path.resolve(DEFAULT_DB_DIR)) {
    try { fs.chmodSync(dir, 0o700) } catch {}
  }

  const db = new DatabaseSync(dbPath)
  try { fs.chmodSync(dbPath, 0o600) } catch {}

  db.exec('PRAGMA busy_timeout = 10000;')
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA foreign_keys = ON;')

  // Run versioned migrations
  runMigrations(db)

  dbInstance = db
  currentDbPath = dbPath
  return db
}

export function closeOrchestratorDb() {
  if (dbInstance) {
    try { dbInstance.close() } catch {}
    dbInstance = null
    currentDbPath = null
  }
}

/* ==========================================================================
 * Project Operations
 * ========================================================================== */

export function createProject({ id = null, name, repoPath, activeBranch = 'main' }, db = null) {
  const targetDb = db || getOrchestratorDb()
  const projectId = id || `proj_${randomUUID().slice(0, 12)}`
  const now = Date.now()

  targetDb.prepare(`
    INSERT INTO projects (id, name, repo_path, active_branch, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(projectId, name, path.resolve(repoPath), activeBranch, now)

  return getProject(projectId, targetDb)
}

export function getProject(projectId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId)
}

export function listProjects(db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all()
}

export function deleteProject(projectId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId).changes > 0
}

/* ==========================================================================
 * Requirements Baselines Operations
 * ========================================================================== */

export function createBaseline({
  id = null,
  projectId,
  version = 'v1.0.0',
  specMarkdown,
  contentDigest,
  status = 'DRAFT',
  approvedAt = null,
  approvedBy = null,
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const baselineId = id || `base_${randomUUID().slice(0, 12)}`

  targetDb.prepare(`
    INSERT INTO requirements_baselines (
      id, project_id, version, spec_markdown, content_digest, status, approved_at, approved_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(baselineId, projectId, version, specMarkdown, contentDigest, status, approvedAt, approvedBy)

  return getBaseline(baselineId, targetDb)
}

export function getBaseline(baselineId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM requirements_baselines WHERE id = ?`).get(baselineId)
}

export function getApprovedBaseline(projectId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`
    SELECT * FROM requirements_baselines
    WHERE project_id = ? AND status = 'APPROVED'
    ORDER BY approved_at DESC LIMIT 1
  `).get(projectId)
}

export function approveBaseline(baselineId, approvedBy = 'owner', db = null) {
  const targetDb = db || getOrchestratorDb()
  const now = Date.now()

  targetDb.prepare(`
    UPDATE requirements_baselines
    SET status = 'APPROVED', approved_at = ?, approved_by = ?
    WHERE id = ?
  `).run(now, approvedBy, baselineId)

  return getBaseline(baselineId, targetDb)
}

/* ==========================================================================
 * Milestone Operations
 * ========================================================================== */

export function createMilestone({ id = null, baselineId, title, orderIndex = 1 }, db = null) {
  const targetDb = db || getOrchestratorDb()
  const milestoneId = id || `ms_${randomUUID().slice(0, 12)}`

  targetDb.prepare(`
    INSERT INTO milestones (id, baseline_id, title, order_index)
    VALUES (?, ?, ?, ?)
  `).run(milestoneId, baselineId, title, orderIndex)

  return targetDb.prepare(`SELECT * FROM milestones WHERE id = ?`).get(milestoneId)
}

export function listMilestones(baselineId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM milestones WHERE baseline_id = ? ORDER BY order_index ASC`).all(baselineId)
}

/* ==========================================================================
 * Epic Operations
 * ========================================================================== */

export function createEpic({
  id = null,
  projectId,
  baselineId = null,
  title,
  description = '',
  orderIndex = 1,
  status = 'PLANNED',
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const epicId = id || `epic_${randomUUID().slice(0, 12)}`
  const now = Date.now()

  targetDb.prepare(`
    INSERT INTO epics (id, project_id, baseline_id, title, description, order_index, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(epicId, projectId, baselineId, title, description, orderIndex, status, now)

  return getEpic(epicId, targetDb)
}

export function getEpic(epicId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM epics WHERE id = ?`).get(epicId)
}

export function listEpics(projectId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM epics WHERE project_id = ? ORDER BY order_index ASC`).all(projectId)
}

export function updateEpicStatus(epicId, status, db = null) {
  const targetDb = db || getOrchestratorDb()
  targetDb.prepare(`UPDATE epics SET status = ? WHERE id = ?`).run(status, epicId)
  return getEpic(epicId, targetDb)
}

/* ==========================================================================
 * Sprint Operations
 * ========================================================================== */

export function createSprint({
  id = null,
  projectId,
  name,
  goal = '',
  startDate = null,
  endDate = null,
  status = 'PLANNED',
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const sprintId = id || `sprint_${randomUUID().slice(0, 12)}`
  const now = Date.now()

  targetDb.prepare(`
    INSERT INTO sprints (id, project_id, name, goal, start_date, end_date, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sprintId, projectId, name, goal, startDate, endDate, status, now)

  return getSprint(sprintId, targetDb)
}

export function getSprint(sprintId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM sprints WHERE id = ?`).get(sprintId)
}

export function listSprints(projectId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM sprints WHERE project_id = ? ORDER BY created_at DESC`).all(projectId)
}

export function updateSprintStatus(sprintId, status, db = null) {
  const targetDb = db || getOrchestratorDb()
  targetDb.prepare(`UPDATE sprints SET status = ? WHERE id = ?`).run(status, sprintId)
  return getSprint(sprintId, targetDb)
}

/* ==========================================================================
 * Task Operations
 * ========================================================================== */

export function createTask({
  id = null,
  milestoneId,
  title,
  description = '',
  scopePaths = [],
  status = 'Backlog',
  waitingReason = null,
  blockedReason = null,
  blockedBy = [],
  worktreePath = null,
  maxRepairs = 3,
  epicId = null,
  sprintId = null,
  linkedRequirementIds = [],
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const taskId = id || `tsk_${randomUUID().slice(0, 12)}`
  const now = Date.now()

  targetDb.prepare(`
    INSERT INTO tasks (
      id, milestone_id, title, description, scope_paths_json, status,
      waiting_reason, blocked_reason, blocked_by_json, worktree_path,
      repair_attempts, max_repairs, created_at, updated_at,
      epic_id, sprint_id, linked_requirement_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    milestoneId,
    title,
    description,
    JSON.stringify(scopePaths),
    status,
    waitingReason,
    blockedReason,
    JSON.stringify(blockedBy),
    worktreePath,
    maxRepairs,
    now,
    now,
    epicId,
    sprintId,
    JSON.stringify(linkedRequirementIds),
  )

  return getTask(taskId, targetDb)
}

export function getTask(taskId, db = null) {
  const targetDb = db || getOrchestratorDb()
  const row = targetDb.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId)
  if (!row) return null

  return {
    ...row,
    scope_paths: JSON.parse(row.scope_paths_json || '[]'),
    blocked_by: JSON.parse(row.blocked_by_json || '[]'),
    linked_requirement_ids: JSON.parse(row.linked_requirement_ids_json || '[]'),
  }
}

export function listTasks(milestoneId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM tasks WHERE milestone_id = ? ORDER BY created_at ASC`).all(milestoneId).map((row) => ({
    ...row,
    scope_paths: JSON.parse(row.scope_paths_json || '[]'),
    blocked_by: JSON.parse(row.blocked_by_json || '[]'),
    linked_requirement_ids: JSON.parse(row.linked_requirement_ids_json || '[]'),
  }))
}

export function updateTaskStatus(taskId, { status, waitingReason = null, blockedReason = null }, db = null) {
  const targetDb = db || getOrchestratorDb()
  const now = Date.now()

  targetDb.prepare(`
    UPDATE tasks
    SET status = ?, waiting_reason = ?, blocked_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(status, waitingReason, blockedReason, now, taskId)

  return getTask(taskId, targetDb)
}

export function incrementTaskRepairAttempts(taskId, db = null) {
  const targetDb = db || getOrchestratorDb()
  const now = Date.now()

  targetDb.prepare(`
    UPDATE tasks
    SET repair_attempts = repair_attempts + 1, updated_at = ?
    WHERE id = ?
  `).run(now, taskId)

  return getTask(taskId, targetDb)
}

export function setTaskWorktree(taskId, worktreePath, db = null) {
  const targetDb = db || getOrchestratorDb()
  const now = Date.now()

  targetDb.prepare(`
    UPDATE tasks
    SET worktree_path = ?, updated_at = ?
    WHERE id = ?
  `).run(worktreePath, now, taskId)

  return getTask(taskId, targetDb)
}

/* ==========================================================================
 * Task Runs Operations
 * ========================================================================== */

export function createTaskRun({
  id = null,
  taskId,
  kind,
  role,
  model = null,
  provider = null,
  accountEmail = null,
  baseCommitSha = null,
  processPid = null,
  processStartTime = null,
  processCmdline = null,
  leaseExpiresAt = null,
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const runId = id || `run_${randomUUID().slice(0, 12)}`
  const now = Date.now()

  targetDb.prepare(`
    INSERT INTO task_runs (
      id, task_id, kind, role, model, provider, account_email,
      input_tokens, output_tokens, is_estimated, base_commit_sha,
      process_pid, process_start_time, process_cmdline, lease_expires_at,
      started_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, 'RUNNING')
  `).run(
    runId, taskId, kind, role, model, provider, accountEmail,
    baseCommitSha, processPid, processStartTime, processCmdline,
    leaseExpiresAt, now
  )

  return getTaskRun(runId, targetDb)
}

export function getTaskRun(runId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM task_runs WHERE id = ?`).get(runId)
}

export function getActiveTaskRun(taskId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`
    SELECT * FROM task_runs
    WHERE task_id = ? AND status IN ('RUNNING', 'PENDING')
    ORDER BY started_at DESC LIMIT 1
  `).get(taskId)
}

export function completeTaskRun(runId, {
  status = 'SUCCEEDED',
  candidateCommitSha = null,
  diffDigest = null,
  inputTokens = 0,
  outputTokens = 0,
  isEstimated = 0,
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const now = Date.now()

  targetDb.prepare(`
    UPDATE task_runs
    SET status = ?, candidate_commit_sha = ?, diff_digest = ?,
        input_tokens = ?, output_tokens = ?, is_estimated = ?, completed_at = ?
    WHERE id = ?
  `).run(status, candidateCommitSha, diffDigest, inputTokens, outputTokens, isEstimated ? 1 : 0, now, runId)

  return getTaskRun(runId, targetDb)
}

/* ==========================================================================
 * Verification Results Operations
 * ========================================================================== */

export function recordVerificationResult({
  id = null,
  taskRunId,
  command,
  exitCode,
  outputLog = '',
  verificationDigest,
  environmentInfo = {},
  passed,
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const verifId = id || `verif_${randomUUID().slice(0, 12)}`
  const now = Date.now()

  targetDb.prepare(`
    INSERT INTO verification_results (
      id, task_run_id, command, exit_code, output_log,
      verification_digest, environment_info_json, passed, executed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    verifId, taskRunId, command, exitCode, outputLog,
    verificationDigest, JSON.stringify(environmentInfo), passed ? 1 : 0, now
  )

  return targetDb.prepare(`SELECT * FROM verification_results WHERE id = ?`).get(verifId)
}

export function getVerificationResults(taskRunId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`
    SELECT * FROM verification_results
    WHERE task_run_id = ? ORDER BY executed_at ASC
  `).all(taskRunId).map((r) => ({
    ...r,
    environment_info: JSON.parse(r.environment_info_json || '{}'),
  }))
}

/* ==========================================================================
 * Review Records Operations
 * ========================================================================== */

export function recordReviewRecord({
  id = null,
  taskRunId,
  candidateCommitSha,
  diffDigest,
  verificationDigest,
  verdict,
  summary = '',
  findings = [],
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const reviewId = id || `rev_${randomUUID().slice(0, 12)}`
  const now = Date.now()

  targetDb.prepare(`
    INSERT INTO review_records (
      id, task_run_id, candidate_commit_sha, diff_digest,
      verification_digest, verdict, summary, findings_json, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reviewId, taskRunId, candidateCommitSha, diffDigest,
    verificationDigest, verdict, summary, JSON.stringify(findings), now
  )

  return targetDb.prepare(`SELECT * FROM review_records WHERE id = ?`).get(reviewId)
}

export function getReviewRecords(taskRunId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`
    SELECT * FROM review_records
    WHERE task_run_id = ? ORDER BY reviewed_at DESC
  `).all(taskRunId).map((r) => ({
    ...r,
    findings: JSON.parse(r.findings_json || '[]'),
  }))
}

/* ==========================================================================
 * Acceptance Records Operations
 * ========================================================================== */

export function recordAcceptance({
  id = null,
  taskId,
  candidateCommitSha,
  acceptedBy = 'owner',
  integratedCommitSha = null,
  integratedAt = null,
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const acceptId = id || `acc_${randomUUID().slice(0, 12)}`
  const now = Date.now()

  targetDb.prepare(`
    INSERT INTO acceptance_records (
      id, task_id, candidate_commit_sha, accepted_by, accepted_at,
      integrated_commit_sha, integrated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(acceptId, taskId, candidateCommitSha, acceptedBy, now, integratedCommitSha, integratedAt)

  return targetDb.prepare(`SELECT * FROM acceptance_records WHERE id = ?`).get(acceptId)
}

export function getAcceptanceRecord(taskId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM acceptance_records WHERE task_id = ? ORDER BY accepted_at DESC LIMIT 1`).get(taskId)
}

/* ==========================================================================
 * Audit Logs Operations
 * ========================================================================== */

export function recordAuditLog({
  id = null,
  projectId,
  taskId = null,
  eventType,
  actor = 'orchestrator',
  details = {},
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const logId = id || `audit_${randomUUID().slice(0, 12)}`
  const now = Date.now()

  targetDb.prepare(`
    INSERT INTO audit_logs (id, project_id, task_id, event_type, actor, details_json, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(logId, projectId, taskId, eventType, actor, JSON.stringify(details), now)

  return targetDb.prepare(`SELECT * FROM audit_logs WHERE id = ?`).get(logId)
}

export function listAuditLogs(projectId, db = null) {
  const targetDb = db || getOrchestratorDb()
  return targetDb.prepare(`SELECT * FROM audit_logs WHERE project_id = ? ORDER BY timestamp DESC`).all(projectId).map((l) => ({
    ...l,
    details: JSON.parse(l.details_json || '{}'),
  }))
}
