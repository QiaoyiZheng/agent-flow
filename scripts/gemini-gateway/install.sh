#!/bin/sh
# Set up Gemini CLI to use an API gateway on this machine (run on the machine itself, or: ssh host sh -s < install.sh).
#
#   GEMINI_GATEWAY_URL=http://host:port GEMINI_GATEWAY_KEY=sk-... sh install.sh [shell-rc-file] [top|end]
#
# Needs Gemini CLI installed (npm install -g @google/gemini-cli) and its node (20+). Writes:
#   ~/.gemini/gateway.env              the key and address (mode 600), and a `gemini` shell function
#   ~/.gemini/agent-flow/gemini        starts Gemini CLI with gateway-fix.mjs loaded
#   ~/.gemini/agent-flow/gateway-fix.mjs   (copied next to this script, or from stdin's companion: see GATEWAY_FIX)
#   ~/.gemini/settings.json            API-key login and a default model, if there is no settings file yet
# and adds one line to the shell rc file that loads gateway.env.
set -e
: "${GEMINI_GATEWAY_URL:?set GEMINI_GATEWAY_URL}" "${GEMINI_GATEWAY_KEY:?set GEMINI_GATEWAY_KEY}"
MODEL="${GEMINI_MODEL:-gemini-4-argon}"
RC="${1:-$HOME/.bashrc}"
WHERE="${2:-end}"
D="$HOME/.gemini/agent-flow"
mkdir -p "$D"

# the fix module: next to this script, or passed in GATEWAY_FIX (its text) when the script is piped over ssh
if [ -n "$GATEWAY_FIX" ]; then printf '%s\n' "$GATEWAY_FIX" > "$D/gateway-fix.mjs"
elif [ -f "$(dirname "$0")/gateway-fix.mjs" ]; then cp "$(dirname "$0")/gateway-fix.mjs" "$D/gateway-fix.mjs"
else echo "gateway-fix.mjs not found" >&2; exit 1; fi

# Gemini CLI's script and a node new enough for it (on some servers the system node is too old)
JS=""
for c in "$(command -v gemini 2>/dev/null)" "$HOME"/.local/node-*/lib/node_modules/@google/gemini-cli/bundle/gemini.js; do
  [ -n "$c" ] && [ -e "$c" ] || continue
  # npm's link to the bundle
  r=$(readlink -f "$c" 2>/dev/null || true)
  case "$r" in */gemini-cli/bundle/gemini.js) JS="$r"; break;; esac
  # a wrapper script naming the bundle
  b=$(grep -o '[^ "]*gemini-cli/bundle/gemini.js' "$c" 2>/dev/null | head -n 1 || true)
  [ -n "$b" ] && [ -f "$b" ] && { JS="$b"; break; }
done
[ -n "$JS" ] || { echo "Gemini CLI not found" >&2; exit 1; }
NODE=""
# the node of the prefix Gemini CLI was installed into (<prefix>/lib/node_modules/@google/gemini-cli/bundle), else node
for n in "$(dirname "$JS")/../../../../../bin/node" "$(command -v node)"; do
  [ -x "$n" ] || continue
  v=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$v" -ge 20 ] 2>/dev/null && { NODE=$(cd "$(dirname "$n")" && pwd)/$(basename "$n"); break; }
done
[ -n "$NODE" ] || { echo "no node 20+ found for Gemini CLI" >&2; exit 1; }

cat > "$D/gemini" <<EOF
#!/bin/sh
# Gemini CLI with gateway-fix.mjs (written by agent-flow's scripts/gemini-gateway/install.sh)
exec "$NODE" --import="$D/gateway-fix.mjs" "$JS" "\$@"
EOF
chmod +x "$D/gemini"

umask 077
cat > "$HOME/.gemini/gateway.env" <<EOF
# Gemini CLI through the API gateway (agent-flow's scripts/gemini-gateway/install.sh). Loaded by the shell rc file.
export GEMINI_API_KEY='$GEMINI_GATEWAY_KEY'
export GOOGLE_GEMINI_BASE_URL='$GEMINI_GATEWAY_URL'
gemini() { "\$HOME/.gemini/agent-flow/gemini" "\$@"; }
EOF
chmod 600 "$HOME/.gemini/gateway.env"
umask 022

if [ ! -f "$HOME/.gemini/settings.json" ]; then
  cat > "$HOME/.gemini/settings.json" <<EOF
{
  "security": { "auth": { "selectedType": "gemini-api-key" } },
  "model": { "name": "$MODEL" }
}
EOF
fi

LINE='[ -f "$HOME/.gemini/gateway.env" ] && . "$HOME/.gemini/gateway.env"  # Gemini CLI gateway'
if ! grep -qF '.gemini/gateway.env' "$RC" 2>/dev/null; then
  if [ "$WHERE" = top ] && [ -f "$RC" ]; then { echo "$LINE"; cat "$RC"; } > "$RC.af-tmp" && cat "$RC.af-tmp" > "$RC" && rm -f "$RC.af-tmp"
  else printf '\n%s\n' "$LINE" >> "$RC"; fi
fi
echo "gemini: $NODE --import=$D/gateway-fix.mjs $JS"
