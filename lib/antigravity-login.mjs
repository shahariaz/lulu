import http from 'node:http'
import crypto, { randomUUID } from 'node:crypto'
import { antigravityAccountManager, OAUTH_CONFIG, OAUTH_REDIRECT_URI } from './antigravity-accounts.mjs'

const LOGIN_TTL_MS = Number(process.env.ANTIGRAVITY_LOGIN_TTL_MS || 300_000)

export class AntigravityLoginManager {
  constructor() {
    this.sessions = new Map()
  }

  async start() {
    // Cancel any in-flight sessions to cleanly free callback port
    for (const [id, s] of this.sessions.entries()) {
      if (s.status === 'waiting') {
        await this.cancel(id, 'Replaced by a new login attempt')
      }
    }

    const sessionId = randomUUID()
    const { verifier, challenge } = antigravityAccountManager.constructor.generatePKCE()
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

    const session = {
      id: sessionId,
      provider: 'antigravity',
      method: 'browser',
      status: 'waiting',
      authUrl,
      verifier,
      state,
      account: null,
      error: null,
      createdAt: Date.now(),
      server: null,
      timer: null,
    }

    this.sessions.set(sessionId, session)

    // Start local callback listener on port 51121
    await this.#startCallbackServer(session)

    session.timer = setTimeout(() => this.cancel(sessionId, 'Login session expired'), LOGIN_TTL_MS)
    session.timer.unref?.()

    return this.publicSession(session)
  }

  async #startCallbackServer(session) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
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
            res.end(this.#renderErrorPage(`Google authentication failed: ${errorDescription || error}`))
            this.#fail(session, new Error(errorDescription || error))
            return
          }

          if (!code || callbackState !== session.state) {
            res.writeHead(400, { 'Content-Type': 'text/html' })
            res.end(this.#renderErrorPage('Invalid authorization state or missing code.'))
            this.#fail(session, new Error('State mismatch or missing authorization code'))
            return
          }

          // Exchange code for tokens
          const tokenRes = await fetch(OAUTH_CONFIG.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: OAUTH_CONFIG.clientId,
              client_secret: OAUTH_CONFIG.clientSecret,
              code,
              grant_type: 'authorization_code',
              redirect_uri: OAUTH_REDIRECT_URI,
              code_verifier: session.verifier,
            }),
          })

          if (!tokenRes.ok) {
            const errText = await tokenRes.text()
            throw new Error(`Token exchange failed (${tokenRes.status}): ${errText}`)
          }

          const tokenData = await tokenRes.json()
          const refreshToken = tokenData.refresh_token
          const accessToken = tokenData.access_token

          // Fetch user info for email
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

          // Discover project
          let projectId = null
          if (accessToken) {
            try {
              projectId = await antigravityAccountManager.getProjectForAccount({ email: accountEmail }, accessToken)
            } catch {}
          }

          const account = await antigravityAccountManager.addAccountFromRefreshToken({
            refreshToken: refreshToken || accessToken,
            email: accountEmail,
            projectId,
          })

          session.account = account
          session.status = 'completed'

          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end(this.#renderSuccessPage(accountEmail))
          this.#cleanup(session)
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html' })
          res.end(this.#renderErrorPage(err.message))
          this.#fail(session, err)
        }
      })

      server.on('error', (err) => {
        if (session.status === 'waiting') {
          this.#fail(session, new Error(`Could not start OAuth listener on port ${OAUTH_CONFIG.callbackPort}: ${err.message}`))
        }
        reject(err)
      })

      server.listen(OAUTH_CONFIG.callbackPort, '127.0.0.1', () => {
        session.server = server
        resolve()
      })
    })
  }

  get(id) {
    const session = this.sessions.get(id)
    return session ? this.publicSession(session) : null
  }

  async cancel(id, reason = 'Login cancelled') {
    const session = this.sessions.get(id)
    if (!session) return false
    session.status = 'cancelled'
    session.error = reason
    this.#cleanup(session)
    return true
  }

  #fail(session, error) {
    session.status = 'failed'
    session.error = error?.message || String(error)
    this.#cleanup(session)
  }

  #cleanup(session) {
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    if (session.server) {
      try { session.server.close() } catch {}
      session.server = null
    }
  }

  publicSession(session) {
    return {
      id: session.id,
      provider: 'antigravity',
      method: session.method,
      status: session.status,
      authUrl: session.authUrl,
      account: session.account,
      error: session.error,
      createdAt: session.createdAt,
    }
  }

  #renderSuccessPage(email) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Google Account Connected - Claude-Zen</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #e6edf3; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 36px 40px; text-align: center; max-width: 440px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    .icon { font-size: 44px; margin-bottom: 12px; }
    h2 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
    p { margin: 0 0 16px; font-size: 14px; color: #8b949e; line-height: 1.5; }
    .email { color: #58a6ff; font-weight: 600; }
    .close-hint { font-size: 13px; color: #3fb950; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h2>Google Account Connected!</h2>
    <p>Account <span class="email">${escapeHtml(email)}</span> has been added to your Claude-Zen Antigravity pool.</p>
    <div class="close-hint">You can safely close this tab and return to Claude-Zen.</div>
  </div>
</body>
</html>`
  }

  #renderErrorPage(error) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authentication Error - Claude-Zen</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #e6edf3; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #f85149; border-radius: 12px; padding: 36px 40px; text-align: center; max-width: 440px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    .icon { font-size: 44px; margin-bottom: 12px; }
    h2 { margin: 0 0 8px; font-size: 20px; font-weight: 600; color: #f85149; }
    p { margin: 0 0 16px; font-size: 14px; color: #8b949e; line-height: 1.5; }
    .err-msg { background: #21262d; padding: 8px 12px; border-radius: 6px; font-family: monospace; font-size: 12px; color: #ff7b72; word-break: break-word; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">❌</div>
    <h2>Authentication Failed</h2>
    <p>Could not connect Google account:</p>
    <div class="err-msg">${escapeHtml(error)}</div>
  </div>
</body>
</html>`
  }
}

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export const antigravityLoginManager = new AntigravityLoginManager()
