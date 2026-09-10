import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'

function readParsedEnv(filePath) {
  try {
    return parseEnv(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`Unable to load environment file ${filePath}: ${error.message}`)
  }
}

/**
 * Load orchestrator configuration without overwriting explicit shell variables.
 *
 * General configuration belongs in the repository .env. For compatibility with the existing
 * local gateway setup, Brave credentials may also live in brave.env at the repository root or
 * inside antigravity-gateway. Those dedicated files expose only BRAVE_API_KEY to this process;
 * a legacy `apiKey=` entry is accepted without leaking that generic name into child processes.
 */
export function loadOrchestratorEnvironment({ repoRoot, env = process.env } = {}) {
  if (!repoRoot) throw new Error('repoRoot is required')

  const general = readParsedEnv(path.join(repoRoot, '.env'))
  if (general) {
    for (const [key, value] of Object.entries(general)) {
      if (env[key] === undefined) env[key] = value
    }
  }

  let braveSource = env.BRAVE_API_KEY ? 'shell or .env' : null
  const braveFiles = [
    path.join(repoRoot, 'brave.env'),
    path.join(repoRoot, 'antigravity-gateway', 'brave.env'),
  ]

  for (const filePath of braveFiles) {
    if (env.BRAVE_API_KEY) break
    const parsed = readParsedEnv(filePath)
    const value = parsed?.BRAVE_API_KEY || parsed?.apiKey
    if (value) {
      env.BRAVE_API_KEY = value
      braveSource = path.relative(repoRoot, filePath)
    }
  }

  return { braveConfigured: Boolean(env.BRAVE_API_KEY), braveSource }
}
