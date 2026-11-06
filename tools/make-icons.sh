#!/usr/bin/env bash
# Reusable local icon generator (no CDN / no network).
#
# Default mode (no arguments) produces both sets, idempotently:
#   assets/tray-spike-512.png, assets/tray-spike-32.png   (Task 6 spike)
#   assets/tray-32.png                                    (production tray icon)
#   build/icons/<size>.png                                (electron-builder icons)
#
# Custom mode (same CLI as before):
#   tools/make-icons.sh [source.svg] [out-dir] [basename]
# with ICON_SIZES="22 24 48" to override the 512/32 default.
set -euo pipefail

command -v rsvg-convert >/dev/null 2>&1 || {
  echo "make-icons: rsvg-convert not found on PATH" >&2
  exit 2
}

render() {
  local src="$1" out="$2" size="$3"
  mkdir -p "$(dirname "$out")"
  [[ -f "$src" ]] || { echo "make-icons: source not found: $src" >&2; exit 2; }
  rsvg-convert -w "$size" -h "$size" -o "$out" "$src"
  printf 'wrote %s (%s bytes)\n' "$out" "$(stat -c %s "$out")"
}

if [[ $# -eq 0 ]]; then
  # Task 6 spike outputs stay byte-compatible with the original script.
  for size in 512 32; do
    render assets/tray-spike.svg "assets/tray-spike-${size}.png" "$size"
  done

  # Task 13 production tray icon + electron-builder icon set (local only).
  render assets/icon.svg assets/tray-32.png 32
  for size in 16 24 32 48 64 128 256 512; do
    render assets/icon.svg "build/icons/${size}x${size}.png" "$size"
  done
  exit 0
fi

SRC="${1:-assets/tray-spike.svg}"
OUTDIR="${2:-assets}"
BASENAME="${3:-$(basename "$SRC" .svg)}"
SIZES="${ICON_SIZES:-512 32}"

for size in $SIZES; do
  render "$SRC" "$OUTDIR/${BASENAME}-${size}.png" "$size"
done
