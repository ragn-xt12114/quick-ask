#!/bin/sh
# QuickAsk user-data uninstaller.
#
# Scope: this script only removes QuickAsk's user-level data, configuration,
# logs/cache and XDG autostart entry. It never removes the checkout, build
# output, the release/ directory, or any system package files.
#
# Default mode is a dry run. Deletion requires --yes.
# Keyring entries are only touched when --purge-keyring AND --yes are both
# supplied.
#
# Usage:
#   scripts/uninstall-quickask.sh [--dry-run] [--yes] [--purge-keyring]
#   scripts/uninstall-quickask.sh --help
#
# Exit codes:
#   0  success (or dry run)
#   2  usage error
#   3  refused (app still running or unsafe target path)
#   4  one or more removals failed

set -u

APP_NAME='quickask'
YES=0
PURGE_KEYRING=0
FAILED=0

usage() {
  cat <<'EOF'
QuickAsk user-data uninstaller (POSIX sh)

Usage:
  scripts/uninstall-quickask.sh                 # dry run (default)
  scripts/uninstall-quickask.sh --yes           # delete data/config/logs/cache/autostart
  scripts/uninstall-quickask.sh --yes --purge-keyring
  scripts/uninstall-quickask.sh --help

What --yes removes (under your user account only):
  - $QUICKASK_DATA_DIR, or $XDG_DATA_HOME/quickask   (database, history, secrets.enc)
  - $XDG_CONFIG_HOME/quickask                        (config, Crashpad)
  - $XDG_STATE_HOME/quickask                         (logs)
  - $XDG_CACHE_HOME/quickask                         (Chromium cache)
  - $XDG_CONFIG_HOME/autostart/quickask.desktop      (app-created autostart)
  - $XDG_CONFIG_HOME/autostart/QuickAsk.desktop      (legacy name, if present)
  - $XDG_DATA_HOME/applications/quickask.desktop     (M1 user menu entry)
  - $XDG_DATA_HOME/icons/hicolor/512x512/apps/quickask.png (M1 user icon)

The .deb payload under /opt/QuickAsk is NOT removed by this script. Remove
the package itself with:  sudo dpkg -r quickask  (or: sudo apt remove quickask)

Keyring: --purge-keyring removes entries with service=quickask via
`secret-tool clear service quickask` when secret-tool is installed. Without it,
remove entries manually in KWallet/Seahorse (service quickask).

This script never uses sudo and never deletes files outside the paths listed
above. Run `npm run build` output and release/ artifacts are preserved.
EOF
}

say() {
  printf '%s\n' "$*"
}

die_usage() {
  printf 'uninstall-quickask: %s\n' "$*" >&2
  printf 'Run with --help for usage.\n' >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      YES=0
      ;;
    --yes|-y)
      YES=1
      ;;
    --purge-keyring)
      PURGE_KEYRING=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die_usage "unknown argument: $1"
      ;;
  esac
  shift
done

if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
fi
if [ -z "${HOME:-}" ] || [ "$HOME" = '/' ]; then
  printf 'uninstall-quickask: cannot determine a safe HOME; refusing.\n' >&2
  exit 3
fi
export HOME

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
SCRIPT_ROOT="$(dirname "$SCRIPT_DIR")"

XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"

if [ -n "${QUICKASK_DATA_DIR:-}" ]; then
  DATA_DIR="$QUICKASK_DATA_DIR"
  DATA_LABEL="data (QUICKASK_DATA_DIR)"
else
  DATA_DIR="$XDG_DATA_HOME/quickask"
  DATA_LABEL="data"
fi
CONFIG_DIR="$XDG_CONFIG_HOME/quickask"
STATE_DIR="$XDG_STATE_HOME/quickask"
CACHE_DIR="$XDG_CACHE_HOME/quickask"
AUTOSTART_DIR="$XDG_CONFIG_HOME/autostart"
AUTOSTART_FILE="$AUTOSTART_DIR/quickask.desktop"
AUTOSTART_LEGACY_FILE="$AUTOSTART_DIR/QuickAsk.desktop"
USER_MENU_FILE="$XDG_DATA_HOME/applications/quickask.desktop"
USER_ICON_FILE="$XDG_DATA_HOME/icons/hicolor/512x512/apps/quickask.png"

# Reject targets that are empty, relative, root, HOME, an ancestor of HOME,
# or contain a parent-directory component. Custom QUICKASK_DATA_DIR targets
# are allowed only when they are absolute and not HOME/root.
is_safe_target() {
  path="$1"
  [ -n "$path" ] || return 1
  case "$path" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$path" in
    /|.|..|*/..|*/../*|../*|..) return 1 ;;
  esac
  [ "$path" != "$HOME" ] || return 1
  # path must not be an ancestor of HOME (e.g. /home or /)
  case "$HOME/" in
    "$path"/*) return 1 ;;
  esac
  # never remove system paths or the checkout/build tree
  case "$path" in
    /opt/*|/usr/*|/etc/*|/var/*|/bin/*|/sbin/*|/boot/*|/dev/*|/proc/*|/sys/*|/run/*) return 1 ;;
    "$SCRIPT_ROOT"|"$SCRIPT_ROOT"/*) return 1 ;;
  esac
  return 0
}

is_safe_autostart_target() {
  path="$1"
  is_safe_target "$path" || return 1
  case "$path" in
    "$AUTOSTART_DIR/quickask.desktop"|"$AUTOSTART_DIR/QuickAsk.desktop") return 0 ;;
    *) return 1 ;;
  esac
}

app_running() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -x "$APP_NAME" >/dev/null 2>&1
  else
    return 1
  fi
}

remove_target() {
  label="$1"
  path="$2"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    say "  skip ($label): $path (not present)"
    return 0
  fi
  if [ "$YES" -eq 0 ]; then
    say "  would remove ($label): $path"
    return 0
  fi
  if ! is_safe_target "$path"; then
    printf 'uninstall-quickask: refusing unsafe path for %s: %s\n' "$label" "$path" >&2
    FAILED=1
    return 1
  fi
  if rm -rf -- "$path"; then
    say "  removed ($label): $path"
  else
    printf 'uninstall-quickask: failed to remove (%s): %s\n' "$label" "$path" >&2
    FAILED=1
  fi
}

remove_autostart() {
  path="$1"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    say "  skip (autostart): $path (not present)"
    return 0
  fi
  if [ "$YES" -eq 0 ]; then
    say "  would remove (autostart): $path"
    return 0
  fi
  if ! is_safe_autostart_target "$path"; then
    printf 'uninstall-quickask: refusing unsafe autostart path: %s\n' "$path" >&2
    FAILED=1
    return 1
  fi
  if rm -f -- "$path"; then
    say "  removed (autostart): $path"
  else
    printf 'uninstall-quickask: failed to remove autostart: %s\n' "$path" >&2
    FAILED=1
  fi
}

remove_app_file() {
  label="$1"
  path="$2"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    say "  skip ($label): $path (not present)"
    return 0
  fi
  if [ "$YES" -eq 0 ]; then
    say "  would remove ($label): $path"
    return 0
  fi
  if ! is_safe_target "$path"; then
    printf 'uninstall-quickask: refusing unsafe path for %s: %s\n' "$label" "$path" >&2
    FAILED=1
    return 1
  fi
  if rm -f -- "$path"; then
    say "  removed ($label): $path"
  else
    printf 'uninstall-quickask: failed to remove (%s): %s\n' "$label" "$path" >&2
    FAILED=1
  fi
}

purge_keyring() {
  if [ "$PURGE_KEYRING" -eq 0 ]; then
    return 0
  fi
  if [ "$YES" -eq 0 ]; then
    say "  would purge keyring entries: service=$APP_NAME (secret-tool / KWallet / Seahorse)"
    return 0
  fi
  if command -v secret-tool >/dev/null 2>&1; then
    say "  purging keyring entries: service=$APP_NAME"
    if secret-tool clear service "$APP_NAME" >/dev/null 2>&1; then
      say "  keyring purge: OK (service=$APP_NAME)"
    else
      say "  keyring purge: no matching entries, or Secret Service unavailable"
      say "  manual fallback: KWallet/Seahorse -> search service '$APP_NAME' -> delete"
    fi
  else
    say "  secret-tool not installed; keyring entries were NOT removed"
    say "  manual: KWallet (kwalletmanager) or Seahorse -> search service '$APP_NAME'"
  fi
}

if [ "$YES" -eq 0 ]; then
  say "QuickAsk uninstall (DRY RUN; nothing will be deleted)"
  say "  data path source: $DATA_LABEL"
else
  say "QuickAsk uninstall (DELETE MODE)"
  if app_running; then
    printf 'uninstall-quickask: QuickAsk is still running. Quit it from the tray first.\n' >&2
    printf 'uninstall-quickask: refusing to delete data while the app may hold the database.\n' >&2
    exit 3
  fi
fi

# Preflight every target before deleting anything. A bad QUICKASK_DATA_DIR or
# XDG override must abort the whole run, not leave a half-removed install.
if [ "$YES" -eq 1 ]; then
  for _target in "$DATA_DIR" "$CONFIG_DIR" "$STATE_DIR" "$CACHE_DIR"; do
    if ! is_safe_target "$_target"; then
      printf 'uninstall-quickask: refusing unsafe target path: %s\n' "$_target" >&2
      exit 3
    fi
  done
  for _target in "$AUTOSTART_FILE" "$AUTOSTART_LEGACY_FILE"; do
    if ! is_safe_autostart_target "$_target"; then
      printf 'uninstall-quickask: refusing unsafe autostart path: %s\n' "$_target" >&2
      exit 3
    fi
  done
  for _target in "$USER_MENU_FILE" "$USER_ICON_FILE"; do
    if ! is_safe_target "$_target"; then
      printf 'uninstall-quickask: refusing unsafe user app path: %s\n' "$_target" >&2
      exit 3
    fi
  done
fi

say "  HOME=$HOME"
remove_target "$DATA_LABEL" "$DATA_DIR"
remove_target "config" "$CONFIG_DIR"
remove_target "state/logs" "$STATE_DIR"
remove_target "cache" "$CACHE_DIR"
remove_autostart "$AUTOSTART_FILE"
remove_autostart "$AUTOSTART_LEGACY_FILE"
remove_app_file "menu item" "$USER_MENU_FILE"
remove_app_file "user icon" "$USER_ICON_FILE"
purge_keyring

if [ -d /opt/QuickAsk ]; then
  say "  note: /opt/QuickAsk exists (system package payload); remove with: sudo dpkg -r quickask"
fi

if [ "$YES" -eq 0 ]; then
  say "Dry run complete. Re-run with --yes to delete the paths above."
  [ "$PURGE_KEYRING" -eq 1 ] && say "Keyring purge is also gated on --yes."
  exit 0
fi

if [ "$FAILED" -ne 0 ]; then
  printf 'uninstall-quickask: completed with errors.\n' >&2
  exit 4
fi

say "Done. Source tree, build output and release/ artifacts were not touched."
exit 0
