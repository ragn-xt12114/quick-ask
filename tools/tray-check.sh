#!/usr/bin/env bash
# Task 6 / G7 — Plasma 6 StatusNotifierItem + Electron Tray behaviour spike.
#
# What this does:
#   1. starts spike/tray.cjs (Electron, 32x32 locally generated PNG)
#   2. waits for TRAY_READY and records the new SNI item via qdbus6
#   3. reveals the existing Plasma panel (keyboard shortcut, no config edits),
#      captures it with spectacle and locates the magenta icon with PIL
#   4. performs real xdotool left / right / double clicks and saves screenshots,
#      Electron events and popup-window evidence for each
#   5. supplements with deterministic org.kde.StatusNotifierItem DBus calls
#      (Activate / SecondaryActivate / ContextMenu)
#   6. cleans up by PID and restores the previous focus / pointer / panel state
#
# Rules: no pkill -f / killall; no panel configuration changes; no sudo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source scripts/env.sh
export DISPLAY="${DISPLAY:-:0}"

EVID="$ROOT/.omo/evidence"
PY="${PYTHON:-python3}"
PROBE="$ROOT/tools/tray-probe.py"
ELECTRON="$ROOT/node_modules/.bin/electron"
APP_ENTRY="$ROOT/spike/tray.cjs"
EVENTS="$EVID/task-6-tray-events.json"
APP_LOG="$EVID/task-6-tray-app.log"
DRIVER_LOG="$EVID/task-6-tray-driver.log"
DBUS_TXT="$EVID/task-6-tray-dbus.txt"
BEFORE_LIST="$EVID/task-6-tray-sni-before.txt"
AFTER_LIST="$EVID/task-6-tray-sni-after.txt"
RUN_META="$EVID/task-6-tray-run-meta.json"
PLASMA_JSON="$EVID/task-6-tray-plasma.json"

mkdir -p "$EVID"

APP_LAUNCH_PID=""
APP_MAIN_PID=""
TOP_PANEL=""
ORIG_ACTIVE=""
ORIG_MOUSE_X=""
ORIG_MOUSE_Y=""
ORIG_PANEL_STATE=""
ICON_LOCATION="panel"
CLICK_X=""
CLICK_Y=""
TRAY_X=""
TRAY_Y=""
TRAY_W=""
TRAY_H=""

log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$DRIVER_LOG" >&2; }
die() { log "FAIL: $*"; exit 1; }

map_state() {
  xwininfo -id "$1" 2>/dev/null | awk -F': *' '/Map State/{print $2; exit}'
}

win_geometry() {
  # prints x y w h for an X window id
  local id="$1" info x y w h
  info="$(xwininfo -id "$id" 2>/dev/null)" || return 1
  x="$(printf '%s\n' "$info" | awk -F': *' '/Absolute upper-left X/{print $2; exit}')"
  y="$(printf '%s\n' "$info" | awk -F': *' '/Absolute upper-left Y/{print $2; exit}')"
  w="$(printf '%s\n' "$info" | awk -F': *' '/Width:/{print $2; exit}')"
  h="$(printf '%s\n' "$info" | awk -F': *' '/Height:/{print $2; exit}')"
  [[ -n "$x" && -n "$y" && -n "$w" && -n "$h" ]] || return 1
  printf '%s %s %s %s\n' "$x" "$y" "$w" "$h"
}

find_top_panel() {
  local id x y w h
  for id in $(xdotool search --class plasmashell 2>/dev/null); do
    read -r x y w h < <(win_geometry "$id") || continue
    if [[ "$x" == "0" && "$y" == "0" && "$w" -ge 1000 && "$h" -ge 30 && "$h" -le 80 ]]; then
      printf '%s\n' "$id"
      return 0
    fi
  done
  return 1
}

plasma_script() {
  qdbus6 org.kde.plasmashell /PlasmaShell org.kde.PlasmaShell.evaluateScript "$1" 2>/dev/null
}

ensure_top_panel_visible() {
  local attempt state t0 t1
  t0="$(date +%s%3N)"
  TOP_PANEL="$(find_top_panel)" || die "could not find top Plasma panel window"
  state="$(map_state "$TOP_PANEL")"
  attempt=0
  while [[ "$state" != "IsViewable" && "$attempt" -lt 5 ]]; do
    # cycle-panels is a user-facing Plasma shortcut.  Using it only gives the
    # panel keyboard focus / reveals it; no panel configuration is written.
    qdbus6 org.kde.kglobalaccel /component/plasmashell \
      org.kde.kglobalaccel.Component.invokeShortcut cycle-panels >/dev/null 2>&1 || true
    sleep 0.8
    state="$(map_state "$TOP_PANEL")"
    attempt=$((attempt + 1))
  done
  [[ "$state" == "IsViewable" ]] || die "could not reveal top Plasma panel (state=$state)"
  # Keep the pointer over the panel so the panel does not immediately autohide.
  xdotool mousemove 1000 20 >/dev/null 2>&1 || true
  sleep 0.25
  t1="$(date +%s%3N)"
  log "panel ensure: top=$TOP_PANEL attempts=$attempt state=$state elapsed_ms=$((t1 - t0))"
}

capture() {
  local out="$1" attempt
  rm -f "$out"
  for attempt in 1 2 3; do
    timeout 30 spectacle -b -n -f -o "$out" >/dev/null 2>&1 || true
    if [[ -s "$out" ]]; then
      return 0
    fi
    sleep 0.5
  done
  log "capture failed: $out"
  return 1
}

locate_icon() {
  # locate_icon <screenshot.png> <json-out>
  local image="$1" out="$2"
  if "$PY" "$PROBE" icon --image "$image" --out "$out" >/dev/null 2>&1; then
    read -r CLICK_X CLICK_Y < <("$PY" - "$out" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
c = d.get('chosen') or {}
center = c.get('center') or {}
print(center.get('x', ''), center.get('y', ''))
PY
)
    [[ -n "$CLICK_X" && -n "$CLICK_Y" ]] || return 1
    return 0
  fi
  return 1
}

open_overflow() {
  # Click the Plasma system-tray overflow chevron at the right edge of the
  # systemtray widget.  Only used when the icon is not visible in the panel.
  local offset x y shot="$EVID/task-6-tray-overflow.png"
  for offset in 12 6 22; do
    x=$((TRAY_X + TRAY_W - offset))
    y=$((TRAY_Y + TRAY_H / 2))
    xdotool mousemove "$x" "$y" >/dev/null 2>&1 || true
    sleep 0.2
    xdotool click 1 >/dev/null 2>&1 || true
    sleep 0.8
    capture "$shot" || continue
    if locate_icon "$shot" "$EVID/task-6-tray-icon-overflow.json"; then
      return 0
    fi
  done
  return 1
}

ensure_icon_ready() {
  # The icon coordinate is stable while the panel session is alive; only the
  # panel visibility and overflow state can change.  Avoid a full spectacle
  # capture before every test (spectacle can occasionally take >15 s).
  local name="$1"
  ensure_top_panel_visible
  if [[ "$ICON_LOCATION" == "overflow" ]]; then
    if open_overflow; then
      return 0
    fi
    die "icon not visible after opening overflow for $name"
  fi
  return 0
}

snap_windows() {
  local t0 t1
  t0="$(date +%s%3N)"
  "$PY" "$PROBE" snapshot-windows --out "$1" >/dev/null
  t1="$(date +%s%3N)"
  log "snapshot $(basename "$1") elapsed_ms=$((t1 - t0))"
}
diff_windows() { "$PY" "$PROBE" diff-windows --before "$1" --after "$2" --out "$3" >/dev/null; }
event_count() { "$PY" "$PROBE" event-count --events "$EVENTS"; }
extract_events() { "$PY" "$PROBE" events --events "$EVENTS" --since "$1" --out "$2" >/dev/null; }

sni_list() {
  qdbus6 org.kde.StatusNotifierWatcher /StatusNotifierWatcher \
    org.kde.StatusNotifierWatcher.RegisteredStatusNotifierItems 2>/dev/null |
    sed '/^[[:space:]]*$/d'
}

find_quickask_item() {
  # find_quickask_item <before-list> <after-list>
  "$PY" - "$1" "$2" <<'PY'
import subprocess, sys

before = set(x for x in open(sys.argv[1], encoding='utf-8').read().split() if x)
after = [x for x in open(sys.argv[2], encoding='utf-8').read().split() if x]

def tooltip(item):
    service, path = item.split('/', 1)
    path = '/' + path
    p = subprocess.run(
        [
            'gdbus', 'call', '--session', '--dest', service,
            '--object-path', path, '--method',
            'org.freedesktop.DBus.Properties.Get',
            'org.kde.StatusNotifierItem', 'ToolTip',
        ],
        capture_output=True, text=True,
    )
    return p.stdout if p.returncode == 0 else ''

for item in after:
    if item in before and 'QuickAsk test tray' not in tooltip(item):
        continue
    if 'QuickAsk test tray' in tooltip(item):
        print(item)
        sys.exit(0)
sys.exit(1)
PY
}

sni_props_text() {
  local item="$1" service path prop
  service="${item%%/*}"
  path="/${item#*/}"
  echo "\$ gdbus call --session --dest $service --object-path $path \\"
  echo "    --method org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierItem <prop>"
  for prop in Id Title ToolTip Status Category Menu ItemIsMenu; do
    echo "--- $prop ---"
    gdbus call --session --dest "$service" --object-path "$path" \
      --method org.freedesktop.DBus.Properties.Get \
      org.kde.StatusNotifierItem "$prop" 2>&1 || true
  done
}

cleanup() {
  local rc=$?
  set +e
  log "cleanup start (rc=$rc)"
  # Preserve a valid event-log snapshot before SIGTERM.  Electron may be
  # killed mid-write; the snapshot is restored below if the live file is bad.
  if [[ -s "${EVENTS:-}" ]]; then
    cp -f "$EVENTS" "$EVID/task-6-tray-events.snapshot.json" 2>/dev/null || true
  fi
  # Close any popup menus / overflow before killing the app.
  xdotool key Escape >/dev/null 2>&1 || true
  xdotool key Escape >/dev/null 2>&1 || true

  if [[ -n "${APP_MAIN_PID:-}" ]] && kill -0 "$APP_MAIN_PID" 2>/dev/null; then
    log "SIGTERM app main pid=$APP_MAIN_PID"
    kill -TERM "$APP_MAIN_PID" 2>/dev/null || true
  fi
  if [[ -n "${APP_LAUNCH_PID:-}" ]] && kill -0 "$APP_LAUNCH_PID" 2>/dev/null; then
    log "SIGTERM app launch pid=$APP_LAUNCH_PID"
    kill -TERM "$APP_LAUNCH_PID" 2>/dev/null || true
  fi
  sleep 0.8

  # Kill only Electron processes whose command line contains OUR spike path.
  # The [s] trick avoids matching this shell's own command line.
  local pid
  for pid in $(pgrep -f "[s]pike/tray.cjs" 2>/dev/null || true); do
    log "SIGTERM leftover spike pid=$pid"
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 0.5
  for pid in $(pgrep -f "[s]pike/tray.cjs" 2>/dev/null || true); do
    log "SIGKILL leftover spike pid=$pid"
    kill -KILL "$pid" 2>/dev/null || true
  done

  # Restore previous active window and pointer.
  if [[ -n "${ORIG_ACTIVE:-}" ]]; then
    xdotool windowactivate "$ORIG_ACTIVE" >/dev/null 2>&1 || true
  fi
  # If the panel was initially autohidden, let it autohide again by moving
  # the pointer off the panel and keeping focus on the previous window; never
  # write panel configuration.
  xdotool mousemove 960 500 >/dev/null 2>&1 || true
  sleep 0.5
  if [[ -n "${TOP_PANEL:-}" && "${ORIG_PANEL_STATE:-}" == "IsUnMapped" ]]; then
    local attempt
    for attempt in 1 2; do
      [[ "$(map_state "$TOP_PANEL")" == "IsViewable" ]] || break
      qdbus6 org.kde.kglobalaccel /component/plasmashell         org.kde.kglobalaccel.Component.invokeShortcut cycle-panels >/dev/null 2>&1 || true
      sleep 0.8
      xdotool windowactivate "${ORIG_ACTIVE:-$TOP_PANEL}" >/dev/null 2>&1 || true
      xdotool mousemove 960 500 >/dev/null 2>&1 || true
      sleep 1.5
    done
  fi
  if [[ -n "${ORIG_MOUSE_X:-}" && -n "${ORIG_MOUSE_Y:-}" ]]; then
    xdotool mousemove "$ORIG_MOUSE_X" "$ORIG_MOUSE_Y" >/dev/null 2>&1 || true
  fi
  sleep 0.5
  local final_state="unknown"
  [[ -n "${TOP_PANEL:-}" ]] && final_state="$(map_state "$TOP_PANEL")"
  log "cleanup final panel_state=$final_state original=$ORIG_PANEL_STATE"
  export TOP_PANEL ORIG_PANEL_STATE ORIG_ACTIVE ORIG_MOUSE_X ORIG_MOUSE_Y APP_MAIN_PID NEW_ITEM
  export FINAL_STATE="$final_state"
  if [[ -f "$EVID/task-6-tray-panel-state.json" ]]; then
    "$PY" - "$EVID/task-6-tray-panel-state.json" <<'PY_PANEL' || true
import json, os, sys
path = sys.argv[1]
try:
    d = json.load(open(path, encoding='utf-8'))
except Exception:
    d = {}
d['cleanup_ts'] = os.popen('date -Is').read().strip()
d['top_panel_window'] = os.environ.get('TOP_PANEL') or d.get('top_panel_window')
d['initial_state'] = os.environ.get('ORIG_PANEL_STATE') or d.get('initial_state')
d['final_state'] = os.environ.get('FINAL_STATE') or d.get('final_state')
d['original_active_window'] = os.environ.get('ORIG_ACTIVE') or d.get('original_active_window')
d['original_mouse'] = [os.environ.get('ORIG_MOUSE_X'), os.environ.get('ORIG_MOUSE_Y')]
d['app_pid'] = os.environ.get('APP_MAIN_PID') or d.get('app_pid')
d['new_sni_item'] = os.environ.get('NEW_ITEM') or d.get('new_sni_item')
with open(path, 'w', encoding='utf-8') as fh:
    json.dump(d, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
PY_PANEL
  fi
  if command -v pgrep >/dev/null 2>&1; then
    local left
    left="$(pgrep -f "[s]pike/tray.cjs" 2>/dev/null || true)"
    if [[ -n "$left" ]]; then
      log "WARNING leftover spike pids: $left"
    else
      log "no spike/tray.cjs processes left"
    fi
  fi
  # Guarantee the required events evidence path is valid JSON even if the
  # final Electron quit raced a non-atomic write.
  if [[ -f "$EVID/task-6-tray-events.snapshot.json" ]]; then
    if ! "$PY" -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$EVENTS" >/dev/null 2>&1; then
      cp -f "$EVID/task-6-tray-events.snapshot.json" "$EVENTS" 2>/dev/null || true
      log "restored event log from snapshot"
    fi
  fi
  log "cleanup done"
  return 0
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 0. preconditions / initial state
# ---------------------------------------------------------------------------
[[ -x "$ELECTRON" ]] || die "Electron binary missing: $ELECTRON; run npm ci"
[[ -f "$ROOT/assets/tray-spike-32.png" ]] || die "missing assets/tray-spike-32.png"
[[ -f "$PROBE" ]] || die "missing $PROBE"

if [[ "$(qdbus6 org.kde.screensaver /ScreenSaver org.freedesktop.ScreenSaver.GetActive 2>/dev/null || true)" == "true" ]]; then
  die "session is locked (ScreenSaver.GetActive=true); refusing to run"
fi

if pgrep -f "[s]pike/tray.cjs" >/dev/null 2>&1; then
  die "a previous spike/tray.cjs is still running; refusing to start another"
fi

rm -f "$EVENTS" "$APP_LOG" "$DRIVER_LOG" "$DBUS_TXT" "$BEFORE_LIST" "$AFTER_LIST" \
  "$RUN_META" "$PLASMA_JSON" \
  "$EVID"/task-6-tray-{left,right,right-item,double,dbus-activate,dbus-secondary,dbus-contextmenu}*.{png,json} \
  "$EVID"/task-6-tray-panel*.png "$EVID"/task-6-tray-overflow*.png \
  "$EVID"/task-6-tray-sni.json "$EVID"/task-6-tray-summary.json 2>/dev/null || true

ORIG_ACTIVE="$(xdotool getactivewindow 2>/dev/null || true)"
read -r ORIG_MOUSE_X ORIG_MOUSE_Y < <(xdotool getmouselocation --shell 2>/dev/null | awk -F= '/^X=/{x=$2} /^Y=/{y=$2} END{print x, y}')
TOP_PANEL="$(find_top_panel)" || die "top Plasma panel not found"
ORIG_PANEL_STATE="$(map_state "$TOP_PANEL")"
log "initial ORIG_ACTIVE=$ORIG_ACTIVE mouse=${ORIG_MOUSE_X:-?},${ORIG_MOUSE_Y:-?} top_panel=$TOP_PANEL state=$ORIG_PANEL_STATE"

# Read system-tray widget geometry (read-only Plasma scripting API).
PLASMA_SCRIPT='var out=null; for (var i=0;i<panels().length;i++){var p=panels()[i]; var ws=p.widgets(); for (var j=0;j<ws.length;j++){ if (ws[j].type=="org.kde.plasma.systemtray"){ out={panel_index:i, location:p.location, panel_height:p.height, tray_geom:ws[j].geometry, widget_id:ws[j].id}; } } } print(JSON.stringify(out));'
plasma_script "$PLASMA_SCRIPT" > "$PLASMA_JSON" || die "PlasmaShell evaluateScript failed"
if ! read -r TRAY_X TRAY_Y TRAY_W TRAY_H < <("$PY" - "$PLASMA_JSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
g = d['tray_geom']
print(int(g['x']), int(g['y']), int(g['width']), int(g['height']))
PY
); then
  die "could not parse systemtray geometry"
fi
log "systemtray widget x=$TRAY_X y=$TRAY_Y w=$TRAY_W h=$TRAY_H"

sni_list > "$BEFORE_LIST" || true
log "SNI items before app: $(wc -l < "$BEFORE_LIST")"

# ---------------------------------------------------------------------------
# 1. start app + wait TRAY_READY
# ---------------------------------------------------------------------------
log "starting Electron tray spike"
setsid "$ELECTRON" "$APP_ENTRY" --enable-logging > "$APP_LOG" 2>&1 &
APP_LAUNCH_PID=$!
log "app launch pid=$APP_LAUNCH_PID"

for _ in $(seq 1 300); do
  if [[ -s "$EVENTS" ]] && grep -q '"type": "TRAY_READY"' "$EVENTS"; then
    break
  fi
  if ! kill -0 "$APP_LAUNCH_PID" 2>/dev/null; then
    tail -40 "$APP_LOG" >&2 || true
    die "Electron exited before TRAY_READY"
  fi
  sleep 0.1
done
grep -q '"type": "TRAY_READY"' "$EVENTS" || die "TRAY_READY not found in $EVENTS"
APP_MAIN_PID="$("$PY" - "$EVENTS" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding='utf-8'))['pid'])
PY
)"
[[ -n "$APP_MAIN_PID" ]] || die "could not parse app PID"
log "TRAY_READY app main pid=$APP_MAIN_PID"

# Wait for the new SNI item to appear and identify it by its tooltip.
NEW_ITEM=""
for _ in $(seq 1 100); do
  sni_list > "$AFTER_LIST" || true
  if NEW_ITEM="$(find_quickask_item "$BEFORE_LIST" "$AFTER_LIST" 2>/dev/null)" && [[ -n "$NEW_ITEM" ]]; then
    break
  fi
  NEW_ITEM=""
  sleep 0.1
done
[[ -n "$NEW_ITEM" ]] || die "QuickAsk SNI item not found in StatusNotifierWatcher"
log "new SNI item: $NEW_ITEM"

"$PY" "$PROBE" sni-props --item "$NEW_ITEM" --out "$EVID/task-6-tray-sni.json" >/dev/null

# Raw SNI registration evidence file (task explicitly requires qdbus6 output).
{
  echo "# Task 6 / G7 — StatusNotifierItem registration evidence"
  echo "# generated: $(date -Is)"
  echo "# display: $DISPLAY"
  echo
  echo "## qdbus6 watcher list BEFORE app start"
  echo "\$ qdbus6 org.kde.StatusNotifierWatcher /StatusNotifierWatcher org.kde.StatusNotifierWatcher.RegisteredStatusNotifierItems"
  cat "$BEFORE_LIST"
  echo
  echo "## qdbus6 watcher list AFTER TRAY_READY"
  echo "\$ qdbus6 org.kde.StatusNotifierWatcher /StatusNotifierWatcher org.kde.StatusNotifierWatcher.RegisteredStatusNotifierItems"
  cat "$AFTER_LIST"
  echo
  echo "## new item"
  echo "$NEW_ITEM"
  echo
  echo "## item properties (gdbus; Electron's SNI object has no Introspect, qdbus6 Get fails)"
  sni_props_text "$NEW_ITEM"
  echo
  echo "## qdbus6 direct Get failure note (expected; no Introspect)"
  service="${NEW_ITEM%%/*}"
  path="/${NEW_ITEM#*/}"
  qdbus6 "$service" "$path" org.freedesktop.DBus.Properties.Get org.kde.StatusNotifierItem Id 2>&1 || true
  echo
  echo "## org.freedesktop.secrets owner (keyring context, G8)"
  echo "\$ qdbus6 org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets"
  qdbus6 org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets 2>&1 || true
  echo "\$ qdbus6 org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.GetNameOwner org.freedesktop.secrets"
  qdbus6 org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.GetNameOwner org.freedesktop.secrets 2>&1 || true
} > "$DBUS_TXT"

# Run metadata
export RUN_META BEFORE_LIST AFTER_LIST NEW_ITEM APP_MAIN_PID APP_LAUNCH_PID TOP_PANEL ORIG_PANEL_STATE PLASMA_JSON
"$PY" - <<'PY'
import json, os
meta = {
    'started_at': None,
    'finished_at': os.popen('date -Is').read().strip(),
    'before_registered_items': open(os.environ['BEFORE_LIST'], encoding='utf-8').read().split(),
    'after_registered_items': open(os.environ['AFTER_LIST'], encoding='utf-8').read().split(),
    'new_item': os.environ['NEW_ITEM'],
    'app_launch_pid': int(os.environ['APP_LAUNCH_PID']),
    'app_main_pid': int(os.environ['APP_MAIN_PID']),
    'top_panel_window': os.environ['TOP_PANEL'],
    'top_panel_initial_state': os.environ['ORIG_PANEL_STATE'],
    'plasma': json.load(open(os.environ['PLASMA_JSON'], encoding='utf-8')),
}
with open(os.environ['RUN_META'], 'w', encoding='utf-8') as fh:
    json.dump(meta, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
PY

# ---------------------------------------------------------------------------
# 2. panel + icon
# ---------------------------------------------------------------------------
log "revealing Plasma panel"
ensure_top_panel_visible
capture "$EVID/task-6-tray-panel.png" || die "could not capture panel"
if locate_icon "$EVID/task-6-tray-panel.png" "$EVID/task-6-tray-icon-location.json"; then
  ICON_LOCATION="panel"
  log "icon found in panel at $CLICK_X,$CLICK_Y"
else
  log "icon not in panel; opening system-tray overflow"
  if open_overflow; then
    ICON_LOCATION="overflow"
    capture "$EVID/task-6-tray-panel.png" || true
    log "icon found in overflow at $CLICK_X,$CLICK_Y"
  else
    die "icon not found in panel or overflow"
  fi
fi

# ---------------------------------------------------------------------------
# 3. real input tests
# ---------------------------------------------------------------------------
run_left_click() {
  local n before after diff
  ensure_icon_ready left
  n="$(event_count)"
  snap_windows "$EVID/task-6-tray-left-before-windows.json"
  ensure_top_panel_visible
  xdotool mousemove "$CLICK_X" "$CLICK_Y" >/dev/null 2>&1 || true
  sleep 0.2
  xdotool click 1 >/dev/null 2>&1 || true
  sleep 0.7
  capture "$EVID/task-6-tray-left.png" || die "left screenshot failed"
  snap_windows "$EVID/task-6-tray-left-after-windows.json"
  diff_windows "$EVID/task-6-tray-left-before-windows.json" "$EVID/task-6-tray-left-after-windows.json" "$EVID/task-6-tray-left-windows.json"
  extract_events "$n" "$EVID/task-6-tray-left-events.json"
  log "left click done at $CLICK_X,$CLICK_Y"
}

run_right_click() {
  local n before after diff mx my mw mh
  ensure_icon_ready right
  n="$(event_count)"
  snap_windows "$EVID/task-6-tray-right-before-windows.json"
  ensure_top_panel_visible
  xdotool mousemove "$CLICK_X" "$CLICK_Y" >/dev/null 2>&1 || true
  sleep 0.2
  xdotool click 3 >/dev/null 2>&1 || true
  sleep 0.7
  capture "$EVID/task-6-tray-right.png" || die "right screenshot failed"
  snap_windows "$EVID/task-6-tray-right-after-windows.json"
  diff_windows "$EVID/task-6-tray-right-before-windows.json" "$EVID/task-6-tray-right-after-windows.json" "$EVID/task-6-tray-right-windows.json"
  extract_events "$n" "$EVID/task-6-tray-right-events.json"

  read -r mx my mw mh < <("$PY" - "$EVID/task-6-tray-right-windows.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
m = d.get('menu_like') or {}
print(m.get('x', ''), m.get('y', ''), m.get('width', ''), m.get('height', ''))
PY
)
  if [[ -n "$mx" && -n "$my" && -n "$mw" && -n "$mh" ]]; then
    local ix iy
    ix=$((mx + mw / 2))
    iy=$((my + 22))
    log "right menu at $mx,$my ${mw}x${mh}; clicking first item at $ix,$iy"
    snap_windows "$EVID/task-6-tray-right-item-before-windows.json"
    xdotool mousemove "$ix" "$iy" >/dev/null 2>&1 || true
    sleep 0.2
    xdotool click 1 >/dev/null 2>&1 || true
    sleep 0.7
    capture "$EVID/task-6-tray-right-item.png" || true
    snap_windows "$EVID/task-6-tray-right-item-after-windows.json" || true
    extract_events "$n" "$EVID/task-6-tray-right-item-events.json"
    "$PY" - "$EVID/task-6-tray-right-windows.json" "$ix" "$iy" > "$EVID/task-6-tray-right-menu-click.json" <<'PY'
import json, sys
menu = json.load(open(sys.argv[1], encoding='utf-8')).get('menu_like')
print(json.dumps({
    'menu': menu,
    'click': {'x': int(sys.argv[2]), 'y': int(sys.argv[3])},
    'item': '显示/隐藏 (first menu item)',
}, ensure_ascii=False, indent=2))
PY
  else
    log "right click did not create a detectable menu window"
    xdotool key Escape >/dev/null 2>&1 || true
  fi
}

run_double_click() {
  local n
  ensure_icon_ready double
  n="$(event_count)"
  snap_windows "$EVID/task-6-tray-double-before-windows.json"
  ensure_top_panel_visible
  xdotool mousemove "$CLICK_X" "$CLICK_Y" >/dev/null 2>&1 || true
  sleep 0.2
  # Task 6 explicitly requires --repeat 2 --delay 100.
  xdotool click --repeat 2 --delay 100 1 >/dev/null 2>&1 || true
  sleep 0.7
  capture "$EVID/task-6-tray-double.png" || die "double-click screenshot failed"
  snap_windows "$EVID/task-6-tray-double-after-windows.json"
  diff_windows "$EVID/task-6-tray-double-before-windows.json" "$EVID/task-6-tray-double-after-windows.json" "$EVID/task-6-tray-double-windows.json"
  extract_events "$n" "$EVID/task-6-tray-double-events.json"
  log "double click done at $CLICK_X,$CLICK_Y"
}

log "running real click tests"
run_left_click
run_right_click
run_double_click

# ---------------------------------------------------------------------------
# 4. deterministic DBus supplement (not a substitute for the real clicks)
# ---------------------------------------------------------------------------
DBUS_ACTIONS_TXT="$EVID/task-6-tray-dbus-actions.txt"
: > "$DBUS_ACTIONS_TXT"
DBUS_ACTIONS_JSON="$EVID/task-6-tray-dbus-actions.json"
"$PY" - <<'PY' > "$DBUS_ACTIONS_JSON"
print('{}')
PY

run_dbus_action() {
  local action="$1" slug="$2" n out rc
  n="$(event_count)"
  snap_windows "$EVID/task-6-tray-dbus-$slug-before-windows.json"
  {
    echo "# $(date -Is) $action"
    echo "\$ gdbus call --session --dest ${NEW_ITEM%%/*} --object-path /${NEW_ITEM#*/} \\"
    echo "    --method org.kde.StatusNotifierItem.$action 0 0"
  } >> "$DBUS_ACTIONS_TXT"
  set +e
  out="$(gdbus call --session --dest "${NEW_ITEM%%/*}" --object-path "/${NEW_ITEM#*/}" \
    --method "org.kde.StatusNotifierItem.$action" 0 0 2>&1)"
  rc=$?
  set -e
  {
    echo "exit=$rc"
    printf '%s\n' "$out"
    echo
  } >> "$DBUS_ACTIONS_TXT"
  sleep 0.7
  capture "$EVID/task-6-tray-dbus-$slug.png" || true
  snap_windows "$EVID/task-6-tray-dbus-$slug-after-windows.json" || true
  diff_windows "$EVID/task-6-tray-dbus-$slug-before-windows.json" "$EVID/task-6-tray-dbus-$slug-after-windows.json" "$EVID/task-6-tray-dbus-$slug-windows.json" || true
  extract_events "$n" "$EVID/task-6-tray-dbus-$slug-events.json"
  "$PY" - "$DBUS_ACTIONS_JSON" "$action" "$rc" "$out" "$EVID/task-6-tray-dbus-$slug-windows.json" "$EVID/task-6-tray-dbus-$slug-events.json" "$slug" <<'PY'
import json, os, sys
path, action, rc, out, win, ev, slug = sys.argv[1:8]
data = json.load(open(path, encoding='utf-8'))
wi = json.load(open(win, encoding='utf-8')) if os.path.exists(win) else {}
evi = json.load(open(ev, encoding='utf-8')) if os.path.exists(ev) else {}
data[action] = {
    'exit': int(rc),
    'stdout': out,
    'menu_shown': wi.get('menu_shown', False),
    'new_windows': wi.get('new_windows', []),
    'app_events': evi.get('events', []),
    'screenshot': f'.omo/evidence/task-6-tray-dbus-{slug}.png',
}
with open(path, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
PY
  # If ContextMenu opened a popup, close it before the next action.
  if [[ "$action" == "ContextMenu" ]]; then
    xdotool key Escape >/dev/null 2>&1 || true
    sleep 0.3
  fi
  log "DBus $action done (exit=$rc)"
}

log "running DBus supplement"
run_dbus_action Activate activate
run_dbus_action SecondaryActivate secondary
run_dbus_action ContextMenu contextmenu

# ---------------------------------------------------------------------------
# 5. summary + final state
# ---------------------------------------------------------------------------
"$PY" "$PROBE" state --events "$EVENTS" --out "$EVID/task-6-tray-state.json" >/dev/null

FINAL_STATE="$(map_state "$TOP_PANEL")"
export TOP_PANEL ORIG_PANEL_STATE ORIG_ACTIVE ORIG_MOUSE_X ORIG_MOUSE_Y APP_MAIN_PID NEW_ITEM FINAL_STATE
"$PY" - "$EVID/task-6-tray-panel-state.json" "$EVID/task-6-tray-summary.json" <<'PY'
import json, os, subprocess, sys
panel_state_path, summary_path = sys.argv[1:3]
summary = json.load(open(summary_path, encoding='utf-8'))
data = {
    'ts': os.popen('date -Is').read().strip(),
    'top_panel_window': os.environ.get('TOP_PANEL'),
    'initial_state': os.environ.get('ORIG_PANEL_STATE'),
    'final_state': os.environ.get('FINAL_STATE'),
    'original_active_window': os.environ.get('ORIG_ACTIVE'),
    'original_mouse': [os.environ.get('ORIG_MOUSE_X'), os.environ.get('ORIG_MOUSE_Y')],
    'app_pid': os.environ.get('APP_MAIN_PID'),
    'new_sni_item': os.environ.get('NEW_ITEM'),
    'systemtray_geometry': summary.get('run_meta', {}).get('plasma', {}).get('tray_geom'),
}
with open(panel_state_path, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write('\n')
PY

"$PY" "$PROBE" combine-summary --dir "$EVID" --out "$EVID/task-6-tray-summary.json" >/dev/null

log "done; see $EVID/task-6-tray-summary.json"
