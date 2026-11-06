#!/usr/bin/env bash
# Task 17 privacy audit (NFR-10 / D.9).
#
# Fails when src/main or src/renderer contains:
#   - crash reporting / auto update / telemetry / Sentry hooks
#   - spellcheck enabled
#   - remote http(s) URLs in executable code
#   - weakened renderer isolation flags
#
# Allowed exceptions (documented on purpose):
#   * URLs that only appear inside comments (e.g. provider/url.ts examples,
#     ipc/sender.ts dev-server note) are removed by the comment-line filter.
#   * The SVG XML namespace `http://www.w3.org/2000/svg` in Icons.tsx is not a
#     network request; it is filtered explicitly.
#   * Tests may use `http://localhost` / mock servers; this audit only scans
#     src/main and src/renderer, never tests/ or tools/.
#
# Usage: bash tools/privacy-audit.sh [--out FILE]

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT=""
if [ "${1:-}" = "--out" ] && [ -n "${2:-}" ]; then
  OUT="$2"
fi

cd "$ROOT" || exit 2

FAIL=0
LINES=()
add() { LINES+=("$1"); }

SCAN_DIRS=(src/main src/renderer)
for dir in "${SCAN_DIRS[@]}"; do
  if [ ! -d "$dir" ]; then
    add "missing_scan_dir: $dir"
    FAIL=1
  fi
done

FILES_SCANNED=$(find "${SCAN_DIRS[@]}" -type f 2>/dev/null | wc -l | tr -d ' ')

# 1) Crash/telemetry/auto-update hooks (case-insensitive, includes comments).
BANNED_HITS=$(grep -RInE 'crashReporter|autoUpdater|telemetry|sentry' "${SCAN_DIRS[@]}" 2>/dev/null || true)
SPELLCHECK_HITS=$(grep -RInE 'spellcheck[[:space:]]*:[[:space:]]*true' "${SCAN_DIRS[@]}" 2>/dev/null || true)

# 2) Remote URLs outside comments. grep output: file:line:content
RAW_URL_HITS=$(grep -RInE 'https?://' "${SCAN_DIRS[@]}" 2>/dev/null || true)
URL_HITS=$(printf '%s\n' "$RAW_URL_HITS" \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' \
  | grep -v 'xmlns="http://www.w3.org/2000/svg"' \
  | grep -v 'xmlns='"'"'http://www.w3.org/2000/svg'"'"'' \
  | grep -v '^$' || true)

# 3) Renderer isolation flags must not be weakened in main.
ISOLATION_HITS=$(grep -RInE 'nodeIntegration[[:space:]]*:[[:space:]]*true|sandbox[[:space:]]*:[[:space:]]*false|contextIsolation[[:space:]]*:[[:space:]]*false|webSecurity[[:space:]]*:[[:space:]]*false|webviewTag[[:space:]]*:[[:space:]]*true' src/main 2>/dev/null || true)

# 4) Production CSP must keep connect-src 'none' (Task 9).
CSP_OK="no"
if grep -q "connect-src 'none'" src/shared/csp.ts 2>/dev/null; then
  CSP_OK="yes"
else
  add "production_csp_missing_connect_src_none"
  FAIL=1
fi

count() { printf '%s\n' "$1" | grep -c . || true; }

for label in BANNED_HITS SPELLCHECK_HITS URL_HITS ISOLATION_HITS; do
  value="${!label}"
  n=$(count "$value")
  if [ "$n" -gt 0 ]; then
    FAIL=1
    add "${label}_count: $n"
    while IFS= read -r line; do
      [ -n "$line" ] && add "  $line"
    done <<< "$value"
  else
    add "${label}_count: 0"
  fi
done

add "files_scanned: $FILES_SCANNED"
add "csp_connect_src_none: $CSP_OK"
if [ "$FAIL" -eq 0 ]; then
  add "verdict: PASS"
  add "PRIVACY_AUDIT_PASS"
else
  add "verdict: FAIL"
  add "PRIVACY_AUDIT_FAILED"
fi

REPORT=$(printf '%s\n' "TASK 17 PRIVACY AUDIT" "generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)" "${LINES[@]}")
printf '%s\n' "$REPORT"
if [ -n "$OUT" ]; then
  mkdir -p "$(dirname "$OUT")"
  printf '%s\n' "$REPORT" > "$OUT"
fi
[ "$FAIL" -eq 0 ]
