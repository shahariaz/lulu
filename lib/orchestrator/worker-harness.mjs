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
  sanitizeWorkerEnvironment,
} from './security-boundary.mjs'
import {
  detectContainerEngine,
  buildWorkerContainerArgs,
  resolveGatewayHostAlias,
  resolveHostUser,
} from './container-runner.mjs'
import { runGit, resolveRepoRootFromWorktree } from './git-workspace.mjs'

// Re-exported for callers/tests that already import it from here.
export { resolveRepoRootFromWorktree }
import { computeSpecDigest } from './spec-engine.mjs'

/**
 * Sum real token usage out of the Claude Code CLI's `--output-format stream-json` event stream.
 *
 * The CLI reports usage in more than one place depending on version and turn shape:
 *   - a terminal `{ type: 'result', usage: {...} }` event (authoritative when present)
 *   - per-assistant-turn `{ type: 'assistant', message: { usage: {...} } }` events
 *   - streaming `{ type: 'message_delta', usage: { output_tokens } }` deltas
 *
 * Prefer the terminal `result` total; otherwise accumulate per-turn. Cache reads/writes count as
 * input, matching how the gateways bill them.
 *
 * Returns { inputTokens, outputTokens, isEstimated }. `isEstimated` is true only when the stream
 * carried no usage at all — never guess a number and report it as measured.
 */
export function aggregateUsageFromEvents(events = []) {
  const readUsage = (u) => ({
    input: (u?.input_tokens || 0)
      + (u?.cache_creation_input_tokens || 0)
      + (u?.cache_read_input_tokens || 0),
    output: u?.output_tokens || 0,
  })

  // 1. Terminal result event wins — it is the CLI's own total for the whole run.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.type === 'result' && ev.usage) {
      const { input, output } = readUsage(ev.usage)
      if (input || output) return { inputTokens: input, outputTokens: output, isEstimated: false }
    }
  }

  // 2. Otherwise accumulate per-turn usage.
  let inputTokens = 0
  let outputTokens = 0
  let sawUsage = false

  for (const ev of events) {
    const usage = ev?.message?.usage || (ev?.type === 'message_delta' ? ev.usage : null)
    if (!usage) continue
    const { input, output } = readUsage(usage)
    if (!input && !output) continue
    sawUsage = true
    inputTokens += input
    outputTokens += output
  }

  if (sawUsage) return { inputTokens, outputTokens, isEstimated: false }

  // 3. Nothing reported usage. Record zeros flagged as estimated rather than inventing numbers.
  return { inputTokens: 0, outputTokens: 0, isEstimated: true }
}

/**
 * Detect whether a worker run was stopped by a quota guard rather than failing on its own.
 *
 * The CLI's terminal `result` event reports this explicitly — verified on 2.1.231, a run
 * capped by --max-turns emits:
 *   { type: 'result', subtype: 'error_max_turns', terminal_reason: 'max_turns',
 *     is_error: true, num_turns: N }
 *
 * Returns { limit, terminalReason, turns } or null.
 */
export function detectQuotaStop(events = []) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.type !== 'result') continue

    const reason = ev.terminal_reason || ''
    const subtype = ev.subtype || ''

    if (reason === 'max_turns' || subtype === 'error_max_turns') {
      return { limit: 'max-turns', terminalReason: reason || subtype, turns: ev.num_turns ?? null }
    }
    if (/budget/i.test(reason) || /budget/i.test(subtype)) {
      return { limit: 'max-budget-usd', terminalReason: reason || subtype, turns: ev.num_turns ?? null }
    }
    return null
  }
  return null
}

/**
 * Execution tier for agent-written code.
 *
 * 'container' (default) runs the worker in an isolated image where the owner's home directory
 * and main checkout simply do not exist. 'host' is the legacy path — the agent runs as the
 * owner with Bash access. Keep 'host' only as an explicit escape hatch for debugging.
 */
export function resolveExecutionTier() {
  const tier = (process.env.ZEN_EXECUTION_TIER || 'container').toLowerCase()
  return tier === 'host' ? 'host' : 'container'
}

/**
 * Run the worker CLI inside the container tier.
 *
 * The mount layout comes from buildWorktreeMounts() — see the long comment there for why the
 * repo root is deliberately NOT mounted and why `:ro` is not used as a boundary.
 */
async function runWorkerInContainer({
  repoPath, taskId, worktreePath, cliArgs, workerEnv, gatewayUrl, timeoutMs, onStdout,
}) {
  const detected = detectContainerEngine()
  if (!detected.available || detected.engine === 'none') {
    throw new Error(
      'ZEN_EXECUTION_TIER=container but no container engine (docker/podman) is available. ' +
      'Install Docker, or set ZEN_EXECUTION_TIER=host to run on the host (agent gains full ' +
      'access to the owner account — only do this while supervising).'
    )
  }

  const { alias } = resolveGatewayHostAlias()
  // Rewrite a loopback gateway URL to the host alias: 127.0.0.1 inside the container is the
  // container itself, not the host.
  const containerGatewayUrl = gatewayUrl.replace(/(127\.0\.0\.1|localhost)/, alias)

  const args = buildWorkerContainerArgs({
    engine: detected.engine,
    repoPath,
    taskId,
    worktreePath,
    command: 'claude',
    args: cliArgs,
    user: resolveHostUser(worktreePath),
    env: { ...workerEnv, ANTHROPIC_BASE_URL: containerGatewayUrl },
  })

  return spawnControlledProcess(detected.engine, args, { timeoutMs, onStdout })
}

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
  // Quota guards — see the flag block below for measurements. Defaults are deliberately
  // generous enough for real work but far below "burned the day's quota".
  maxTurns = Number(process.env.ZEN_WORKER_MAX_TURNS || 60),
  maxBudgetUsd = Number(process.env.ZEN_WORKER_MAX_BUDGET_USD || 5),
  onEvent = null,
  mockAction = null, // for testing without spawning external processes
}, db = null) {
  const targetDb = db || getOrchestratorDb()
  const task = getTask(taskId, targetDb)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  if (!fs.existsSync(worktreePath)) {
    throw new Error(`Task worktree directory does not exist: ${worktreePath}`)
  }

  const executionTier = resolveExecutionTier()
  // Ask git for the repository root rather than assuming <repo>/.zen-worktrees/<taskId>.
  // The container mount layout needs the real path and a wrong guess fails obscurely.
  const repoPath = resolveRepoRootFromWorktree(worktreePath)

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
    // Spawn the headless Claude Code CLI. The flag set here is pinned by
    // test/harness-compat-spike.test.mjs — change both together or the worker breaks silently
    // on a CLI upgrade.
    //
    // DO NOT ADD `--bare`. On CLI 2.1.231 it reduces the built-in tool set to
    // ["Bash","Edit","Read"] and SILENTLY DROPS Write — `--tools ...,Write` is ignored rather
    // than erroring. A worker that cannot Write can edit existing files but can never create
    // one, which is invisible until a task needs a new file and the agent flails. Verified by
    // test/harness-compat-spike.test.mjs Step 4.
    const cliArgs = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Constrain to exactly the tools a worker needs. Verified on CLI 2.1.231 to yield
      // ["Bash","Edit","Read","Write"] — nothing else.
      '--tools', 'Read,Edit,Write,Bash',
      // Ignore the host's MCP configuration. Without this the worker inherits whatever MCP
      // servers the owner has configured (web search, etc.), silently widening its reach far
      // beyond the task scope.
      '--strict-mcp-config',
      //
      // Permission mode is tier-dependent, and `dontAsk` is NOT the autonomous mode despite
      // the name — it means "do not prompt, and DENY anything that would have prompted".
      // A worker run with it gets: "Permission to use Write has been denied because Claude
      // Code is running in don't ask mode."
      //
      //   container → bypassPermissions. The container IS the security boundary (no home dir,
      //               no main checkout, only this worktree), so the CLI's own prompts are
      //               redundant and would deadlock a headless run.
      //   host      → acceptEdits. Deliberately weaker: file edits proceed, but anything
      //               needing broader permission does not silently get it. The host tier is a
      //               debugging escape hatch, not a mode to run unsupervised work in.
      '--permission-mode', executionTier === 'container' ? 'bypassPermissions' : 'acceptEdits',
      //
      // QUOTA GUARDS. Without these a misbehaving gateway loops the agent indefinitely:
      // measured 1,562 agent turns in 45s against a mock that always replied `tool_use`, and
      // the default timeoutMs here is 120s. Every one of those turns is real spend against the
      // owner's pooled subscriptions, so a single wedged task could exhaust a day's quota.
      //
      // Both flags verified honored on CLI 2.1.231:
      //   --max-turns      hard, deterministic stop (exact turn count)
      //   --max-budget-usd cost-based backstop; only applies with --print/-p, which we use
      // Belt and braces on purpose — the turn cap does not depend on cost being reported
      // correctly, and the budget cap bounds a small number of very expensive turns.
      '--max-turns', String(maxTurns),
      '--max-budget-usd', String(maxBudgetUsd),
    ]

    // The CLI never contacts Anthropic: ANTHROPIC_BASE_URL points at the local gateway, which
    // fans out to the owner's pooled subscriptions. The key is a placeholder. INVARIANT 6.
    //
    // DO NOT SET CLAUDE_CODE_SIMPLE=1. Like `--bare`, it reduces the built-in tool set to
    // ["Bash","Edit","Read"] and silently drops Write — same failure, second cause. Both were
    // present here originally, so removing only one leaves the worker unable to create files.
    const workerEnv = {
      ANTHROPIC_API_KEY: 'zen-worker-local',
    }

    const onStdout = (chunk) => {
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
    }

    try {
      if (executionTier === 'container') {
        runResult = await runWorkerInContainer({
          repoPath, taskId, worktreePath, cliArgs, workerEnv, gatewayUrl, timeoutMs, onStdout,
        })
      } else {
        // Host tier: the agent runs with Bash access as the owner's user and can read
        // ~/.ssh, ~/.aws, ~/.codex. Acceptable only when a human is watching.
        runResult = await spawnControlledProcess('claude', cliArgs, {
          cwd: worktreePath,
          timeoutMs,
          env: {
            ...sanitizeWorkerEnvironment(process.env),
            ...workerEnv,
            ANTHROPIC_BASE_URL: gatewayUrl,
          },
          onStdout,
        })
      }
    } catch (err) {
      runResult = { exitCode: 1, stdout: '', stderr: err.message }
    }
  }

  if (runResult.exitCode !== 0) {
    // Distinguish "hit a quota guard" from "failed". A capped run is an operational limit the
    // owner can raise, not a broken task — surfacing both as a generic failure hides the one
    // thing they need to know, which is that spend was bounded and why.
    const capped = detectQuotaStop(events)
    const usage = aggregateUsageFromEvents(events)

    completeTaskRun(taskRun.id, {
      status: 'FAILED',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      isEstimated: usage.isEstimated ? 1 : 0,
    }, targetDb)

    if (capped) {
      updateTaskStatus(taskId, {
        status: 'Blocked',
        blockedReason: 'BUDGET_EXCEEDED',
      }, targetDb)
    }

    recordAuditLog({
      projectId,
      taskId,
      eventType: capped ? 'WORKER_TASK_QUOTA_STOPPED' : 'WORKER_TASK_FAILED',
      actor: 'worker',
      details: {
        exitCode: runResult.exitCode,
        stderr: runResult.stderr,
        ...(capped ? { limit: capped.limit, terminalReason: capped.terminalReason, turns: capped.turns } : {}),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    }, targetDb)

    if (capped) {
      const err = new Error(
        `Worker stopped by the ${capped.limit} guard after ${capped.turns ?? 'unknown'} turns ` +
        `(terminal_reason=${capped.terminalReason}). Raise ZEN_WORKER_MAX_TURNS / ` +
        `ZEN_WORKER_MAX_BUDGET_USD if this task legitimately needs more, but first check the ` +
        `gateway is not looping the agent.`
      )
      err.code = 'E_WORKER_QUOTA_EXCEEDED'
      err.limit = capped.limit
      throw err
    }

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
  const usage = aggregateUsageFromEvents(events)
  const completedRun = completeTaskRun(taskRun.id, {
    status: 'SUCCEEDED',
    candidateCommitSha,
    diffDigest,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    isEstimated: usage.isEstimated ? 1 : 0,
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
