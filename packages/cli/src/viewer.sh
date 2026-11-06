#!/bin/bash
# `af viewer`: the process inside a viewer pane (the af script runs this instead of viewer.ts: bash takes about 2 MB,
# bun about 16 MB, and a session can have a dozen viewer panes). The web UI draws a rich file/web view for the pane;
# this draws a plain one for the Herdr TUI, and follows the pane's target as agents change it with `af open --in`.
# Never exits by itself: while the server restarts, the last view stays. q or Ctrl+C closes the pane.

sock="${AF_SOCK:-$HOME/.agent-flow/server.sock}"
pane="${HERDR_PANE_ID:-}"
if [ -z "$pane" ]; then
  echo "af viewer runs inside a Herdr pane (HERDR_PANE_ID is not set)" >&2
  exit 2
fi
MAX_LINES=3000
bye() {
  printf '\033[?25h'
  exit 0
}
trap bye INT TERM
printf '\033[?25l'

render() {
  local t=$1
  printf '\033[2J\033[3J\033[H\033[2m≡ agent-flow viewer · shown in full in the web UI · q closes this pane\033[0m\n\033[1m%s\033[0m\n\n' "$t"
  case "$t" in
    [a-zA-Z]*://*)
      echo "Web page. Open the agent-flow web UI to see it."
      return
      ;;
  esac
  if [ ! -e "$t" ]; then
    printf '\033[31mThis path does not exist (any more).\033[0m\n'
  elif [ -d "$t" ]; then
    # folders first, in blue, then files
    ls -1pA "$t" 2>/dev/null | grep '/$' | sed $'s/^/\033[34m/; s/$/\033[0m/'
    ls -1pA "$t" 2>/dev/null | grep -v '/$'
  elif [ "$(wc -c <"$t" | tr -d ' ')" -gt 5000000 ]; then
    echo "Large file. Open it in the web UI or an editor."
  elif [ "$(file -b --mime-encoding "$t" 2>/dev/null)" = binary ]; then
    echo "Binary file. Open it in the web UI or an editor."
  elif command -v bat >/dev/null 2>&1; then
    COLUMNS=$(tput cols 2>/dev/null || echo 100) bat --paging=never --color=always --style=numbers --line-range ":$MAX_LINES" "$t" 2>/dev/null || cat "$t"
  else
    local n
    n=$(head -n "$MAX_LINES" "$t" | wc -l | tr -d ' ')
    head -n "$MAX_LINES" "$t" | awk -v w="${#n}" '{ printf "\033[2m%*d\033[0m  %s\n", w, NR, $0 }'
  fi
}

shown=""
while :; do
  t=$(curl -s -m 3 --unix-socket "$sock" "http://af/view?pane=$pane&format=text" 2>/dev/null)
  if [ -n "$t" ]; then
    stamp=$t
    if [ -e "$t" ]; then stamp="$t@$(stat -f %m "$t" 2>/dev/null || stat -c %Y "$t" 2>/dev/null)"; fi
    if [ "$stamp" != "$shown" ]; then
      shown=$stamp
      render "$t"
    fi
  fi
  # a key: q (or Ctrl+C, trapped above) closes the pane; otherwise look again in 2 s
  if IFS= read -rsn1 -t 2 key && [ "$key" = q ]; then bye; fi
done
