#!/usr/bin/env node
// Antigravity (Google Cloud Code / Gemini 3.8 / Claude Opus & Sonnet 4.6) Gateway
// Exposes Anthropic Messages API on :8788 with multi-account failover,
// automatic rate-limit cooldown management, SQLite metrics & token tracking.

import http from 'node:http'
import { getDb, recordRequest } from './lib/db.mjs'
import { antigravityAccountManager } from './lib/antigravity-accounts.mjs'
import { antigravityClient } from './lib/antigravity-client.mjs'
import {
  antigravityAnthropicModels,
  findAntigravityModel,
  normalizeAntigravityModel,
} from './lib/antigravity-models.mjs'
import { estimateTokens, reasoningEffortFor } from './lib/activity.mjs'
import { budgetAnthropicRequest, DEFAULT_ANTIGRAVITY_MAX_INPUT_CHARS } from './lib/input-budget.mjs'

const PORT = Number(process.env.ANTIGRAVITY_PORT || process.env.PORT || 8788)
const MAX_BODY_BYTES = Number(process.env.ANTIGRAVITY_MAX_BODY_BYTES || 32 * 1024 * 1024)
const MAX_INPUT_CHARS = Number(process.env.ANTIGRAVITY_MAX_INPUT_CHARS || DEFAULT_ANTIGRAVITY_MAX_INPUT_CHARS)

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = ''
    let bytes = 0
    req.on('data', (c) => {
      bytes += c.length
      if (bytes > MAX_BODY_BYTES) {
        // Destroy the stream immediately so the socket isn't held open
        req.destroy()
        const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`)
        error.statusCode = 413
        reject(error)
        return
      }
      d += c
    })
    req.on('end', () => resolve(d))
    req.on('error', reject)
  })

const sse = (res, event, data) =>
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

async function executeTurn(body, req, res) {
  const startTime = Date.now()
  const requestedModel = body.model || 'gemini-3.8-flash-tiered'
  const modelMeta = findAntigravityModel(requestedModel)
  const normalizedModel = modelMeta?.model || normalizeAntigravityModel(requestedModel) || requestedModel

  const isStream = !!body.stream
  let selectedAccountEmail = null

  // Create an AbortController tied to the client connection.
  // When Claude Code closes the socket (Escape, timeout, session end),
  // the signal fires and we cancel the upstream Google request immediately.
  const ac = new AbortController()
  const { signal } = ac

  const onClientClose = () => {
    if (!signal.aborted) {
      ac.abort(new Error('Client disconnected'))
    }
  }
  req.on('close', onClientClose)

  const cleanup = () => req.removeListener('close', onClientClose)

  try {
    const result = await antigravityClient.executeTurn(body, {
      onAccountSelected: (email) => {
        selectedAccountEmail = email
        if (!res.headersSent) {
          res.setHeader('X-Account-Email', email)
        }
      },
      signal,
    })

    if (result.type === 'stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Account-Email': result.accountEmail || selectedAccountEmail || 'antigravity-pool',
      })

      let inputTokens = 0
      let outputTokens = 0
      let reasoningTokens = 0
      let stopReason = null
      const toolsCalled = []

      for await (const event of result.generator) {
        // Stop writing if the client is gone
        if (signal.aborted || res.destroyed) break

        if (event.type === 'message_start') {
          inputTokens = event.message?.usage?.input_tokens || inputTokens
        } else if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            toolsCalled.push({
              id: event.content_block.id || null,
              name: event.content_block.name || 'unknown',
            })
          }
        } else if (event.type === 'message_delta') {
          outputTokens = event.usage?.output_tokens || outputTokens
          reasoningTokens = event.usage?.reasoning_tokens || reasoningTokens
          stopReason = event.delta?.stop_reason || stopReason
        }

        // Only write if the socket is still open
        if (!res.destroyed) {
          sse(res, event.type, event)
        }
      }

      if (!res.destroyed) res.end()

      // Only record if the turn actually completed (not aborted mid-stream)
      if (!signal.aborted) {
        recordRequest({
          provider: 'antigravity',
          model: normalizedModel,
          accountEmail: result.accountEmail || selectedAccountEmail,
          inputTokens: inputTokens || estimateTokens(body),
          outputTokens: outputTokens || 0,
          reasoningTokens: reasoningTokens || 0,
          reasoningEffort: reasoningEffortFor(body),
          durationMs: Date.now() - startTime,
          status: 'success',
          toolsCalled,
          stopReason,
        })
      }
      return
    }

    // Non-streaming JSON response
    const jsonResponse = result.data
    const inputTokens = jsonResponse.usage?.input_tokens || estimateTokens(body)
    const outputTokens = jsonResponse.usage?.output_tokens || 0
    const reasoningTokens = jsonResponse.usage?.reasoning_tokens || 0
    const toolsCalled = (jsonResponse.content || [])
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name }))

    recordRequest({
      provider: 'antigravity',
      model: normalizedModel,
      accountEmail: result.accountEmail || selectedAccountEmail,
      inputTokens,
      outputTokens,
      reasoningTokens,
      reasoningEffort: reasoningEffortFor(body),
      durationMs: Date.now() - startTime,
      status: 'success',
      toolsCalled,
      stopReason: jsonResponse.stop_reason || 'end_turn',
    })

    if (!res.headersSent && !res.destroyed) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Account-Email': result.accountEmail || selectedAccountEmail || 'antigravity-pool',
      })
      res.end(JSON.stringify(jsonResponse))
    }
  } catch (err) {
    // 499 = client disconnected — don't log as an error, just clean up
    if (err.statusCode === 499 || signal.aborted) {
      console.warn(`[AntigravityGateway] Client disconnected for model=${normalizedModel}`)
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(499, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'client_disconnect', message: 'Client disconnected' } }))
      }
      return
    }

    const durationMs = Date.now() - startTime
    const statusCode = err.statusCode || 500
    const isRateLimit = statusCode === 429 || /rate.?limit|quota/i.test(err.message)

    recordRequest({
      provider: 'antigravity',
      model: normalizedModel,
      accountEmail: selectedAccountEmail,
      inputTokens: estimateTokens(body),
      outputTokens: 0,
      durationMs,
      status: isRateLimit ? 'rate_limited' : 'error',
      errorMessage: err.message,
      reasoningEffort: reasoningEffortFor(body),
    })

    if (!res.headersSent && !res.destroyed) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: isRateLimit ? 'rate_limit_error' : 'api_error',
          message: err.message,
        },
      }))
    }
  } finally {
    cleanup()
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')

  // CORS headers — only allow requests from the local dashboard / localhost
  const origin = req.headers.origin
  const allowedOrigins = new Set([
    'http://127.0.0.1:8789', 'http://localhost:8789',
    'http://127.0.0.1:8788', 'http://localhost:8788',
    'http://127.0.0.1:8787', 'http://localhost:8787',
  ])
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  // Health
  if (url.pathname === '/health') {
    const accounts = antigravityAccountManager.listAccounts()
    const available = antigravityAccountManager.getAvailableAccounts()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      status: 'ok',
      provider: 'antigravity',
      accounts: accounts.length,
      available: available.length,
    }))
  }

  // Model catalog
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      data: antigravityAnthropicModels(),
      has_more: false,
      first_id: 'gemini-3.8-flash-tiered',
      last_id: 'claude-sonnet-4-6',
    }))
  }

  // Count tokens
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

  // Anthropic Messages API — exact suffix match to avoid catching /api/accounts/messages etc.
  if (req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname.endsWith('/v1/messages'))) {
    try {
      const raw = await readBody(req)
      const parsed = JSON.parse(raw)
      const budgeted = budgetAnthropicRequest(parsed, { maxChars: MAX_INPUT_CHARS })
      if (budgeted.truncated) {
        console.warn(`[AntigravityGateway] Input reduced from ${budgeted.originalChars} to ${budgeted.finalChars} characters`)
      }
      return await executeTurn(budgeted.body, req, res)
    } catch (err) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } }))
      }
    }
  }

  // REST API: Accounts list
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    await antigravityAccountManager.refreshQuotaSnapshots()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(antigravityAccountManager.listAccounts()))
  }

  // REST API: Add account from refresh token
  if (req.method === 'POST' && url.pathname === '/api/accounts') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw || '{}')
      const result = await antigravityAccountManager.addAccountFromRefreshToken(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: error.message }))
    }
  }

  // REST API: Reset rate limits
  if (req.method === 'POST' && url.pathname === '/api/accounts/reset-limits') {
    antigravityAccountManager.resetAllLimits()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ status: 'ok', message: 'Antigravity rate limits cleared' }))
  }

  // REST API: Set active account
  if (req.method === 'POST' && url.pathname === '/api/accounts/set-active') {
    try {
      const raw = await readBody(req)
      const body = JSON.parse(raw || '{}')
      const success = antigravityAccountManager.setActiveAccount(body.id || body.email)
      res.writeHead(success ? 200 : 404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ success }))
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: error.message }))
    }
  }

  // REST API: Delete account
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/accounts/')) {
    const id = decodeURIComponent(url.pathname.replace('/api/accounts/', ''))
    const success = antigravityAccountManager.removeAccount(id)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ success }))
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }))
})

// Initialize DB and Accounts on boot
getDb()
await antigravityAccountManager.init()

server.listen(PORT, '127.0.0.1', () => {
  console.error(`Antigravity Gateway running on http://127.0.0.1:${PORT}`)
})

function shutdown() {
  server.close(() => process.exit(0))
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
