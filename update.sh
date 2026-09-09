#!/usr/bin/env bash
# Update Claude-Zen: sync code changes, release ports, and reset caches.
# Usage:
#   ./update.sh [soft|hard]
#   ./update.sh soft   (default: sync files, kill 3 ports, restart cleanly, keep accounts/history)
#   ./update.sh hard   (sync files, kill 3 ports, clear rate-limits, truncate logs, reset catalogs)
set -euo pipefail

MODE="${1:-soft}"
SRC="$(cd "$(dirname "$0")" && pwd)"
DIR="${CLAUDE_ZEN_DIR:-$HOME/.zen-claude}"
BIN="${CLAUDE_ZEN_BIN:-$HOME/.local/bin}"

say()  { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$1"; }
die()  { printf '  \033[31mfail\033[0m %s\n' "$1" >&2; exit 1; }

case "$MODE" in
  soft|--soft)
    MODE="soft"
    ;;
  hard|--hard)
    MODE="hard"
    ;;
  *)
    echo "Usage: $0 [soft|hard]"
    exit 1
    ;;
esac

MODE_UPPER="$(echo "$MODE" | tr '[:lower:]' '[:upper:]')"

echo ""
echo "Claude-Zen Update ($MODE_UPPER)"
echo "=============================="

# 1. Kill all 3 ports & watchdog
if [ -f "$SRC/clean-ports.sh" ]; then
  CLAUDE_ZEN_DIR="$DIR" ZEN_PROXY_PORT="${ZEN_PROXY_PORT:-8787}" ANTIGRAVITY_PORT="${ANTIGRAVITY_PORT:-8788}" CODEX_PORT="${CODEX_PORT:-8789}" bash "$SRC/clean-ports.sh"
elif [ -f "$DIR/clean-ports.sh" ]; then
  CLAUDE_ZEN_DIR="$DIR" ZEN_PROXY_PORT="${ZEN_PROXY_PORT:-8787}" ANTIGRAVITY_PORT="${ANTIGRAVITY_PORT:-8788}" CODEX_PORT="${CODEX_PORT:-8789}" bash "$DIR/clean-ports.sh"
else
  pkill -f "$DIR/zen-proxy.mjs" 2>/dev/null || true
  pkill -f "$DIR/antigravity-gateway.mjs" 2>/dev/null || true
  pkill -f "$DIR/codex-gateway.mjs" 2>/dev/null || true
  pkill -f "$DIR/watchdog.sh" 2>/dev/null || true
  rm -f "$DIR/watchdog.pid" "$DIR"/watchdog.lock.d* 2>/dev/null || true
fi

# 2. Verify Node is available
command -v node >/dev/null 2>&1 || die "node is not installed"
NODE_BIN="$(command -v node)"

# 3. Synchronize files from repository to ~/.zen-claude
mkdir -p "$DIR/lib" "$BIN"

install -m 644 "$SRC/zen-proxy.mjs"             "$DIR/zen-proxy.mjs"
install -m 644 "$SRC/codex-gateway.mjs"          "$DIR/codex-gateway.mjs"
install -m 644 "$SRC/antigravity-gateway.mjs"    "$DIR/antigravity-gateway.mjs"
install -m 644 "$SRC/lib/db.mjs"                "$DIR/lib/db.mjs"
install -m 644 "$SRC/lib/cleanup.mjs"           "$DIR/lib/cleanup.mjs"
install -m 644 "$SRC/lib/activity.mjs"          "$DIR/lib/activity.mjs"
install -m 644 "$SRC/lib/antigravity-models.mjs" "$DIR/lib/antigravity-models.mjs"
install -m 644 "$SRC/lib/antigravity-accounts.mjs" "$DIR/lib/antigravity-accounts.mjs"
install -m 644 "$SRC/lib/antigravity-login.mjs"    "$DIR/lib/antigravity-login.mjs"
install -m 644 "$SRC/lib/anthropic-antigravity.mjs" "$DIR/lib/anthropic-antigravity.mjs"
install -m 644 "$SRC/lib/input-budget.mjs"          "$DIR/lib/input-budget.mjs"
install -m 644 "$SRC/lib/opencode-zen.mjs"          "$DIR/lib/opencode-zen.mjs"
install -m 644 "$SRC/lib/antigravity-client.mjs" "$DIR/lib/antigravity-client.mjs"
install -m 644 "$SRC/lib/zen-accounts.mjs"        "$DIR/lib/zen-accounts.mjs"
install -m 644 "$SRC/lib/codex-accounts.mjs"    "$DIR/lib/codex-accounts.mjs"
install -m 644 "$SRC/lib/anthropic-codex.mjs"   "$DIR/lib/anthropic-codex.mjs"
install -m 644 "$SRC/lib/anthropic-sse.mjs"     "$DIR/lib/anthropic-sse.mjs"
install -m 644 "$SRC/lib/codex-app-server.mjs"  "$DIR/lib/codex-app-server.mjs"
install -m 644 "$SRC/lib/codex-login.mjs"       "$DIR/lib/codex-login.mjs"
install -m 644 "$SRC/lib/codex-models.mjs"      "$DIR/lib/codex-models.mjs"
install -m 644 "$SRC/lib/qwen-accounts.mjs"     "$DIR/lib/qwen-accounts.mjs"
install -m 644 "$SRC/lib/qwen-client.mjs"       "$DIR/lib/qwen-client.mjs"
install -m 644 "$SRC/lib/qwen-web-accounts.mjs" "$DIR/lib/qwen-web-accounts.mjs"
install -m 644 "$SRC/lib/qwen-web-client.mjs"   "$DIR/lib/qwen-web-client.mjs"
install -m 644 "$SRC/lib/qwen-models.mjs"       "$DIR/lib/qwen-models.mjs"
install -m 644 "$SRC/lib/routing-profiles.mjs"  "$DIR/lib/routing-profiles.mjs"
install -m 644 "$SRC/lib/ui.mjs"                "$DIR/lib/ui.mjs"
install -m 755 "$SRC/start.sh"                  "$DIR/start.sh"
install -m 755 "$SRC/clean-ports.sh"            "$DIR/clean-ports.sh"
install -m 755 "$SRC/update.sh"                 "$DIR/update.sh"
install -m 755 "$SRC/bin/claude-zen"             "$BIN/claude-zen"
install -m 755 "$SRC/bin/qwen-agent"             "$BIN/qwen-agent"
install -m 755 "$SRC/watchdog.sh"              "$DIR/watchdog.sh"
[ -f "$SRC/config.yaml" ] && [ ! -f "$DIR/config.yaml" ] && install -m 644 "$SRC/config.yaml" "$DIR/config.yaml"

# Preserve user configuration while migrating retired model identifiers.
if [ -f "$DIR/config.yaml" ] && grep -q 'gemini-3\.7-flash' "$DIR/config.yaml"; then
  sed -i.bak 's/gemini-3\.7-flash/gemini-3.8-flash/g' "$DIR/config.yaml"
  rm -f "$DIR/config.yaml.bak"
fi

ok "Synced codebase and UI files to $DIR"

# 4. Mode-specific operations
if [ "$MODE" = "hard" ]; then
  # Perform hard cache & rate-limit reset
  "$NODE_BIN" "$DIR/lib/cleanup.mjs" --hard
  ok "Reset all account rate-limit cooldowns in database"
  ok "Cleared cached provider model catalogs"
  ok "Truncated runtime logs and removed watchdog lock files"
else
  # Soft mode: just remove stale watchdog locks
  rm -rf "$DIR/watchdog.pid" "$DIR"/watchdog.lock.d* 2>/dev/null || true
  ok "Removed stale supervisor locks (accounts and history preserved)"
fi

echo ""
ok "Claude-Zen $MODE update completed successfully!"
echo ""
echo "Next steps:"
echo "  claude-zen         # Start coding with updated code"
echo "  claude-zen --ui    # Open the refreshed Web Dashboard"
echo ""
