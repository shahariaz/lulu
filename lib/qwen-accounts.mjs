import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {
  getAccounts,
  upsertAccount,
  deleteAccount as dbDeleteAccount,
  updateAccountTokens,
  markAccountRateLimited,
  clearRateLimits,
  touchAccountLastUsed,
  updateAccountRateLimitState,
  getAccountModelRateLimits,
  markAccountModelRateLimited,
} from './db.mjs'

const QWEN_AUTH_DIR = path.join(os.homedir(), '.zen-claude')
const QWEN_AUTH_FILE = path.join(QWEN_AUTH_DIR, 'qwen-auth.json')
const QWEN_LEGACY_DIR = path.join(os.homedir(), '.qwen')
const QWEN_LEGACY_FILE = path.join(QWEN_LEGACY_DIR, 'oauth_creds.json')

export const QWEN_MODELS = Object.freeze([
  'qwen3.7-plus',
  'qwen3.8-max',
  'qwen3.7-max',
  'qwen3.6-plus',
  'qwen3.5-plus',
  'qwen-deep-research',
  'qwen-web-dev',
  'qwen-full-stack',
  'qwen-slides',
])

export const DEFAULT_QWEN_MODEL = 'qwen3.7-plus'

export function maskToken(token) {
  if (!token || typeof token !== 'string') return '••••'
  if (token.length <= 16) return '••••'
  return `${token.slice(0, 8)}••••${token.slice(-6)}`
}

export function parseJwtPayload(token) {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const raw = Buffer.from(parts[1], 'base64url').toString('utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export class QwenAccountManager {
  constructor({
    authFile = QWEN_AUTH_FILE,
    legacyFile = QWEN_LEGACY_FILE,
  } = {}) {
    this.authFile = authFile
    this.legacyFile = legacyFile
    this.accounts = []
    this.stickyAccountByModel = new Map()
    this.currentIndex = 0
    this.initialized = false
  }

  init() {
    this.loadAccounts()
    this.initialized = true
    return this.accounts
  }

  loadAccounts() {
    const dbAccounts = getAccounts('qwen') || []
    const accountsMap = new Map()

    for (const acc of dbAccounts) {
      accountsMap.set(acc.email, {
        id: acc.id,
        email: acc.email,
        name: acc.name || 'Qwen User',
        accessToken: acc.access_token,
        refreshToken: acc.refresh_token,
        expiresAt: acc.expires_at,
        status: acc.status || 'active',
        rateLimitedUntil: acc.rate_limited_until,
        rateLimitReason: acc.rate_limit_reason,
        lastUsed: acc.last_used,
        createdAt: acc.created_at,
      })
    }

    // Check configured auth file
    if (this.authFile && fs.existsSync(this.authFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.authFile, 'utf8'))
        const list = Array.isArray(data) ? data : [data]
        for (const item of list) {
          if (!item?.token && !item?.accessToken && !item?.access_token) continue
          const token = item.token || item.accessToken || item.access_token
          const payload = parseJwtPayload(token)
          const email = item.email || payload?.email || payload?.id || 'qwen-user@chat.qwen.ai'
          if (!accountsMap.has(email)) {
            const acc = {
              id: item.id || `qwen_${crypto.randomUUID()}`,
              email,
              name: item.name || payload?.name || 'Qwen Web User',
              accessToken: token,
              refreshToken: item.refreshToken || item.refresh_token || null,
              expiresAt: item.expiresAt || (payload?.exp ? payload.exp * 1000 : null),
              status: 'active',
              createdAt: Date.now(),
            }
            accountsMap.set(email, acc)
            this.persistToDb(acc)
          }
        }
      } catch (err) {
        console.error('[QwenAccounts] Failed reading auth file:', err.message)
      }
    }

    // Check legacy oauth file
    if (this.legacyFile && fs.existsSync(this.legacyFile)) {
      try {
        const item = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'))
        const token = item.access_token || item.token
        if (token) {
          const payload = parseJwtPayload(token)
          const email = item.email || payload?.email || payload?.id || 'qwen-oauth@chat.qwen.ai'
          if (!accountsMap.has(email)) {
            const acc = {
              id: `qwen_${crypto.randomUUID()}`,
              email,
              name: 'Qwen OAuth User',
              accessToken: token,
              refreshToken: item.refresh_token || null,
              expiresAt: item.expiry_date || (payload?.exp ? payload.exp * 1000 : null),
              status: 'active',
              createdAt: Date.now(),
            }
            accountsMap.set(email, acc)
            this.persistToDb(acc)
          }
        }
      } catch (err) {
        console.error('[QwenAccounts] Failed reading legacy auth file:', err.message)
      }
    }

    // Check env QWEN_ACCESS_TOKEN / QWEN_TOKEN
    const envToken = process.env.QWEN_ACCESS_TOKEN || process.env.QWEN_TOKEN
    if (envToken && !accountsMap.has('qwen-env@chat.qwen.ai')) {
      const payload = parseJwtPayload(envToken)
      const email = payload?.email || payload?.id || 'qwen-env@chat.qwen.ai'
      if (!accountsMap.has(email)) {
        const acc = {
          id: `qwen_${crypto.randomUUID()}`,
          email,
          name: 'Qwen Environment User',
          accessToken: envToken,
          refreshToken: null,
          expiresAt: payload?.exp ? payload.exp * 1000 : null,
          status: 'active',
          createdAt: Date.now(),
        }
        accountsMap.set(email, acc)
        this.persistToDb(acc)
      }
    }

    this.accounts = Array.from(accountsMap.values())
    return this.accounts
  }

  persistToDb(acc) {
    try {
      upsertAccount({
        id: acc.id,
        provider: 'qwen',
        email: acc.email,
        name: acc.name,
        account_id: acc.email,
        accountId: acc.email,
        plan_type: 'web',
        planType: 'web',
        access_token: acc.accessToken,
        accessToken: acc.accessToken,
        refresh_token: acc.refreshToken,
        refreshToken: acc.refreshToken,
        expires_at: acc.expiresAt,
        expiresAt: acc.expiresAt,
        status: acc.status || 'active',
        created_at: acc.createdAt || Date.now(),
        createdAt: acc.createdAt || Date.now(),
      })
    } catch (err) {
      console.error('[QwenAccounts] Failed upserting to db:', err.message)
    }
  }

  saveAccount({ token, email, name, refreshToken, expiresAt }) {
    if (!token) throw new Error('Token is required')
    const payload = parseJwtPayload(token)
    const effectiveEmail = email || payload?.email || payload?.id || `qwen-${Date.now()}@chat.qwen.ai`
    const effectiveName = name || payload?.name || 'Qwen User'
    const effectiveExpiresAt = expiresAt || (payload?.exp ? payload.exp * 1000 : null)

    const existing = this.accounts.find((a) => a.email === effectiveEmail)
    const account = {
      id: existing?.id || `qwen_${crypto.randomUUID()}`,
      email: effectiveEmail,
      name: effectiveName,
      accessToken: token,
      refreshToken: refreshToken || existing?.refreshToken || null,
      expiresAt: effectiveExpiresAt,
      status: 'active',
      rateLimitedUntil: null,
      rateLimitReason: null,
      lastUsed: Date.now(),
      createdAt: existing?.createdAt || Date.now(),
    }

    this.persistToDb(account)

    if (existing) {
      Object.assign(existing, account)
    } else {
      this.accounts.push(account)
    }

    this.persistToFile()
    return account
  }

  persistToFile() {
    if (!this.authFile) return
    try {
      const dir = path.dirname(this.authFile)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      }
      const data = this.accounts.map((a) => ({
        id: a.id,
        email: a.email,
        name: a.name,
        token: a.accessToken,
        refreshToken: a.refreshToken,
        expiresAt: a.expiresAt,
      }))
      fs.writeFileSync(this.authFile, JSON.stringify(data, null, 2), { mode: 0o600 })
    } catch (err) {
      console.error('[QwenAccounts] Failed writing auth file:', err.message)
    }
  }

  listAccounts() {
    const now = Date.now()
    return this.accounts.map((acc, idx) => {
      const isRateLimited = !!(acc.rateLimitedUntil && acc.rateLimitedUntil > now)
      return {
        id: acc.id,
        provider: 'qwen',
        index: idx + 1,
        email: acc.email,
        name: acc.name || 'Qwen User',
        plan_type: 'Qwen Chat (chat.qwen.ai)',
        status: isRateLimited ? 'rate_limited' : (acc.status || 'active'),
        cooldown_remaining_sec: isRateLimited ? Math.max(0, Math.ceil((acc.rateLimitedUntil - now) / 1000)) : 0,
        rate_limit_reason: isRateLimited ? (acc.rateLimitReason || 'Rate limited') : null,
        last_used: acc.lastUsed,
        created_at: acc.createdAt,
        key_preview: maskToken(acc.accessToken),
        is_current_active: idx === (this.currentIndex % Math.max(1, this.accounts.length)),
      }
    })
  }

  removeAccount(idOrEmail) {
    return this.deleteAccount(idOrEmail)
  }

  resetAllLimits() {
    this.clearRateLimits()
  }

  async testAccount(idOrEmail, model = DEFAULT_QWEN_MODEL) {
    if (!this.initialized) this.init()
    const target = this.accounts.find((a) => a.id === idOrEmail || a.email === idOrEmail)
    if (!target) throw new Error(`Account ${idOrEmail} not found`)

    const { qwenClient } = await import('./qwen-client.mjs')
    const start = Date.now()
    const result = await qwenClient.createChatCompletion({
      model,
      messages: [{ role: 'user', content: 'Say "Qwen connection verified!" in under 5 words.' }],
      stream: false,
      token: target.accessToken,
    })
    const durationMs = Date.now() - start
    const responseText = result?.choices?.[0]?.message?.content || 'OK'

    return {
      success: true,
      accountEmail: target.email,
      provider: 'qwen',
      model,
      durationMs,
      responseText,
    }
  }

  deleteAccount(idOrEmail) {
    const idx = this.accounts.findIndex((a) => a.id === idOrEmail || a.email === idOrEmail)
    if (idx === -1) return false
    const account = this.accounts[idx]
    this.accounts.splice(idx, 1)

    try {
      dbDeleteAccount(account.id)
    } catch (err) {
      console.error('[QwenAccounts] Failed deleting from db:', err.message)
    }

    this.persistToFile()
    return true
  }

  getAccount(idOrEmail) {
    return this.accounts.find((a) => a.id === idOrEmail || a.email === idOrEmail) || null
  }

  getNextAvailableAccount(model = null) {
    if (!this.initialized) this.init()
    if (!this.accounts.length) return null

    const now = Date.now()

    // 1. Check sticky account for this model
    if (model) {
      const stickyEmail = this.stickyAccountByModel.get(model)
      if (stickyEmail) {
        const stickyAcc = this.accounts.find((a) => a.email === stickyEmail)
        if (stickyAcc && (!stickyAcc.rateLimitedUntil || stickyAcc.rateLimitedUntil <= now)) {
          touchAccountLastUsed(stickyAcc.id)
          return stickyAcc
        }
      }
    }

    // 2. Rotate through active, non-rate-limited accounts
    const available = this.accounts.filter((a) => !a.rateLimitedUntil || a.rateLimitedUntil <= now)
    if (!available.length) return null

    this.currentIndex = (this.currentIndex + 1) % available.length
    const chosen = available[this.currentIndex]

    if (model) {
      this.stickyAccountByModel.set(model, chosen.email)
    }

    touchAccountLastUsed(chosen.id)
    return chosen
  }

  markRateLimited(email, cooldownMs = 60000, reason = 'Rate limited by Qwen') {
    const acc = this.accounts.find((a) => a.email === email)
    if (!acc) return
    const until = Date.now() + cooldownMs
    acc.rateLimitedUntil = until
    acc.rateLimitReason = reason
    try {
      markAccountRateLimited(acc.email, 'qwen', cooldownMs, reason)
    } catch (err) {
      console.error('[QwenAccounts] Failed marking rate limited in db:', err.message)
    }
  }

  clearRateLimits() {
    for (const acc of this.accounts) {
      acc.rateLimitedUntil = null
      acc.rateLimitReason = null
    }
    try {
      clearRateLimits('qwen')
    } catch (err) {
      console.error('[QwenAccounts] Failed clearing rate limits:', err.message)
    }
  }
}

export const qwenAccountManager = new QwenAccountManager()
