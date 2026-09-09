#!/usr/bin/env bash
# Installs the Zen bridge into ~/.zen-claude and the launcher into ~/.local/bin.
# Safe to re-run; it overwrites the code and leaves your key alone.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DIR="$HOME/.zen-claude"
BIN="$HOME/.local/bin"

say()  { printf '  %s\n' "$1"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
die()  { printf '  \033[31mfail\033[0m %s\n' "$1" >&2; exit 1; }

echo ""
echo "Installing claude-zen"
echo ""

# ---- prerequisites -------------------------------------------------------
command -v node >/dev/null 2>&1 || die "node is not installed (need v22+)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node v22+ required (found v$NODE_MAJOR) -- needs node:sqlite"
ok "node v$(node -p 'process.versions.node')"

command -v python3 >/dev/null 2>&1 || die "python3 is not installed"
ok "python3"

if command -v claude >/dev/null 2>&1; then
  ok "claude on PATH"
else
  say "warn Claude Code is not on PATH yet."
  say "     Install it first: https://claude.com/claude-code"
fi

# ---- api key -------------------------------------------------------------
KEY="${ZEN_API_KEY:-${1:-}}"
if [ -z "$KEY" ] && [ -f "$DIR/.env" ]; then
  KEY="$(grep '^ZEN_API_KEY=' "$DIR/.env" | cut -d= -f2- || true)"
  [ -n "$KEY" ] && say "using the key already in $DIR/.env"
fi
if [ -z "$KEY" ]; then
  echo ""
  say "Get a free key at https://opencode.ai -- it looks like sk-<61 chars>"
  printf '  OpenCode Zen API key: '
  read -r KEY
fi

case "$KEY" in
  sk-*) ;;
  *) die "that doesn't look like a Zen key (should start with sk-)" ;;
esac
[ "${#KEY}" -ge 32 ] || die "that key looks too short to be real"

# ---- write files ---------------------------------------------------------
mkdir -p "$DIR/lib" "$BIN"

NODE_BIN="$(command -v node)"
printf 'ZEN_API_KEY=%s\nNODE_BIN=%s\n' "$KEY" "$NODE_BIN" > "$DIR/.env"
chmod 600 "$DIR/.env"
ok "wrote $DIR/.env (chmod 600)"

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
install -m 644 "$SRC/config.yaml"               "$DIR/config.yaml"
ok "installed proxy + Codex gateway + Antigravity gateway + UI + launcher"

# ---- initialize codex, antigravity, and zen accounts & metrics DB --------
node -e "
  Promise.all([
    import('$DIR/lib/codex-accounts.mjs').then(async ({ codexAccountManager }) => {
      await codexAccountManager.init();
      const count = codexAccountManager.listAccounts().filter((account) => account.provider === 'codex').length;
      if (count > 0) {
        console.log('  \x1b[32mok\x1b[0m   imported ' + count + ' ChatGPT Plus account(s) into SQLite');
      }
    }),
    import('$DIR/lib/antigravity-accounts.mjs').then(async ({ antigravityAccountManager }) => {
      await antigravityAccountManager.init();
      const count = antigravityAccountManager.listAccounts().length;
      if (count > 0) {
        console.log('  \x1b[32mok\x1b[0m   imported ' + count + ' Google Antigravity account(s) into SQLite');
      }
    }),
    import('$DIR/lib/zen-accounts.mjs').then(async ({ zenAccountManager }) => {
      await zenAccountManager.init();
      const count = zenAccountManager.listAccounts().length;
      if (count > 0) {
        console.log('  \x1b[32mok\x1b[0m   imported ' + count + ' OpenCode Zen account(s) into SQLite');
      }
    })
  ]).catch(() => {});
" 2>/dev/null || true

# ---- PATH ----------------------------------------------------------------
case ":$PATH:" in
  *":$BIN:"*) ok "$BIN is on PATH" ;;
  *)
    say "warn $BIN is not on your PATH. Add this to your shell profile:"
    say "       export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

# ---- settings.json conflict ---------------------------------------------
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ] && grep -q 'ANTHROPIC_.*MODEL' "$SETTINGS" 2>/dev/null; then
  echo ""
  say "note ~/.claude/settings.json pins ANTHROPIC_*_MODEL values."
  say "     Those override environment variables, so claude-zen passes the"
  say "     model as a CLI flag to beat them. Nothing to fix -- just so you"
  say "     know why plain \`claude\` and \`claude-zen\` behave differently."
fi

echo ""
echo "Done. Next:"
echo ""
echo "    ./verify.sh        # prove it works"
echo "    claude-zen         # start coding"
echo ""
