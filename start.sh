#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
set -a; [ -f ./.env ] && source ./.env; set +a

# Supervisors such as launchd often provide a minimal PATH. Resolve Node once
# so service restarts do not depend on the caller's shell configuration.
if [ -z "${NODE_BIN:-}" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
[ -x "$NODE_BIN" ] || { echo "Node.js executable not found; set NODE_BIN in .env" >&2; exit 1; }

export PORT="${PORT:-8787}"
export ANTIGRAVITY_BASE_URL="${ANTIGRAVITY_BASE_URL:-http://127.0.0.1:8788/v1}"
export ANTIGRAVITY_MODELS="${ANTIGRAVITY_MODELS:-gemini-3.8-flash-tiered,gemini-3.1-pro-low,gemini-pro-agent,claude-opus-4-6-thinking,claude-sonnet-4-6}"
export CODEX_BASE_URL="${CODEX_BASE_URL:-http://127.0.0.1:8789/v1}"
export CODEX_MODELS="${CODEX_MODELS:-gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini}"

ANTIGRAVITY_PORT="${ANTIGRAVITY_PORT:-8788}"
CODEX_PORT="${CODEX_PORT:-8789}"
ANTIGRAVITY_GATEWAY_IMPL="${ANTIGRAVITY_GATEWAY_IMPL_OVERRIDE:-${ANTIGRAVITY_GATEWAY_IMPL:-custom}}"
ANTIGRAVITY_OPEN_SOURCE_DIR="${ANTIGRAVITY_OPEN_SOURCE_DIR:-$HOME/.zen-claude/antigravity-gateway}"

# The open-source gateway's /health endpoint refreshes quota for every account
# and can take several seconds. Use a cheap 404 route as a liveness probe so a
# slow quota refresh cannot trigger a duplicate-process restart storm.
if ! curl -sS --max-time 1 -o /dev/null "http://127.0.0.1:${ANTIGRAVITY_PORT}/__claude_zen_liveness" 2>/dev/null; then
  if [ "$ANTIGRAVITY_GATEWAY_IMPL" = "opensource" ]; then
    agw_entry="$ANTIGRAVITY_OPEN_SOURCE_DIR/src/index.js"
    [ -f "$agw_entry" ] || { echo "Open-source Antigravity Gateway not found: $agw_entry" >&2; exit 1; }
    (cd "$ANTIGRAVITY_OPEN_SOURCE_DIR" && PORT="$ANTIGRAVITY_PORT" nohup "$NODE_BIN" "$agw_entry" >>"$PWD/../antigravity-gateway.log" 2>&1 &)
  elif [ -f "./antigravity-gateway.mjs" ]; then
    ANTIGRAVITY_PORT="$ANTIGRAVITY_PORT" nohup "$NODE_BIN" antigravity-gateway.mjs >>./antigravity-gateway.log 2>&1 &
  fi
fi

# Start Codex Gateway in background if available and not already listening
if [ -f "./codex-gateway.mjs" ]; then
  if ! curl -sf --max-time 1 "http://127.0.0.1:${CODEX_PORT}/health" >/dev/null 2>&1; then
    CODEX_PORT="$CODEX_PORT" nohup "$NODE_BIN" codex-gateway.mjs >>./codex-gateway.log 2>&1 &
    gateway_ready=0
    for _ in $(seq 1 100); do
      if curl -sf --max-time 1 "http://127.0.0.1:${CODEX_PORT}/health" >/dev/null 2>&1; then
        gateway_ready=1
        break
      fi
      sleep 0.1
    done
    if [ "$gateway_ready" -ne 1 ]; then
      echo "Codex Gateway failed to become ready on port ${CODEX_PORT}" >&2
      tail -40 ./codex-gateway.log >&2 || true
      exit 1
    fi
  fi
fi

exec "$NODE_BIN" zen-proxy.mjs
