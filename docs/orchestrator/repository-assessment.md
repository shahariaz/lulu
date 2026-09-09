# Repository Assessment: Claude-Zen Architecture & Discovery

**Document Status:** Revision 1 — Grounded Audit & Gap Analysis  
**Date:** 2026-09-09  
**Repository Working Directory:** `/Users/sar/shahariaz/claude-zen`  
**Git Working Tree Status:** Non-git directory (No `.git` metadata in working root; verified via `git status` exit code 128)  

---

## 1. Executive Summary

This assessment provides an evidence-based architectural audit of the Claude-Zen codebase to establish the baseline for building an autonomous, self-hosted AI software delivery platform.

The existing Claude-Zen codebase is **not** an autonomous delivery orchestrator. It is a **multi-provider reverse proxy, protocol translation bridge, and credential rotation manager** built to run Anthropic's official Claude Code CLI against alternative model backends (Google Cloud Code / Gemini, OpenAI ChatGPT Plus / Codex, and OpenCode Zen).

The repository provides production-quality components for provider format translation, streaming SSE conversion, OAuth token lifecycle management, and rate-limit cooldown failovers. However, it completely lacks the control plane required for software delivery: project registries, branch/worktree isolation, deterministic task state machines, role-based tool restrictions, automated verification gates, and diff review mechanisms.

---

## 2. Current System Architecture

The existing implementation consists of five primary layers:

```
                                  ┌─────────────────────────────────┐
                                  │      Claude Code CLI Tool       │
                                  │ (started via bin/claude-zen)    │
                                  └────────────────┬────────────────┘
                                                   │ Anthropic /v1/messages
                                                   ▼
                                  ┌─────────────────────────────────┐
                                  │    zen-proxy.mjs (Port 8787)    │
                                  │  - Shared Activity Logger       │
                                  │  - Profile Model Resolver       │
                                  │  - Tool Route Pinning Cache     │
                                  └─────────┬──────────────┬────────┘
                                            │              │
                   ┌────────────────────────┘              └────────────────────────┐
                   │ Anthropic SSE                                                  │ Forwarded
                   ▼                                                                ▼
      ┌─────────────────────────┐                                      ┌─────────────────────────┐
      │ antigravity-gateway.mjs │                                      │   codex-gateway.mjs     │
      │       (Port 8788)       │                                      │       (Port 8789)       │
      │ - Cloud Code HTTP API   │                                      │ - Codex app-server RPC  │
      │ - Gemini 3.8 / Claude   │                                      │ - ChatGPT Plus OAuth    │
      │ - Google OAuth PKCE     │                                      │ - Web Dashboard & API   │
      └────────────┬────────────┘                                      └────────────┬────────────┘
                   │                                                                │
                   └────────────────────────┬───────────────────────────────────────┘
                                            ▼
                               ┌─────────────────────────┐
                               │ SQLite: zen-metrics.db  │
                               │  - Request telemetry    │
                               │  - Account credentials  │
                               │  - Global routing state │
                               └─────────────────────────┘
```

### 2.1 File & Module Inventory

1. **CLI Launcher (`bin/claude-zen`)**:
   A 1,015-line Bash script that manages local background gateway daemons (`start_proxy`, `start_antigravity`, `start_codex`, `start_watchdog`), exports environment variables (`ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`), and executes the official Anthropic Claude Code binary (`exec "$CLAUDE_BIN" ...`).
2. **OpenCode Zen Proxy (`zen-proxy.mjs`)**:
   An HTTP server on port 8787. It serves as the primary gateway for Claude Code. It translates Anthropic Messages payloads into OpenAI chat completions for OpenCode Zen models, records telemetry in SQLite, resolves virtual profile aliases (`claude-zen-opus`, `claude-zen-sonnet`, `claude-zen-haiku`), tracks tool route affinity, and proxies requests targeting Antigravity or Codex.
3. **Antigravity Gateway (`antigravity-gateway.mjs`)**:
   An HTTP server on port 8788. It translates Anthropic `/v1/messages` requests to Google Cloud Code internal endpoints (`autopush-cloudcode-pa.sandbox.googleapis.com` or production equivalents). It manages Google OAuth PKCE tokens, rate-limit cooldowns, thought signatures for Gemini models, and SSE streaming conversion (`lib/anthropic-antigravity.mjs`).
4. **Codex Gateway (`codex-gateway.mjs`)**:
   An HTTP server on port 8789. It translates Anthropic messages into structured JSON-RPC dynamic tools executed by a spawned `codex app-server --stdio` subprocess. It also serves the Web Dashboard single-page application and provides REST endpoints for account management, routing profiles, and metrics queries.
5. **Database & Persistence (`lib/db.mjs`)**:
   A Node.js native SQLite database interface (`node:sqlite`, `DatabaseSync`) managing database tables at `~/.zen-claude/zen-metrics.sqlite`.
6. **Watchdog Supervisor (`watchdog.sh`)**:
   A background daemon running in a 5-second polling loop that pings health endpoints on ports 8787, 8788, and 8789, restarting failed processes automatically.

---

## 3. Deep-Dive Inspection of Key Architectural Dimensions

### 3.1 Global Routing vs. Tool-Continuation Route Pinning vs. Task/Session Policy

* **Existing Tool-Continuation Route Pinning**:
  In `zen-proxy.mjs:138-175`, Claude-Zen implements an in-memory route pinning mechanism:
  - `routeByToolCallId` is an in-memory `Map` that maps `tool_use_id` to a route descriptor (`{ provider, model, expiresAt }`) with a 30-minute TTL and a 2,000-entry LRU cap.
  - When a tool call is emitted in an assistant message, `rememberToolRoute(block.id, route)` stores the originating provider and model.
  - On the subsequent client request, `pinnedRouteForBody(body)` inspects the newest message for `tool_result` blocks. If matching IDs are found, the request is forced to remain pinned to that exact provider and model, ignoring whatever routing profile is currently active in the database.
* **Finding**:
  Tool-continuation route pinning is **strictly an ephemeral, in-flight turn stability mechanism**. Its purpose is solely to prevent a mid-conversation tool continuation from failing if the user toggles active routing profiles on the dashboard while an agent tool call is executing.
* **What is Missing (No Project/Task/Session Routing Policy)**:
  Beyond tool-continuation pinning, routing is completely **global and process-wide**:
  - Virtual aliases (`claude-zen-opus`, `claude-zen-sonnet`, `claude-zen-haiku`) are resolved by reading a singleton row from SQLite (`routing_state` where `id = 1`) on every request (`lib/db.mjs:97-102`, `lib/routing-profiles.mjs:298-316`).
  - There is no concept of a project-specific routing profile, task-specific model binding, or agent session context in the gateway layer.
  - Two concurrent sessions invoking `claude-zen-sonnet` cannot be configured to use different providers or models; they both resolve to the single active profile configured on the server.

### 3.2 Tool Execution, Tool Continuation, and Session Isolation

* **Implementation Evidence**:
  - **Codex Gateway Dynamic Tool Loop** (`lib/anthropic-codex.mjs:84-94`, `lib/codex-app-server.mjs:16-33, 238-241, 380-387`):
    Anthropic tool definitions from Claude Code are transformed into Codex dynamic JSON-RPC tools. When Codex invokes `item/tool/call`, `AppServerTurnSession` holds the RPC promise, maps the call into an Anthropic `tool_use` SSE block, and concludes the HTTP turn with `stop_reason: 'tool_use'`. When Claude Code posts the next turn containing `tool_result`, `CodexHarnessAdapter.findSession(toolResults)` locates the in-memory session by `tool_use_id` and resumes the RPC call.
  - **Antigravity Gateway Tool Loop** (`lib/anthropic-antigravity.mjs:44-89, 150-196, 396-412`):
    Stateless per-request translation. Anthropic `tools` map to Google `functionDeclarations`. `tool_use` blocks map to `functionCall` parts, and `tool_result` blocks map to `functionResponse` parts. Thought signatures for Gemini models are cached in an in-memory `Map` (`signatureByToolId`).
* **Finding**:
  Multi-turn tool loops are functional, but session state exists solely in volatile process memory keyed by individual `tool_use_id`.
* **Gap**:
  There is zero task-level session persistence or isolation. If any gateway daemon crashes or restarts during an agent tool loop, all in-flight session context is lost, causing subsequent tool returns from Claude Code to fail with HTTP 400 errors or permanent hangs.

### 3.3 Git Working-Copy Isolation vs. Execution Security

In the current implementation, **neither Git working-copy isolation nor execution security exists**:

```
Current Reality (bin/claude-zen:1014):
┌────────────────────────────────────────────────────────────────────────┐
│ Host Operating System (macOS / Linux)                                 │
│                                                                        │
│  claude CLI (--dangerously-skip-permissions)                          │
│   ├── No Git isolation: edits directly in user's active checkout       │
│   ├── No filesystem containment: can read/write /Users, /etc, /tmp     │
│   ├── No credential masking: inherits user's full shell environment    │
│   └── No command filtering: executes arbitrary unconstrained bash      │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Git Working-Copy Isolation (Current: None)**:
   - Claude Code is executed directly inside whatever working directory the user launches it from (`bin/claude-zen:1014`).
   - In `lib/anthropic-codex.mjs:39-43` and `lib/codex-app-server.mjs:616-624`, `extractClaudeWorkingDirectory` inspects Claude Code's system prompt text (`- Primary working directory: <path>`) solely to pass `cwd` to `thread/start`.
   - There is no creation of isolated branches or git worktrees. Any file modification made by an agent directly alters the user's active working tree.
2. **Execution Security (Current: None)**:
   - The CLI launcher unconditionally executes Claude Code with `--dangerously-skip-permissions`:
     ```bash
     # bin/claude-zen:1014
     exec "$CLAUDE_BIN" --model "$MODEL" --settings "$SETTINGS_JSON" --dangerously-skip-permissions "$@"
     ```
   - This bypasses all confirmation prompts, giving any LLM model unconstrained shell and filesystem access with the privileges of the host user.
   - There is no environment variable scrubbing; host tokens and sensitive environment variables are fully visible to child processes.

### 3.4 Harness Integration Options: CLI vs. SDK vs. Custom Loop

To replace `--dangerously-skip-permissions`, the architecture must evaluate how agent execution should be driven:

| Dimension | Option 1: Headless Claude Code CLI | Option 2: Claude Agent SDK / Tool Runner | Option 3: Pure Custom Node.js Loop |
| :--- | :--- | :--- | :--- |
| **Integration Mechanism** | Subprocess via `child_process.spawn`: `claude -p "<prompt>" --bare --output-format stream-json --tools "Read,Edit,Bash" --permission-mode dontAsk` | `@anthropic-ai/claude-agent-sdk` (wraps engine) OR `@anthropic-ai/sdk` `client.beta.messages.toolRunner` | Direct Node.js `fetch()` loop calling `http://127.0.0.1:878[7-9]/v1/messages` |
| **Output Protocol** | Structured NDJSON event stream on stdout (`system/init`, `stream_event`, `assistant`, `result`) | Typed async iterator (`for await (const chunk of runner)`) | Direct HTTP SSE stream (`text/event-stream`) |
| **Tool Confinement** | Native permission modes (`dontAsk`, `acceptEdits`), `--allowedTools`, and `PreToolUse` hooks | In-process MCP server (`createSdkMcpServer`) + `canUseTool` programmatic approval gates | Manual tool execution with Node.js path checks (`assertPathWithinWorktree`) |
| **Coding Capabilities** | Full turnkey coding harness (file editing, multi-file diffing, subagents) | Full coding harness (Agent SDK) OR DIY tool definitions (Tool Runner) | All file read/edit and test execution tools must be built from scratch |
| **Gateway Compatibility** | [UNVERIFIED: Gateway Parity]: Requires local gateways to support all Claude Code beta headers and system prompt structures | [UNVERIFIED: Gateway Parity]: Requires full Messages API parity | 100% adaptable to any local proxy quirks or schema constraints |
| **Resource Overhead** | High (~0.5s–1.5s cold spawn; separate binary) | Moderate (Agent SDK bundles binary; Tool Runner is pure in-process) | Near-zero startup latency (<5ms) and minimal memory footprint |

### 3.5 Task Persistence, Cancellation, and Crash Recovery

* **Database Schema (`lib/db.mjs:32-118`)**:
  - The SQLite database contains 7 tables: `accounts`, `requests`, `rate_limit_events`, `account_model_limits`, `routing_profiles`, `routing_state`, and `provider_model_catalog`.
  - Schema migrations are performed ad-hoc via `PRAGMA table_info` column checks (`lib/db.mjs:120-132`). There is no versioned migration table.
  - Telemetry logs individual request turns (`input_tokens`, `output_tokens`, `duration_ms`, `tools_called`, `stop_reason`).
  - There are no tables for projects, repositories, baselines, tasks, test runs, or code reviews.
* **Cancellation**:
  - `antigravity-gateway.mjs:54-67` binds an `AbortController` to client socket closure (`req.on('close')`), which propagates an abort signal to Google Cloud Code HTTP requests.
  - `zen-proxy.mjs` and `codex-gateway.mjs` do not listen for client socket disconnects; cancelled turns continue to run upstream until completion or timeout.
* **Crash Recovery**:
  - `watchdog.sh` continuously polls ports 8787, 8788, and 8789 every 5 seconds, auto-restarting dead gateway processes.
  - Because no task state machine exists, an interrupted agent session cannot be resumed or recovered on restart.

### 3.6 Usage Tracking vs. Actual Spending / Usage Limits

* **Telemetry Tracking**:
  - `lib/db.mjs:51-67, 268-292` records per-turn usage in the `requests` table.
* **Token Estimation vs. Observed Usage**:
  - For providers reporting true token usage (e.g., Google Cloud Code `promptTokenCount`), observed usage is recorded.
  - For Codex and certain OpenCode streaming routes, usage is estimated using character heuristics (`lib/anthropic-codex.mjs:32-37`, `estimateInputTokens(body)` dividing character length by 4).
  - The database does not distinguish observed from estimated tokens in its schema.
* **Input Budget Truncation**:
  - `lib/input-budget.mjs:49-112` implements `budgetAnthropicRequest`. It truncates text blocks and tool inputs when the total character count exceeds limits (default 200k chars for Antigravity).
  - This is a payload truncation buffer to prevent upstream HTTP 400/413 errors, **not** a financial or usage budget.
* **Spending Caps**:
  - There are no financial budgets, daily spending limits, or token quotas implemented anywhere in the repository.
  - The only blocking mechanism is upstream HTTP 429 rate-limiting, which triggers temporary cooldowns (`rate_limited_until`).

### 3.7 Web Dashboard & UI Architecture

* **Implementation Evidence**:
  - `lib/ui.mjs` is a monolithic 2,822-line file exporting `renderDashboardHtml()`. It bundles HTML markup, embedded CSS styling, and client-side JavaScript into a single concatenated template literal.
  - Served directly on port 8789 (`codex-gateway.mjs:325-328`).
  - Sections implemented: Overview KPIs, Recent Activity Feed with cursor pagination, Analytics leaderboards, Account Pool management with OAuth login modals, Model Quotas, Routing Profiles, and Rate Limit logs.
* **Finding**:
  The dashboard is an effective operations console for monitoring proxy traffic and managing credentials, but its architecture cannot easily support complex software delivery views (interactive diff viewers, task kanban boards, live chat scoper) without becoming completely unmaintainable.

---

## 4. Reusable Assets vs. Gaps vs. Replacement Plan

| Component | Current State | Strategy for Orchestrator | Rationale |
| :--- | :--- | :--- | :--- |
| **Antigravity Gateway Client (`lib/antigravity-client.mjs`)** | Fully working | **Reuse** | Robust handling of Google OAuth PKCE, quota tracking, thought signatures, and SSE stream translation. |
| **Codex App-Server Bridge (`lib/codex-app-server.mjs`)** | Fully working | **Reuse** | Robust multi-turn JSON-RPC dynamic tool bridge for ChatGPT Plus accounts. |
| **OpenCode / Qwen Adapters (`lib/opencode-zen.mjs`)** | Fully working | **Reuse as Fallback** | Valuable alternative provider routes when primary quotas are exhausted. |
| **SQLite Foundation (`lib/db.mjs`)** | Implemented for metrics | **Extend with Versioned Migrations** | Solid `DatabaseSync` foundation. Must add formal migration tracking (`schema_migrations`) and tables for projects, baselines, tasks, and artifacts. |
| **Model Routing Resolver (`lib/routing-profiles.mjs`)** | Global singleton profile | **Refactor** | Must decouple from singleton `routing_state (id=1)` to support per-role and per-task model bindings. |
| **Web Dashboard (`lib/ui.mjs`)** | 2.8k-line monolithic string | **Replace with Modern SPA** | Replace with a lightweight, component-based Vite + Preact/React SPA built to static assets. |
| **CLI Launcher (`bin/claude-zen`)** | 1k-line Bash script | **Replace with Node Daemon** | Orchestrator control plane should run as a unified Node.js service rather than a bash wrapper invoking Claude Code with bypass flags. |
| **Git Worktree Isolation Manager** | Completely missing | **Build New (Milestone 1)** | Required to isolate agent file modifications from the owner's active checkout. |
| **Task State Machine & DAG Scheduler** | Completely missing | **Build New (Milestone 1)** | Required to manage deterministic 9-state task lifecycles and dependency scheduling. |
| **Automated Verification Engine** | Completely missing | **Build New (Milestone 1)** | Required to independently execute test/lint checks and govern bounded repair loops. |
| **Specialist Review & Diff Inspector** | Completely missing | **Build New (Milestone 1)** | Required to perform independent adversarial code reviews against exact commit diffs. |

---

## 5. README Claims vs. Implementation Reality Matrix

| Feature Claimed in README | Implemented Reality | Evidence / Citation |
| :--- | :--- | :--- |
| *"Run Claude Code across multiple LLM providers"* | **True.** Translates Anthropic Messages API calls to OpenAI, Google Cloud Code, and OpenCode formats. | `zen-proxy.mjs:240-335`, `antigravity-gateway.mjs:45-120`, `codex-gateway.mjs:125-230` |
| *"Multi-Account Dynamic Rate-Limit Hot-Failover"* | **True.** Automatically marks accounts cooling down and rotates to the next available account in the pool. | `codex-gateway.mjs:236-256`, `lib/antigravity-client.mjs:120-220` |
| *"Tool continuations stay on the provider/model that created the tool_use"* | **True.** Implemented via in-memory `routeByToolCallId` map, but strictly scoped to in-flight turns, not tasks or sessions. | `zen-proxy.mjs:138-175` |
| *"Runtime Model Profiles: activate without restarting"* | **True, but strictly global.** Changing a profile affects all requests across the entire proxy immediately. | `lib/routing-profiles.mjs:298-316`, `lib/db.mjs:97-102` |
| *"Input Budget Truncation"* | **True, but it is payload character sanitation, not spending caps.** | `lib/input-budget.mjs:49-112` |
| *"Self-hosted AI software delivery application"* | **False (Not yet implemented).** The repository currently provides proxying and account rotation, with zero delivery control-plane features. | Whole-codebase audit |
