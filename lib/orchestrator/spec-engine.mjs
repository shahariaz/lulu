import { createHash, randomUUID } from 'node:crypto'
import {
  createBaseline,
  getBaseline,
  approveBaseline,
  getApprovedBaseline,
  recordAuditLog,
  getOrchestratorDb,
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

// In-memory active spec conversations cache
const activeConversations = new Map()

/**
 * Start a new conversational scoping session for a feature.
 */
export function startSpecConversation({ projectId, featureTitle, initialPrompt = '' }) {
  const conversationId = `conv_${randomUUID().slice(0, 12)}`
  const conversation = {
    id: conversationId,
    projectId,
    featureTitle,
    messages: [
      { role: 'system', content: ARCHITECT_SYSTEM_PROMPT },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  if (initialPrompt.trim()) {
    conversation.messages.push({ role: 'user', content: initialPrompt.trim() })
  }

  activeConversations.set(conversationId, conversation)
  return conversation
}

/**
 * Add a message to the spec conversation.
 */
export function addSpecMessage(conversationId, { role, content }) {
  const conversation = activeConversations.get(conversationId)
  if (!conversation) {
    throw new Error(`Specification conversation not found: ${conversationId}`)
  }

  const message = { role, content, timestamp: Date.now() }
  conversation.messages.push(message)
  conversation.updatedAt = Date.now()
  return conversation
}

/**
 * Generate a live LLM reply from the Architect model using the local gateway.
 * Falls back gracefully if gateway is unreachable.
 */
export async function generateArchitectReply(conversationId, {
  gatewayUrl = process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788',
  model = process.env.ZEN_ARCHITECT_MODEL || 'gemini-3.8-flash-tiered',
  maxTokens = 4096,
} = {}) {
  const conversation = activeConversations.get(conversationId)
  if (!conversation) {
    throw new Error(`Specification conversation not found: ${conversationId}`)
  }

  const systemMsg = conversation.messages.find((m) => m.role === 'system')
  const apiMessages = conversation.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }))

  try {
    const res = await fetch(`${gatewayUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'local-antigravity',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemMsg ? systemMsg.content : ARCHITECT_SYSTEM_PROMPT,
        messages: apiMessages,
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Gateway HTTP ${res.status}: ${errText}`)
    }

    const data = await res.json()
    const textBlock = (data.content || []).find((b) => b.type === 'text')
    const replyText = textBlock ? textBlock.text : 'I have analyzed the requirements. Let us proceed to formalize the specification.'

    const assistantMessage = { role: 'assistant', content: replyText, timestamp: Date.now() }
    conversation.messages.push(assistantMessage)
    conversation.updatedAt = Date.now()
    return { success: true, message: assistantMessage, conversation }
  } catch (err) {
    const fallbackText = `I have received your requirements for "${conversation.featureTitle}". Let us formalize the specification with stable requirement IDs (REQ-F-01, REQ-F-02) and verification criteria.`
    const fallbackMessage = { role: 'assistant', content: fallbackText, timestamp: Date.now(), isFallback: true }
    conversation.messages.push(fallbackMessage)
    conversation.updatedAt = Date.now()
    return { success: false, message: fallbackMessage, error: err.message, conversation }
  }
}

/**
 * Get the full conversation transcript.
 */
export function getSpecConversation(conversationId) {
  return activeConversations.get(conversationId) || null
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

/**
 * Analyze the impact of a new specification draft compared to an existing approved baseline.
 * Identifies added, modified, and removed requirement IDs.
 */
export function analyzeSpecImpact(previousSpecMarkdown, newSpecMarkdown) {
  const prevReqs = extractRequirementIds(previousSpecMarkdown || '')
  const newReqs = extractRequirementIds(newSpecMarkdown || '')

  const prevSet = new Set(prevReqs)
  const newSet = new Set(newReqs)

  const added = newReqs.filter((r) => !prevSet.has(r))
  const removed = prevReqs.filter((r) => !newSet.has(r))
  const retained = prevReqs.filter((r) => newSet.has(r))

  return {
    addedRequirements: added,
    removedRequirements: removed,
    retainedRequirements: retained,
    totalPrevious: prevReqs.length,
    totalNew: newReqs.length,
    hasImpact: added.length > 0 || removed.length > 0,
  }
}

/**
 * Extract requirement IDs matching patterns like REQ-F-*, REQ-NF-*, or REQ-*
 */
export function extractRequirementIds(markdown) {
  const regex = /\b(REQ-[A-Z0-9_-]+)\b/g
  const matches = new Set()
  let match
  while ((match = regex.exec(markdown)) !== null) {
    matches.add(match[1])
  }
  return Array.from(matches)
}
