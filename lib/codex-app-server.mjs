import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { codexAccountManager } from './codex-accounts.mjs'
import {
  anthropicToCodexInput,
  anthropicToolsToDynamic,
  buildCodexInstructions,
  codexInputCharacterCount,
  extractClaudeWorkingDirectory,
  normalizeToolArguments,
  toolResultContentItems,
} from './anthropic-codex.mjs'

const DISABLED_CODEX_FEATURES = [
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'multi_agent',
  'plugins',
  'recommended_plugins',
  'shell_tool',
  'skill_search',
  'tool_suggest',
  'unified_exec',
  'view_image',
  'workspace_dependencies',
]

function resolveCodexCommand() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN
  for (const candidate of [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
  ]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return 'codex'
}

const DEFAULT_CODEX_COMMAND = resolveCodexCommand()

const CODEX_APP_SERVER_MAX_INPUT_CHARS = 1_048_576
const DEFAULT_INPUT_SAFETY_RESERVE_CHARS = 64 * 1024

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

const DEFAULT_MAX_INPUT_CHARS = Math.min(
  CODEX_APP_SERVER_MAX_INPUT_CHARS - DEFAULT_INPUT_SAFETY_RESERVE_CHARS,
  positiveInteger(process.env.CODEX_MAX_INPUT_CHARS, 900 * 1024),
)
const DEFAULT_MAX_INITIAL_INPUT_CHARS = positiveInteger(
  process.env.CODEX_MAX_INITIAL_INPUT_CHARS,
  640 * 1024,
)
const DEFAULT_MAX_TOOL_RESULT_CHARS = positiveInteger(
  process.env.CODEX_MAX_TOOL_RESULT_CHARS,
  200 * 1024,
)

const MODEL_ADAPTER_INSTRUCTIONS = `
You are the reasoning engine behind Claude Code. Claude Code is the only tool
harness and the only process allowed to touch the user's machine.

Use the dynamic tools registered by the client. When work requires a
tool, call the matching dynamic tool with structured JSON arguments and wait
for its result. Never use or request built-in Codex shell, browser, MCP, app,
skill, or sub-agent tools. Native apply_patch is the only built-in exception
and may be used only when workspace-write is enabled. Continue reasoning after
each tool result until you can answer or need another tool.

The app-server sandbox mirrors the tools supplied by Claude Code. When Claude
Code supplies Edit or Write, the thread receives workspace-write access scoped
to the stated project cwd, so native apply_patch may also edit that workspace.
Otherwise the thread remains read-only. Never interpret the sandbox label as a
reason to refuse an available outer dynamic tool.
Use Claude Code's stated primary working directory for every dynamic-tool path.
Do not write outside that working directory.
`.trim()

const WRITING_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit'])

export function codexSandboxForTools(dynamicTools = [], configured = process.env.CODEX_SANDBOX_MODE || 'auto') {
  if (configured === 'read-only' || configured === 'workspace-write') return configured
  return dynamicTools.some((tool) => WRITING_TOOL_NAMES.has(tool?.name))
    ? 'workspace-write'
    : 'read-only'
}

export function extractToolResults(messages = []) {
  const results = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool_result' && block.tool_use_id) results.push(block)
    }
  }
  return results
}

export class CodexAppServerClient extends EventEmitter {
  constructor({ codexHome, account = null, debug = false, command = DEFAULT_CODEX_COMMAND, requestTimeoutMs = 300_000 } = {}) {
    super()
    this.codexHome = codexHome
    this.account = account
    this.debug = debug
    this.command = command
    this.requestTimeoutMs = requestTimeoutMs
    this.proc = null
    this.nextRequestId = 1
    this.pendingRequests = new Map()
    this.stdoutBuffer = ''
    this.stderrBuffer = ''
    this.closed = false
  }

  async start() {
    if (this.proc) return
    const args = ['app-server', '--stdio']
    for (const feature of DISABLED_CODEX_FEATURES) args.push('--disable', feature)

    this.proc = spawn(this.command, args, {
      env: {
        ...process.env,
        CODEX_HOME: this.codexHome,
        CI: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout.on('data', (chunk) => this.#onStdout(chunk))
    this.proc.stderr.on('data', (chunk) => {
      this.stderrBuffer = (this.stderrBuffer + chunk.toString()).slice(-32_000)
      if (this.debug) process.stderr.write(`[CodexAppServer] ${chunk}`)
    })
    this.proc.on('error', (error) => this.#closeWithError(error))
    this.proc.on('close', (code, signal) => {
      if (this.closed) return
      const detail = this.stderrBuffer.trim()
      this.#closeWithError(new Error(
        `Codex app-server exited (${signal || code})${detail ? `: ${detail}` : ''}`,
      ))
    })

    await this.request('initialize', {
      clientInfo: { name: 'claude-zen', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.notify('initialized')
  }

  request(method, params = {}) {
    if (!this.proc?.stdin?.writable) return Promise.reject(new Error('Codex app-server is not running'))
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pendingRequests.set(id, { resolve, reject, timer, method })
      this.#write({ id, method, params })
    })
  }

  notify(method, params) {
    this.#write(params === undefined ? { method } : { method, params })
  }

  respond(id, result) {
    this.#write({ id, result })
  }

  respondError(id, message, code = -32000) {
    this.#write({ id, error: { code, message } })
  }

  stop() {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Codex app-server stopped'))
    }
    this.pendingRequests.clear()
    this.proc?.kill('SIGTERM')
    this.proc = null
  }

  #write(message) {
    if (!this.proc?.stdin?.writable) throw new Error('Codex app-server stdin is closed')
    this.proc.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #onStdout(chunk) {
    this.stdoutBuffer += chunk.toString()
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        this.#onMessage(JSON.parse(line))
      } catch (error) {
        if (this.debug) console.error('[CodexAppServer] Invalid JSON:', line, error)
      }
    }
  }

  #onMessage(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pendingRequests.get(message.id)
      if (!pending) return
      this.pendingRequests.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        const error = new Error(message.error.message || `Codex app-server request failed: ${pending.method}`)
        error.code = message.error.code
        error.data = message.error.data
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.method === 'item/tool/call' && message.id !== undefined) {
      this.emit('tool-call', { rpcId: message.id, ...message.params })
      return
    }
    if (message.method === 'account/chatgptAuthTokens/refresh' && message.id !== undefined) {
      if (this.account?.access_token && this.account?.account_id) {
        this.respond(message.id, {
          accessToken: this.account.access_token,
          chatgptAccountId: this.account.account_id,
          chatgptPlanType: this.account.plan_type || null,
        })
      } else {
        this.respondError(message.id, 'No refreshed ChatGPT token is available', -32001)
      }
      return
    }
    if (message.id !== undefined && message.method) {
      this.respondError(message.id, 'Claude Code owns tool execution for this gateway', -32601)
      return
    }
    this.emit('notification', message)
  }

  #closeWithError(error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingRequests.clear()
    this.emit('fatal', error)
  }
}

export class AppServerTurnSession {
  constructor({
    client,
    threadId,
    turnId,
    account,
    registry,
    boundaryDelayMs = 30,
    turnTimeoutMs = 300_000,
    pendingToolTtlMs = 900_000,
    inputChars = 0,
    maxInputChars = DEFAULT_MAX_INPUT_CHARS,
    maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
  }) {
    this.client = client
    this.threadId = threadId
    this.turnId = turnId
    this.account = account
    this.accountEmail = account?.email
    this.registry = registry
    this.boundaryDelayMs = boundaryDelayMs
    this.turnTimeoutMs = turnTimeoutMs
    this.pendingToolTtlMs = pendingToolTtlMs
    this.inputChars = inputChars
    this.maxInputChars = maxInputChars
    this.maxToolResultChars = maxToolResultChars
    this.pendingToolCalls = new Map()
    this.exposedToolCallIds = new Set()
    this.replyText = ''
    this.deltaItemIds = new Set()
    this.usage = { inputTokens: 0, outputTokens: 0 }
    this.waiter = null
    this.boundaryTimer = null
    this.turnTimer = null
    this.idleTimer = null
    this.finished = false
    this.onNotification = (message) => this.#onNotification(message)
    this.onToolCall = (call) => this.#onToolCall(call)
    this.onFatal = (error) => this.#reject(error)
    client.on('notification', this.onNotification)
    client.on('tool-call', this.onToolCall)
    client.on('fatal', this.onFatal)
  }

  waitForBoundary(streamHandlers = null) {
    if (this.waiter) throw new Error('A Codex turn boundary is already being awaited')
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject, streamHandlers }
      this.turnTimer = setTimeout(() => this.#reject(new Error('Codex turn timed out')), this.turnTimeoutMs)
      this.turnTimer.unref?.()
    })
  }

  async resume(toolResults, streamHandlers = null) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const resultIds = new Set(toolResults.map((result) => result.tool_use_id))
    for (const callId of this.exposedToolCallIds) {
      if (!resultIds.has(callId)) throw new Error(`Missing tool_result for ${callId}`)
    }

    const boundary = this.waitForBoundary(streamHandlers)
    const answered = []
    for (const result of toolResults) {
      const pending = this.pendingToolCalls.get(result.tool_use_id)
      if (!pending) continue
      const remainingChars = Math.max(0, this.maxInputChars - this.inputChars)
      const resultBudget = Math.min(remainingChars, this.maxToolResultChars)
      const contentItems = toolResultContentItems(result, { maxTextChars: resultBudget })
      this.inputChars += codexInputCharacterCount(contentItems)
      this.client.respond(pending.rpcId, {
        success: !result.is_error,
        contentItems,
      })
      this.pendingToolCalls.delete(result.tool_use_id)
      this.exposedToolCallIds.delete(result.tool_use_id)
      this.registry.pendingByToolId.delete(result.tool_use_id)
      answered.push(result.tool_use_id)
    }
    if (!answered.length) {
      this.#reject(new Error('No matching pending Codex tool calls were found'))
      return boundary
    }
    if ([...this.pendingToolCalls.keys()].some((callId) => !this.exposedToolCallIds.has(callId))) {
      this.#scheduleToolBoundary()
    }
    return boundary
  }

  dispose() {
    if (this.finished) return
    this.finished = true
    if (this.boundaryTimer) clearTimeout(this.boundaryTimer)
    if (this.turnTimer) clearTimeout(this.turnTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const callId of this.pendingToolCalls.keys()) this.registry.pendingByToolId.delete(callId)
    this.pendingToolCalls.clear()
    this.exposedToolCallIds.clear()
    this.client.off('notification', this.onNotification)
    this.client.off('tool-call', this.onToolCall)
    this.client.off('fatal', this.onFatal)
    this.client.stop()
    this.registry.sessions.delete(this)
  }

  #onToolCall(call) {
    if (call.threadId !== this.threadId) return
    if (this.turnId && call.turnId !== this.turnId) return
    if (!this.turnId) this.turnId = call.turnId
    this.pendingToolCalls.set(call.callId, call)
    this.registry.pendingByToolId.set(call.callId, this)
    this.#scheduleToolBoundary()
  }

  #scheduleToolBoundary() {
    if (this.boundaryTimer) clearTimeout(this.boundaryTimer)
    this.boundaryTimer = setTimeout(() => this.#resolveToolBoundary(), this.boundaryDelayMs)
  }

  #onNotification(message) {
    const params = message.params || {}
    if (params.threadId && params.threadId !== this.threadId) return
    if (this.turnId && params.turnId && params.turnId !== this.turnId) return
    if (!this.turnId && params.turnId) this.turnId = params.turnId

    if (message.method === 'item/agentMessage/delta') {
      this.deltaItemIds.add(params.itemId)
      const delta = params.delta || ''
      this.replyText += delta
      this.waiter?.streamHandlers?.onTextDelta?.(delta)
      return
    }
    if (message.method === 'item/completed') {
      const item = params.item
      if (item?.type === 'agentMessage' && !this.deltaItemIds.has(item.id)) {
        const text = item.text || ''
        this.replyText += text
        this.waiter?.streamHandlers?.onTextDelta?.(text)
      }
      return
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage?.last || params.tokenUsage?.total
      if (usage) {
        this.usage = {
          inputTokens: usage.inputTokens || 0,
          outputTokens: usage.outputTokens || 0,
        }
      }
      return
    }
    if (message.method === 'error') {
      if (params.willRetry) return
      const error = new Error(params.error?.message || params.message || 'Codex app-server error')
      error.codexErrorInfo = params.error?.codexErrorInfo || null
      this.#reject(error)
      return
    }
    if (message.method === 'turn/completed') {
      if (params.turn?.status === 'failed') {
        this.#reject(new Error(params.turn.error?.message || 'Codex turn failed'))
      } else if (this.pendingToolCalls.size === 0) {
        this.#resolve({ toolCalls: [] })
        this.dispose()
      }
    }
  }

  #resolveToolBoundary() {
    this.boundaryTimer = null
    if (!this.waiter) return
    const unexposedCalls = [...this.pendingToolCalls.values()]
      .filter((call) => !this.exposedToolCallIds.has(call.callId))
    if (!unexposedCalls.length) return
    const toolCalls = unexposedCalls.map((call) => ({
      type: 'tool_use',
      id: call.callId,
      name: call.tool,
      input: normalizeToolArguments(call.arguments),
    }))
    for (const call of unexposedCalls) this.exposedToolCallIds.add(call.callId)
    this.waiter.streamHandlers?.onToolCalls?.(toolCalls)
    this.#resolve({ toolCalls })
    if (!this.waiter) {
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.idleTimer = setTimeout(() => this.dispose(), this.pendingToolTtlMs)
      this.idleTimer.unref?.()
    }
  }

  #resolve({ toolCalls }) {
    if (!this.waiter) return
    const waiter = this.waiter
    this.waiter = null
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = null
    const replyText = this.replyText
    this.replyText = ''
    this.deltaItemIds.clear()
    waiter.resolve({
      replyText,
      toolCalls,
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      accountEmail: this.accountEmail,
      session: toolCalls.length ? this : null,
    })
  }

  #reject(error) {
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      if (this.turnTimer) clearTimeout(this.turnTimer)
      this.turnTimer = null
      waiter.reject(error)
    }
    this.dispose()
  }
}

export class CodexHarnessAdapter {
  constructor({
    debug = false,
    command = DEFAULT_CODEX_COMMAND,
    turnTimeoutMs = 300_000,
    pendingToolTtlMs = 900_000,
    maxInputChars = DEFAULT_MAX_INPUT_CHARS,
    maxInitialInputChars = DEFAULT_MAX_INITIAL_INPUT_CHARS,
    maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
  } = {}) {
    this.debug = debug
    this.command = command
    this.turnTimeoutMs = turnTimeoutMs
    this.pendingToolTtlMs = pendingToolTtlMs
    this.maxInputChars = Math.min(maxInputChars, CODEX_APP_SERVER_MAX_INPUT_CHARS)
    this.maxInitialInputChars = Math.min(maxInitialInputChars, this.maxInputChars)
    this.maxToolResultChars = Math.min(maxToolResultChars, this.maxInputChars)
    this.pendingByToolId = new Map()
    this.sessions = new Set()
  }

  findSession(toolResults) {
    const sessions = new Set()
    for (const result of toolResults) {
      const session = this.pendingByToolId.get(result.tool_use_id)
      if (session) sessions.add(session)
    }
    return sessions.size === 1 ? [...sessions][0] : null
  }

  async execute({ body, model, codexHome, account, cwd = process.cwd(), streamHandlers = null }) {
    const toolResults = extractToolResults(body.messages)
    const existing = this.findSession(toolResults)
    if (existing) return existing.resume(toolResults, streamHandlers)

    const client = new CodexAppServerClient({
      codexHome,
      account,
      debug: this.debug,
      command: this.command,
      requestTimeoutMs: this.turnTimeoutMs,
    })
    await client.start()

    const baseInstructions = buildCodexInstructions(body)
    const dynamicTools = anthropicToolsToDynamic(body.tools, body.tool_choice)
    const sandbox = codexSandboxForTools(dynamicTools)
    const instructionChars = baseInstructions.length + MODEL_ADAPTER_INSTRUCTIONS.length + JSON.stringify(dynamicTools).length
    const initialInputBudget = Math.max(
      0,
      Math.min(this.maxInitialInputChars, this.maxInputChars - instructionChars),
    )
    const input = anthropicToCodexInput(body, { maxTextChars: initialInputBudget })
    const inputChars = instructionChars + codexInputCharacterCount(input)

    const threadResponse = await client.request('thread/start', {
      model,
      cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox,
      baseInstructions,
      developerInstructions: MODEL_ADAPTER_INSTRUCTIONS,
      dynamicTools,
      config: {
        mcp_servers: {},
        web_search: 'disabled',
      },
    })
    const threadId = threadResponse.thread.id
    const session = new AppServerTurnSession({
      client,
      threadId,
      turnId: null,
      account,
      registry: this,
      turnTimeoutMs: this.turnTimeoutMs,
      pendingToolTtlMs: this.pendingToolTtlMs,
      inputChars,
      maxInputChars: this.maxInputChars,
      maxToolResultChars: this.maxToolResultChars,
    })
    this.sessions.add(session)
    const boundary = session.waitForBoundary(streamHandlers)
    try {
      const turnResponse = await client.request('turn/start', {
        threadId,
        model,
        input,
        effort: body.claude_zen?.reasoning_effort || process.env.CODEX_REASONING_EFFORT || 'medium',
        summary: 'none',
      })
      session.turnId ||= turnResponse.turn.id
      return boundary
    } catch (error) {
      session.dispose()
      throw error
    }
  }

  close() {
    for (const session of [...this.sessions]) session.dispose()
  }
}

export class CodexAppServerBridge {
  constructor(options = {}) {
    this.adapter = new CodexHarnessAdapter(options)
  }

  continuationAccount(body) {
    const session = this.adapter.findSession(extractToolResults(body.messages))
    return session?.account || null
  }

  async execute(body, account, { streamHandlers = null } = {}) {
    const model = body.model || 'gpt-5.6-sol'
    const codexHome = this.continuationAccount(body)
      ? null
      : codexAccountManager.materializeCodexHome(account)
    const requestedCwd = extractClaudeWorkingDirectory(body.system)
    let cwd = process.cwd()
    if (requestedCwd && path.isAbsolute(requestedCwd)) {
      try {
        cwd = fs.realpathSync(requestedCwd)
      } catch {
        cwd = requestedCwd
      }
    }
    const result = await this.adapter.execute({
      body,
      model,
      codexHome,
      account,
      cwd,
      streamHandlers,
    })
    return {
      type: result.toolCalls.length ? 'tool_use' : 'message',
      text: result.replyText,
      toolCalls: result.toolCalls,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      },
    }
  }

  async readRateLimits(account) {
    await codexAccountManager.ensureFreshToken(account)
    const client = new CodexAppServerClient({
      codexHome: codexAccountManager.materializeCodexHome(account),
      debug: process.env.CODEX_DEBUG === '1',
      requestTimeoutMs: 30_000,
    })
    try {
      await client.start()
      return await client.request('account/rateLimits/read', {})
    } finally {
      client.stop()
    }
  }

  async listModels(account, { includeHidden = false } = {}) {
    await codexAccountManager.ensureFreshToken(account)
    const client = new CodexAppServerClient({
      codexHome: codexAccountManager.materializeCodexHome(account),
      debug: process.env.CODEX_DEBUG === '1',
      requestTimeoutMs: 30_000,
    })
    try {
      await client.start()
      const models = []
      let cursor = null
      do {
        const response = await client.request('model/list', { cursor, limit: 100, includeHidden })
        models.push(...(response.data || []))
        cursor = response.nextCursor || null
      } while (cursor)
      return models
    } finally {
      client.stop()
    }
  }

  close() {
    this.adapter.close()
  }
}

export const codexAppServerBridge = new CodexAppServerBridge({
  debug: process.env.CODEX_DEBUG === '1',
  turnTimeoutMs: Number(process.env.CODEX_TURN_TIMEOUT_MS || 300_000),
  pendingToolTtlMs: Number(process.env.CODEX_PENDING_TOOL_TTL_MS || 900_000),
})
