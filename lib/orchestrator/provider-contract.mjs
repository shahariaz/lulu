import { createHash } from 'node:crypto'

/**
 * Provider contracts — turning silent drift into a loud, diffable signal.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The gateways front third-party providers the owner does not control. Those providers change
 * underneath us between runs: a model id disappears, a usage field stops being reported, a
 * request gets routed somewhere else. Contract tests prove the contract at the moment they run;
 * they say nothing about the hours in between, and the system can be quietly producing
 * unreliable work the whole time.
 *
 * Two live examples, both measured on this machine rather than imagined:
 *
 *   1. The zen proxy SILENTLY SUBSTITUTES MODELS. Asked for `claude-zen-opus` it returns
 *      `gpt-5.6-sol@low`. Nothing in the response announces the swap. That is not cosmetic:
 *      the product's independent-review guarantee assumes the reviewer is a different model
 *      from the worker, and two different *requested* models can resolve to the same one.
 *   2. Only the antigravity gateway reports `reasoning_tokens`. The truncation diagnosis in
 *      gateway-errors.mjs depends on it, so on the other gateways a budget-starved response is
 *      invisible for a different reason than the one we already fixed.
 *
 * THE APPROACH
 *
 * Declare the properties the system actually depends on, verify them against the live gateway,
 * and persist a snapshot. Drift is then a diff between snapshots — reviewable, attributable to
 * a date, and surfaced in the cockpit — instead of a mystery bug weeks later. The same
 * assertions run cheaply on every real call (see gateway-errors.mjs), so drift surfaces at the
 * moment it affects work rather than at the next test run.
 *
 * Consistent with INVARIANT 1: when a provider stops meeting a capability the system relies on,
 * say so. Do not keep reporting numbers that have quietly become fiction.
 */

/** Capabilities the orchestrator depends on, and what breaks when each one goes away. */
export const CONTRACT_CAPABILITIES = Object.freeze({
  reachable: {
    required: true,
    breaks: 'Nothing can run. Every model-backed gate holds.',
  },
  honoursRequestedModel: {
    required: false, // observed, not demanded — some gateways legitimately route
    breaks: 'Independent review cannot be guaranteed: the reviewer and worker may silently '
      + 'resolve to the same model. Review comparisons must use the RESOLVED model.',
  },
  reportsUsage: {
    required: true,
    breaks: 'Token accounting becomes fiction and cost reporting is unsafe to trust.',
  },
  reportsReasoningTokens: {
    required: false,
    breaks: 'Budget-truncation detection is blind: a response can be cut off mid-JSON while '
      + 'reporting stop_reason "end_turn" and nothing will explain why.',
  },
  returnsTextContent: {
    required: true,
    breaks: 'Every structured-output feature (blueprint, decomposition, review) fails.',
  },
})

/**
 * Compare two model identifiers for *material* difference.
 *
 * Gateways decorate ids with routing suffixes (`gpt-5.6-sol` → `gpt-5.6-sol@low`), which is
 * benign. A different family (`claude-zen-opus` → `gpt-5.6-sol`) is not: it means the request
 * was rerouted to a different model entirely.
 */
export function modelFamily(modelId) {
  return String(modelId || '')
    .toLowerCase()
    .split('@')[0]           // routing suffix
    .replace(/-(low|high|medium|tiered|extra-low|thinking|lite)$/g, '')
    .trim()
}

export function isMaterialModelSubstitution(requested, resolved) {
  if (!requested || !resolved) return false
  return modelFamily(requested) !== modelFamily(resolved)
}

/**
 * Assess a single live response envelope against the contract.
 * Pure — takes a parsed response body, returns observations. Used both by the periodic
 * verifier and by every real call at runtime.
 */
export function observeEnvelope({ requestedModel, body }) {
  const usage = body?.usage || {}
  const resolvedModel = body?.model || null
  const contentTypes = (body?.content || []).map((b) => b.type)

  return {
    resolvedModel,
    honoursRequestedModel: !isMaterialModelSubstitution(requestedModel, resolvedModel),
    reportsUsage: typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number',
    reportsReasoningTokens: typeof usage.reasoning_tokens === 'number',
    returnsTextContent: contentTypes.includes('text'),
    stopReason: body?.stop_reason || null,
    usageKeys: Object.keys(usage).sort(),
    contentTypes: [...new Set(contentTypes)].sort(),
  }
}

/**
 * Verify a gateway against the contract with one small live call.
 * Never throws — an unreachable provider is a contract observation, not a crash.
 */
export async function verifyProviderContract({
  gatewayUrl,
  model,
  apiKey = 'local-antigravity',
  timeoutMs = Number(process.env.ZEN_CONTRACT_TIMEOUT_MS || 60000),
  fetchImpl = fetch,
} = {}) {
  const observedAt = Date.now()
  const base = { gatewayUrl, requestedModel: model, observedAt }

  let res
  try {
    res = await fetchImpl(`${gatewayUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      // Deliberately tiny: this runs on a cadence and spends real subscription quota.
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: 'Reply with only the word PONG.',
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { ...base, reachable: false, error: `unreachable: ${err.message}` }
  }

  if (!res.ok) {
    return { ...base, reachable: false, error: `HTTP ${res.status}` }
  }

  let body
  try {
    body = await res.json()
  } catch (err) {
    return { ...base, reachable: false, error: `non-JSON body: ${err.message}` }
  }

  return { ...base, reachable: true, error: null, ...observeEnvelope({ requestedModel: model, body }) }
}

/**
 * Stable fingerprint of the capability surface, so a snapshot can be compared cheaply.
 * Deliberately excludes timestamps and the resolved model id (routing suffixes churn).
 */
export function contractFingerprint(snapshot) {
  const material = {
    reachable: !!snapshot.reachable,
    honoursRequestedModel: !!snapshot.honoursRequestedModel,
    reportsUsage: !!snapshot.reportsUsage,
    reportsReasoningTokens: !!snapshot.reportsReasoningTokens,
    returnsTextContent: !!snapshot.returnsTextContent,
    usageKeys: snapshot.usageKeys || [],
    contentTypes: snapshot.contentTypes || [],
  }
  return 'sha256:' + createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32)
}

/**
 * What changed between two snapshots, in terms a human can act on.
 *
 * Returns { drifted, changes: [{ capability, from, to, severity, consequence }] }.
 * `severity` is 'breaking' when the system relies on the capability, 'degraded' when a
 * safeguard quietly loses its teeth, and 'info' for routing noise.
 */
export function diffContractSnapshots(previous, current) {
  if (!previous) return { drifted: false, changes: [], reason: 'no previous snapshot' }

  const changes = []
  const note = (capability, from, to) => {
    const meta = CONTRACT_CAPABILITIES[capability]
    changes.push({
      capability,
      from,
      to,
      severity: meta?.required ? 'breaking' : 'degraded',
      consequence: meta?.breaks || 'Unknown effect.',
    })
  }

  for (const capability of Object.keys(CONTRACT_CAPABILITIES)) {
    const before = !!previous[capability]
    const after = !!current[capability]
    // Only losing a capability is drift worth alarming on; regaining one is good news.
    if (before && !after) note(capability, before, after)
  }

  const beforeKeys = (previous.usageKeys || []).join(',')
  const afterKeys = (current.usageKeys || []).join(',')
  if (beforeKeys !== afterKeys) {
    changes.push({
      capability: 'usageKeys',
      from: beforeKeys,
      to: afterKeys,
      severity: 'info',
      consequence: 'The usage envelope changed shape; check token accounting still adds up.',
    })
  }

  return {
    drifted: changes.length > 0,
    changes,
    reason: changes.length ? 'capability surface changed' : 'no material change',
  }
}

/** Format a drift report for a log line or an audit entry. */
export function formatDrift(gatewayUrl, diff) {
  if (!diff.drifted) return `${gatewayUrl}: no contract drift`
  const lines = diff.changes.map((c) => `  [${c.severity}] ${c.capability}: ${c.from} -> ${c.to} — ${c.consequence}`)
  return `${gatewayUrl}: PROVIDER CONTRACT DRIFT\n${lines.join('\n')}`
}

/**
 * Verify every configured gateway, persist a snapshot, and report drift against the last one.
 *
 * This is the piece that overcomes the limitation contract tests leave behind: they prove the
 * contract at the instant they run, whereas this records it continuously, so a capability that
 * disappears is attributable to a moment and visible without anyone remembering to look.
 *
 * Never throws — a provider being down is an observation, not a reason to stop the orchestrator.
 */
export async function sweepProviderContracts({
  gateways = defaultGatewayTargets(),
  db = null,
  onDrift = null,
  // Skip a gateway whose last snapshot is still fresh. Each verification is a real request
  // against the owner's pooled subscriptions, and the orchestrator restarts often during
  // development — re-verifying on every boot would spend quota to learn nothing.
  maxAgeMs = Number(process.env.ZEN_CONTRACT_MAX_AGE_MS || 3600000),
  force = false,
} = {}) {
  const {
    recordProviderContractSnapshot,
    getLatestProviderContractSnapshot,
    recordAuditLog,
  } = await import('./db/index.mjs')

  const results = []

  for (const target of gateways) {
    const previous = getLatestProviderContractSnapshot(target.gatewayUrl, db)

    if (!force && previous && Date.now() - previous.observedAt < maxAgeMs) {
      results.push({ target: target.gatewayUrl, snapshot: previous, diff: { drifted: false, changes: [], reason: 'snapshot still fresh' }, skipped: true })
      continue
    }

    const observed = await verifyProviderContract(target)
    const snapshot = { ...observed, fingerprint: contractFingerprint(observed) }

    const diff = diffContractSnapshots(previous, snapshot)
    recordProviderContractSnapshot(snapshot, db)

    if (diff.drifted) {
      const breaking = diff.changes.filter((c) => c.severity === 'breaking')
      recordAuditLog({
        // Provider drift is system-wide, not attributable to one project.
        projectId: null,
        eventType: breaking.length ? 'PROVIDER_CONTRACT_BROKEN' : 'PROVIDER_CONTRACT_DRIFT',
        actor: 'orchestrator',
        details: { gatewayUrl: target.gatewayUrl, changes: diff.changes },
      }, db)
      onDrift?.({ target, diff, snapshot, previous })
    }

    results.push({ target: target.gatewayUrl, snapshot, diff })
  }

  return {
    results,
    drifted: results.filter((r) => r.diff.drifted),
    unreachable: results.filter((r) => !r.snapshot.reachable),
  }
}

/**
 * The gateways this deployment actually depends on, and the model each is asked for.
 * Kept here so the sweep and the cockpit agree on what "configured" means.
 */
export function defaultGatewayTargets() {
  return [
    {
      gatewayUrl: process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788',
      model: process.env.ZEN_ARCHITECT_MODEL || 'gemini-3.8-flash-tiered',
      role: 'architect/blueprint/decomposition',
    },
    {
      gatewayUrl: process.env.ZEN_REVIEWER_GATEWAY_URL || process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788',
      model: process.env.ZEN_REVIEWER_MODEL || 'gemini-3.8-flash-tiered',
      role: 'reviewer',
    },
  ].filter((t, i, all) => all.findIndex((o) => o.gatewayUrl === t.gatewayUrl && o.model === t.model) === i)
}
