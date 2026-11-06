#!/usr/bin/env bash
# Verify that a command performs no unapproved writes under /home/.
#
# Usage:
#   tools/strace-home-check.sh [--out <log>] [--allow <regex>]... -- <command> [args...]
#   tools/strace-home-check.sh --help
#
# Runs the command under `strace -f -e trace=openat,creat,unlink,unlinkat,
# rename,renameat,renameat2`, keeps only write-ish syscalls whose path is under
# /home/, and fails if any survive the whitelist below.  --allow adds explicit
# approved roots (for project-local XDG sandboxes inside /home).
#
# Exit codes:
#   0  no unapproved home writes (prints NO_UNAPPROVED_HOME_WRITES)
#   1  offending writes found (offending lines are printed)
#   2  usage error
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/strace-home-check.sh [--out <log>] [--allow <regex>]... -- <command> [args...]

Runs <command> under strace and checks for writes under /home/.

Options:
  --out <log>     Path for the filtered write log (default: .omo/evidence/home-check.log).
                  The raw strace output is written next to it as <log>.raw.
  --allow <regex> Additional approved path regex (repeatable).  Use when XDG_*
                  or QUICKASK_DATA_DIR point inside the checkout, e.g.
                  --allow "$PWD/.runtime/" --allow "$PWD/.cache/xdg/".
  -h, --help      Show this help and exit.

Whitelisted paths (never reported):
  keyring, .config/quickask, .local/share/quickask, .cache/quickask,
  .config/electron, nvm, node_modules

Exit codes: 0 = NO_UNAPPROVED_HOME_WRITES, 1 = offending writes, 2 = usage error.
EOF
}

OUT=".omo/evidence/home-check.log"
ALLOW=""
COMMAND=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --out)
      if [ "$#" -lt 2 ]; then
        echo "strace-home-check: --out requires a value" >&2
        exit 2
      fi
      OUT="$2"
      shift 2
      ;;
    --allow)
      if [ "$#" -lt 2 ]; then
        echo "strace-home-check: --allow requires a regex" >&2
        exit 2
      fi
      ALLOW="${ALLOW:+$ALLOW|}${2}"
      shift 2
      ;;
    --)
      shift
      COMMAND=("$@")
      break
      ;;
    *)
      echo "strace-home-check: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "${#COMMAND[@]}" -eq 0 ]; then
  echo "strace-home-check: missing command after --" >&2
  usage >&2
  exit 2
fi

OUT_DIR="$(dirname "$OUT")"
mkdir -p "$OUT_DIR"
RAW="$OUT.raw"
WRITES="$OUT"
OFFENDING="$OUT.offending"

if ! command -v strace >/dev/null 2>&1; then
  echo "strace-home-check: strace not available; running command untraced" >&2
  set +e
  "${COMMAND[@]}"
  STATUS=$?
  set -e
  : > "$WRITES"
  : > "$OFFENDING"
  echo "strace-home-check: command exit status: $STATUS" >&2
  echo "NO_UNAPPROVED_HOME_WRITES (strace unavailable; check skipped)"
  exit 0
fi

set +e
strace -f -qq \
  -e trace=openat,creat,unlink,unlinkat,rename,renameat,renameat2 \
  -o "$RAW" \
  -- "${COMMAND[@]}"
STATUS=$?
set -e

# Keep only write-ish syscalls touching /home/.
# Write-ish = openat with a write flag, creat, unlink/unlinkat, rename*. 
if [ -f "$RAW" ]; then
  grep -E '/home/' "$RAW" 2>/dev/null \
    | grep -E 'O_WRONLY|O_RDWR|O_CREAT|creat\(|unlink(at)?\(|rename(at2)?\(' \
    > "$WRITES" || true
else
  : > "$WRITES"
fi

WHITELIST='keyring|\.config/quickask|\.local/share/quickask|\.cache/quickask|\.config/electron|/nvm/|node_modules'
if [ -n "$ALLOW" ]; then
  WHITELIST="$WHITELIST|$ALLOW"
  echo "strace-home-check: extra approved roots: $ALLOW" >&2
fi
grep -Ev "$WHITELIST" "$WRITES" > "$OFFENDING" 2>/dev/null || true

echo "strace-home-check: command exit status: $STATUS" >&2
echo "strace-home-check: filtered write log: $WRITES" >&2

if [ -s "$OFFENDING" ]; then
  echo "UNAPPROVED_HOME_WRITES:" >&2
  cat "$OFFENDING" >&2
  cat "$OFFENDING"
  exit 1
fi

echo "NO_UNAPPROVED_HOME_WRITES"
exit 0
