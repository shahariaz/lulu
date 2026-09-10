import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callGatewayForText, GatewayUnavailableError, STRUCTURED_OUTPUT_MAX_TOKENS } from './gateway-errors.mjs'
import { spawnControlledProcess, validateWorkerCommand } from './security-boundary.mjs'
import {
  createConversation,
  getConversation,
  updateConversation,
  addConversationMessage,
  getProjectCouncilConversation,
  getOrchestratorDb,
} from './db/index.mjs'

export const BLUEPRINT_MAX_TOKENS = Number(process.env.ZEN_BLUEPRINT_MAX_TOKENS || 32000)

export const COUNCIL_PERSONAS = {
  pm: {
    id: 'pm', title: 'Chief Product Officer (PM)', badge: 'Strategy & Market', color: '#38bdf8', avatar: '💡',
    systemPrompt: `You are the Chief Product Officer for an enterprise software studio. Validate the owner's actual product idea, evaluate market fit and named competitors, uncover customer pain, and define a defensible value proposition. Use MoSCoW priorities. Distinguish sourced facts from hypotheses and never invent market evidence.`,
  },
  designer: {
    id: 'designer', title: 'Staff Product & UX Designer', badge: 'UX & Design Systems', color: '#ec4899', avatar: '🎨',
    systemPrompt: `You are a Staff Product and UX Designer. Map the actual user's journey, define hierarchy and interaction states, eliminate friction, and specify accessible behavior. Cover empty, loading, error, and recovery states. Never substitute a generic dashboard for the owner's product.`,
  },
  architect: {
    id: 'architect', title: 'Principal Systems Architect', badge: 'Architecture & Schema', color: '#58a6ff', avatar: '🏛️',
    systemPrompt: `You are a Principal Systems Architect. Design a bounded topology, explicit relational schema, API contracts, verification strategy, and security boundaries for the owner's actual idea. State trade-offs and unknowns. Do not invent requirements or claim unverified properties.`,
  },
  pjm: {
    id: 'pjm', title: 'Director of Agile Delivery (PjM)', badge: 'Roadmap & Phasing', color: '#a855f7', avatar: '📅',
    systemPrompt: `You are the Director of Agile Delivery. Turn the owner's validated product scope into lean milestones, bounded features, dependency-ordered tasks, acceptance criteria, and explicit file blast radii. Identify risks and keep deployment out of scope.`,
  },
  council: {
    id: 'council', title: 'Product Design Council', badge: 'Executive Synthesis', color: '#10b981', avatar: '🌐',
    systemPrompt: `You are the Product Design Council, combining product strategy, UX, systems architecture, and delivery planning. Reason specifically about the owner's idea, surface uncertainty, and produce no claims that are not grounded in the conversation or supplied research.`,
  },
}

const MARKET_RESEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['competitors', 'marketSize', 'differentiators', 'risks', 'sources'],
  properties: {
    competitors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'url', 'positioning', 'pricing', 'strengths', 'weaknesses'],
        properties: {
          name: { type: 'string' }, url: { type: 'string' }, positioning: { type: 'string' }, pricing: { type: 'string' },
          strengths: { type: 'array', items: { type: 'string' } },
          weaknesses: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    marketSize: { type: 'string' },
    differentiators: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    sources: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'url'],
        properties: { title: { type: 'string' }, url: { type: 'string' } },
      },
    },
  },
}

const BLUEPRINT_SYSTEM_PROMPT = `You are the executive Product Design Council. Synthesize the owner's idea, full council transcript, and cited market research into one implementation-ready blueprint.

Return ONLY valid JSON. Never invent competitor facts or source URLs. Requirements must be specific, independently verifiable, and use stable IDs matching REQ-F-* or REQ-NF-*.

Required shape:
{
  "market": { "coreValueProp": "", "targetAudience": "", "competitors": [{ "name": "", "positioning": "", "url": "" }], "uniqueDifferentiators": [""] },
  "prd": { "executiveSummary": "", "inScope": [""], "outOfScope": [""], "requirements": [{ "id": "REQ-F-01", "title": "", "description": "", "acceptanceCriteria": ["Given/When/Then, independently verifiable"], "priority": "MUST|SHOULD|COULD" }] },
  "userJourneys": [{ "persona": "", "goal": "", "steps": [""] }],
  "architecture": { "techStack": "", "databaseSchema": { "tables": [{ "name": "", "columns": [""] }] }, "apiContracts": [{ "method": "", "path": "", "purpose": "" }] },
  "roadmap": { "milestones": [{ "title": "", "tasks": [{ "title": "", "description": "" }] }] }
}`

/**
 * `truncation` comes from callGatewayForText and turns a bare "malformed JSON" into a
 * diagnosis. That failure has no signal of its own — a budget-starved response reports
 * stop_reason 'end_turn' while being cut off mid-array — so without this the symptom points at
 * the prompt or the parser instead of at max_tokens.
 */
function jsonObjectFromTextWithTruncation(response, label, gatewayUrl = null) {
  return jsonObjectFromText(response.text, label, gatewayUrl, response.truncation)
}

function jsonObjectFromText(text, label, gatewayUrl = null, truncation = null) {
  const trimmed = String(text || '').trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  const candidate = fence?.[1] || (first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed)
  try {
    return JSON.parse(candidate)
  } catch (err) {
    const budgetNote = truncation?.likely
      ? ` The response was almost certainly truncated by the token budget — ${truncation.reason}.`
        + ' Raise max_tokens for this call; it is shared between reasoning and output.'
      : ''
    throw new GatewayUnavailableError(`${label} returned malformed JSON: ${err.message}.${budgetNote}`, { gatewayUrl, cause: err })
  }
}

function councilMessageFromRow(row) {
  const persona = row.agent_role ? COUNCIL_PERSONAS[row.agent_role] : null
  return {
    id: row.id,
    role: row.role,
    ...(persona ? { agent: persona } : {}),
    content: row.content,
    ...(row.role === 'user' && row.agent_role ? { targetRole: row.agent_role } : {}),
    timestamp: row.created_at,
  }
}

function councilSessionFromConversation(conversation) {
  if (!conversation) return null
  return {
    id: conversation.id,
    projectId: conversation.project_id,
    projectName: conversation.title || '',
    ideaDescription: conversation.idea_description || '',
    messages: conversation.messages.map(councilMessageFromRow),
    marketResearch: conversation.marketResearch,
    blueprint: conversation.blueprint,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
  }
}

export function parseMentionTarget(text = '') {
  const lower = text.toLowerCase()
  if (lower.includes('@pm') || lower.includes('@product')) return 'pm'
  if (lower.includes('@designer') || lower.includes('@ux')) return 'designer'
  if (lower.includes('@architect') || lower.includes('@arch') || lower.includes('@tech')) return 'architect'
  if (lower.includes('@pjm') || lower.includes('@project') || lower.includes('@delivery')) return 'pjm'
  return 'council'
}

export function getCouncilSession(sessionId, db = null) {
  const conversation = getConversation(sessionId, db)
  if (!conversation || conversation.kind !== 'COUNCIL') return null
  return councilSessionFromConversation(conversation)
}

export function getProjectCouncilSession(projectId, db = null) {
  const conversation = getProjectCouncilConversation(projectId, db)
  if (!conversation || conversation.kind !== 'COUNCIL') return null
  return councilSessionFromConversation(conversation)
}

export function startCouncilSession({
  sessionId = null,
  projectId = null,
  projectName = '',
  ideaDescription = '',
  targetPersona = 'developers',
}, db = null) {
  const id = sessionId || `council_${randomUUID().slice(0, 12)}`
  const targetDb = db || getOrchestratorDb()
  createConversation({ id, projectId, kind: 'COUNCIL', title: projectName, ideaDescription }, targetDb)

  const content = `Welcome to the **Claude-Zen Product Design Council**. We are your dedicated executive team:

- **💡 @pm**: Market validation, competitor analysis, feature prioritization.
- **🎨 @designer**: User journeys, interaction states, and accessibility.
- **🏛️ @architect**: Relational schema, API contracts, and technical trade-offs.
- **📅 @pjm**: Delivery roadmap, bounded features, and dependency-ordered tasks.

Describe the product and its intended user, or @mention a specialist directly.`
  addConversationMessage({
    id: `msg_${randomUUID().slice(0, 8)}`, conversationId: id, role: 'assistant', agentRole: 'council', content,
  }, targetDb)
  const session = getCouncilSession(id, targetDb)
  session.targetPersona = targetPersona
  return session
}

export async function executeCouncilTurn({
  sessionId,
  userMessage,
  forcedRole = null,
  gatewayUrl = process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788',
  model = process.env.ZEN_ARCHITECT_MODEL || 'gemini-3.8-flash-tiered',
  mockReply = null,
  db = null,
}) {
  const targetDb = db || getOrchestratorDb()
  const session = getCouncilSession(sessionId, targetDb)
  if (!session) throw new Error(`Council session not found: ${sessionId}`)
  if (!userMessage?.trim()) throw new Error('Council message content is required')

  const targetRole = forcedRole || parseMentionTarget(userMessage)
  const persona = COUNCIL_PERSONAS[targetRole] || COUNCIL_PERSONAS.council
  const timestamp = Date.now()
  addConversationMessage({
    id: `msg_${randomUUID().slice(0, 8)}`, conversationId: sessionId, role: 'user', agentRole: targetRole,
    content: userMessage.trim(), createdAt: timestamp,
  }, targetDb)

  const refreshed = getCouncilSession(sessionId, targetDb)
  const replyText = mockReply || (await callGatewayForText({
    gatewayUrl,
    model,
    system: `${persona.systemPrompt}\n\nProduct name: ${refreshed.projectName || 'Untitled'}\nIdea: ${refreshed.ideaDescription || 'Not yet supplied'}`,
    messages: refreshed.messages.map((message) => ({ role: message.role, content: message.content })),
  })).text

  const agentMsgRecord = {
    id: `msg_${randomUUID().slice(0, 8)}`, role: 'assistant', agent: persona, content: replyText, timestamp: Date.now(),
  }
  addConversationMessage({
    id: agentMsgRecord.id, conversationId: sessionId, role: 'assistant', agentRole: targetRole,
    content: replyText, createdAt: agentMsgRecord.timestamp,
  }, targetDb)

  return { session: getCouncilSession(sessionId, targetDb), reply: agentMsgRecord, targetRole }
}

/**
 * Execute an automated multi-persona round-table council debate.
 * Sequentially engages @pm, @architect, @designer, and @pjm to produce
 * a comprehensive 360-degree architectural and product audit.
 */
export async function executeCouncilDebate({
  sessionId,
  userPrompt = null,
  gatewayUrl = process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788',
  model = process.env.ZEN_ARCHITECT_MODEL || 'gemini-3.8-flash-tiered',
  mockReplies = null,
  onTurn = null,
  db = null,
}) {
  const targetDb = db || getOrchestratorDb()
  const session = getCouncilSession(sessionId, targetDb)
  if (!session) throw new Error(`Council session not found: ${sessionId}`)

  const debateSequence = [
    {
      role: 'pm',
      prompt: userPrompt
        ? `@pm ${userPrompt}`
        : `As CPO, challenge the product's core value proposition, market differentiation, target persona pain points, and classify initial feature priorities (MoSCoW).`,
    },
    {
      role: 'architect',
      prompt: `As Principal Systems Architect, evaluate the PM's strategy. Specify the bounded system topology, data flow, concurrency model, and primary technical failure modes.`,
    },
    {
      role: 'designer',
      prompt: `As Staff Product & UX Designer, map the critical user journey based on the architecture. Define state hierarchy, operator interaction, and failure recovery states.`,
    },
    {
      role: 'pjm',
      prompt: `As Director of Agile Delivery, synthesize the findings. Identify the #1 delivery risk, define Phase 1 scope boundaries, and establish criteria for a lean MVP.`,
    },
  ]

  const turns = []
  for (const step of debateSequence) {
    const turnResult = await executeCouncilTurn({
      sessionId,
      userMessage: step.prompt,
      forcedRole: step.role,
      gatewayUrl,
      model,
      mockReply: mockReplies ? (mockReplies[step.role] || `Mock reply from ${step.role}`) : null,
      db: targetDb,
    })
    turns.push(turnResult)
    if (onTurn) {
      try { onTurn(step.role, turnResult) } catch {}
    }
  }

  return {
    session: getCouncilSession(sessionId, targetDb),
    turns,
  }
}

/**
 * Validate a market-research brief.
 *
 * `requireSubstance` is the part that matters. Shape-only validation accepted this, live:
 *
 *   { competitors: [], marketSize: 'Unknown', differentiators: [], risks: [], sources: [] }
 *
 * Every field was the right type, so it passed, was persisted, and was reported as successful
 * research. What actually happened is that Wigolo returned off-topic sources (a rainfall-tracking
 * query came back with Yahoo Japan billing FAQs) and the structuring model correctly REFUSED to
 * invent competitors from them. Recording that refusal as a research brief inverts invariant 1:
 * rather than fabricating content, the system fabricates the appearance of having done the work.
 *
 * A brief with no sources is not research. Fail closed and say why.
 */
function validateMarketResearch(value, { requireSubstance = true } = {}) {
  if (!value || typeof value !== 'object') throw new Error('market research must be an object')
  for (const field of ['competitors', 'differentiators', 'risks', 'sources']) {
    if (!Array.isArray(value[field])) throw new Error(`market research.${field} must be an array`)
  }
  if (typeof value.marketSize !== 'string') throw new Error('market research.marketSize must be a string')
  if (requireSubstance) {
    if (value.sources.length === 0) {
      throw new Error('market research cites no sources — an unsourced brief is not research')
    }
    // Sources are INPUTS. A brief that cites pages but reaches no conclusion — no competitor,
    // no differentiator, no risk — is a null result wearing the shape of a finding. That is the
    // live failure: four sources came back, none of them relevant, and the model rightly drew
    // nothing from them. Report that as a failure, not as a completed research step.
    const conclusions = value.competitors.length + value.differentiators.length + value.risks.length
    if (conclusions === 0) {
      throw new Error(
        `market research cites ${value.sources.length} source(s) but reaches no conclusion `
        + '(no competitor, differentiator, or risk). The sources were most likely irrelevant to '
        + 'the idea — rerun the research rather than treating this as a finding.',
      )
    }
  }
  for (const competitor of value.competitors) {
    if (!competitor || typeof competitor.name !== 'string' || typeof competitor.url !== 'string') {
      throw new Error('each market research competitor needs a name and URL')
    }
    if (typeof competitor.positioning !== 'string' || typeof competitor.pricing !== 'string') {
      throw new Error(`competitor ${competitor.name} needs positioning and pricing`)
    }
    if (!Array.isArray(competitor.strengths) || !Array.isArray(competitor.weaknesses)) {
      throw new Error(`competitor ${competitor.name} needs strengths and weaknesses arrays`)
    }
  }
  for (const source of value.sources) {
    if (!source || typeof source.title !== 'string' || typeof source.url !== 'string') {
      throw new Error('each market research source needs a title and URL')
    }
    if (requireSubstance && !/^https?:\/\//i.test(source.url)) {
      throw new Error(`market research source "${source.title}" has no resolvable URL — a citation the owner cannot open is not a citation`)
    }
  }
  return value
}

/**
 * Env the research tool is allowed to receive.
 *
 * Wigolo adds its Brave engine to the pool only when BRAVE_API_KEY is set, which takes the
 * effective pool for commercial queries from two engines to three — the difference between
 * "one bad scrape becomes the whole result set" and "consensus filters it out". The blanket
 * secret filter in security-boundary.mjs strips anything containing `KEY`, so without naming it
 * here the variable would be dropped silently and the owner would think it was configured.
 *
 * This is the search tool's own credential and it is never handed to agent-authored code.
 */
const RESEARCH_ENV_ALLOWLIST = ['BRAVE_API_KEY']

/**
 * Build the retrieval query for market research.
 *
 * Search on the PROBLEM AND CATEGORY, never on the product's name and never on the research
 * methodology. Both of those were in the previous query and both actively poisoned retrieval,
 * measured here on the idea "TrailMesh — offline mesh messaging for hikers":
 *
 *   - Leading with the name searched for the name. A new product's name is by definition not a
 *     market term, so it matched a GitHub repo called trailmesh, Jeep "TrailSac" mesh cargo
 *     bags, and a Java `com.jmex.effects.TrailMesh` API.
 *   - Embedding the instructions ("identify named direct competitors, positioning, pricing,
 *     market-size evidence, risks") retrieved articles about HOW TO DO competitor analysis —
 *     Shopify's product-research guide, "Competitor Analysis: A Complete Guide (in 5 Steps)".
 *
 * The description alone returned the real competitive set on three runs out of three
 * (Meshtastic, off-grid mesh radio guides, satellite communicators). The shape we want out of
 * those sources is expressed by the JSON Schema and the structuring prompt, which is where
 * instructions belong — not in the search query.
 */
function buildResearchQuery({ ideaTitle, ideaDescription }) {
  const category = String(ideaDescription || '').trim()
  if (category) return category
  return String(ideaTitle || '').trim() || 'Untitled product'
}

/**
 * Wait for the search backend to have more than one engine before spending the research call.
 *
 * Pool collapse is TRANSIENT: engines drop out on rate-limit (marginalia 429) or reputation
 * blocks (mojeek 403) and their circuit breakers reopen after a cooldown. When the pool is down
 * to a single engine there is no cross-engine consensus, so one bad scrape becomes the entire
 * result set — that is the whole mechanism behind the "random" bad research.
 *
 * The economics make waiting obviously right: the pre-flight probe costs about a second
 * (`--search-depth=fast`), while `wigolo research` costs 30-40 seconds and, on a collapsed pool,
 * most likely produces a brief the substance gate will reject anyway. So probe, and if the pool
 * is collapsed, back off and probe again rather than paying for research that is likely to be
 * thrown away.
 *
 * Bounded and non-fatal: after the attempts are spent, research proceeds regardless. A collapsed
 * pool often still returns good results, and refusing on health alone would trade an intermittent
 * failure for a permanent one. The last health reading is returned either way so a refusal can
 * explain itself.
 */
async function awaitHealthySearchPool({ ideaTitle, ideaDescription, searchRunner = null }) {
  const attempts = Math.max(1, Number(process.env.ZEN_RESEARCH_POOL_ATTEMPTS || 3))
  const backoffMs = Number(process.env.ZEN_RESEARCH_POOL_BACKOFF_MS || 2000)

  let health = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    health = await refreshResearchCache({ ideaTitle, ideaDescription, searchRunner })

    // No telemetry (older CLI, or the probe failed) — nothing to wait for.
    if (!health) return null
    if (!isPoolCollapsed(health)) return health

    if (attempt < attempts) {
      console.warn(
        `[Research] Search pool collapsed to ${health.enginesUsed.length || 0} engine(s)`
        + `${health.warnings.length ? ` (${health.warnings.join('; ')})` : ''}; `
        + `waiting ${backoffMs}ms for breakers to reopen (attempt ${attempt}/${attempts}).`,
      )
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
  }

  console.warn(
    '[Research] Proceeding on a degraded search pool; results may be unreliable.'
    + (process.env.BRAVE_API_KEY
      ? ''
      : ' Setting BRAVE_API_KEY adds a third search engine (Brave\'s free tier covers roughly '
        + '250 research runs a month), which is what keeps a single bad result from becoming '
        + 'the whole set.'),
  )
  return health
}

/** One engine means no consensus to filter noise — the condition worth waiting out. */
function isPoolCollapsed(health) {
  if (!health) return false
  if (health.enginesUsed.length > 1) return false
  return health.degraded || health.enginesUsed.length <= 1
}

/**
 * Refresh Wigolo's cache for this idea before researching it.
 *
 * `wigolo research` reads the local knowledge cache and has NO --force-refresh flag (only
 * `search` does). That cache can hold poisoned entries from an earlier bad scrape, and when it
 * does, research is built on them silently. Measured here: "rainfall tracking app for farmers"
 * returned Windows File Explorer support pages from cache, and the same query with
 * --force-refresh returned relevant results 4 times out of 4.
 *
 * So we run one cheap keyword search with --force-refresh first, purely for its side effect of
 * rewriting those cache entries. Keyword phrasing is deliberate — Wigolo ranks keyword queries
 * far better than prose questions.
 *
 * Best-effort: a failure here is not a reason to abandon the research. The substance gate in
 * validateMarketResearch() is what actually protects the brief's quality.
 */
async function refreshResearchCache({ ideaTitle, ideaDescription, searchRunner = null }) {
  const keywords = buildResearchQuery({ ideaTitle, ideaDescription })
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/)
    .filter(Boolean).slice(0, 12).join(' ')
  if (!keywords) return null
  const args = ['search', keywords, '--json', '--force-refresh', '--search-depth=fast']
  try {
    validateWorkerCommand(`wigolo search ${keywords}`)
    const result = searchRunner
      ? await searchRunner({ command: 'wigolo', args, keywords })
      : await spawnControlledProcess('wigolo', args, { timeoutMs: 45000, allowEnv: RESEARCH_ENV_ALLOWLIST })
    return describeSearchHealth(result)
  } catch (err) {
    console.warn(`[Research] Cache refresh skipped (${err.message}); researching against the existing cache.`)
    return null
  }
}

/**
 * Read the search backend's own health telemetry out of the pre-flight.
 *
 * `wigolo search --json` reports `engine_pool` and `engine_warnings`; `wigolo research --json`
 * does not. Since the pre-flight above already runs a search, that signal is free — we were
 * simply discarding it.
 *
 * It explains the flakiness that looked random. Wigolo queries several engines and relies on
 * cross-engine consensus to filter noise. Measured here, most of them were unavailable —
 * marginalia rate-limited (HTTP 429, breaker open), mojeek blocked (HTTP 403) — leaving
 * `engines_used: ["bing"]` and `engine_pool.reasons: ["pool_collapsed"]`. With a single engine
 * there is no consensus, so one bad scrape becomes the entire result set. That is why a query
 * about rainfall tracking returned Windows File Explorer support pages, and why swapping in a
 * different scraper would not have helped.
 *
 * Health alone is not grounds to refuse — single-engine runs do often return good results. It is
 * used to EXPLAIN a refusal, so the owner gets "5 of 7 search engines are rate-limited" instead
 * of "rerun it", which is the difference between an actionable failure and a mysterious one.
 */
function describeSearchHealth(processResult) {
  let parsed
  try { parsed = JSON.parse(String(processResult?.stdout || '').trim()) } catch { return null }
  const pool = parsed?.engine_pool
  if (!pool) return null
  return {
    enginesUsed: parsed.engines_used || [],
    healthy: pool.healthy ?? null,
    total: pool.total ?? null,
    degraded: !!pool.degraded,
    warnings: (parsed.engine_warnings || []).map((w) => `${w.engine}: ${w.message || w.code}`),
  }
}

/** Append the backend's health to a refusal, so the owner knows whether to retry or reconfigure. */
function withSearchHealth(message, health) {
  if (!health?.degraded) return message
  const engines = health.healthy !== null && health.total !== null
    ? `${health.healthy} of ${health.total} search engines are available`
    : 'the search backend is degraded'
  const detail = health.warnings.length ? ` (${health.warnings.join('; ')})` : ''
  return `${message} Search quality is currently degraded: ${engines}${detail}`
    + `, so results come from ${health.enginesUsed.length || 'a'} engine`
    + `${health.enginesUsed.length === 1 ? ' with no cross-engine consensus to filter noise' : 's'}.`
}

/** Union two source lists by URL, preferring the first list's titles. Tool sources win. */
function mergeSources(toolSources = [], modelSources = []) {
  const byUrl = new Map()
  for (const source of [...(toolSources || []), ...(modelSources || [])]) {
    const url = source?.url
    if (!url || byUrl.has(url)) continue
    byUrl.set(url, { title: source.title || url, url })
  }
  return [...byUrl.values()]
}

function findStructuredMarketResearch(raw) {
  for (const candidate of [raw, raw?.result, raw?.data, raw?.structured, raw?.extracted]) {
    try { return validateMarketResearch(candidate) } catch {}
  }
  return null
}

export async function researchMarket({
  ideaTitle,
  ideaDescription,
  depth = 'standard',
  sessionId = null,
  gatewayUrl = process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788',
  model = process.env.ZEN_ARCHITECT_MODEL || 'gemini-3.8-flash-tiered',
  runner = null,
  structureRunner = null,
  searchRunner = null,
  db = null,
}) {
  if (!ideaTitle?.trim() && !ideaDescription?.trim()) throw new Error('An idea title or description is required for market research')
  if (!['quick', 'standard', 'comprehensive'].includes(depth)) throw new Error(`Unsupported Wigolo research depth: ${depth}`)

  const targetDb = db || getOrchestratorDb()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-market-research-'))
  const schemaPath = path.join(tempDir, 'market.schema.json')
  fs.writeFileSync(schemaPath, JSON.stringify(MARKET_RESEARCH_SCHEMA), { mode: 0o600 })
  const question = buildResearchQuery({ ideaTitle, ideaDescription })
  const args = ['research', question, '--json', `--depth=${depth}`, `--schema=@${schemaPath}`, '--citation-format=json']

  try {
    validateWorkerCommand(`wigolo research ${question}`)
    // Only on the real spawn path — an injected runner owns the process entirely.
    // Run the pre-flight on the real spawn path, or whenever a caller supplies a search seam.
    // An injected research `runner` alone skips it: that caller owns the process entirely.
    const searchHealth = (runner && !searchRunner)
      ? null
      : await awaitHealthySearchPool({ ideaTitle, ideaDescription, searchRunner })
    let processResult
    try {
      processResult = runner
        ? await runner({ command: 'wigolo', args, schemaPath, question })
        : await spawnControlledProcess('wigolo', args, { timeoutMs: 120000, allowEnv: RESEARCH_ENV_ALLOWLIST })
    } catch (err) {
      throw new GatewayUnavailableError(`Wigolo market research could not start: ${err.message}`, { cause: err })
    }
    // Exit code is a signal, not the verdict. Measured live: Wigolo emitted its complete 30KB
    // result at ~12s and then never exited — its browser pool keeps the process alive — so we
    // killed it at the timeout and discarded a full set of real research. Parse stdout first;
    // only treat a nonzero exit as fatal when there is nothing usable in it. This salvages
    // finished work without inventing any: unparseable output still fails closed below.
    let raw = null
    const stdout = String(processResult?.stdout || '').trim()
    if (stdout) { try { raw = JSON.parse(stdout) } catch { raw = null } }

    if (!raw) {
      const detail = String(processResult?.stderr || stdout).trim().slice(0, 500)
      if (!processResult || processResult.exitCode !== 0) {
        throw new GatewayUnavailableError(`Wigolo market research failed${processResult?.timedOut ? ' after its timeout' : ''}${detail ? `: ${detail}` : ''}`)
      }
      throw new GatewayUnavailableError(`Wigolo returned malformed JSON${detail ? `: ${detail}` : ''}`)
    }
    if (processResult.exitCode !== 0) {
      console.warn(`[Research] Wigolo exited ${processResult.exitCode}${processResult.timedOut ? ' (killed at timeout)' : ''} but had already produced a complete result; using it.`)
    }
    if (raw?.error) throw new GatewayUnavailableError(`Wigolo market research failed: ${raw.error}`)

    let brief = findStructuredMarketResearch(raw)
    if (!brief) {
      const evidence = {
        report: raw.report || '', brief: raw.brief || null, evidence: raw.evidence || [], citations: raw.citations || [],
        sources: (raw.sources || []).map((source) => ({
          title: source.title || source.url || 'Untitled source', url: source.url || '',
          snippet: source.snippet || source.description || '',
        })).filter((source) => source.url),
      }
      if (evidence.sources.length === 0) {
        throw new GatewayUnavailableError(withSearchHealth('Wigolo returned no usable market-research sources.', searchHealth))
      }

      const structured = structureRunner
        ? await structureRunner({ ideaTitle, ideaDescription, evidence, schema: MARKET_RESEARCH_SCHEMA })
        : jsonObjectFromTextWithTruncation(await callGatewayForText({
            gatewayUrl,
            model,
            system: 'You are a market analyst. Return only JSON matching the supplied schema. Use only facts and URLs in the Wigolo evidence; write "Unknown" when pricing or market size is not evidenced.',
            messages: [{ role: 'user', content: `Product: ${ideaTitle}\nIdea: ${ideaDescription || ''}\nSchema: ${JSON.stringify(MARKET_RESEARCH_SCHEMA)}\nWigolo evidence: ${JSON.stringify(evidence)}` }],
            maxTokens: STRUCTURED_OUTPUT_MAX_TOKENS,
          }), 'Market-research structuring gateway', gatewayUrl)
      // Sources are FACTS the research tool produced, not model output. The structuring model
      // was observed returning `sources: []` while summarising four real ones, which silently
      // destroys the provenance the PRD is supposed to cite. Union the two, tool-side first.
      const merged = { ...structured, sources: mergeSources(evidence.sources, structured?.sources) }
      try { brief = validateMarketResearch(merged) } catch (err) {
        throw new GatewayUnavailableError(
          withSearchHealth(`Structured market research was unusable: ${err.message}.`, searchHealth),
          { gatewayUrl, cause: err },
        )
      }
    }

    if (sessionId) {
      if (!getCouncilSession(sessionId, targetDb)) throw new Error(`Council session not found: ${sessionId}`)
      updateConversation(sessionId, { marketResearch: brief }, targetDb)
    }
    return brief
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export async function generateCompetitorTeardown({ productIdea, ideaDescription = '', depth = 'standard', ...options }) {
  return researchMarket({ ideaTitle: productIdea, ideaDescription, depth, ...options })
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function validateProductBlueprint(value) {
  if (!value || typeof value !== 'object') throw new Error('blueprint must be an object')
  for (const key of ['market', 'prd', 'userJourneys', 'architecture', 'roadmap']) {
    if (!value[key] || typeof value[key] !== 'object') throw new Error(`blueprint.${key} is required`)
  }
  if (!nonEmptyString(value.market.coreValueProp) || !nonEmptyString(value.market.targetAudience)) {
    throw new Error('blueprint.market needs a value proposition and target audience')
  }
  if (!Array.isArray(value.market.competitors) || !Array.isArray(value.market.uniqueDifferentiators)) {
    throw new Error('blueprint.market competitor and differentiator arrays are required')
  }
  if (!nonEmptyString(value.prd.executiveSummary) || !Array.isArray(value.prd.inScope) || !Array.isArray(value.prd.outOfScope)) {
    throw new Error('blueprint.prd summary and scope arrays are required')
  }
  if (!Array.isArray(value.prd.requirements) || value.prd.requirements.length === 0) throw new Error('blueprint.prd must contain requirements')
  const ids = new Set()
  for (const requirement of value.prd.requirements) {
    if (!/^REQ-(?:F|NF)-[A-Z0-9_-]+$/.test(requirement?.id || '')) throw new Error(`Invalid requirement ID: ${requirement?.id || '<missing>'}`)
    if (ids.has(requirement.id)) throw new Error(`Duplicate requirement ID: ${requirement.id}`)
    ids.add(requirement.id)
    if (!nonEmptyString(requirement.title) || !nonEmptyString(requirement.description)) throw new Error(`Requirement ${requirement.id} needs a title and description`)
    if (!Array.isArray(requirement.acceptanceCriteria) || requirement.acceptanceCriteria.length === 0 || !requirement.acceptanceCriteria.every(nonEmptyString)) {
      throw new Error(`Requirement ${requirement.id} needs independently verifiable acceptance criteria`)
    }
    if (!['MUST', 'SHOULD', 'COULD'].includes(requirement.priority)) throw new Error(`Requirement ${requirement.id} has invalid priority`)
  }
  if (!Array.isArray(value.userJourneys) || !Array.isArray(value.architecture?.databaseSchema?.tables) || !Array.isArray(value.architecture?.apiContracts)) {
    throw new Error('blueprint journeys and architecture arrays are required')
  }
  if (!Array.isArray(value.roadmap?.milestones) || value.roadmap.milestones.length === 0) throw new Error('blueprint.roadmap needs milestones')
  return value
}

export async function synthesizeProductBlueprint({
  sessionId = null,
  ideaTitle = '',
  ideaDescription = '',
  transcript = null,
  marketResearch = null,
  gatewayUrl = process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788',
  model = process.env.ZEN_ARCHITECT_MODEL || 'gemini-3.8-flash-tiered',
  mockBlueprint = null,
  gatewayRunner = null,
  db = null,
}) {
  const targetDb = db || getOrchestratorDb()
  const session = sessionId ? getCouncilSession(sessionId, targetDb) : null
  if (sessionId && !session) throw new Error(`Council session not found: ${sessionId}`)

  const resolvedTitle = ideaTitle || session?.projectName || ''
  const resolvedDescription = ideaDescription || session?.ideaDescription || ''
  const resolvedTranscript = transcript || session?.messages || []
  const resolvedResearch = marketResearch || session?.marketResearch
  if (!resolvedTitle.trim() || !resolvedDescription.trim()) throw new Error('Blueprint synthesis requires the idea title and description')
  if (!Array.isArray(resolvedTranscript) || resolvedTranscript.length === 0) throw new Error('Blueprint synthesis requires the Council transcript')
  if (!resolvedResearch || !Array.isArray(resolvedResearch.sources) || resolvedResearch.sources.length === 0) {
    throw new Error('Blueprint synthesis requires persisted, sourced market research')
  }

  let candidate = mockBlueprint
  if (!candidate) {
    const messages = [{
      role: 'user',
      content: `Idea title: ${resolvedTitle}\nIdea description: ${resolvedDescription}\n\nCouncil transcript:\n${JSON.stringify(resolvedTranscript.map((message) => ({ role: message.role, agent: message.agent?.id || message.targetRole || null, content: message.content })))}\n\nMarket research:\n${JSON.stringify(resolvedResearch)}`,
    }]
    const response = gatewayRunner
      ? await gatewayRunner({ gatewayUrl, model, system: BLUEPRINT_SYSTEM_PROMPT, messages })
      // max_tokens is shared between REASONING and output on these models. Measured against
      // the live gateway: a large schema drew 7,860 reasoning tokens and left 328 for the
      // answer, truncating the JSON mid-array while still reporting stop_reason 'end_turn'.
      // The blueprint is the largest structured output in the system, so it needs real headroom.
      : await callGatewayForText({ gatewayUrl, model, system: BLUEPRINT_SYSTEM_PROMPT, messages, maxTokens: BLUEPRINT_MAX_TOKENS })
    candidate = typeof response === 'string' ? jsonObjectFromText(response, 'Blueprint gateway', gatewayUrl) :
      response?.text ? jsonObjectFromText(response.text, 'Blueprint gateway', gatewayUrl, response.truncation) : response
  }

  let blueprint
  try { blueprint = validateProductBlueprint(candidate) } catch (err) {
    throw new GatewayUnavailableError(`Blueprint output was unusable: ${err.message}`, { gatewayUrl, cause: err })
  }
  blueprint = { title: resolvedTitle, version: 'v1.0.0', createdAt: Date.now(), ...blueprint }
  if (sessionId) updateConversation(sessionId, { blueprint }, targetDb)
  return blueprint
}
