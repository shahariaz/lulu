import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  getAccounts,
  upsertAccount,
  deleteAccount as dbDeleteAccount,
  markAccountRateLimited,
  clearRateLimits,
  touchAccountLastUsed,
  updateAccountRateLimitState,
  getAccountModelRateLimits,
  markAccountModelRateLimited,
} from './db.mjs'

const ZEN_ENV_PATH = path.join(os.homedir(), '.zen-claude', '.env')
const LOCAL_ENV_PATH = path.join(process.cwd(), '.env')
const OPENCODE_CONFIG_PATHS = [
  path.join(os.homedir(), '.opencode', 'config.json'),
  path.join(os.homedir(), '.config', 'opencode', 'config.json'),
  path.join(os.homedir(), '.opencode', 'auth.json'),
  path.join(os.homedir(), '.config', 'opencode', 'auth.json'),
]

export const ZEN_FREE_MODELS = Object.freeze([
  // OpenCode Zen display name: "Ox Alpha Free" (canonical Zen model ID).
  'x-preview-f-free',
  'nemotron-3.5-lightning-free',
  'ling-3.0-tiny-free',
  'laguna-s-2.1-free',
  'hy3-free',
  'nemotron-3-ultra-free',
  'mimo-v2.5-free',
])

export const ZEN_GO_MODELS = Object.freeze([
  'qwen3.7-plus',
  'mimo-v2.5',
  'minimax-m3',
  'kimi-k3',
  'glm-5',
])

export const ALL_ZEN_MODELS = Object.freeze([...ZEN_FREE_MODELS, ...ZEN_GO_MODELS])

export function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '••••'
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 5)}••••${key.slice(-4)}`
}

export class ZenAccountManager {
  constructor() {
    this.accounts = []
    this.stickyAccountByModel = new Map()
    this.currentIndex = 0
    this.initialized = false
  }

  async init() {
    if (this.initialized) return
    await this.autoImportExistingAccounts()
    this.reloadFromDb()
    this.initialized = true
  }

  reloadFromDb() {
    this.accounts = getAccounts('zen')
    this.clearExpiredLimits()
  }

  clearExpiredLimits() {
    const now = Date.now()
    for (const acc of this.accounts) {
      if (acc.rate_limited_until && acc.rate_limited_until <= now) {
        acc.rate_limited_until = null
        acc.rate_limit_reason = null
        acc.status = 'active'
        updateAccountRateLimitState(acc.id, {})
      }
    }
  }

  async autoImportExistingAccounts() {
    try {
      const candidateKeys = new Map() // key -> { email, name, planType }

      // 1. Check process.env.ZEN_API_KEY
      if (process.env.ZEN_API_KEY && process.env.ZEN_API_KEY.startsWith('sk-')) {
        candidateKeys.set(process.env.ZEN_API_KEY, {
          email: 'zen-primary@local',
          name: 'Primary Zen Key (ENV)',
          planType: 'hybrid',
        })
      }

      // 2. Check ~/.zen-claude/.env and local .env
      for (const envPath of [ZEN_ENV_PATH, LOCAL_ENV_PATH]) {
        try {
          if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8')
            const match = content.match(/^ZEN_API_KEY=(sk-[^\s#]+)/m)
            if (match && match[1] && !candidateKeys.has(match[1])) {
              candidateKeys.set(match[1], {
                email: 'zen-env@local',
                name: 'Zen Key (.env)',
                planType: 'hybrid',
              })
            }
          }
        } catch {}
      }

      // 3. Check OpenCode config files
      for (const cfgPath of OPENCODE_CONFIG_PATHS) {
        try {
          if (fs.existsSync(cfgPath)) {
            const raw = fs.readFileSync(cfgPath, 'utf8')
            const cfg = JSON.parse(raw)
            const key = cfg.api_key || cfg.apiKey || cfg.token || cfg.tokens?.zen
            const email = cfg.email || cfg.user?.email || `opencode-${path.basename(cfgPath)}`
            if (key && typeof key === 'string' && key.startsWith('sk-') && !candidateKeys.has(key)) {
              candidateKeys.set(key, {
                email,
                name: cfg.name || 'OpenCode CLI Account',
                planType: cfg.plan_type || 'hybrid',
              })
            }
          }
        } catch {}
      }

      const existingAccounts = getAccounts('zen')
      const existingTokens = new Set(existingAccounts.map((a) => a.access_token).filter(Boolean))

      for (const [key, meta] of candidateKeys.entries()) {
        if (!existingTokens.has(key)) {
          const safeId = 'zen_' + meta.email.replace(/[^a-zA-Z0-9._-]/g, '_')
          upsertAccount({
            id: safeId,
            provider: 'zen',
            email: meta.email,
            name: meta.name,
            account_id: meta.planType || 'hybrid',
            plan_type: meta.planType || 'hybrid',
            access_token: key,
            status: 'active',
          })
        }
      }
    } catch (err) {
      console.error('[ZenAccounts] Failed to auto-import accounts:', err.message)
    }
  }

  getAvailableAccounts(model = null, { excludeEmails = null } = {}) {
    this.clearExpiredLimits()
    const now = Date.now()
    const isFreeModel = Boolean(model && (model.endsWith('-free') || ZEN_FREE_MODELS.includes(model)))
    const isGoModel = Boolean(model && (!isFreeModel || ZEN_GO_MODELS.includes(model)))

    const modelLimitedEmails = model
      ? new Set(getAccountModelRateLimits('zen').filter((l) => l.model === model).map((l) => l.account_email))
      : new Set()

    return this.accounts.filter((a) => {
      if (excludeEmails?.has(a.email)) return false
      if (a.status === 'invalid') return false
      if (a.rate_limited_until && a.rate_limited_until > now) return false
      if (modelLimitedEmails.has(a.email)) return false

      const plan = (a.plan_type || a.account_id || 'hybrid').toLowerCase()
      if (isFreeModel) {
        // Free models can run on free or hybrid accounts
        if (plan === 'go') {
          // If we have accounts with 'free' or 'hybrid' plan, prefer those over strictly 'go'
          const hasFreeOrHybrid = this.accounts.some((acc) => {
            const p = (acc.plan_type || acc.account_id || 'hybrid').toLowerCase()
            return (p === 'free' || p === 'hybrid') && (!acc.rate_limited_until || acc.rate_limited_until <= now)
          })
          if (hasFreeOrHybrid) return false
        }
      } else if (isGoModel) {
        // Go paid models need 'go' or 'hybrid' plan
        if (plan === 'free') {
          const hasGoOrHybrid = this.accounts.some((acc) => {
            const p = (acc.plan_type || acc.account_id || 'hybrid').toLowerCase()
            return (p === 'go' || p === 'hybrid') && (!acc.rate_limited_until || acc.rate_limited_until <= now)
          })
          if (hasGoOrHybrid) return false
        }
      }
      return true
    })
  }

  getShortestWaitMs(model = null) {
    const now = Date.now()
    let minWait = Infinity
    for (const a of this.accounts) {
      if (a.rate_limited_until && a.rate_limited_until > now) {
        const wait = a.rate_limited_until - now
        if (wait < minWait) minWait = wait
      }
    }
    if (model) {
      for (const limit of getAccountModelRateLimits('zen')) {
        if (limit.model === model && limit.rate_limited_until > now) {
          minWait = Math.min(minWait, limit.rate_limited_until - now)
        }
      }
    }
    return minWait === Infinity ? 60000 : minWait
  }

  async getAccountForTurn(model = null, { excludeEmails = null } = {}) {
    await this.init()
    this.clearExpiredLimits()

    const available = this.getAvailableAccounts(model, { excludeEmails })
    if (available.length === 0) {
      const waitMs = this.getShortestWaitMs(model)
      return {
        account: null,
        apiKey: null,
        waitMs,
        error: this.accounts.length === 0
          ? 'No OpenCode Zen accounts are configured. Add an API key with `claude-zen --zen-accounts add` or set ZEN_API_KEY.'
          : `All ${this.accounts.length} OpenCode Zen accounts are currently rate-limited. Earliest reset in ${Math.ceil(waitMs / 60000)} minutes.`,
      }
    }

    // Sticky selection for consistency
    const stickyKey = model || 'default'
    let chosen = null
    const stickyEmail = this.stickyAccountByModel.get(stickyKey)
    if (stickyEmail) {
      chosen = available.find((a) => a.email === stickyEmail)
    }

    if (!chosen) {
      const activeEmail = this.accounts[this.currentIndex]?.email
      chosen = (activeEmail && available.find((a) => a.email === activeEmail)) || available[0]
      this.stickyAccountByModel.set(stickyKey, chosen.email)
      this.currentIndex = this.accounts.findIndex((a) => a.id === chosen.id)
    }

    touchAccountLastUsed(chosen.id)
    return {
      account: chosen,
      apiKey: chosen.access_token,
      waitMs: 0,
      error: null,
    }
  }

  markRateLimited(email, cooldownMs = 60000, reason = 'OpenCode Quota Limit', model = null) {
    if (model) markAccountModelRateLimited(email, 'zen', model, cooldownMs, reason)
    else markAccountRateLimited(email, 'zen', cooldownMs, reason, model)
    this.reloadFromDb()

    const available = this.getAvailableAccounts(model)
    if (available.length > 0) {
      this.currentIndex = (this.currentIndex + 1) % available.length
      if (model) this.stickyAccountByModel.set(model, available[this.currentIndex].email)
      console.warn(`[ZenAccounts] Rotated account for ${model || 'default'} to: ${available[this.currentIndex].email}`)
    }
  }

  addAccountFromApiKey({ apiKey, email = null, name = null, planType = 'hybrid' }) {
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim().startsWith('sk-')) {
      throw new Error('Valid OpenCode API key starting with "sk-" is required')
    }
    const cleanKey = apiKey.trim()
    const normalizedPlan = ['free', 'go', 'hybrid'].includes(String(planType).toLowerCase())
      ? String(planType).toLowerCase()
      : 'hybrid'

    const derivedEmail = email && String(email).trim()
      ? String(email).trim()
      : `zen-${cleanKey.slice(3, 11)}@opencode.ai`

    const derivedName = name && String(name).trim()
      ? String(name).trim()
      : `OpenCode ${normalizedPlan === 'free' ? 'Free' : normalizedPlan === 'go' ? 'Go (Paid)' : 'Zen'} Account`

    const existing = getAccounts('zen').find((a) => a.access_token === cleanKey || a.email === derivedEmail)
    const id = existing?.id || ('zen_' + derivedEmail.replace(/[^a-zA-Z0-9._-]/g, '_'))

    const accountObj = {
      id,
      provider: 'zen',
      email: derivedEmail,
      name: derivedName,
      account_id: normalizedPlan,
      plan_type: normalizedPlan,
      access_token: cleanKey,
      status: 'active',
      created_at: Date.now(),
    }

    upsertAccount(accountObj)
    this.reloadFromDb()
    return { id, email: derivedEmail, name: derivedName, planType: normalizedPlan }
  }

  removeAccount(idOrEmail) {
    const res = dbDeleteAccount(idOrEmail)
    this.reloadFromDb()
    return res
  }

  setActiveAccount(idOrEmail) {
    const idx = this.accounts.findIndex((a) => a.id === idOrEmail || a.email === idOrEmail)
    if (idx >= 0) {
      this.currentIndex = idx
      this.stickyAccountByModel.clear()
      return true
    }
    return false
  }

  resetAllLimits() {
    clearRateLimits('zen')
    this.reloadFromDb()
  }

  listAccounts() {
    this.clearExpiredLimits()
    const now = Date.now()
    const modelLimits = getAccountModelRateLimits('zen')

    return this.accounts.map((acc, idx) => {
      const isRateLimited = !!(acc.rate_limited_until && acc.rate_limited_until > now)
      const remainingSec = isRateLimited ? Math.max(0, Math.ceil((acc.rate_limited_until - now) / 1000)) : 0
      const plan = acc.plan_type || acc.account_id || 'hybrid'
      const planLabel = plan === 'free' ? 'Zen Free' : plan === 'go' ? 'Zen Go (Paid)' : 'Zen Hybrid (Free + Go)'

      const limitsForAcc = modelLimits.filter((l) => l.account_email === acc.email)
      const totalSupported = ALL_ZEN_MODELS.length
      const limitedCount = limitsForAcc.length

      let statusText = 'active'
      if (acc.status === 'invalid') statusText = 'invalid'
      else if (limitedCount > 0 && limitedCount < totalSupported) statusText = 'partially_limited'
      else if (isRateLimited) statusText = 'rate_limited'

      return {
        id: acc.id,
        provider: 'zen',
        index: idx + 1,
        email: acc.email,
        name: acc.name || 'OpenCode Account',
        plan_type: planLabel,
        account_id: plan,
        status: statusText,
        rate_limited_until: acc.rate_limited_until,
        cooldown_remaining_sec: remainingSec,
        cooldown_source: 'upstream',
        rate_limit_reason: isRateLimited ? (acc.rate_limit_reason || 'Rate limit reached') : null,
        last_used: acc.last_used,
        created_at: acc.created_at,
        key_preview: maskApiKey(acc.access_token),
        is_current_active: idx === this.currentIndex % Math.max(1, this.accounts.length),
        model_rate_limits: limitsForAcc.map((limit) => ({
          model: limit.model,
          is_rate_limited: true,
          reset_time: limit.rate_limited_until,
          cooldown_remaining_sec: Math.max(0, Math.ceil((limit.rate_limited_until - now) / 1000)),
          cooldown_source: 'upstream',
        })),
        supported_models: plan === 'free'
          ? [...ZEN_FREE_MODELS]
          : plan === 'go'
            ? [...ZEN_GO_MODELS]
            : [...ALL_ZEN_MODELS],
      }
    })
  }

  async testAccount(idOrEmail, model = null) {
    await this.init()
    this.reloadFromDb()
    const target = this.accounts.find((a) => a.id === idOrEmail || a.email === idOrEmail)
    if (!target) throw new Error(`Account ${idOrEmail} not found`)

    const plan = (target.plan_type || target.account_id || 'hybrid').toLowerCase()
    const isFree = plan === 'free'
    const targetModel = model || (isFree ? 'nemotron-3.5-lightning-free' : 'qwen3.7-plus')
    const upstream = isFree ? 'https://opencode.ai/zen/v1' : 'https://opencode.ai/zen/go/v1'
    const start = Date.now()
    const res = await fetch(`${upstream}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: 'user', content: 'Say "OpenCode Zen verified!" in under 5 words.' }],
        max_tokens: 30,
      }),
    })
    const durationMs = Date.now() - start
    const text = await res.text()
    if (!res.ok) throw new Error(`OpenCode error (${res.status}): ${text.slice(0, 300)}`)
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`OpenCode returned non-JSON response: ${text.slice(0, 200)}`)
    }
    return {
      success: true,
      accountEmail: target.email,
      provider: 'zen',
      model: targetModel,
      durationMs,
      responseText: data.choices?.[0]?.message?.content || 'OK',
    }
  }
}

export const zenAccountManager = new ZenAccountManager()
