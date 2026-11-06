#!/usr/bin/env bash
# Build the native QuickAsk helpers.
# Run via: npm run build:native
set -euo pipefail

cd "$(dirname "$0")/.."

case "$(uname -s)" in
  Linux) ;;
  *)
    echo "[build:native] skipped on $(uname -s): the X11 helper is Linux-only"
    exit 0
    ;;
esac

mkdir -p native .omo/evidence

set -x
gcc -O2 -Wall -Wextra -Werror -o native/quickask-x11 native/quickask-x11.c -lX11 -lXext
gcc -O2 -Wall -Wextra -Werror -o .omo/evidence/x11-grab-test tools/x11-grab-test.c -lX11
set +x
