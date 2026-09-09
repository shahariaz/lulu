#!/usr/bin/env bash
# Local self-healing supervisor for claude-zen services (Zen, Antigravity, Codex).
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; [ -f "$DIR/.env" ] && source "$DIR/.env"; set +a

if [ -z "${NODE_BIN:-}" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi

ZEN_PORT="${ZEN_PROXY_PORT:-8787}"
AGW_PORT="${ANTIGRAVITY_PORT:-8788}"
CODEX_PORT="${CODEX_PORT:-8789}"
AGW_IMPL="${ANTIGRAVITY_GATEWAY_IMPL_OVERRIDE:-${ANTIGRAVITY_GATEWAY_IMPL:-custom}}"
AGW_OPEN_SOURCE_DIR="${ANTIGRAVITY_OPEN_SOURCE_DIR:-$DIR/antigravity-gateway}"

WATCH_ZEN="${WATCH_ZEN:-1}"
WATCH_AGW="${WATCH_AGW:-1}"
WATCH_CODEX="${WATCH_CODEX:-1}"

LOG="$DIR/watchdog.log"
PID_FILE="$DIR/watchdog.pid"

LOCK_DIR="$DIR/watchdog.lock.d"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then exit 0; fi

  # Atomically move a stale lock out of the way. If another watchdog wins the
  # move or creates the replacement lock first, this process simply exits.
  stale_lock="${LOCK_DIR}.stale.$$"
  mv "$LOCK_DIR" "$stale_lock" 2>/dev/null || exit 0
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    rmdir "$stale_lock" 2>/dev/null || true
    exit 0
  fi
  rmdir "$stale_lock" 2>/dev/null || true
fi
echo "$$" > "$PID_FILE"
cleanup() {
  if [ "$(cat "$PID_FILE" 2>/dev/null || true)" = "$$" ]; then
    rm -f "$PID_FILE"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}
trap 'cleanup; exit 0' INT TERM EXIT

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
up() { curl -sf --max-time 2 "$1" >/dev/null 2>&1; }
agw_up() {
  # Avoid /health here: upstream refreshes quota for all accounts on that route,
  # so a slow Google response must not be mistaken for a dead local process.
  curl -sS --max-time 1 -o /dev/null "http://127.0.0.1:${AGW_PORT}/__claude_zen_liveness" 2>/dev/null
}

start_zen() {
  up "http://127.0.0.1:${ZEN_PORT}/health" && return 0
  log "Zen Proxy is down; restarting on ${ZEN_PORT}"
  nohup "$DIR/start.sh" >>"$DIR/proxy.log" 2>&1 &
  # start.sh also brings up both gateways. Give it time to do so before the
  # remaining checks try to launch duplicates.
  for _ in $(seq 1 100); do
    up "http://127.0.0.1:${ZEN_PORT}/health" && return 0
    sleep 0.1
  done
}

start_agw() {
  agw_up && return 0
  local agw_script agw_workdir
  if [ "$AGW_IMPL" = "opensource" ]; then
    agw_workdir="$AGW_OPEN_SOURCE_DIR"
    agw_script="$agw_workdir/src/index.js"
  else
    agw_workdir="$DIR"
    agw_script="$DIR/antigravity-gateway.mjs"
  fi
  [ -f "$agw_script" ] || return 0
  [ -x "$NODE_BIN" ] || { log "Antigravity restart skipped: Node.js executable not found; set NODE_BIN in .env"; return 0; }
  log "Antigravity ($AGW_IMPL) is down; restarting on ${AGW_PORT}"
  if [ "$AGW_IMPL" = "opensource" ]; then
    (cd "$agw_workdir" && PORT="$AGW_PORT" nohup "$NODE_BIN" "$agw_script" >>"$DIR/antigravity-gateway.log" 2>&1 &)
  else
    (cd "$agw_workdir" && ANTIGRAVITY_PORT="$AGW_PORT" nohup "$NODE_BIN" "$agw_script" >>"$DIR/antigravity-gateway.log" 2>&1 &)
  fi
}

start_codex() {
  up "http://127.0.0.1:${CODEX_PORT}/health" && return 0
  local gw_script="$DIR/codex-gateway.mjs"
  [ -f "$gw_script" ] || return 0
  [ -x "$NODE_BIN" ] || { log "Codex restart skipped: Node.js executable not found; set NODE_BIN in .env"; return 0; }
  log "Codex Gateway is down; restarting on ${CODEX_PORT}"
  (cd "$DIR" && CODEX_PORT="$CODEX_PORT" nohup "$NODE_BIN" "$gw_script" >>"$DIR/codex-gateway.log" 2>&1 &)
}

log "watchdog started (Zen=${WATCH_ZEN} :${ZEN_PORT}, Antigravity=${WATCH_AGW} :${AGW_PORT}, Codex=${WATCH_CODEX} :${CODEX_PORT})"
while :; do
  [ "$WATCH_ZEN" = 1 ] && start_zen
  [ "$WATCH_AGW" = 1 ] && start_agw
  [ "$WATCH_CODEX" = 1 ] && start_codex
  sleep 5
done
