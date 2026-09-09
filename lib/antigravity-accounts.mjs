import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
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
import { ANTIGRAVITY_MODELS, normalizeAntigravityModel } from './antigravity-models.mjs'

export const OAUTH_CONFIG = Object.freeze({
  clientId: process.env.ANTIGRAVITY_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo',
  callbackPort: 51121,
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ],
})

export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CONFIG.callbackPort}/oauth-callback`
export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc'
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
]
const QUOTA_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
const QUOTA_CACHE_MS = Number(process.env.ANTIGRAVITY_QUOTA_CACHE_MS || 60000)
const SHOW_QUOTA_MODEL = /^(claude-(?:opus|sonnet)-4-6|gemini-3\.8-flash|gemini-3\.7-plus|gemini-3\.6-flash-tiered|gemini-3\.1-pro|gemini-pro-agent)/i

export const ANTIGRAVITY_HEADERS = Object.freeze({
  'User-Agent': 'antigravity/1.11.5 darwin/arm64',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata': JSON.stringify({
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  }),
})

const AGW_CONFIG_PATH = process.env.ANTIGRAVITY_ACCOUNTS_PATH
  || path.join(os.homedir(), '.config', 'antigravity-gateway', 'accounts.json')

export class AntigravityAccountManager {
  constructor() {
    this.accounts = []
    this.projectByEmail = new Map()
    this.tokenCache = new Map() // email -> { token, expiresAt }
    this.stickyAccountByModel = new Map()
    this.currentIndex = 0
    this.activeAccountEmail = null
    this.initialized = false
    this.rateLimitSnapshots = new Map()
  }

  async init() {
    // Deduplicate concurrent cold-start calls so autoImportExistingAccounts
    // only ever runs once regardless of how many requests arrive simultaneously.
    if (this._initPromise) return this._initPromise
    if (this.initialized) return
    this._initPromise = (async () => {
      await this.autoImportExistingAccounts()
      this.reloadFromDb()
      this.initialized = true
    })().finally(() => { this._initPromise = null })
    return this._initPromise
  }

  reloadFromDb() {
    this.accounts = getAccounts('antigravity')
    for (const a of this.accounts) {
      if (a.account_id) this.projectByEmail.set(a.email, a.account_id)
    }
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
      if (!fs.existsSync(AGW_CONFIG_PATH)) return
      const raw = fs.readFileSync(AGW_CONFIG_PATH, 'utf8')
      const config = JSON.parse(raw)
      const agwAccounts = config.accounts || []
      const now = Date.now()

      for (const a of agwAccounts) {
        if (!a.refreshToken && !a.token && !a.access_token) continue
        const email = a.email || 'google-user@gmail.com'
        const existing = getAccounts('antigravity').find((acc) => acc.email === email)
        const accountId = a.projectId || existing?.account_id || null

        let isRateLimited = false
        let maxResetTime = null
        let rateLimitReason = null

        if (a.modelRateLimits) {
          for (const [modelName, limit] of Object.entries(a.modelRateLimits)) {
            if (limit.isRateLimited && limit.resetTime && limit.resetTime > now) {
              isRateLimited = true
              if (!maxResetTime || limit.resetTime > maxResetTime) {
                maxResetTime = limit.resetTime
                rateLimitReason = `Quota limit on ${modelName}`
              }
            }
          }
        }

        const accountObj = {
          id: existing?.id || ('agw_' + email.replace(/[^a-zA-Z0-9]/g, '_')),
          provider: 'antigravity',
          email,
          name: a.projectId ? `Google (${a.projectId})` : 'Google Account',
          account_id: accountId,
          plan_type: 'google-oauth',
          access_token: a.accessToken || a.token || existing?.access_token || null,
          refresh_token: a.refreshToken || existing?.refresh_token || null,
          expires_at: a.expiresAt || existing?.expires_at || (now + 3600000),
          status: a.isInvalid ? 'invalid' : (isRateLimited ? 'rate_limited' : 'active'),
          last_used: a.lastUsed || existing?.last_used || null,
          rate_limited_until: maxResetTime,
          rate_limit_reason: isRateLimited ? (rateLimitReason || 'Antigravity Quota Limit') : null,
          created_at: a.addedAt ? new Date(a.addedAt).getTime() : now,
        }

        upsertAccount(accountObj)
        if (accountId) this.projectByEmail.set(email, accountId)
      }
      const persistedActive = agwAccounts[Number(config.activeIndex) || 0]
      if (persistedActive?.email) this.activeAccountEmail = persistedActive.email
    } catch (err) {
      console.error('[AntigravityAccounts] Failed to auto-import accounts:', err.message)
    }
  }

  getAvailableAccounts(model = null, { excludeEmails = null } = {}) {
    this.clearExpiredLimits()
    const now = Date.now()
    const modelLimitedEmails = model
      ? new Set(getAccountModelRateLimits('antigravity').filter((limit) => limit.model === model).map((limit) => limit.account_email))
      : new Set()
    return this.accounts.filter((a) => {
      if (a.status === 'invalid') return false
      if (excludeEmails?.has(a.email)) return false
      if (a.rate_limited_until && a.rate_limited_until > now) return false
      if (modelLimitedEmails.has(a.email)) return false
      return true
    })
  }

  async getAccountForTurn(model = null, { excludeEmails = null } = {}) {
    await this.init()
    // Refresh account list periodically so new accounts added while running are picked up.
    // Guard with try/catch so a locked or corrupt DB doesn't take down active requests.
    const now = Date.now()
    if (!this._lastDbRefresh || now - this._lastDbRefresh > 30000) {
      try {
        this.reloadFromDb()
      } catch (err) {
        console.warn('[AntigravityAccounts] Periodic DB refresh failed (using cached list):', err.message)
      }
      this._lastDbRefresh = now
    }
    this.clearExpiredLimits()

    // Take a local snapshot so concurrent mutations to this.accounts during
    // the async token-refresh below don't corrupt index calculations.
    const accounts = this.accounts.slice()
    const available = this.getAvailableAccounts(model, { excludeEmails })
    if (available.length === 0) {
      const waitMs = this.getShortestWaitMs(model)
      return {
        account: null,
        token: null,
        project: DEFAULT_PROJECT_ID,
        waitMs,
        error: `All ${accounts.length} Antigravity Google accounts are currently rate-limited. Earliest reset in ${Math.ceil(waitMs / 60000)} minutes.`,
      }
    }

    // Sticky selection for cache continuity
    const stickyKey = model || 'default'
    let chosen = null
    const stickyEmail = this.stickyAccountByModel.get(stickyKey)
    if (stickyEmail) {
      chosen = available.find((a) => a.email === stickyEmail)
    }

    if (!chosen) {
      const activeEmail = this.activeAccountEmail || accounts[this.currentIndex]?.email
      chosen = (activeEmail && available.find((a) => a.email === activeEmail)) || available[0]
      this.stickyAccountByModel.set(stickyKey, chosen.email)
      this.currentIndex = accounts.findIndex((a) => a.id === chosen.id)
      this.activeAccountEmail = chosen.email
    }

    // Refresh token if needed
    try {
      const token = await this.ensureFreshToken(chosen)
      const project = await this.getProjectForAccount(chosen, token)
      touchAccountLastUsed(chosen.id)
      return { account: chosen, token, project, waitMs: 0, error: null }
    } catch (err) {
      console.warn(`[AntigravityAccounts] Token refresh failed for ${chosen.email}: ${err.message}. Rotating...`)
      const backup = available.find((a) => a.id !== chosen.id && !excludeEmails?.has(a.email))
      if (backup) {
        this.stickyAccountByModel.set(stickyKey, backup.email)
        const token = await this.ensureFreshToken(backup)
        const project = await this.getProjectForAccount(backup, token)
        touchAccountLastUsed(backup.id)
        return { account: backup, token, project, waitMs: 0, error: null }
      }
      throw err
    }
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
      for (const limit of getAccountModelRateLimits('antigravity')) {
        if (limit.model === model && limit.rate_limited_until > now) {
          minWait = Math.min(minWait, limit.rate_limited_until - now)
        }
      }
    }
    return minWait === Infinity ? 60000 : minWait
  }

  async ensureFreshToken(account, { force = false } = {}) {
    const now = Date.now()
    const cached = this.tokenCache.get(account.email)
    if (!force && cached && cached.expiresAt > now + 300000 && cached.token) {
      return cached.token
    }

    if (!force && account.access_token && account.expires_at && account.expires_at > now + 300000) {
      this.tokenCache.set(account.email, { token: account.access_token, expiresAt: account.expires_at })
      return account.access_token
    }

    if (!account.refresh_token) {
      if (account.access_token) return account.access_token
      throw new Error(`Account ${account.email} has no refresh token`)
    }

    // Deduplicate concurrent refresh calls for the same account.
    // Without this, two parallel requests hit the token endpoint simultaneously
    // and can trigger Google's rate-limiting on the token exchange endpoint.
    if (!this._refreshPromises) this._refreshPromises = new Map()
    const inflight = this._refreshPromises.get(account.email)
    if (inflight) return inflight

    const refreshPromise = (async () => {
      const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: OAUTH_CONFIG.clientId,
          client_secret: OAUTH_CONFIG.clientSecret,
          refresh_token: account.refresh_token,
          grant_type: 'refresh_token',
        }),
      })

      if (!response.ok) {
        // Sanitize the error: strip the response body which may echo back
        // token-adjacent fields. Only log the status code.
        throw new Error(`Google token refresh failed (${response.status}) for ${account.email}`)
      }

      const data = await response.json()
      const newAccessToken = data.access_token
      const expiresIn = data.expires_in || 3600
      const newExpiresAt = Date.now() + (expiresIn * 1000)

      account.access_token = newAccessToken
      account.expires_at = newExpiresAt

      this.tokenCache.set(account.email, { token: newAccessToken, expiresAt: newExpiresAt })
      updateAccountTokens(account.id, {
        accessToken: newAccessToken,
        refreshToken: account.refresh_token,
        expiresAt: newExpiresAt,
      })

      return newAccessToken
    })().finally(() => {
      this._refreshPromises?.delete(account.email)
    })

    this._refreshPromises.set(account.email, refreshPromise)
    return refreshPromise
  }

  async getProjectForAccount(account, token) {
    if (account.account_id) return account.account_id
    if (this.projectByEmail.has(account.email)) return this.projectByEmail.get(account.email)

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
      try {
        const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...ANTIGRAVITY_HEADERS,
          },
          body: JSON.stringify({
            metadata: {
              ideType: 'IDE_UNSPECIFIED',
              platform: 'PLATFORM_UNSPECIFIED',
              pluginType: 'GEMINI',
            },
          }),
        })
        if (!res.ok) continue
        const data = await res.json()
        let discovered = null
        if (typeof data.cloudaicompanionProject === 'string') {
          discovered = data.cloudaicompanionProject
        } else if (data.cloudaicompanionProject?.id) {
          discovered = data.cloudaicompanionProject.id
        }
        if (discovered) {
          this.projectByEmail.set(account.email, discovered)
          account.account_id = discovered
          upsertAccount(account)
          return discovered
        }
      } catch (err) {
        // Continue to fallback
      }
    }

    return DEFAULT_PROJECT_ID
  }

  async refreshQuotaSnapshot(account, { force = false } = {}) {
    const cached = this.rateLimitSnapshots.get(account.email)
    if (!force && cached && Date.now() - cached.checked_at < QUOTA_CACHE_MS) return cached

    try {
      let token = await this.ensureFreshToken(account)
      const project = await this.getProjectForAccount(account, token)
      const fetchQuota = (bearer) => fetch(QUOTA_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
            'X-Client-Name': 'antigravity',
            'X-Client-Version': '1.11.5',
            ...ANTIGRAVITY_HEADERS,
          },
          body: JSON.stringify(project ? { project } : {}),
          signal: AbortSignal.timeout(8000),
        })
      let response = await fetchQuota(token)
      if (response.status === 401 && account.refresh_token) {
        this.tokenCache.delete(account.email)
        token = await this.ensureFreshToken(account, { force: true })
        response = await fetchQuota(token)
      }
      if (!response.ok) throw new Error(`quota endpoint returned ${response.status}`)
      const data = await response.json()
      const source = data.models && typeof data.models === 'object' ? data.models : {}
      const checkedAt = Date.now()
      const rawModels = Object.entries(source).flatMap(([model, value]) => {
        if (!SHOW_QUOTA_MODEL.test(model)) return []
        const quota = value?.quotaInfo
        const fraction = Number(quota?.remainingFraction)
        if (!Number.isFinite(fraction) || value?.isInternal) return []
        const remainingPercent = Math.max(0, Math.min(100, fraction * 100))
        const resetTime = quota?.resetTime ? Date.parse(quota.resetTime) : null
        const exposedModel = model === 'gemini-3.6-flash-tiered'
          ? 'gemini-3.8-flash-tiered'
          : model
        const canonicalModel = normalizeAntigravityModel(exposedModel) || exposedModel
        if (remainingPercent <= 0 && resetTime && resetTime > checkedAt && normalizeAntigravityModel(exposedModel)) {
          markAccountModelRateLimited(
            account.email,
            'antigravity',
            canonicalModel,
            resetTime - checkedAt,
            `Quota exhausted for ${exposedModel}`,
          )
        }
        return [{
          model: exposedModel,
          upstream_model: model,
          canonical_model: canonicalModel,
          display_name: exposedModel === 'gemini-3.8-flash-tiered'
            ? 'Gemini 3.8 Flash'
            : (value?.displayName || exposedModel),
          remaining_percent: remainingPercent,
          used_percent: 100 - remainingPercent,
          reset_time: Number.isFinite(resetTime) ? resetTime : null,
          is_rate_limited: remainingPercent <= 0,
        }]
      })
      // Google currently returns both gemini-3.1-pro-high and
      // gemini-pro-agent for the same callable quota pool. Show it once and
      // use the more conservative remaining value when the aliases differ.
      const byCanonicalModel = new Map()
      for (const item of rawModels) {
        const existing = byCanonicalModel.get(item.canonical_model)
        if (!existing || item.remaining_percent < existing.remaining_percent) {
          byCanonicalModel.set(item.canonical_model, item)
        }
      }
      const models = [...byCanonicalModel.values()]
      const snapshot = { checked_at: checkedAt, models, error: null }
      this.rateLimitSnapshots.set(account.email, snapshot)
      return snapshot
    } catch (error) {
      console.warn(`[AntigravityAccounts] Quota refresh failed for ${account.email}: ${error.message}`)
      const snapshot = {
        checked_at: Date.now(),
        models: cached?.models || [],
        error: error.message,
      }
      this.rateLimitSnapshots.set(account.email, snapshot)
      return snapshot
    }
  }

  async refreshQuotaSnapshots({ force = false } = {}) {
    await this.init()
    await Promise.all(this.accounts
      .filter((account) => account.status !== 'invalid')
      .map((account) => this.refreshQuotaSnapshot(account, { force })))
  }

  markRateLimited(email, cooldownMs = 60000, reason = 'Antigravity Quota Limit', model = null) {
    if (model) markAccountModelRateLimited(email, 'antigravity', model, cooldownMs, reason)
    else markAccountRateLimited(email, 'antigravity', cooldownMs, reason)
    this.reloadFromDb()
    // Always clear the sticky so the next getAccountForTurn picks from available accounts
    if (model) {
      this.stickyAccountByModel.delete(model)
    } else {
      this.stickyAccountByModel.clear()
    }
    const available = this.getAvailableAccounts(model)
    if (available.length > 0) {
      // Pick the next available account that is not the one just rate-limited
      const nextAccount = available.find((a) => a.email !== email) || available[0]
      // Update currentIndex to point to the next account in the full accounts list
      const nextIdx = this.accounts.findIndex((a) => a.id === nextAccount.id)
      if (nextIdx >= 0) this.currentIndex = nextIdx
      this.activeAccountEmail = nextAccount.email
      if (model) this.stickyAccountByModel.set(model, nextAccount.email)
      console.warn(`[AntigravityAccounts] Rotated account for ${model || 'default'} to: ${nextAccount.email}`)
    } else {
      console.warn(`[AntigravityAccounts] All accounts are rate-limited for ${model || 'default'}`)
    }
  }

  resetAllLimits() {
    clearRateLimits('antigravity')
    this.stickyAccountByModel.clear()
    this.reloadFromDb()
  }

  removeAccount(idOrEmail) {
    const target = this.accounts.find((a) => a.id === idOrEmail || a.email === idOrEmail)
    const email = target?.email || idOrEmail
    this.removeConfigFileEntry(email)
    const res = dbDeleteAccount(idOrEmail)
    this.reloadFromDb()
    return res
  }

  removeConfigFileEntry(email) {
    try {
      if (!fs.existsSync(AGW_CONFIG_PATH)) return
      const raw = fs.readFileSync(AGW_CONFIG_PATH, 'utf8')
      const config = JSON.parse(raw)
      config.accounts = (config.accounts || []).filter((a) => a.email !== email && ('agw_' + (a.email || '').replace(/[^a-zA-Z0-9]/g, '_')) !== email)
      fs.writeFileSync(AGW_CONFIG_PATH, JSON.stringify(config, null, 2))
    } catch (err) {
      console.error('[AntigravityAccounts] Failed to remove Antigravity account from config:', err.message)
    }
  }

  saveToConfigFile(account) {
    try {
      const dir = path.dirname(AGW_CONFIG_PATH)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      let config = { accounts: [], activeIndex: 0 }
      if (fs.existsSync(AGW_CONFIG_PATH)) {
        try {
          config = JSON.parse(fs.readFileSync(AGW_CONFIG_PATH, 'utf8')) || config
        } catch {}
      }
      if (!Array.isArray(config.accounts)) config.accounts = []
      const email = account.email
      const existingIdx = config.accounts.findIndex((a) => a.email === email)
      const accEntry = {
        email,
        projectId: account.account_id || account.projectId || DEFAULT_PROJECT_ID,
        refreshToken: account.refresh_token || account.refreshToken || null,
        accessToken: account.access_token || account.accessToken || null,
        addedAt: Date.now(),
      }
      if (existingIdx >= 0) {
        config.accounts[existingIdx] = { ...config.accounts[existingIdx], ...accEntry }
      } else {
        config.accounts.push(accEntry)
      }
      fs.writeFileSync(AGW_CONFIG_PATH, JSON.stringify(config, null, 2))
    } catch (e) {
      console.error('[AntigravityAccounts] Failed to write config file:', e.message)
    }
  }

  async importLocalAccounts() {
    await this.autoImportExistingAccounts()
    this.reloadFromDb()
    return { success: true, count: this.accounts.length, accounts: this.accounts }
  }

  setActiveAccount(idOrEmail) {
    const idx = this.accounts.findIndex((a) => a.id === idOrEmail || a.email === idOrEmail)
    if (idx >= 0) {
      this.currentIndex = idx
      this.activeAccountEmail = this.accounts[idx].email
      this.stickyAccountByModel.clear()
      try {
        if (fs.existsSync(AGW_CONFIG_PATH)) {
          const config = JSON.parse(fs.readFileSync(AGW_CONFIG_PATH, 'utf8'))
          const configIdx = (config.accounts || []).findIndex((account) => account.email === this.activeAccountEmail)
          if (configIdx >= 0) {
            config.activeIndex = configIdx
            fs.writeFileSync(AGW_CONFIG_PATH, JSON.stringify(config, null, 2))
          }
        }
      } catch (error) {
        console.warn(`[AntigravityAccounts] Could not persist active account: ${error.message}`)
      }
      return true
    }
    return false
  }

  listAccounts() {
    this.clearExpiredLimits()
    const now = Date.now()
    const modelLimits = getAccountModelRateLimits('antigravity')
    return this.accounts.map((acc, idx) => {
      const isRateLimited = !!(acc.rate_limited_until && acc.rate_limited_until > now)
      const remainingSec = isRateLimited ? Math.max(0, Math.ceil((acc.rate_limited_until - now) / 1000)) : 0
      const tokenExpiresInSec = acc.expires_at ? Math.max(0, Math.ceil((acc.expires_at - now) / 1000)) : 3600
      const tokenStatus = tokenExpiresInSec <= 0 ? 'expired' : (tokenExpiresInSec < 300 ? 'expiring_soon' : 'valid')

      const localLimits = modelLimits.filter((limit) => limit.account_email === acc.email)
      const quotaSnapshot = this.rateLimitSnapshots.get(acc.email)
      const snapshotModels = quotaSnapshot?.models || []
      const quotaModels = snapshotModels.map((quota) => {
        const local = localLimits.find((limit) => limit.model === quota.canonical_model || limit.model === quota.model)
        return local ? {
          ...quota,
          is_rate_limited: true,
          reset_time: Math.max(quota.reset_time || 0, local.rate_limited_until),
        } : quota
      })
      for (const limit of localLimits) {
        if (quotaModels.some((quota) => quota.model === limit.model || quota.canonical_model === limit.model)) continue
        quotaModels.push({
          model: limit.model,
          canonical_model: limit.model,
          remaining_percent: 0,
          used_percent: 100,
          is_rate_limited: true,
          reset_time: limit.rate_limited_until,
        })
      }
      const hasModelLimit = quotaModels.some((quota) => quota.is_rate_limited)

      return {
        id: acc.id,
        provider: 'antigravity',
        index: idx + 1,
        email: acc.email,
        name: acc.name || 'Google Account',
        plan_type: 'Google OAuth',
        account_id: acc.account_id || DEFAULT_PROJECT_ID,
        status: isRateLimited ? 'rate_limited' : (hasModelLimit ? 'partially_limited' : acc.status),
        rate_limited_until: acc.rate_limited_until,
        cooldown_remaining_sec: remainingSec,
        cooldown_source: 'upstream',
        rate_limit_reason: acc.rate_limit_reason,
        last_used: acc.last_used,
        created_at: acc.created_at,
        token_status: tokenStatus,
        token_expires_in_sec: tokenExpiresInSec,
        is_current_active: this.activeAccountEmail
          ? acc.email === this.activeAccountEmail
          : idx === this.currentIndex % Math.max(1, this.accounts.length),
        model_rate_limits: quotaModels,
        rate_limits_checked_at: quotaSnapshot?.checked_at || null,
        quota_error: quotaSnapshot?.error || null,
        supported_models: ANTIGRAVITY_MODELS.map((item) => item.model),
      }
    })
  }

  // OAuth Login Flow
  static generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    return { verifier, challenge }
  }

  static getAuthorizationUrl() {
    const { verifier, challenge } = AntigravityAccountManager.generatePKCE()
    const state = crypto.randomBytes(16).toString('hex')
    const params = new URLSearchParams({
      client_id: OAUTH_CONFIG.clientId,
      redirect_uri: OAUTH_REDIRECT_URI,
      response_type: 'code',
      scope: OAUTH_CONFIG.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })
    return {
      url: `${OAUTH_CONFIG.authUrl}?${params.toString()}`,
      verifier,
      state,
    }
  }

  async addAccountFromRefreshToken({ refreshToken, email = null, projectId = null }) {
    if (!refreshToken) throw new Error('Google OAuth refresh_token is required')

    // Validate the refresh token by exchanging it immediately.
    // Never silently fall back to using a refresh_token as a bearer credential.
    const tokenRes = await fetch(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: OAUTH_CONFIG.clientId,
        client_secret: OAUTH_CONFIG.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })

    if (!tokenRes.ok) {
      throw new Error(`Failed to validate refresh token (${tokenRes.status})`)
    }

    const tokenData = await tokenRes.json()
    const accessToken = tokenData.access_token

    let accountEmail = email
    if (!accountEmail && accessToken) {
      try {
        const userRes = await fetch(OAUTH_CONFIG.userInfoUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (userRes.ok) {
          const userInfo = await userRes.json()
          accountEmail = userInfo.email
        }
      } catch {}
    }
    accountEmail ||= `google-acc-${Date.now()}@gmail.com`

    let discoveredProject = projectId
    if (!discoveredProject && accessToken) {
      try {
        discoveredProject = await this.getProjectForAccount({ email: accountEmail }, accessToken)
      } catch {}
    }
    discoveredProject ||= DEFAULT_PROJECT_ID

    const id = 'agw_' + accountEmail.replace(/[^a-zA-Z0-9]/g, '_')
    const accountObj = {
      id,
      provider: 'antigravity',
      email: accountEmail,
      name: `Google (${discoveredProject})`,
      account_id: discoveredProject,
      plan_type: 'google-oauth',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Date.now() + ((tokenData.expires_in || 3600) * 1000),
      status: 'active',
    }

    upsertAccount(accountObj)
    this.saveToConfigFile(accountObj)
    this.reloadFromDb()
    return { id, email: accountEmail, projectId: discoveredProject }
  }

  async loginWithOAuth({ openBrowser = true, onUrl = null } = {}) {
    const { verifier, challenge } = AntigravityAccountManager.generatePKCE()
    const state = crypto.randomBytes(16).toString('hex')

    const params = new URLSearchParams({
      client_id: OAUTH_CONFIG.clientId,
      redirect_uri: OAUTH_REDIRECT_URI,
      response_type: 'code',
      scope: OAUTH_CONFIG.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })
    const authUrl = `${OAUTH_CONFIG.authUrl}?${params.toString()}`

    if (typeof onUrl === 'function') {
      onUrl(authUrl)
    }

    if (openBrowser) {
      try {
        const { exec } = await import('node:child_process')
        const cmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start ""' : 'xdg-open')
        exec(`${cmd} "${authUrl}"`, () => {})
      } catch {}
    }

    return new Promise((resolve, reject) => {
      let cleanedUp = false
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('OAuth authorization timed out after 5 minutes'))
      }, 300_000)
      timeout.unref?.()

      const server = http.createServer(async (req, res) => {
        const reqUrl = new URL(req.url, `http://localhost:${OAUTH_CONFIG.callbackPort}`)
        if (reqUrl.pathname !== '/oauth-callback') {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          return res.end('Not found')
        }

        const code = reqUrl.searchParams.get('code')
        const callbackState = reqUrl.searchParams.get('state')
        const error = reqUrl.searchParams.get('error')
        const errorDescription = reqUrl.searchParams.get('error_description')

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0d1117;color:#f85149;padding:40px;text-align:center;"><h2>Authentication failed</h2><p>${errorDescription || error}</p></body></html>`)
          cleanup()
          reject(new Error(errorDescription || error))
          return
        }

        if (!code || callbackState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0d1117;color:#f85149;padding:40px;text-align:center;"><h2>Invalid callback state or missing code</h2></body></html>')
          cleanup()
          reject(new Error('State mismatch or missing authorization code'))
          return
        }

        try {
          const tokenRes = await fetch(OAUTH_CONFIG.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: OAUTH_CONFIG.clientId,
              client_secret: OAUTH_CONFIG.clientSecret,
              code,
              grant_type: 'authorization_code',
              redirect_uri: OAUTH_REDIRECT_URI,
              code_verifier: verifier,
            }),
          })

          if (!tokenRes.ok) {
            const errText = await tokenRes.text()
            throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`)
          }

          const tokenData = await tokenRes.json()
          const refreshToken = tokenData.refresh_token
          const accessToken = tokenData.access_token

          let accountEmail = null
          if (accessToken) {
            try {
              const userRes = await fetch(OAUTH_CONFIG.userInfoUrl, {
                headers: { Authorization: `Bearer ${accessToken}` },
              })
              if (userRes.ok) {
                const userInfo = await userRes.json()
                accountEmail = userInfo.email
              }
            } catch {}
          }
          accountEmail ||= `google-user-${Date.now()}@gmail.com`

          let projectId = null
          if (accessToken) {
            try {
              projectId = await this.getProjectForAccount({ email: accountEmail }, accessToken)
            } catch {}
          }

          const account = await this.addAccountFromRefreshToken({
            refreshToken: refreshToken || accessToken,
            email: accountEmail,
            projectId,
          })

          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="background:#161b22;padding:32px 40px;border-radius:12px;border:1px solid #30363d;text-align:center;"><div style="font-size:40px;margin-bottom:12px;">✅</div><h2 style="margin:0 0 8px;">Google Account Connected!</h2><p style="color:#8b949e;"><strong>${accountEmail}</strong> has been added to Claude-Zen.</p><p style="color:#3fb950;">You can close this tab and return to your terminal.</p></div></body></html>`)

          cleanup()
          resolve(account)
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html' })
          res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0d1117;color:#f85149;padding:40px;text-align:center;"><h2>Error connecting account</h2><p>${err.message}</p></body></html>`)
          cleanup()
          reject(err)
        }
      })

      function cleanup() {
        if (cleanedUp) return
        cleanedUp = true
        clearTimeout(timeout)
        try { server.close() } catch {}
      }

      server.on('error', (err) => {
        cleanup()
        reject(new Error(`Failed to listen on port ${OAUTH_CONFIG.callbackPort}: ${err.message}`))
      })

      server.listen(OAUTH_CONFIG.callbackPort, '127.0.0.1')
    })
  }

  async testAccount(idOrEmail, model = 'gemini-3.8-flash-tiered') {
    await this.init()
    this.reloadFromDb()
    const target = this.accounts.find((a) => a.id === idOrEmail || a.email === idOrEmail)
    if (!target) throw new Error(`Account ${idOrEmail} not found in Antigravity pool`)

    const { antigravityClient } = await import('./antigravity-client.mjs')
    const start = Date.now()
    const result = await antigravityClient.executeTurn({
      model: model || 'gemini-3.8-flash-tiered',
      stream: false,
      messages: [{ role: 'user', content: 'Say "Antigravity Google verified!" in under 5 words.' }],
    }, {
      onAccountSelected: () => {},
    })
    const durationMs = Date.now() - start
    const textBlock = result.response?.content?.find((b) => b.type === 'text')
    return {
      success: true,
      accountEmail: target.email,
      provider: 'antigravity',
      model: model || 'gemini-3.8-flash-tiered',
      durationMs,
      responseText: textBlock?.text || 'OK',
    }
  }
}

export const antigravityAccountManager = new AntigravityAccountManager()
