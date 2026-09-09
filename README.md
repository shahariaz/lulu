# claude-zen

Run **Claude Code** across multiple LLM providers:
- **OpenAI Codex / ChatGPT Plus** (`gpt-5.6-sol`, `gpt-5.4`, `gpt-5.5`, `o3`) with multi-account auto-failover & rate-limit cooldown tracking.
- **Google Gemini & Claude / Antigravity Gateway** (`gemini-3.8-flash`, `claude-opus-4-6`, `claude-sonnet-4-6`) with multi-account Google OAuth load balancing.
- **OpenCode Zen / Go** (`qwen3.7-plus`, `mimo-v2.5`, `nemotron-3.5-lightning-free`, `ling-3.0-tiny-free`) with multi-account rotation for Free and Go Paid models.

Includes a local **SQLite metrics database** for token tracking and a responsive **Web Dashboard** on `http://127.0.0.1:8789/dashboard`.

---

## Quick Start

```bash
git clone https://github.com/Itsme23476/claude-zen
cd claude-zen
./install.sh          # installs proxy, Codex gateway, and DB
./verify.sh           # proves it works
```

Start coding:

```bash
claude-zen                        # start with hybrid routing
claude-zen --codex                # use ChatGPT Plus / Codex directly
claude-zen --antigravity          # use Antigravity Gateway directly
claude-zen --ui                   # open the Web Dashboard in your browser
```

---

## Features

### 1. OpenAI Codex / ChatGPT Plus Integration (Port 8789)
- **Zero-Config Import:** Automatically imports your existing ChatGPT Plus credentials from `~/.codex/auth.json`.
- **Claude Code-native Tools:** Codex app-server receives Claude Code's JSON tool schemas as structured dynamic tools. GPT chooses calls and arguments; Claude Code remains the only process that executes them.
- **True Incremental Streaming:** GPT text deltas flow from Codex app-server to Claude Code immediately as Anthropic SSE events; native tool calls and continuations use the same stream without buffering the completed turn.
- **No Nested Agent:** The gateway does not run `codex exec`, parse XML tool calls, or grant a second agent filesystem access. Codex app-server is deliberately read-only; file and shell work is performed only by Claude Code's outer dynamic tools, which retain the outer harness permissions.
- **Isolated Accounts:** Each ChatGPT account runs through its own private `CODEX_HOME`, so account selection and rate-limit failover use the credentials shown by the dashboard.
- **Multi-Account Management:** Add accounts from the dashboard with ChatGPT browser OAuth, device-code OAuth, or by importing the current `codex login`. Pasting token JSON remains an advanced fallback.
- **Dynamic Rate-Limit Hot-Failover:** If one account reaches its 3-hour / daily usage limit (HTTP 429), the gateway automatically marks it cooling down and seamlessly switches to the next available account without failing your Claude Code turn.
- **Automatic OAuth Token Refresh:** Automatically refreshes OpenAI access tokens before they expire.

### 2. Antigravity Gateway Integration (Port 8788)
- **Supported Models:** Gemini 3.8 Flash (`gemini-3.8-flash`), Claude Opus 4.6 (`claude-opus-4-6`), and Claude Sonnet 4.6 (`claude-sonnet-4-6`).
- **Native Thinking & 64k Output:** Native `LOW`, `MEDIUM`, and `HIGH` thinking levels for Gemini 3.8 and interleaved thinking for Claude Opus/Sonnet 4.6 with 65,536-token output capacity.
- **Zero-Dependency Native Gateway:** Runs standalone on port 8788 with automated Google OAuth PKCE authentication, token refresh, and multi-account failover.
- **Accurate Telemetry:** All turns are attributed to the exact Google account that served them and logged into SQLite.

### 3. OpenCode Zen / Go Integration (Port 8787)
- **Multi-Account Free & Go Rotation:** Manage multiple OpenCode API keys with distinct plan types (`free`, `go` paid, or `hybrid`).
- **Dynamic Rate-Limit Failover:** When free or paid quotas are reached (HTTP 429), requests rotate seamlessly to the next available account without failing your Claude Code turn.
- **Model-Aware Routing:** Free models (`nemotron-3.5-lightning-free`, `ling-3.0-tiny-free`, `laguna-s-2.1-free`, `hy3-free`, `nemotron-3-ultra-free`, `mimo-v2.5-free`) route to `https://opencode.ai/zen/v1`, while Go paid models (`qwen3.7-plus`, `mimo-v2.5`, `minimax-m3`, `kimi-k3`, `glm-5`) route to `https://opencode.ai/zen/go/v1`.
- **Easy Account Import:** Add keys through the Web Dashboard, CLI (`claude-zen --zen-accounts add`), or automatically from `.env`.

### 4. Local SQLite Token Database (`node:sqlite`)
- Persisted at `~/.zen-claude/zen-metrics.sqlite`.
- Tracks:
  - Input tokens, output tokens, total tokens per request, per turn, and per day.
  - Usage breakdown by model (`gpt-5.6-sol`, `gemini-3.8-flash`, `qwen3.7-plus`, etc.).
  - Usage breakdown by account.
  - Request duration, status, reasoning effort/tokens, stop reason, tool names, error diagnostics, and rate-limit cooldown events.
  - Genuine turns from Codex, Antigravity, Zen/OpenCode streaming, and Anthropic-native Go paths.

### 5. Responsive Web Dashboard
- Open at `http://127.0.0.1:8789/dashboard` or via `claude-zen --ui`.
- Real-time overview of all 3 gateways (Zen :8787, Antigravity :8788, Codex :8789).
- Live token counters (Today's tokens, all-time tokens, active accounts across all 3 pools).
- Visual usage charts by model and account.
- Responsive Recent Activity Feed with provider/model/account/status filters and search across model, account, tool, and error diagnostics.
- Per-turn reasoning, tool usage, input/output tokens, latency, stop reason, timestamp, and expandable errors.
- Accessible loading, empty, partial-failure, and retry states for desktop and mobile.
- Interactive Account Manager (Add Account, Reset Rate Limits, Remove Account).
- Runtime Model Profiles: create named Opus/Sonnet/Haiku mappings and activate them without restarting Claude Code.

---

## CLI Usage

```bash
# Providers & Models
claude-zen                         # Start services & use hybrid routing
claude-zen --codex                 # Use Codex / ChatGPT Plus (default: gpt-5.6-sol)
claude-zen --codex -m gpt-5.4      # Use a specific Codex model
claude-zen --antigravity           # Use Antigravity (default: gemini-3.8-flash-tiered)
claude-zen -m <model>              # Override model for one run

# Dashboard
claude-zen --ui                    # Open Web Dashboard in default browser
claude-zen --status                # Print status of all gateways, accounts & token metrics

# OpenCode Zen / Go Account Management
claude-zen --zen-accounts list          # List all OpenCode Zen & Go accounts
claude-zen --zen-accounts add <sk-...>  # Add another OpenCode API key
claude-zen --zen-accounts reset-limits  # Force clear all OpenCode rate limit cooldowns
claude-zen --zen-accounts remove <acc>  # Remove an account

# ChatGPT / Codex Account Management
claude-zen --codex-accounts list         # List all accounts and rate limit cooldowns
claude-zen --codex-accounts check        # Probe live account status
claude-zen --codex-accounts reset-limits # Force clear all rate limit cooldowns
claude-zen --codex-accounts add          # Add another ChatGPT Plus account
claude-zen --codex-accounts remove <acc> # Remove an account

# Antigravity Account Management
claude-zen --accounts list               # List Antigravity Google accounts
claude-zen --accounts add                # Add another Google account
claude-zen --accounts reset-limits       # Reset Antigravity rate limits

# Code Updates & Maintenance (Kill Ports & Clear Caches)
claude-zen --update soft                 # Sync code changes, restart 3 ports, keep database/history
claude-zen --update hard                 # Sync code, kill 3 ports, clear rate limits, catalogs & logs
claude-zen --kill-ports                  # Kill all 3 ports (:8787, :8788, :8789) & watchdog supervisor
claude-zen --restart                     # Cleanly restart all gateways and watchdog
./clean-ports.sh                         # Standalone script to terminate all 3 ports
./update.sh [soft|hard]                  # Standalone updater script
```

---

## Runtime Model Profiles

Start `claude-zen`, open the dashboard, and use **Runtime Model Profiles**. A profile maps each Claude tier to a provider and model—for example:

- Opus → Codex / `gpt-5.6-sol` / `high` reasoning
- Sonnet → Antigravity / `gemini-3.8-flash-tiered` / `medium` reasoning
- Haiku → Codex / `gpt-5.6-luna` / `medium` reasoning

The Codex model picker is populated from the signed-in ChatGPT accounts through Codex app-server, including each model's supported reasoning levels. Gemini 3.8 routes expose low, medium, and high thinking levels. Activation is immediate for the next request. Claude Code is launched with stable `claude-zen-opus`, `claude-zen-sonnet`, and `claude-zen-haiku` aliases; the proxy resolves those aliases from SQLite on every turn. If activation happens while a tool call is outstanding, its `tool_result` remains pinned to the provider/model that created it.

`-m <model>`, `--codex`, and `--antigravity` remain explicit routing overrides. Antigravity requests still pass through the local Zen proxy unchanged so their real activity can be recorded before forwarding to port 8788. A Codex reasoning level can be selected directly with `model@effort`, for example:

```bash
claude-zen --codex -m gpt-5.6-sol@high
claude-zen --codex -m gpt-5.6-luna@medium
```

Only reasoning levels reported for that model are accepted; invalid combinations fail before inference.

## Initial Hybrid Configuration (`config.yaml`)

Edit [`config.yaml`](config.yaml) to map Claude Code tiers across providers:

```yaml
mode: hybrid

providers:
  zen:
    go_base_url: https://opencode.ai/zen/go/v1
    free_base_url: https://opencode.ai/zen/v1
  antigravity:
    base_url: http://127.0.0.1:8788/v1
  codex:
    base_url: http://127.0.0.1:8789/v1

tiers:
  opus:
    provider: codex
    model: gpt-5.6-sol
  sonnet:
    provider: codex
    model: gpt-5.4
  haiku:
    provider: antigravity
    model: gemini-3.8-flash-tiered
```

These tier values are retained for legacy compatibility and startup model hints. Runtime profiles in the dashboard are the source of truth during hybrid sessions. After modifying provider endpoints in `config.yaml`, run `./install.sh` to update `~/.zen-claude`.

---

## Architecture Overview

```
                              ┌───────────────────────────┐
                              │      Claude Code CLI      │
                              └─────────────┬─────────────┘
                                            │ Anthropic /v1/messages
                                            ▼
                              ┌───────────────────────────┐
                              │    claude-zen Launcher    │
                              │   (--hybrid / --codex)    │
                              └──────┬─────┬────────┬─────┘
                                     │     │        │
                       ┌─────────────┘     │        └──────────────┐
             Port 8787 │         Port 8788 │             Port 8789 │
        ┌──────────────▼───┐ ┌─────────────▼───┐ ┌─────────────────▼────────┐
        │   zen-proxy.mjs  │ │  Antigravity    │ │      Codex Gateway       │
        │    (OpenCode)    │ │ (Gemini/Google) │ │ Anthropic ↔ app-server   │
        └──────────────┬───┘ └─────────────┬───┘ └────────┬─────────────────┘
                       │                   │              │
                       └───────────────────┼──────────────┘
                                           ▼
                             ┌───────────────────────────┐
                             │    SQLite Metrics & DB    │
                             │   zen-metrics.sqlite      │
                             │  + Web UI on Port 8789    │
                             └───────────────────────────┘
```

---

## What Gets Installed

```
~/.zen-claude/zen-metrics.sqlite      local SQLite database for token metrics & accounts
~/.zen-claude/codex-gateway.mjs       Codex / ChatGPT Plus gateway & dashboard server
~/.zen-claude/antigravity-gateway.mjs Antigravity (Gemini 3.8 & Claude Opus/Sonnet 4.6) gateway server
~/.zen-claude/lib/db.mjs              SQLite database interface
~/.zen-claude/lib/antigravity-models.mjs Antigravity model definitions & aliases
~/.zen-claude/lib/antigravity-accounts.mjs Google OAuth multi-account & token manager
~/.zen-claude/lib/anthropic-antigravity.mjs Anthropic ↔ Cloud Code format translation & SSE streaming
~/.zen-claude/lib/antigravity-client.mjs Cloud Code HTTP client with auto-failover
~/.zen-claude/lib/codex-accounts.mjs  Codex multi-account failover & token manager
~/.zen-claude/lib/anthropic-codex.mjs Anthropic ↔ Codex app-server protocol translation
~/.zen-claude/lib/anthropic-sse.mjs   incremental Anthropic SSE writer
~/.zen-claude/lib/codex-app-server.mjs structured Codex app-server transport
~/.zen-claude/lib/codex-login.mjs     isolated browser/device OAuth sessions
~/.zen-claude/lib/codex-models.mjs    Codex model catalog & reasoning levels
~/.zen-claude/lib/routing-profiles.mjs runtime tier/profile resolver
~/.zen-claude/lib/ui.mjs              Dashboard UI
~/.zen-claude/zen-proxy.mjs           OpenCode bridge
~/.zen-claude/start.sh                starts background services
~/.zen-claude/watchdog.sh             auto-heals failed services
~/.local/bin/claude-zen               CLI launcher
```

---

## License

MIT
