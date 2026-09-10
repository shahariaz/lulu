import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startOrchestratorServer } from '../lib/orchestrator/api.mjs'
import { getOrchestratorDb, closeOrchestratorDb, getProject, getTask } from '../lib/orchestrator/db/index.mjs'

// This suite drives the HTTP API with caller-supplied mock model output. That is refused by
// default (see lib/orchestrator/http/shared.mjs — a request must never be able to fabricate
// content indistinguishable from real model output). Opt in explicitly for these tests only;
// test/mock-injection-gate.test.mjs asserts the default stays OFF.
process.env.ZEN_ALLOW_MOCK_INJECTION = '1'

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
    const research = {
      competitors: [{ name: 'Kafka', url: 'https://kafka.apache.org', positioning: 'Distributed event streaming', pricing: 'Open source', strengths: ['Throughput'], weaknesses: ['JVM operations'] }],
      marketSize: 'Unknown', differentiators: ['Small operational footprint'], risks: ['Crowded category'],
      sources: [{ title: 'Apache Kafka', url: 'https://kafka.apache.org' }],
    }
    const mockBlueprint = {
      market: { coreValueProp: 'A small-footprint event bus', targetAudience: 'Platform engineers', competitors: [{ name: 'Kafka', positioning: 'Distributed streaming', url: 'https://kafka.apache.org' }], uniqueDifferentiators: ['Zero-JVM operation'] },
      prd: { executiveSummary: 'Build a small event distributor.', inScope: ['Publish and subscribe'], outOfScope: ['Managed hosting'], requirements: [{ id: 'REQ-F-01', title: 'Publish event', description: 'Accept and distribute an event.', acceptanceCriteria: ['Given a subscriber, when an event is published, then the subscriber receives it.'], priority: 'MUST' }] },
      userJourneys: [{ persona: 'Platform engineer', goal: 'Distribute an event', steps: ['Create topic', 'Publish event'] }],
      architecture: { techStack: 'Node.js 24 + SQLite', databaseSchema: { tables: [{ name: 'events', columns: ['id TEXT PRIMARY KEY'] }] }, apiContracts: [{ method: 'POST', path: '/events', purpose: 'Publish an event' }] },
      roadmap: { milestones: [{ title: 'Event delivery', tasks: [{ title: 'Implement event store', description: 'Persist and dispatch events' }] }] },
    }
    const mockDecomposition = {
      milestoneTitle: 'MVP Event Delivery',
      epics: [{ title: 'Event Core', description: 'Publish and subscribe', features: [{ title: 'Publish events', description: 'Accept events', acceptanceCriteria: ['Published events reach subscribers.'], linkedRequirementIds: ['REQ-F-01'], tasks: [{ tempId: 't1', title: 'Implement event store', description: 'Store events', scopePaths: ['src/events.mjs'], acceptanceCriteria: ['The event store persists a valid event.'], linkedRequirementIds: ['REQ-F-01'], blockedBy: [] }] }] }],
    }
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
        ideaDescription: 'Small event distributor',
        sessionId: session.id,
        mockResearch: research,
      }),
    })
    assert.equal(tearRes.status, 200)
    const { teardown } = await tearRes.json()
    assert.equal(teardown.competitors[0].name, 'Kafka')
    assert.ok(teardown.sources.length > 0)

    // 4. Blueprint Synthesis
    const blueRes = await fetch(`${url}/api/orchestrator/council/blueprint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ideaTitle: 'Enterprise Event Bus',
        ideaDescription: 'Zero-JVM high-throughput event distributor.',
        sessionId: session.id,
        mockBlueprint,
      }),
    })
    assert.equal(blueRes.status, 200)
    const { blueprint } = await blueRes.json()
    assert.ok(blueprint.market.uniqueDifferentiators.length >= 1)
    assert.ok(blueprint.prd.requirements[0].acceptanceCriteria.length >= 1)
    assert.ok(blueprint.architecture.databaseSchema.tables.length >= 1)

    // 5. One-Click Project Initializer from Blueprint
    const initRes = await fetch(`${url}/api/orchestrator/council/initialize-project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath: tmpRepoPath,
        projectName: 'Enterprise Event Bus',
        sessionId: session.id,
        blueprint,
        mockDecomposition,
      }),
    })

    assert.equal(initRes.status, 201)
    const initData = await initRes.json()
    assert.equal(initData.success, true)
    assert.ok(initData.project.id)
    assert.equal(initData.baseline.status, 'APPROVED')
    assert.equal(initData.decomposition.tasks.length, 1)
    assert.equal(initData.decomposition.features.length, 1)

    // Verify git repo initialized and README created on disk
    assert.equal(fs.existsSync(path.join(tmpRepoPath, '.git')), true)
    assert.equal(fs.existsSync(path.join(tmpRepoPath, 'README.md')), true)

    // Verify first task is automatically in Ready status
    const firstTask = initData.decomposition.tasks[0]
    const dbTask = getTask(firstTask.id, db)
    assert.equal(dbTask.status, 'Ready')
    assert.deepEqual(dbTask.linked_requirement_ids, ['REQ-F-01'])
    assert.deepEqual(dbTask.acceptance_criteria, ['The event store persists a valid event.'])
  } finally {
    await serverInfo.close()
    closeOrchestratorDb()
    fs.rmSync(tmpRepoPath, { recursive: true, force: true })
  }
})
