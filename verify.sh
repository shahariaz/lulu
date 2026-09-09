#!/usr/bin/env bash
# Proves the setup actually works. Exits nonzero on the first real failure.
#
#   ./verify.sh            # checks a-h (fast)
#   ./verify.sh --full     # also runs full end-to-end checks
set -uo pipefail

DIR="$HOME/.zen-claude"
PORT="${ZEN_PROXY_PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"
AGW_PORT="${ANTIGRAVITY_PORT:-8788}"
AGW_BASE="http://127.0.0.1:${AGW_PORT}"
CODEX_PORT="${CODEX_PORT:-8789}"
CODEX_BASE="http://127.0.0.1:${CODEX_PORT}"
# Use a Go model by default.
MODEL="${DEFAULT_ZEN_MODEL:-mimo-v2.5}"
FULL=0
[ "${1:-}" = "--full" ] && FULL=1

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
info() { printf '        %s\n' "$1"; }

KEY="$(grep '^ZEN_API_KEY=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
[ -n "$KEY" ] || { echo "no key in $DIR/.env -- run install.sh first"; exit 1; }

echo ""
echo "Verifying claude-zen"
echo ""

# ---- a: proxy health -----------------------------------------------------
if ! curl -sf --max-time 3 "$BASE/health" >/dev/null 2>&1; then
  info "proxy down, starting it..."
  nohup "$DIR/start.sh" >>"$DIR/proxy.log" 2>&1 &
  for _ in $(seq 1 40); do curl -sf --max-time 2 "$BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
fi
if curl -sf --max-time 3 "$BASE/health" 2>/dev/null | grep -q '"ok"'; then
  ok "a  proxy is up on $BASE"
else
  no "a  proxy will not start -- see $DIR/proxy.log"
  exit 1
fi

# ---- b: the bug this proxy exists for ------------------------------------
SHIM="$(curl -s --max-time 30 https://opencode.ai/zen/v1/messages \
  -H "x-api-key: $KEY" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":600,
       \"tools\":[{\"name\":\"bash\",\"description\":\"run\",\"input_schema\":
         {\"type\":\"object\",\"properties\":{\"command\":{\"type\":\"string\"}}}}],
       \"messages\":[{\"role\":\"user\",\"content\":\"list files, use bash\"}]}" 2>/dev/null)"
if printf '%s' "$SHIM" | grep -q '"content"'; then
  ok "b  heads up: Zen's /v1/messages answered -- the proxy may be optional now"
  info "if this keeps happening, try ANTHROPIC_BASE_URL=https://opencode.ai/zen directly"
elif printf '%s' "$SHIM" | grep -q '"error"'; then
  ok "b  Zen's native /v1/messages still mangles tool schemas (proxy required)"
else
  no "b  unexpected reply from Zen's /v1/messages"
  info "$(printf '%s' "$SHIM" | head -c 200)"
fi

# ---- c: tool translation -------------------------------------------------
TOOLS="$(curl -s --max-time 60 "$BASE/v1/messages" -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":900,
       \"tools\":[{\"name\":\"ls\",\"description\":\"List files in a directory\",
         \"input_schema\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}},
         \"required\":[\"path\"]}}],
       \"messages\":[{\"role\":\"user\",\"content\":\"List the files in /tmp. Use the ls tool.\"}]}" 2>/dev/null)"
if printf '%s' "$TOOLS" | grep -q '"type":"tool_use"'; then
  ok "c  Anthropic tool schema translates and the model calls the tool"
else
  no "c  no tool_use block returned"
  info "$(printf '%s' "$TOOLS" | head -c 200)"
fi

# ---- d: multi-turn with a tool result ------------------------------------
CYCLE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$BASE/v1/messages" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":900,\"messages\":[
       {\"role\":\"user\",\"content\":\"List /tmp with the ls tool.\"},
       {\"role\":\"assistant\",\"content\":[
         {\"type\":\"text\",\"text\":\"Checking.\"},
         {\"type\":\"tool_use\",\"id\":\"toolu_01\",\"name\":\"ls\",\"input\":{\"path\":\"/tmp\"}}]},
       {\"role\":\"user\",\"content\":[
         {\"type\":\"tool_result\",\"tool_use_id\":\"toolu_01\",\"content\":\"a.txt\"}]},
       {\"role\":\"user\",\"content\":\"Summarize in one short sentence.\"}]}" 2>/dev/null)"
[ "$CYCLE" = "200" ] && ok "d  tool_use -> tool_result round trip" \
                     || no "d  round trip returned HTTP $CYCLE"

# ---- e: isolated cold-cache test -----------------------------------------
# Never restart the production listener here. Some execution environments
# reap a nohup replacement when this verifier exits, leaving a proxy that was
# healthy on entry unavailable. A fresh process, database, and loopback port
# exercise the same empty-cache path without touching the live service.
COLD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claude-zen-verify.XXXXXX")"
COLD_DB="$COLD_DIR/metrics.sqlite"
COLD_LOG="$COLD_DIR/proxy.log"
COLD_PORT="$(node -e "
  const net = require('node:net');
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    console.log(server.address().port);
    server.close();
  });
")"
COLD_BASE="http://127.0.0.1:${COLD_PORT}"
COLD_PID=""
cleanup_cold_proxy() {
  if [ -n "$COLD_PID" ] && kill -0 "$COLD_PID" 2>/dev/null; then
    kill "$COLD_PID" 2>/dev/null || true
    wait "$COLD_PID" 2>/dev/null || true
  fi
  rm -rf "$COLD_DIR"
}
trap cleanup_cold_proxy EXIT

PORT="$COLD_PORT" ZEN_DB_PATH="$COLD_DB" ZEN_API_KEY="$KEY" \
  node "$DIR/zen-proxy.mjs" >>"$COLD_LOG" 2>&1 &
COLD_PID=$!
for _ in $(seq 1 40); do
  curl -sf --max-time 2 "$COLD_BASE/health" >/dev/null 2>&1 && break
  kill -0 "$COLD_PID" 2>/dev/null || break
  sleep 0.5
done

COLD="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$COLD_BASE/v1/messages" \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":900,\"messages\":[
       {\"role\":\"user\",\"content\":\"What is 2+2? Just the number.\"},
       {\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"4\"}]},
       {\"role\":\"user\",\"content\":\"Times 3? Just the number.\"}]}" 2>/dev/null)"
if [ "$COLD" = "200" ]; then
  ok "e  cold-cache replay in isolated proxy"
else
  no "e  cold-cache replay returned HTTP $COLD"
  [ -s "$COLD_LOG" ] && info "$(tail -3 "$COLD_LOG")"
fi
cleanup_cold_proxy
COLD_PID=""
trap - EXIT

# ---- f: Codex Gateway health ---------------------------------------------
if ! curl -sf --max-time 3 "$CODEX_BASE/health" >/dev/null 2>&1; then
  info "starting Codex Gateway..."
  (cd "$DIR" && CODEX_PORT="$CODEX_PORT" nohup node codex-gateway.mjs >>"$DIR/codex-gateway.log" 2>&1 &)
  for _ in $(seq 1 40); do curl -sf --max-time 2 "$CODEX_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
fi

if curl -sf --max-time 3 "$CODEX_BASE/health" 2>/dev/null | grep -q '"codex"'; then
  ok "f  Codex Gateway is up on $CODEX_BASE (port $CODEX_PORT)"
else
  no "f  Codex Gateway will not start -- see $DIR/codex-gateway.log"
fi

# ---- f2: Antigravity Gateway health --------------------------------------
if ! curl -sf --max-time 3 "$AGW_BASE/health" >/dev/null 2>&1; then
  info "starting Antigravity Gateway..."
  (cd "$DIR" && ANTIGRAVITY_PORT="$AGW_PORT" nohup node antigravity-gateway.mjs >>"$DIR/antigravity-gateway.log" 2>&1 &)
  for _ in $(seq 1 40); do curl -sf --max-time 2 "$AGW_BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
fi

if curl -sf --max-time 3 "$AGW_BASE/health" 2>/dev/null | grep -q '"antigravity"'; then
  ok "f2 Antigravity Gateway is up on $AGW_BASE (port $AGW_PORT)"
else
  no "f2 Antigravity Gateway will not start -- see $DIR/antigravity-gateway.log"
fi

# ---- g: SQLite database & metrics ----------------------------------------
DB_CHECK="$(node -e "
  import('$DIR/lib/db.mjs').then(({ getDb, getStats }) => {
    const db = getDb();
    const stats = getStats();
    if (stats && stats.accounts_summary) {
      console.log('OK:' + stats.accounts_summary.total);
    }
  }).catch(e => console.log('ERR:' + e.message));
" 2>/dev/null || echo "ERR:node_failed")"

if printf '%s' "$DB_CHECK" | grep -q '^OK:'; then
  ok "g  SQLite database initialized & token tracking active"
else
  no "g  SQLite database check failed ($DB_CHECK)"
fi

# ---- h: Web Dashboard & REST APIs ----------------------------------------
DASHBOARD="$(curl -sf --max-time 3 "$CODEX_BASE/dashboard" 2>/dev/null || true)"
if [[ "$DASHBOARD" == *Claude-Zen* ]]; then
  ok "h  Web Dashboard is responsive (http://127.0.0.1:${CODEX_PORT}/dashboard)"
else
  no "h  Web Dashboard failed to render"
fi

# ---- i: API endpoints (stats, pool, accounts, export) ---------------------
API_CHECK="$(node -e "
  Promise.all([
    fetch('$CODEX_BASE/api/stats').then(r => r.json()),
    fetch('$CODEX_BASE/api/accounts').then(r => r.json()),
    fetch('$CODEX_BASE/api/pool').then(r => r.json()),
    fetch('$CODEX_BASE/api/export?format=json').then(r => r.json())
  ]).then(([stats, accounts, pool, exp]) => {
    if (stats && stats.today && accounts && pool && exp) {
      console.log('OK:' + accounts.length);
    }
  }).catch(e => console.log('ERR:' + e.message));
" 2>/dev/null || echo "ERR:api_check_failed")"

if printf '%s' "$API_CHECK" | grep -q '^OK:'; then
  ok "i  REST API endpoints verified (/api/stats, /api/accounts, /api/pool, /api/export)"
else
  no "i  REST API check failed ($API_CHECK)"
fi

# ---- j: real Claude Code + ChatGPT/Codex model ---------------------------
if [ "$FULL" = 1 ]; then
  if command -v claude-zen >/dev/null 2>&1; then
    T="$(mktemp -d)"; echo "codeword: BANANA-42" > "$T/secret.txt"
    CODEX_TEST_MODEL="${CODEX_TEST_MODEL:-gpt-5.6-sol@low}"
    OUT="$(cd "$T" && claude-zen --codex -m "$CODEX_TEST_MODEL" -p "Read secret.txt and tell me the codeword." \
             --allowedTools Read --permission-mode acceptEdits 2>&1 || true)"
    printf '%s' "$OUT" | grep -q 'BANANA-42' \
      && ok "j  real Claude Code + $CODEX_TEST_MODEL read a file through the outer harness" \
      || { no "j  end-to-end run did not return the codeword"; info "$(printf '%s' "$OUT" | tail -3)"; }
    rm -rf "$T"
  else
    no "j  claude-zen not on PATH"
  fi
else
  info "skipping j (real Claude Code) -- re-run with --full to include it"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  printf '  \033[32m%d passed, 0 failed.\033[0m  Start with: claude-zen\n\n' "$pass"
  exit 0
fi
printf '  \033[31m%d passed, %d failed.\033[0m\n\n' "$pass" "$fail"
exit 1
