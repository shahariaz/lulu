import fs from 'node:fs'
import path from 'node:path'

/**
 * Migration runner for Claude-Zen Orchestrator.
 * Uses sequential, versioned SQL migration scripts executed transactionally.
 */
export function initMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)
}

export function getAppliedMigrations(db) {
  initMigrationTable(db)
  return db.prepare(`SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC`).all()
}

export function runMigrations(db, migrationsDir = null) {
  const dir = migrationsDir || path.join(import.meta.dirname, 'migrations')
  initMigrationTable(db)

  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`)
  }

  const files = fs.readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  const appliedList = getAppliedMigrations(db)
  const appliedVersions = new Set(appliedList.map((m) => m.version))
  const newlyApplied = []

  for (const file of files) {
    const match = file.match(/^(\d+)_(.+)\.sql$/)
    if (!match) continue

    const version = parseInt(match[1], 10)
    const name = match[2]

    if (appliedVersions.has(version)) {
      continue
    }

    const filePath = path.join(dir, file)
    const sql = fs.readFileSync(filePath, 'utf8')

    // Execute migration in an explicit transaction
    try {
      db.exec('BEGIN IMMEDIATE;')
      db.exec(sql)
      db.prepare(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (?, ?, ?)
      `).run(version, name, Date.now())
      db.exec('COMMIT;')
      newlyApplied.push({ version, name, file })
    } catch (err) {
      try {
        db.exec('ROLLBACK;')
      } catch {}
      throw new Error(`Migration ${file} (v${version}) failed: ${err.message}`)
    }
  }

  return {
    applied: newlyApplied,
    totalApplied: appliedList.length + newlyApplied.length,
  }
}
