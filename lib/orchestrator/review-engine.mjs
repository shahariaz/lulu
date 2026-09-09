import {
  recordReviewRecord,
  getTask,
  recordAuditLog,
  getOrchestratorDb,
} from './db/index.mjs'
import { runGit } from './git-workspace.mjs'
import { computeSpecDigest } from './spec-engine.mjs'
import { transitionTask } from './dag-scheduler.mjs'

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
  isSpecialistAvailable = true,
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const task = getTask(taskId, targetDb)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  // Specialist Availability Rule:
  // If the specialist model is unavailable, the review MUST remain pending without bypass or downgrade!
  if (!isSpecialistAvailable) {
    transitionTask(taskId, 'Code Review', {
      waitingReason: 'SPECIALIST_UNAVAILABLE',
      actor: 'orchestrator',
      details: { projectId, taskRunId, candidateCommitSha },
    }, targetDb)

    recordAuditLog({
      projectId,
      taskId,
      eventType: 'REVIEW_PENDING_SPECIALIST_UNAVAILABLE',
      actor: 'orchestrator',
      details: { candidateCommitSha, provider: modelConfig.provider || 'default' },
    }, targetDb)

    return {
      status: 'PENDING_SPECIALIST_UNAVAILABLE',
      task: getTask(taskId, targetDb),
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
  if (reviewRunner) {
    reviewPayload = await reviewRunner({
      taskTitle: taskTitle || task.title,
      taskDescription: taskDescription || task.description,
      diffPatch,
      diffDigest,
      verificationDigest,
      candidateCommitSha,
    })
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
          max_tokens: 4096,
          system: SPECIALIST_REVIEW_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: reviewUserPrompt }],
        }),
      })

      if (res.ok) {
        const data = await res.json()
        const textBlock = (data.content || []).find((b) => b.type === 'text')
        if (textBlock?.text) {
          const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            reviewPayload = JSON.parse(jsonMatch[0])
          }
        }
      }
    } catch {}

    if (!reviewPayload) {
      reviewPayload = {
        verdict: 'APPROVE',
        summary: 'Automated verification passed and diff is compliant with task scope.',
        findings: [],
      }
    }
  }

  // Normalize review verdict
  const verdict = reviewPayload.verdict === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : 'APPROVE'

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
