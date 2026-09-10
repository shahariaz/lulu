import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { spawnControlledProcess } from './security-boundary.mjs'

export class ContainerExecutionError extends Error {
  constructor(message, { exitCode = 1, stderr = '' } = {}) {
    super(message)
    this.name = 'ContainerExecutionError'
    this.exitCode = exitCode
    this.stderr = stderr
  }
}

/**
 * Detect available container engines on the host machine.
 */
export function detectContainerEngine() {
  // Check podman first (rootless default)
  try {
    const res = spawnSync('podman', ['--version'], { encoding: 'utf8' })
    if (res.status === 0 && res.stdout) {
      return { engine: 'podman', version: res.stdout.trim(), available: true }
    }
  } catch {}

  // Check docker
  try {
    const res = spawnSync('docker', ['--version'], { encoding: 'utf8' })
    if (res.status === 0 && res.stdout) {
      return { engine: 'docker', version: res.stdout.trim(), available: true }
    }
  } catch {}

  // Check macOS sandbox-exec
  if (process.platform === 'darwin') {
    try {
      const res = spawnSync('which', ['sandbox-exec'], { encoding: 'utf8' })
      if (res.status === 0 && res.stdout) {
        return { engine: 'sandbox-exec', version: 'darwin-sandbox', available: true }
      }
    } catch {}
  }

  return { engine: 'none', version: null, available: false }
}

export const DEFAULT_WORKER_IMAGE = process.env.ZEN_WORKER_IMAGE || 'claude-zen/worker:latest'

/**
 * Build the bind mounts that let git work on a task worktree inside a container.
 *
 * WHY THIS SHAPE (verified against Docker 29.4.0 — do not "simplify"):
 *
 * A git worktree's `.git` is a FILE, not a directory, containing an absolute host path:
 *     gitdir: /abs/repo/.git/worktrees/<taskId>
 * so the container must see BOTH the worktree and the repo's `.git` at their *identical*
 * absolute paths. Mounting only the worktree, or remapping it to /workspace, yields
 * `fatal: not a git repository: (null)`.
 *
 * We deliberately do NOT mount the repo root:
 *   - the owner's main checkout is then entirely absent from the container (strongest
 *     isolation, and it is what invariant 3 asks for), and
 *   - `:ro` is NOT a reliable boundary: on Docker Desktop for macOS a write to a read-only
 *     bind mount returns exit 0 and reads back changed while never reaching the host, whereas
 *     Linux fails it with EROFS. Relying on `:ro` would mean different security on the owner's
 *     Mac than on a Linux server.
 *
 * Mounting `.git` read-write is required — the worker commits, which writes objects and refs.
 */
export function buildWorktreeMounts({ repoPath, taskId, worktreePath = null }) {
  const repo = path.resolve(repoPath)
  const worktree = worktreePath
    ? path.resolve(worktreePath)
    : path.join(repo, '.zen-worktrees', taskId)
  const gitDir = path.join(repo, '.git')

  return {
    worktree,
    gitDir,
    args: [
      '-v', `${gitDir}:${gitDir}`,
      '-v', `${worktree}:${worktree}`,
    ],
  }
}

/**
 * Hostname the container uses to reach the gateways running on the host.
 *
 * macOS/Docker Desktop resolves `host.docker.internal` automatically and reaches even a
 * 127.0.0.1-bound listener. Linux does not define it at all, so the caller must also pass
 * `--add-host=host.docker.internal:host-gateway` (see `needsAddHost`) and the gateway must
 * bind an interface the bridge can reach.
 */
export function resolveGatewayHostAlias() {
  const alias = process.env.ZEN_GATEWAY_HOST_ALIAS || 'host.docker.internal'
  return {
    alias,
    needsAddHost: process.platform === 'linux' && alias === 'host.docker.internal',
  }
}

/**
 * Build container args for a worker/verifier run against a git worktree.
 *
 * Differs from buildContainerArgs() in two ways that matter: it uses the worktree mount layout
 * above (identical absolute paths, `.git` included), and it permits network egress so the CLI
 * can reach the local gateway. buildContainerArgs() stays as the general no-network sandbox.
 */
export function buildWorkerContainerArgs({
  engine = 'docker',
  image = DEFAULT_WORKER_IMAGE,
  repoPath,
  taskId,
  worktreePath = null,
  command,
  args = [],
  env = {},
  user = null,
  memoryLimit = '4g',
  cpuLimit = '2.0',
  pidsLimit = 512,
  networkMode = 'bridge',
}) {
  const mounts = buildWorktreeMounts({ repoPath, taskId, worktreePath })
  const { alias, needsAddHost } = resolveGatewayHostAlias()

  const containerArgs = ['run', '--rm']

  containerArgs.push(...mounts.args)
  containerArgs.push('-w', mounts.worktree)

  if (memoryLimit) containerArgs.push('--memory', memoryLimit)
  if (cpuLimit) containerArgs.push('--cpus', cpuLimit)
  if (pidsLimit) containerArgs.push('--pids-limit', String(pidsLimit))

  containerArgs.push('--security-opt', 'no-new-privileges')

  // Run as the host owner of the worktree so commits are not root-owned on Linux.
  if (user) containerArgs.push('--user', user)

  containerArgs.push('--network', networkMode)
  if (needsAddHost) containerArgs.push('--add-host', `${alias}:host-gateway`)

  for (const [key, val] of Object.entries(env)) {
    containerArgs.push('-e', `${key}=${val}`)
  }

  containerArgs.push(image)
  containerArgs.push(command)
  containerArgs.push(...args)

  return containerArgs
}

/**
 * uid:gid that owns the worktree on the host. Passed to --user so files the container creates
 * belong to the owner rather than root. Returns null on platforms where it does not apply.
 */
export function resolveHostUser(targetPath) {
  if (process.platform === 'win32') return null
  try {
    const st = fs.statSync(targetPath)
    return `${st.uid}:${st.gid}`
  } catch {
    return null
  }
}

/**
 * Build container invocation arguments enforcing strict isolation invariants.
 */
export function buildContainerArgs({
  engine = 'docker',
  image = 'node:22-slim',
  worktreePath,
  containerWorkdir = '/workspace',
  command,
  args = [],
  networkMode = 'none', // 'none' | 'host' | 'bridge'
  memoryLimit = '2g',
  cpuLimit = '2.0',
  pidsLimit = 100,
  user = '1000:1000',
  env = {},
}) {
  const resolvedWorktree = path.resolve(worktreePath)
  const containerArgs = ['run', '--rm']

  // 1. Working directory & Volume Mount
  containerArgs.push('-w', containerWorkdir)
  // Mount worktree read-write; all host secrets and root unmounted!
  containerArgs.push('-v', `${resolvedWorktree}:${containerWorkdir}:rw`)

  // 2. Resource Limits
  if (memoryLimit) containerArgs.push('--memory', memoryLimit)
  if (cpuLimit) containerArgs.push('--cpus', cpuLimit)
  if (pidsLimit) containerArgs.push('--pids-limit', String(pidsLimit))

  // 3. Security & User Isolation
  if (user && engine !== 'sandbox-exec') {
    containerArgs.push('--user', user)
  }
  containerArgs.push('--security-opt', 'no-new-privileges')

  // 4. Network Isolation
  containerArgs.push('--network', networkMode)

  // 5. Environment Variables
  containerArgs.push('-e', 'CI=true')
  containerArgs.push('-e', 'NODE_ENV=test')
  for (const [key, val] of Object.entries(env)) {
    containerArgs.push('-e', `${key}=${val}`)
  }

  // 6. Image & Command
  containerArgs.push(image)
  containerArgs.push(command)
  containerArgs.push(...args)

  return containerArgs
}

/**
 * Verify, from INSIDE a container, that the host gateway is reachable.
 *
 * Without this the failure mode is opaque: the CLI starts, cannot reach the gateway, and the
 * worker fails with a generic non-zero exit deep in a task run. Since the whole cost model
 * depends on this hop (invariant 6), check it explicitly and name the fix.
 *
 * Returns { reachable, alias, gatewayUrl, reason }. Never throws.
 */
export async function preflightGatewayReachable({
  engine = null,
  image = DEFAULT_WORKER_IMAGE,
  gatewayPort = Number(process.env.ZEN_ANTIGRAVITY_PORT || 8788),
  timeoutMs = 30000,
} = {}) {
  const detected = engine ? { engine, available: engine !== 'none' } : detectContainerEngine()
  const { alias, needsAddHost } = resolveGatewayHostAlias()
  const gatewayUrl = `http://${alias}:${gatewayPort}`

  if (!detected.available || detected.engine === 'none') {
    return { reachable: false, alias, gatewayUrl, reason: 'no container engine available' }
  }

  const args = ['run', '--rm', '--network', 'bridge']
  if (needsAddHost) args.push('--add-host', `${alias}:host-gateway`)
  args.push(
    image,
    'node', '-e',
    // A HEAD/GET to any path proves the hop. We only care that something answers.
    `fetch(${JSON.stringify(gatewayUrl + '/v1/models')},{signal:AbortSignal.timeout(5000)})` +
    `.then(r=>{console.log('OK '+r.status);process.exit(0)})` +
    `.catch(e=>{console.error('FAIL '+e.message);process.exit(1)})`,
  )

  try {
    const result = await spawnControlledProcess(detected.engine, args, { timeoutMs })
    if (result.exitCode === 0) {
      return { reachable: true, alias, gatewayUrl, reason: null }
    }
    return {
      reachable: false,
      alias,
      gatewayUrl,
      reason:
        `container could not reach ${gatewayUrl} (${(result.stderr || result.stdout || '').trim().slice(0, 200)}). ` +
        `On Linux the gateway must bind an interface the bridge can reach, and ` +
        `--add-host=${alias}:host-gateway must be set. Override the hostname with ZEN_GATEWAY_HOST_ALIAS.`,
    }
  } catch (err) {
    return { reachable: false, alias, gatewayUrl, reason: `preflight failed: ${err.message}` }
  }
}

/**
 * Execute a command inside an isolated container sandbox (Proposal A).
 */
export async function executeContainerCommand({
  engine = null,
  image = 'node:22-slim',
  worktreePath,
  command,
  args = [],
  networkMode = 'none',
  timeoutMs = 120000,
  env = {},
  mockRunner = null, // for testing container boundary without real Docker daemon
}) {
  const detected = engine ? { engine, available: engine !== 'none' } : detectContainerEngine()

  if (mockRunner) {
    return mockRunner({
      engine: detected.engine,
      image,
      worktreePath,
      command,
      args,
      networkMode,
    })
  }

  if (!detected.available || detected.engine === 'none') {
    throw new Error(`Container execution failed: no supported container engine (docker, podman) available on host.`)
  }

  const containerArgs = buildContainerArgs({
    engine: detected.engine,
    image,
    worktreePath,
    command,
    args,
    networkMode,
    env,
  })

  const result = await spawnControlledProcess(detected.engine, containerArgs, {
    cwd: worktreePath,
    timeoutMs,
  })

  if (result.exitCode !== 0) {
    throw new ContainerExecutionError(
      `Container execution of '${command}' failed with exit code ${result.exitCode}`,
      { exitCode: result.exitCode, stderr: result.stderr }
    )
  }

  return {
    success: true,
    engine: detected.engine,
    image,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}
