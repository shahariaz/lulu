import fs from 'node:fs'
import path from 'node:path'
import {
  createTaskRun,
  completeTaskRun,
  getTask,
  updateTaskStatus,
  recordAuditLog,
  getOrchestratorDb,
} from './db/index.mjs'
import {
  assertPathWithinWorktree,
  spawnControlledProcess,
} from './security-boundary.mjs'
import { runGit } from './git-workspace.mjs'
import { computeSpecDigest } from './spec-engine.mjs'

export function buildWorkerPrompt({ taskTitle, taskDescription, scopePaths }) {
  const scopes = scopePaths && scopePaths.length
    ? scopePaths.map((p) => `- ${p}`).join('\n')
    : '- Any file within the repository'

  return `You are the Claude-Zen Worker Agent implementing the following assigned task:
Title: ${taskTitle}
Description: ${taskDescription || 'Implement the required changes and unit tests.'}

Allowed Scope Paths:
${scopes}

Rules:
1. Confine all file additions, edits, and deletions strictly within the allowed scope paths.
2. Write clean, idiomatic, and minimal code and unit tests.
3. Run project test commands (e.g. npm test) to verify your implementation before completing.
4. When finished, summarize the changes you made.`
}

/**
 * Execute a worker implementation task inside an isolated Git worktree.
 */
export async function executeWorkerTask({
  taskId,
  projectId,
  worktreePath,
  scopePaths = [],
  modelConfig = {},
  gatewayUrl = 'http://127.0.0.1:8788',
  timeoutMs = 120000,
  onEvent = null,
  mockAction = null, // for testing without spawning external processes
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const task = getTask(taskId, targetDb)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Task worktree directory does not exist: ${worktreePath}`)
  }

  // 1. Get base commit SHA of the worktree branch
  const baseCommitSha = runGit(worktreePath, ['rev-parse', 'HEAD'])

  // 2. Create Task Run record in SQLite
  const taskRun = createTaskRun({
    taskId,
    kind: 'WORKER',
    role: 'WORKER',
    model: modelConfig.model || 'gemini-3.8-flash',
    provider: modelConfig.provider || 'antigravity',
    accountEmail: modelConfig.accountEmail || null,
    baseCommitSha,
    leaseExpiresAt: Date.now() + timeoutMs,
  }, targetDb)

  const prompt = buildWorkerPrompt({
    taskTitle: task.title,
    taskDescription: task.description,
    scopePaths: scopePaths.length ? scopePaths : task.scope_paths,
  })

  let runResult = null
  const events = []

  // 3. Execution Phase
  if (mockAction) {
    // Deterministic in-process mock action (used for test isolation without external CLI)
    try {
      await mockAction({ worktreePath, scopePaths: task.scope_paths, taskRun })
      runResult = { exitCode: 0, stdout: 'Mock worker execution completed successfully.' }
    } catch (err) {
      runResult = { exitCode: 1, stdout: '', stderr: err.message }
    }
  } else {
    // Spawn Headless Claude Code CLI (verified in TSK-M1-05)
    try {
      runResult = await spawnControlledProcess('claude', [
        '-p', prompt,
        '--bare',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--tools', 'Read,Edit,Write,Bash',
        '--permission-mode', 'dontAsk',
      ], {
        cwd: worktreePath,
        timeoutMs,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: gatewayUrl,
          ANTHROPIC_API_KEY: 'zen-worker-local',
          CLAUDE_CODE_SIMPLE: '1',
        },
        onStdout: (chunk) => {
          const lines = chunk.toString().split('\n')
          for (const line of lines) {
            if (line.trim()) {
              try {
                const ev = JSON.parse(line)
                events.push(ev)
                onEvent?.(ev)
              } catch {}
            }
          }
        },
      })
    } catch (err) {
      runResult = { exitCode: 1, stdout: '', stderr: err.message }
    }
  }

  if (runResult.exitCode !== 0) {
    completeTaskRun(taskRun.id, {
      status: 'FAILED',
      outputTokens: 0,
      inputTokens: 0,
    }, targetDb)

    recordAuditLog({
      projectId,
      taskId,
      eventType: 'WORKER_TASK_FAILED',
      actor: 'worker',
      details: { exitCode: runResult.exitCode, stderr: runResult.stderr },
    }, targetDb)

    throw new Error(`Worker execution failed (exit code ${runResult.exitCode}): ${runResult.stderr || runResult.stdout}`)
  }

  // 4. Candidate Snapshot Creation
  // Check if worktree has modifications
  const gitStatus = runGit(worktreePath, ['status', '--porcelain'])
  if (!gitStatus.trim()) {
    completeTaskRun(taskRun.id, { status: 'FAILED' }, targetDb)
    throw new Error('Worker completed without making any file changes')
  }

  // Verify that all modified/added files resolve within scope paths
  const effectiveScopes = scopePaths.length ? scopePaths : task.scope_paths
  if (effectiveScopes.length > 0) {
    // Stage explicitly the allowed scope paths
    for (const p of effectiveScopes) {
      assertPathWithinWorktree(p, worktreePath)
    }
    runGit(worktreePath, ['add', ...effectiveScopes])
  } else {
    runGit(worktreePath, ['add', '.'])
  }

  // Check staged diff
  const stagedDiff = runGit(worktreePath, ['diff', '--cached'])
  if (!stagedDiff.trim()) {
    throw new Error('No changes staged within the defined scope paths')
  }

  // Create immutable candidate commit
  runGit(worktreePath, ['commit', '-m', `feat(${task.id}): ${task.title}`])
  const candidateCommitSha = runGit(worktreePath, ['rev-parse', 'HEAD'])

  // Compute diff digest between base commit and candidate commit
  const fullDiff = runGit(worktreePath, ['diff', `${baseCommitSha}..${candidateCommitSha}`])
  const diffDigest = computeSpecDigest(fullDiff)

  // 5. Complete Task Run in SQLite
  const completedRun = completeTaskRun(taskRun.id, {
    status: 'SUCCEEDED',
    candidateCommitSha,
    diffDigest,
    inputTokens: 100, // aggregated from events or estimated
    outputTokens: 50,
  }, targetDb)

  recordAuditLog({
    projectId,
    taskId,
    eventType: 'CANDIDATE_SNAPSHOT_CREATED',
    actor: 'worker',
    details: { candidateCommitSha, diffDigest, baseCommitSha },
  }, targetDb)

  return {
    taskRunId: taskRun.id,
    candidateCommitSha,
    diffDigest,
    baseCommitSha,
    stdout: runResult.stdout,
    events,
  }
}
