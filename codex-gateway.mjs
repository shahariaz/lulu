#!/usr/bin/env node
// Codex / ChatGPT Plus Gateway for Claude Code & Claude-Zen
// Exposes Anthropic Messages API on :8789 with multi-account failover,
// automatic rate-limit cooldown management, SQLite metrics & Web Dashboard.

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { getDb, recordRequest, getStats, getRecentRequests, getRateLimitEvents } from './lib/db.mjs'
import { codexAccountManager } from './lib/codex-accounts.mjs'
import { antigravityAccountManager } from './lib/antigravity-accounts.mjs'
import { zenAccountManager } from './lib/zen-accounts.mjs'
import { qwenAccountManager } from './lib/qwen-accounts.mjs'
import { codexAppServerBridge } from './lib/codex-app-server.mjs'
import { codexLoginManager } from './lib/codex-login.mjs'
import { antigravityLoginManager } from './lib/antigravity-login.mjs'
import {
  VIRTUAL_MODELS,
  getRoutingProfiles,
  refreshRoutingCatalog,
  removeRoutingProfile,
  routingModelMetadata,
  saveRoutingProfile,
  setActiveRoutingProfile,
} from './lib/routing-profiles.mjs'
import {
  codexAnthropicModels,
  getCodexModels,
  mergeCodexModels,
  parseCodexModelSelection,
  saveCodexModels,
} from './lib/codex-models.mjs'
import { estimateInputTokens, estimateOutputTokens } from './lib/anthropic-codex.mjs'
import { AnthropicSseWriter } from './lib/anthropic-sse.mjs'
import { renderDashboardHtml } from './lib/ui.mjs'

const PORT = Number(process.env.CODEX_PORT || process.env.PORT || 8789)
const DEBUG = process.env.CODEX_DEBUG === '1'
const RATE_LIMIT_REFRESH_MS = Number(process.env.CODEX_RATE_LIMIT_REFRESH_MS || 60_000)
let rateLimitRefresh = null
let lastRateLimitRefresh = 0
const MODEL_REFRESH_MS = Number(process.env.CODEX_MODEL_REFRESH_MS || 300_000)
let modelRefresh = null
let lastModelRefresh = 0

async function refreshCodexRateLimits({ force = false } = {}) {
  if (rateLimitRefresh) return rateLimitRefresh
  if (!force && Date.now() - lastRateLimitRefresh < RATE_LIMIT_REFRESH_MS) return
  rateLimitRefresh = (async () => {
    const accounts = [...codexAccountManager.accounts]
    await Promise.allSettled(accounts.map(async (account) => {
      try {
        const snapshot = await codexAppServerBridge.readRateLimits(account)
        codexAccountManager.applyRateLimitSnapshot(account.id, snapshot)
      } catch (error) {
        if (DEBUG) console.error(`[CodexGateway] Rate-limit probe failed for ${account.email}:`, error.message)
      }
    }))
    lastRateLimitRefresh = Date.now()
  })().finally(() => { rateLimitRefresh = null })
  return rateLimitRefresh
}

async function refreshCodexModelCatalog({ force = false } = {}) {
  if (modelRefresh) return modelRefresh
  if (!force && Date.now() - lastModelRefresh < MODEL_REFRESH_MS) return getCodexModels()
  modelRefresh = (async () => {
    const catalogs = []
    await Promise.allSettled([...codexAccountManager.accounts].map(async (account) => {
      const models = await codexAppServerBridge.listModels(account)
      codexAccountManager.setAccountModels(account.id, models)
      catalogs.push(models)
    }))
    const merged = mergeCodexModels(catalogs)
    if (merged.length) saveCodexModels(merged)
    refreshRoutingCatalog()
    lastModelRefresh = Date.now()
    return getCodexModels()
  })().finally(() => { modelRefresh = null })
  return modelRefresh
}

const anthropicModels = () => codexAnthropicModels()

const MAX_BODY_BYTES = Number(process.env.CODEX_MAX_BODY_BYTES || 32 * 1024 * 1024)
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = ''
    let bytes = 0
    let tooLarge = false
    req.on('data', (c) => {
      bytes += c.length
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true
        return
      }
      d += c
    })
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`)
        error.statusCode = 413
        reject(error)
      } else {
        resolve(d)
      }
    })
    req.on('error', reject)
  })

function resultContent(result) {
  const content = []
  if (result.text) content.push({ type: 'text', text: result.text })
  for (const call of result.toolCalls || []) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input || {} })
  }
  if (!content.length) content.push({ type: 'text', text: '' })
  return content
}

function isRateLimitError(err) {
  const details = `${err?.message || ''} ${JSON.stringify(err?.codexErrorInfo || '')}`.toLowerCase()
  return details.includes('usage limit') || details.includes('usagelimit') ||
    details.includes('429') || details.includes('rate_limit') || details.includes('quota')
}

/**
 * Executes a turn with automatic multi-account rotation on rate limits
 */
async function executeCodexTurn(body, res) {
  const startTime = Date.now()
  let retryCount = 0
  const requestedModel = body.model || 'gpt-5.6-sol'
  const initialSelection = parseCodexModelSelection(requestedModel)
  if (!initialSelection) {
    const error = new Error(`Model is not available for this ChatGPT account: ${requestedModel}`)
    error.statusCode = 400
    recordRequest({
      provider: 'codex',
      model: requestedModel,
      inputTokens: estimateInputTokens(body),
      durationMs: Date.now() - startTime,
      status: 'error',
      errorMessage: error.message,
      reasoningEffort: body.claude_zen?.reasoning_effort || body.output_config?.effort || body.effort || null,
    })
    throw error
  }
  const requestedEffort = body.claude_zen?.reasoning_effort || body.output_config?.effort || body.effort || initialSelection.effort
  const selection = parseCodexModelSelection(`${initialSelection.model}@${requestedEffort}`)
  const model = selection.model
  const selectedModel = `${selection.model}@${selection.effort}`
  body.model = model
  body.claude_zen = { ...(body.claude_zen || {}), reasoning_effort: selection.effort }
  const maxRetries = Math.max(1, codexAccountManager.getAvailableAccounts(model).length)
  const isStream = !!body.stream
  const stream = isStream
    ? new AnthropicSseWriter(res, { model: selectedModel, inputTokens: estimateInputTokens(body) })
    : null

  while (retryCount < maxRetries) {
    const continuationAccount = codexAppServerBridge.continuationAccount(body)
    const turnSelection = continuationAccount
      ? { account: continuationAccount, error: null }
      : await codexAccountManager.getAccountForTurn(model)
    if (!turnSelection.account) {
      recordRequest({
        provider: 'codex',
        model: selectedModel,
        inputTokens: estimateInputTokens(body),
        durationMs: Date.now() - startTime,
        status: 'rate_limited',
        errorMessage: turnSelection.error || 'All ChatGPT Plus accounts are rate-limited.',
        reasoningEffort: selection.effort,
      })
      res.writeHead(429, { 'Content-Type': 'application/json' })
      return res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: turnSelection.error || 'All ChatGPT Plus accounts are rate-limited.',
          },
        }),
      )
    }

    const account = turnSelection.account
    try {
      const result = await codexAppServerBridge.execute(body, account, {
        streamHandlers: stream ? {
          onTextDelta: (delta) => stream.textDelta(delta),
          onToolCalls: (calls) => stream.toolCalls(calls),
        } : null,
      })
      const inputTokens = result.usage?.inputTokens || estimateInputTokens(body)
      const outputTokens = result.usage?.outputTokens || estimateOutputTokens(result)

      const durationMs = Date.now() - startTime
      recordRequest({
        provider: 'codex',
        model: selectedModel,
        accountEmail: account.email,
        inputTokens,
        outputTokens,
        durationMs,
        status: 'success',
        toolsCalled: result.toolCalls,
        reasoningEffort: selection.effort,
        stopReason: result.type === 'tool_use' ? 'tool_use' : 'end_turn',
      })

      if (isStream) {
        stream.finish({
          stopReason: result.type === 'tool_use' ? 'tool_use' : 'end_turn',
          inputTokens,
          outputTokens,
          toolCalls: result.toolCalls,
        })
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'msg_' + randomUUID().slice(0, 16),
        type: 'message',
        role: 'assistant',
        model: selectedModel,
        content: resultContent(result),
        stop_reason: result.type === 'tool_use' ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      }))
    } catch (err) {
      const errMsg = err.message || ''

      if (isRateLimitError(err)) {
        console.warn(`[CodexGateway] Rate limit hit for account: ${account.email}. Rotating...`)
        codexAccountManager.markRateLimited(account.email, 3600000, 'Usage limit reached', model)
        recordRequest({
          provider: 'codex',
          model: selectedModel,
          accountEmail: account.email,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: Date.now() - startTime,
          status: 'rate_limited',
          errorMessage: errMsg,
          reasoningEffort: selection.effort,
        })
        if (stream?.started) {
          stream.fail(errMsg, 'rate_limit_error')
          return
        }
        retryCount++
        continue // Auto-failover to next account!
      }

      console.error('[CodexGateway] Turn execution error:', err)
      recordRequest({
        provider: 'codex',
        model: selectedModel,
        accountEmail: account.email,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - startTime,
        status: 'error',
        errorMessage: errMsg,
        reasoningEffort: selection.effort,
      })

      if (stream?.fail(errMsg)) return
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: errMsg },
          }),
        )
      }
      return
    }
  }

  if (!res.headersSent) {
    res.writeHead(429, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'All available accounts reached their rate limit during this turn.',
        },
      }),
    )
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  // The dashboard is local-only. Do not let arbitrary websites initiate OAuth
  // sessions or mutate accounts/profiles through a browser.
  const origin = req.headers.origin
  const allowedOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])
  if (origin && !allowedOrigins.has(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: 'Origin not allowed' }))
  }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // Dashboard Web UI
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(renderDashboardHtml())
  }

  // Health
  if (url.pathname === '/health') {
    const accounts = codexAccountManager.listAccounts()
    const available = codexAccountManager.getAvailableAccounts()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(
      JSON.stringify({
        status: 'ok',
        provider: 'codex',
        accounts: accounts.length,
        available: available.length,
      }),
    )
  }

  // Anthropic Models Catalog
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    void refreshCodexModelCatalog()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(
      JSON.stringify({
        data: anthropicModels(),
        has_more: false,
        first_id: anthropicModels()[0]?.id || null,
        last_id: anthropicModels().at(-1)?.id || null,
      }),
    )
  }

  // Count Tokens
  if (url.pathname.endsWith('/count_tokens')) {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw || '{}')
      const chars = JSON.stringify(body.messages || []).length + JSON.stringify(body.system || '').length
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ input_tokens: Math.ceil(chars / 4) }))
    } catch (error) {
      res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: error.message }))
    }
  }

  // Anthropic Messages API
  if (req.method === 'POST' && url.pathname.includes('/messages')) {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw)
      return await executeCodexTurn(body, res)
    } catch (err) {
      console.error('[CodexGateway] Error processing message:', err)
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } }))
      }
    }
  }

  // REST API: Stats (with enhanced metrics & pool overview)
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const stats = getStats()
    const pool = codexAccountManager.getPoolOverview()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ...stats, pool }))
  }

  // REST API: Pool Overview
  if (req.method === 'GET' && url.pathname === '/api/pool') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(codexAccountManager.getPoolOverview()))
  }

  // REST API: Accounts List
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    void refreshCodexRateLimits()
    void antigravityAccountManager.refreshQuotaSnapshots()
    const accounts = codexAccountManager.listAccounts()
      .filter((account) => account.provider !== 'antigravity')
    accounts.push(...antigravityAccountManager.listAccounts())
    accounts.push(...qwenAccountManager.loadAccounts().map((acc) => ({
      id: acc.id,
      provider: 'qwen',
      email: acc.email,
      name: acc.name,
      plan_type: 'web',
      status: acc.rateLimitedUntil && acc.rateLimitedUntil > Date.now() ? 'rate_limited' : 'active',
      rate_limited_until: acc.rateLimitedUntil,
      rate_limit_reason: acc.rateLimitReason,
      last_used: acc.lastUsed,
      created_at: acc.createdAt,
    })))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(accounts))
  }

  // REST API: Add Account
  if (req.method === 'POST' && url.pathname === '/api/accounts') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw || '{}')
      let result
      if (body.provider === 'qwen' || body.qwenToken || (body.accessToken && String(body.accessToken).startsWith('eyJ') && !body.id_token && !body.refreshToken && !body.refresh_token)) {
        result = qwenAccountManager.saveAccount({
          token: body.qwenToken || body.accessToken || body.access_token || body.token,
          email: body.email,
          name: body.name,
        })
      } else if (body.provider === 'zen' || (body.apiKey && String(body.apiKey).startsWith('sk-')) || (body.accessToken && String(body.accessToken).startsWith('sk-') && !body.refreshToken && !body.id_token)) {
        result = zenAccountManager.addAccountFromApiKey({
          apiKey: body.apiKey || body.accessToken || body.access_token,
          email: body.email,
          name: body.name,
          planType: body.planType || body.plan_type,
        })
      } else if (body.provider === 'antigravity' || body.refreshToken || body.refresh_token) {
        result = await antigravityAccountManager.addAccountFromRefreshToken({
          refreshToken: body.refreshToken || body.refresh_token || body.tokens?.refresh_token || body.accessToken || body.access_token,
          email: body.email,
          projectId: body.projectId || body.project_id,
        })
        await codexAccountManager.syncAntigravityAccountsToDb()
      } else {
        result = codexAccountManager.addAccountFromTokens(body)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: error.message }))
    }
  }

  // REST API: Start a first-party OAuth login
  if (req.method === 'POST' && url.pathname === '/api/accounts/login') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      let session
      if (body.provider === 'antigravity' || body.method === 'google') {
        session = await antigravityLoginManager.start()
      } else {
        session = await codexLoginManager.start(body.method || 'browser')
      }
      res.writeHead(202, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(session))
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: error.message }))
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/accounts/login/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/accounts/login/'.length))
    const session = antigravityLoginManager.get(id) || codexLoginManager.get(id)
    res.writeHead(session ? 200 : 404, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(session || { error: 'Login session not found' }))
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/accounts/login/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/accounts/login/'.length))
    const success = (await antigravityLoginManager.cancel(id)) || (await codexLoginManager.cancel(id))
    res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ success }))
  }

  if (req.method === 'POST' && url.pathname === '/api/accounts/import-local') {
    try {
      const account = await codexAccountManager.importCurrentCodexLogin()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(account))
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: error.message }))
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/accounts/import-antigravity') {
    try {
      const result = await antigravityAccountManager.importLocalAccounts()
      await codexAccountManager.syncAntigravityAccountsToDb()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: error.message }))
    }
  }

  // REST API: Sync / Probe Accounts
  if (req.method === 'POST' && url.pathname === '/api/accounts/sync') {
    await codexAccountManager.autoImportLocalCodexAuth()
    await codexAccountManager.syncAntigravityAccountsToDb()
    await zenAccountManager.autoImportExistingAccounts()
    zenAccountManager.reloadFromDb()
    codexAccountManager.reloadFromDb()
    await refreshCodexModelCatalog({ force: true })
    await refreshCodexRateLimits({ force: true })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok', accounts: codexAccountManager.listAccounts() }))
  }

  // REST API: Set Active Account
  if (req.method === 'POST' && url.pathname === '/api/accounts/set-active') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw || '{}')
      const target = body.id || body.email

      // Try codex / zen managers (in-process)
      let success = codexAccountManager.setActiveAccount(target) ||
        zenAccountManager.setActiveAccount(target)

      // For antigravity accounts, also forward to the antigravity gateway process
      // so its in-process account manager is updated immediately (cross-process fix)
      const agwPort = Number(process.env.ANTIGRAVITY_PORT || 8788)
      try {
        const agwRes = await fetch(`http://127.0.0.1:${agwPort}/api/accounts/set-active`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: target, email: target }),
        })
        if (agwRes.ok) {
          const agwJson = await agwRes.json()
          if (agwJson.success) {
            // Also update local copy for display
            antigravityAccountManager.setActiveAccount(target)
            success = true
          }
        }
      } catch {
        // Antigravity gateway may not be running — fall back to local-only
        if (antigravityAccountManager.setActiveAccount(target)) success = true
      }

      res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ success }))
    } catch (error) {
      res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: error.message }))
    }
  }

  // REST API: Test Account Connection
  if (req.method === 'POST' && url.pathname === '/api/accounts/test') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const targetId = body.id || body.email
      if (!targetId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Account ID or email required' }))
      }
      const result = await codexAccountManager.testAccount(targetId, body.model)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ success: false, error: error.message }))
    }
  }

  // REST API: Delete Account
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/accounts/')) {
    const id = decodeURIComponent(url.pathname.replace('/api/accounts/', ''))
    const success = codexAccountManager.removeAccount(id) || qwenAccountManager.deleteAccount(id)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ success }))
  }

  // REST API: Reset Rate Limits
  if (req.method === 'POST' && url.pathname === '/api/accounts/reset-limits') {
    codexAccountManager.resetAllLimits()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok', message: 'Rate limits cleared' }))
  }

  // REST API: live routing profiles. The Zen proxy reads the same SQLite DB,
  // so activation affects the next request without restarting Claude Code.
  if (req.method === 'GET' && url.pathname === '/api/routing') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      virtualModels: VIRTUAL_MODELS,
      catalog: refreshRoutingCatalog(),
      modelMetadata: routingModelMetadata(),
      profiles: getRoutingProfiles(),
    }))
  }

  if (req.method === 'POST' && url.pathname === '/api/routing/profiles') {
    try {
      const profile = saveRoutingProfile(JSON.parse((await readBody(req)) || '{}'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(profile))
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: error.message }))
    }
  }

  const activateMatch = url.pathname.match(/^\/api\/routing\/profiles\/([^/]+)\/activate$/)
  if (req.method === 'POST' && activateMatch) {
    try {
      const profile = setActiveRoutingProfile(decodeURIComponent(activateMatch[1]))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(profile))
    } catch (error) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: error.message }))
    }
  }

  const profileMatch = url.pathname.match(/^\/api\/routing\/profiles\/([^/]+)$/)
  if (req.method === 'DELETE' && profileMatch) {
    try {
      const success = removeRoutingProfile(decodeURIComponent(profileMatch[1]))
      res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ success }))
    } catch (error) {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: error.message }))
    }
  }

  // REST API: Rate Limit Incidents Log
  if (req.method === 'GET' && url.pathname === '/api/rate-limits') {
    const limit = Number(url.searchParams.get('limit')) || 30
    const events = getRateLimitEvents(limit)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(events))
  }

  // REST API: Recent Requests (with search, status, provider filters and cursor-based pagination)
  if (req.method === 'GET' && url.pathname === '/api/requests') {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 25))
    const provider = url.searchParams.get('provider')
    const model = url.searchParams.get('model')
    const status = url.searchParams.get('status')
    const search = url.searchParams.get('search')
    const cursor = url.searchParams.get('cursor')
    const direction = url.searchParams.get('direction') || 'next'

    const reqs = getRecentRequests({
      limit,
      provider,
      model,
      status,
      search,
      cursor,
      direction,
      paginate: true,
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(reqs))
  }

  // REST API: Export Data
  if (req.method === 'GET' && url.pathname === '/api/export') {
    const format = url.searchParams.get('format') || 'json'
    const requests = getRecentRequests({ limit: 500 })
    const stats = getStats()

    if (format === 'csv') {
      const header = 'id,timestamp,iso_time,provider,model,account_email,input_tokens,output_tokens,total_tokens,reasoning_effort,reasoning_tokens,tools_called,stop_reason,duration_ms,status,error_message\n'
      const rows = requests.map((r) => [
        `"${r.id}"`,
        r.timestamp,
        `"${new Date(r.timestamp).toISOString()}"`,
        `"${r.provider}"`,
        `"${r.model}"`,
        `"${(r.account_email || '').replace(/"/g, '""')}"`,
        r.input_tokens || 0,
        r.output_tokens || 0,
        r.total_tokens || 0,
        `"${(r.reasoning_effort || '').replace(/"/g, '""')}"`,
        r.reasoning_tokens || 0,
        `"${JSON.stringify(r.tools_called || []).replace(/"/g, '""')}"`,
        `"${(r.stop_reason || '').replace(/"/g, '""')}"`,
        r.duration_ms || 0,
        `"${r.status}"`,
        `"${(r.error_message || '').replace(/"/g, '""')}"`,
      ].join(',')).join('\n')

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="claude-zen-requests.csv"',
      })
      return res.end(header + rows)
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="claude-zen-metrics.json"',
    })
    return res.end(JSON.stringify({ stats, requests }, null, 2))
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }))
})

// Initialize DB and Accounts on boot
getDb()
await codexAccountManager.init()
await refreshCodexModelCatalog({ force: true })
await refreshCodexRateLimits({ force: true })
const rateLimitTimer = setInterval(() => void refreshCodexRateLimits(), RATE_LIMIT_REFRESH_MS)
rateLimitTimer.unref?.()
const modelTimer = setInterval(() => void refreshCodexModelCatalog(), MODEL_REFRESH_MS)
modelTimer.unref?.()

server.listen(PORT, '127.0.0.1', () => {
  console.error(`Codex Gateway running on http://127.0.0.1:${PORT}`)
  console.error(`Dashboard available at http://127.0.0.1:${PORT}/dashboard`)
})

function shutdown() {
  clearInterval(rateLimitTimer)
  clearInterval(modelTimer)
  codexAppServerBridge.close()
  server.close(() => process.exit(0))
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
