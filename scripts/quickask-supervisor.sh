#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${QUICKASK_PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
APP_BIN="${QUICKASK_APP_BIN:-$PROJECT_ROOT/release/linux-unpacked/quickask}"
RUNTIME_DIR="${QUICKASK_SUPERVISOR_RUNTIME_DIR:-$PROJECT_ROOT/.runtime}"
LOCK_FILE="${QUICKASK_SUPERVISOR_LOCK:-$RUNTIME_DIR/quickask-supervisor.lock}"
STOP_FILE="${QUICKASK_SUPERVISOR_STOP:-$RUNTIME_DIR/quickask-supervisor.stop}"
LOG_FILE="${QUICKASK_SUPERVISOR_LOG:-$RUNTIME_DIR/quickask-supervisor.log}"
RESTART_DELAY="${QUICKASK_SUPERVISOR_RESTART_DELAY:-1}"

mkdir -p "$RUNTIME_DIR"
exec 9>"$LOCK_FILE" || exit 1
if ! flock -n 9; then
  printf '%s supervisor already running\n' "$(date -Is)" >&2
  exit 0
fi

child_pid=0
stopping=0

log() {
  printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG_FILE"
}

stop_child() {
  if [[ "$child_pid" -gt 0 ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null
    wait "$child_pid" 2>/dev/null
  fi
  child_pid=0
}

on_signal() {
  stopping=1
  stop_child
  log "supervisor stopping"
  exit 0
}

trap on_signal TERM INT HUP

log "supervisor start app=$APP_BIN stop=$STOP_FILE"

while :; do
  if [[ -f "$STOP_FILE" ]]; then
    log "stop file present before start"
    break
  fi
  if [[ ! -x "$APP_BIN" ]]; then
    log "app is not executable: $APP_BIN"
    exit 1
  fi

  "$APP_BIN" &
  child_pid=$!
  wait "$child_pid"
  exit_code=$?
  child_pid=0

  if [[ "$stopping" -eq 1 ]]; then
    exit 0
  fi
  if [[ "$exit_code" -eq 0 ]]; then
    log "app exited cleanly"
    break
  fi
  if [[ -f "$STOP_FILE" ]]; then
    log "app exited $exit_code with stop file present"
    break
  fi

  log "app exited $exit_code; restarting in ${RESTART_DELAY}s"
  sleep "$RESTART_DELAY" &
  wait $!
  if [[ "$stopping" -eq 1 ]]; then
    exit 0
  fi
done

log "supervisor exit"
exit 0
