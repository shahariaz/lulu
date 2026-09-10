import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getRequestListener } from '@hono/node-server'
import { getOrchestratorDb, recordAuditLog } from './db/index.mjs'
import { performStartupRecovery } from './db/recovery-manager.mjs'
import { WorkerPoolManager } from './worker-pool.mjs'
import { ConflictFreeMergeQueue } from './merge-queue.mjs'
import { registerProjectRoutes } from './features/projects/routes.mjs'
import { registerProductDesignRoutes } from './features/product-design/routes.mjs'
import { registerPlanningRoutes } from './features/planning/routes.mjs'
import { registerDeliveryRoutes } from './features/delivery/routes.mjs'
import { renderUiBuildRequiredHtml } from './ui/build-required-html.mjs'
import { broadcastOrchestratorEvent, subscribeToOrchestratorEvents } from './http/event-bus.mjs'

export { broadcastOrchestratorEvent }

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
}
const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const frontendDist = path.resolve(moduleDir, '../../dist')

function staticResponse(c, requestedPath) {
  if (!fs.existsSync(frontendDist)) return null
  const relative = requestedPath.replace(/^\/+/, '') || 'index.html'
  const target = path.resolve(frontendDist, relative)
  if (!target.startsWith(`${frontendDist}${path.sep}`) && target !== path.join(frontendDist, 'index.html')) return null
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null
  const bytes = fs.readFileSync(target)
  return c.body(bytes, 200, { 'Content-Type': MIME_TYPES[path.extname(target)] || 'application/octet-stream', 'Cache-Control': relative === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable' })
}

/** Compose the feature modules. Hono owns transport concerns; domain engines remain framework-free. */
export function createOrchestratorApp({ db = null } = {}) {
  const targetDb = db || getOrchestratorDb()
  const app = new Hono()
  const workerPool = new WorkerPoolManager({ maxConcurrency: 3 })
  const mergeQueue = new ConflictFreeMergeQueue()
  mergeQueue.db = targetDb
  const dependencies = { db: targetDb, workerPool, mergeQueue }

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin')
    if (origin && !origin.includes('127.0.0.1') && !origin.includes('localhost')) return c.json({ error: 'Origin not allowed' }, 403)
    await next()
  })

  app.get('/api/orchestrator/events', (c) => streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: 'connected', data: JSON.stringify({ time: Date.now() }) })
    let closed = false
    const unsubscribe = subscribeToOrchestratorEvents((event, data) => { if (!closed) void stream.writeSSE({ event, data: JSON.stringify(data) }) })
    const abort = () => { closed = true; unsubscribe() }
    c.req.raw.signal.addEventListener('abort', abort, { once: true })
    try {
      while (!closed && !c.req.raw.signal.aborted) {
        await stream.sleep(15_000)
        if (!closed) await stream.write(': keepalive\n\n')
      }
    } finally { abort() }
  }))

  registerProjectRoutes(app, dependencies)
  registerProductDesignRoutes(app, dependencies)
  registerPlanningRoutes(app, dependencies)
  registerDeliveryRoutes(app, dependencies)

  app.get('/delivery', (c) => staticResponse(c, '/index.html') || c.html(renderUiBuildRequiredHtml()))
  app.get('/orchestrator', (c) => staticResponse(c, '/index.html') || c.html(renderUiBuildRequiredHtml()))
  app.get('/', (c) => staticResponse(c, '/index.html') || c.html(renderUiBuildRequiredHtml()))
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404)
    return staticResponse(c, c.req.path) || staticResponse(c, '/index.html') || c.html(renderUiBuildRequiredHtml())
  })
  app.notFound((c) => c.json({ error: `Not found: ${c.req.method} ${c.req.path}` }, 404))
  app.onError((err, c) => {
    if (process.env.ZEN_DEBUG_HTTP_ERRORS === '1') console.error(err)
    if (err.code === 'E_GATEWAY_UNAVAILABLE') return c.json({ error: err.message, code: err.code, gatewayUrl: err.gatewayUrl || null }, 503)
    // Refusing caller-supplied model output is a policy decision, not a malformed request.
    if (err.code === 'E_MOCK_INJECTION_FORBIDDEN') return c.json({ error: err.message, code: err.code }, 403)
    return c.json({ error: err.message, code: err.code || 'BAD_REQUEST' }, 400)
  })
  return app
}

export function createOrchestratorHandler({ db = null } = {}) {
  const app = createOrchestratorApp({ db })
  return getRequestListener((request) => app.fetch(request))
}

export function startOrchestratorServer({
  port = Number(process.env.ZEN_ORCHESTRATOR_PORT || 8900), db = null, skipRecovery = false,
} = {}) {
  const targetDb = db || getOrchestratorDb()
  const server = http.createServer(createOrchestratorHandler({ db: targetDb }))
  let recovery = null
  if (!skipRecovery) {
    try {
      recovery = performStartupRecovery(targetDb)
      if (recovery.reconciledRuns > 0 || recovery.quarantinedTasks.length > 0) {
        console.log(`[Recovery] Reconciled ${recovery.reconciledRuns} interrupted run(s); preserved ${recovery.preservedWorktrees} worktree(s); cleared ${recovery.clearedLocks} stale git lock(s); quarantined ${recovery.quarantinedTasks.length} task(s) for owner review.`)
        for (const item of recovery.quarantinedTasks) recordAuditLog({ taskId: item.taskId, eventType: 'STARTUP_RECOVERY_QUARANTINE', actor: 'orchestrator', details: { runId: item.runId, worktreePath: item.worktreePath, isDirty: item.isDirty } }, targetDb)
      }
    } catch (err) { console.error('[Recovery] Startup recovery failed (continuing):', err.message) }
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port
      resolve({ server, port: actualPort, url: `http://127.0.0.1:${actualPort}`, recovery, close: () => new Promise((done) => server.close(done)) })
    })
  })
}
