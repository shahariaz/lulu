import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startOrchestratorServer } from '../lib/orchestrator/api.mjs'
import { getOrchestratorDb, closeOrchestratorDb, getProject, getTask } from '../lib/orchestrator/db/index.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-council-api-'))
  return path.join(tmpDir, 'council-api.sqlite')
}

test('Council REST API: start session, execute turns with @mentions, teardown, and initialize project', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const serverInfo = await startOrchestratorServer({ port: 0, db })
  const { url } = serverInfo

  const tmpRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-council-repo-'))

  try {
    // 1. Start Council Session
    const startRes = await fetch(`${url}/api/orchestrator/council/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectName: 'Enterprise Event Bus',
        ideaDescription: 'High-throughput real-time event streaming engine for microservices.',
        targetPersona: 'enterprise architects',
      }),
    })
    assert.equal(startRes.status, 200)
    const { session, personas } = await startRes.json()
    assert.ok(session.id.startsWith('council_'))
    assert.ok(personas.pm)
    assert.ok(personas.designer)
    assert.ok(personas.architect)
    assert.ok(personas.pjm)

    // 2. Council Turn with @pm
    const pmRes = await fetch(`${url}/api/orchestrator/council/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        userMessage: '@pm who are the main competitors and what is our differentiator?',
        mockReply: 'Main competitors are Apache Kafka and RabbitMQ. Our differentiator is zero-JVM footprint and native SSE streaming.',
      }),
    })
    assert.equal(pmRes.status, 200)
    const pmData = await pmRes.json()
    assert.equal(pmData.targetRole, 'pm')
    assert.match(pmData.reply.content, /Kafka and RabbitMQ/)

    // 3. Competitor Teardown
    const tearRes = await fetch(`${url}/api/orchestrator/council/teardown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productIdea: 'Event Bus Engine',
        industryCategory: 'Messaging & Streaming',
      }),
    })
    assert.equal(tearRes.status, 200)
    const { teardown } = await tearRes.json()
    assert.ok(teardown.competitors.length >= 2)
    assert.ok(teardown.swotAnalysis.strengths.length > 0)

    // 4. Blueprint Synthesis
    const blueRes = await fetch(`${url}/api/orchestrator/council/blueprint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ideaTitle: 'Enterprise Event Bus',
        ideaDescription: 'Zero-JVM high-throughput event distributor.',
        techStack: 'Node.js 24 + TypeScript + SQLite WAL',
      }),
    })
    assert.equal(blueRes.status, 200)
    const { blueprint } = await blueRes.json()
    assert.ok(blueprint.market.uniqueDifferentiators.length >= 2)
    assert.ok(blueprint.prd.requirements.length >= 4)
    assert.ok(blueprint.architecture.databaseSchema.tables.length >= 2)

    // 5. One-Click Project Initializer from Blueprint
    const initRes = await fetch(`${url}/api/orchestrator/council/initialize-project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath: tmpRepoPath,
        projectName: 'Enterprise Event Bus',
        blueprint,
      }),
    })

    assert.equal(initRes.status, 201)
    const initData = await initRes.json()
    assert.equal(initData.success, true)
    assert.ok(initData.project.id)
    assert.equal(initData.baseline.status, 'APPROVED')
    assert.ok(initData.decomposition.tasks.length >= 2)

    // Verify git repo initialized and README created on disk
    assert.equal(fs.existsSync(path.join(tmpRepoPath, '.git')), true)
    assert.equal(fs.existsSync(path.join(tmpRepoPath, 'README.md')), true)

    // Verify first task is automatically in Ready status
    const firstTask = initData.decomposition.tasks[0]
    const dbTask = getTask(firstTask.id, db)
    assert.equal(dbTask.status, 'Ready')
  } finally {
    await serverInfo.close()
    closeOrchestratorDb()
    fs.rmSync(tmpRepoPath, { recursive: true, force: true })
  }
})
