#!/bin/sh
# Linux, macOS and WSL: identical setup contract to native Windows.
set -eu
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js 22+ with npm from https://nodejs.org, then retry.' >&2
  exit 1
fi
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$ROOT/scripts/setup.mjs" "$@"
