import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseMentionTarget,
  startCouncilSession,
  executeCouncilTurn,
  executeCouncilDebate,
  generateCompetitorTeardown,
  synthesizeProductBlueprint,
  researchMarket,
  getCouncilSession,
  COUNCIL_PERSONAS,
} from '../lib/orchestrator/council-engine.mjs'
import { getOrchestratorDb, closeOrchestratorDb, createProject } from '../lib/orchestrator/db/index.mjs'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-council-engine-'))
  return getOrchestratorDb(path.join(dir, 'test.sqlite'))
}

const TEST_RESEARCH = {
  competitors: [{
    name: 'AuditCo', url: 'https://audit.example', positioning: 'Compliance event storage',
    pricing: 'Unknown', strengths: ['Retention controls'], weaknesses: ['No local mode'],
  }],
  marketSize: 'Unknown',
  differentiators: ['Local verification'],
  risks: ['Long enterprise sales cycle'],
  sources: [{ title: 'AuditCo product', url: 'https://audit.example' }],
}

function blueprintFor(title = 'Audit trail') {
  return {
    market: {
      coreValueProp: `${title} with verifiable local evidence`, targetAudience: 'Compliance engineers',
      competitors: [{ name: 'AuditCo', positioning: 'Hosted audit logs', url: 'https://audit.example' }],
      uniqueDifferentiators: ['Local custody'],
    },
    prd: {
      executiveSummary: `Build ${title}`,
      inScope: ['Append events'], outOfScope: ['SaaS billing'],
      requirements: [{
        id: 'REQ-F-01', title: `Deliver ${title}`, description: `Store one immutable ${title} event.`,
        acceptanceCriteria: [`Given valid ${title} data, when it is appended, then it can be read by ID.`], priority: 'MUST',
      }],
    },
    userJourneys: [{ persona: 'Auditor', goal: 'Inspect an event', steps: ['Open event', 'Verify digest'] }],
    architecture: {
      techStack: 'Node.js 24 + SQLite',
      databaseSchema: { tables: [{ name: 'events', columns: ['id TEXT PRIMARY KEY'] }] },
      apiContracts: [{ method: 'POST', path: '/events', purpose: 'Append event' }],
    },
    roadmap: { milestones: [{ title: 'Foundation', tasks: [{ title: 'Store events', description: 'Implement persistence' }] }] },
  }
}

test('parseMentionTarget detects agent roles from text', () => {
  assert.equal(parseMentionTarget('@pm what are our top competitors?'), 'pm')
  assert.equal(parseMentionTarget('@designer create an onboarding flow'), 'designer')
  assert.equal(parseMentionTarget('@ux design linear-style dark mode'), 'designer')
  assert.equal(parseMentionTarget('@architect design PostgreSQL schema'), 'architect')
  assert.equal(parseMentionTarget('@tech recommend stack'), 'architect')
  assert.equal(parseMentionTarget('@pjm break into milestones'), 'pjm')
  assert.equal(parseMentionTarget('@delivery what is our MVP?'), 'pjm')
  assert.equal(parseMentionTarget('Hello team, let us review the idea'), 'council')
})

test('startCouncilSession and executeCouncilTurn support multi-persona advisory dialogue', async () => {
  const session = startCouncilSession({
    projectName: 'Enterprise Newsletter Engine',
    ideaDescription: 'Self-hosted Substack alternative for engineering teams.',
  })

  assert.ok(session.id.startsWith('council_'))
  assert.equal(session.messages.length, 1)
  assert.equal(session.messages[0].agent.id, 'council')

  // 1. Ask PM
  const pmTurn = await executeCouncilTurn({
    sessionId: session.id,
    userMessage: '@pm who are the main competitors and what is our differentiator?',
    mockReply: 'Main competitors are Substack and Ghost. Our differentiator is local privacy and self-hosting.',
  })

  assert.equal(pmTurn.targetRole, 'pm')
  assert.equal(pmTurn.reply.agent.id, 'pm')
  assert.match(pmTurn.reply.content, /Substack and Ghost/)

  // 2. Ask Architect
  const archTurn = await executeCouncilTurn({
    sessionId: session.id,
    userMessage: '@architect propose data models for subscribers and newsletters',
    mockReply: 'Recommended schema: subscribers (id, email, status) and newsletters (id, title, content_markdown).',
  })

  assert.equal(archTurn.targetRole, 'architect')
  assert.equal(archTurn.reply.agent.id, 'architect')
  assert.match(archTurn.reply.content, /subscribers/)

  // Total messages in session: 1 intro + 2 user + 2 assistant = 5
  assert.equal(archTurn.session.messages.length, 5)
})

test('council transcripts survive closing and reopening the database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-council-restart-'))
  const dbPath = path.join(dir, 'restart.sqlite')
  let db = getOrchestratorDb(dbPath)
  const session = startCouncilSession({ projectName: 'Restart Safe', ideaDescription: 'Durable product decisions' }, db)
  await executeCouncilTurn({ sessionId: session.id, userMessage: '@pm preserve this decision', mockReply: 'Decision preserved.', db })
  closeOrchestratorDb()

  db = getOrchestratorDb(dbPath)
  const restored = getCouncilSession(session.id, db)
  assert.equal(restored.projectName, 'Restart Safe')
  assert.equal(restored.messages.length, 3)
  assert.equal(restored.messages.at(-1).content, 'Decision preserved.')
  closeOrchestratorDb()
})

test('executeCouncilDebate sequences all 4 specialists and invokes onTurn callbacks', async () => {
  const db = tempDb()
  const session = startCouncilSession({ projectName: 'Debate Test App', ideaDescription: 'Fast local search' }, db)

  const turnsSeen = []
  const result = await executeCouncilDebate({
    sessionId: session.id,
    userPrompt: 'Review our fast local search concept',
    mockReplies: {
      pm: 'PM: Market size is strong, focus on local latency as key differentiator.',
      architect: 'Architect: Use SQLite full-text search with BM25 ranking.',
      designer: 'Designer: Single omnibox search input with instant keyboard navigation.',
      pjm: 'PjM: Milestone 1 bounds ingestion and indexing; query UI is Milestone 2.',
    },
    onTurn: (role, turnResult) => {
      turnsSeen.push({ role, title: turnResult.reply.agent.title })
    },
    db,
  })

  assert.equal(result.turns.length, 4)
  assert.equal(turnsSeen.length, 4)
  assert.equal(turnsSeen[0].role, 'pm')
  assert.equal(turnsSeen[1].role, 'architect')
  assert.equal(turnsSeen[2].role, 'designer')
  assert.equal(turnsSeen[3].role, 'pjm')

  // Total messages in session: 1 intro + 4 user prompts + 4 assistant replies = 9 messages
  assert.equal(result.session.messages.length, 9)
  assert.match(result.session.messages[2].content, /PM: Market size/)
  assert.match(result.session.messages[4].content, /Architect: Use SQLite/)
  assert.match(result.session.messages[6].content, /Designer: Single omnibox/)
  assert.match(result.session.messages[8].content, /PjM: Milestone 1/)

  closeOrchestratorDb()
})

test('researchMarket returns structured sourced analysis and persists it', async () => {
  const db = tempDb()
  const session = startCouncilSession({ projectName: 'Audit Tool', ideaDescription: 'Local audit evidence' }, db)
  const teardown = await researchMarket({
    ideaTitle: 'Audit Tool',
    ideaDescription: 'Local audit evidence',
    sessionId: session.id,
    db,
    runner: async () => ({ exitCode: 0, stdout: JSON.stringify(TEST_RESEARCH), stderr: '' }),
  })

  assert.equal(teardown.competitors[0].name, 'AuditCo')
  assert.equal(teardown.sources[0].url, 'https://audit.example')
  assert.deepEqual(getCouncilSession(session.id, db).marketResearch, TEST_RESEARCH)
  closeOrchestratorDb()
})

test('generateCompetitorTeardown is a fail-closed compatibility wrapper', async () => {
  const teardown = await generateCompetitorTeardown({
    productIdea: 'Self-Hosted AI Code Delivery Platform',
    runner: async () => ({ exitCode: 0, stdout: JSON.stringify(TEST_RESEARCH), stderr: '' }),
  })

  assert.equal(teardown.competitors[0].name, 'AuditCo')
})

test('synthesizeProductBlueprint consumes the idea, transcript, and research', async () => {
  const db = tempDb()
  const session = startCouncilSession({
    projectName: 'Enterprise Audit Log Engine',
    ideaDescription: 'High-throughput immutable audit trail for compliance.',
  }, db)
  await researchMarket({
    ideaTitle: 'Enterprise Audit Log Engine', ideaDescription: 'Immutable compliance trail', sessionId: session.id, db,
    runner: async () => ({ exitCode: 0, stdout: JSON.stringify(TEST_RESEARCH), stderr: '' }),
  })
  const blueprint = await synthesizeProductBlueprint({
    sessionId: session.id,
    ideaTitle: 'Enterprise Audit Log Engine',
    ideaDescription: 'High-throughput immutable audit trail for compliance.',
    mockBlueprint: blueprintFor('immutable audit trail'),
    db,
  })

  assert.equal(blueprint.title, 'Enterprise Audit Log Engine')
  assert.equal(blueprint.version, 'v1.0.0')

  // Part 1: Market
  assert.ok(blueprint.market.targetAudience)
  assert.ok(blueprint.market.competitors.length >= 1)
  assert.ok(blueprint.market.uniqueDifferentiators.length >= 1)

  // Part 2: PRD
  assert.ok(blueprint.prd.requirements.length >= 1)
  assert.equal(blueprint.prd.requirements[0].id, 'REQ-F-01')

  // Part 3: User Journeys
  assert.ok(blueprint.userJourneys.length >= 1)
  assert.ok(blueprint.userJourneys[0].steps.length >= 2)

  // Part 4: Architecture & DB ERD
  assert.ok(blueprint.architecture.databaseSchema.tables.length >= 1)
  assert.ok(blueprint.architecture.apiContracts.length >= 1)

  // Part 5: Roadmap
  assert.ok(blueprint.roadmap.milestones.length >= 1)
  assert.equal(getCouncilSession(session.id, db).blueprint.prd.requirements[0].id, 'REQ-F-01')
  closeOrchestratorDb()
})

test('different ideas produce materially different model blueprints', async () => {
  const make = (title) => synthesizeProductBlueprint({
    ideaTitle: title,
    ideaDescription: `A product for ${title}`,
    transcript: [{ role: 'user', content: title }],
    marketResearch: TEST_RESEARCH,
    gatewayRunner: async ({ messages }) => ({ text: JSON.stringify(blueprintFor(messages[0].content.includes('Weather') ? 'weather routing' : 'music licensing')) }),
  })
  const weather = await make('Weather Router')
  const music = await make('Music Rights Ledger')
  assert.notDeepEqual(weather.prd.requirements, music.prd.requirements)
  assert.notEqual(weather.market.coreValueProp, music.market.coreValueProp)
})

test('researchMarket surfaces a typed dependency error when Wigolo is unavailable', async () => {
  await assert.rejects(
    () => researchMarket({ ideaTitle: 'Novel product', ideaDescription: 'Specific market', runner: async () => { throw new Error('ENOENT') } }),
    (err) => err.code === 'E_GATEWAY_UNAVAILABLE',
  )
})

/**
 * Fail-closed regression tests for the advisory engines.
 *
 * Both the Council and the Architect used to answer with hardcoded paragraphs when the gateway
 * was unreachable — per-role "strategy analysis" that read like considered advice but was
 * written into the source, ignored the user's actual idea, and was indistinguishable in the UI
 * from a real reply. An advisor that cannot be reached must fail loudly.
 */

test('executeCouncilTurn throws instead of inventing advice when the gateway is down', async () => {
  const session = startCouncilSession({
    projectName: 'Test Product',
    ideaDescription: 'A tool for something specific and unusual.',
  })

  // The session opens with a fixed welcome message (UI chrome, not analysis). Baseline against
  // it so we detect a fabricated *reply*, not the greeting.
  const assistantCountBefore = session.messages.filter((m) => m.role === 'assistant').length

  await assert.rejects(
    () => executeCouncilTurn({
      sessionId: session.id,
      userMessage: '@pm who are our competitors?',
      gatewayUrl: 'http://127.0.0.1:1', // nothing listens here
    }),
    (err) => {
      assert.equal(err.code, 'E_GATEWAY_UNAVAILABLE')
      return true
    },
  )

  const assistantCountAfter = session.messages.filter((m) => m.role === 'assistant').length
  assert.equal(
    assistantCountAfter,
    assistantCountBefore,
    'no advisory reply may be recorded when the gateway failed',
  )
})

test('generateArchitectReply throws instead of appending canned text when the gateway is down', async () => {
  const { startSpecConversation, generateArchitectReply, getSpecConversation } =
    await import('../lib/orchestrator/spec-engine.mjs')

  const db = tempDb()
  const project = createProject({ name: 'Spec test', repoPath: '/tmp/spec-test' }, db)
  const convo = startSpecConversation({
    projectId: project.id,
    featureTitle: 'Some Feature',
    initialPrompt: 'Build me a thing.',
  }, db)

  const before = getSpecConversation(convo.id, db).messages.length

  await assert.rejects(
    () => generateArchitectReply(convo.id, { gatewayUrl: 'http://127.0.0.1:1', db }),
    (err) => {
      assert.equal(err.code, 'E_GATEWAY_UNAVAILABLE')
      return true
    },
  )

  // Transcript untouched — nothing fabricated entered the specification conversation.
  assert.equal(getSpecConversation(convo.id, db).messages.length, before)
  closeOrchestratorDb()
})

/**
 * The three defects below were all found by running the REAL research path once. Every one of
 * them passed the mock-based suite, because the mocks returned well-formed, substantive briefs —
 * the exact conditions under which none of these bugs exist.
 */

test('an unsourced brief is refused, not persisted as successful research', async () => {
  const db = tempDb()
  try {
    const session = startCouncilSession({ projectName: 'Rain', ideaDescription: 'Rainfall tracking.' }, db)

    // Measured live: Wigolo returned four off-topic sources (Yahoo Japan billing FAQs for a
    // rainfall query), so the structuring model correctly declined to invent competitors and
    // returned an empty-but-well-shaped brief. That was stored and reported as research.
    // Citing sources is not enough — the refusal must surface as a refusal.
    await assert.rejects(
      () => researchMarket({
        ideaTitle: 'Rain', ideaDescription: 'Rainfall tracking.', sessionId: session.id, db,
        runner: async () => ({
          exitCode: 0, stderr: '',
          stdout: JSON.stringify({ sources: [{ title: 'Unrelated', url: 'https://example.invalid/a' }], evidence: [] }),
        }),
        structureRunner: async () => ({ competitors: [], marketSize: 'Unknown', differentiators: [], risks: [], sources: [] }),
      }),
      /unusable|no conclusion|not research/i,
    )

    // And nothing may be left behind that a later stage could mistake for research.
    const after = getCouncilSession(session.id, db)
    assert.ok(!after.marketResearch?.sources?.length, 'an unusable brief must not be persisted')
  } finally {
    closeOrchestratorDb()
  }
})

test('sources the structuring model drops are restored from the research tool', async () => {
  const db = tempDb()
  try {
    // The model summarised four real sources and returned `sources: []`, destroying the
    // provenance the PRD is meant to cite. Sources are facts from the tool, not model output.
    const brief = await researchMarket({
      ideaTitle: 'Rain', ideaDescription: 'Rainfall tracking.', db,
      runner: async () => ({
        exitCode: 0, stderr: '',
        stdout: JSON.stringify({
          sources: [
            { title: 'Field guide', url: 'https://example.test/guide' },
            { title: 'Market note', url: 'https://example.test/note' },
          ],
        }),
      }),
      structureRunner: async () => ({
        competitors: [{ name: 'RainCo', url: 'https://rainco.test', positioning: 'p', pricing: 'Unknown', strengths: ['s'], weaknesses: ['w'] }],
        marketSize: 'Unknown', differentiators: ['d'], risks: ['r'],
        sources: [],
      }),
    })

    assert.deepEqual(brief.sources.map((s) => s.url).sort(),
      ['https://example.test/guide', 'https://example.test/note'])
  } finally {
    closeOrchestratorDb()
  }
})

test('a research process that produces a complete result and then hangs is not wasted', async () => {
  const db = tempDb()
  try {
    // Wigolo emitted its full result at ~12s and never exited (its browser pool holds the
    // process open), so it was killed at the timeout and the finished research was thrown away.
    const brief = await researchMarket({
      ideaTitle: 'Rain', ideaDescription: 'Rainfall tracking.', db,
      runner: async () => ({
        exitCode: 124, timedOut: true, stderr: 'killed',
        stdout: JSON.stringify(TEST_RESEARCH),
      }),
    })
    assert.equal(brief.competitors[0].name, 'AuditCo')

    // But a kill with nothing usable in stdout still fails closed.
    await assert.rejects(
      () => researchMarket({
        ideaTitle: 'Rain', ideaDescription: 'Rainfall tracking.', db,
        runner: async () => ({ exitCode: 124, timedOut: true, stdout: 'Fetching...', stderr: 'killed' }),
      }),
      /failed after its timeout/,
    )
  } finally {
    closeOrchestratorDb()
  }
})

test('a refusal names the degraded search backend instead of blaming the idea', async () => {
  const db = tempDb()
  const previousBackoff = process.env.ZEN_RESEARCH_POOL_BACKOFF_MS
  process.env.ZEN_RESEARCH_POOL_BACKOFF_MS = '1' // this pool never recovers; do not really wait
  try {
    // Wigolo queries several engines and uses cross-engine consensus to filter noise. When most
    // are rate-limited or blocked the pool collapses to one engine, consensus disappears, and a
    // single bad scrape becomes the whole result set. That is the real cause of the "random"
    // failures, and the owner cannot act on it unless the refusal says so.
    await assert.rejects(
      () => researchMarket({
        ideaTitle: 'Rain', ideaDescription: 'Rainfall tracking.', db,
        searchRunner: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            engines_used: ['bing'],
            engine_pool: { healthy: 1, total: 7, degraded: true, reasons: ['pool_collapsed'] },
            engine_warnings: [
              { engine: 'marginalia', code: 'http_429', message: 'Marginalia returned 429' },
              { engine: 'mojeek', code: 'http_403', message: 'Mojeek returned 403' },
            ],
          }),
        }),
        runner: async () => ({
          exitCode: 0, stderr: '',
          stdout: JSON.stringify({ sources: [{ title: 'Irrelevant', url: 'https://example.test/x' }] }),
        }),
        structureRunner: async () => ({ competitors: [], marketSize: 'Unknown', differentiators: [], risks: [], sources: [] }),
      }),
      (err) => {
        assert.match(err.message, /1 of 7 search engines/,
          'the refusal must report how much of the search backend is actually up')
        assert.match(err.message, /Marginalia returned 429/, 'and name what failed')
        assert.match(err.message, /no cross-engine consensus/,
          'and explain why one engine means unreliable results')
        return true
      },
    )
  } finally {
    process.env.ZEN_RESEARCH_POOL_BACKOFF_MS = previousBackoff
    closeOrchestratorDb()
  }
})

test('research waits for a healthy search pool instead of paying for a doomed call', async () => {
  const db = tempDb()
  const probes = []
  const previousBackoff = process.env.ZEN_RESEARCH_POOL_BACKOFF_MS
  process.env.ZEN_RESEARCH_POOL_BACKOFF_MS = '1' // the wait is real; this suite must stay fast
  try {
    // Engines drop out on rate-limit and their breakers reopen after a cooldown, so a collapsed
    // pool is transient. Probing costs ~1s; the research call costs 30-40s and on one engine
    // most likely produces a brief the substance gate rejects. So probe until the pool recovers.
    const brief = await researchMarket({
      ideaTitle: 'Rain', ideaDescription: 'Rainfall tracking.', db,
      searchRunner: async () => {
        probes.push(Date.now())
        const collapsed = probes.length < 3
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            engines_used: collapsed ? ['bing'] : ['bing', 'duckduckgo', 'wikipedia'],
            engine_pool: collapsed
              ? { healthy: 1, total: 7, degraded: true }
              : { healthy: 3, total: 7, degraded: false },
            engine_warnings: collapsed ? [{ engine: 'marginalia', code: 'http_429', message: 'Marginalia returned 429' }] : [],
          }),
        }
      },
      runner: async () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(TEST_RESEARCH) }),
    })

    assert.equal(probes.length, 3, 'it must keep probing until the pool recovers')
    assert.equal(brief.competitors[0].name, 'AuditCo', 'and then do the research normally')
  } finally {
    process.env.ZEN_RESEARCH_POOL_BACKOFF_MS = previousBackoff
    closeOrchestratorDb()
  }
})

test('a pool that never recovers does not block research forever', async () => {
  const db = tempDb()
  let probes = 0
  const previousBackoff = process.env.ZEN_RESEARCH_POOL_BACKOFF_MS
  process.env.ZEN_RESEARCH_POOL_BACKOFF_MS = '1'
  try {
    // Refusing on health alone would trade an intermittent failure for a permanent one — a
    // collapsed pool still returns good results often enough to be worth trying.
    const brief = await researchMarket({
      ideaTitle: 'Rain', ideaDescription: 'Rainfall tracking.', db,
      searchRunner: async () => {
        probes += 1
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            engines_used: ['bing'],
            engine_pool: { healthy: 1, total: 7, degraded: true },
            engine_warnings: [],
          }),
        }
      },
      runner: async () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(TEST_RESEARCH) }),
    })

    assert.equal(probes, 3, 'the wait must be bounded')
    assert.ok(brief.competitors.length > 0, 'and research must still run')
  } finally {
    process.env.ZEN_RESEARCH_POOL_BACKOFF_MS = previousBackoff
    closeOrchestratorDb()
  }
})
