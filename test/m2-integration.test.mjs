import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

import {
  getOrchestratorDb,
  closeOrchestratorDb,
  createProject,
  createBaseline,
  approveBaseline,
  createMilestone,
  createTask,
  getTask,
  getTaskRun,
} from '../lib/orchestrator/db/index.mjs'
import {
  createFeatureBranch,
  provisionTaskWorktree,
  teardownTaskWorktree,
  runGit,
} from '../lib/orchestrator/git-workspace.mjs'
import {
  claimTaskForExecution,
  transitionTask,
} from '../lib/orchestrator/dag-scheduler.mjs'
import { executeWorkerTask } from '../lib/orchestrator/worker-harness.mjs'
import {
  runVerificationChecks,
  handleVerificationOutcome,
} from '../lib/orchestrator/verifier-engine.mjs'
import {
  startPreviewServer,
  stopPreviewServer,
  getPreviewStatus,
  isPortAvailable,
} from '../lib/orchestrator/preview-manager.mjs'
import {
  parseFailureDiagnostics,
  injectOwnerGuidance,
  applyWorktreeQuickFix,
} from '../lib/orchestrator/failure-inspector.mjs'
import {
  checkMergeCompatibility,
  mergeFeatureBranch,
  cleanupFeatureArtifacts,
} from '../lib/orchestrator/merge-engine.mjs'
import {
  executeContainerCommand,
} from '../lib/orchestrator/container-runner.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-m2-db-'))
  return path.join(tmpDir, 'm2-orchestrator.sqlite')
}

function createFixtureRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-m2-repo-'))
  execFileSync('git', ['init', '-b', 'main', repoDir])
  execFileSync('git', ['config', 'user.name', 'M2 Tester'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'm2@example.com'], { cwd: repoDir })

  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'm2-target-app',
    version: '1.0.0',
    type: 'module',
    scripts: { test: 'node --test' }
  }, null, 2))
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# M2 Target App\n')

  execFileSync('git', ['add', '.'], { cwd: repoDir })
  execFileSync('git', ['commit', '-m', 'Initial baseline commit'], { cwd: repoDir })

  return repoDir
}

test('Milestone 2 End-to-End: Preview Lifecycle, Failure Diagnostics & Guidance, and Squash Merge with Release Notes', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createFixtureRepo()

  try {
    // 1. Setup Project, Baseline, and Milestone
    const project = createProject({ name: 'M2 Platform Service', repoPath: repo }, db)
    const baseline = createBaseline({
      projectId: project.id,
      specMarkdown: '# M2 PRD\n- REQ-F-01: Preview dev server\n- REQ-F-02: Guided repair',
      contentDigest: 'sha256:m2digest',
      status: 'APPROVED',
    }, db)
    const milestone = createMilestone({ baselineId: baseline.id, title: 'Milestone 2: Hardening' }, db)

    const task = createTask({
      milestoneId: milestone.id,
      title: 'Web Component with Live Preview',
      description: 'Implement HTML widget and dev server script.',
      scopePaths: ['src/widget.html', 'src/widget.mjs', 'test/widget.test.js'],
      status: 'Ready',
      maxRepairs: 3,
    }, db)

    // 2. Feature Branch & Task Worktree Provisioning
    const featureSlug = 'live-widget'
    createFeatureBranch(repo, featureSlug)
    const { worktreePath, baseCommitSha } = provisionTaskWorktree(repo, `zen/${featureSlug}`, task.id)

    // Claim Task
    claimTaskForExecution(task.id, project.id, db)
    assert.equal(getTask(task.id, db).status, 'In Progress')

    // 3. Worker Implementation (with an intentional bug in the test assertion)
    const workerResult = await executeWorkerTask({
      taskId: task.id,
      projectId: project.id,
      worktreePath,
      scopePaths: task.scope_paths,
      mockAction: async ({ worktreePath }) => {
        fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true })
        fs.mkdirSync(path.join(worktreePath, 'test'), { recursive: true })

        // Widget HTML for live preview
        fs.writeFileSync(path.join(worktreePath, 'src', 'widget.html'), `
<!DOCTYPE html>
<html>
  <head><title>Live Widget</title></head>
  <body><h1>Widget v1 Active</h1></body>
</html>
        `)

        // Widget logic
        fs.writeFileSync(path.join(worktreePath, 'src', 'widget.mjs'), `
export function renderGreeting(name) {
  return "Hello, " + name + "!";
}
        `)

        // Test with intentional assertion mismatch to trigger failure inspector
        fs.writeFileSync(path.join(worktreePath, 'test', 'widget.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGreeting } from '../src/widget.mjs';

test('renderGreeting outputs correct format', () => {
  // BUG: Expects Welcome instead of Hello
  assert.equal(renderGreeting("World"), "Welcome, World!");
});
        `)
      },
    }, db)

    assert.ok(workerResult.candidateCommitSha)
    transitionTask(task.id, 'Automated Checks', {}, db)

    // 4. Automated Verification Fails (Intentional Test Failure)
    const verif1 = await runVerificationChecks({
      taskRunId: workerResult.taskRunId,
      worktreePath,
      checkCommands: ['node --test test/widget.test.js'],
    }, db)
    assert.equal(verif1.passed, false, 'Initial verification should fail due to assertion bug')

    // Handle verification failure: repair attempt 1
    const outcome1 = await handleVerificationOutcome({
      taskId: task.id,
      projectId: project.id,
      taskRunId: workerResult.taskRunId,
      verificationResult: verif1,
    }, db)
    assert.equal(outcome1.outcome, 'RETRY_REPAIR')
    assert.equal(outcome1.task.repair_attempts, 1)

    // 5. Interactive Failure Inspector Parses Diagnostics
    const diagnostics = parseFailureDiagnostics(verif1.outputLog)
    assert.equal(diagnostics.hasFailure, true)
    assert.equal(diagnostics.errorType, 'AssertionError')
    assert.ok(diagnostics.failingFiles.some((f) => f.includes('widget.test.js')))
    assert.match(diagnostics.assertionDiff, /Hello, World!/)

    // Simulate 2 more failures to reach maximum repairs (3)
    transitionTask(task.id, 'Automated Checks', {}, db)
    await handleVerificationOutcome({ taskId: task.id, projectId: project.id, taskRunId: workerResult.taskRunId, verificationResult: verif1 }, db)
    transitionTask(task.id, 'Automated Checks', {}, db)
    const outcomeFinal = await handleVerificationOutcome({ taskId: task.id, projectId: project.id, taskRunId: workerResult.taskRunId, verificationResult: verif1 }, db)

    assert.equal(outcomeFinal.outcome, 'BLOCKED_REPAIR_LIMIT')
    assert.equal(outcomeFinal.task.status, 'Blocked')
    assert.equal(outcomeFinal.task.blocked_reason, 'REPAIR_LIMIT_EXCEEDED')

    // 6. Owner Guidance Injection & In-Browser Quick-Fix
    // Owner supplies guidance: "Change expected string from Welcome to Hello"
    const guidance = await injectOwnerGuidance({
      taskId: task.id,
      projectId: project.id,
      guidanceNotes: 'Fix assertion in test/widget.test.js: expected "Hello, World!" not "Welcome, World!"',
      resetRepairs: true,
    }, db)
    assert.equal(guidance.success, true)
    assert.equal(guidance.task.status, 'In Progress')
    assert.equal(guidance.task.repair_attempts, 0)

    // Owner applies quick-fix directly to the worktree
    const quickFix = applyWorktreeQuickFix({
      taskId: task.id,
      worktreePath,
      filePath: 'test/widget.test.js',
      content: `
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGreeting } from '../src/widget.mjs';

test('renderGreeting outputs correct format', () => {
  assert.equal(renderGreeting("World"), "Hello, World!");
});
      `,
    }, db)
    assert.equal(quickFix.success, true)

    // Re-commit candidate fix
    runGit(worktreePath, ['add', 'test/widget.test.js'])
    runGit(worktreePath, ['commit', '-m', 'fix(test): update expected greeting to Hello'])
    const fixedCandidateSha = runGit(worktreePath, ['rev-parse', 'HEAD'])

    // Re-run Verification: PASSES!
    transitionTask(task.id, 'Automated Checks', {}, db)
    const verif2 = await runVerificationChecks({
      taskRunId: workerResult.taskRunId,
      worktreePath,
      checkCommands: ['node --test test/widget.test.js'],
    }, db)
    assert.equal(verif2.passed, true, 'Verification must pass after quick-fix')

    const outcome2 = await handleVerificationOutcome({
      taskId: task.id,
      projectId: project.id,
      taskRunId: workerResult.taskRunId,
      verificationResult: verif2,
    }, db)
    assert.equal(outcome2.outcome, 'ADVANCED_TO_REVIEW')
    assert.equal(outcome2.task.status, 'Code Review')

    // 7. Live Local Web Preview Server Lifecycle
    // Start local preview dev server
    const previewScript = `
import http from 'node:http';
import fs from 'node:fs';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Widget v1 Active</h1>');
});
server.listen(process.env.PORT, '127.0.0.1');
    `
    fs.writeFileSync(path.join(worktreePath, 'preview-server.mjs'), previewScript)

    const previewSession = await startPreviewServer({
      taskId: task.id,
      worktreePath,
      command: 'node',
      args: ['preview-server.mjs'],
      timeoutMs: 5000,
    })

    assert.equal(previewSession.status, 'RUNNING')
    assert.ok(previewSession.port >= 41000)

    // Verify preview server responds to HTTP GET
    const previewBody = await new Promise((resolve, reject) => {
      http.get(previewSession.url, (res) => {
        let d = ''
        res.on('data', (c) => d += c)
        res.on('end', () => resolve(d))
      }).on('error', reject)
    })
    assert.match(previewBody, /Widget v1 Active/)

    // Check preview status
    const pStatus = getPreviewStatus(task.id)
    assert.equal(pStatus.status, 'RUNNING')
    assert.equal(pStatus.port, previewSession.port)

    // Stop preview server
    const stopRes = stopPreviewServer(task.id)
    assert.equal(stopRes.stopped, true)

    // Verify port was released
    await new Promise((r) => setTimeout(r, 150))
    const portFree = await isPortAvailable(previewSession.port)
    assert.equal(portFree, true)

    // 8. Containerized Sandbox Execution Verification (Proposal A)
    const containerResult = await executeContainerCommand({
      worktreePath,
      command: 'node',
      args: ['--version'],
      mockRunner: async ({ image, command, networkMode }) => {
        assert.equal(image, 'node:22-slim')
        assert.equal(networkMode, 'none')
        return {
          success: true,
          engine: 'mock-sandbox',
          image,
          exitCode: 0,
          stdout: 'v22.14.0\n',
          stderr: '',
        }
      },
    })
    assert.equal(containerResult.success, true)
    assert.match(containerResult.stdout, /v22\./)

    // 9. Advance to QA and Fast-Forward Merge
    transitionTask(task.id, 'QA', { waitingReason: 'AWAITING_OWNER_ACCEPTANCE' }, db)

    // Integrate candidate into feature branch
    runGit(repo, ['checkout', `zen/${featureSlug}`])
    runGit(repo, ['merge', '--ff-only', fixedCandidateSha])
    teardownTaskWorktree(repo, task.id, { force: true })
    transitionTask(task.id, 'Done', {}, db)

    // 10. Advanced Feature Merge: Squash & Merge with Release Notes
    const mergeResult = mergeFeatureBranch({
      repoPath: repo,
      featureBranch: `zen/${featureSlug}`,
      baseBranch: 'main',
      strategy: 'squash',
      featureTitle: 'Token Bucket Widget & Dev Preview',
      baselineVersion: 'v1.0.0',
      completedTasks: [
        { id: task.id, title: task.title },
      ],
    })

    assert.equal(mergeResult.success, true)
    assert.equal(mergeResult.strategy, 'squash')

    // Verify squashed commit message in main branch log
    const gitLog = runGit(repo, ['log', '-1', '--pretty=%B'])
    assert.match(gitLog, /feat: Token Bucket Widget & Dev Preview/)
    assert.match(gitLog, /Approved Baseline: v1\.0\.0/)
    assert.match(gitLog, /- Web Component with Live Preview/)

    // Verify files exist in main branch
    assert.equal(fs.existsSync(path.join(repo, 'src', 'widget.mjs')), true)
    assert.equal(fs.existsSync(path.join(repo, 'src', 'widget.html')), true)
    assert.equal(fs.existsSync(path.join(repo, 'test', 'widget.test.js')), true)

    // Clean up feature branch
    const cleanup = cleanupFeatureArtifacts({ repoPath: repo, featureBranch: `zen/${featureSlug}` })
    assert.equal(cleanup.deletedBranch, true)
  } finally {
    closeOrchestratorDb()
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
