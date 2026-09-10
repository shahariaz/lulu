import {
  recordReviewRecord,
  getTask,
  getLatestTaskRunByKind,
  recordAuditLog,
  getOrchestratorDb,
} from './db/index.mjs'
import { runGit } from './git-workspace.mjs'
import { computeSpecDigest } from './spec-engine.mjs'
import { transitionTask } from './dag-scheduler.mjs'
import { isMaterialModelSubstitution } from './provider-contract.mjs'
import { STRUCTURED_OUTPUT_MAX_TOKENS } from './gateway-errors.mjs'

export const SPECIALIST_REVIEW_SYSTEM_PROMPT = `You are an expert, independent Senior Staff Code Reviewer for Claude-Zen.
Your duty is to conduct a rigorous, adversarial code review of a candidate git diff against its specification and test results.

Evaluate the diff across these dimensions:
1. Correctness: Does the code meet all requirements and edge cases?
2. Security: Are there injection risks, path traversals, credential leaks, or memory/resource issues?
3. Regressions: Does the change break existing behaviors or violate interfaces?
4. Quality & Tests: Are new tests comprehensive, readable, and properly isolated?

You must respond with a strictly valid JSON object conforming to this schema:
{
  "verdict": "APPROVE" | "CHANGES_REQUESTED",
  "summary": "A clear, 1-3 sentence summary of the review",
  "findings": [
    {
      "category": "correctness" | "security" | "regression" | "style",
      "severity": "critical" | "high" | "medium" | "low",
      "file": "file/path.ext",
      "line": 10,
      "description": "Specific issue explanation"
    }
  ]
}`

/**
 * Cheap reachability check for the reviewer gateway.
 * Returns { available, reason } — never throws, so a probe failure is a hold, not a crash.
 */
export async function probeSpecialistAvailable(modelConfig = {}) {
  const gatewayUrl = modelConfig.gatewayUrl || process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788'
  const timeoutMs = Number(process.env.ZEN_REVIEWER_PROBE_TIMEOUT_MS || 3000)

  try {
    const res = await fetch(`${gatewayUrl}/v1/models`, {
      method: 'GET',
      headers: { 'x-api-key': 'local-antigravity', 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    // Any HTTP answer proves the gateway is up. 404 is fine — some gateways omit /v1/models.
    if (res.status >= 500) {
      return { available: false, reason: `reviewer gateway unhealthy (HTTP ${res.status})` }
    }
    return { available: true, reason: null }
  } catch (err) {
    return { available: false, reason: `reviewer gateway unreachable at ${gatewayUrl}: ${err.message}` }
  }
}

/**
 * Hold a task in Code Review because no independent specialist reviewer could be reached.
 *
 * INVARIANT (Specialist Quota Rule): a review that could not be performed must never be
 * downgraded, bypassed, or synthesised into a verdict. The task stays in Code Review with
 * waiting_reason = 'SPECIALIST_UNAVAILABLE' until a real reviewer responds. This function is
 * the ONLY sanctioned outcome for "the reviewer did not run" — do not add a fallback verdict.
 */
function holdForUnavailableSpecialist({
  taskId,
  projectId,
  taskRunId,
  candidateCommitSha,
  modelConfig = {},
  reason,
}, db) {
  transitionTask(taskId, 'Code Review', {
    waitingReason: 'SPECIALIST_UNAVAILABLE',
    actor: 'orchestrator',
    automatic: true,
    details: { projectId, taskRunId, candidateCommitSha, reason },
  }, db)

  recordAuditLog({
    projectId,
    taskId,
    eventType: 'REVIEW_PENDING_SPECIALIST_UNAVAILABLE',
    actor: 'orchestrator',
    details: { candidateCommitSha, provider: modelConfig.provider || 'default', reason },
  }, db)

  return {
    status: 'PENDING_SPECIALIST_UNAVAILABLE',
    reason,
    task: getTask(taskId, db),
  }
}

export class ReviewInvalidationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReviewInvalidationError'
    this.code = code
  }
}

/**
 * Perform adversarial code review against an immutable candidate commit diff.
 */
export async function runSpecialistReview({
  taskId,
  projectId,
  taskRunId,
  worktreePath,
  baseCommitSha,
  candidateCommitSha,
  verificationDigest,
  taskTitle = '',
  taskDescription = '',
  modelConfig = {},
  reviewRunner = null, // Custom or mock review runner for tests/gateways
  // Tri-state: null = probe the gateway; true/false = explicit override (tests, callers that
  // already know). Defaulting to `true` would have meant "assume a reviewer exists", which is
  // how an unreachable gateway used to slip through as an approval.
  isSpecialistAvailable = null,
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const task = getTask(taskId, targetDb)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  // Specialist Availability Rule:
  // If the specialist model is unavailable, the review MUST remain pending without bypass or downgrade!
  if (isSpecialistAvailable === false) {
    return holdForUnavailableSpecialist({
      taskId, projectId, taskRunId, candidateCommitSha, modelConfig,
      reason: 'specialist marked unavailable by caller',
    }, targetDb)
  }

  // Unspecified availability: probe the gateway before doing any work. An injected reviewRunner
  // IS the specialist, so it needs no probe.
  if (isSpecialistAvailable === null && !reviewRunner) {
    const probe = await probeSpecialistAvailable(modelConfig)
    if (!probe.available) {
      return holdForUnavailableSpecialist({
        taskId, projectId, taskRunId, candidateCommitSha, modelConfig,
        reason: probe.reason,
      }, targetDb)
    }
  }

  // 1. Post-Verification Cleanliness & Artifact Invalidation Check
  const currentHead = runGit(worktreePath, ['rev-parse', 'HEAD'])
  if (currentHead !== candidateCommitSha) {
    throw new ReviewInvalidationError(
      'E_WORKTREE_ALTERED_POST_VERIFICATION',
      `Worktree HEAD (${currentHead}) no longer matches verified candidate commit (${candidateCommitSha}). Verification invalidated.`
    )
  }

  const postStatus = runGit(worktreePath, ['status', '--porcelain'])
  const postModified = postStatus.split('\n').filter((l) => !l.startsWith('?? ') && l.trim())
  if (postModified.length > 0) {
    throw new ReviewInvalidationError(
      'E_WORKTREE_ALTERED_POST_VERIFICATION',
      `Worktree has uncommitted modifications after verification (${postModified.join(', ')}). Verification invalidated.`
    )
  }

  // 2. Extract Exact Unified Diff
  const diffPatch = runGit(worktreePath, ['diff', `${baseCommitSha}..${candidateCommitSha}`])
  const diffDigest = computeSpecDigest(diffPatch)

  // 3. Reviewer Execution Phase
  let reviewPayload = null
  let unavailableReason = null
  let resolvedReviewerModel = null
  if (reviewRunner) {
    try {
      reviewPayload = await reviewRunner({
        taskTitle: taskTitle || task.title,
        taskDescription: taskDescription || task.description,
        diffPatch,
        diffDigest,
        verificationDigest,
        candidateCommitSha,
      })
      // The real path reads this off the response envelope. A runner may report it too, so the
      // reviewer-is-not-the-author check below is exercisable without a live gateway.
      if (reviewPayload?.resolvedModel) resolvedReviewerModel = reviewPayload.resolvedModel
    } catch (err) {
      unavailableReason = `review runner threw: ${err.message}`
    }

    // A runner that threw or returned nothing means the review did not happen.
    if (!reviewPayload) {
      return holdForUnavailableSpecialist({
        taskId, projectId, taskRunId, candidateCommitSha, modelConfig,
        reason: unavailableReason || 'review runner returned no verdict',
      }, targetDb)
    }
  } else {
    // Attempt live adversarial review via local gateway
    const gatewayUrl = modelConfig.gatewayUrl || process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788'
    const model = modelConfig.model || process.env.ZEN_REVIEWER_MODEL || 'gemini-3.8-flash-tiered'

    try {
      const reviewUserPrompt = `Conduct an adversarial code review of the following candidate diff:
Task: ${taskTitle || task.title}
Description: ${taskDescription || task.description}
Candidate Commit: ${candidateCommitSha}
Verification Digest: ${verificationDigest}

Unified Diff:
\`\`\`diff
${diffPatch.slice(0, 15000)}
\`\`\`

Respond with strictly valid JSON: {"verdict": "APPROVE"|"CHANGES_REQUESTED", "summary": "...", "findings": [...]}`

      const res = await fetch(`${gatewayUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'local-antigravity',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          // The verdict is JSON-parsed out of this response, and max_tokens is shared with
          // reasoning. On 4096, a review with a long findings array truncated mid-array, matched
          // no JSON object, and became a SPECIALIST_UNAVAILABLE hold — so the more thorough the
          // review, the more reliably it failed to deliver one.
          max_tokens: STRUCTURED_OUTPUT_MAX_TOKENS,
          system: SPECIALIST_REVIEW_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: reviewUserPrompt }],
        }),
      })

      if (!res.ok) {
        unavailableReason = `reviewer gateway returned HTTP ${res.status}`
      } else {
        const data = await res.json()
        resolvedReviewerModel = data.model || null
        const textBlock = (data.content || []).find((b) => b.type === 'text')
        if (!textBlock?.text) {
          unavailableReason = 'reviewer response contained no text block'
        } else {
          const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/)
          if (!jsonMatch) {
            unavailableReason = 'reviewer response contained no JSON object'
          } else {
            reviewPayload = JSON.parse(jsonMatch[0])
          }
        }
      }
    } catch (err) {
      unavailableReason = `reviewer gateway call failed: ${err.message}`
    }

    // The reviewer did not produce a usable verdict. Hold the task — never synthesise one.
    if (!reviewPayload) {
      return holdForUnavailableSpecialist({
        taskId, projectId, taskRunId, candidateCommitSha, modelConfig,
        reason: unavailableReason || 'reviewer returned no parseable verdict',
      }, targetDb)
    }
  }

  // INDEPENDENT REVIEW, ENFORCED ON THE MODEL THAT ACTUALLY ANSWERED.
  //
  // The product's fifth guarantee is that the reviewer is not the author. Requesting two
  // different model ids is not evidence of that: gateways silently reroute — asking the zen
  // proxy for `claude-zen-opus` returns `gpt-5.6-sol@low` with nothing in the response
  // announcing the swap — so two distinct requests can resolve to one model and the review
  // becomes self-review without anyone noticing.
  //
  // Only enforced when both resolved models are known; an unknown is not evidence of a breach.
  if (resolvedReviewerModel) {
    const workerRun = getLatestTaskRunByKind(taskId, 'WORKER', targetDb)
    const workerModel = workerRun?.model || null
    if (workerModel && !isMaterialModelSubstitution(workerModel, resolvedReviewerModel)) {
      return holdForUnavailableSpecialist({
        taskId, projectId, taskRunId, candidateCommitSha, modelConfig,
        reason: `reviewer and worker resolved to the same model (${resolvedReviewerModel}); `
          + 'independent review is not possible. Configure ZEN_REVIEWER_MODEL to a different '
          + 'model family, or point the reviewer at a different gateway.',
      }, targetDb)
    }
  }

  // Normalize review verdict.
  // Fail CLOSED: only an explicit APPROVE approves. Anything else — CHANGES_REQUESTED, an
  // unrecognised verdict, a typo, a missing field — blocks promotion and returns to the worker.
  const verdict = reviewPayload.verdict === 'APPROVE' ? 'APPROVE' : 'CHANGES_REQUESTED'

  // 4. Record in SQLite review_records
  const record = recordReviewRecord({
    taskRunId,
    candidateCommitSha,
    diffDigest,
    verificationDigest,
    verdict,
    summary: reviewPayload.summary || '',
    findings: reviewPayload.findings || [],
  }, targetDb)

  // 5. Handle Review Outcome & Transitions
  const outcome = await handleReviewOutcome({
    taskId,
    projectId,
    reviewRecord: record,
  }, targetDb)

  return {
    reviewRecord: record,
    outcome,
  }
}

/**
 * Transition task based on specialist review verdict.
 */
export async function handleReviewOutcome({ taskId, projectId, reviewRecord }, db = null) {
  const targetDb = db || getOrchestratorDb()

  if (reviewRecord.verdict === 'APPROVE') {
    // Advanced to QA (Owner Acceptance stage)
    const updated = transitionTask(taskId, 'QA', {
      waitingReason: 'AWAITING_OWNER_ACCEPTANCE',
      actor: 'specialist-reviewer',
      automatic: true,
      details: {
        projectId,
        candidateCommitSha: reviewRecord.candidate_commit_sha,
        reviewId: reviewRecord.id,
      },
    }, targetDb)

    recordAuditLog({
      projectId,
      taskId,
      eventType: 'REVIEW_APPROVED',
      actor: 'specialist-reviewer',
      details: { reviewId: reviewRecord.id, candidateCommitSha: reviewRecord.candidate_commit_sha },
    }, targetDb)

    return {
      outcome: 'ADVANCED_TO_QA',
      task: updated,
    }
  }

  // Verdict is CHANGES_REQUESTED -> Return to In Progress for worker refinement
  const updated = transitionTask(taskId, 'In Progress', {
    waitingReason: null,
    blockedReason: null,
    actor: 'specialist-reviewer',
    automatic: true,
    details: {
      projectId,
      candidateCommitSha: reviewRecord.candidate_commit_sha,
      reviewId: reviewRecord.id,
      findingsCount: (reviewRecord.findings_json ? JSON.parse(reviewRecord.findings_json) : []).length,
    },
  }, targetDb)

  recordAuditLog({
    projectId,
    taskId,
    eventType: 'REVIEW_CHANGES_REQUESTED',
    actor: 'specialist-reviewer',
    details: { reviewId: reviewRecord.id, summary: reviewRecord.summary },
  }, targetDb)

  return {
    outcome: 'CHANGES_REQUESTED',
    task: updated,
  }
}
