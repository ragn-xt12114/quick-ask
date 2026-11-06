#!/usr/bin/env bash
# Task 6 / G8 — run the Secret Service + safeStorage spike and produce evidence.
#
# The opencode shell often lacks the Plasma desktop variables (XDG_CURRENT_DESKTOP
# etc.), which makes Electron safeStorage fall back to basic_text.  We read the
# live plasmashell environment (read-only /proc) and use those exact values for
# the production-representative run.  We also record the bare-shell default.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source scripts/env.sh
export DISPLAY="${DISPLAY:-:0}"

EVID="$ROOT/.omo/evidence"
PY="${PYTHON:-python3}"
ELECTRON="$ROOT/node_modules/.bin/electron"
NODE_BIN="$(command -v node)"
APP="$ROOT/spike/keyring.cjs"
OUT_JSON="$EVID/task-6-keyring.json"
APP_LOG="$EVID/task-6-keyring.log"
UNAVAILABLE_LOG="$EVID/task-6-keyring-unavailable.log"
BARE_LOG="$EVID/task-6-safe-storage-default-bare.log"
ACTUAL_SAFE_LOG="$EVID/task-6-safe-storage-actual-env.log"
SESSION_ENV="$EVID/task-6-keyring-session-env.txt"
GREP_TXT="$EVID/task-6-grep.txt"
DRIVER_LOG="$EVID/task-6-keyring-driver.log"

mkdir -p "$EVID"

log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$DRIVER_LOG" >&2; }
die() { log "FAIL: $*"; exit 1; }

[[ -x "$ELECTRON" ]] || die "missing Electron binary"
[[ -f "$APP" ]] || die "missing $APP"
[[ -x "$NODE_BIN" ]] || die "missing system node"

if pgrep -f "[s]pike/keyring.cjs" >/dev/null 2>&1; then
  die "a previous keyring spike is still running"
fi

# Read the real Plasma session environment without changing it.
PS_PID="$(pgrep -x plasmashell | head -1 || true)"
[[ -n "$PS_PID" ]] || die "plasmashell not running; cannot read session env"
tr '\0' '\n' < "/proc/$PS_PID/environ" > "$SESSION_ENV"
XDG_CURRENT_DESKTOP="$(sed -n 's/^XDG_CURRENT_DESKTOP=//p' "$SESSION_ENV" | head -1)"
DESKTOP_SESSION="$(sed -n 's/^DESKTOP_SESSION=//p' "$SESSION_ENV" | head -1)"
KDE_FULL_SESSION="$(sed -n 's/^KDE_FULL_SESSION=//p' "$SESSION_ENV" | head -1)"
KDE_SESSION_VERSION="$(sed -n 's/^KDE_SESSION_VERSION=//p' "$SESSION_ENV" | head -1)"
log "session env: XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-?} DESKTOP_SESSION=${DESKTOP_SESSION:-?} KDE_FULL_SESSION=${KDE_FULL_SESSION:-?} KDE_SESSION_VERSION=${KDE_SESSION_VERSION:-?}"
[[ "$XDG_CURRENT_DESKTOP" == "KDE" ]] || log "WARNING: live session XDG_CURRENT_DESKTOP is not KDE"

# Secret Service owner (read-only DBus query).
{
  echo "# Task 6 / G8 — keyring environment"
  echo "# generated: $(date -Is)"
  echo "# plasmashell pid: $PS_PID"
  echo
  echo "## live Plasma session env"
  grep -E '^(XDG_CURRENT_DESKTOP|DESKTOP_SESSION|KDE_FULL_SESSION|KDE_SESSION_VERSION|DISPLAY|DBUS_SESSION_BUS_ADDRESS)=' "$SESSION_ENV" || true
  echo
  echo "## org.freedesktop.secrets"
  echo "\$ qdbus6 org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets"
  qdbus6 org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets 2>&1 || true
  echo "\$ qdbus6 org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.GetNameOwner org.freedesktop.secrets"
  qdbus6 org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.GetNameOwner org.freedesktop.secrets 2>&1 || true
  echo
  echo "## keyring module"
  echo "\$ node -e \"console.log(require.resolve('@napi-rs/keyring'))\""
  "$NODE_BIN" -e "console.log(require.resolve('@napi-rs/keyring'))" 2>&1 || true
  echo "\$ node -p \"require('@napi-rs/keyring/package.json').version\""
  "$NODE_BIN" -p "require('@napi-rs/keyring/package.json').version" 2>&1 || true
} > "$EVID/task-6-keyring-env.txt"

# Bare-shell safeStorage probe: intentionally without desktop vars.  This
# records the basic_text fallback rather than hiding it.
log "bare-shell safeStorage probe"
rm -f "$BARE_LOG"
env -u XDG_CURRENT_DESKTOP -u DESKTOP_SESSION -u KDE_FULL_SESSION -u KDE_SESSION_VERSION \
  "$ELECTRON" "$APP" --safe-storage-only > "$BARE_LOG" 2>&1 || true
log "bare backend: $(grep -E 'SAFE_STORAGE_BACKEND=' "$BARE_LOG" | tail -1 || true)"

# Actual Plasma-session safeStorage probe.
log "actual-session safeStorage probe"
rm -f "$ACTUAL_SAFE_LOG"
XDG_CURRENT_DESKTOP="$XDG_CURRENT_DESKTOP" \
DESKTOP_SESSION="$DESKTOP_SESSION" \
KDE_FULL_SESSION="$KDE_FULL_SESSION" \
KDE_SESSION_VERSION="$KDE_SESSION_VERSION" \
  "$ELECTRON" "$APP" --safe-storage-only > "$ACTUAL_SAFE_LOG" 2>&1 || true
log "actual backend: $(grep -E 'SAFE_STORAGE_BACKEND=' "$ACTUAL_SAFE_LOG" | tail -1 || true)"

# Main G8 run under the real Plasma session env.
log "main keyring run"
rm -f "$OUT_JSON" "$UNAVAILABLE_LOG"
set +e
XDG_CURRENT_DESKTOP="$XDG_CURRENT_DESKTOP" \
DESKTOP_SESSION="$DESKTOP_SESSION" \
KDE_FULL_SESSION="$KDE_FULL_SESSION" \
KDE_SESSION_VERSION="$KDE_SESSION_VERSION" \
QUICKASK_NODE_BIN="$NODE_BIN" \
  "$ELECTRON" "$APP" > "$APP_LOG" 2>&1
APP_RC=$?
set -e
log "main keyring exit=$APP_RC"
[[ -s "$OUT_JSON" ]] || die "keyring spike did not write $OUT_JSON; see $APP_LOG"
"$PY" -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$OUT_JSON" || die "invalid JSON: $OUT_JSON"

# Ensure no keyring app is left behind.
for pid in $(pgrep -f "[s]keyring.cjs" 2>/dev/null || true); do
  log "killing leftover keyring pid=$pid"
  kill -TERM "$pid" 2>/dev/null || true
done

FP="$("$PY" - "$OUT_JSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
print(d.get('secret_fingerprint') or '')
PY
)"
[[ -n "$FP" ]] || die "secret_fingerprint missing from $OUT_JSON"

# Grep evidence.  The fingerprint is safe to search; the full secret is never
# printed or passed to grep.  The full-secret scan was done in-memory by the
# Electron process (see no_plaintext_scan in the JSON).
{
  echo "# Task 6 / G8 — no-plaintext check"
  echo "# generated: $(date -Is)"
  echo
  echo "## 1) grep for the non-secret fingerprint only (never the secret)"
  echo "\$ grep -rnF '$FP' package.json scripts docs spike tools .omo/evidence \\"
  echo "    --include='*.json' --include='*.log' --include='*.txt' --include='*.md' \\"
  echo "    --exclude-dir=node_modules --exclude-dir=.cache --exclude-dir=out \\"
  echo "    --exclude-dir=test-results --exclude-dir='frames-*'"
  grep -rnF "$FP" package.json scripts docs spike tools .omo/evidence \
    --include='*.json' --include='*.log' --include='*.txt' --include='*.md' \
    --exclude-dir=node_modules --exclude-dir=.cache --exclude-dir=out \
    --exclude-dir=test-results --exclude-dir='frames-*' 2>/dev/null |
    sed 's/^/MATCH: /' || echo "NO_FINGERPRINT_MATCHES"
  echo
  echo "## 2) full-secret in-memory scan (secret never printed)"
  "$PY" - "$OUT_JSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
scan = d.get('no_plaintext_scan') or {}
print(f"files_scanned={scan.get('files_scanned')}")
print(f"hits={scan.get('hits')}")
print(f"no_plaintext={d.get('no_plaintext')}")
print(f"entry_holds_secret={(d.get('roundtrip') or {}).get('entry_holds_secret')}")
PY
  echo
  echo "## 3) result"
  "$PY" - "$OUT_JSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
ok = bool(d.get('no_plaintext')) and bool((d.get('roundtrip') or {}).get('entry_holds_secret'))
print('NO_PLAINTEXT_FOUND' if ok else 'PLAINTEXT_RISK_DETECTED')
PY
} > "$GREP_TXT"

# Final summary.
log "keyring status: $("$PY" - "$OUT_JSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
print(d.get('status'), d.get('summary'))
PY
)"
log "wrote $OUT_JSON, $GREP_TXT, $UNAVAILABLE_LOG"
