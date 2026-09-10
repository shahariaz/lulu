import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  detectContainerEngine,
  buildWorktreeMounts,
  buildWorkerContainerArgs,
  resolveGatewayHostAlias,
  resolveHostUser,
  DEFAULT_WORKER_IMAGE,
} from '../lib/orchestrator/container-runner.mjs'
import {
  executeWorkerTask,
  resolveExecutionTier,
  resolveRepoRootFromWorktree,
  detectQuotaStop,
} from '../lib/orchestrator/worker-harness.mjs'
import {
  getOrchestratorDb,
  closeOrchestratorDb,
  createProject,
  createBaseline,
  createMilestone,
  createTask,
  getTask,
  getTaskRun,
} from '../lib/orchestrator/db/index.mjs'
import {
  createFeatureBranch,
  provisionTaskWorktree,
} from '../lib/orchestrator/git-workspace.mjs'

/**
 * Container execution tier tests.
 *
 * The pure-function tests always run. The tests that actually start a container are skipped
 * when no engine is available (CI has no Docker) — they must not turn CI red, but they also
 * must not silently pass and imply coverage that did not happen.
 */
const engineInfo = detectContainerEngine()
const hasEngine = engineInfo.available && engineInfo.engine !== 'none' && engineInfo.engine !== 'sandbox-exec'

function imageExists() {
  if (!hasEngine) return false
  const res = spawnSync(engineInfo.engine, ['image', 'inspect', DEFAULT_WORKER_IMAGE], { encoding: 'utf8' })
  return res.status === 0
}
const canRunContainers = hasEngine && imageExists()
const skipReason = !hasEngine
  ? 'no container engine available'
  : `worker image ${DEFAULT_WORKER_IMAGE} not built — run: npm run build:worker-image`

// ---------------------------------------------------------------------------
// Mount layout — pure functions, always run.
// ---------------------------------------------------------------------------

test('buildWorktreeMounts mounts .git and the worktree at identical absolute paths', () => {
  const { args, worktree, gitDir } = buildWorktreeMounts({
    repoPath: '/abs/repo',
    taskId: 'task_1',
  })

  assert.equal(gitDir, '/abs/repo/.git')
  assert.equal(worktree, '/abs/repo/.zen-worktrees/task_1')

  // Identical host:container paths are REQUIRED. A worktree's .git is a file containing
  // `gitdir: <abs>/.git/worktrees/<id>` — remapping to /workspace breaks git entirely.
  assert.deepEqual(args, [
    '-v', '/abs/repo/.git:/abs/repo/.git',
    '-v', '/abs/repo/.zen-worktrees/task_1:/abs/repo/.zen-worktrees/task_1',
  ])
})

test('buildWorktreeMounts never mounts the repository root', () => {
  const { args } = buildWorktreeMounts({ repoPath: '/abs/repo', taskId: 't1' })

  // The owner's main checkout must be absent from the container. Mounting the repo root even
  // read-only is not acceptable: on Docker Desktop for macOS a write to a :ro bind mount
  // returns exit 0 and reads back changed while never reaching the host, so :ro is not a
  // portable boundary.
  for (const a of args) {
    assert.ok(
      !a.startsWith('/abs/repo:'),
      `repo root must not be mounted, found: ${a}`,
    )
  }
})

test('buildWorkerContainerArgs sets the worktree as workdir and permits gateway egress', () => {
  const args = buildWorkerContainerArgs({
    repoPath: '/abs/repo',
    taskId: 't1',
    command: 'claude',
    args: ['-p', 'do the thing'],
    env: { ANTHROPIC_BASE_URL: 'http://host.docker.internal:8788' },
  })

  const wIdx = args.indexOf('-w')
  assert.equal(args[wIdx + 1], '/abs/repo/.zen-worktrees/t1')

  // Network must NOT be 'none' — the worker's whole job requires reaching the local gateway.
  const netIdx = args.indexOf('--network')
  assert.notEqual(args[netIdx + 1], 'none')

  assert.ok(args.includes('--security-opt'))
  assert.ok(args.includes('no-new-privileges'))
  assert.ok(args.includes('ANTHROPIC_BASE_URL=http://host.docker.internal:8788'))
  assert.equal(args[args.length - 3], 'claude')
})

test('resolveGatewayHostAlias flags that Linux needs an explicit --add-host', () => {
  const { alias, needsAddHost } = resolveGatewayHostAlias()
  assert.equal(typeof alias, 'string')
  assert.equal(needsAddHost, process.platform === 'linux' && alias === 'host.docker.internal')
})

test('resolveExecutionTier defaults to container', () => {
  const prev = process.env.ZEN_EXECUTION_TIER
  try {
    delete process.env.ZEN_EXECUTION_TIER
    assert.equal(resolveExecutionTier(), 'container')
    process.env.ZEN_EXECUTION_TIER = 'host'
    assert.equal(resolveExecutionTier(), 'host')
    process.env.ZEN_EXECUTION_TIER = 'nonsense'
    assert.equal(resolveExecutionTier(), 'container', 'unknown values must not silently mean host')
  } finally {
    if (prev === undefined) delete process.env.ZEN_EXECUTION_TIER
    else process.env.ZEN_EXECUTION_TIER = prev
  }
})

test('resolveRepoRootFromWorktree derives the repo root from git, not from path convention', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-rr-'))
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })

    createFeatureBranch(repo, 'rr')
    const { worktreePath } = provisionTaskWorktree(repo, 'zen/rr', 'task_rr')

    assert.equal(fs.realpathSync(resolveRepoRootFromWorktree(worktreePath)), fs.realpathSync(repo))
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Live container tests — require Docker + the built worker image.
// ---------------------------------------------------------------------------

test('worker executes inside the container and commits to the host worktree', { skip: canRunContainers ? false : skipReason }, async () => {
  // Mock gateway on the host. The container reaches it via host.docker.internal, which is the
  // hop the entire cost model depends on (INVARIANT 6).
  const gw = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200); return res.end('{}') }
    let body = ''
    for await (const c of req) body += c
    let tools = 0
    let sawToolResult = false
    try {
      const j = JSON.parse(body)
      tools = (j.tools || []).length
      sawToolResult = JSON.stringify(j.messages || []).includes('tool_result')
    } catch {}

    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (tools > 0 && !sawToolResult) {
      const input = JSON.stringify({ file_path: 'created_by_worker.txt', content: 'hello from container\n' })
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"mock","usage":{"input_tokens":42,"output_tokens":0}}}\n\n')
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"Write","input":{}}}\n\n')
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":' + JSON.stringify(input) + '}}\n\n')
      res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":17}}\n\n')
    } else {
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m0","type":"message","role":"assistant","content":[],"model":"mock","usage":{"input_tokens":5,"output_tokens":0}}}\n\n')
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n')
      res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n')
    }
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    res.end()
  })
  await new Promise((r) => gw.listen(0, '0.0.0.0', r))
  const gatewayUrl = `http://127.0.0.1:${gw.address().port}`

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-cw-'))
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-cw-db-'))
  const prevTier = process.env.ZEN_EXECUTION_TIER
  process.env.ZEN_EXECUTION_TIER = 'container'

  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'README.md'), '# app\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })

    const db = getOrchestratorDb(path.join(dbDir, 'test.sqlite'))
    const project = createProject({ name: 'CW', repoPath: repo }, db)
    const baseline = createBaseline({ projectId: project.id, specMarkdown: 's', contentDigest: 'd', status: 'APPROVED' }, db)
    const milestone = createMilestone({ baselineId: baseline.id, title: 'M' }, db)
    const task = createTask({ milestoneId: milestone.id, title: 'Create a file', status: 'In Progress' }, db)

    createFeatureBranch(repo, 'cw')
    const { worktreePath } = provisionTaskWorktree(repo, 'zen/cw', task.id)

    const result = await executeWorkerTask({
      taskId: task.id,
      projectId: project.id,
      worktreePath,
      gatewayUrl,
      timeoutMs: 120000,
    }, db)

    // The agent's file, written inside the container, must land in the host worktree.
    assert.ok(fs.existsSync(path.join(worktreePath, 'created_by_worker.txt')))
    assert.ok(result.candidateCommitSha, 'a candidate commit must exist')

    // Token accounting must be real, not the old hardcoded 100/50.
    const run = getTaskRun(result.taskRunId, db)
    assert.equal(run.is_estimated, 0, 'usage must come from the CLI event stream')
    assert.ok(run.input_tokens > 0 && run.output_tokens > 0)

    // INVARIANT 3: the owner's main checkout is untouched.
    const mainStatus = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
      .replace(/\?\? \.zen-worktrees\/\n?/, '')
      .trim()
    assert.equal(mainStatus, '', 'main checkout must remain clean')
  } finally {
    gw.close()
    closeOrchestratorDb()
    if (prevTier === undefined) delete process.env.ZEN_EXECUTION_TIER
    else process.env.ZEN_EXECUTION_TIER = prevTier
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(dbDir, { recursive: true, force: true })
  }
})

test('the container cannot read the owner home directory or gateway credentials', { skip: canRunContainers ? false : skipReason }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-iso-'))
  const sentinel = path.join(os.homedir(), '.zen-isolation-sentinel')

  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })
    createFeatureBranch(repo, 'iso')
    const { worktreePath } = provisionTaskWorktree(repo, 'zen/iso', 'task_iso')

    fs.writeFileSync(sentinel, 'this must not be readable from the container\n')

    const { args: mountArgs } = buildWorktreeMounts({ repoPath: repo, taskId: 'task_iso' })
    const res = spawnSync(engineInfo.engine, [
      'run', '--rm', '--entrypoint', 'sh',
      ...mountArgs,
      '-w', worktreePath,
      DEFAULT_WORKER_IMAGE,
      '-c',
      // Probe the three things that made the host tier unacceptable: the owner's home, their
      // ssh keys, and ~/.zen-claude which holds the gateway account credentials.
      `cat ${sentinel} 2>&1; ls ${path.join(os.homedir(), '.ssh')} 2>&1; ls ${path.join(os.homedir(), '.zen-claude')} 2>&1`,
    ], { encoding: 'utf8' })

    const out = `${res.stdout}${res.stderr}`
    assert.ok(!out.includes('must not be readable'), 'container read a file from the owner home directory')
    assert.match(out, /No such file or directory/, 'owner paths should not exist inside the container')
  } finally {
    fs.rmSync(sentinel, { force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

/**
 * Quota guard tests.
 *
 * A gateway that keeps replying `tool_use` loops the agent indefinitely. Measured against a
 * mock: 1,562 agent turns in 45 seconds, with the worker's default timeout at 120s. Every turn
 * is real spend against the owner's pooled subscriptions, so an unbounded worker can exhaust a
 * day's quota on one wedged task.
 */

test('detectQuotaStop recognises a turn-capped run and ignores ordinary failures', () => {
  assert.deepEqual(
    detectQuotaStop([{ type: 'result', subtype: 'error_max_turns', terminal_reason: 'max_turns', num_turns: 4 }]),
    { limit: 'max-turns', terminalReason: 'max_turns', turns: 4 },
  )

  // An ordinary error must NOT be reported as a quota stop — that would tell the owner to
  // raise a limit when the real problem is elsewhere.
  assert.equal(
    detectQuotaStop([{ type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }]),
    null,
  )
  assert.equal(detectQuotaStop([]), null)
})

test('a looping gateway is bounded by the turn cap instead of burning quota', { skip: canRunContainers ? false : skipReason }, async () => {
  let agentTurns = 0

  // Pathological gateway: always asks for another tool call, never ends the turn.
  const gw = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200); return res.end('{}') }
    let body = ''
    for await (const c of req) body += c
    let tools = 0
    try { tools = (JSON.parse(body).tools || []).length } catch {}
    if (tools > 0) agentTurns++

    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (tools > 0) {
      const input = JSON.stringify({ command: 'echo loop' })
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"mock","usage":{"input_tokens":10,"output_tokens":0}}}\n\n')
      res.write(`event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_${agentTurns}","name":"Bash","input":{}}}\n\n`)
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":' + JSON.stringify(input) + '}}\n\n')
      res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n')
    } else {
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m0","type":"message","role":"assistant","content":[],"model":"mock","usage":{"input_tokens":1,"output_tokens":0}}}\n\n')
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"t"}}\n\n')
      res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n')
    }
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    res.end()
  })
  await new Promise((r) => gw.listen(0, '0.0.0.0', r))
  const gatewayUrl = `http://127.0.0.1:${gw.address().port}`

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-quota-'))
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-quota-db-'))
  const prevTier = process.env.ZEN_EXECUTION_TIER
  process.env.ZEN_EXECUTION_TIER = 'container'

  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })

    const db = getOrchestratorDb(path.join(dbDir, 'test.sqlite'))
    const project = createProject({ name: 'Q', repoPath: repo }, db)
    const baseline = createBaseline({ projectId: project.id, specMarkdown: 's', contentDigest: 'd', status: 'APPROVED' }, db)
    const milestone = createMilestone({ baselineId: baseline.id, title: 'M' }, db)
    const task = createTask({ milestoneId: milestone.id, title: 'Loop forever', status: 'In Progress' }, db)

    createFeatureBranch(repo, 'q')
    const { worktreePath } = provisionTaskWorktree(repo, 'zen/q', task.id)

    await assert.rejects(
      () => executeWorkerTask({
        taskId: task.id,
        projectId: project.id,
        worktreePath,
        gatewayUrl,
        timeoutMs: 120000,
        maxTurns: 3,
        maxBudgetUsd: 1,
      }, db),
      (err) => {
        assert.equal(err.code, 'E_WORKER_QUOTA_EXCEEDED')
        assert.equal(err.limit, 'max-turns')
        return true
      },
    )

    // The cap must actually bound spend, not merely label the failure afterwards.
    assert.ok(agentTurns <= 5, `expected the loop to be cut short, gateway served ${agentTurns} turns`)

    // The task is Blocked for an operational reason the owner can act on, not a mystery failure.
    const blocked = getTask(task.id, db)
    assert.equal(blocked.status, 'Blocked')
    assert.equal(blocked.blocked_reason, 'BUDGET_EXCEEDED')
  } finally {
    gw.close()
    closeOrchestratorDb()
    if (prevTier === undefined) delete process.env.ZEN_EXECUTION_TIER
    else process.env.ZEN_EXECUTION_TIER = prevTier
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(dbDir, { recursive: true, force: true })
  }
})

/**
 * T1.2 — verification runs in the container tier.
 *
 * The point is provenance: the verification_digest the reviewer trusts must correspond to a
 * run inside the sandbox, in the same image the code was built in. Recording the host's node
 * version for a containerised run would make the artifact misdescribe itself.
 */

test('container-tier verification records honest provenance and denies network egress', { skip: canRunContainers ? false : skipReason }, async () => {
  const { runVerificationChecks } = await import('../lib/orchestrator/verifier-engine.mjs')
  const { getVerificationResults, createTaskRun: mkRun } = await import('../lib/orchestrator/db/index.mjs')

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-v-'))
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-v-db-'))

  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
    // A check that proves BOTH facts at once: it prints the node version actually executing
    // (container's, not the host's) and reports whether egress is blocked.
    fs.writeFileSync(path.join(repo, 'check.js'), `
      const https = require('node:http')
      process.stdout.write('RUNTIME=' + process.version + '\\n')
      const req = https.request({ host: 'example.com', port: 80, timeout: 3000 }, () => {
        process.stdout.write('EGRESS=open\\n'); process.exit(0)
      })
      req.on('error', () => { process.stdout.write('EGRESS=blocked\\n'); process.exit(0) })
      req.on('timeout', () => { process.stdout.write('EGRESS=blocked\\n'); process.exit(0) })
      req.end()
    `)
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })

    createFeatureBranch(repo, 'v')
    const { worktreePath } = provisionTaskWorktree(repo, 'zen/v', 'task_v')

    const db = getOrchestratorDb(path.join(dbDir, 'test.sqlite'))
    const project = createProject({ name: 'V', repoPath: repo }, db)
    const baseline = createBaseline({ projectId: project.id, specMarkdown: 's', contentDigest: 'd', status: 'APPROVED' }, db)
    const milestone = createMilestone({ baselineId: baseline.id, title: 'M' }, db)
    const task = createTask({ milestoneId: milestone.id, title: 'V', status: 'Automated Checks' }, db)
    const run = mkRun({ taskId: task.id, kind: 'VERIFICATION', role: 'VERIFIER' }, db)

    const result = await runVerificationChecks({
      taskRunId: run.id,
      worktreePath,
      checkCommands: ['node check.js'],
      timeoutMs: 90000,
      tier: 'container',
    }, db)

    assert.equal(result.passed, true, `verification should pass. log: ${result.outputLog}`)

    // Ran inside the container: the reported runtime is the image's node, and the image is
    // pinned to node:24-slim which differs from whatever the host happens to run.
    assert.match(result.outputLog, /RUNTIME=v\d+/)

    // Network egress must be denied — a test suite has no reason to reach the internet, and
    // denying it means a runaway test cannot phone home or burn gateway quota.
    assert.match(result.outputLog, /EGRESS=blocked/, 'verification container must have no network')

    // The stored artifact must describe where it actually ran.
    const [stored] = getVerificationResults(run.id, db)
    assert.equal(stored.environment_info.tier, 'container')
    assert.equal(stored.environment_info.network, 'none')
    assert.ok(stored.environment_info.image, 'image must be recorded for reproducibility')
    assert.equal(stored.environment_info.node, undefined, 'must not record the host node version for a container run')
  } finally {
    closeOrchestratorDb()
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(dbDir, { recursive: true, force: true })
  }
})
