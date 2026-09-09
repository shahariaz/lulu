#!/usr/bin/env bash
# Terminate watchdog supervisors and release all 3 Claude-Zen ports (:8787, :8788, :8789).
set -u

DIR="${CLAUDE_ZEN_DIR:-$HOME/.zen-claude}"
ZEN_PORT="${ZEN_PROXY_PORT:-8787}"
AGW_PORT="${ANTIGRAVITY_PORT:-8788}"
CODEX_PORT="${CODEX_PORT:-8789}"

say() { printf '  %s\n' "$1"; }
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; }
warn(){ printf '  \033[33mwarn\033[0m %s\n' "$1"; }

echo ""
echo "Claude-Zen Port & Process Cleanup"
echo "=================================="

# 1. Stop watchdog supervisor first so it does not auto-restart killed services
if [ -f "$DIR/watchdog.pid" ]; then
  WPID="$(cat "$DIR/watchdog.pid" 2>/dev/null || true)"
  if [ -n "$WPID" ] && kill -0 "$WPID" 2>/dev/null; then
    kill -TERM "$WPID" 2>/dev/null || kill -9 "$WPID" 2>/dev/null || true
    ok "Stopped watchdog process (PID $WPID)"
  fi
  rm -f "$DIR/watchdog.pid"
fi

# Catch any additional watchdog scripts
pkill -f "$DIR/watchdog.sh" 2>/dev/null || pkill -f "watchdog.sh" 2>/dev/null || true
rm -rf "$DIR"/watchdog.lock.d* 2>/dev/null || true
ok "Cleaned watchdog lock files"

# 2. Kill Node gateway processes by script name within target directory
pkill -f "$DIR/zen-proxy.mjs" 2>/dev/null || true
pkill -f "$DIR/antigravity-gateway.mjs" 2>/dev/null || true
pkill -f "$DIR/codex-gateway.mjs" 2>/dev/null || true
ok "Terminated gateway Node processes for $DIR"

# 3. Kill any remaining processes listening on the 3 ports
kill_port() {
  local p="$1"
  local name="$2"
  local pids=""

  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti :"$p" 2>/dev/null || true)"
  fi

  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill -9 2>/dev/null || true
    ok "Freed port :$p ($name)"
  else
    # Fallback to fuser on Linux if available
    if command -v fuser >/dev/null 2>&1; then
      fuser -k -n tcp "$p" 2>/dev/null || true
    fi
    ok "Port :$p ($name) is free"
  fi
}

kill_port "$ZEN_PORT" "Zen Proxy"
kill_port "$AGW_PORT" "Antigravity Gateway"
kill_port "$CODEX_PORT" "Codex Gateway / UI"

# 4. Verify ports are fully released
sleep 0.3
all_free=1
for p in "$ZEN_PORT" "$AGW_PORT" "$CODEX_PORT"; do
  if command -v lsof >/dev/null 2>&1; then
    if lsof -i :"$p" >/dev/null 2>&1; then
      warn "Port :$p still appears in use; waiting..."
      all_free=0
    fi
  fi
done

if [ "$all_free" -eq 1 ]; then
  echo ""
  ok "All 3 ports (:8787, :8788, :8789) and supervisors are cleanly stopped."
  echo ""
else
  echo ""
  warn "Some ports may take a few seconds to release completely."
  echo ""
fi
