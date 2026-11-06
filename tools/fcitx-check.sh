#!/usr/bin/env bash
# QuickAsk M0 — G6 fcitx5 Chinese / candidate window / composing Enter+Esc
# end-to-end driver.
#
# Usage:
#   source scripts/env.sh
#   bash tools/fcitx-check.sh [--out .omo/evidence/] [--app spike/ime.cjs] [--port 18080]
#
# The driver:
#   1. records fcitx5-remote/diagnose state and saves the prior group/IM/active
#      state in a trap that restores it even on failure;
#   2. starts tools/mock-sse-server.mjs and the Electron spike;
#   3. focuses the spike window and types real xdotool keystrokes through
#      fcitx5 (never clipboard/DOM injection);
#   4. captures the candidate window screenshot + geometry;
#   5. asserts composing-Enter = 0 HTTP requests, committed-Enter = exactly 1;
#   6. asserts composing-Escape cancels composition without hiding the window;
#   7. asserts Tab/Ctrl shortcuts are ignored during composition;
#   8. writes task-5-summary.json and all task-5-* evidence.
#
# It never edits fcitx5 configuration files. Only runtime fcitx5-remote calls
# are used, and the prior state is restored on exit.
#
# Kill policy: PID/process-group only. NEVER pkill -f / killall.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
# shellcheck disable=SC1091
source scripts/env.sh

export DISPLAY="${DISPLAY:-:0}"
export XMODIFIERS="@im=fcitx"
export GTK_IM_MODULE="fcitx"
export QT_IM_MODULE="fcitx"
export GDK_BACKEND="x11"
export QT_QPA_PLATFORM="xcb"

OUT="$ROOT/.omo/evidence"
APP="$ROOT/spike/ime.cjs"
PORT=18080

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out)
      OUT="$2"
      shift 2
      ;;
    --app)
      APP="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$OUT" in
  /*) ;;
  *) OUT="$ROOT/$OUT" ;;
esac
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
case "$APP" in
  /*) ;;
  *) APP="$ROOT/$APP" ;;
esac

ELECTRON="$ROOT/node_modules/.bin/electron"
HELPER="$ROOT/native/quickask-x11"
PROBE="$ROOT/tools/ime-probe.mjs"
ANALYZE="$ROOT/tools/ime-analyze.mjs"
MOCK="$ROOT/tools/mock-sse-server.mjs"

SESSION_FILE="$OUT/task-5-session-state.txt"
DIAG_FILE="$OUT/task-5-fcitx5-diagnose.txt"
STATE_BEFORE_FILE="$OUT/task-5-fcitx-state-before.txt"
STATE_AFTER_FILE="$OUT/task-5-fcitx-state-after.txt"
CONFIG_BEFORE_FILE="$OUT/task-5-config-hashes-before.txt"
CONFIG_AFTER_FILE="$OUT/task-5-config-hashes-after.txt"
APP_LOG="$OUT/task-5-app.log"
SERVER_LOG="$OUT/task-5-server.log"
SERVER_OUT="$OUT/task-5-server-stdout.log"
STATE="$OUT/task-5-ime-state.json"
EVENTS="$OUT/task-5-events.jsonl"
SHORTCUTS="$OUT/task-5-shortcuts.jsonl"
CANDIDATE_JSON="$OUT/task-5-candidate.json"
CANDIDATE_TXT="$OUT/task-5-candidate-windows.txt"
CANDIDATE_PNG="$OUT/task-5-candidate.png"
CANDIDATE_CROP="$OUT/task-5-candidate-crop.png"
ESC_PNG="$OUT/task-5-esc.png"
CLEANUP_FILE="$OUT/task-5-cleanup.txt"
REQ_BEFORE="$OUT/task-5-requests-before.txt"
REQ_AFTER="$OUT/task-5-requests-after.txt"
REQ_AFTER_COMPOSING="$OUT/task-5-requests-after-composing-enter.txt"
SHORTCUTS_RAW="$OUT/task-5-composition-shortcuts-raw.jsonl"
SHORTCUTS_JSON="$OUT/task-5-composition-shortcuts.json"
FACTS="$OUT/task-5-facts.json"
EVENTS_EXCERPT="$OUT/task-5-events-excerpt.json"
SUMMARY="$OUT/task-5-summary.json"
RUN_LOG="$OUT/task-5-run.log"

: > "$RUN_LOG"
log() {
  printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$RUN_LOG"
}
log_cmd() {
  printf '\n$ %s\n' "$*" >> "$RUN_LOG"
  "$@" >> "$RUN_LOG" 2>&1
}

# ---------------------------------------------------------------- preflight
missing=()
for cmd in node jq xdotool xwininfo xprop spectacle fcitx5-remote fcitx5-diagnose sha256sum curl setsid xdpyinfo pgrep; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
[ -x "$ELECTRON" ] || missing+=("$ELECTRON")
[ -x "$HELPER" ] || missing+=("$HELPER")
[ -f "$PROBE" ] || missing+=("$PROBE")
[ -f "$ANALYZE" ] || missing+=("$ANALYZE")
[ -f "$MOCK" ] || missing+=("$MOCK")
if [ "${#missing[@]}" -gt 0 ]; then
  log "MISSING required tools/files: ${missing[*]}"
  exit 2
fi

ABORTED_LOCKED=0
screensaver_active() {
  qdbus6 org.freedesktop.ScreenSaver /ScreenSaver org.freedesktop.ScreenSaver.GetActive 2>/dev/null | tr -d '[:space:]'
}
lock_window() {
  xdotool search --class kscreenlocker_greet 2>/dev/null | head -1 || true
}
assert_unlocked() {
  local active lock
  active="$(screensaver_active)"
  lock="$(lock_window)"
  if [ "${active:-}" = "true" ] || [ -n "${lock:-}" ]; then
    ABORTED_LOCKED=1
    log "ABORT: session locked (screensaver_active=${active:-unknown}, lock_window=${lock:-none})"
    {
      echo "aborted_at=$(date -Is)"
      echo "screensaver_active=${active:-unknown}"
      echo "lock_window=${lock:-none}"
      echo "reason=session locked; no locked-screen evidence is valid"
    } > "$OUT/task-5-aborted-locked.txt"
    return 1
  fi
  return 0
}
has_cjk() {
  node -e 'process.exit(/[\u4e00-\u9fff]/.test(process.argv[1]) ? 0 : 1)' "$1"
}

if ! assert_unlocked; then
  exit 3
fi

SCREEN_DIMS="$(xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2; exit}')"
{
  echo "generated_at=$(date -Is)"
  echo "display=$DISPLAY"
  echo "screen=$SCREEN_DIMS"
  echo "screensaver_active=$(screensaver_active)"
  echo "lock_window=$(lock_window)"
  echo "compositor_active=$(qdbus6 org.kde.KWin /Compositor org.kde.kwin.Compositing.active 2>/dev/null | tr -d '[:space:]')"
  echo "electron_version=$("$ELECTRON" --version 2>/dev/null | tail -1)"
  echo "node_version=$(node --version)"
  echo "fcitx5_pid_before=$(pgrep -x fcitx5 | tr '\n' ' ')"
} > "$SESSION_FILE"

log "== G6 fcitx5 IME driver: out=$OUT app=$APP port=$PORT"
{
  echo "# command: fcitx5-diagnose"
  echo "# generated_at: $(date -Is)"
  fcitx5-diagnose 2>&1
} > "$DIAG_FILE" || true
log "fcitx5-diagnose -> $DIAG_FILE"

# ---------------------------------------------------------------- fcitx state
PRIOR_STATE="$(fcitx5-remote 2>/dev/null | tr -d '[:space:]')"
PRIOR_GROUP="$(fcitx5-remote -q 2>/dev/null)"
PRIOR_IM="$(fcitx5-remote -n 2>/dev/null)"
FCITX_PID_BEFORE="$(pgrep -x fcitx5 | tr '\n' ' ' | sed 's/ *$//')"
{
  echo "generated_at=$(date -Is)"
  echo "fcitx5_pid=$FCITX_PID_BEFORE"
  echo "state=$PRIOR_STATE"
  echo "group=$PRIOR_GROUP"
  echo "im=$PRIOR_IM"
  echo "fcitx5-remote=$PRIOR_STATE"
  echo "fcitx5-remote-q=$PRIOR_GROUP"
  echo "fcitx5-remote-n=$PRIOR_IM"
} > "$STATE_BEFORE_FILE"

config_hash_file() {
  local file="$1"
  if [ -f "$file" ]; then
    sha256sum "$file" | awk '{print $1}'
  else
    echo "missing"
  fi
}
PROFILE_FILE="$HOME/.config/fcitx5/profile"
PINYIN_CONF="$HOME/.config/fcitx5/conf/pinyin.conf"
RIME_CONF="$HOME/.config/fcitx5/conf/rime.conf"
HASH_PROFILE_BEFORE="$(config_hash_file "$PROFILE_FILE")"
HASH_PINYIN_BEFORE="$(config_hash_file "$PINYIN_CONF")"
HASH_RIME_BEFORE="$(config_hash_file "$RIME_CONF")"
{
  echo "profile=$HASH_PROFILE_BEFORE"
  echo "pinyin.conf=$HASH_PINYIN_BEFORE"
  echo "rime.conf=$HASH_RIME_BEFORE"
} > "$CONFIG_BEFORE_FILE"

APP_PID=""
SERVER_PID=""
WID_HEX=""
WID_DEC=""
USED_IM=""
PINYIN_SWITCH_ATTEMPTED=0
PINYIN_SWITCH_EFFECTIVE=0
FINALIZED=0
FINAL_EXIT=0
ABORT_REASON=""

# Scenario fact variables (defaults: fail).
CAND_FOUND=0
CAND_PASS=0
ENTER_COMPOSING_REQUESTS=0
ENTER_COMPOSING_REQUESTS_BEFORE=0
ENTER_COMPOSING_VALUE=""
ENTER_COMPOSING_SENDS=0
ENTER_COMPOSING_SEND_REQUESTED=0
ENTER_COMPOSING_COMPOSITION_ENDED=0
ENTER_COMPOSING_CHINESE=0
ENTER_COMPOSING_PASS=0
CHINESE_COMMIT_VALUE=""
CHINESE_COMMIT_PASS=0
ENTER_COMMITTED_REQUESTS=0
ENTER_COMMITTED_VALUE=""
ENTER_COMMITTED_SENDS=0
ENTER_COMMITTED_SEND_REQUESTED=0
ENTER_COMMITTED_PASS=0
ESC_WINDOW_VISIBLE=0
ESC_MAP_STATE="unknown"
ESC_COMPOSITION_CANCELED=0
ESC_VALUE=""
ESC_HIDDEN_BEFORE=0
ESC_HIDDEN_AFTER=0
ESC_CANDIDATE_VISIBLE_AFTER=0
ESC_PASS=0
SHORTCUT_PASS=0
SHORTCUT_TRIGGERED_COUNT=0
SHORTCUT_SENDS_DELTA=0
KP_ENTER_PASS=0

kill_pid_tree() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
  # The app is started with setsid; its negative PID is the process group.
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || true
  fi
  local i
  for i in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
}

restore_fcitx() {
  [ -n "${PRIOR_GROUP:-}" ] && fcitx5-remote -g "$PRIOR_GROUP" >/dev/null 2>&1 || true
  [ -n "${PRIOR_IM:-}" ] && fcitx5-remote -s "$PRIOR_IM" >/dev/null 2>&1 || true
  case "${PRIOR_STATE:-}" in
    2) fcitx5-remote -o >/dev/null 2>&1 || true ;;
    1) fcitx5-remote -c >/dev/null 2>&1 || true ;;
    *)
      # fcitx5-remote has no documented command to restore state 0; record it.
      ;;
  esac
}

write_after_state() {
  local state group im
  state="$(fcitx5-remote 2>/dev/null | tr -d '[:space:]')"
  group="$(fcitx5-remote -q 2>/dev/null)"
  im="$(fcitx5-remote -n 2>/dev/null)"
  {
    echo "generated_at=$(date -Is)"
    echo "fcitx5_pid=$(pgrep -x fcitx5 | tr '\n' ' ' | sed 's/ *$//')"
    echo "state=$state"
    echo "group=$group"
    echo "im=$im"
    echo "prior_state=$PRIOR_STATE"
    echo "prior_group=$PRIOR_GROUP"
    echo "prior_im=$PRIOR_IM"
    echo "restored_exact=$([ "$state" = "$PRIOR_STATE" ] && [ "$group" = "$PRIOR_GROUP" ] && [ "$im" = "$PRIOR_IM" ] && echo true || echo false)"
  } > "$STATE_AFTER_FILE"
  STATE_AFTER_VALUE="$state"
  GROUP_AFTER_VALUE="$group"
  IM_AFTER_VALUE="$im"
  HASH_PROFILE_AFTER="$(config_hash_file "$PROFILE_FILE")"
  HASH_PINYIN_AFTER="$(config_hash_file "$PINYIN_CONF")"
  HASH_RIME_AFTER="$(config_hash_file "$RIME_CONF")"
  {
    echo "profile=$HASH_PROFILE_AFTER"
    echo "pinyin.conf=$HASH_PINYIN_AFTER"
    echo "rime.conf=$HASH_RIME_AFTER"
  } > "$CONFIG_AFTER_FILE"
}
STATE_AFTER_VALUE=""
GROUP_AFTER_VALUE=""
IM_AFTER_VALUE=""
HASH_PROFILE_AFTER=""
HASH_PINYIN_AFTER=""
HASH_RIME_AFTER=""

stop_processes() {
  if [ -n "${APP_PID:-}" ]; then
    kill_pid_tree "$APP_PID"
    APP_PID=""
  fi
  if [ -n "${SERVER_PID:-}" ]; then
    kill_pid_tree "$SERVER_PID"
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
  sleep 0.3
}

build_summary() {
  local restored_exact="false"
  if [ "$STATE_AFTER_VALUE" = "$PRIOR_STATE" ] && [ "$GROUP_AFTER_VALUE" = "$PRIOR_GROUP" ] && [ "$IM_AFTER_VALUE" = "$PRIOR_IM" ]; then
    restored_exact="true"
  fi
  local running="false"
  [ -n "$(pgrep -x fcitx5)" ] && running="true"

  # The analyzer must never crash on a partial run.
  [ -f "$EVENTS" ] || : > "$EVENTS"

  # Shortcut result file defaults so the analyzer never crashes.
  if [ ! -s "$SHORTCUTS_JSON" ]; then
    jq -n --argjson pass false \
      '{pass:$pass, events:[], triggered_count:0, sends_delta:0, note:"driver did not reach shortcut phase"}' \
      > "$SHORTCUTS_JSON" 2>/dev/null || echo '{"pass":false,"events":[],"triggered_count":0,"sends_delta":0}' > "$SHORTCUTS_JSON"
  fi
  if [ ! -s "$CANDIDATE_JSON" ]; then
    echo '{"found":false,"wids":[],"geometry":null,"distance_px":null,"metric":null,"pass":false,"all":[]}' > "$CANDIDATE_JSON"
  fi

  local limitations_json
  limitations_json="$(jq -n '[]')"

  jq -n \
    --argjson running "$running" \
    --arg state_before "$PRIOR_STATE" \
    --arg group_before "$PRIOR_GROUP" \
    --arg im_before "$PRIOR_IM" \
    --arg used_im "$USED_IM" \
    --arg state_after "$STATE_AFTER_VALUE" \
    --arg group_after "$GROUP_AFTER_VALUE" \
    --arg im_after "$IM_AFTER_VALUE" \
    --argjson pinyin_attempted "$([ "$PINYIN_SWITCH_ATTEMPTED" = 1 ] && echo true || echo false)" \
    --argjson pinyin_effective "$([ "$PINYIN_SWITCH_EFFECTIVE" = 1 ] && echo true || echo false)" \
    --argjson restored_exact "$restored_exact" \
    --arg hash_profile_before "$HASH_PROFILE_BEFORE" \
    --arg hash_pinyin_before "$HASH_PINYIN_BEFORE" \
    --arg hash_rime_before "$HASH_RIME_BEFORE" \
    --arg hash_profile_after "$HASH_PROFILE_AFTER" \
    --arg hash_pinyin_after "$HASH_PINYIN_AFTER" \
    --arg hash_rime_after "$HASH_RIME_AFTER" \
    --slurpfile candidate "$CANDIDATE_JSON" \
    --slurpfile shortcuts "$SHORTCUTS_JSON" \
    --argjson ec_requests "$ENTER_COMPOSING_REQUESTS" \
    --argjson ec_requests_before "$ENTER_COMPOSING_REQUESTS_BEFORE" \
    --arg ec_value "$ENTER_COMPOSING_VALUE" \
    --argjson ec_sends "$ENTER_COMPOSING_SENDS" \
    --argjson ec_send_requested "$ENTER_COMPOSING_SEND_REQUESTED" \
    --argjson ec_composition_ended "$ENTER_COMPOSING_COMPOSITION_ENDED" \
    --argjson ec_pass "$ENTER_COMPOSING_PASS" \
    --argjson ec_chinese "$ENTER_COMPOSING_CHINESE" \
    --arg chinese_value "$CHINESE_COMMIT_VALUE" \
    --argjson ecm_requests "$ENTER_COMMITTED_REQUESTS" \
    --arg ecm_value "$ENTER_COMMITTED_VALUE" \
    --argjson ecm_sends "$ENTER_COMMITTED_SENDS" \
    --argjson ecm_send_requested "$ENTER_COMMITTED_SEND_REQUESTED" \
    --argjson ecm_pass "$ENTER_COMMITTED_PASS" \
    --argjson esc_visible "$ESC_WINDOW_VISIBLE" \
    --arg esc_map_state "$ESC_MAP_STATE" \
    --argjson esc_canceled "$ESC_COMPOSITION_CANCELED" \
    --arg esc_value "$ESC_VALUE" \
    --argjson esc_hidden_before "$ESC_HIDDEN_BEFORE" \
    --argjson esc_hidden_after "$ESC_HIDDEN_AFTER" \
    --argjson esc_cand_after "$ESC_CANDIDATE_VISIBLE_AFTER" \
    --argjson esc_pass "$ESC_PASS" \
    --argjson kp_enter_pass "$KP_ENTER_PASS" \
    --argjson limitations "$limitations_json" \
    '{
      fcitx: {
        running: $running,
        state_before: ($state_before | tonumber? // 0),
        group_before: $group_before,
        im_before: $im_before,
        used_im: $used_im,
        state_after: ($state_after | tonumber? // 0),
        group_after: $group_after,
        im_after: $im_after,
        restored_exact: $restored_exact,
        pinyin_switch_attempted: $pinyin_attempted,
        pinyin_switch_effective: $pinyin_effective,
        config_hashes_before: {
          profile: $hash_profile_before,
          "pinyin.conf": $hash_pinyin_before,
          "rime.conf": $hash_rime_before
        },
        config_hashes_after: {
          profile: $hash_profile_after,
          "pinyin.conf": $hash_pinyin_after,
          "rime.conf": $hash_rime_after
        }
      },
      candidate: $candidate[0],
      enter_composing: {
        requests: $ec_requests,
        requests_before: $ec_requests_before,
        value: $ec_value,
        sends: $ec_sends,
        send_requested: $ec_send_requested,
        composition_ended: ($ec_composition_ended == 1),
        chinese_commit: ($ec_chinese == 1),
        chinese_commit_value: $chinese_value,
        pass: ($ec_pass == 1)
      },
      enter_committed: {
        requests: $ecm_requests,
        value: $ecm_value,
        sends: $ecm_sends,
        send_requested: $ecm_send_requested,
        commit_key: "space",
        pass: ($ecm_pass == 1)
      },
      esc_composing: {
        window_visible: ($esc_visible == 1),
        map_state: $esc_map_state,
        composition_canceled: ($esc_canceled == 1),
        value: $esc_value,
        window_hidden_before: $esc_hidden_before,
        window_hidden_after: $esc_hidden_after,
        candidate_visible_after: ($esc_cand_after == 1),
        pass: ($esc_pass == 1)
      },
      kp_enter: {
        pass: ($kp_enter_pass == 1),
        source: "real xdotool key KP_Enter during composition"
      },
      shortcuts: $shortcuts[0],
      limitations: $limitations,
      evidence: [
        "task-5-fcitx5-diagnose.txt",
        "task-5-fcitx-state-before.txt",
        "task-5-fcitx-state-after.txt",
        "task-5-config-hashes-before.txt",
        "task-5-config-hashes-after.txt",
        "task-5-session-state.txt",
        "task-5-app.log",
        "task-5-server.log",
        "task-5-ime-state.json",
        "task-5-events.jsonl",
        "task-5-candidate.png",
        "task-5-candidate-crop.png",
        "task-5-candidate-windows.txt",
        "task-5-candidate.json",
        "task-5-kp-enter.json",
        "task-5-requests-before.txt",
        "task-5-requests-after-composing-enter.txt",
        "task-5-requests-after.txt",
        "task-5-state-after-composing-enter.json",
        "task-5-state-after-candidate-commit.json",
        "task-5-esc.png",
        "task-5-esc-state.json",
        "task-5-candidate-after-esc.json",
        "task-5-candidate-after-esc.txt",
        "task-5-composition-shortcuts.json",
        "task-5-shortcuts.jsonl",
        "task-5-events-excerpt.json",
        "task-5-cleanup.txt"
      ]
    }' > "$FACTS"

  node "$ANALYZE" --events "$EVENTS" --facts "$FACTS" \
    --out-events "$EVENTS_EXCERPT" --out-summary "$SUMMARY" >> "$RUN_LOG" 2>&1
  local rc=$?
  FINAL_EXIT=$rc
  log "summary written: $SUMMARY (analyzer exit $rc)"
}

finalize() {
  [ "$FINALIZED" = 1 ] && return 0
  FINALIZED=1
  log "== finalize: kill app/server by PID and restore fcitx"
  stop_processes
  restore_fcitx
  sleep 0.3
  write_after_state
  # Record any remaining electron test processes (do not kill unrelated apps).
  pgrep -x electron > "$OUT/task-5-leftover-electron.txt" 2>/dev/null || true
  {
    echo "generated_at=$(date -Is)"
    echo "electron_pids=$({ pgrep -x electron || true; } | tr '\n' ' ' | sed 's/ *$//')"
    echo "mock_pids=$({ pgrep -f '[m]ock-sse-server' || true; } | tr '\n' ' ' | sed 's/ *$//')"
    echo "fcitx_state=$(fcitx5-remote 2>/dev/null | tr -d '[:space:]')"
    echo "fcitx_group=$(fcitx5-remote -q 2>/dev/null)"
    echo "fcitx_im=$(fcitx5-remote -n 2>/dev/null)"
    echo "app_window_map_state=$(window_map_state 2>/dev/null || true)"
    if [ -s "$CANDIDATE_JSON" ]; then
      CAND_WID="$(jq -r '.selected.wid // empty' "$CANDIDATE_JSON" 2>/dev/null)"
      if [ -n "$CAND_WID" ]; then
        echo "candidate_wid=$CAND_WID"
        echo "candidate_map_state=$(xwininfo -id "$CAND_WID" 2>/dev/null | awk '/Map State:/{print $3; exit}')"
      fi
    fi
  } > "$CLEANUP_FILE"
  if [ "$ABORTED_LOCKED" = 1 ]; then
    log "session locked mid-run; leaving task-5-aborted-locked.txt and suppressing summary"
    rm -f "$SUMMARY" "$FACTS"
  else
    build_summary
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  finalize
  exit "$status"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------- helpers
state_get() {
  jq -r "$1" "$STATE" 2>/dev/null
}
wait_state() {
  local i
  for i in $(seq 1 100); do
    [ -s "$STATE" ] && return 0
    sleep 0.1
  done
  return 1
}
request_count() {
  local n
  n="$(grep -c 'POST /v1/chat/completions' "$SERVER_LOG" 2>/dev/null || true)"
  echo "${n:-0}"
}
send_requested_count() {
  local n
  n="$(grep -c 'SEND_REQUESTED' "$APP_LOG" 2>/dev/null || true)"
  echo "${n:-0}"
}
hidden_count() {
  local n
  n="$(grep -c 'WINDOW_HIDDEN' "$APP_LOG" 2>/dev/null || true)"
  echo "${n:-0}"
}
window_map_state() {
  xwininfo -id "$WID_HEX" 2>/dev/null | awk '/Map State:/{print $3; exit}'
}
focus_app() {
  [ -n "$WID_DEC" ] || return 1
  local map i
  for i in $(seq 1 30); do
    map="$(window_map_state)"
    [ "$map" = "IsViewable" ] && break
    sleep 0.1
  done
  [ "$map" = "IsViewable" ] || return 1
  local rect ix iy iw ih tries focus
  rect="$(state_get '[.input_rect_screen.x,.input_rect_screen.y,.input_rect_screen.width,.input_rect_screen.height] | @tsv' 2>/dev/null || true)"
  tries=0
  while [ "$tries" -lt 3 ]; do
    xdotool windowraise "$WID_DEC" >/dev/null 2>&1 || true
    xdotool windowactivate --sync "$WID_DEC" >/dev/null 2>&1 || true
    xdotool windowfocus --sync "$WID_DEC" >/dev/null 2>&1 || true
    if [ -x "$HELPER" ]; then
      "$HELPER" activate "$WID_HEX" >/dev/null 2>&1 || true
    fi
    sleep 0.15
    focus="$(xdotool getwindowfocus 2>/dev/null | tr -d '[:space:]')"
    if [ "$focus" = "$WID_DEC" ]; then
      if [ -n "$rect" ] && [ "$(state_get .input_focused)" != "true" ]; then
        set -- $rect
        ix="$1"; iy="$2"; iw="$3"; ih="$4"
        xdotool mousemove "$((ix + iw / 2))" "$((iy + ih / 2))" click 1 >/dev/null 2>&1 || true
        sleep 0.2
      fi
      return 0
    fi
    if [ -n "$rect" ]; then
      # shellcheck disable=SC2086
      set -- $rect
      ix="$1"; iy="$2"; iw="$3"; ih="$4"
      xdotool mousemove "$((ix + iw / 2))" "$((iy + ih / 2))" click 1 >/dev/null 2>&1 || true
      sleep 0.2
    fi
    tries=$((tries + 1))
  done
  focus="$(xdotool getwindowfocus 2>/dev/null | tr -d '[:space:]')"
  [ "$focus" = "$WID_DEC" ]
}
press_key() {
  if ! focus_app; then
    log "FOCUS_FAIL before key '$1' (focus=$(xdotool getwindowfocus 2>/dev/null))"
    return 1
  fi
  xdotool key "$1"
}
type_text() {
  if ! focus_app; then
    log "FOCUS_FAIL before typing '$1' (focus=$(xdotool getwindowfocus 2>/dev/null))"
    return 1
  fi
  xdotool type --delay 80 "$1"
}
clear_input() {
  focus_app || return 1
  xdotool key ctrl+a BackSpace
  sleep 0.25
}
cancel_composition() {
  if [ "$(state_get .composing)" = "true" ]; then
    press_key Escape || true
    sleep 0.45
  fi
}
ensure_ime() {
  fcitx5-remote -o >/dev/null 2>&1 || true
  if [ -n "$USED_IM" ]; then
    fcitx5-remote -s "$USED_IM" >/dev/null 2>&1 || true
  fi
  sleep 0.15
}
start_composition() {
  local text="$1" attempt
  for attempt in 1 2 3; do
    cancel_composition
    clear_input || return 1
    ensure_ime
    if ! type_text "$text"; then
      return 1
    fi
    sleep 0.85
    if [ "$(state_get .composing)" = "true" ]; then
      return 0
    fi
    log "composition did not start (attempt $attempt), im=$(fcitx5-remote -n 2>/dev/null)"
  done
  return 1
}
capture_screenshot() {
  local file="$1"
  assert_unlocked || exit 3
  spectacle -b -n -f -o "$file" > "$OUT/task-5-spectacle.log" 2>&1 || true
  [ -s "$file" ]
}
count_text_to_file() {
  local file="$1" label="$2" command="$3" output="$4"
  {
    echo "# G6 $label"
    echo "# command: $command"
    echo "$output"
  } > "$file"
}

# ---------------------------------------------------------------- start infra
log "== starting mock SSE server"
: > "$SERVER_LOG"
: > "$SERVER_OUT"
setsid node "$MOCK" --port "$PORT" --chunks 3 --delay 100 --log "$SERVER_LOG" \
  > "$SERVER_OUT" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 80); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if ! curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  log "ABORT: mock server did not become healthy on port $PORT"
  ABORT_REASON="mock server not healthy"
  exit 4
fi
log "mock server pid=$SERVER_PID"

log "== starting Electron spike"
: > "$APP_LOG"
QUICKASK_TEST_BASE_URL="http://127.0.0.1:$PORT/v1" \
  setsid "$ELECTRON" "$APP" --evidence-dir "$OUT" --idle-timeout-ms 600000 \
  > "$APP_LOG" 2>&1 &
APP_PID=$!
READY=0
for i in $(seq 1 300); do
  if grep -q '^APP_READY$' "$APP_LOG" 2>/dev/null; then
    READY=1
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if [ "$READY" != 1 ]; then
  log "ABORT: spike did not print APP_READY"
  ABORT_REASON="app not ready"
  exit 4
fi
WID_HEX="$(grep -m1 '^WID=0x' "$APP_LOG" | cut -d= -f2 | tr -d '[:space:]')"
WID_DEC="$(printf '%d' "$WID_HEX")"
{
  echo "app_pid=$APP_PID"
  echo "wid=$WID_HEX"
  echo "wid_dec=$WID_DEC"
  echo "app_ready=$(grep -m1 '^APP_READY$' "$APP_LOG")"
  echo "input_rect_screen=$(grep -m1 '^INPUT_RECT_SCREEN=' "$APP_LOG" | cut -d= -f2-)"
  echo "base_url=http://127.0.0.1:$PORT/v1"
  echo "used_im_initial=$(fcitx5-remote -n 2>/dev/null)"
} > "$OUT/task-5-app-ready.txt"
wait_state || log "WARN: state file not written yet"
log "app ready wid=$WID_HEX ($WID_DEC) pid=$APP_PID"

# Activate fcitx, but keep the user's current IM first (rime in this setup).
fcitx5-remote -o >/dev/null 2>&1 || true
sleep 0.3
USED_IM="$(fcitx5-remote -n 2>/dev/null)"
if [ -z "$USED_IM" ] || [ "$USED_IM" = "keyboard-us" ]; then
  fcitx5-remote -s rime >/dev/null 2>&1 || true
  sleep 0.2
  USED_IM="$(fcitx5-remote -n 2>/dev/null)"
fi
log "fcitx activated state=$(fcitx5-remote 2>/dev/null) group=$(fcitx5-remote -q 2>/dev/null) im=$USED_IM"

if ! focus_app; then
  log "ABORT: cannot focus app window $WID_HEX"
  ABORT_REASON="cannot focus app window"
  exit 5
fi

# ---------------------------------------------------------------- preflight composition
log "== preflight composition (rime first)"
if ! start_composition nihao; then
  log "rime did not produce a composition; attempting pinyin fallback"
  PINYIN_SWITCH_ATTEMPTED=1
  OLD_IM="$(fcitx5-remote -n 2>/dev/null)"
  fcitx5-remote -s pinyin >/dev/null 2>&1 || true
  sleep 0.3
  NEW_IM="$(fcitx5-remote -n 2>/dev/null)"
  {
    echo "old_im=$OLD_IM"
    echo "new_im=$NEW_IM"
    echo "pinyin_attempted=true"
    echo "pinyin_effective=$([ "$NEW_IM" = "pinyin" ] && echo true || echo false)"
    echo "note=fcitx5-remote -s pinyin only switches IMs that are in the active group; the current group contains keyboard-us + rime."
  } > "$OUT/task-5-pinyin-fallback.txt"
  if [ "$NEW_IM" = "pinyin" ]; then
    PINYIN_SWITCH_EFFECTIVE=1
    USED_IM="pinyin"
    if start_composition nihao; then
      log "pinyin composition started"
    else
      log "ABORT: neither rime nor pinyin produced a composition"
      ABORT_REASON="no IME composition"
      exit 5
    fi
  else
    log "ABORT: rime did not compose and pinyin is not in the active group"
    ABORT_REASON="no IME composition"
    exit 5
  fi
fi
cancel_composition
clear_input || true
log "preflight composition ok (im=$USED_IM)"

# ---------------------------------------------------------------- 1. candidate
log "== scenario 1: candidate window while composing 'nihao'"
if ! start_composition nihao; then
  log "ABORT: could not start composition for candidate scenario"
  ABORT_REASON="candidate scenario: no composition"
  exit 5
fi
if ! capture_screenshot "$CANDIDATE_PNG"; then
  log "WARN: candidate screenshot failed or session locked"
fi
node "$PROBE" --state "$STATE" --app-wid "$WID_HEX" \
  --out "$CANDIDATE_JSON" --text "$CANDIDATE_TXT" >> "$RUN_LOG" 2>&1 || true
CAND_FOUND="$(jq -r '.found == true | if . then 1 else 0 end' "$CANDIDATE_JSON" 2>/dev/null || echo 0)"
CAND_PASS="$(jq -r '.pass == true | if . then 1 else 0 end' "$CANDIDATE_JSON" 2>/dev/null || echo 0)"
log "candidate found=$CAND_FOUND pass=$CAND_PASS geometry=$(jq -c '.geometry' "$CANDIDATE_JSON" 2>/dev/null) distance=$(jq -r '.distance_px' "$CANDIDATE_JSON" 2>/dev/null)"

# Crop the screenshot around the app + candidate for review.
PY="${PYTHON:-python3}"
if [ -x "$PY" ] && [ -s "$CANDIDATE_PNG" ] && [ -s "$CANDIDATE_JSON" ]; then
  "$PY" - "$CANDIDATE_PNG" "$CANDIDATE_CROP" "$CANDIDATE_JSON" <<'PY' >> "$RUN_LOG" 2>&1 || true
import json, sys
from PIL import Image
src, dst, meta = sys.argv[1], sys.argv[2], sys.argv[3]
im = Image.open(src)
m = json.load(open(meta))
wb = m.get('window_bounds') or {'x': 0, 'y': 0, 'width': 1920, 'height': 1080}
g = m.get('geometry') or wb
x0 = max(0, min(wb['x'], g['x']) - 40)
y0 = max(0, min(wb['y'], g['y']) - 40)
x1 = min(im.width, max(wb['x'] + wb['width'], g['x'] + g['width']) + 40)
y1 = min(im.height, max(wb['y'] + wb['height'], g['y'] + g['height']) + 40)
im.crop((x0, y0, x1, y1)).save(dst)
print(f"crop={x0},{y0},{x1},{y1} -> {dst}")
PY
fi

# KP_Enter diagnostic: unlike Return (consumed by fcitx), KP_Enter reaches
# the DOM as keydown Enter(isComposing=true) and must not send.
SENDS_BEFORE_KP="$(state_get .sends)"
HIDDEN_BEFORE_KP="$(hidden_count)"
REQUESTS_BEFORE_KP="$(request_count)"
if press_key KP_Enter; then
  sleep 0.45
else
  log "WARN: KP_Enter diagnostic focus failed"
fi
SENDS_AFTER_KP="$(state_get .sends)"
HIDDEN_AFTER_KP="$(hidden_count)"
REQUESTS_AFTER_KP="$(request_count)"
COMPOSING_AFTER_KP="$(state_get .composing)"
{
  echo "sends_before=$SENDS_BEFORE_KP"
  echo "sends_after=$SENDS_AFTER_KP"
  echo "requests_before=$REQUESTS_BEFORE_KP"
  echo "requests_after=$REQUESTS_AFTER_KP"
  echo "hidden_before=$HIDDEN_BEFORE_KP"
  echo "hidden_after=$HIDDEN_AFTER_KP"
  echo "composing_after=$COMPOSING_AFTER_KP"
  echo "keydown_enter_isComposing=$(grep -c '\"key\":\"Enter\".*\"isComposing\":true' "$EVENTS" 2>/dev/null || true)"
} > "$OUT/task-5-kp-enter.json"
KP_ENTER_KEYDOWN_COUNT="$(grep -c '"key":"Enter".*"isComposing":true' "$EVENTS" 2>/dev/null || true)"
KP_ENTER_KEYDOWN_COUNT="${KP_ENTER_KEYDOWN_COUNT:-0}"
if [ "$SENDS_AFTER_KP" = "$SENDS_BEFORE_KP" ] && [ "$REQUESTS_AFTER_KP" = "$REQUESTS_BEFORE_KP" ] && [ "$HIDDEN_AFTER_KP" = "$HIDDEN_BEFORE_KP" ] && [ "$KP_ENTER_KEYDOWN_COUNT" -gt 0 ]; then
  KP_ENTER_PASS=1
fi
cancel_composition
clear_input || true

# ---------------------------------------------------------------- 2. composing Enter
log "== scenario 2: Return during composition (must not send)"
if ! start_composition nihao; then
  log "ABORT: could not start composition for composing-Enter scenario"
  ABORT_REASON="composing Enter scenario: no composition"
  exit 5
fi
ENTER_COMPOSING_REQUESTS_BEFORE="$(request_count)"
SENDS_BEFORE_ENTER="$(state_get .sends)"
SEND_REQ_BEFORE_ENTER="$(send_requested_count)"
count_text_to_file "$REQ_BEFORE" "requests before composing Enter" \
  "grep -c 'POST /v1/chat/completions' $SERVER_LOG" "$ENTER_COMPOSING_REQUESTS_BEFORE"
if ! press_key Return; then
  log "WARN: Return focus failed"
fi
sleep 0.8
ENTER_COMPOSING_REQUESTS_AFTER="$(request_count)"
ENTER_COMPOSING_REQUESTS=$((ENTER_COMPOSING_REQUESTS_AFTER - ENTER_COMPOSING_REQUESTS_BEFORE))
ENTER_COMPOSING_VALUE="$(state_get .value)"
ENTER_COMPOSING_SENDS="$(state_get .sends)"
ENTER_COMPOSING_SEND_REQUESTED="$(send_requested_count)"
COMPOSING_AFTER_ENTER="$(state_get .composing)"
[ "$COMPOSING_AFTER_ENTER" = "false" ] && ENTER_COMPOSING_COMPOSITION_ENDED=1
[ -n "$ENTER_COMPOSING_VALUE" ] && has_cjk "$ENTER_COMPOSING_VALUE" && ENTER_COMPOSING_CHINESE=1
cp "$STATE" "$OUT/task-5-state-after-composing-enter.json" 2>/dev/null || true
count_text_to_file "$REQ_AFTER_COMPOSING" "requests after composing Enter" \
  "grep -c 'POST /v1/chat/completions' $SERVER_LOG" "$ENTER_COMPOSING_REQUESTS_AFTER"
if [ "$ENTER_COMPOSING_REQUESTS" -eq 0 ] && \
   [ "$ENTER_COMPOSING_SENDS" = "$SENDS_BEFORE_ENTER" ] && \
   [ "$ENTER_COMPOSING_SEND_REQUESTED" = "$SEND_REQ_BEFORE_ENTER" ] && \
   [ "$ENTER_COMPOSING_COMPOSITION_ENDED" = 1 ] && \
   [ -n "$ENTER_COMPOSING_VALUE" ]; then
  ENTER_COMPOSING_PASS=1
fi
log "composing Enter: requests_delta=$ENTER_COMPOSING_REQUESTS value=$(printf '%q' "$ENTER_COMPOSING_VALUE") sends=$ENTER_COMPOSING_SENDS pass=$ENTER_COMPOSING_PASS"
clear_input || true

# ---------------------------------------------------------------- 3. Chinese commit + committed Enter
log "== scenario 3: Chinese candidate commit (Space) then committed Enter (must send exactly once)"
if ! start_composition nihao; then
  log "ABORT: could not start composition for Chinese commit scenario"
  ABORT_REASON="Chinese commit scenario: no composition"
  exit 5
fi
REQ_BEFORE_CHINESE="$(request_count)"
if ! press_key space; then
  log "WARN: Space focus failed"
fi
sleep 0.6
CHINESE_COMMIT_VALUE="$(state_get .value)"
REQ_AFTER_CHINESE="$(request_count)"
COMPOSING_AFTER_SPACE="$(state_get .composing)"
cp "$STATE" "$OUT/task-5-state-after-candidate-commit.json" 2>/dev/null || true
if has_cjk "$CHINESE_COMMIT_VALUE" && \
   [ "$REQ_AFTER_CHINESE" = "$REQ_BEFORE_CHINESE" ] && [ "$COMPOSING_AFTER_SPACE" = "false" ]; then
  CHINESE_COMMIT_PASS=1
fi
log "Chinese commit via Space: value=$(printf '%q' "$CHINESE_COMMIT_VALUE") requests_delta=$((REQ_AFTER_CHINESE - REQ_BEFORE_CHINESE)) pass=$CHINESE_COMMIT_PASS"

ENTER_COMMITTED_REQUESTS_BEFORE="$(request_count)"
ENTER_COMMITTED_SEND_REQ_BEFORE="$(send_requested_count)"
SENDS_BEFORE_COMMITTED="$(state_get .sends)"
if ! press_key Return; then
  log "WARN: committed Return focus failed"
fi
sleep 1.6
ENTER_COMMITTED_REQUESTS_AFTER="$(request_count)"
ENTER_COMMITTED_REQUESTS=$((ENTER_COMMITTED_REQUESTS_AFTER - ENTER_COMMITTED_REQUESTS_BEFORE))
ENTER_COMMITTED_VALUE="$(state_get .value)"
ENTER_COMMITTED_SENDS="$(state_get .sends)"
ENTER_COMMITTED_SEND_REQUESTED="$(send_requested_count)"
count_text_to_file "$REQ_AFTER" "requests after committed Enter" \
  "grep -c 'POST /v1/chat/completions' $SERVER_LOG" "$ENTER_COMMITTED_REQUESTS_AFTER"
if [ "$ENTER_COMMITTED_REQUESTS" -eq 1 ] && \
   [ "$ENTER_COMMITTED_SEND_REQUESTED" -eq $((ENTER_COMMITTED_SEND_REQ_BEFORE + 1)) ] && \
   [ "$ENTER_COMMITTED_SENDS" = "$((SENDS_BEFORE_COMMITTED + 1))" ] && \
   has_cjk "$ENTER_COMMITTED_VALUE"; then
  ENTER_COMMITTED_PASS=1
fi
log "committed Enter: requests_delta=$ENTER_COMMITTED_REQUESTS send_requested=$ENTER_COMMITTED_SEND_REQUESTED value=$(printf '%q' "$ENTER_COMMITTED_VALUE") pass=$ENTER_COMMITTED_PASS"
clear_input || true

# ---------------------------------------------------------------- 4. composing Escape
log "== scenario 4: Escape during composition (cancel, no hide)"
if ! start_composition shijie; then
  log "ABORT: could not start composition for Escape scenario"
  ABORT_REASON="Escape scenario: no composition"
  exit 5
fi
ESC_HIDDEN_BEFORE="$(hidden_count)"
ESC_REQUESTS_BEFORE="$(request_count)"
ESC_SENDS_BEFORE="$(state_get .sends)"
if ! press_key Escape; then
  log "WARN: Escape focus failed"
fi
sleep 0.85
ESC_HIDDEN_AFTER="$(hidden_count)"
ESC_REQUESTS_AFTER="$(request_count)"
ESC_MAP_STATE="$(window_map_state)"
ESC_VALUE="$(state_get .value)"
COMPOSING_AFTER_ESC="$(state_get .composing)"
[ "$ESC_MAP_STATE" = "IsViewable" ] && ESC_WINDOW_VISIBLE=1
[ "$COMPOSING_AFTER_ESC" = "false" ] && ESC_COMPOSITION_CANCELED=1
cp "$STATE" "$OUT/task-5-esc-state.json" 2>/dev/null || true
# Candidate must be gone / not viewable after Escape.
node "$PROBE" --state "$STATE" --app-wid "$WID_HEX" \
  --out "$OUT/task-5-candidate-after-esc.json" --text "$OUT/task-5-candidate-after-esc.txt" >> "$RUN_LOG" 2>&1 || true
ESC_CANDIDATE_VISIBLE_AFTER="$(jq -r '.found == true | if . then 1 else 0 end' "$OUT/task-5-candidate-after-esc.json" 2>/dev/null || echo 0)"
capture_screenshot "$ESC_PNG" || log "WARN: esc screenshot failed"
if [ "$ESC_WINDOW_VISIBLE" = 1 ] && \
   [ "$ESC_HIDDEN_AFTER" = "$ESC_HIDDEN_BEFORE" ] && \
   [ "$ESC_COMPOSITION_CANCELED" = 1 ] && \
   [ "$ESC_REQUESTS_AFTER" = "$ESC_REQUESTS_BEFORE" ] && \
   [ "$(state_get .sends)" = "$ESC_SENDS_BEFORE" ] && \
   [ -z "$ESC_VALUE" ] && \
   [ "$ESC_CANDIDATE_VISIBLE_AFTER" = 0 ]; then
  ESC_PASS=1
fi
log "esc composing: map=$ESC_MAP_STATE hidden=$ESC_HIDDEN_BEFORE->$ESC_HIDDEN_AFTER comp_canceled=$ESC_COMPOSITION_CANCELED value=$(printf '%q' "$ESC_VALUE") candidate_after=$ESC_CANDIDATE_VISIBLE_AFTER pass=$ESC_PASS"

# ---------------------------------------------------------------- 5. shortcut guard
log "== scenario 5: shortcuts during composition (must not trigger app shortcuts)"
: > "$SHORTCUTS_RAW"
if ! start_composition nihao; then
  log "ABORT: could not start composition for shortcut scenario"
  ABORT_REASON="shortcut scenario: no composition"
  exit 5
fi
SHORTCUT_KEYS=(Tab ctrl+n ctrl+h ctrl+comma ctrl+shift+v)
SHORTCUT_NAMES=(Tab Ctrl+N Ctrl+H "Ctrl+," "Ctrl+Shift+V")
SHORTCUT_SENDS_BEFORE_ALL="$(state_get .sends)"
SHORTCUT_SENDS_BEFORE_ALL="${SHORTCUT_SENDS_BEFORE_ALL:-0}"
SHORTCUT_REQUESTS_BEFORE_ALL="$(request_count)"
SHORTCUT_TRIGGERED_BEFORE_ALL="$(grep -c 'SHORTCUT_TRIGGERED' "$APP_LOG" 2>/dev/null || true)"
SHORTCUT_TRIGGERED_BEFORE_ALL="${SHORTCUT_TRIGGERED_BEFORE_ALL:-0}"
for idx in "${!SHORTCUT_KEYS[@]}"; do
  key="${SHORTCUT_KEYS[$idx]}"
  name="${SHORTCUT_NAMES[$idx]}"
  if [ "$(state_get .composing)" != "true" ]; then
    log "composition ended before shortcut $name; restarting"
    start_composition nihao || true
  fi
  COMPOSING_BEFORE="$(state_get .composing)"
  VALUE_BEFORE="$(state_get .value)"
  SENDS_BEFORE="$(state_get .sends)"
  REQUESTS_BEFORE="$(request_count)"
  SC_BEFORE="$([ -f "$SHORTCUTS" ] && wc -l < "$SHORTCUTS" | tr -d ' ' || echo 0)"
  SC_BEFORE="${SC_BEFORE:-0}"
  TRIG_BEFORE="$(grep -c 'SHORTCUT_TRIGGERED' "$APP_LOG" 2>/dev/null || true)"
  TRIG_BEFORE="${TRIG_BEFORE:-0}"
  if ! press_key "$key"; then
    log "WARN: shortcut key $key focus failed"
  fi
  sleep 0.28
  COMPOSING_AFTER="$(state_get .composing)"
  VALUE_AFTER="$(state_get .value)"
  SENDS_AFTER="$(state_get .sends)"
  REQUESTS_AFTER="$(request_count)"
  SC_AFTER="$([ -f "$SHORTCUTS" ] && wc -l < "$SHORTCUTS" | tr -d ' ' || echo 0)"
  SC_AFTER="${SC_AFTER:-0}"
  TRIG_AFTER="$(grep -c 'SHORTCUT_TRIGGERED' "$APP_LOG" 2>/dev/null || true)"
  TRIG_AFTER="${TRIG_AFTER:-0}"
  NEW_EVENTS=""
  if [ "$SC_AFTER" -gt "$SC_BEFORE" ]; then
    NEW_EVENTS="$(tail -n $((SC_AFTER - SC_BEFORE)) "$SHORTCUTS" | jq -s -c '.')"
  fi
  jq -n \
    --arg key "$key" \
    --arg name "$name" \
    --arg composing_before "$COMPOSING_BEFORE" \
    --arg composing_after "$COMPOSING_AFTER" \
    --arg value_before "$VALUE_BEFORE" \
    --arg value_after "$VALUE_AFTER" \
    --argjson sends_before "$SENDS_BEFORE" \
    --argjson sends_after "$SENDS_AFTER" \
    --argjson requests_before "$REQUESTS_BEFORE" \
    --argjson requests_after "$REQUESTS_AFTER" \
    --argjson triggered_delta "$((TRIG_AFTER - TRIG_BEFORE))" \
    --argjson delivered_via_shortcut_ipc "$([ "$SC_AFTER" -gt "$SC_BEFORE" ] && echo true || echo false)" \
    --argjson new_events "${NEW_EVENTS:-[]}" \
    '{key:$key,name:$name,composing_before:($composing_before=="true"),composing_after:($composing_after=="true"),value_before:$value_before,value_after:$value_after,sends_before:$sends_before,sends_after:$sends_after,requests_before:$requests_before,requests_after:$requests_after,triggered_delta:$triggered_delta,delivered_via_shortcut_ipc:$delivered_via_shortcut_ipc,new_events:$new_events}' \
    >> "$SHORTCUTS_RAW"
  log "shortcut $name: composing=$COMPOSING_BEFORE->$COMPOSING_AFTER triggered+=$((TRIG_AFTER - TRIG_BEFORE)) sends=$SENDS_BEFORE->$SENDS_AFTER"
done
SHORTCUT_TRIGGERED_AFTER_ALL="$(grep -c 'SHORTCUT_TRIGGERED' "$APP_LOG" 2>/dev/null || true)"
SHORTCUT_TRIGGERED_AFTER_ALL="${SHORTCUT_TRIGGERED_AFTER_ALL:-0}"
SHORTCUT_TRIGGERED_COUNT=$((SHORTCUT_TRIGGERED_AFTER_ALL - SHORTCUT_TRIGGERED_BEFORE_ALL))
SHORTCUT_SENDS_AFTER_ALL="$(state_get .sends)"
SHORTCUT_SENDS_AFTER_ALL="${SHORTCUT_SENDS_AFTER_ALL:-0}"
SHORTCUT_SENDS_DELTA=$((SHORTCUT_SENDS_AFTER_ALL - SHORTCUT_SENDS_BEFORE_ALL))
SHORTCUT_REQUESTS_AFTER_ALL="$(request_count)"
cancel_composition
clear_input || true
SHORTCUT_MAP_AFTER="$(window_map_state)"
if [ "$SHORTCUT_TRIGGERED_COUNT" -eq 0 ] && \
   [ "$SHORTCUT_SENDS_DELTA" -eq 0 ] && \
   [ "$SHORTCUT_REQUESTS_AFTER_ALL" = "$SHORTCUT_REQUESTS_BEFORE_ALL" ] && \
   [ "$SHORTCUT_MAP_AFTER" = "IsViewable" ]; then
  SHORTCUT_PASS=1
fi
jq -s \
  --argjson pass "$([ "$SHORTCUT_PASS" = 1 ] && echo true || echo false)" \
  --argjson triggered "$SHORTCUT_TRIGGERED_COUNT" \
  --argjson sends_delta "$SHORTCUT_SENDS_DELTA" \
  --arg note "Tab is consumed by Rime (Shift+Right cursor move) and produces no DOM shortcut IPC; the other Ctrl shortcuts reach the renderer and log SHORTCUT_IGNORED_COMPOSING. Ctrl+Shift+V is preventDefaulted so it cannot paste into the composition." \
  '{pass:$pass, events:., triggered_count:$triggered, sends_delta:$sends_delta, note:$note}' \
  "$SHORTCUTS_RAW" > "$SHORTCUTS_JSON" 2>/dev/null || true
log "shortcuts: triggered=$SHORTCUT_TRIGGERED_COUNT sends_delta=$SHORTCUT_SENDS_DELTA pass=$SHORTCUT_PASS"

# ---------------------------------------------------------------- finalize
log "== all scenarios complete; restoring fcitx and writing summary"
FINAL_EXIT=0
finalize
exit "$FINAL_EXIT"
