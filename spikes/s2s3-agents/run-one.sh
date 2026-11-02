#!/bin/bash
# usage: run-one.sh <kind> <name> <workdir>  → creates tab, starts agent with injection, prints pane id
set -euo pipefail
KIND=$1 NAME=$2 WD=$3
HERE=$(cd "$(dirname "$0")" && pwd); BIN=$HERE/bin; PROTO=$HERE/worker.md
herdr tab create --workspace wM --cwd "$WD" --label "$NAME" --env AF_RUN=spike --env "AF_AGENT=$NAME" --env AF_SOCK=/tmp/afs/server.sock --env "PATH=$BIN:$PATH" --no-focus > /tmp/afs-tab-$NAME.json
PANE=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['result']['root_pane']['pane_id'])" /tmp/afs-tab-$NAME.json)
sleep 1
case $KIND in
  claude) herdr agent start "$NAME" --kind claude --pane "$PANE" --timeout 60000 -- --append-system-prompt-file "$PROTO" --permission-mode auto >/dev/null ;;
  codex)  ONE=$(tr '\n' ' ' < "$PROTO")
          herdr agent start "$NAME" --kind codex --pane "$PANE" --timeout 60000 -- -c check_for_update_on_startup=false -c "developer_instructions=$ONE" -s workspace-write -c sandbox_workspace_write.network_access=true -a never --add-dir /tmp/afs >/dev/null ;;
  omp)    herdr agent start "$NAME" --kind omp --pane "$PANE" --timeout 60000 -- "--append-system-prompt=$PROTO" >/dev/null ;;
esac
echo "$PANE"
