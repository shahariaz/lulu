import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import {
  runE2ESuite,
  normaliseFindings,
  detectBrowserTool,
  recordQAResult,
  QAUnavailableError,
} from '../lib/orchestrator/qa-engine.mjs'
import {
  getOrchestratorDb,
  closeOrchestratorDb,
  createProject,
  createBaseline,
  createMilestone,
  createTask,
  createTaskRun,
  getVerificationResults,
} from '../lib/orchestrator/db/index.mjs'

const browserTool = detectBrowserTool()
const skipBrowser = browserTool.available ? false : 'agent-browser CLI not available'

/** Serve a fixed HTML page so the browser has something real to look at. */
async function servePage(html) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((r) => server.close(r)),
  }
}

// ---------------------------------------------------------------------------
// Fail-closed behaviour. These are the tests that matter most: a QA tier that
// passes when it could not actually look at anything manufactures exactly the
// "hallucinated done" the product exists to eliminate.
// ---------------------------------------------------------------------------

test('QA refuses to pass a task that has no acceptance criteria', async () => {
  await assert.rejects(
    () => runE2ESuite({ taskId: 't1', previewUrl: 'http://127.0.0.1:1', acceptanceCriteria: [] }),
    (err) => {
      assert.equal(err.code, 'E_QA_UNAVAILABLE')
      assert.match(err.message, /nothing to check/i)
      return true
    },
  )
})

test('QA fails closed when the judge omits a criterion', () => {
  const criteria = ['Header is visible', 'Footer shows the year']

  // The judge only reported on one of the two.
  const findings = normaliseFindings({ findings: [{ criterion: 'Header is visible', met: true, evidence: 'seen' }] }, criteria)

  assert.equal(findings.length, 2)
  assert.equal(findings[0].met, true)
  assert.equal(findings[1].met, false, 'an unreported criterion must never count as met')
  assert.match(findings[1].evidence, /did not report/i)
})

test('QA treats a non-boolean or missing met flag as not met', () => {
  const criteria = ['A', 'B', 'C']
  const findings = normaliseFindings({
    findings: [
      { criterion: 'A', met: 'yes' },      // truthy string, not true
      { criterion: 'B' },                   // no met field
      { criterion: 'C', met: true },
    ],
  }, criteria)

  assert.equal(findings[0].met, false, 'only an exact boolean true may pass')
  assert.equal(findings[1].met, false)
  assert.equal(findings[2].met, true)
})

test('QA fails closed when the judge returns an unusable verdict', async () => {
  const page = await servePage('<html><body><h1>Hi</h1></body></html>')
  try {
    await assert.rejects(
      () => runE2ESuite({
        taskId: 't2',
        previewUrl: page.url,
        acceptanceCriteria: ['Something is shown'],
        // Stub the browser so this test does not need a real one.
        browserRunner: async ({ outDir }) => {
          const p = path.join(outDir, 'preview.png')
          fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex'))
          return { screenshotPath: p, snapshot: 'h1 "Hi"' }
        },
        judgeRunner: async () => { throw new Error('gateway exploded') },
      }),
      /gateway exploded/,
    )
  } finally {
    await page.close()
  }
})

test('a task only passes when every criterion is positively met', async () => {
  const page = await servePage('<html><body><h1>Dashboard</h1></body></html>')
  const stubBrowser = async ({ outDir }) => {
    const p = path.join(outDir, 'preview.png')
    fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex'))
    return { screenshotPath: p, snapshot: 'h1 "Dashboard"' }
  }

  try {
    const allMet = await runE2ESuite({
      taskId: 't3',
      previewUrl: page.url,
      acceptanceCriteria: ['Dashboard heading is visible'],
      browserRunner: stubBrowser,
      judgeRunner: async () => ({
        findings: [{ criterion: 'Dashboard heading is visible', met: true, evidence: 'h1 reads Dashboard' }],
        summary: 'Looks right.',
      }),
    })
    assert.equal(allMet.passed, true)

    const oneMissed = await runE2ESuite({
      taskId: 't4',
      previewUrl: page.url,
      acceptanceCriteria: ['Dashboard heading is visible', 'A chart is rendered'],
      browserRunner: stubBrowser,
      judgeRunner: async () => ({
        findings: [
          { criterion: 'Dashboard heading is visible', met: true, evidence: 'h1 reads Dashboard' },
          { criterion: 'A chart is rendered', met: false, evidence: 'no chart in the screenshot' },
        ],
        summary: 'Chart missing.',
      }),
    })
    assert.equal(oneMissed.passed, false, 'one unmet criterion must fail the whole gate')
    assert.equal(oneMissed.findings.filter((f) => !f.met).length, 1)
  } finally {
    await page.close()
  }
})

test('recordQAResult stores a verification row the existing gate understands', () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-qa-db-'))
  try {
    const db = getOrchestratorDb(path.join(dbDir, 'qa.sqlite'))
    const project = createProject({ name: 'QA', repoPath: '/tmp/qa' }, db)
    const baseline = createBaseline({ projectId: project.id, specMarkdown: 's', contentDigest: 'd', status: 'APPROVED' }, db)
    const milestone = createMilestone({ baselineId: baseline.id, title: 'M' }, db)
    const task = createTask({ milestoneId: milestone.id, title: 'QA task', status: 'Automated Checks' }, db)
    const run = createTaskRun({ taskId: task.id, kind: 'VERIFICATION', role: 'QA' }, db)

    recordQAResult({
      taskRunId: run.id,
      previewUrl: 'http://127.0.0.1:41000/',
      result: {
        passed: false,
        summary: 'Chart missing.',
        findings: [
          { criterion: 'Heading visible', met: true, evidence: 'h1 present' },
          { criterion: 'Chart rendered', met: false, evidence: 'blank area' },
        ],
        screenshots: [{ name: 'preview', path: '/tmp/preview.png' }],
      },
    }, db)

    const [stored] = getVerificationResults(run.id, db)
    assert.equal(stored.passed, 0)
    assert.equal(stored.exit_code, 1)
    assert.equal(stored.environment_info.kind, 'E2E_VISUAL')
    assert.match(stored.output_log, /\[NOT MET\] Chart rendered/)
    assert.ok(stored.verification_digest.startsWith('sha256:'))
  } finally {
    closeOrchestratorDb()
    fs.rmSync(dbDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Live browser test — drives a real headless Chrome against a real page.
// ---------------------------------------------------------------------------

test('the browser really renders the page and the snapshot reflects its content', { skip: skipBrowser }, async () => {
  const page = await servePage(`
    <html><body style="font-family:sans-serif;padding:40px">
      <h1 id="title">Claude-Zen QA Fixture</h1>
      <button id="go">Run report</button>
    </body></html>
  `)

  try {
    let captured = null
    const result = await runE2ESuite({
      taskId: 'live1',
      previewUrl: page.url,
      acceptanceCriteria: ['The page shows a heading', 'A button is present'],
      timeoutMs: 90000,
      // Real browser; stub only the judge so the test does not need a live gateway.
      judgeRunner: async ({ snapshot, screenshotBase64 }) => {
        captured = { snapshot, screenshotBase64 }
        return {
          findings: [
            { criterion: 'The page shows a heading', met: /Claude-Zen QA Fixture/.test(snapshot), evidence: 'heading in snapshot' },
            { criterion: 'A button is present', met: /button/i.test(snapshot), evidence: 'button in snapshot' },
          ],
          summary: 'Judged from a real snapshot.',
        }
      },
    })

    assert.ok(captured, 'the judge must receive real capture data')
    assert.ok(captured.screenshotBase64.length > 100, 'a real screenshot must be captured')
    assert.match(captured.snapshot, /Claude-Zen QA Fixture/, 'snapshot must reflect the rendered page')
    assert.equal(result.passed, true)
    assert.ok(fs.existsSync(result.screenshots[0].path))
  } finally {
    await page.close()
  }
})
