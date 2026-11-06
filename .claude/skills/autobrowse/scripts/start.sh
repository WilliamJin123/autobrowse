#!/bin/bash
# start.sh <site> [url] [port] [explore flags…]  → one explore session in the background; prints the port when it takes commands.
# The token lands in $TMPDIR/autobrowse/explore-<port>.token (owner-only); cmd.sh reads it, nothing prints it.
set -euo pipefail
SITE=${1:?site}; URL=${2:-}; PORT=${3:-9090}
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
DIR=${TMPDIR:-/tmp}/autobrowse; mkdir -p "$DIR"; chmod 700 "$DIR"
TOKEN="$DIR/explore-$PORT.token"; LOG="$DIR/explore-$PORT.log"
if [ -f "$TOKEN" ] && curl -s -m 3 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$TOKEN")" "http://127.0.0.1:$PORT/" -d '{"cmd":"url"}' | grep -q 200; then
  echo "port $PORT already open"; exit 0
fi
# A live session that is busy keeps its token: a second start would fight it for the port.
INFO="$DIR/explore-$PORT.json"
if [ -f "$INFO" ]; then
  OLD=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$INFO")
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "port $PORT: explore pid $OLD is alive and does not answer. End it: autobrowse stop $PORT"; exit 1
  fi
fi
rm -f "$TOKEN"
ARGS=(explore "$SITE" --port "$PORT"); [ -n "$URL" ] && ARGS+=(--url "$URL")
[ $# -gt 3 ] && ARGS+=("${@:4}")  # --signup/--codes/--login/--headed: what place may type
# exec: the forked shell becomes the CLI, so nothing holds our stdout open (`start.sh | tail` returns)
(cd "$ROOT" && exec nohup "$ROOT/bin/autobrowse" "${ARGS[@]}" </dev/null >"$LOG" 2>&1 &)
# Tight memory is a warning, not a stop: the CLI wrote it to the log (a block that a blank line ends).
warned() { sed -n '/^warning: memory is tight/,/^$/p' "$LOG" | sed '/^$/d'; }
for _ in $(seq 1 120); do
  [ -f "$TOKEN" ] && { warned; echo "port $PORT"; echo "log $LOG"; echo "when done: autobrowse stop $PORT achieved|failed \"why\""; exit 0; }
  if ! pgrep -qf "explore $SITE --port $PORT"; then sleep 1; [ -f "$TOKEN" ] && { warned; echo "port $PORT"; exit 0; }; echo "explore exited; log:"; sed 's/[A-Za-z0-9_-]\{30,\}/<tok>/g' "$LOG" | tail -20; exit 1; fi
  sleep 1
done
echo "no token after 120s; log:"; sed 's/[A-Za-z0-9_-]\{30,\}/<tok>/g' "$LOG" | tail -20; exit 1
