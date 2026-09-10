import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callGatewayForText, GatewayUnavailableError } from './gateway-errors.mjs'
import { spawnControlledProcess, validateWorkerCommand } from './security-boundary.mjs'
import {
  createConversation,
  getConversation,
  updateConversation,
  addConversationMessage,
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

function jsonObjectFromText(text, label, gatewayUrl = null) {
  const trimmed = String(text || '').trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  const candidate = fence?.[1] || (first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed)
  try {
    return JSON.parse(candidate)
  } catch (err) {
    throw new GatewayUnavailableError(`${label} returned malformed JSON: ${err.message}`, { gatewayUrl, cause: err })
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

function validateMarketResearch(value) {
  if (!value || typeof value !== 'object') throw new Error('market research must be an object')
  for (const field of ['competitors', 'differentiators', 'risks', 'sources']) {
    if (!Array.isArray(value[field])) throw new Error(`market research.${field} must be an array`)
  }
  if (typeof value.marketSize !== 'string') throw new Error('market research.marketSize must be a string')
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
  }
  return value
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
  db = null,
}) {
  if (!ideaTitle?.trim() && !ideaDescription?.trim()) throw new Error('An idea title or description is required for market research')
  if (!['quick', 'standard', 'comprehensive'].includes(depth)) throw new Error(`Unsupported Wigolo research depth: ${depth}`)

  const targetDb = db || getOrchestratorDb()
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-market-research-'))
  const schemaPath = path.join(tempDir, 'market.schema.json')
  fs.writeFileSync(schemaPath, JSON.stringify(MARKET_RESEARCH_SCHEMA), { mode: 0o600 })
  const question = [
    `Research the market for the product idea "${ideaTitle || 'Untitled product'}".`,
    ideaDescription ? `Idea: ${ideaDescription}` : '',
    'Identify named direct competitors, official URLs, positioning, evidenced pricing, strengths, weaknesses, market-size evidence, differentiation opportunities, risks, and source URLs.',
  ].filter(Boolean).join(' ')
  const args = ['research', question, '--json', `--depth=${depth}`, `--schema=@${schemaPath}`, '--citation-format=json']

  try {
    validateWorkerCommand(`wigolo research ${question}`)
    let processResult
    try {
      processResult = runner
        ? await runner({ command: 'wigolo', args, schemaPath, question })
        : await spawnControlledProcess('wigolo', args, { timeoutMs: 120000 })
    } catch (err) {
      throw new GatewayUnavailableError(`Wigolo market research could not start: ${err.message}`, { cause: err })
    }
    if (!processResult || processResult.exitCode !== 0) {
      const detail = String(processResult?.stderr || processResult?.stdout || '').trim().slice(0, 500)
      throw new GatewayUnavailableError(`Wigolo market research failed${processResult?.timedOut ? ' after its timeout' : ''}${detail ? `: ${detail}` : ''}`)
    }

    let raw
    try { raw = JSON.parse(String(processResult.stdout || '').trim()) } catch (err) {
      throw new GatewayUnavailableError(`Wigolo returned malformed JSON: ${err.message}`, { cause: err })
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
      if (evidence.sources.length === 0) throw new GatewayUnavailableError('Wigolo returned no usable market-research sources')

      const structured = structureRunner
        ? await structureRunner({ ideaTitle, ideaDescription, evidence, schema: MARKET_RESEARCH_SCHEMA })
        : jsonObjectFromText((await callGatewayForText({
            gatewayUrl,
            model,
            system: 'You are a market analyst. Return only JSON matching the supplied schema. Use only facts and URLs in the Wigolo evidence; write "Unknown" when pricing or market size is not evidenced.',
            messages: [{ role: 'user', content: `Product: ${ideaTitle}\nIdea: ${ideaDescription || ''}\nSchema: ${JSON.stringify(MARKET_RESEARCH_SCHEMA)}\nWigolo evidence: ${JSON.stringify(evidence)}` }],
          })).text, 'Market-research structuring gateway', gatewayUrl)
      try { brief = validateMarketResearch(structured) } catch (err) {
        throw new GatewayUnavailableError(`Structured market research was unusable: ${err.message}`, { gatewayUrl, cause: err })
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
      response?.text ? jsonObjectFromText(response.text, 'Blueprint gateway', gatewayUrl) : response
  }

  let blueprint
  try { blueprint = validateProductBlueprint(candidate) } catch (err) {
    throw new GatewayUnavailableError(`Blueprint output was unusable: ${err.message}`, { gatewayUrl, cause: err })
  }
  blueprint = { title: resolvedTitle, version: 'v1.0.0', createdAt: Date.now(), ...blueprint }
  if (sessionId) updateConversation(sessionId, { blueprint }, targetDb)
  return blueprint
}
