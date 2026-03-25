#!/usr/bin/env bash

set -eo pipefail # exit on error, error on any fail in pipe (not just last cmd); add -x to print each cmd; see gist bash_strict_mode.md

echo "══════════════════════════════════════════════════"
echo "  Free Games Claimer"
if [ -n "$COMMIT" ]; then
  echo "  Version: ${COMMIT}"
else
  LOCAL_COMMIT=$(git -C /fgc rev-parse --short HEAD 2>/dev/null || echo "unknown")
  echo "  Version: ${LOCAL_COMMIT}"
fi
echo "  Source:  https://github.com/vogler/free-games-claimer"
[ -n "$BRANCH" ] && [ "$BRANCH" != "main" ] && echo "  Branch:  ${BRANCH}"
if [ -n "$NOW" ]; then
  echo "  Build:   $NOW"
else
  echo "  Build:   $(date -u '+%Y-%m-%d %H:%M:%S UTC') (local)"
fi
echo "══════════════════════════════════════════════════"

BROWSER="${BROWSER_DIR:-data/browser}"

# Remove chromium profile lock.
# When running in docker and then killing it, on the next run chromium displayed a dialog to unlock the profile which made the script time out.
# Maybe due to changed hostname of container or due to how the docker container kills playwright - didn't check.
# https://bugs.chromium.org/p/chromium/issues/detail?id=367048
rm -f "/fgc/$BROWSER/SingletonLock"

# Remove X server display lock, fix for `docker compose up` which reuses container which made it fail after initial run, https://github.com/vogler/free-games-claimer/issues/31
# Maybe no longer needed after adding #478's -nolisten unix below
rm -f /tmp/.X1-lock

export DISPLAY=:1 # need to export this, otherwise playwright complains with 'Looks like you launched a headed browser without having a XServer running.'
if [ -z "$VNC_PASSWORD" ]; then
        pw="-SecurityTypes None"
        pwt="no password!"
else
        # pw="-passwd $VNC_PASSWORD" # not supported anymore
        pw="-rfbauth ~/.vnc/passwd"
        mkdir ~/.vnc/
        echo "$VNC_PASSWORD" | /opt/TurboVNC/bin/vncpasswd -f >~/.vnc/passwd
        pwt="with password"
fi
# TurboVNC server replaces Xvfb+x11vnc
# shellcheck disable=SC2086
/opt/TurboVNC/bin/vncserver $DISPLAY -geometry "${WIDTH}x${HEIGHT}" -depth "${DEPTH}" -rfbport "${VNC_PORT}" $pw -vgl -log /fgc/data/TurboVNC.log -xstartup /usr/bin/ratpoison 2>/dev/null # -noxstartup -novnc /usr/share/novnc/
websockify -D --web "/usr/share/novnc/" "$NOVNC_PORT" "localhost:$VNC_PORT" 2>/dev/null 1>&2 &
echo "  VNC:   port ${VNC_PORT} (${pwt}), ${WIDTH}x${HEIGHT}"
echo "  noVNC: http://localhost:${NOVNC_PORT}/?autoconnect=true"

if [ "$LOGIN_MODE" = "1" ]; then
  echo "LOGIN_MODE=1: Starting interactive login panel on port ${PANEL_PORT:-7080}..."
  exec tini -g -- node interactive-login.js
fi

if [ -n "$LOOP" ]; then
  echo "LOOP=${LOOP}: Will repeat every ${LOOP} seconds."
  while true; do
    tini -g -- "$@" || true
    echo "Sleeping for ${LOOP} seconds..."
    sleep "$LOOP"
  done
else
  exec tini -g -- "$@" # https://github.com/krallin/tini/issues/8 node/playwright respond to signals like ctrl-c, but unsure about zombie processes
fi
