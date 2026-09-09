import crypto from 'node:crypto'
import {
  getAccounts,
  upsertAccount,
  deleteAccount as dbDeleteAccount,
  markAccountRateLimited,
  markAccountModelRateLimited,
  getAccountModelRateLimits,
  clearRateLimits,
  touchAccountLastUsed,
} from './db.mjs'

const PROVIDER = 'qwen-web'

export function maskCookie(cookie) {
  if (!cookie || typeof cookie !== 'string') return '••••'
  if (cookie.length <= 12) return '••••'
  return `${cookie.slice(0, 6)}••••${cookie.slice(-4)}`
}

export class QwenWebAccountManager {
  constructor() {
    this.accounts = []
    this.stickyAccountByModel = new Map()
    this.currentIndex = 0
    this.initialized = false
  }

  init() {
    this.reloadFromDb()
    this.initialized = true
    return this.accounts
  }

  reloadFromDb() {
    this.accounts = getAccounts(PROVIDER) || []
    return this.accounts
  }

  addAccountFromCookie({ cookie, email = null, name = null }) {
    if (!cookie || !String(cookie).trim()) {
      throw new Error('Cookie string is required')
    }
    const cleanCookie = String(cookie).trim()
    const digest = crypto.createHash('sha256').update(cleanCookie).digest('hex').slice(0, 8)
    const derivedEmail = (email && String(email).trim()) || `qwen-web-${digest}@chat.qwen.ai`
    const derivedName = (name && String(name).trim()) || `Qwen Web Account (${digest})`

    if (!this.initialized) this.init()
    const existing = this.accounts.find((a) => a.access_token === cleanCookie || a.email === derivedEmail)
    const id = existing?.id || `qwen_web_${crypto.randomUUID()}`

    upsertAccount({
      id,
      provider: PROVIDER,
      email: derivedEmail,
      name: derivedName,
      account_id: 'web',
      plan_type: 'web',
      access_token: cleanCookie,
      status: 'active',
      created_at: Date.now(),
    })
    this.reloadFromDb()
    return { id, email: derivedEmail, name: derivedName }
  }

  getAvailableAccounts(model = null) {
    if (!this.initialized) this.init()
    this.reloadFromDb()
    const now = Date.now()
    const modelLimitedEmails = model
      ? new Set(getAccountModelRateLimits(PROVIDER).filter((l) => l.model === model).map((l) => l.account_email))
      : new Set()

    return this.accounts.filter((a) => {
      if (a.status === 'invalid') return false
      if (a.rate_limited_until && a.rate_limited_until > now) return false
      if (modelLimitedEmails.has(a.email)) return false
      return Boolean(a.access_token)
    })
  }

  getShortestWaitMs(model = null) {
    const now = Date.now()
    let minWait = Infinity
    for (const a of this.accounts) {
      if (a.rate_limited_until && a.rate_limited_until > now) {
        minWait = Math.min(minWait, a.rate_limited_until - now)
      }
    }
    if (model) {
      for (const limit of getAccountModelRateLimits(PROVIDER)) {
        if (limit.model === model && limit.rate_limited_until > now) {
          minWait = Math.min(minWait, limit.rate_limited_until - now)
        }
      }
    }
    return minWait === Infinity ? 60000 : minWait
  }

  async getAccountForTurn(model = null) {
    if (!this.initialized) this.init()
    this.reloadFromDb()

    const available = this.getAvailableAccounts(model)
    if (available.length === 0) {
      const waitMs = this.getShortestWaitMs(model)
      return {
        account: null,
        cookie: null,
        waitMs,
        error:
          this.accounts.length === 0
            ? 'No Qwen Web accounts configured. Run `claude-zen --qwen-web-accounts add`.'
            : `All ${this.accounts.length} Qwen Web account(s) are currently cooling down / blocked. Earliest reset in ${Math.ceil(waitMs / 60000)} min.`,
      }
    }

    const stickyKey = model || 'default'
    let chosen = null
    const stickyEmail = this.stickyAccountByModel.get(stickyKey)
    if (stickyEmail) {
      chosen = available.find((a) => a.email === stickyEmail)
    }
    if (!chosen) {
      this.currentIndex = (this.currentIndex + 1) % available.length
      chosen = available[this.currentIndex]
      this.stickyAccountByModel.set(stickyKey, chosen.email)
    }

    touchAccountLastUsed(chosen.id)
    return { account: chosen, cookie: chosen.access_token, waitMs: 0, error: null }
  }

  markRateLimited(email, cooldownMs = 300000, reason = 'Qwen Web rate limit / WAF', model = null) {
    if (model) markAccountModelRateLimited(email, PROVIDER, model, cooldownMs, reason)
    else markAccountRateLimited(email, PROVIDER, cooldownMs, reason, model)
    this.reloadFromDb()

    // Unstick immediately so the next request rotates to a different account
    // instead of re-picking the one that just failed.
    for (const [key, stuckEmail] of this.stickyAccountByModel.entries()) {
      if (stuckEmail === email) this.stickyAccountByModel.delete(key)
    }
  }

  resetAllLimits() {
    clearRateLimits(PROVIDER)
    this.reloadFromDb()
  }

  removeAccount(idOrEmail) {
    const res = dbDeleteAccount(idOrEmail)
    this.reloadFromDb()
    return res
  }

  listAccounts() {
    this.reloadFromDb()
    const now = Date.now()
    const modelLimits = getAccountModelRateLimits(PROVIDER)

    return this.accounts.map((acc, idx) => {
      const isRateLimited = !!(acc.rate_limited_until && acc.rate_limited_until > now)
      const remainingSec = isRateLimited ? Math.max(0, Math.ceil((acc.rate_limited_until - now) / 1000)) : 0
      const limitsForAcc = modelLimits.filter((l) => l.account_email === acc.email)

      return {
        id: acc.id,
        provider: PROVIDER,
        index: idx + 1,
        email: acc.email,
        name: acc.name || 'Qwen Web Account',
        plan_type: 'Qwen Web (chat.qwen.ai)',
        status: isRateLimited ? 'rate_limited' : (acc.status || 'active'),
        cooldown_remaining_sec: remainingSec,
        rate_limit_reason: isRateLimited ? (acc.rate_limit_reason || 'Rate limited / WAF') : null,
        last_used: acc.last_used,
        created_at: acc.created_at,
        key_preview: maskCookie(acc.access_token),
        is_current_active: idx === (this.currentIndex % Math.max(1, this.accounts.length)),
        model_rate_limits: limitsForAcc.map((l) => ({
          model: l.model,
          cooldown_remaining_sec: Math.max(0, Math.ceil((l.rate_limited_until - now) / 1000)),
        })),
      }
    })
  }

  async testAccount(idOrEmail, model = 'qwen3.8-max') {
    if (!this.initialized) this.init()
    this.reloadFromDb()
    const target = this.accounts.find((a) => a.id === idOrEmail || a.email === idOrEmail)
    if (!target) throw new Error(`Account ${idOrEmail} not found`)

    const { QwenWebClient } = await import('./qwen-web-client.mjs')
    const testMgr = {
      getAvailableAccounts: () => [target],
      getAccountForTurn: async () => ({ account: target, cookie: target.access_token, waitMs: 0, error: null }),
      markRateLimited: () => {},
    }

    const client = new QwenWebClient(testMgr)
    const start = Date.now()
    const result = await client.executeTurn({
      model,
      stream: false,
      messages: [{ role: 'user', content: 'Say "Qwen Web connection verified!" in under 5 words.' }],
    })
    const durationMs = Date.now() - start
    const textBlock = result.response?.content?.find((b) => b.type === 'text')

    return {
      success: true,
      accountEmail: target.email,
      provider: PROVIDER,
      model,
      durationMs,
      responseText: textBlock?.text || 'OK',
    }
  }
}

export const qwenWebAccountManager = new QwenWebAccountManager()
