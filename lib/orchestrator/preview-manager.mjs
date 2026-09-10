import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { sanitizeWorkerEnvironment } from './security-boundary.mjs'
import { terminateProcessGroup, isPidAlive } from './db/recovery-manager.mjs'
import { detectContainerEngine, DEFAULT_WORKER_IMAGE, resolveHostUser } from './container-runner.mjs'

// Default ephemeral port pool range for local previews
const PREVIEW_PORT_START = 41000
const PREVIEW_PORT_END = 41999
const PREVIEW_PORT_COUNT = PREVIEW_PORT_END - PREVIEW_PORT_START + 1

const activePreviews = new Map() // taskId -> PreviewSession
const allocatedPorts = new Set()
// Node's test runner and multiple orchestrator processes do not share allocatedPorts.
// Starting each process at a PID-derived offset avoids every process racing for 41000.
let nextPortOffset = process.pid % PREVIEW_PORT_COUNT

/**
 * Check if a TCP port is currently free on 127.0.0.1.
 */
export function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Find and allocate the next available port in the preview pool.
 */
export async function allocatePreviewPort() {
  for (let attempt = 0; attempt < PREVIEW_PORT_COUNT; attempt++) {
    const offset = (nextPortOffset + attempt) % PREVIEW_PORT_COUNT
    const port = PREVIEW_PORT_START + offset
    if (!allocatedPorts.has(port)) {
      const isFree = await isPortAvailable(port)
      if (isFree) {
        allocatedPorts.add(port)
        nextPortOffset = (offset + 1) % PREVIEW_PORT_COUNT
        return port
      }
    }
  }

  // Fallback to random ephemeral port
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => {
        allocatedPorts.add(p)
        resolve(p)
      })
    })
    srv.on('error', reject)
  })
}

/**
 * Release an allocated preview port.
 */
export function releasePreviewPort(port) {
  allocatedPorts.delete(port)
}

/**
 * Detect appropriate preview / dev server command from repository files.
 */
export function detectPreviewCommand(worktreePath, port, { host = '127.0.0.1' } = {}) {
  const pkgPath = path.join(worktreePath, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg.scripts?.dev) {
        // If package uses vite or next, pass port
        if (pkg.dependencies?.vite || pkg.devDependencies?.vite) {
          return { command: 'npx', args: ['vite', '--port', String(port), '--host', host] }
        }
        return { command: 'npm', args: ['run', 'dev', '--', '--port', String(port)] }
      }
      if (pkg.scripts?.start) {
        return { command: 'npm', args: ['start'] }
      }
    } catch {}
  }

  // Node is guaranteed by the preview image; Python is not.
  return {
    command: 'node',
    args: ['-e', `const h=require('node:http'),f=require('node:fs'),p=require('node:path');h.createServer((q,r)=>{let x=p.join(process.cwd(),q.url==='/'?'index.html':q.url);f.readFile(x,(e,b)=>{r.statusCode=e?404:200;r.end(e?'Not found':b)})}).listen(${port},${JSON.stringify(host)})`],
  }
}

export function buildPreviewContainerArgs({
  engine,
  image = DEFAULT_WORKER_IMAGE,
  worktreePath,
  hostPort,
  containerPort = hostPort,
  containerName,
  command,
  args = [],
  env = {},
}) {
  if (engine !== 'docker' && engine !== 'podman') throw new Error(`Unsupported preview container engine: ${engine}`)
  const resolvedWorktree = path.resolve(worktreePath)
  const result = [
    'run', '--rm', '--name', containerName,
    '-w', '/workspace', '-v', `${resolvedWorktree}:/workspace:rw`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
    '--memory', '1g', '--cpus', '1.0', '--pids-limit', '128',
    '--security-opt', 'no-new-privileges', '--network', 'bridge',
    '-p', `127.0.0.1:${hostPort}:${containerPort}`,
  ]
  const user = resolveHostUser(resolvedWorktree)
  if (user) result.push('--user', user)
  const safeEnv = { CI: 'true', NODE_ENV: 'development', PORT: String(containerPort), HOST: '0.0.0.0', HOME: '/tmp', npm_config_cache: '/tmp/npm-cache', ...env }
  for (const [key, value] of Object.entries(safeEnv)) result.push('-e', `${key}=${value}`)
  result.push(image, command, ...args)
  return result
}

/**
 * Poll server URL until it responds or timeout expires.
 */
export async function waitForServerReady(port, { timeoutMs = 15000, pathname = '/' } = {}) {
  const start = Date.now()
  const url = `http://127.0.0.1:${port}${pathname}`

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 1000 }, (response) => {
          resolve(response.statusCode)
        })
        req.on('error', reject)
        req.on('timeout', () => {
          req.destroy()
          reject(new Error('timeout'))
        })
      })

      if (res) return true
    } catch {
      // Server not ready yet; wait 200ms
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  return false
}

/**
 * Start an isolated preview dev server for a task worktree.
 */
export async function startPreviewServer({
  taskId,
  worktreePath,
  command = null,
  args = [],
  port = null,
  env = {},
  timeoutMs = 15000,
  tier = process.env.ZEN_PREVIEW_TIER || 'container',
  image = process.env.ZEN_PREVIEW_IMAGE || DEFAULT_WORKER_IMAGE,
  containerEngine = null,
}) {
  if (activePreviews.has(taskId)) {
    const existing = activePreviews.get(taskId)
    if (isPidAlive(existing.pid)) {
      return existing
    }
    // Stale session
    stopPreviewServer(taskId)
  }

  const assignedPort = port || (await allocatePreviewPort())
  const resolvedWorktree = path.resolve(worktreePath)

  let execCmd = command
  let execArgs = args

  if (tier !== 'host' && tier !== 'container') throw new Error(`Unsupported preview tier: ${tier}`)
  if (!execCmd) {
    const detected = detectPreviewCommand(resolvedWorktree, assignedPort, { host: tier === 'container' ? '0.0.0.0' : '127.0.0.1' })
    execCmd = detected.command
    execArgs = detected.args
  }

  // Sanitize environment variables so dev server doesn't leak secrets
  const sanitizedEnv = sanitizeWorkerEnvironment({
    ...process.env,
    ...env,
    PORT: String(assignedPort),
  })

  let stdoutBuffer = ''
  let stderrBuffer = ''

  let processCommand = execCmd
  let processArgs = execArgs
  let containerName = null
  let activeContainerEngine = null
  if (tier === 'container') {
    const detected = containerEngine ? { engine: containerEngine, available: true } : detectContainerEngine()
    if (!detected.available || !['docker', 'podman'].includes(detected.engine)) {
      releasePreviewPort(assignedPort)
      throw new Error('Container preview requires Docker or Podman; set ZEN_PREVIEW_TIER=host only for trusted local development')
    }
    processCommand = detected.engine
    activeContainerEngine = detected.engine
    containerName = `zen-preview-${String(taskId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40)}-${Date.now()}`
    processArgs = buildPreviewContainerArgs({
      engine: detected.engine, image, worktreePath: resolvedWorktree, hostPort: assignedPort,
      containerName, command: execCmd, args: execArgs, env,
    })
  }

  const child = spawn(processCommand, processArgs, {
    cwd: tier === 'host' ? resolvedWorktree : undefined,
    env: sanitizedEnv,
    detached: true, // new process group for clean group termination
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const pid = child.pid
  const session = {
    taskId,
    port: assignedPort,
    pid,
    url: `http://127.0.0.1:${assignedPort}`,
    worktreePath: resolvedWorktree,
    command: `${execCmd} ${execArgs.join(' ')}`,
    tier,
    containerName,
    containerEngine: activeContainerEngine,
    status: 'STARTING',
    startedAt: Date.now(),
    getLogs: () => ({ stdout: stdoutBuffer, stderr: stderrBuffer }),
  }

  child.stdout.on('data', (c) => {
    stdoutBuffer = (stdoutBuffer + c.toString()).slice(-20000) // keep last 20k chars
  })

  child.stderr.on('data', (c) => {
    stderrBuffer = (stderrBuffer + c.toString()).slice(-20000)
  })

  child.on('close', (code) => {
    session.status = 'STOPPED'
    session.exitCode = code
    releasePreviewPort(assignedPort)
    activePreviews.delete(taskId)
  })

  child.on('error', (err) => {
    session.status = 'ERROR'
    session.error = err.message
    releasePreviewPort(assignedPort)
    activePreviews.delete(taskId)
  })

  activePreviews.set(taskId, session)

  // Wait for server to begin responding
  const isReady = await waitForServerReady(assignedPort, { timeoutMs })
  session.status = isReady ? 'RUNNING' : 'UNRESPONSIVE'

  return session
}

/**
 * Stop an active preview server for a task.
 */
export function stopPreviewServer(taskId) {
  const session = activePreviews.get(taskId)
  if (!session) return { stopped: false, wasRunning: false }

  if (session.tier === 'container' && session.containerName) {
    spawnSync(session.containerEngine || 'docker', ['stop', '--time', '2', session.containerName], { encoding: 'utf8' })
  }
  terminateProcessGroup(session.pid, { graceMs: 2000 })
  releasePreviewPort(session.port)
  activePreviews.delete(taskId)

  return {
    stopped: true,
    wasRunning: true,
    port: session.port,
  }
}

/**
 * Stop all active preview servers.
 */
export function stopAllPreviewServers() {
  const stopped = []
  for (const taskId of activePreviews.keys()) {
    stopped.push(stopPreviewServer(taskId))
  }
  return stopped
}

/**
 * Get status of an active preview session.
 */
export function getPreviewStatus(taskId) {
  const session = activePreviews.get(taskId)
  if (!session) return null

  const isAlive = isPidAlive(session.pid)
  return {
    taskId: session.taskId,
    port: session.port,
    url: session.url,
    status: isAlive ? session.status : 'DEAD',
    uptimeMs: Date.now() - session.startedAt,
    command: session.command,
    tier: session.tier,
    containerName: session.containerName,
    logs: session.getLogs(),
  }
}
