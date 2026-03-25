#!/usr/bin/env bash
set -eo pipefail

LIBGBM_PATH=$(ls -d /nix/store/*mesa*libgbm*/lib 2>/dev/null | head -1)
if [ -n "$LIBGBM_PATH" ]; then
  export LD_LIBRARY_PATH="${LIBGBM_PATH}:${REPLIT_LD_LIBRARY_PATH}:${LD_LIBRARY_PATH}"
else
  export LD_LIBRARY_PATH="${REPLIT_LD_LIBRARY_PATH}:${LD_LIBRARY_PATH}"
fi

exec node "$@"
