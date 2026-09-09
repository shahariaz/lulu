import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { startOrchestratorServer } from '../lib/orchestrator/api.mjs'
import { getOrchestratorDb, closeOrchestratorDb, getTask } from '../lib/orchestrator/db/index.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-m3-db-'))
  return path.join(tmpDir, 'm3-orchestrator.sqlite')
}

function createFixtureRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-m3-repo-'))
  execFileSync('git', ['init', '-b', 'main', repoDir])
  execFileSync('git', ['config', 'user.name', 'M3 Tester'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'm3@example.com'], { cwd: repoDir })

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'm3-platform-app',
    version: '1.0.0',
    type: 'module',
    scripts: { test: 'node --test' }
  }, null, 2))
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# M3 Platform App\n')
  fs.writeFileSync(path.join(repoDir, 'test-runner.mjs'), 'console.log("PASS"); process.exit(0);\n')

  execFileSync('git', ['add', '.'], { cwd: repoDir })
  execFileSync('git', ['commit', '-m', 'Initial baseline commit'], { cwd: repoDir })

  return repoDir
}

test('Milestone 3 End-to-End: Hierarchical Epics, Sprints, Version Diffing, and Scope Impact Invalidation', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createFixtureRepo()

  const serverInfo = await startOrchestratorServer({ port: 0, db })
  const { url } = serverInfo

  try {
    // 1. Import Project
    const projRes = await fetch(`${url}/api/orchestrator/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repo, name: 'M3 Hierarchical Platform' }),
    })
    const { project } = await projRes.json()
    assert.ok(project.id)

    // 2. Draft & Approve Baseline v1.0.0
    const v1Spec = `
# Platform Architecture v1.0.0
## Functional Requirements
- REQ-F-01: Session Token Generator
  HMAC token creation.
- REQ-F-02: Payment Processor
  Credit card charge gateway.
    `
    const draftRes1 = await fetch(`${url}/api/orchestrator/projects/${project.id}/baselines/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specMarkdown: v1Spec, version: 'v1.0.0' }),
    })
    const { draft: draft1 } = await draftRes1.json()

    const approveRes1 = await fetch(`${url}/api/orchestrator/baselines/${draft1.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvedBy: 'owner' }),
    })
    const { approved: base1 } = await approveRes1.json()
    assert.equal(base1.status, 'APPROVED')

    // 3. Hierarchical Decomposition into Epics and Tasks
    const decompRes = await fetch(`${url}/api/orchestrator/baselines/${base1.id}/decompose-hierarchical`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        milestoneTitle: 'Milestone 3: Core Platform',
        epicsWithTasks: [
          {
            tempId: 'epic_auth',
            title: 'Epic 1: Authentication Services',
            description: 'HMAC and token sessions',
            tasks: [
              {
                tempId: 't_auth_1',
                title: 'Task 1.1: Token Generator Service',
                scopePaths: ['src/auth/token.js'],
                linkedRequirementIds: ['REQ-F-01'],
                blockedBy: [],
              },
            ],
          },
          {
            tempId: 'epic_pay',
            title: 'Epic 2: Payment Processing',
            description: 'Stripe and cards gateway',
            tasks: [
              {
                tempId: 't_pay_1',
                title: 'Task 2.1: Payment Gateway Client',
                scopePaths: ['src/pay/gateway.js'],
                linkedRequirementIds: ['REQ-F-02'],
                blockedBy: ['t_auth_1'], // Cross-epic dependency!
              },
            ],
          },
        ],
      }),
    })

    assert.equal(decompRes.status, 201)
    const hierData = await decompRes.json()
    assert.equal(hierData.epics.length, 2)
    assert.equal(hierData.tasks.length, 2)

    const epicAuth = hierData.epics.find((e) => e.title.includes('Epic 1'))
    const epicPay = hierData.epics.find((e) => e.title.includes('Epic 2'))
    const taskAuth = hierData.tasks.find((t) => t.title.includes('Task 1.1'))
    const taskPay = hierData.tasks.find((t) => t.title.includes('Task 2.1'))

    assert.equal(taskAuth.status, 'Ready')
    assert.equal(taskPay.status, 'Backlog')
    assert.equal(taskAuth.epic_id, epicAuth.id)
    assert.equal(taskPay.epic_id, epicPay.id)

    // 4. Sprint Planning: Create Sprint & Assign Task
    const sprintRes = await fetch(`${url}/api/orchestrator/projects/${project.id}/sprints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sprint 1 - Identity', goal: 'Deliver HMAC auth tokens' }),
    })
    assert.equal(sprintRes.status, 201)
    const { sprint } = await sprintRes.json()
    assert.ok(sprint.id)

    const assignRes = await fetch(`${url}/api/orchestrator/sprints/${sprint.id}/assign-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: [taskAuth.id] }),
    })
    assert.equal(assignRes.status, 200)
    assert.equal(getTask(taskAuth.id, db).sprint_id, sprint.id)

    // 5. Query Epic Progress (Initial: 0% complete)
    const epicsRes1 = await fetch(`${url}/api/orchestrator/projects/${project.id}/epics`)
    assert.equal(epicsRes1.status, 200)
    const { epics: epicsList1 } = await epicsRes1.json()
    const authProg1 = epicsList1.find((e) => e.epicId === epicAuth.id)
    assert.equal(authProg1.progressPercentage, 0)
    assert.equal(authProg1.status, 'PLANNED')

    // 6. Execute Task 1.1 Through to Acceptance & Fast-Forward Integration
    await fetch(`${url}/api/orchestrator/tasks/${taskAuth.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, featureSlug: 'm3-feat' }),
    })

    const execRes = await fetch(`${url}/api/orchestrator/tasks/${taskAuth.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        mockFiles: [{ path: 'src/auth/token.js', content: 'export const token = "hmac_xyz";\n' }],
      }),
    })
    const { workerResult } = await execRes.json()

    await fetch(`${url}/api/orchestrator/tasks/${taskAuth.id}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: project.id, checkCommands: ['node test-runner.mjs'] }),
    })

    await fetch(`${url}/api/orchestrator/tasks/${taskAuth.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        candidateCommitSha: workerResult.candidateCommitSha,
        mockReview: { verdict: 'APPROVE', summary: 'Token service verified' },
      }),
    })

    await fetch(`${url}/api/orchestrator/tasks/${taskAuth.id}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoPath: repo,
        candidateCommitSha: workerResult.candidateCommitSha,
        featureBranch: 'zen/m3-feat',
        acceptedBy: 'owner',
      }),
    })

    assert.equal(getTask(taskAuth.id, db).status, 'Done')

    // 7. Verify Epic 1 Auto-Updates to COMPLETED (100% progress)
    const progRes2 = await fetch(`${url}/api/orchestrator/epics/${epicAuth.id}/progress`)
    assert.equal(progRes2.status, 200)
    const { progress: authProg2 } = await progRes2.json()
    assert.equal(authProg2.progressPercentage, 100)
    assert.equal(authProg2.status, 'COMPLETED')

    // Verify Task 2.1 is unblocked across epics to Ready!
    assert.equal(getTask(taskPay.id, db).status, 'Ready')

    // 8. Requirements Version Diffing (v1.0.0 vs v1.1.0)
    const v2Spec = `
# Platform Architecture v1.1.0
## Functional Requirements
- REQ-F-01: Session Token Generator
  HMAC token creation with dynamic key rotation.
- REQ-F-02: Payment Processor
  Credit card charge gateway.
- REQ-F-03: Webhook Notification Engine
  Send async events to external endpoints.
    `
    const draftRes2 = await fetch(`${url}/api/orchestrator/projects/${project.id}/baselines/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specMarkdown: v2Spec, version: 'v1.1.0' }),
    })
    const { draft: draft2 } = await draftRes2.json()

    const approveRes2 = await fetch(`${url}/api/orchestrator/baselines/${draft2.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvedBy: 'owner' }),
    })
    const { approved: base2 } = await approveRes2.json()

    // Query Spec Diff
    const diffRes = await fetch(`${url}/api/orchestrator/baselines/${base1.id}/diff/${base2.id}`)
    assert.equal(diffRes.status, 200)
    const { diffResult, changelog } = await diffRes.json()
    assert.equal(diffResult.hasChanges, true)
    assert.equal(diffResult.stats.addedCount, 1)
    assert.equal(diffResult.stats.modifiedCount, 1)
    assert.match(changelog, /# Specification Changelog/)
    assert.match(changelog, /REQ-F-03/)

    // 9. Automated Scope Impact Analysis
    const impactRes = await fetch(`${url}/api/orchestrator/baselines/scope-impact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        previousBaselineId: base1.id,
        newBaselineId: base2.id,
      }),
    })
    assert.equal(impactRes.status, 200)
    const { report } = await impactRes.json()
    assert.equal(report.hasImpact, true)
    assert.equal(report.affectedTasks.length, 1)
    assert.equal(report.affectedTasks[0].taskId, taskAuth.id)
    assert.match(report.affectedTasks[0].reason, /REQ-F-01 was modified/)
    assert.equal(report.uncoveredNewRequirements[0].id, 'REQ-F-03')

    // 10. Apply Scope Impact -> Flags Affected Task for Rework
    const applyRes = await fetch(`${url}/api/orchestrator/baselines/apply-impact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        impactReport: report,
      }),
    })
    assert.equal(applyRes.status, 200)
    const applyData = await applyRes.json()
    assert.equal(applyData.affectedCount, 1)

    // Verify Task 1.1 now has waiting_reason = REWORK_REQUIRED
    const recheckedTaskAuth = getTask(taskAuth.id, db)
    assert.equal(recheckedTaskAuth.waiting_reason, 'REWORK_REQUIRED')
  } finally {
    await serverInfo.close()
    closeOrchestratorDb()
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
