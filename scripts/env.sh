# Source this file before any npm/electron command:
#   source scripts/env.sh
#
# Keeps $HOME unchanged (nvm needs it) and redirects every build/runtime
# download cache into the project-local .cache/ directory.
#
# Works when sourced from bash or zsh.

if [ -n "${ZSH_VERSION:-}" ]; then
  _quickask_src="${(%):-%x}"
elif [ -n "${BASH_SOURCE[0]:-}" ]; then
  _quickask_src="${BASH_SOURCE[0]}"
else
  _quickask_src="$0"
fi

if [ -n "$_quickask_src" ] && [ -f "$_quickask_src" ]; then
  PROJECT_ROOT="$(cd "$(dirname "$_quickask_src")/.." && pwd)"
else
  PROJECT_ROOT="$PWD"
fi
unset _quickask_src

export npm_config_cache="$PROJECT_ROOT/.cache/npm"
export ELECTRON_CACHE="$PROJECT_ROOT/.cache/electron"
export electron_config_cache="$PROJECT_ROOT/.cache/electron"
export ELECTRON_BUILDER_CACHE="$PROJECT_ROOT/.cache/electron-builder"
export XDG_CACHE_HOME="$PROJECT_ROOT/.cache/xdg"

# Never download Playwright browsers in this project.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Electron's @electron/get must honour HTTP_PROXY/HTTPS_PROXY.
export ELECTRON_GET_USE_PROXY=1

mkdir -p "$npm_config_cache" "$ELECTRON_CACHE" "$ELECTRON_BUILDER_CACHE" "$XDG_CACHE_HOME"
