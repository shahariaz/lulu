import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { sanitizeWorkerEnvironment } from './security-boundary.mjs'
import { terminateProcessGroup, isPidAlive } from './db/recovery-manager.mjs'

// Default ephemeral port pool range for local previews
const PREVIEW_PORT_START = 41000
const PREVIEW_PORT_END = 41999

const activePreviews = new Map() // taskId -> PreviewSession
const allocatedPorts = new Set()

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
  for (let port = PREVIEW_PORT_START; port <= PREVIEW_PORT_END; port++) {
    if (!allocatedPorts.has(port)) {
      const isFree = await isPortAvailable(port)
      if (isFree) {
        allocatedPorts.add(port)
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
export function detectPreviewCommand(worktreePath, port) {
  const pkgPath = path.join(worktreePath, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (pkg.scripts?.dev) {
        // If package uses vite or next, pass port
        if (pkg.dependencies?.vite || pkg.devDependencies?.vite) {
          return { command: 'npx', args: ['vite', '--port', String(port), '--host', '127.0.0.1'] }
        }
        return { command: 'npm', args: ['run', 'dev', '--', '--port', String(port)] }
      }
      if (pkg.scripts?.start) {
        return { command: 'npm', args: ['start'] }
      }
    } catch {}
  }

  // Fallback: Python simple HTTP server
  return {
    command: 'python3',
    args: ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
  }
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

  if (!execCmd) {
    const detected = detectPreviewCommand(resolvedWorktree, assignedPort)
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

  const child = spawn(execCmd, execArgs, {
    cwd: resolvedWorktree,
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
    logs: session.getLogs(),
  }
}
