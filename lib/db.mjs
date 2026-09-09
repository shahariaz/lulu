import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

const DEFAULT_DB_DIR = path.join(os.homedir(), '.zen-claude')
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'zen-metrics.sqlite')

let dbInstance = null

export function getDb(customPath = null) {
  if (dbInstance) return dbInstance

  const dbPath = customPath || process.env.ZEN_DB_PATH || DEFAULT_DB_PATH
  const dir = path.dirname(dbPath)
  let createdDir = false
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    createdDir = true
  }
  if (createdDir || path.resolve(dir) === path.resolve(DEFAULT_DB_DIR)) fs.chmodSync(dir, 0o700)

  const db = new DatabaseSync(dbPath)
  fs.chmodSync(dbPath, 0o600)
  db.exec('PRAGMA busy_timeout = 10000;')
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      account_id TEXT,
      plan_type TEXT DEFAULT 'plus',
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      client_id TEXT,
      expires_at INTEGER,
      status TEXT DEFAULT 'active',
      last_used INTEGER,
      rate_limited_until INTEGER,
      rate_limit_reason TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      account_email TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      status TEXT DEFAULT 'success',
      error_message TEXT,
      tools_called TEXT,
      reasoning_effort TEXT,
      reasoning_tokens INTEGER DEFAULT 0,
      stop_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS rate_limit_events (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      provider TEXT NOT NULL,
      account_email TEXT NOT NULL,
      model TEXT,
      cooldown_ms INTEGER NOT NULL,
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS account_model_limits (
      provider TEXT NOT NULL,
      account_email TEXT NOT NULL,
      model TEXT NOT NULL,
      rate_limited_until INTEGER NOT NULL,
      reason TEXT,
      PRIMARY KEY (provider, account_email, model)
    );

    CREATE TABLE IF NOT EXISTS routing_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      tiers_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS routing_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_profile_id TEXT,
      activated_at INTEGER,
      FOREIGN KEY (active_profile_id) REFERENCES routing_profiles(id)
    );

    CREATE TABLE IF NOT EXISTS provider_model_catalog (
      provider TEXT PRIMARY KEY,
      models_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
    CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider);
    CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider);
    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
    CREATE INDEX IF NOT EXISTS idx_rle_timestamp ON rate_limit_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_account_model_limits_until ON account_model_limits(rate_limited_until);
  `)

  // Existing installations predate the diagnostic columns above. SQLite's
  // CREATE TABLE IF NOT EXISTS does not evolve a table, so migrate in place
  // without discarding the user's metrics history.
  const requestColumns = new Set(db.prepare('PRAGMA table_info(requests)').all().map((column) => column.name))
  const migrations = [
    ['reasoning_effort', 'TEXT'],
    ['reasoning_tokens', 'INTEGER DEFAULT 0'],
    ['stop_reason', 'TEXT'],
  ]
  for (const [name, definition] of migrations) {
    if (!requestColumns.has(name)) db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${definition}`)
  }

  // Analytics count provider turns, not internal proxy hops. Older
  // Antigravity traffic was recorded by both the dedicated gateway and the
  // outer Zen proxy. Keep raw rows for diagnostics, but expose a canonical
  // view that removes the synthetic outer-hop failures and paired successes.
  db.exec(`
    DROP VIEW IF EXISTS analytics_requests;
    CREATE VIEW analytics_requests AS
    WITH ordered AS (
      SELECT r.*,
        LAG(timestamp) OVER (
          PARTITION BY provider, model, COALESCE(account_email, ''), status,
            input_tokens, output_tokens, total_tokens, reasoning_tokens,
            COALESCE(stop_reason, '')
          ORDER BY timestamp, id
        ) AS previous_matching_timestamp
      FROM requests r
      WHERE NOT (provider = 'antigravity' AND account_email = 'antigravity-pool')
    )
    SELECT id, timestamp, provider, model, account_email,
      input_tokens, output_tokens, total_tokens, duration_ms, status,
      error_message, tools_called, reasoning_effort, reasoning_tokens, stop_reason
    FROM ordered
    WHERE NOT (
      provider = 'antigravity' AND status = 'success' AND
      previous_matching_timestamp IS NOT NULL AND
      timestamp - previous_matching_timestamp BETWEEN 0 AND 500
    );
  `)

  dbInstance = db
  return db
}

export function closeDb() {
  if (!dbInstance) return
  dbInstance.close()
  dbInstance = null
}

export function listRoutingProfiles() {
  return getDb().prepare(`
    SELECT p.*, CASE WHEN s.active_profile_id = p.id THEN 1 ELSE 0 END AS is_active
    FROM routing_profiles p
    LEFT JOIN routing_state s ON s.id = 1
    ORDER BY is_active DESC, p.name COLLATE NOCASE
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description || '',
    tiers: JSON.parse(row.tiers_json),
    is_active: !!row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }))
}

export function upsertRoutingProfile({ id, name, description = '', tiers }) {
  const db = getDb()
  const now = Date.now()
  const profileId = id || `profile_${randomUUID()}`
  db.prepare(`
    INSERT INTO routing_profiles (id, name, description, tiers_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      tiers_json = excluded.tiers_json,
      updated_at = excluded.updated_at
  `).run(profileId, name, description, JSON.stringify(tiers), now, now)
  return profileId
}

export function activateRoutingProfile(id) {
  const db = getDb()
  const exists = db.prepare('SELECT id FROM routing_profiles WHERE id = ?').get(id)
  if (!exists) throw new Error(`Routing profile not found: ${id}`)
  db.prepare(`
    INSERT INTO routing_state (id, active_profile_id, activated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET active_profile_id = excluded.active_profile_id, activated_at = excluded.activated_at
  `).run(id, Date.now())
}

export function deleteRoutingProfile(id) {
  const db = getDb()
  const active = db.prepare('SELECT active_profile_id FROM routing_state WHERE id = 1').get()
  if (active?.active_profile_id === id) throw new Error('Activate another profile before deleting this one')
  return db.prepare('DELETE FROM routing_profiles WHERE id = ?').run(id).changes > 0
}

export function saveProviderModelCatalog(provider, models) {
  getDb().prepare(`
    INSERT INTO provider_model_catalog (provider, models_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET models_json = excluded.models_json, updated_at = excluded.updated_at
  `).run(provider, JSON.stringify(models), Date.now())
}

export function getProviderModelCatalog(provider) {
  const row = getDb().prepare('SELECT models_json, updated_at FROM provider_model_catalog WHERE provider = ?').get(provider)
  if (!row) return null
  try {
    return { models: JSON.parse(row.models_json), updated_at: row.updated_at }
  } catch {
    return null
  }
}

export function recordRequest({
  provider = 'codex',
  model = 'unknown',
  accountEmail = null,
  inputTokens = 0,
  outputTokens = 0,
  durationMs = 0,
  status = 'success',
  errorMessage = null,
  toolsCalled = null,
  reasoningEffort = null,
  reasoningTokens = 0,
  stopReason = null,
}) {
  try {
    const db = getDb()
    const id = 'req_' + randomUUID()
    const timestamp = Date.now()
    const totalTokens = (inputTokens || 0) + (outputTokens || 0)
    const normalizedTools = Array.isArray(toolsCalled)
      ? toolsCalled.map((tool) => ({
          id: tool?.id || null,
          name: tool?.name || tool?.function?.name || String(tool || 'unknown'),
        }))
      : toolsCalled
    const toolsStr = Array.isArray(normalizedTools) ? JSON.stringify(normalizedTools) : normalizedTools

    const stmt = db.prepare(`
      INSERT INTO requests (
        id, timestamp, provider, model, account_email,
        input_tokens, output_tokens, total_tokens,
        duration_ms, status, error_message, tools_called,
        reasoning_effort, reasoning_tokens, stop_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      id,
      timestamp,
      provider,
      model,
      accountEmail,
      inputTokens || 0,
      outputTokens || 0,
      totalTokens,
      durationMs || 0,
      status,
      errorMessage,
      toolsStr,
      reasoningEffort,
      reasoningTokens || 0,
      stopReason,
    )
    return id
  } catch (err) {
    console.error('[DB] Failed to record request:', err.message)
    return null
  }
}

export function recordRateLimitEvent({
  provider = 'codex',
  accountEmail,
  model = null,
  cooldownMs = 3600000,
  reason = 'Usage limit reached',
}) {
  try {
    const db = getDb()
    const id = 'rle_' + randomUUID()
    const timestamp = Date.now()
    const stmt = db.prepare(`
      INSERT INTO rate_limit_events (id, timestamp, provider, account_email, model, cooldown_ms, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(id, timestamp, provider, accountEmail, model, cooldownMs, reason)
    return id
  } catch (err) {
    console.error('[DB] Failed to record rate limit event:', err.message)
    return null
  }
}

function calculatePercentiles(durations) {
  if (!durations || !durations.length) {
    return { p50: 0, p90: 0, p95: 0, p99: 0 }
  }
  const sorted = [...durations].sort((a, b) => a - b)
  const getP = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
    return sorted[idx]
  }
  return {
    p50: getP(50),
    p90: getP(90),
    p95: getP(95),
    p99: getP(99),
  }
}

function enrichPerformance(rows = []) {
  const maxRequests = Math.max(1, ...rows.map((row) => Number(row.request_count) || 0))
  return rows.map((row) => {
    const requests = Number(row.request_count) || 0
    const successes = Number(row.success_count) || 0
    const successRate = requests ? (successes / requests) * 100 : 0
    const latencyScore = 100 / (1 + (Number(row.avg_duration_ms) || 0) / 30000)
    const confidenceScore = Math.min(100, (Math.log1p(requests) / Math.log1p(maxRequests)) * 100)
    const performanceScore = requests >= 5
      ? 0.7 * successRate + 0.2 * latencyScore + 0.1 * confidenceScore
      : null
    return {
      ...row,
      success_rate: Number(successRate.toFixed(1)),
      avg_tokens_per_request: requests ? Math.round((Number(row.total_tokens) || 0) / requests) : 0,
      performance_score: performanceScore == null ? null : Number(performanceScore.toFixed(1)),
    }
  })
}

export function getStats() {
  try {
    const db = getDb()
    const now = Date.now()
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const todayTimestamp = startOfToday.getTime()
    const oneDayAgo = now - 86400000

    // Today stats
    const todayStmt = db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_requests,
        SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_requests,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_requests,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
        COALESCE(AVG(duration_ms), 0) as avg_duration_ms
      FROM analytics_requests
      WHERE timestamp >= ?
    `)
    const todayRaw = todayStmt.get(todayTimestamp)
    const successRateToday = todayRaw.total_requests > 0
      ? Number(((todayRaw.success_requests / todayRaw.total_requests) * 100).toFixed(1))
      : 100.0

    // Today durations for percentiles
    const todayDurationsStmt = db.prepare(`
      SELECT duration_ms FROM analytics_requests
      WHERE timestamp >= ? AND duration_ms > 0
    `)
    const todayDurations = todayDurationsStmt.all(todayTimestamp).map((r) => r.duration_ms)
    const percentiles = calculatePercentiles(todayDurations)

    const today = {
      ...todayRaw,
      success_rate: successRateToday,
      p50_duration_ms: percentiles.p50,
      p90_duration_ms: percentiles.p90,
      p95_duration_ms: percentiles.p95,
      p99_duration_ms: percentiles.p99,
    }

    // All time stats
    const allTimeStmt = db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_requests,
        SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_requests,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_requests,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
        COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
        COUNT(DISTINCT date(timestamp / 1000, 'unixepoch', 'localtime')) as active_days,
        MIN(timestamp) as first_request_at,
        MAX(timestamp) as last_request_at,
        SUM(CASE WHEN tools_called IS NOT NULL AND tools_called NOT IN ('', '[]') THEN 1 ELSE 0 END) as tool_turns
      FROM analytics_requests
    `)
    const allTimeRaw = allTimeStmt.get()
    const successRateAllTime = allTimeRaw.total_requests > 0
      ? Number(((allTimeRaw.success_requests / allTimeRaw.total_requests) * 100).toFixed(1))
      : 100.0

    const allTimeDurations = db.prepare(`
      SELECT duration_ms FROM analytics_requests WHERE duration_ms > 0
    `).all().map((row) => row.duration_ms)
    const allTimePercentiles = calculatePercentiles(allTimeDurations)
    const allTime = {
      ...allTimeRaw,
      success_rate: successRateAllTime,
      avg_tokens_per_request: allTimeRaw.total_requests
        ? Math.round(allTimeRaw.total_tokens / allTimeRaw.total_requests)
        : 0,
      p50_duration_ms: allTimePercentiles.p50,
      p95_duration_ms: allTimePercentiles.p95,
    }

    // Stats by provider
    const byProviderStmt = db.prepare(`
      SELECT
        provider,
        COUNT(*) as request_count,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
        COALESCE(AVG(duration_ms), 0) as avg_duration_ms
      FROM analytics_requests
      GROUP BY provider
      ORDER BY total_tokens DESC
    `)
    const byProvider = enrichPerformance(byProviderStmt.all())

    // Stats by model
    const byModelStmt = db.prepare(`
      SELECT
        model,
        provider,
        COUNT(*) as request_count,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
        COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
        MAX(timestamp) as last_seen
      FROM analytics_requests
      GROUP BY model, provider
      ORDER BY total_tokens DESC
      LIMIT 15
    `)
    const byModel = enrichPerformance(byModelStmt.all())

    // Stats by account
    const byAccountStmt = db.prepare(`
      SELECT
        COALESCE(account_email, 'anonymous') as email,
        provider,
        COUNT(*) as request_count,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
        SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(reasoning_tokens), 0) as reasoning_tokens,
        COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
        MAX(timestamp) as last_seen
      FROM analytics_requests
      GROUP BY account_email, provider
      ORDER BY total_tokens DESC
    `)
    const byAccount = enrichPerformance(byAccountStmt.all())

    // Hourly breakdown for past 24 hours (for sparklines)
    const hourly24h = []
    for (let h = 23; h >= 0; h--) {
      const hStart = now - (h + 1) * 3600000
      const hEnd = now - h * 3600000
      const hourDate = new Date(hEnd)
      const hLabel = hourDate.getHours() + ':00'

      const hStmt = db.prepare(`
        SELECT
          COUNT(*) as request_count,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limits
        FROM analytics_requests
        WHERE timestamp >= ? AND timestamp < ?
      `)
      const hRes = hStmt.get(hStart, hEnd)
      hourly24h.push({
        hour: hLabel,
        timestamp: hEnd,
        ...hRes,
      })
    }

    // Daily breakdown past 7 days
    const past7Days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      d.setHours(0, 0, 0, 0)
      const dayStart = d.getTime()
      const dayEnd = dayStart + 86400000
      const dayStmt = db.prepare(`
        SELECT
          COUNT(*) as request_count,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) as rate_limited_count,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
          COALESCE(SUM(input_tokens), 0) as input_tokens,
          COALESCE(SUM(output_tokens), 0) as output_tokens,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(AVG(duration_ms), 0) as avg_duration_ms
        FROM analytics_requests
        WHERE timestamp >= ? AND timestamp < ?
      `)
      const res = dayStmt.get(dayStart, dayEnd)
      past7Days.push({
        date: d.toISOString().split('T')[0],
        day_name: d.toLocaleDateString('en-US', { weekday: 'short' }),
        ...res,
      })
    }

    // Rate limit events in last 24h count
    const rle24hStmt = db.prepare(`
      SELECT COUNT(*) as count FROM rate_limit_events WHERE timestamp >= ?
    `)
    const rle24h = rle24hStmt.get(oneDayAgo)?.count || 0

    // Active accounts count
    const accountsCountStmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' AND (rate_limited_until IS NULL OR rate_limited_until <= ?) THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN rate_limited_until > ? THEN 1 ELSE 0 END) as rate_limited,
        SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) as invalid
      FROM accounts
    `)
    const accountsCount = accountsCountStmt.get(now, now)

    const eligibleAccounts = byAccount.filter((row) => row.performance_score != null && row.email !== 'anonymous')
    const eligibleModels = byModel.filter((row) => row.performance_score != null)
    const bestBy = (rows, field, direction = 'desc') => [...rows].sort((a, b) =>
      direction === 'asc' ? Number(a[field]) - Number(b[field]) : Number(b[field]) - Number(a[field]))[0] || null
    const leaders = {
      best_account: bestBy(eligibleAccounts, 'performance_score'),
      best_model: bestBy(eligibleModels, 'performance_score'),
      most_used_account: bestBy(byAccount.filter((row) => row.email !== 'anonymous'), 'total_tokens'),
      most_used_model: bestBy(byModel, 'total_tokens'),
      fastest_account: bestBy(eligibleAccounts, 'avg_duration_ms', 'asc'),
      fastest_model: bestBy(eligibleModels, 'avg_duration_ms', 'asc'),
      top_provider: bestBy(byProvider, 'total_tokens'),
    }

    return {
      today,
      all_time: allTime,
      by_provider: byProvider,
      by_model: byModel,
      by_account: byAccount,
      leaders,
      analytics_notes: {
        canonical_turns: true,
        historical_antigravity_duplicates_removed: true,
        performance_minimum_requests: 5,
      },
      hourly_24h: hourly24h,
      past_7_days: past7Days,
      rate_limit_events_24h: rle24h,
      accounts_summary: {
        total: accountsCount.total || 0,
        available: accountsCount.available || 0,
        rate_limited: accountsCount.rate_limited || 0,
        invalid: accountsCount.invalid || 0,
      },
    }
  } catch (err) {
    console.error('[DB] Failed to get stats:', err.message)
    return {
      today: { total_requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, success_rate: 100, avg_duration_ms: 0 },
      all_time: { total_requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, success_rate: 100 },
      by_provider: [],
      by_model: [],
      by_account: [],
      leaders: {},
      analytics_notes: { canonical_turns: true, performance_minimum_requests: 5 },
      hourly_24h: [],
      past_7_days: [],
      rate_limit_events_24h: 0,
      accounts_summary: { total: 0, available: 0, rate_limited: 0, invalid: 0 },
    }
  }
}

export function encodeCursor(timestamp, id) {
  if (timestamp == null || !id) return null
  try {
    return Buffer.from(JSON.stringify({ t: Number(timestamp), i: String(id) })).toString('base64url')
  } catch {
    return null
  }
}

export function decodeCursor(cursor) {
  if (!cursor) return null
  try {
    const raw = Buffer.from(String(cursor), 'base64url').toString('utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.t === 'number' && typeof parsed.i === 'string') {
      return { timestamp: parsed.t, id: parsed.i }
    }
  } catch {}
  if (typeof cursor === 'string' && cursor.includes(':')) {
    const [tsStr, id] = cursor.split(':')
    const ts = Number(tsStr)
    if (Number.isFinite(ts) && id) return { timestamp: ts, id }
  }
  const tsNum = Number(cursor)
  if (Number.isFinite(tsNum) && tsNum > 0) return { timestamp: tsNum, id: '' }
  return null
}

export function getRecentRequests({
  limit = 50,
  provider = null,
  model = null,
  status = null,
  search = null,
  cursor = null,
  direction = 'next',
  paginate = false,
} = {}) {
  try {
    const db = getDb()
    const conditions = []
    const params = []

    if (provider && provider !== 'all') {
      conditions.push('provider = ?')
      params.push(provider)
    }

    if (model && model !== 'all') {
      conditions.push('model = ?')
      params.push(model)
    }

    if (status && status !== 'all') {
      conditions.push('status = ?')
      params.push(status)
    }

    if (search && search.trim()) {
      const q = `%${search.trim()}%`
      conditions.push('(model LIKE ? OR account_email LIKE ? OR error_message LIKE ? OR tools_called LIKE ? OR reasoning_effort LIKE ? OR stop_reason LIKE ?)')
      params.push(q, q, q, q, q, q)
    }

    const baseWhere = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

    // Fast total count query for the active filters
    let totalCount = 0
    try {
      const countStmt = db.prepare(`SELECT COUNT(*) as total FROM requests ${baseWhere}`)
      totalCount = countStmt.get(...params)?.total || 0
    } catch {}

    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 50))
    const decoded = decodeCursor(cursor)
    const queryConditions = [...conditions]
    const queryParams = [...params]

    let isPrev = direction === 'prev' && decoded != null
    let hasPrev = false
    let hasMore = false

    if (decoded) {
      if (isPrev) {
        // Query items newer than the cursor
        if (decoded.id) {
          queryConditions.push('(timestamp > ? OR (timestamp = ? AND id > ?))')
          queryParams.push(decoded.timestamp, decoded.timestamp, decoded.id)
        } else {
          queryConditions.push('timestamp > ?')
          queryParams.push(decoded.timestamp)
        }
      } else {
        // Query items older than the cursor (next page)
        if (decoded.id) {
          queryConditions.push('(timestamp < ? OR (timestamp = ? AND id < ?))')
          queryParams.push(decoded.timestamp, decoded.timestamp, decoded.id)
        } else {
          queryConditions.push('timestamp < ?')
          queryParams.push(decoded.timestamp)
        }
      }
    }

    const whereClause = queryConditions.length > 0 ? 'WHERE ' + queryConditions.join(' AND ') : ''
    const orderDirection = isPrev ? 'ASC' : 'DESC'
    queryParams.push(safeLimit + 1)

    const query = `
      SELECT * FROM requests
      ${whereClause}
      ORDER BY timestamp ${orderDirection}, id ${orderDirection}
      LIMIT ?
    `
    const stmt = db.prepare(query)
    let rows = stmt.all(...queryParams)

    if (isPrev) {
      // When moving backwards (newer items), if we got extra rows, there are even newer records
      hasPrev = rows.length > safeLimit
      if (hasPrev) rows = rows.slice(0, safeLimit)
      // Reverse back to standard descending order (newest first)
      rows.reverse()
      // There are more older items because we came from an older page
      hasMore = true
    } else {
      // When moving forward (older items), if we got extra rows, there are more older records
      hasMore = rows.length > safeLimit
      if (hasMore) rows = rows.slice(0, safeLimit)
      hasPrev = Boolean(decoded)
    }

    const items = rows.map((row) => {
      let tools = []
      try {
        tools = row.tools_called ? JSON.parse(row.tools_called) : []
      } catch {
        tools = row.tools_called ? [{ id: null, name: String(row.tools_called) }] : []
      }
      return {
        ...row,
        tools_called: Array.isArray(tools) ? tools : [],
        tool_count: Array.isArray(tools) ? tools.length : 0,
      }
    })

    const nextCursor = (hasMore && items.length > 0)
      ? encodeCursor(items[items.length - 1].timestamp, items[items.length - 1].id)
      : null

    const prevCursor = (hasPrev && items.length > 0)
      ? encodeCursor(items[0].timestamp, items[0].id)
      : null

    if (paginate) {
      return {
        items,
        nextCursor,
        prevCursor,
        hasMore: Boolean(hasMore),
        hasPrev: Boolean(hasPrev),
        totalCount,
        limit: safeLimit,
      }
    }

    // Attach pagination metadata to array for backwards compatibility
    Object.assign(items, {
      nextCursor,
      prevCursor,
      hasMore: Boolean(hasMore),
      hasPrev: Boolean(hasPrev),
      totalCount,
      limit: safeLimit,
    })
    return items
  } catch (err) {
    console.error('[DB] Failed to get recent requests:', err.message)
    if (paginate) {
      return {
        items: [],
        nextCursor: null,
        prevCursor: null,
        hasMore: false,
        hasPrev: false,
        totalCount: 0,
        limit: Math.min(500, Math.max(1, Number(limit) || 50)),
      }
    }
    return []
  }
}

export function getRateLimitEvents(limit = 30) {
  try {
    const db = getDb()
    const stmt = db.prepare(`
      SELECT * FROM rate_limit_events
      ORDER BY timestamp DESC
      LIMIT ?
    `)
    return stmt.all(limit)
  } catch (err) {
    console.error('[DB] Failed to get rate limit events:', err.message)
    return []
  }
}

export function getAccounts(provider = null) {
  try {
    const db = getDb()
    if (provider) {
      const stmt = db.prepare('SELECT * FROM accounts WHERE provider = ? ORDER BY created_at ASC')
      return stmt.all(provider)
    }
    const stmt = db.prepare('SELECT * FROM accounts ORDER BY provider, created_at ASC')
    return stmt.all()
  } catch (err) {
    console.error('[DB] Failed to get accounts:', err.message)
    return []
  }
}

export function upsertAccount(account) {
  try {
    const db = getDb()
    const now = Date.now()
    const id = account.id || ('acc_' + randomUUID())

    const stmt = db.prepare(`
      INSERT INTO accounts (
        id, provider, email, name, account_id, plan_type,
        access_token, refresh_token, id_token, client_id,
        expires_at, status, last_used, rate_limited_until,
        rate_limit_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        account_id = excluded.account_id,
        plan_type = excluded.plan_type,
        access_token = COALESCE(excluded.access_token, accounts.access_token),
        refresh_token = COALESCE(excluded.refresh_token, accounts.refresh_token),
        id_token = COALESCE(excluded.id_token, accounts.id_token),
        client_id = COALESCE(excluded.client_id, accounts.client_id),
        expires_at = COALESCE(excluded.expires_at, accounts.expires_at),
        status = excluded.status,
        last_used = COALESCE(excluded.last_used, accounts.last_used),
        rate_limited_until = excluded.rate_limited_until,
        rate_limit_reason = excluded.rate_limit_reason
    `)

    stmt.run(
      id,
      account.provider || 'codex',
      account.email,
      account.name || null,
      account.account_id || null,
      account.plan_type || 'plus',
      account.access_token || null,
      account.refresh_token || null,
      account.id_token || null,
      account.client_id || null,
      account.expires_at || null,
      account.status || 'active',
      account.last_used || null,
      account.rate_limited_until || null,
      account.rate_limit_reason || null,
      account.created_at || now,
    )
    return id
  } catch (err) {
    console.error('[DB] Failed to upsert account:', err.message)
    return null
  }
}

export function deleteAccount(id) {
  try {
    const db = getDb()
    const stmt = db.prepare('DELETE FROM accounts WHERE id = ? OR email = ?')
    stmt.run(id, id)
    return true
  } catch (err) {
    console.error('[DB] Failed to delete account:', err.message)
    return false
  }
}

export function updateAccountTokens(id, { accessToken, refreshToken, idToken, expiresAt }) {
  try {
    const db = getDb()
    const stmt = db.prepare(`
      UPDATE accounts
      SET access_token = ?, refresh_token = COALESCE(?, refresh_token), id_token = COALESCE(?, id_token), expires_at = ?
      WHERE id = ? OR email = ?
    `)
    stmt.run(accessToken, refreshToken || null, idToken || null, expiresAt, id, id)
    return true
  } catch (err) {
    console.error('[DB] Failed to update account tokens:', err.message)
    return false
  }
}

export function updateAccountRateLimitState(id, { until = null, reason = null } = {}) {
  try {
    const stmt = getDb().prepare(`
      UPDATE accounts
      SET rate_limited_until = ?, rate_limit_reason = ?,
          status = CASE WHEN ? IS NOT NULL AND ? > ? THEN 'rate_limited' ELSE 'active' END
      WHERE id = ?
    `)
    stmt.run(until, reason, until, until, Date.now(), id)
    return true
  } catch (err) {
    console.error('[DB] Failed to update account rate-limit state:', err.message)
    return false
  }
}

export function markAccountRateLimited(email, provider = 'codex', cooldownMs = 3600000, reason = 'Rate limit reached', model = null) {
  try {
    const db = getDb()
    const now = Date.now()
    const until = now + cooldownMs

    const stmt = db.prepare(`
      UPDATE accounts
      SET rate_limited_until = ?, rate_limit_reason = ?
      WHERE email = ? AND provider = ?
    `)
    stmt.run(until, reason, email, provider)

    recordRateLimitEvent({
      provider,
      accountEmail: email,
      model,
      cooldownMs,
      reason,
    })
    return true
  } catch (err) {
    console.error('[DB] Failed to mark rate limited:', err.message)
    return false
  }
}

export function markAccountModelRateLimited(email, provider, model, cooldownMs = 60000, reason = 'Model rate limit reached') {
  try {
    const now = Date.now()
    const until = now + cooldownMs
    getDb().prepare(`
      INSERT INTO account_model_limits (provider, account_email, model, rate_limited_until, reason)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, account_email, model) DO UPDATE SET
        rate_limited_until = MAX(rate_limited_until, excluded.rate_limited_until),
        reason = excluded.reason
    `).run(provider, email, model, until, reason)
    recordRateLimitEvent({ provider, accountEmail: email, model, cooldownMs, reason })
    return true
  } catch (err) {
    console.error('[DB] Failed to mark model rate limited:', err.message)
    return false
  }
}

export function getAccountModelRateLimits(provider, email = null) {
  try {
    const db = getDb()
    db.prepare('DELETE FROM account_model_limits WHERE rate_limited_until <= ?').run(Date.now())
    if (email) {
      return db.prepare(`
        SELECT provider, account_email, model, rate_limited_until, reason
        FROM account_model_limits
        WHERE provider = ? AND account_email = ?
        ORDER BY rate_limited_until ASC
      `).all(provider, email)
    }
    return db.prepare(`
      SELECT provider, account_email, model, rate_limited_until, reason
      FROM account_model_limits
      WHERE provider = ?
      ORDER BY rate_limited_until ASC
    `).all(provider)
  } catch (err) {
    console.error('[DB] Failed to read model rate limits:', err.message)
    return []
  }
}

export function clearAccountModelRateLimits(provider = null) {
  try {
    const db = getDb()
    if (provider) db.prepare('DELETE FROM account_model_limits WHERE provider = ?').run(provider)
    else db.prepare('DELETE FROM account_model_limits').run()
    return true
  } catch (err) {
    console.error('[DB] Failed to clear model rate limits:', err.message)
    return false
  }
}

export function clearRateLimits(provider = null) {
  try {
    const db = getDb()
    if (provider) {
      const stmt = db.prepare('UPDATE accounts SET rate_limited_until = NULL, rate_limit_reason = NULL WHERE provider = ?')
      stmt.run(provider)
      db.prepare('DELETE FROM account_model_limits WHERE provider = ?').run(provider)
    } else {
      const stmt = db.prepare('UPDATE accounts SET rate_limited_until = NULL, rate_limit_reason = NULL')
      stmt.run()
      db.prepare('DELETE FROM account_model_limits').run()
    }
    return true
  } catch (err) {
    console.error('[DB] Failed to clear rate limits:', err.message)
    return false
  }
}

export function touchAccountLastUsed(idOrEmail) {
  try {
    const db = getDb()
    const stmt = db.prepare('UPDATE accounts SET last_used = ? WHERE id = ? OR email = ?')
    stmt.run(Date.now(), idOrEmail, idOrEmail)
    return true
  } catch (err) {
    return false
  }
}
