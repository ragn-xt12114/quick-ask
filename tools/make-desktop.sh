#!/usr/bin/env bash
# Generate release/quickask.desktop from the build/quickask.desktop template.
#
# The template is the source of truth for the eventual system install
# (Exec=/opt/QuickAsk/quickask, matching the Task 8 deb layout).  The M1
# unpacked build lives in this checkout, so the generated copy gets an
# absolute Exec and Icon for the current path.
#
# Usage:
#   tools/make-desktop.sh [output.desktop]
#
# Default output: <repo>/release/quickask.desktop
#
# Re-run after moving the checkout or rebuilding release/linux-unpacked.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT/build/quickask.desktop"
BINARY="$ROOT/release/linux-unpacked/quickask"
ICON="$ROOT/build/icons/512x512.png"
OUT="${1:-$ROOT/release/quickask.desktop}"

[[ -f "$TEMPLATE" ]] || {
  echo "make-desktop: template not found: $TEMPLATE" >&2
  exit 2
}
[[ -x "$BINARY" ]] || {
  echo "make-desktop: unpacked binary not found or not executable: $BINARY" >&2
  echo "make-desktop: run 'npm run build && npm run dist:dir' first" >&2
  exit 2
}

# desktop-entry Exec quoting: only quote when the path contains whitespace.
exec_arg() {
  local value="$1"
  if [[ "$value" =~ [[:space:]] ]]; then
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    value="${value//\`/\\\`}"
    value="${value//\$/\\\$}"
    printf '"%s"' "$value"
  else
    printf '%s' "$value"
  fi
}

ICON_VALUE="quickask"
if [[ -f "$ICON" ]]; then
  ICON_VALUE="$(exec_arg "$ICON")"
fi
EXEC_VALUE="$(exec_arg "$BINARY") %U"

mkdir -p "$(dirname "$OUT")"
awk -v exec="$EXEC_VALUE" -v icon="$ICON_VALUE" '
  BEGIN { saw_exec = 0; saw_icon = 0 }
  /^Exec=/ { print "Exec=" exec; saw_exec = 1; next }
  /^Icon=/ { print "Icon=" icon; saw_icon = 1; next }
  { print }
  END {
    if (!saw_exec) print "Exec=" exec
    if (!saw_icon) print "Icon=" icon
  }
' "$TEMPLATE" > "$OUT"
chmod 0644 "$OUT"

echo "wrote $OUT"
echo "Exec=$EXEC_VALUE"
echo "Icon=$ICON_VALUE"

if command -v desktop-file-validate >/dev/null 2>&1; then
  if desktop-file-validate "$OUT"; then
    echo "desktop-file-validate: OK"
  else
    echo "desktop-file-validate: FAILED" >&2
    exit 1
  fi
else
  echo "desktop-file-validate: not installed (skipped)" >&2
fi
