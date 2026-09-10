import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { spawnControlledProcess } from './security-boundary.mjs'
import { callGatewayForText, GatewayUnavailableError } from './gateway-errors.mjs'
import { recordVerificationResult, getOrchestratorDb } from './db/index.mjs'
import { computeVerificationDigest } from './verifier-engine.mjs'

/**
 * QA engine — visual and end-to-end verification.
 *
 * This is the department that makes "done" mean something. Deterministic tests prove the code
 * runs; this proves the thing a person would actually look at matches what was asked for.
 *
 * INVARIANT 1 applies with full force here: if the browser tool or the judging gateway is
 * unavailable, the answer is UNAVAILABLE, never PASSED. A QA tier that silently passes when it
 * could not look at anything is worse than no QA tier, because it manufactures the exact
 * "hallucinated done" this product exists to eliminate.
 */

export class QAUnavailableError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message)
    this.name = 'QAUnavailableError'
    this.code = 'E_QA_UNAVAILABLE'
    if (cause) this.cause = cause
  }
}

export const QA_JUDGE_SYSTEM_PROMPT = `You are a meticulous QA engineer reviewing a running web application against its acceptance criteria.

You are given a screenshot of the application and an accessibility snapshot of the page, plus a list of acceptance criteria.

For EACH criterion, decide whether the evidence actually demonstrates it is met. Judge only what you can see. If the screenshot does not show enough to decide, the criterion is NOT met — say what additional view would settle it.

Do not be generous. A criterion is met only if the evidence positively demonstrates it. Missing, blank, broken, or unrendered UI is a failure, not an ambiguity.

Respond with strictly valid JSON:
{
  "findings": [
    { "criterion": "<the criterion text, verbatim>", "met": true|false, "evidence": "<what in the screenshot/snapshot shows this>" }
  ],
  "summary": "<1-3 sentences>"
}`

/**
 * Is the browser automation CLI usable on this machine?
 */
export function detectBrowserTool() {
  try {
    const res = spawnSync('agent-browser', ['--version'], { encoding: 'utf8' })
    if (res.status === 0) {
      return { available: true, version: (res.stdout || '').trim() }
    }
  } catch {}
  return { available: false, version: null }
}

/**
 * Run one agent-browser subcommand inside a dedicated session.
 *
 * The session name matters: the default agent-browser session is a single browser shared
 * across every agent on the machine and persists between conversations, so using it could
 * hijack a page the owner has open. Each QA run gets its own.
 */
async function browser(sessionId, args, { timeoutMs = 60000 } = {}) {
  return spawnControlledProcess('agent-browser', args, {
    timeoutMs,
    env: { ...process.env, AGENT_BROWSER_SESSION: sessionId },
  })
}

/**
 * Drive a running preview and judge it against acceptance criteria.
 *
 * @returns {Promise<{passed:boolean, findings:Array, screenshots:Array, summary:string}>}
 * @throws {QAUnavailableError|GatewayUnavailableError} when QA could not be performed at all.
 */
export async function runE2ESuite({
  taskId,
  previewUrl,
  acceptanceCriteria = [],
  artifactDir = null,
  gatewayUrl = process.env.ZEN_GATEWAY_URL || 'http://127.0.0.1:8788',
  model = process.env.ZEN_QA_MODEL || 'gemini-3.8-flash-tiered',
  timeoutMs = 120000,
  browserRunner = null, // test seam: ({ sessionId, previewUrl, outDir }) => { screenshotPath, snapshot }
  judgeRunner = null,   // test seam: ({ criteria, snapshot, screenshotBase64 }) => payload
}) {
  if (!previewUrl) throw new QAUnavailableError('runE2ESuite requires a previewUrl')

  // No criteria means nothing to verify. Returning "passed" here would be the fabrication this
  // engine exists to prevent — an empty checklist is not a green one.
  if (!acceptanceCriteria.length) {
    throw new QAUnavailableError(
      `No acceptance criteria supplied for task ${taskId}. QA cannot pass a task with nothing to check.`
    )
  }

  const outDir = artifactDir || fs.mkdtempSync(path.join(os.tmpdir(), `zen-qa-${taskId}-`))
  fs.mkdirSync(outDir, { recursive: true })

  const sessionId = `zen-qa-${taskId}-${Date.now()}`
  let capture

  if (browserRunner) {
    capture = await browserRunner({ sessionId, previewUrl, outDir })
  } else {
    const tool = detectBrowserTool()
    if (!tool.available) {
      throw new QAUnavailableError(
        'agent-browser CLI is not available, so the running application could not be inspected. ' +
        'Install it (npm i -g agent-browser && agent-browser install) or disable the QA gate ' +
        'explicitly — it must not be treated as a pass.'
      )
    }
    capture = await captureWithBrowser({ sessionId, previewUrl, outDir, timeoutMs })
  }

  const screenshotBase64 = fs.readFileSync(capture.screenshotPath).toString('base64')

  const payload = judgeRunner
    ? await judgeRunner({ criteria: acceptanceCriteria, snapshot: capture.snapshot, screenshotBase64 })
    : await judgeWithModel({
      gatewayUrl, model, timeoutMs,
      criteria: acceptanceCriteria,
      snapshot: capture.snapshot,
      screenshotBase64,
    })

  const findings = normaliseFindings(payload, acceptanceCriteria)

  return {
    // Fail closed: every criterion must be positively met.
    passed: findings.every((f) => f.met),
    findings,
    summary: payload?.summary || '',
    screenshots: [{ name: 'preview', path: capture.screenshotPath }],
    sessionId,
  }
}

async function captureWithBrowser({ sessionId, previewUrl, outDir, timeoutMs }) {
  const screenshotPath = path.join(outDir, 'preview.png')

  try {
    const opened = await browser(sessionId, ['open', previewUrl], { timeoutMs })
    if (opened.exitCode !== 0) {
      throw new QAUnavailableError(
        `Could not open the preview at ${previewUrl}: ${(opened.stderr || opened.stdout || '').trim().slice(0, 300)}`
      )
    }

    // Let the app settle before judging it, or we screenshot a loading spinner and call it a
    // failure that is really a race.
    await browser(sessionId, ['wait', '--load', 'networkidle'], { timeoutMs })

    const shot = await browser(sessionId, ['screenshot', screenshotPath], { timeoutMs })
    if (shot.exitCode !== 0 || !fs.existsSync(screenshotPath)) {
      throw new QAUnavailableError(
        `Screenshot failed: ${(shot.stderr || shot.stdout || '').trim().slice(0, 300)}`
      )
    }

    // The accessibility snapshot is cheap, textual, and often decides criteria a screenshot
    // cannot (labels, roles, disabled states).
    const snap = await browser(sessionId, ['snapshot'], { timeoutMs })

    return { screenshotPath, snapshot: (snap.stdout || '').slice(0, 20000) }
  } finally {
    // Always release the browser session, including on failure — a leaked session keeps a
    // headless Chrome alive on the owner's machine.
    try { await browser(sessionId, ['close'], { timeoutMs: 15000 }) } catch {}
  }
}

async function judgeWithModel({ gatewayUrl, model, timeoutMs, criteria, snapshot, screenshotBase64 }) {
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')

  const { text } = await callGatewayForText({
    gatewayUrl,
    model,
    timeoutMs,
    system: QA_JUDGE_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 },
        },
        {
          type: 'text',
          text:
            `Acceptance criteria:\n${criteriaList}\n\n` +
            `Accessibility snapshot of the page:\n\`\`\`\n${snapshot}\n\`\`\`\n\n` +
            'Respond with strictly valid JSON as specified.',
        },
      ],
    }],
  })

  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    // Unparseable judgement is not a pass. See INVARIANT 1.
    throw new GatewayUnavailableError(
      'QA judge returned no parseable JSON verdict; refusing to infer a result.',
      { gatewayUrl },
    )
  }

  try {
    return JSON.parse(match[0])
  } catch (err) {
    throw new GatewayUnavailableError(
      `QA judge returned malformed JSON: ${err.message}`,
      { gatewayUrl, cause: err },
    )
  }
}

/**
 * Map the model's findings back onto the requested criteria.
 *
 * Any criterion the judge did not explicitly mark met is NOT met. A judge that skips a
 * criterion must not thereby grant it.
 */
export function normaliseFindings(payload, criteria) {
  const reported = Array.isArray(payload?.findings) ? payload.findings : []

  return criteria.map((criterion) => {
    const hit = reported.find((f) => typeof f?.criterion === 'string'
      && f.criterion.trim().toLowerCase() === String(criterion).trim().toLowerCase())

    if (!hit) {
      return { criterion, met: false, evidence: 'QA judge did not report on this criterion.' }
    }
    return {
      criterion,
      met: hit.met === true,
      evidence: typeof hit.evidence === 'string' ? hit.evidence : '',
    }
  })
}

/**
 * Persist a QA run as a verification_results row so the existing promotion gate applies
 * unchanged. `environment_info.kind` discriminates it from a deterministic test run — no
 * schema change needed, and the reviewer can see which kind of evidence it is looking at.
 */
export function recordQAResult({ taskRunId, previewUrl, result }, db = null) {
  const targetDb = db || getOrchestratorDb()

  const outputLog = [
    `QA visual/e2e verification against ${previewUrl}`,
    result.summary ? `Summary: ${result.summary}` : '',
    ...result.findings.map((f) => `[${f.met ? 'MET' : 'NOT MET'}] ${f.criterion} — ${f.evidence}`),
  ].filter(Boolean).join('\n')

  const verificationDigest = computeVerificationDigest({
    commands: ['qa:e2e'],
    exitCodes: [result.passed ? 0 : 1],
    outputLogs: [outputLog],
  })

  return recordVerificationResult({
    taskRunId,
    command: 'qa:e2e',
    exitCode: result.passed ? 0 : 1,
    outputLog,
    verificationDigest,
    environmentInfo: {
      kind: 'E2E_VISUAL',
      previewUrl,
      screenshots: result.screenshots.map((s) => s.path),
      criteriaCount: result.findings.length,
    },
    passed: result.passed,
  }, targetDb)
}
