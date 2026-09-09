import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMentionTarget,
  startCouncilSession,
  executeCouncilTurn,
  generateCompetitorTeardown,
  synthesizeProductBlueprint,
  COUNCIL_PERSONAS,
} from '../lib/orchestrator/council-engine.mjs'

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
  assert.equal(session.messages.length, 5)
})

test('generateCompetitorTeardown outputs structured market analysis', () => {
  const teardown = generateCompetitorTeardown({
    productIdea: 'Self-Hosted AI Code Delivery Platform',
    industryCategory: 'Developer Infrastructure',
  })

  assert.equal(teardown.category, 'Developer Infrastructure')
  assert.ok(teardown.competitors.length >= 2)
  assert.ok(teardown.swotAnalysis.strengths.length > 0)
  assert.ok(teardown.recommendation.length > 0)
})

test('synthesizeProductBlueprint generates complete 5-part enterprise specification', () => {
  const blueprint = synthesizeProductBlueprint({
    ideaTitle: 'Enterprise Audit Log Engine',
    ideaDescription: 'High-throughput immutable audit trail for compliance.',
  })

  assert.equal(blueprint.title, 'Enterprise Audit Log Engine')
  assert.equal(blueprint.version, 'v1.0.0')

  // Part 1: Market
  assert.ok(blueprint.market.targetAudience)
  assert.ok(blueprint.market.competitors.length >= 2)
  assert.ok(blueprint.market.uniqueDifferentiators.length >= 2)

  // Part 2: PRD
  assert.ok(blueprint.prd.requirements.length >= 4)
  assert.equal(blueprint.prd.requirements[0].id, 'REQ-F-01')

  // Part 3: User Journeys
  assert.ok(blueprint.userJourneys.length >= 2)
  assert.ok(blueprint.userJourneys[0].steps.length >= 2)

  // Part 4: Architecture & DB ERD
  assert.ok(blueprint.architecture.databaseSchema.tables.length >= 2)
  assert.ok(blueprint.architecture.apiContracts.length >= 2)

  // Part 5: Roadmap
  assert.ok(blueprint.roadmap.milestones.length >= 2)
  assert.ok(blueprint.roadmap.milestones[0].tasks.length >= 2)
})
