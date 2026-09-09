import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexAppServerClient } from './codex-app-server.mjs'
import { codexAccountManager } from './codex-accounts.mjs'

const LOGIN_ROOT = process.env.CODEX_LOGIN_HOME_ROOT
  || path.join(os.homedir(), '.zen-claude', 'login-sessions')
const LOGIN_TTL_MS = Number(process.env.CODEX_LOGIN_TTL_MS || 600_000)

class CodexLoginManager {
  constructor() {
    this.sessions = new Map()
  }

  async start(method = 'browser') {
    if (!['browser', 'device'].includes(method)) throw new Error('Login method must be browser or device')
    fs.mkdirSync(LOGIN_ROOT, { recursive: true, mode: 0o700 })
    const sessionId = randomUUID()
    const codexHome = fs.mkdtempSync(path.join(LOGIN_ROOT, 'login-'))
    fs.chmodSync(codexHome, 0o700)
    const client = new CodexAppServerClient({
      codexHome,
      debug: process.env.CODEX_DEBUG === '1',
      requestTimeoutMs: LOGIN_TTL_MS,
    })
    const session = {
      id: sessionId,
      method,
      codexHome,
      client,
      loginId: null,
      status: 'starting',
      createdAt: Date.now(),
      authUrl: null,
      verificationUrl: null,
      userCode: null,
      account: null,
      error: null,
      timer: null,
    }
    this.sessions.set(sessionId, session)

    client.on('notification', (message) => {
      if (message.method !== 'account/login/completed') return
      const params = message.params || {}
      if (session.loginId && params.loginId && params.loginId !== session.loginId) return
      this.#complete(session, params).catch((error) => this.#fail(session, error))
    })
    client.on('fatal', (error) => {
      if (!['completed', 'cancelled', 'failed'].includes(session.status)) this.#fail(session, error)
    })

    try {
      await client.start()
      const response = await client.request('account/login/start', {
        type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt',
      })
      session.loginId = response.loginId
      session.authUrl = response.authUrl || null
      session.verificationUrl = response.verificationUrl || null
      session.userCode = response.userCode || null
      session.status = 'waiting'
      session.timer = setTimeout(() => this.cancel(sessionId, 'Login expired'), LOGIN_TTL_MS)
      session.timer.unref?.()
      return this.publicSession(session)
    } catch (error) {
      this.#fail(session, error)
      throw error
    }
  }

  get(id) {
    const session = this.sessions.get(id)
    return session ? this.publicSession(session) : null
  }

  async cancel(id, reason = 'Login cancelled') {
    const session = this.sessions.get(id)
    if (!session) return false
    if (session.loginId && session.status === 'waiting') {
      try { await session.client.request('account/login/cancel', { loginId: session.loginId }) } catch {}
    }
    session.status = 'cancelled'
    session.error = reason
    this.#cleanup(session)
    return true
  }

  publicSession(session) {
    return {
      id: session.id,
      method: session.method,
      status: session.status,
      authUrl: session.authUrl,
      verificationUrl: session.verificationUrl,
      userCode: session.userCode,
      account: session.account,
      error: session.error,
      createdAt: session.createdAt,
    }
  }

  async #complete(session, params) {
    if (!params.success) throw new Error(params.error || 'ChatGPT sign-in failed')
    const authPath = path.join(session.codexHome, 'auth.json')
    if (!fs.existsSync(authPath)) throw new Error('Codex completed login but did not create auth.json')
    session.account = codexAccountManager.importAuthFile(authPath)
    session.status = 'completed'
    this.#cleanup(session)
  }

  #fail(session, error) {
    session.status = 'failed'
    session.error = error?.message || String(error)
    this.#cleanup(session)
  }

  #cleanup(session) {
    if (session.timer) clearTimeout(session.timer)
    session.timer = null
    session.client.stop()
    const resolvedRoot = path.resolve(LOGIN_ROOT) + path.sep
    const resolvedHome = path.resolve(session.codexHome)
    if (resolvedHome.startsWith(resolvedRoot)) {
      try { fs.rmSync(resolvedHome, { recursive: true, force: true }) } catch {}
    }
    setTimeout(() => this.sessions.delete(session.id), 60_000).unref?.()
  }
}

export const codexLoginManager = new CodexLoginManager()
