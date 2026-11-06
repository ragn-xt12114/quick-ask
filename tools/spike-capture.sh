#!/usr/bin/env bash
# QuickAsk M0 G1/G5 spike capture wrapper.
#
# Usage:
#   tools/spike-capture.sh cycle [--variant gpu-on] [--disable-gpu] [--enable-transparent-visuals]
#   tools/spike-capture.sh sizes
#   tools/spike-capture.sh blur
#   tools/spike-capture.sh opaque
#   tools/spike-capture.sh g5
#
# Records a 60fps x11grab MP4, runs the spike self-test, extracts frames,
# and calls tools/spike-check.py (PIL). Idempotent: regenerates evidence.
#
# Compositor suspend/resume is guarded by a bash trap. KWin 6.3.6 does not
# expose org.kde.kwin.Compositing.suspend/resume over DBus, so the equivalent
# runtime toggle is invoked through kglobalaccel ("Suspend Compositing").

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
# shellcheck disable=SC1091
source scripts/env.sh

export DISPLAY="${DISPLAY:-:0}"
EVID="$ROOT/.omo/evidence"
mkdir -p "$EVID"

MODE="${1:-cycle}"
shift || true

VARIANT="gpu-on"
EXTRA=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --variant)
      VARIANT="$2"
      shift 2
      ;;
    --disable-gpu)
      EXTRA+=("--disable-gpu")
      if [ "$VARIANT" = "gpu-on" ]; then VARIANT="gpu-off"; fi
      shift
      ;;
    --enable-transparent-visuals)
      EXTRA+=("--enable-transparent-visuals")
      if [ "$VARIANT" = "gpu-on" ]; then VARIANT="transparent-visuals"; fi
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$MODE" in
  cycle) TAG="cycle-$VARIANT" ;;
  sizes|blur|opaque|g5) TAG="$MODE" ;;
  *)
    echo "unknown mode: $MODE (cycle|sizes|blur|opaque|g5)" >&2
    exit 2
    ;;
esac

MP4="$EVID/task-3-$TAG.mp4"
FFLOG="$EVID/task-3-$TAG-ffmpeg.log"
ELOG="$EVID/task-3-$TAG-electron.log"
FRAMES="$EVID/frames-$TAG"
META="$EVID/task-3-$TAG-capture-meta.json"
PIXELS="$EVID/task-3-$TAG-pixels.json"

FFMPEG_PID=""
ELECTRON_PID=""
COMPOSITOR_TOUCHED=0
DISPLAY_BASE="${DISPLAY%%.*}"
X11GRAB_INPUT="${DISPLAY_BASE}.0+0,0"

# ------------------------------------------------------------------ compositor
compositor_active() {
  qdbus6 org.kde.KWin /Compositor org.kde.kwin.Compositing.active 2>/dev/null | tr -d '[:space:]'
}

toggle_compositor() {
  qdbus6 org.kde.kglobalaccel /component/kwin \
    org.kde.kglobalaccel.Component.invokeShortcut 'Suspend Compositing' \
    >/dev/null 2>&1 || xdotool key --clearmodifiers alt+shift+F12
}

ensure_compositor_on() {
  local i active
  for i in 1 2 3 4 5 6 7 8; do
    active="$(compositor_active)"
    if [ "$active" = "true" ]; then
      return 0
    fi
    toggle_compositor
    sleep 0.4
  done
  return 1
}

suspend_compositor() {
  local i active
  for i in 1 2 3 4; do
    toggle_compositor
    sleep 0.4
    active="$(compositor_active)"
    if [ "$active" = "false" ]; then
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------- cleanup
cleanup() {
  local status=$?
  if [ -n "$FFMPEG_PID" ] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
    kill -INT "$FFMPEG_PID" 2>/dev/null
    wait "$FFMPEG_PID" 2>/dev/null
  fi
  if [ "$COMPOSITOR_TOUCHED" = "1" ]; then
    ensure_compositor_on || true
    COMPOSITOR_TOUCHED=0
  fi
  if [ -n "$ELECTRON_PID" ] && kill -0 "$ELECTRON_PID" 2>/dev/null; then
    kill -TERM "$ELECTRON_PID" 2>/dev/null
    wait "$ELECTRON_PID" 2>/dev/null
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

wait_with_timeout() {
  local pid="$1" timeout_ms="$2" start now
  start=$(date +%s%3N)
  while kill -0 "$pid" 2>/dev/null; do
    now=$(date +%s%3N)
    if [ $((now - start)) -ge "$timeout_ms" ]; then
      return 124
    fi
    sleep 0.1
  done
  return 0
}

wait_for_file() {
  local file="$1" timeout_ms="$2" start now
  start=$(date +%s%3N)
  while [ ! -f "$file" ]; do
    now=$(date +%s%3N)
    if [ $((now - start)) -ge "$timeout_ms" ]; then
      return 1
    fi
    sleep 0.1
  done
  return 0
}

# ------------------------------------------------------------------ preflight
SCREEN_DIMS="$(xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2; exit}')"
SCREEN_W="${SCREEN_DIMS%x*}"
SCREEN_H="${SCREEN_DIMS#*x}"
if [ -z "$SCREEN_W" ] || [ -z "$SCREEN_H" ]; then
  echo "cannot determine screen size" >&2
  exit 1
fi

echo "== spike-capture mode=$MODE tag=$TAG variant=$VARIANT screen=${SCREEN_W}x${SCREEN_H} display=$DISPLAY"

# KWin composites windows into a full-screen workspace window; root capture
# (import -window root / ffmpeg x11grab root) misses them on this machine.
CAPTURE_WID="$("${PYTHON:-python3}" "$ROOT/tools/find-compositor-window.py" 2>/dev/null || true)"
if [ -z "$CAPTURE_WID" ] || [ "$CAPTURE_WID" = "0x0" ]; then
  echo "WARN: could not find KWin compositor window; falling back to root" >&2
  CAPTURE_WID="0x0"
fi
CAPTURE_WID_DEC=$((CAPTURE_WID))
{
  echo "capture_window=$CAPTURE_WID"
  echo "capture_window_decimal=$CAPTURE_WID_DEC"
  echo "generated_at=$(date -Is)"
  echo "screen=${SCREEN_W}x${SCREEN_H}"
} > "$EVID/task-3-compositor-window.txt"
export QUICKASK_CAPTURE_WID="$CAPTURE_WID"
echo "== capture window: $CAPTURE_WID ($CAPTURE_WID_DEC)"

SCREENSAVER_ACTIVE="$(qdbus6 org.freedesktop.ScreenSaver /ScreenSaver org.freedesktop.ScreenSaver.GetActive 2>/dev/null | tr -d '[:space:]' || true)"
LOCK_WIN="$(xdotool search --class kscreenlocker_greet 2>/dev/null | head -1 || true)"
COMPOSITOR_STATE="$(compositor_active)"
{
  echo "generated_at=$(date -Is)"
  echo "screensaver_active=${SCREENSAVER_ACTIVE:-unknown}"
  echo "lock_window=${LOCK_WIN:-none}"
  echo "compositor_active=$COMPOSITOR_STATE"
  echo "display=$DISPLAY"
  echo "screen=${SCREEN_W}x${SCREEN_H}"
} > "$EVID/task-3-session-state.txt"

# spectacle/KWin ScreenShot2 is used for true composited stills when the
# session is unlocked. Under a suspended compositor (G5) use the workspace
# window fallback instead.
if [ "$MODE" = "opaque" ] || [ "$MODE" = "g5" ]; then
  export QUICKASK_SCREEN_CAPTURE=root
  echo "== screenshot mode: root raw screen (compositor suspended)"
elif [ "${SCREENSAVER_ACTIVE:-}" = "true" ] || [ -n "${LOCK_WIN:-}" ]; then
  export QUICKASK_SCREEN_CAPTURE=workspace
  echo "== screenshot mode: workspace fallback (locked)"
else
  echo "== screenshot mode: spectacle (true composite)"
fi

rm -f "$MP4" "$FFLOG" "$ELOG" "$META" "$PIXELS"
rm -rf "$FRAMES"
mkdir -p "$FRAMES"
rm -f "$EVID/task-3-spike-info.json"

if [ "$MODE" = "opaque" ] || [ "$MODE" = "g5" ]; then
  rm -f "$EVID/task-3-$MODE-ready.json" "$EVID/task-3-$MODE-go"
fi

# ------------------------------------------------------------------ record
FFMPEG_START_MS=$(date +%s%3N)
ffmpeg -hide_banner -loglevel warning -y \
  -f x11grab -framerate 60 -video_size "${SCREEN_W}x${SCREEN_H}" \
  -window_id "$CAPTURE_WID_DEC" \
  -i "$X11GRAB_INPUT" \
  -t 180 -c:v libx264 -preset ultrafast -crf 20 -pix_fmt yuv420p \
  "$MP4" > "$FFLOG" 2>&1 &
FFMPEG_PID=$!
sleep 0.5

if ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
  echo "ffmpeg failed to start; see $FFLOG" >&2
  cat "$FFLOG" >&2 || true
  exit 1
fi

# ------------------------------------------------------------------ spike
./node_modules/.bin/electron spike/main.cjs --self-test "$MODE" --variant "$VARIANT" \
  "${EXTRA[@]}" > "$ELOG" 2>&1 &
ELECTRON_PID=$!

if [ "$MODE" = "opaque" ] || [ "$MODE" = "g5" ]; then
  READY="$EVID/task-3-$MODE-ready.json"
  if ! wait_for_file "$READY" 30000; then
    echo "spike never became ready ($READY)" >&2
  fi
  COMPOSITOR_TOUCHED=1
  qdbus6 org.kde.KWin /Compositor org.kde.kwin.Compositing.active \
    > "$EVID/task-3-$MODE-compositing-before.txt" 2>&1 || true
  if suspend_compositor; then
    qdbus6 org.kde.KWin /Compositor org.kde.kwin.Compositing.active \
      > "$EVID/task-3-$MODE-compositing-suspended.txt" 2>&1 || true
    : > "$EVID/task-3-$MODE-go"
    # Keep the compositor suspended for a short, bounded window.
    wait_with_timeout "$ELECTRON_PID" 8000 || echo "spike timeout under suspended compositor" >&2
  else
    echo "could not suspend compositor; running with compositor on" >&2
    : > "$EVID/task-3-$MODE-go"
    wait_with_timeout "$ELECTRON_PID" 12000 || true
  fi
  ensure_compositor_on || echo "WARN: failed to restore compositor" >&2
  COMPOSITOR_TOUCHED=0
  qdbus6 org.kde.KWin /Compositor org.kde.kwin.Compositing.active \
    > "$EVID/task-3-$MODE-compositing-after.txt" 2>&1 || true
  if [ "$MODE" = "g5" ]; then
    cp "$EVID/task-3-$MODE-compositing-after.txt" "$EVID/task-3-compositing-after.txt"
  fi
  if kill -0 "$ELECTRON_PID" 2>/dev/null; then
    wait_with_timeout "$ELECTRON_PID" 2000 || kill -TERM "$ELECTRON_PID" 2>/dev/null || true
  fi
  wait "$ELECTRON_PID" 2>/dev/null || true
else
  wait "$ELECTRON_PID" 2>/dev/null || true
fi
ELECTRON_PID=""

FFMPEG_END_MS=$(date +%s%3N)
if kill -0 "$FFMPEG_PID" 2>/dev/null; then
  kill -INT "$FFMPEG_PID" 2>/dev/null
  wait "$FFMPEG_PID" 2>/dev/null
fi
FFMPEG_PID=""

# ------------------------------------------------------------------ extract frames
if [ ! -s "$MP4" ]; then
  echo "ERROR: no mp4 produced" >&2
  exit 1
fi
ffmpeg -hide_banner -loglevel error -y -i "$MP4" \
  -vf "fps=30,scale=640:-1:flags=fast_bilinear" -q:v 4 \
  "$FRAMES/f_%05d.jpg" >> "$FFLOG" 2>&1 || true
FRAME_COUNT=$(find "$FRAMES" -maxdepth 1 -name 'f_*.jpg' 2>/dev/null | wc -l | tr -d ' ')

# ------------------------------------------------------------------ meta
jq -n \
  --arg tag "$TAG" \
  --arg mode "$MODE" \
  --arg variant "$VARIANT" \
  --arg mp4 "$MP4" \
  --arg ffmpeg_log "$FFLOG" \
  --arg electron_log "$ELOG" \
  --argjson ffmpeg_start_ms "$FFMPEG_START_MS" \
  --argjson ffmpeg_end_ms "$FFMPEG_END_MS" \
  --argjson record_fps 60 \
  --argjson extract_fps 30 \
  --argjson frame_width 640 \
  --argjson frame_height 360 \
  --argjson screen_width "$SCREEN_W" \
  --argjson screen_height "$SCREEN_H" \
  --argjson frame_count "$FRAME_COUNT" \
  '{tag:$tag,mode:$mode,variant:$variant,mp4:$mp4,ffmpeg_log:$ffmpeg_log,electron_log:$electron_log,ffmpeg_start_ms:$ffmpeg_start_ms,ffmpeg_end_ms:$ffmpeg_end_ms,record_fps:$record_fps,extract_fps:$extract_fps,frame_width:$frame_width,frame_height:$frame_height,screen_width:$screen_width,screen_height:$screen_height,frame_count:$frame_count}' \
  > "$META"

# canonical cycle timings for the default GPU-on variant
if [ "$MODE" = "cycle" ] && [ "$VARIANT" = "gpu-on" ] && [ -f "$EVID/task-3-cycle-timestamps-gpu-on.json" ]; then
  cp "$EVID/task-3-cycle-timestamps-gpu-on.json" "$EVID/task-3-cycle-timestamps.json"
  ln -sf "task-3-cycle-gpu-on.mp4" "$EVID/task-3-transparency.mp4" 2>/dev/null || true
fi

TIMINGS=""
if [ "$MODE" = "cycle" ]; then
  TIMINGS="$EVID/task-3-cycle-timestamps-$VARIANT.json"
elif [ "$MODE" = "sizes" ]; then
  TIMINGS="$EVID/task-3-sizes-bounds.json"
fi

CHECK_ARGS=(
  --mode "$MODE"
  --tag "$TAG"
  --frames-dir "$FRAMES"
  --meta "$META"
  --info "$EVID/task-3-spike-info.json"
  --evidence-dir "$EVID"
  --out "$PIXELS"
)
if [ -n "$TIMINGS" ] && [ -f "$TIMINGS" ]; then
  CHECK_ARGS+=(--timings "$TIMINGS")
fi

"${PYTHON:-python3}" "$ROOT/tools/spike-check.py" "${CHECK_ARGS[@]}"
CHECK_RC=$?

echo "== captured $FRAME_COUNT frames -> $MP4"
echo "== pixels -> $PIXELS (checker exit=$CHECK_RC)"
exit 0
