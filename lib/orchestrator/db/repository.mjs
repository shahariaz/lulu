import {
  getOrchestratorDb,
  createProject,
  getProject,
  listProjects,
  deleteProject,
  createBaseline,
  getBaseline,
  getApprovedBaseline,
  approveBaseline,
  createMilestone,
  listMilestones,
  createEpic,
  getEpic,
  listEpics,
  updateEpicStatus,
  createSprint,
  getSprint,
  listSprints,
  updateSprintStatus,
  createTask,
  getTask,
  listTasks,
  updateTaskStatus,
  incrementTaskRepairAttempts,
  setTaskWorktree,
  createTaskRun,
  getTaskRun,
  getActiveTaskRun,
  completeTaskRun,
  recordVerificationResult,
  getVerificationResults,
  recordReviewRecord,
  getReviewRecords,
  recordAcceptance,
  getAcceptanceRecord,
  recordAuditLog,
  listAuditLogs,
} from './index.mjs'

/**
 * Abstract Base Storage Repository defining the data access contract.
 * Both SQLite and future PostgreSQL adapters implement this exact interface.
 */
export class StorageRepository {
  // Projects
  async createProject(params) { throw new Error('Not implemented') }
  async getProject(id) { throw new Error('Not implemented') }
  async listProjects() { throw new Error('Not implemented') }
  async deleteProject(id) { throw new Error('Not implemented') }

  // Baselines
  async createBaseline(params) { throw new Error('Not implemented') }
  async getBaseline(id) { throw new Error('Not implemented') }
  async getApprovedBaseline(projectId) { throw new Error('Not implemented') }
  async approveBaseline(id, approvedBy) { throw new Error('Not implemented') }

  // Milestones
  async createMilestone(params) { throw new Error('Not implemented') }
  async listMilestones(baselineId) { throw new Error('Not implemented') }

  // Epics
  async createEpic(params) { throw new Error('Not implemented') }
  async getEpic(id) { throw new Error('Not implemented') }
  async listEpics(projectId) { throw new Error('Not implemented') }
  async updateEpicStatus(id, status) { throw new Error('Not implemented') }

  // Sprints
  async createSprint(params) { throw new Error('Not implemented') }
  async getSprint(id) { throw new Error('Not implemented') }
  async listSprints(projectId) { throw new Error('Not implemented') }
  async updateSprintStatus(id, status) { throw new Error('Not implemented') }

  // Tasks
  async createTask(params) { throw new Error('Not implemented') }
  async getTask(id) { throw new Error('Not implemented') }
  async listTasks(milestoneId) { throw new Error('Not implemented') }
  async updateTaskStatus(id, update) { throw new Error('Not implemented') }
  async incrementTaskRepairAttempts(id) { throw new Error('Not implemented') }
  async setTaskWorktree(id, worktreePath) { throw new Error('Not implemented') }

  // Task Runs
  async createTaskRun(params) { throw new Error('Not implemented') }
  async getTaskRun(id) { throw new Error('Not implemented') }
  async getActiveTaskRun(taskId) { throw new Error('Not implemented') }
  async completeTaskRun(id, update) { throw new Error('Not implemented') }

  // Verification Results
  async recordVerificationResult(params) { throw new Error('Not implemented') }
  async getVerificationResults(taskRunId) { throw new Error('Not implemented') }

  // Reviews
  async recordReviewRecord(params) { throw new Error('Not implemented') }
  async getReviewRecords(taskRunId) { throw new Error('Not implemented') }

  // Acceptance Records
  async recordAcceptance(params) { throw new Error('Not implemented') }
  async getAcceptanceRecord(taskId) { throw new Error('Not implemented') }

  // Audit Logs
  async recordAuditLog(params) { throw new Error('Not implemented') }
  async listAuditLogs(projectId) { throw new Error('Not implemented') }

  // Health check
  async healthCheck() { throw new Error('Not implemented') }
}

/**
 * SQLite Implementation of StorageRepository.
 * Uses native Node.js DatabaseSync in WAL mode.
 */
export class SqliteStorageRepository extends StorageRepository {
  constructor(dbPath = null) {
    super()
    this.dbPath = dbPath
    this.db = getOrchestratorDb(dbPath)
  }

  async createProject(params) {
    return createProject(params, this.db)
  }

  async getProject(id) {
    return getProject(id, this.db)
  }

  async listProjects() {
    return listProjects(this.db)
  }

  async deleteProject(id) {
    return deleteProject(id, this.db)
  }

  async createBaseline(params) {
    return createBaseline(params, this.db)
  }

  async getBaseline(id) {
    return getBaseline(id, this.db)
  }

  async getApprovedBaseline(projectId) {
    return getApprovedBaseline(projectId, this.db)
  }

  async approveBaseline(id, approvedBy) {
    return approveBaseline(id, approvedBy, this.db)
  }

  async createMilestone(params) {
    return createMilestone(params, this.db)
  }

  async listMilestones(baselineId) {
    return listMilestones(baselineId, this.db)
  }

  async createEpic(params) {
    return createEpic(params, this.db)
  }

  async getEpic(id) {
    return getEpic(id, this.db)
  }

  async listEpics(projectId) {
    return listEpics(projectId, this.db)
  }

  async updateEpicStatus(id, status) {
    return updateEpicStatus(id, status, this.db)
  }

  async createSprint(params) {
    return createSprint(params, this.db)
  }

  async getSprint(id) {
    return getSprint(id, this.db)
  }

  async listSprints(projectId) {
    return listSprints(projectId, this.db)
  }

  async updateSprintStatus(id, status) {
    return updateSprintStatus(id, status, this.db)
  }

  async createTask(params) {
    return createTask(params, this.db)
  }

  async getTask(id) {
    return getTask(id, this.db)
  }

  async listTasks(milestoneId) {
    return listTasks(milestoneId, this.db)
  }

  async updateTaskStatus(id, update) {
    return updateTaskStatus(id, update, this.db)
  }

  async incrementTaskRepairAttempts(id) {
    return incrementTaskRepairAttempts(id, this.db)
  }

  async setTaskWorktree(id, worktreePath) {
    return setTaskWorktree(id, worktreePath, this.db)
  }

  async createTaskRun(params) {
    return createTaskRun(params, this.db)
  }

  async getTaskRun(id) {
    return getTaskRun(id, this.db)
  }

  async getActiveTaskRun(taskId) {
    return getActiveTaskRun(taskId, this.db)
  }

  async completeTaskRun(id, update) {
    return completeTaskRun(id, update, this.db)
  }

  async recordVerificationResult(params) {
    return recordVerificationResult(params, this.db)
  }

  async getVerificationResults(taskRunId) {
    return getVerificationResults(taskRunId, this.db)
  }

  async recordReviewRecord(params) {
    return recordReviewRecord(params, this.db)
  }

  async getReviewRecords(taskRunId) {
    return getReviewRecords(taskRunId, this.db)
  }

  async recordAcceptance(params) {
    return recordAcceptance(params, this.db)
  }

  async getAcceptanceRecord(taskId) {
    return getAcceptanceRecord(taskId, this.db)
  }

  async recordAuditLog(params) {
    return recordAuditLog(params, this.db)
  }

  async listAuditLogs(projectId) {
    return listAuditLogs(projectId, this.db)
  }

  async healthCheck() {
    const row = this.db.prepare('SELECT 1 as alive;').get()
    return {
      engine: 'sqlite',
      status: row?.alive === 1 ? 'healthy' : 'unhealthy',
      wal: true,
      path: this.dbPath || 'default',
    }
  }
}

/**
 * PostgreSQL Implementation of StorageRepository (Architecture Parity Blueprint).
 * Structured for future PostgreSQL activation via DATABASE_URL without changing application logic.
 */
export class PostgresStorageRepository extends StorageRepository {
  constructor(connectionString) {
    super()
    this.connectionString = connectionString
    // Intentionally uninstantiated until pg driver is loaded
  }

  async healthCheck() {
    return {
      engine: 'postgres',
      status: 'configured_for_future_migration',
      url: this.connectionString ? this.connectionString.replace(/:[^:@]+@/, ':***@') : null,
    }
  }
}

/**
 * Factory to create the active storage repository.
 * Detects DATABASE_URL or defaults to embedded SQLite.
 */
export function createStorageRepository({ dbPath = null, databaseUrl = null } = {}) {
  const url = databaseUrl || process.env.DATABASE_URL
  if (url && (url.startsWith('postgres://') || url.startsWith('postgresql://'))) {
    return new PostgresStorageRepository(url)
  }
  return new SqliteStorageRepository(dbPath)
}
