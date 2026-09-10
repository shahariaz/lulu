import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { startOrchestratorServer } from '../lib/orchestrator/api.mjs'
import { getOrchestratorDb, closeOrchestratorDb } from '../lib/orchestrator/db/index.mjs'

// This suite drives the HTTP API with caller-supplied mock model output. That is refused by
// default (see lib/orchestrator/http/shared.mjs — a request must never be able to fabricate
// content indistinguishable from real model output). Opt in explicitly for these tests only;
// test/mock-injection-gate.test.mjs asserts the default stays OFF.
process.env.ZEN_ALLOW_MOCK_INJECTION = '1'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-fe-test-'))
  return path.join(tmpDir, 'test-frontend.sqlite')
}

function createTempGitRepo(prefix = 'zen-repo-fe-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execFileSync('git', ['init', '-b', 'main', tmpDir])
  execFileSync('git', ['config', 'user.name', 'Frontend Tester'], { cwd: tmpDir })
  execFileSync('git', ['config', 'user.email', 'fe@example.com'], { cwd: tmpDir })

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'fe-app',
    version: '1.0.0',
    scripts: { test: 'node -e "process.exit(0)"' }
  }, null, 2))
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Frontend App\n')

  execFileSync('git', ['add', '.'], { cwd: tmpDir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpDir })

  return tmpDir
}

test('Frontend static assets, SPA fallback, and realtime SSE event broadcasting', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createTempGitRepo()

  const serverInfo = await startOrchestratorServer({ port: 0, db })
  const { url } = serverInfo

  try {
    // 1. Static HTML Delivery & SPA Fallback
    const rootRes = await fetch(`${url}/`)
    assert.equal(rootRes.status, 200)
    assert.match(rootRes.headers.get('content-type') || '', /text\/html/)
    const rootHtml = await rootRes.text()
    assert.match(rootHtml, /Claude-Zen \| AI Software Delivery Platform/)

    const delivRes = await fetch(`${url}/delivery`)
    assert.equal(delivRes.status, 200)
    assert.match(delivRes.headers.get('content-type') || '', /text\/html/)

    // 2. Real-time Server-Sent Events (SSE) stream connection
    const sseEvents = []
    const controller = new AbortController()

    const ssePromise = (async () => {
      const sseRes = await fetch(`${url}/api/orchestrator/events`, {
        signal: controller.signal,
      })
      assert.equal(sseRes.status, 200)
      assert.match(sseRes.headers.get('content-type') || '', /text\/event-stream/)

      const reader = sseRes.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n\n')
        buffer = lines.pop() || ''
        for (const block of lines) {
          if (block.trim()) {
            sseEvents.push(block.trim())
          }
        }
      }
    })().catch(() => {})

    // Give SSE connection brief moment to establish
    await new Promise((r) => setTimeout(r, 80))

    // 3. Trigger orchestrator operations and verify live SSE broadcasts
    // Import Project
    const projRes = await fetch(`${url}/api/orchestrator/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repo, name: 'PWA Test App' }),
    })
    const { project } = await projRes.json()

    // Draft & Approve Baseline
    const draftRes = await fetch(`${url}/api/orchestrator/projects/${project.id}/baselines/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specMarkdown: '# PWA PRD\n- REQ-F-01: Offline shell', version: 'v1.0.0' }),
    })
    const { draft } = await draftRes.json()
    await fetch(`${url}/api/orchestrator/baselines/${draft.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvedBy: 'owner' }),
    })

    // Decompose into Task
    const decompRes = await fetch(`${url}/api/orchestrator/baselines/${draft.id}/decompose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskDefinitions: [{ title: 'Implement Service Worker', scopePaths: ['sw.js'] }],
      }),
    })
    const { tasks } = await decompRes.json()
    const task = tasks[0]

    // Claim Task (broadcasts 'task_claimed')
    await fetch(`${url}/api/orchestrator/tasks/${task.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, featureSlug: 'pwa-feat' }),
    })

    // Execute Worker (broadcasts 'worker_completed')
    const execRes = await fetch(`${url}/api/orchestrator/tasks/${task.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        mockFiles: [{ path: 'sw.js', content: 'self.addEventListener("fetch", () => {});\n' }],
      }),
    })
    const { workerResult } = await execRes.json()

    // Verification (broadcasts 'verification_completed')
    await fetch(`${url}/api/orchestrator/tasks/${task.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, checkCommands: ['npm test'] }),
    })

    // Review (broadcasts 'review_completed')
    await fetch(`${url}/api/orchestrator/tasks/${task.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        candidateCommitSha: workerResult.candidateCommitSha,
        mockReview: { verdict: 'APPROVE', summary: 'Clean service worker' },
      }),
    })

    // Accept (broadcasts 'task_accepted')
    await fetch(`${url}/api/orchestrator/tasks/${task.id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath: repo,
        candidateCommitSha: workerResult.candidateCommitSha,
        featureBranch: 'zen/pwa-feat',
        acceptedBy: 'owner',
      }),
    })

    // Wait for SSE events to arrive
    await new Promise((r) => setTimeout(r, 120))
    controller.abort()
    await ssePromise

    // Verify all real-time events were captured
    const eventBlocks = sseEvents.join('\n')
    assert.match(eventBlocks, /event: connected/)
    assert.match(eventBlocks, /event: task_claimed/)
    assert.match(eventBlocks, /event: worker_completed/)
    assert.match(eventBlocks, /event: verification_completed/)
    assert.match(eventBlocks, /event: review_completed/)
    assert.match(eventBlocks, /event: task_accepted/)
  } finally {
    await serverInfo.close()
    closeOrchestratorDb()
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
