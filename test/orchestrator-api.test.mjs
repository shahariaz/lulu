import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { startOrchestratorServer } from '../lib/orchestrator/api.mjs'
import { getOrchestratorDb, closeOrchestratorDb, getTask } from '../lib/orchestrator/db/index.mjs'
import { runGit } from '../lib/orchestrator/git-workspace.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-api-test-'))
  return path.join(tmpDir, 'test-api.sqlite')
}

function createTempGitRepo(prefix = 'zen-repo-api-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execFileSync('git', ['init', '-b', 'main', tmpDir])
  execFileSync('git', ['config', 'user.name', 'API Tester'], { cwd: tmpDir })
  execFileSync('git', ['config', 'user.email', 'api@example.com'], { cwd: tmpDir })

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'api-app',
    version: '1.0.0',
    scripts: { test: 'node test.mjs' }
  }, null, 2))
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# API App\n')
  fs.writeFileSync(path.join(tmpDir, 'test.mjs'), 'console.log("PASS"); process.exit(0);\n')

  execFileSync('git', ['add', '.'], { cwd: tmpDir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpDir })

  return tmpDir
}

test('Orchestrator Server exposes delivery UI and full API lifecycle', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createTempGitRepo()

  const serverInfo = await startOrchestratorServer({ port: 0, db })
  const { url } = serverInfo

  try {
    // 1. Delivery UI View
    const uiRes = await fetch(`${url}/delivery`)
    assert.equal(uiRes.status, 200)
    const uiHtml = await uiRes.text()
    assert.match(uiHtml, /Claude-Zen \| AI Software Delivery Platform/)
    assert.match(uiHtml, /Delivery Board & Task DAG/)

    // 2. Project Import
    const projRes = await fetch(`${url}/api/orchestrator/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repo, name: 'Sample Delivery Project' }),
    })
    assert.equal(projRes.status, 201)
    const { project } = await projRes.json()
    assert.ok(project.id)
    assert.equal(project.name, 'Sample Delivery Project')

    // 3. Scoping Session
    const scopeStartRes = await fetch(`${url}/api/orchestrator/projects/${project.id}/scoping/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureTitle: 'Calculator API', initialPrompt: 'Add multiply function' }),
    })
    assert.equal(scopeStartRes.status, 200)
    const { session } = await scopeStartRes.json()
    assert.ok(session.id)

    // Send Message
    const msgRes = await fetch(`${url}/api/orchestrator/scoping/${session.id}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'Ensure it handles negative numbers' }),
    })
    assert.equal(msgRes.status, 200)

    // 4. Draft Baseline
    const specMarkdown = `
# Feature: Calculator API
## Requirements
- REQ-F-01: Multiply function
- REQ-F-02: Unit tests
    `
    const draftRes = await fetch(`${url}/api/orchestrator/projects/${project.id}/baselines/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specMarkdown, version: 'v1.0.0' }),
    })
    assert.equal(draftRes.status, 201)
    const { draft } = await draftRes.json()
    assert.ok(draft.id)
    assert.equal(draft.status, 'DRAFT')

    // Approve Baseline v1.0.0
    const approveRes = await fetch(`${url}/api/orchestrator/baselines/${draft.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvedBy: 'owner' }),
    })
    assert.equal(approveRes.status, 200)
    const { approved } = await approveRes.json()
    assert.equal(approved.status, 'APPROVED')
    assert.equal(approved.version, 'v1.0.0')

    // 5. Decompose Baseline into Tasks
    const decompRes = await fetch(`${url}/api/orchestrator/baselines/${approved.id}/decompose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        milestoneTitle: 'M1: Calculator Core',
        taskDefinitions: [
          { tempId: 't1', title: 'Implement multiply() in src/calc.js', scopePaths: ['src/calc.js'], blockedBy: [] },
          { tempId: 't2', title: 'Add test suite in test/calc.test.js', scopePaths: ['test/calc.test.js'], blockedBy: ['t1'] },
        ],
      }),
    })
    assert.equal(decompRes.status, 201)
    const decomp = await decompRes.json()
    assert.equal(decomp.tasks.length, 2)

    const task1 = decomp.tasks.find((t) => t.title.includes('multiply()'))
    const task2 = decomp.tasks.find((t) => t.title.includes('test suite'))
    assert.equal(task1.status, 'Ready')
    assert.equal(task2.status, 'Backlog')

    // 6. Claim Task 1 for Execution (Provisions Worktree)
    const claimRes = await fetch(`${url}/api/orchestrator/tasks/${task1.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, featureSlug: 'calc-feature' }),
    })
    assert.equal(claimRes.status, 200)
    const claim = await claimRes.json()
    assert.equal(claim.task.status, 'In Progress')
    assert.ok(claim.worktreePath)
    assert.equal(fs.existsSync(claim.worktreePath), true)

    // 7. Execute Worker Implementation in Worktree
    const execRes = await fetch(`${url}/api/orchestrator/tasks/${task1.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        mockFiles: [
          { path: 'src/calc.js', content: 'export function multiply(a, b) { return a * b; }\n' }
        ],
      }),
    })
    assert.equal(execRes.status, 200)
    const execJson = await execRes.json()
    assert.equal(execJson.task.status, 'Automated Checks')
    const candidateSha = execJson.workerResult.candidateCommitSha
    assert.ok(candidateSha)

    // 8. Run Automated Verification
    const verifyRes = await fetch(`${url}/api/orchestrator/tasks/${task1.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, checkCommands: ['node test.mjs'] }),
    })
    assert.equal(verifyRes.status, 200)
    const verifyJson = await verifyRes.json()
    assert.equal(verifyJson.verifResult.passed, true)
    assert.equal(verifyJson.outcome.task.status, 'Code Review')
    const verifDigest = verifyJson.verifResult.verificationDigest

    // 9. Run Specialist Code Review
    const reviewRes = await fetch(`${url}/api/orchestrator/tasks/${task1.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        candidateCommitSha: candidateSha,
        verificationDigest: verifDigest,
        mockReview: {
          verdict: 'APPROVE',
          summary: 'Multiply implementation verified clean.',
          findings: [],
        },
      }),
    })
    assert.equal(reviewRes.status, 200)
    const reviewJson = await reviewRes.json()
    assert.equal(reviewJson.reviewRecord.verdict, 'APPROVE')
    assert.equal(reviewJson.outcome.task.status, 'QA')

    // 10. Decoupled Governance: Owner Acceptance & Fast-Forward Integration
    const acceptRes = await fetch(`${url}/api/orchestrator/tasks/${task1.id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath: repo,
        candidateCommitSha: candidateSha,
        featureBranch: 'zen/calc-feature',
        acceptedBy: 'owner',
      }),
    })
    assert.equal(acceptRes.status, 200)
    const acceptJson = await acceptRes.json()
    assert.equal(acceptJson.task.status, 'Done')
    assert.equal(acceptJson.integration.integratedCommitSha, candidateSha)

    // Verify worktree was cleanly pruned
    assert.equal(fs.existsSync(claim.worktreePath), false)

    // 11. Verify Downstream Task 2 has been automatically unblocked to Ready!
    const updatedTask2 = getTask(task2.id, db)
    assert.equal(updatedTask2.status, 'Ready')

    // 12. Feature Branch Merge into Main
    const mergeRes = await fetch(`${url}/api/orchestrator/projects/${project.id}/merge-feature`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ featureBranch: 'zen/calc-feature', baseBranch: 'main' }),
    })
    assert.equal(mergeRes.status, 200)
    const mergeJson = await mergeRes.json()
    assert.equal(mergeJson.mergedCommitSha, candidateSha)

    // Verify main branch now contains the new file!
    assert.equal(fs.existsSync(path.join(repo, 'src', 'calc.js')), true)
  } finally {
    await serverInfo.close()
    closeOrchestratorDb()
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
