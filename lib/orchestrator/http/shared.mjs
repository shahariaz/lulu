/**
 * Parse a JSON request body.
 *
 * Mock-injection screening lives HERE rather than in each route on purpose: every route already
 * goes through readJson, so a route added later is protected by default instead of relying on
 * whoever writes it to remember.
 */
export async function readJson(c) {
  const text = await c.req.text()
  if (!text.trim()) return {}
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error('Invalid JSON payload') }
  return assertNoMockInjection(parsed)
}

/**
 * Request-body fields that let a caller SUPPLY model output instead of the model producing it.
 * These exist as test seams. Reaching them over HTTP defeats INVARIANT 1.
 */
export const MOCK_INJECTION_FIELDS = Object.freeze([
  'mockBlueprint',
  'mockResearch',
  'mockReply',
  'mockDecomposition',
  'mockReview',
  'mockFiles',
])

/**
 * Are caller-supplied mock payloads permitted on this process?
 *
 * Off unless ZEN_ALLOW_MOCK_INJECTION is explicitly enabled. Not merely a hardening nicety:
 * with every gateway down, a caller could previously chain
 *   POST /council/teardown  { mockResearch }   → planted as "sourced" research
 *   POST /council/turn      { mockReply }      → planted in the transcript
 *   POST /council/blueprint { mockBlueprint }  → a complete fabricated blueprint
 * and then POST /council/initialize-project, which runs createDraftBaseline →
 * approveBaselineVersion({ approvedBy: 'owner' }). The result is an immutable, SHA-locked
 * v1.0.0 baseline attributed to the owner, that every downstream task is measured against —
 * with no model consulted at any point and nothing in storage marking it as fabricated.
 */
export function mockInjectionAllowed() {
  const flag = String(process.env.ZEN_ALLOW_MOCK_INJECTION || '').toLowerCase()
  return flag === '1' || flag === 'true'
}

/**
 * Strip caller-supplied mock payloads unless explicitly permitted.
 *
 * Rejects loudly rather than ignoring silently: a caller that sent `mockBlueprint` expecting it
 * to be honoured must not receive a real-looking response that quietly came from somewhere else.
 */
export function assertNoMockInjection(body) {
  if (mockInjectionAllowed()) return body

  const supplied = MOCK_INJECTION_FIELDS.filter((f) => body?.[f] != null)
  if (supplied.length === 0) return body

  const err = new Error(
    `Caller-supplied model output is not permitted: ${supplied.join(', ')}. ` +
    'These are test seams; accepting them over HTTP would let a request fabricate content ' +
    'that is indistinguishable from real model output. Set ZEN_ALLOW_MOCK_INJECTION=1 to ' +
    'enable them in a test process.'
  )
  err.code = 'E_MOCK_INJECTION_FORBIDDEN'
  err.status = 403
  throw err
}

export function json(c, payload, status = 200) {
  c.header('Cache-Control', 'no-store')
  return c.json(payload, status)
}

export function projectForTask(taskId, db) {
  return db.prepare(`
    SELECT p.* FROM tasks t
    JOIN milestones m ON m.id = t.milestone_id
    JOIN requirements_baselines b ON b.id = m.baseline_id
    JOIN projects p ON p.id = b.project_id
    WHERE t.id = ?
  `).get(taskId) || null
}
