import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { isPidAlive, terminateProcessGroup } from './db/recovery-manager.mjs'

export class SecurityBoundaryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SecurityBoundaryError'
    this.code = code
  }
}

const SENSITIVE_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ZEN_API_KEY',
  'CODEX_HOME',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'SSH_AUTH_SOCK',
  'ZEN_DB_PATH',
  'ZEN_ORCHESTRATOR_DB_PATH',
])

const ALLOWED_COMMAND_PREFIXES = [
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'node',
  'python',
  'python3',
  'pytest',
  'cargo',
  'go',
  'git status',
  'git diff',
  'git rev-parse',
  'git log',
  'cat',
  'ls',
  'pwd',
]

const BANNED_COMMAND_PATTERNS = [
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\b\s+if=/,
  /\brm\b\s+-[a-zA-Z]*rf\b\s+[\/~]/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bnc\b/,
  /\bnetcat\b/,
  /:(){:|:&};:/, // fork bomb
]

/**
 * Enforce that a target filesystem path resolves strictly inside the worktree directory.
 * Resolves symlinks and throws E_PATH_TRAVERSAL if outside.
 */
export function assertPathWithinWorktree(targetPath, worktreePath) {
  const resolvedWorktree = path.resolve(worktreePath)
  let resolvedTarget = path.resolve(resolvedWorktree, targetPath)

  // If file exists, check realpath
  if (fs.existsSync(resolvedTarget)) {
    try {
      resolvedTarget = fs.realpathSync(resolvedTarget)
    } catch {}
  } else {
    // If file does not exist yet, check realpath of its nearest existing parent
    let parent = path.dirname(resolvedTarget)
    while (parent && !fs.existsSync(parent) && parent !== path.dirname(parent)) {
      parent = path.dirname(parent)
    }
    if (fs.existsSync(parent)) {
      try {
        const realParent = fs.realpathSync(parent)
        resolvedTarget = path.join(realParent, path.relative(parent, resolvedTarget))
      } catch {}
    }
  }

  const worktreeReal = fs.existsSync(resolvedWorktree) ? fs.realpathSync(resolvedWorktree) : resolvedWorktree

  const relative = path.relative(worktreeReal, resolvedTarget)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SecurityBoundaryError('E_PATH_TRAVERSAL', `Path traversal blocked: '${targetPath}' resolves outside worktree root '${worktreeReal}'`)
  }

  // Prevent direct access to .git metadata directory
  if (relative === '.git' || relative.startsWith('.git/') || relative.startsWith('.git\\')) {
    throw new SecurityBoundaryError('E_GIT_METADATA_PROTECTED', `Direct access to .git metadata is prohibited: '${targetPath}'`)
  }

  return resolvedTarget
}

/**
 * Sanitize child process environment variables, stripping all API keys and host secrets.
 */
export function sanitizeWorkerEnvironment(baseEnv = process.env) {
  const sanitized = {}

  for (const [key, val] of Object.entries(baseEnv)) {
    if (SENSITIVE_ENV_KEYS.has(key)) continue
    if (key.includes('TOKEN') || key.includes('SECRET') || key.includes('KEY') || key.includes('PASSWORD')) {
      // Exclude potential sensitive credentials
      continue
    }
    sanitized[key] = val
  }

  // Set safe defaults
  sanitized.CI = 'true'
  sanitized.NODE_ENV = 'test'
  sanitized.GIT_TERMINAL_PROMPT = '0'
  delete sanitized.NODE_TEST_CONTEXT

  return sanitized
}

/**
 * Validate that a shell command does not violate safety policies.
 */
export function validateWorkerCommand(commandStr) {
  if (!commandStr || typeof commandStr !== 'string') {
    throw new SecurityBoundaryError('E_INVALID_COMMAND', 'Command must be a non-empty string')
  }

  const trimmed = commandStr.trim()

  for (const pattern of BANNED_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new SecurityBoundaryError('E_BANNED_COMMAND', `Command blocked by safety policy: '${trimmed}'`)
    }
  }

  const isAllowed = ALLOWED_COMMAND_PREFIXES.some((prefix) =>
    trimmed === prefix || trimmed.startsWith(prefix + ' ')
  )

  if (!isAllowed) {
    throw new SecurityBoundaryError('E_COMMAND_NOT_ALLOWLISTED', `Command is not on the execution allowlist: '${trimmed}'`)
  }

  return true
}

/**
 * Spawn a child process with POSIX process-group isolation and hard timeout.
 */
export function spawnControlledProcess(command, args, {
  cwd,
  timeoutMs = 120000,
  env = process.env,
  onStdout = null,
  onStderr = null,
} = {}) {
  const sanitizedEnv = sanitizeWorkerEnvironment(env)

  return new Promise((resolve, reject) => {
    let child
    let timer = null
    let stdoutData = ''
    let stderrData = ''
    let timedOut = false

    try {
      child = spawn(command, args, {
        cwd,
        env: sanitizedEnv,
        detached: true, // creates new process group on POSIX (enables group kill)
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      return reject(err)
    }

    const pid = child.pid
    const startTime = Date.now()

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        terminateProcessGroup(pid, { graceMs: 2000 })
      }, timeoutMs)
      timer.unref?.()
    }

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString()
      onStdout?.(chunk)
    })

    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString()
      onStderr?.(chunk)
    })

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({
        pid,
        startTime,
        exitCode: timedOut ? 124 : code,
        signal,
        timedOut,
        stdout: stdoutData,
        stderr: stderrData,
      })
    })
  })
}
