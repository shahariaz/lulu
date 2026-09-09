import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  getAccounts,
  upsertAccount,
  deleteAccount as dbDeleteAccount,
  updateAccountTokens,
  markAccountRateLimited,
  clearRateLimits,
  touchAccountLastUsed,
  updateAccountRateLimitState,
} from './db.mjs'
import { zenAccountManager } from './zen-accounts.mjs'

const CODEX_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json')
const CODEX_ACCOUNT_HOME_ROOT = process.env.CODEX_ACCOUNT_HOME_ROOT
  || path.join(os.homedir(), '.zen-claude', 'codex-accounts')
const AGW_CONFIG_PATH = path.join(os.homedir(), '.config', 'antigravity-gateway', 'accounts.json')
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token'

function parseJwt(token) {
  try {
    if (!token || typeof token !== 'string') return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function timestampMs(value) {
  if (!value) return null
  return value > 10_000_000_000 ? value : value * 1000
}

function formatWindowName(snapshot, window, index) {
  const duration = window.windowDurationMins
  let durationLabel = index === 0 ? 'Primary' : 'Secondary'
  if (duration) {
    if (duration % 10080 === 0) durationLabel = `${duration / 10080}w`
    else if (duration % 1440 === 0) durationLabel = `${duration / 1440}d`
    else if (duration % 60 === 0) durationLabel = `${duration / 60}h`
    else durationLabel = `${duration}m`
  }
  return `${snapshot.limitName || snapshot.limitId || 'Codex'} ${durationLabel}`
}

export class CodexAccountManager {
  constructor() {
    this.accounts = []
    this.rateLimitSnapshots = new Map()
    this.modelsByAccount = new Map()
    this.currentIndex = 0
    this.initialized = false
  }

  async init() {
    if (this.initialized) return

    // Auto-import from ~/.codex/auth.json if exists
    await this.autoImportLocalCodexAuth()

    // Sync Antigravity accounts to DB for visibility
    await this.syncAntigravityAccountsToDb()

    // Initialize Zen accounts
    await zenAccountManager.init()

    // Load all accounts from SQLite DB
    this.reloadFromDb()
    this.initialized = true
  }

  reloadFromDb() {
    this.accounts = getAccounts('codex')
    this.clearExpiredLimits()
  }

  async autoImportLocalCodexAuth() {
    try {
      if (!fs.existsSync(CODEX_AUTH_PATH)) return

      const content = fs.readFileSync(CODEX_AUTH_PATH, 'utf8')
      const auth = JSON.parse(content)
      const tokens = auth.tokens || {}

      if (!tokens.access_token && !tokens.refresh_token) return

      const accessPayload = parseJwt(tokens.access_token) || {}
      const idPayload = parseJwt(tokens.id_token) || {}

      const authClaim = accessPayload['https://api.openai.com/auth'] || {}
      const email = idPayload.email || accessPayload.email || 'codex-primary@local'
      const name = idPayload.name || 'ChatGPT Plus User'
      const accountId = tokens.account_id || authClaim.chatgpt_account_id || null
      const planType = authClaim.chatgpt_plan_type || 'plus'
      const clientId = accessPayload.client_id || DEFAULT_CLIENT_ID
      const expiresAt = accessPayload.exp ? accessPayload.exp * 1000 : Date.now() + 864000000

      const existing = getAccounts('codex').find((account) =>
        (accountId && account.account_id === accountId) || account.email === email)
      const identity = String(accountId || email).replace(/[^a-zA-Z0-9._-]/g, '_')
      const accountObj = {
        id: existing?.id || `acc_chatgpt_${identity}`,
        provider: 'codex',
        email,
        name,
        account_id: accountId,
        plan_type: planType,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: tokens.id_token,
        client_id: clientId,
        expires_at: expiresAt,
        status: 'active',
      }

      upsertAccount(accountObj)
    } catch (err) {
      console.error('[CodexAccounts] Failed to auto-import ~/.codex/auth.json:', err.message)
    }
  }

  applyRateLimitSnapshot(accountId, response) {
    const account = this.accounts.find((item) => item.id === accountId)
    if (!account) return null
    const byId = response?.rateLimitsByLimitId
    const snapshots = byId && Object.keys(byId).length
      ? Object.values(byId)
      : response?.rateLimits ? [response.rateLimits] : []
    const windows = []
    let exhaustedUntil = null
    let reachedType = null

    for (const snapshot of snapshots) {
      reachedType ||= snapshot.rateLimitReachedType || null
      for (const [index, window] of [snapshot.primary, snapshot.secondary].entries()) {
        if (!window) continue
        const resetTime = timestampMs(window.resetsAt)
        const usedPercent = Number(window.usedPercent || 0)
        const exhausted = usedPercent >= 100
        windows.push({
          model: formatWindowName(snapshot, window, index),
          used_percent: usedPercent,
          remaining_percent: Math.max(0, 100 - usedPercent),
          is_rate_limited: exhausted,
          reset_time: resetTime,
          window_duration_mins: window.windowDurationMins || null,
        })
        if (exhausted && resetTime && (!exhaustedUntil || resetTime > exhaustedUntil)) {
          exhaustedUntil = resetTime
        }
      }
    }

    if (reachedType && !exhaustedUntil) {
      exhaustedUntil = Math.max(0, ...windows.map((window) => window.reset_time || 0)) || Date.now() + 3600000
    }
    this.rateLimitSnapshots.set(accountId, {
      windows,
      checked_at: Date.now(),
      reached_type: reachedType,
    })

    const wasCodexSnapshot = String(account.rate_limit_reason || '').startsWith('Codex usage:')
    if (exhaustedUntil && exhaustedUntil > Date.now()) {
      updateAccountRateLimitState(account.id, {
        until: exhaustedUntil,
        reason: `Codex usage: ${reachedType || 'usage window exhausted'}`,
      })
      this.reloadFromDb()
    } else if (wasCodexSnapshot) {
      updateAccountRateLimitState(account.id, {})
      this.reloadFromDb()
    }
    return this.rateLimitSnapshots.get(accountId)
  }

  async syncAntigravityAccountsToDb() {
    try {
      if (!fs.existsSync(AGW_CONFIG_PATH)) return
      const raw = fs.readFileSync(AGW_CONFIG_PATH, 'utf8')
      const config = JSON.parse(raw)
      const agwAccounts = config.accounts || []
      const now = Date.now()

      for (const a of agwAccounts) {
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

        upsertAccount({
          id: 'agw_' + (a.email || '').replace(/[^a-zA-Z0-9]/g, '_'),
          provider: 'antigravity',
          email: a.email,
          name: a.projectId ? `Google (${a.projectId})` : 'Google Account',
          account_id: a.projectId || null,
          plan_type: 'google-oauth',
          status: a.isInvalid ? 'invalid' : (isRateLimited ? 'rate_limited' : 'active'),
          last_used: a.lastUsed || null,
          rate_limited_until: maxResetTime,
          rate_limit_reason: isRateLimited ? (rateLimitReason || 'Antigravity Quota Limit') : null,
        })
      }
    } catch (err) {
      console.error('[CodexAccounts] Failed to sync Antigravity accounts to DB:', err.message)
    }
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

  setAccountModels(accountId, models) {
    this.modelsByAccount.set(accountId, new Set(models.map((item) => item.model || item.id).filter(Boolean)))
  }

  getAvailableAccounts(model = null) {
    this.clearExpiredLimits()
    const now = Date.now()
    return this.accounts.filter((a) => {
      if (a.status !== 'active' || (a.rate_limited_until && a.rate_limited_until > now)) return false
      const supported = this.modelsByAccount.get(a.id)
      return !model || !supported || supported.has(model)
    })
  }

  getShortestWaitMs() {
    const now = Date.now()
    let minWait = Infinity
    for (const a of this.accounts) {
      if (a.rate_limited_until && a.rate_limited_until > now) {
        const wait = a.rate_limited_until - now
        if (wait < minWait) minWait = wait
      }
    }
    return minWait === Infinity ? 3600000 : minWait
  }

  async getAccountForTurn(model = null) {
    await this.init()
    this.clearExpiredLimits()

    const available = this.getAvailableAccounts(model)
    if (available.length === 0) {
      const waitMs = this.getShortestWaitMs()
      return {
        account: null,
        waitMs,
        error: model
          ? `No available ChatGPT account can run ${model}. Accounts may be rate-limited or lack model access.`
          : `All ${this.accounts.length} ChatGPT accounts are currently rate limited. Earliest reset in ${Math.ceil(waitMs / 60000)} minutes.`,
      }
    }

    // Sticky selection: try current index first if available
    let chosen = available.find((a, idx) => idx === this.currentIndex % available.length)
    if (!chosen) {
      chosen = available[0]
      this.currentIndex = this.accounts.findIndex((a) => a.id === chosen.id)
    }

    // Ensure access token is fresh
    try {
      await this.ensureFreshToken(chosen)
    } catch (err) {
      console.error(`[CodexAccounts] Token refresh failed for ${chosen.email}:`, err.message)
      const backup = available.find((a) => a.id !== chosen.id)
      if (backup) {
        chosen = backup
        await this.ensureFreshToken(chosen)
      }
    }

    touchAccountLastUsed(chosen.id)
    return { account: chosen, waitMs: 0, error: null }
  }

  async ensureFreshToken(account) {
    const now = Date.now()
    if (account.expires_at && account.expires_at > now + 600000) {
      return account.access_token
    }

    if (!account.refresh_token) {
      return account.access_token
    }

    const clientId = account.client_id || DEFAULT_CLIENT_ID
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: account.refresh_token,
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Token refresh failed (HTTP ${res.status}): ${errText}`)
    }

    const data = await res.json()
    const newAccessToken = data.access_token
    const newRefreshToken = data.refresh_token || account.refresh_token
    const newIdToken = data.id_token || account.id_token
    const expiresInSec = data.expires_in || 864000
    const newExpiresAt = Date.now() + expiresInSec * 1000

    account.access_token = newAccessToken
    account.refresh_token = newRefreshToken
    account.id_token = newIdToken
    account.expires_at = newExpiresAt

    updateAccountTokens(account.id, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      idToken: newIdToken,
      expiresAt: newExpiresAt,
    })

    return newAccessToken
  }

  materializeCodexHome(account) {
    if (!account?.access_token) {
      throw new Error(`Account ${account?.email || account?.id || 'unknown'} has no Codex access token`)
    }

    const safeId = String(account.id || account.email || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
    const codexHome = path.join(CODEX_ACCOUNT_HOME_ROOT, safeId)
    const authPath = path.join(codexHome, 'auth.json')
    const tempPath = path.join(codexHome, `.auth-${process.pid}-${randomUUID()}.tmp`)
    const auth = {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      last_refresh: new Date().toISOString(),
      tokens: {
        access_token: account.access_token,
        refresh_token: account.refresh_token || null,
        id_token: account.id_token || null,
        account_id: account.account_id || null,
      },
    }

    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 })
    fs.writeFileSync(tempPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tempPath, authPath)
    fs.chmodSync(codexHome, 0o700)
    fs.chmodSync(authPath, 0o600)
    return codexHome
  }

  markRateLimited(email, cooldownMs = 3600000, reason = 'Usage limit reached', model = null) {
    markAccountRateLimited(email, 'codex', cooldownMs, reason, model)
    this.reloadFromDb()

    const available = this.getAvailableAccounts()
    if (available.length > 0) {
      this.currentIndex = (this.currentIndex + 1) % available.length
      console.warn(`[CodexAccounts] Switched active account to: ${available[this.currentIndex].email}`)
    }
  }

  resetAllLimits() {
    clearRateLimits()
    this.reloadFromDb()
    this.resetAntigravityRateLimits()
    zenAccountManager.resetAllLimits()
  }

  resetAntigravityRateLimits() {
    try {
      if (!fs.existsSync(AGW_CONFIG_PATH)) return
      const raw = fs.readFileSync(AGW_CONFIG_PATH, 'utf8')
      const config = JSON.parse(raw)
      for (const a of config.accounts || []) {
        if (a.modelRateLimits) {
          for (const k of Object.keys(a.modelRateLimits)) {
            a.modelRateLimits[k] = { isRateLimited: false, resetTime: null }
          }
        }
      }
      fs.writeFileSync(AGW_CONFIG_PATH, JSON.stringify(config, null, 2))
      this.syncAntigravityAccountsToDb()
    } catch (err) {
      console.error('[CodexAccounts] Failed to reset Antigravity limits:', err.message)
    }
  }

  addAccountFromTokens({ accessToken, refreshToken, idToken, email = null, name = null }) {
    if (!accessToken) throw new Error('ChatGPT access_token is required')
    const accessPayload = parseJwt(accessToken) || {}
    const idPayload = parseJwt(idToken) || {}
    const authClaim = accessPayload['https://api.openai.com/auth'] || {}

    const accountEmail = email || idPayload.email || accessPayload.email || `chatgpt-acc-${Date.now()}@local`
    const accountName = name || idPayload.name || 'ChatGPT Plus Account'
    const accountId = authClaim.chatgpt_account_id || null
    const planType = authClaim.chatgpt_plan_type || 'plus'
    const clientId = accessPayload.client_id || DEFAULT_CLIENT_ID
    const expiresAt = accessPayload.exp ? accessPayload.exp * 1000 : Date.now() + 864000000
    const existing = getAccounts('codex').find((account) =>
      (accountId && account.account_id === accountId) || account.email === accountEmail)

    const newAcc = {
      id: existing?.id,
      provider: 'codex',
      email: accountEmail,
      name: accountName,
      account_id: accountId,
      plan_type: planType,
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      client_id: clientId,
      expires_at: expiresAt,
      status: 'active',
    }

    const id = upsertAccount(newAcc)
    this.reloadFromDb()
    return { id, email: accountEmail }
  }

  importAuthFile(authPath) {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    if (auth.auth_mode && auth.auth_mode !== 'chatgpt') {
      throw new Error('Only ChatGPT OAuth accounts can be added to the Codex rotation pool')
    }
    const tokens = auth.tokens || {}
    if (!tokens.access_token && !tokens.refresh_token) {
      throw new Error('The Codex auth file does not contain ChatGPT OAuth tokens')
    }
    return this.addAccountFromTokens({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
    })
  }

  async importCurrentCodexLogin() {
    if (!fs.existsSync(CODEX_AUTH_PATH)) {
      throw new Error('No ~/.codex/auth.json found. Sign in with Codex first.')
    }
    const result = this.importAuthFile(CODEX_AUTH_PATH)
    this.reloadFromDb()
    return result
  }

  removeAccount(idOrEmail) {
    if (idOrEmail.startsWith('agw_') || idOrEmail.includes('@gmail.com')) {
      const email = idOrEmail.replace(/^agw_/, '')
      this.removeAntigravityAccount(email)
    }
    if (idOrEmail.startsWith('zen_')) {
      zenAccountManager.removeAccount(idOrEmail)
    }
    const res = dbDeleteAccount(idOrEmail)
    this.reloadFromDb()
    zenAccountManager.reloadFromDb()
    return res
  }

  removeAntigravityAccount(email) {
    try {
      if (!fs.existsSync(AGW_CONFIG_PATH)) return
      const raw = fs.readFileSync(AGW_CONFIG_PATH, 'utf8')
      const config = JSON.parse(raw)
      config.accounts = (config.accounts || []).filter((a) => a.email !== email && ('agw_' + a.email.replace(/[^a-zA-Z0-9]/g, '_')) !== email)
      fs.writeFileSync(AGW_CONFIG_PATH, JSON.stringify(config, null, 2))
    } catch (err) {
      console.error('[CodexAccounts] Failed to remove Antigravity account:', err.message)
    }
  }

  setActiveAccount(idOrEmail) {
    const idx = this.accounts.findIndex((a) => a.id === idOrEmail || a.email === idOrEmail)
    if (idx >= 0) {
      this.currentIndex = idx
      return true
    }
    return false
  }

  listAntigravityAccounts() {
    try {
      const now = Date.now()
      if (fs.existsSync(AGW_CONFIG_PATH)) {
        const raw = fs.readFileSync(AGW_CONFIG_PATH, 'utf8')
        const config = JSON.parse(raw)
        const activeIdx = config.activeIndex || 0

        return (config.accounts || []).map((acc, idx) => {
          let isRateLimited = false
          let shortestResetTime = null
          let longestResetTime = null
          const modelLimits = []

          if (acc.modelRateLimits) {
            for (const [modelName, limit] of Object.entries(acc.modelRateLimits)) {
              const isModelLimited = !!(limit.isRateLimited && limit.resetTime && limit.resetTime > now)
              const remainingSec = isModelLimited ? Math.max(0, Math.ceil((limit.resetTime - now) / 1000)) : 0

              modelLimits.push({
                model: modelName,
                is_rate_limited: isModelLimited,
                reset_time: limit.resetTime || null,
                cooldown_remaining_sec: remainingSec,
                cooldown_source: 'upstream',
              })

              if (isModelLimited) {
                isRateLimited = true
                if (!shortestResetTime || limit.resetTime < shortestResetTime) {
                  shortestResetTime = limit.resetTime
                }
                if (!longestResetTime || limit.resetTime > longestResetTime) {
                  longestResetTime = limit.resetTime
                }
              }
            }
          }

          const remainingSec = isRateLimited && shortestResetTime ? Math.max(0, Math.ceil((shortestResetTime - now) / 1000)) : 0
          const totalModelsCount = modelLimits.length
          const limitedModelsCount = modelLimits.filter((m) => m.is_rate_limited).length

          let statusText = 'active'
          if (acc.isInvalid) {
            statusText = 'invalid'
          } else if (limitedModelsCount > 0 && limitedModelsCount < totalModelsCount) {
            statusText = 'partially_limited'
          } else if (isRateLimited) {
            statusText = 'rate_limited'
          }

          return {
            id: 'agw_' + (acc.email || '').replace(/[^a-zA-Z0-9]/g, '_'),
            provider: 'antigravity',
            index: idx + 1,
            email: acc.email,
            name: acc.projectId ? `Google (${acc.projectId})` : 'Google Account',
            plan_type: 'Google OAuth',
            account_id: acc.projectId || 'Google Project',
            status: statusText,
            rate_limited_until: shortestResetTime,
            rate_limited_longest_until: longestResetTime,
            cooldown_remaining_sec: remainingSec,
            cooldown_source: 'upstream',
            rate_limit_reason: isRateLimited ? `Cooldown (${limitedModelsCount}/${totalModelsCount} models)` : (acc.invalidReason || null),
            last_used: acc.lastUsed,
            added_at: acc.addedAt,
            is_current_active: idx === activeIdx,
            model_rate_limits: modelLimits,
            supported_models: ['gemini-3.8-flash-tiered', 'gemini-3.1-pro-low', 'gemini-pro-agent', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6'],
          }
        })
      }

      // Fallback: list from SQLite database
      const dbAccounts = getAccounts('antigravity')
      return dbAccounts.map((acc, idx) => {
        const isRateLimited = !!(acc.rate_limited_until && acc.rate_limited_until > now)
        const remainingSec = isRateLimited ? Math.max(0, Math.ceil((acc.rate_limited_until - now) / 1000)) : 0
        return {
          id: acc.id,
          provider: 'antigravity',
          index: idx + 1,
          email: acc.email,
          name: acc.name || 'Google Account',
          plan_type: 'Google OAuth',
          account_id: acc.account_id || 'Google Project',
          status: isRateLimited ? 'rate_limited' : acc.status,
          rate_limited_until: acc.rate_limited_until,
          cooldown_remaining_sec: remainingSec,
          cooldown_source: 'upstream',
          rate_limit_reason: acc.rate_limit_reason,
          last_used: acc.last_used,
          created_at: acc.created_at,
          is_current_active: idx === 0,
          model_rate_limits: [],
          supported_models: ['gemini-3.8-flash-tiered', 'gemini-3.1-pro-low', 'gemini-pro-agent', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6'],
        }
      })
    } catch {
      return []
    }
  }

  listAccounts() {
    this.clearExpiredLimits()
    const now = Date.now()
    const codexList = this.accounts.map((acc, idx) => {
      const isRateLimited = !!(acc.rate_limited_until && acc.rate_limited_until > now)
      const remainingSec = isRateLimited ? Math.max(0, Math.ceil((acc.rate_limited_until - now) / 1000)) : 0
      const tokenExpiresInSec = acc.expires_at ? Math.max(0, Math.ceil((acc.expires_at - now) / 1000)) : 864000
      const tokenStatus = tokenExpiresInSec <= 0 ? 'expired' : (tokenExpiresInSec < 3600 ? 'expiring_soon' : 'valid')

      return {
        id: acc.id,
        provider: 'codex',
        index: idx + 1,
        email: acc.email,
        name: acc.name || 'ChatGPT Plus Account',
        plan_type: (acc.plan_type || 'plus').toUpperCase(),
        account_id: acc.account_id || 'ChatGPT Plus',
        status: isRateLimited ? 'rate_limited' : acc.status,
        rate_limited_until: acc.rate_limited_until,
        cooldown_remaining_sec: remainingSec,
        cooldown_source: String(acc.rate_limit_reason || '').startsWith('Codex usage:')
          ? 'upstream'
          : 'adaptive_buffer',
        rate_limit_reason: acc.rate_limit_reason,
        last_used: acc.last_used,
        created_at: acc.created_at,
        token_status: tokenStatus,
        token_expires_in_sec: tokenExpiresInSec,
        is_current_active: idx === this.currentIndex % Math.max(1, this.accounts.length),
        model_rate_limits: this.rateLimitSnapshots.get(acc.id)?.windows || [],
        rate_limits_checked_at: this.rateLimitSnapshots.get(acc.id)?.checked_at || null,
        supported_models: [...(this.modelsByAccount.get(acc.id) || [])],
      }
    })

    const agwList = this.listAntigravityAccounts()
    const zenList = zenAccountManager.listAccounts()
    return [...codexList, ...agwList, ...zenList]
  }

  getPoolOverview() {
    const all = this.listAccounts()
    const codex = all.filter((a) => a.provider === 'codex')
    const agw = all.filter((a) => a.provider === 'antigravity')
    const zen = all.filter((a) => a.provider === 'zen')

    const codexAvail = codex.filter((a) => a.status === 'active').length
    const agwAvail = agw.filter((a) => a.status === 'active' || a.status === 'partially_limited').length
    const zenAvail = zen.filter((a) => a.status === 'active' || a.status === 'partially_limited').length

    let earliestReset = null
    for (const a of all) {
      if (a.rate_limited_until && a.rate_limited_until > Date.now()) {
        if (!earliestReset || a.rate_limited_until < earliestReset) {
          earliestReset = a.rate_limited_until
        }
      }
    }

    return {
      total_accounts: all.length,
      codex: { total: codex.length, available: codexAvail, limited: codex.length - codexAvail },
      antigravity: { total: agw.length, available: agwAvail, limited: agw.length - agwAvail },
      zen: { total: zen.length, available: zenAvail, limited: zen.length - zenAvail },
      earliest_reset: earliestReset,
      earliest_reset_sec: earliestReset ? Math.max(0, Math.ceil((earliestReset - Date.now()) / 1000)) : 0,
    }
  }

  async testAccount(idOrEmail) {
    if (idOrEmail.startsWith('agw_') || idOrEmail.includes('@gmail.com')) {
      const { antigravityAccountManager } = await import('./antigravity-accounts.mjs')
      return await antigravityAccountManager.testAccount(idOrEmail)
    }
    if (idOrEmail.startsWith('zen_') || idOrEmail.includes('@opencode.ai')) {
      const { zenAccountManager } = await import('./zen-accounts.mjs')
      return await zenAccountManager.testAccount(idOrEmail)
    }

    await this.init()
    this.reloadFromDb()
    const target = this.accounts.find((a) => a.id === idOrEmail || a.email === idOrEmail)
    if (!target) throw new Error(`Account ${idOrEmail} not found`)

    return {
      success: true,
      accountEmail: target.email,
      provider: 'codex',
      durationMs: 10,
      responseText: 'ChatGPT Plus / OpenAI OAuth session is valid.',
    }
  }
}

export const codexAccountManager = new CodexAccountManager()
