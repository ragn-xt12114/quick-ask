#!/usr/bin/env bash
# Task 17 idle zero-outbound evidence (NFR-10).
#
# Starts the real Electron app hidden/tray with isolated XDG dirs, under
#   strace -f -e trace=connect
# waits for the `app_ready` log event, then runs for N minutes (default 5,
# i.e. 300s) while taking `ss -tnp` snapshots every 30s filtered to the app's
# PID tree. Fails on any non-loopback IPv4/IPv6 TCP connect, including ones
# made by Chromium helper processes (strace -f follows forks).
#
# Usage: bash tools/idle-net-check.sh [--minutes 5] [--out DIR]
#
# Evidence written:
#   <out>/task-17-idle-net.log      human summary
#   <out>/task-17-idle-net.json     machine summary
#   <out>/task-17-idle-ss.txt       periodic filtered ss snapshots
#   <out>/task-17-idle-strace.txt   every connect() line from strace -f
#
# Never uses pkill/killall: cleanup is PID-based from the spawned process tree.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

MINUTES=5
OUT_DIR="$ROOT/.omo/evidence"
while [ $# -gt 0 ]; do
  case "$1" in
    --minutes)
      MINUTES="${2:-}"; shift 2 ;;
    --out)
      OUT_DIR="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '1,40p' "$0"; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$MINUTES" in
  ''|*[!0-9]*)
    echo "invalid --minutes: $MINUTES" >&2; exit 2 ;;
esac
if [ "$MINUTES" -lt 1 ]; then
  echo "--minutes must be >= 1" >&2; exit 2
fi

for tool in strace ss node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "missing required tool: $tool" >&2
    exit 2
  fi
done

export DISPLAY="${DISPLAY:-:0}"
ELECTRON_BIN="${ELECTRON_BIN:-}"
if [ -z "$ELECTRON_BIN" ]; then
  ELECTRON_BIN=$(node -e "process.stdout.write(require('electron'))" 2>/dev/null || true)
fi
if [ -z "$ELECTRON_BIN" ] || [ ! -x "$ELECTRON_BIN" ]; then
  echo "could not resolve the Electron binary (set ELECTRON_BIN)" >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

RUNTIME="$ROOT/.runtime/task17-idle-net"
rm -rf "$RUNTIME"
mkdir -p \
  "$RUNTIME/xdg/config" \
  "$RUNTIME/xdg/data" \
  "$RUNTIME/xdg/state" \
  "$RUNTIME/xdg/cache"

export XDG_CONFIG_HOME="$RUNTIME/xdg/config"
export XDG_DATA_HOME="$RUNTIME/xdg/data"
export XDG_STATE_HOME="$RUNTIME/xdg/state"
export XDG_CACHE_HOME="$RUNTIME/xdg/cache"
export QUICKASK_DATA_DIR="$RUNTIME/xdg/data/quickask"
export QUICKASK_LOG_LEVEL="${QUICKASK_LOG_LEVEL:-info}"

LOG_FILE="$XDG_STATE_HOME/quickask/logs/quickask.log"
STRACE_RAW="$RUNTIME/strace.raw"
SS_RAW="$RUNTIME/ss.raw"
APP_STDOUT="$RUNTIME/app.stdout"
APP_STDERR="$RUNTIME/app.stderr"
: > "$SS_RAW"

descendants() {
  local pid="$1"
  printf '%s\n' "$pid"
  local children
  children=$(sed -n 's/^/ /p' "/proc/$pid/task/$pid/children" 2>/dev/null || true)
  local child
  for child in $children; do
    descendants "$child"
  done
}

app_pids() {
  descendants "$STRACE_PID" | tail -n +2
}

filter_ss_for_pids() {
  local snapshot="$1"
  local pids="$2"
  local pid line
  for pid in $pids; do
    while IFS= read -r line; do
      [ -n "$line" ] && printf '%s\n' "$line"
    done < <(printf '%s\n' "$snapshot" | grep -E "pid=${pid}[,)]" 2>/dev/null || true)
  done
}

write_startup_failure() {
  local reason="$1"
  {
    echo "TASK 17 IDLE NETWORK CHECK"
    echo "generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "requested_minutes: $MINUTES"
    echo "verdict: FAIL"
    echo "code: IDLE_NET_STARTUP_FAILED"
    echo "reason: $reason"
    echo ""
    echo "--- app stdout ---"
    tail -n 50 "$APP_STDOUT" 2>/dev/null || true
    echo "--- app stderr ---"
    tail -n 80 "$APP_STDERR" 2>/dev/null || true
    echo "--- log file ---"
    tail -n 80 "$LOG_FILE" 2>/dev/null || true
  } > "$OUT_DIR/task-17-idle-net.log"
  printf '{"verdict":"FAIL","code":"IDLE_NET_STARTUP_FAILED","reason":%s}\n' \
    "$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$reason")" \
    > "$OUT_DIR/task-17-idle-net.json"
}

echo "starting app under strace: $ELECTRON_BIN $ROOT"
strace -f -e trace=connect -qq -o "$STRACE_RAW" \
  "$ELECTRON_BIN" "$ROOT" >"$APP_STDOUT" 2>"$APP_STDERR" &
STRACE_PID=$!

READY=0
for _ in $(seq 1 60); do
  if [ -f "$LOG_FILE" ] && grep -q '"event":"app_ready"' "$LOG_FILE" 2>/dev/null; then
    READY=1
    break
  fi
  if ! kill -0 "$STRACE_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if [ "$READY" -ne 1 ]; then
  PIDS=$(app_pids)
  for pid in $(printf '%s\n' "$PIDS" | tac); do
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 1
  for pid in $(printf '%s\n' "$PIDS" | tac); do
    kill -KILL "$pid" 2>/dev/null || true
  done
  kill -TERM "$STRACE_PID" 2>/dev/null || true
  wait "$STRACE_PID" 2>/dev/null || true
  write_startup_failure "app_ready was not logged within 30s"
  cat "$OUT_DIR/task-17-idle-net.log"
  exit 1
fi

MAIN_PID=$(app_pids | head -n 1)
DURATION=$((MINUTES * 60))
START=$(date +%s)
EXITED_EARLY=0

echo "app ready; idle run for ${DURATION}s (main pid ${MAIN_PID:-unknown})"

while :; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START))
  if [ "$ELAPSED" -ge "$DURATION" ]; then
    break
  fi
  if ! kill -0 "$STRACE_PID" 2>/dev/null; then
    EXITED_EARLY=1
    break
  fi

  {
    echo "=== snapshot +${ELAPSED}s ==="
    PIDS=$(app_pids)
    SNAPSHOT=$(ss -H -tnp 2>/dev/null || true)
    MATCHED=$(filter_ss_for_pids "$SNAPSHOT" "$PIDS")
    if [ -n "$MATCHED" ]; then
      printf '%s\n' "$MATCHED" | sort -u
    else
      echo "(no TCP sockets for app pids)"
    fi
  } >> "$SS_RAW"

  REMAINING=$((DURATION - ELAPSED))
  SLEEP_FOR=30
  if [ "$REMAINING" -lt "$SLEEP_FOR" ]; then
    SLEEP_FOR=$REMAINING
  fi
  [ "$SLEEP_FOR" -le 0 ] && break
  sleep "$SLEEP_FOR"
done

# Final snapshot at the end of the window.
{
  echo "=== snapshot +$(( $(date +%s) - START ))s (final) ==="
  PIDS=$(app_pids)
  SNAPSHOT=$(ss -H -tnp 2>/dev/null || true)
  MATCHED=$(filter_ss_for_pids "$SNAPSHOT" "$PIDS")
  if [ -n "$MATCHED" ]; then
    printf '%s\n' "$MATCHED" | sort -u
  else
    echo "(no TCP sockets for app pids)"
  fi
} >> "$SS_RAW"

echo "stopping app (pid ${MAIN_PID:-unknown})"
# Graceful path: SIGTERM the Electron main process only, let lifecycle clean
# up its children. Killing helpers first causes GPU launch-failure noise.
if [ -n "$MAIN_PID" ]; then
  kill -TERM "$MAIN_PID" 2>/dev/null || true
fi
for _ in $(seq 1 20); do
  if ! kill -0 "$STRACE_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if kill -0 "$STRACE_PID" 2>/dev/null; then
  PIDS=$(app_pids)
  for pid in $(printf '%s\n' "$PIDS" | tac); do
    kill -KILL "$pid" 2>/dev/null || true
  done
  kill -TERM "$STRACE_PID" 2>/dev/null || true
  sleep 1
  kill -KILL "$STRACE_PID" 2>/dev/null || true
fi
wait "$STRACE_PID" 2>/dev/null || true

{
  echo "# Task 17 raw connect() syscalls captured with strace -f"
  echo "# generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# requested_minutes: $MINUTES"
  echo "# strace_pid: $STRACE_PID"
  echo "# app_main_pid: ${MAIN_PID:-unknown}"
  echo "# exited_early: $EXITED_EARLY"
  echo ""
  grep 'connect(' "$STRACE_RAW" 2>/dev/null || echo "(no connect syscalls)"
} > "$OUT_DIR/task-17-idle-strace.txt"
cp "$SS_RAW" "$OUT_DIR/task-17-idle-ss.txt"

{
  echo "# Task 17 idle run runtime details"
  echo "app_main_pid: ${MAIN_PID:-unknown}"
  echo "strace_pid: $STRACE_PID"
  echo "exited_early: $EXITED_EARLY"
  echo "started_at_epoch: $START"
  echo "finished_at_epoch: $(date +%s)"
  echo "xdg_config_home: $XDG_CONFIG_HOME"
  echo "xdg_state_home: $XDG_STATE_HOME"
  echo "quickask_data_dir: $QUICKASK_DATA_DIR"
  echo ""
  echo "--- app stdout ---"
  tail -n 50 "$APP_STDOUT" 2>/dev/null || true
  echo "--- app stderr (tail) ---"
  tail -n 50 "$APP_STDERR" 2>/dev/null || true
} > "$RUNTIME/run-details.txt"

node "$ROOT/tools/idle-net-parse.mjs" \
  --strace "$STRACE_RAW" \
  --ss "$SS_RAW" \
  --json "$OUT_DIR/task-17-idle-net.json" \
  --text "$OUT_DIR/task-17-idle-net.log" \
  --minutes "$MINUTES"
PARSE_STATUS=$?

if [ "$EXITED_EARLY" -eq 1 ]; then
  echo "IDLE_NET_APP_EXITED_EARLY" >> "$OUT_DIR/task-17-idle-net.log"
  exit 1
fi
exit "$PARSE_STATUS"
