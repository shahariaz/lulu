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
