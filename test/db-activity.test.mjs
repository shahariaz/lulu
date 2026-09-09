import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeDb, getDb, getRecentRequests, getStats, recordRequest } from '../lib/db.mjs'

test('migrates existing request history and returns normalized diagnostics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-activity-'))
  const dbPath = path.join(dir, 'metrics.sqlite')
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE requests (
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
      tools_called TEXT
    );
  `)
  legacy.close()

  try {
    const db = getDb(dbPath)
    const columns = new Set(db.prepare('PRAGMA table_info(requests)').all().map(column => column.name))
    assert.ok(columns.has('reasoning_effort'))
    assert.ok(columns.has('reasoning_tokens'))
    assert.ok(columns.has('stop_reason'))

    recordRequest({
      provider: 'antigravity',
      model: 'gemini-test',
      accountEmail: 'pool@example.com',
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 321,
      toolsCalled: [{ id: 'tool_1', name: 'Read', input: { secret: true } }],
      reasoningEffort: 'high',
      reasoningTokens: 3,
      stopReason: 'tool_use',
    })

    const [request] = getRecentRequests({ provider: 'antigravity' })
    assert.equal(request.total_tokens, 15)
    assert.equal(request.reasoning_effort, 'high')
    assert.equal(request.reasoning_tokens, 3)
    assert.equal(request.stop_reason, 'tool_use')
    assert.equal(request.tool_count, 1)
    assert.deepEqual(request.tools_called, [{ id: 'tool_1', name: 'Read' }])
    assert.doesNotMatch(JSON.stringify(request.tools_called), /secret/)
  } finally {
    closeDb()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('supports cursor-based pagination for request activity history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-cursor-'))
  const dbPath = path.join(dir, 'metrics.sqlite')

  try {
    const db = getDb(dbPath)
    // Insert 5 test requests with known staggered timestamps
    const now = Date.now()
    for (let i = 1; i <= 5; i++) {
      db.prepare(`
        INSERT INTO requests (
          id, timestamp, provider, model, account_email,
          input_tokens, output_tokens, total_tokens,
          duration_ms, status, tools_called
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `req_test_${i}`,
        now + i * 1000,
        i % 2 === 0 ? 'codex' : 'antigravity',
        `model-${i}`,
        `user${i}@example.com`,
        10 * i,
        5 * i,
        15 * i,
        100 * i,
        'success',
        JSON.stringify([{ id: `t${i}`, name: `tool_${i}` }])
      )
    }

    // Page 1: limit 2, paginate: true
    const page1 = getRecentRequests({ limit: 2, paginate: true })
    assert.equal(page1.items.length, 2)
    assert.equal(page1.items[0].id, 'req_test_5')
    assert.equal(page1.items[1].id, 'req_test_4')
    assert.equal(page1.hasMore, true)
    assert.equal(page1.hasPrev, false)
    assert.ok(page1.nextCursor)
    assert.equal(page1.totalCount, 5)

    // Page 2: using page1.nextCursor
    const page2 = getRecentRequests({ limit: 2, cursor: page1.nextCursor, direction: 'next', paginate: true })
    assert.equal(page2.items.length, 2)
    assert.equal(page2.items[0].id, 'req_test_3')
    assert.equal(page2.items[1].id, 'req_test_2')
    assert.equal(page2.hasMore, true)
    assert.equal(page2.hasPrev, true)
    assert.ok(page2.nextCursor)

    // Page 3 (last page): using page2.nextCursor
    const page3 = getRecentRequests({ limit: 2, cursor: page2.nextCursor, direction: 'next', paginate: true })
    assert.equal(page3.items.length, 1)
    assert.equal(page3.items[0].id, 'req_test_1')
    assert.equal(page3.hasMore, false)
    assert.equal(page3.hasPrev, true)

    // Move backwards from page 2 to page 1 using prevCursor
    const backToPage1 = getRecentRequests({ limit: 2, cursor: page2.prevCursor, direction: 'prev', paginate: true })
    assert.equal(backToPage1.items.length, 2)
    assert.equal(backToPage1.items[0].id, 'req_test_5')
    assert.equal(backToPage1.items[1].id, 'req_test_4')
  } finally {
    closeDb()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('lifetime analytics de-duplicate proxy hops and rank established performers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zen-analytics-'))
  const dbPath = path.join(dir, 'metrics.sqlite')

  try {
    const db = getDb(dbPath)
    const now = Date.now()
    const insert = db.prepare(`
      INSERT INTO requests (
        id, timestamp, provider, model, account_email,
        input_tokens, output_tokens, total_tokens, duration_ms, status,
        tools_called, reasoning_tokens, stop_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (let index = 0; index < 5; index++) {
      insert.run(
        `codex_${index}`, now - (index + 1) * 1000, 'codex', 'gpt-test',
        'steady@example.com', 100, 50, 150, 1000, 'success',
        index === 0 ? '[{"name":"Read"}]' : null, 10, 'end_turn',
      )
    }

    // The legacy outer proxy recorded the same successful Antigravity turn a
    // few milliseconds after its dedicated gateway, plus a synthetic pool hop.
    insert.run('ag_canonical', now, 'antigravity', 'claude-test', 'google@example.com', 20, 10, 30, 500, 'success', null, 0, 'end_turn')
    insert.run('ag_duplicate', now + 100, 'antigravity', 'claude-test', 'google@example.com', 20, 10, 30, 510, 'success', null, 0, 'end_turn')
    insert.run('ag_pool', now + 110, 'antigravity', 'claude-test', 'antigravity-pool', 0, 0, 0, 5, 'rate_limited', null, 0, null)

    const rawCount = db.prepare('SELECT COUNT(*) AS count FROM requests').get().count
    const stats = getStats()

    assert.equal(rawCount, 8, 'diagnostic history remains intact')
    assert.equal(stats.all_time.total_requests, 6, 'dashboard counts canonical provider turns')
    assert.equal(stats.all_time.total_tokens, 780)
    assert.equal(stats.all_time.tool_turns, 1)
    assert.equal(stats.analytics_notes.historical_antigravity_duplicates_removed, true)
    assert.equal(stats.leaders.best_account.email, 'steady@example.com')
    assert.equal(stats.leaders.best_model.model, 'gpt-test')
    assert.ok(stats.leaders.best_account.performance_score > 90)
  } finally {
    closeDb()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
