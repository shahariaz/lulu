import { createHash, randomUUID } from 'node:crypto'
import { callGatewayForText } from './gateway-errors.mjs'
import {
  createBaseline,
  getBaseline,
  approveBaseline,
  getApprovedBaseline,
  recordAuditLog,
  getOrchestratorDb,
  createConversation,
  getConversation,
  addConversationMessage,
} from './db/index.mjs'

export const ARCHITECT_SYSTEM_PROMPT = `You are the Principal Software Architect for Claude-Zen.
Your mission is to converse with the project owner, explore their feature goals, identify technical trade-offs and edge cases, and produce a formal, versioned Product Requirements Document (PRD).

When formulating the specification, ensure:
1. Executive Summary & Goals: Clear, bounded description of the feature.
2. Stable Requirement Identifiers: Every functional requirement must have a stable ID (e.g. REQ-F-01, REQ-F-02).
3. Nonfunctional Constraints: Document performance, security, and runtime constraints (e.g. REQ-NF-01).
4. Acceptance & Verification Criteria: Clear verification commands and conditions.
5. In-Scope vs. Out-of-Scope: Strict boundaries to keep implementation bounded.

Structure the final approved PRD using clean Github-flavored markdown.`

function specConversationFromRow(conversation) {
  if (!conversation || conversation.kind !== 'ARCHITECT') return null
  return {
    id: conversation.id,
    projectId: conversation.project_id,
    featureTitle: conversation.title,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.created_at,
    })),
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
  }
}

/**
 * Start a new conversational scoping session for a feature.
 */
export function startSpecConversation({ projectId, featureTitle, initialPrompt = '' }, db = null) {
  const conversationId = `conv_${randomUUID().slice(0, 12)}`
  const targetDb = db || getOrchestratorDb()
  createConversation({
    id: conversationId,
    projectId,
    kind: 'ARCHITECT',
    title: featureTitle,
  }, targetDb)
  addConversationMessage({
    conversationId,
    role: 'system',
    agentRole: 'architect',
    content: ARCHITECT_SYSTEM_PROMPT,
  }, targetDb)

  if (initialPrompt.trim()) {
    addConversationMessage({
      conversationId,
      role: 'user',
      content: initialPrompt.trim(),
    }, targetDb)
  }

  return getSpecConversation(conversationId, targetDb)
}

/**
 * Add a message to the spec conversation.
 */
export function addSpecMessage(conversationId, { role, content }, db = null) {
  const targetDb = db || getOrchestratorDb()
  const conversation = getSpecConversation(conversationId, targetDb)
  if (!conversation) {
    throw new Error(`Specification conversation not found: ${conversationId}`)
  }

  const row = addConversationMessage({ conversationId, role, content }, targetDb)
  return { id: row.id, role: row.role, content: row.content, timestamp: row.created_at }
}

/**
 * Generate a live LLM reply from the Architect model using the local gateway.
 *
 * Throws GatewayUnavailableError if the gateway cannot be reached or returns nothing usable.
 * It previously appended a canned "I have received your requirements..." message to the
 * transcript and returned `success: false` — but the fabricated message was pushed into the
 * conversation regardless, so it became part of the context for later turns and was
 * indistinguishable from a real Architect reply in the UI. A specification conversation must
 * never contain words the Architect did not say.
 */
export async function generateArchitectReply(conversationId, {
  gatewayUrl = process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788',
  model = process.env.ZEN_ARCHITECT_MODEL || 'gemini-3.8-flash-tiered',
  maxTokens = 4096,
  db = null,
} = {}) {
  const targetDb = db || getOrchestratorDb()
  const conversation = getSpecConversation(conversationId, targetDb)
  if (!conversation) {
    throw new Error(`Specification conversation not found: ${conversationId}`)
  }

  const systemMsg = conversation.messages.find((m) => m.role === 'system')
  const apiMessages = conversation.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }))

  // No try/catch: a GatewayUnavailableError propagates to the caller, which surfaces it as a
  // 503. The transcript is left untouched so nothing fabricated enters the conversation.
  const { text: replyText } = await callGatewayForText({
    gatewayUrl,
    model,
    maxTokens,
    system: systemMsg ? systemMsg.content : ARCHITECT_SYSTEM_PROMPT,
    messages: apiMessages,
  })

  const row = addConversationMessage({
    conversationId,
    role: 'assistant',
    agentRole: 'architect',
    content: replyText,
  }, targetDb)
  const assistantMessage = { id: row.id, role: row.role, content: row.content, timestamp: row.created_at }
  return { success: true, message: assistantMessage, conversation: getSpecConversation(conversationId, targetDb) }
}

/**
 * Get the full conversation transcript.
 */
export function getSpecConversation(conversationId, db = null) {
  return specConversationFromRow(getConversation(conversationId, db))
}

/**
 * Compute SHA256 digest of specification content.
 */
export function computeSpecDigest(specMarkdown) {
  return 'sha256:' + createHash('sha256').update(specMarkdown.trim()).digest('hex')
}

/**
 * Create a draft baseline specification in SQLite from conversation or markdown input.
 */
export function createDraftBaseline({ projectId, specMarkdown, version = 'v1.0.0' }, db = null) {
  if (!specMarkdown || typeof specMarkdown !== 'string' || !specMarkdown.trim()) {
    throw new Error('Specification markdown content is required')
  }

  const contentDigest = computeSpecDigest(specMarkdown)
  const baseline = createBaseline({
    projectId,
    version,
    specMarkdown: specMarkdown.trim(),
    contentDigest,
    status: 'DRAFT',
  }, db)

  recordAuditLog({
    projectId,
    eventType: 'BASELINE_DRAFTED',
    actor: 'architect',
    details: { baselineId: baseline.id, version, contentDigest },
  }, db)

  return baseline
}

/**
 * Formally approve and lock a requirements baseline.
 * Locks the record as APPROVED with timestamp, approver, and content digest.
 */
export function approveBaselineVersion({ baselineId, approvedBy = 'owner' }, db = null) {
  const baseline = getBaseline(baselineId, db)
  if (!baseline) {
    throw new Error(`Baseline not found: ${baselineId}`)
  }

  if (baseline.status === 'APPROVED') {
    return baseline // Already approved
  }

  // Supersede prior approved baseline for this project if one exists
  const targetDb = db || getOrchestratorDb()
  const priorApproved = getApprovedBaseline(baseline.project_id, targetDb)
  if (priorApproved && priorApproved.id !== baselineId) {
    targetDb.prepare(`
      UPDATE requirements_baselines
      SET status = 'SUPERSEDED'
      WHERE id = ?
    `).run(priorApproved.id)
  }

  const approved = approveBaseline(baselineId, approvedBy, targetDb)

  recordAuditLog({
    projectId: baseline.project_id,
    eventType: 'BASELINE_APPROVED',
    actor: approvedBy,
    details: { baselineId, version: approved.version, contentDigest: approved.content_digest },
  }, targetDb)

  return approved
}
