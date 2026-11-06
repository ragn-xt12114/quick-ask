#!/usr/bin/env bash
# Task 17 plaintext-secret audit.
#
# Scans SQLite files (binary-safe), config dirs, log dirs and provider profile
# JSON for:
#   - `sk-` API-key prefixes
#   - `Authorization` / `Bearer` literals
#   - SHA-256 fingerprints supplied with --fingerprints
#
# Output lists only <file> + <pattern-label>, never the matching line, so a
# failure cannot itself leak the secret.
#
# Usage:
#   bash tools/grep-key.sh [--data-dir DIR] [--config-dir DIR] [--log-dir DIR]
#                          [--root DIR ...] [--fingerprints FILE] [--out FILE]
#
# Defaults (when no explicit dir is given): XDG data/config/state app dirs.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

DATA_DIR="${QUICKASK_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/quickask}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/quickask"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/quickask/logs"

EXPLICIT=0
DATA_SET=0
CONFIG_SET=0
LOG_SET=0
ROOTS=()
FINGERPRINTS_FILE=""
OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir)
      DATA_DIR="${2:-}"; DATA_SET=1; EXPLICIT=1; shift 2 ;;
    --config-dir)
      CONFIG_DIR="${2:-}"; CONFIG_SET=1; EXPLICIT=1; shift 2 ;;
    --log-dir)
      LOG_DIR="${2:-}"; LOG_SET=1; EXPLICIT=1; shift 2 ;;
    --root)
      ROOTS+=("${2:-}"); EXPLICIT=1; shift 2 ;;
    --fingerprints)
      FINGERPRINTS_FILE="${2:-}"; shift 2 ;;
    --out)
      OUT="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '1,40p' "$0"; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$EXPLICIT" -eq 0 ]; then
  ROOTS+=("$DATA_DIR" "$CONFIG_DIR" "$LOG_DIR")
else
  [ "$DATA_SET" -eq 1 ] && ROOTS+=("$DATA_DIR")
  [ "$CONFIG_SET" -eq 1 ] && ROOTS+=("$CONFIG_DIR")
  [ "$LOG_SET" -eq 1 ] && ROOTS+=("$LOG_DIR")
fi

PATTERN_LABELS=("sk-" "Authorization" "Bearer")
PATTERNS=("sk-" "Authorization" "Bearer")

if [ -n "$FINGERPRINTS_FILE" ] && [ -f "$FINGERPRINTS_FILE" ]; then
  while IFS= read -r line; do
    line="$(printf '%s' "$line" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    case "$line" in
      ''|'#'*) continue ;;
    esac
    value="${line#sha256:}"
    if [ "${#value}" -ge 16 ]; then
      PATTERN_LABELS+=("fingerprint:${value:0:12}...")
      PATTERNS+=("$value")
    fi
  done < "$FINGERPRINTS_FILE"
fi

FILES=()
for root in "${ROOTS[@]}"; do
  [ -n "$root" ] || continue
  if [ ! -d "$root" ]; then
    continue
  fi
  while IFS= read -r -d '' file; do
    FILES+=("$file")
  done < <(find "$root" -type f -size -100M -print0 2>/dev/null)
done

HITS=()
for file in "${FILES[@]}"; do
  index=0
  while [ "$index" -lt "${#PATTERNS[@]}" ]; do
    pattern="${PATTERNS[$index]}"
    label="${PATTERN_LABELS[$index]}"
    if grep -a -q -F -- "$pattern" "$file" 2>/dev/null; then
      HITS+=("$(printf '%s' "${file#"$ROOT"/}"): ${label}")
    fi
    index=$((index + 1))
  done
done

LINES=()
LINES+=("TASK 17 GREP-KEY AUDIT")
LINES+=("generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)")
LINES+=("roots: ${ROOTS[*]:-none}")
LINES+=("files_scanned: ${#FILES[@]}")
LINES+=("patterns: sk-, Authorization, Bearer${FINGERPRINTS_FILE:+, fingerprints}")
LINES+=("fingerprints_file: ${FINGERPRINTS_FILE:-none}")
LINES+=("hits: ${#HITS[@]}")
for hit in "${HITS[@]}"; do
  LINES+=("  $hit")
done
if [ "${#HITS[@]}" -eq 0 ]; then
  LINES+=("NO_PLAINTEXT_FOUND")
else
  LINES+=("PLAINTEXT_FOUND")
fi

REPORT=$(printf '%s\n' "${LINES[@]}")
printf '%s\n' "$REPORT"
if [ -n "$OUT" ]; then
  mkdir -p "$(dirname "$OUT")"
  printf '%s\n' "$REPORT" > "$OUT"
fi
[ "${#HITS[@]}" -eq 0 ]
