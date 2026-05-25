#!/usr/bin/env bash

set -eo pipefail # exit on error, error on any fail in pipe (not just last cmd); add -x to print each cmd; see gist bash_strict_mode.md

# X11 socket dir reset — must run while we're root (we may gosu-drop
# below to a different PUID). Stale ownership in /tmp/.X11-unix from a
# prior container run (different PUID across restarts, podman userns
# mapping, or a previously-root-now-non-root flip) trips TurboVNC's
# _XSERVTransmkdir — the first Xvnc instance hangs ~2 minutes trying
# to recreate the dir with root ownership, gets killed by the watchdog,
# and a second Xvnc finally starts. Anything spawned in the panel
# during that 2-min window fails with "no X server" / "Target page,
# context or browser has been closed". Reported as #41 (Sahibishere,
# podman/Fedora) and #51 (WaBiiZ, diagnostics).
# Guard on root because the re-exec'd, non-root second pass of this
# script can't (and shouldn't) reset /tmp ownership.
if [ "$(id -u)" = "0" ]; then
  rm -rf /tmp/.X11-unix
  mkdir -p /tmp/.X11-unix
  chmod 1777 /tmp/.X11-unix
fi

# --- Optional non-root mode (opt-in via PUID/PGID) ----------------------
# When PUID is set and we're currently root, reconcile a runtime user `fgc`
# with the requested UID/GID, fix ownership of writable paths, then re-exec
# self as that user via gosu. Subsequent execution skips this block (id -u
# is no longer 0). When PUID is unset, this block is skipped entirely and
# the container runs as root exactly like prior releases — no behavior
# change for existing deploys until they opt in by setting PUID.
if [ "$(id -u)" = "0" ] && [ -n "$PUID" ]; then
  PGID="${PGID:-$PUID}"
  # Reconcile group + user. -o allows non-unique IDs which keeps things
  # simple if PUID/PGID collide with existing system accounts.
  if getent group fgc >/dev/null; then
    groupmod -o -g "$PGID" fgc
  else
    groupadd -o -g "$PGID" fgc
  fi
  if id fgc >/dev/null 2>&1; then
    usermod -o -u "$PUID" -g "$PGID" fgc >/dev/null
  else
    useradd -o -u "$PUID" -g "$PGID" -s /bin/bash -m -d /home/fgc fgc
  fi
  # Stale X11 / VNC files from a previous run may be owned by a different
  # UID — clean them while we still have root.
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
  rm -rf /home/fgc/.vnc/*.pid /home/fgc/.vnc/*.log 2>/dev/null || true
  # Make sure paths the runtime user needs to write are owned by them.
  mkdir -p /fgc/data /home/fgc/.vnc /home/fgc/.cache
  chown -R "$PUID:$PGID" /fgc/data /home/fgc
  # The browser cache is read-only at runtime (binaries only), but make
  # sure the runtime user can traverse and read it. The Dockerfile already
  # chmod a+rX'd it; this is belt-and-braces.
  if [ -d "${PLAYWRIGHT_BROWSERS_PATH:-/usr/local/share/ms-playwright}" ]; then
    chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH:-/usr/local/share/ms-playwright}" 2>/dev/null || true
  fi
  echo "  Running as: fgc (uid=$PUID gid=$PGID) — non-root mode"
  exec gosu fgc "$0" "$@"
fi
# -----------------------------------------------------------------------

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
rm -f "/fgc/${BROWSER}-mobile/SingletonLock"

# Clean up stale display/VNC files from previous runs.
# Fixes container failing to start after stop/start (without recreate) on Unraid and similar platforms.
rm -f /tmp/.X1-lock
rm -f /tmp/.X11-unix/X1
rm -f ~/.vnc/*:1.pid
/opt/TurboVNC/bin/vncserver -kill :1 2>/dev/null || true

export DISPLAY=:1 # need to export this, otherwise playwright complains with 'Looks like you launched a headed browser without having a XServer running.'
if [ -z "$VNC_PASSWORD" ]; then
        pw="-SecurityTypes None"
        pwt="no password!"
else
        # pw="-passwd $VNC_PASSWORD" # not supported anymore
        pw="-rfbauth ~/.vnc/passwd"
        mkdir -p ~/.vnc/
        echo "$VNC_PASSWORD" | /opt/TurboVNC/bin/vncpasswd -f >~/.vnc/passwd
        pwt="with password"
fi
# TurboVNC server replaces Xvfb+x11vnc
# shellcheck disable=SC2086
/opt/TurboVNC/bin/vncserver $DISPLAY -geometry "${WIDTH}x${HEIGHT}" -depth "${DEPTH}" -rfbport "${VNC_PORT}" $pw -vgl -log /fgc/data/TurboVNC.log -xstartup /usr/bin/ratpoison 2>/dev/null # -noxstartup -novnc /usr/share/novnc/
websockify -D --web "/usr/share/novnc/" "$NOVNC_PORT" "localhost:$VNC_PORT" 2>/dev/null 1>&2 &
echo "  VNC:   port ${VNC_PORT} (${pwt}), ${WIDTH}x${HEIGHT}"
echo "  noVNC: http://localhost:${NOVNC_PORT}/?autoconnect=true"

# Wait for X server to actually answer connections before starting the
# panel. Previously polled only for the socket file at /tmp/.X11-unix/X1,
# which TurboVNC writes early in init — passes our wait before X is
# actually serving requests. Sahibishere reported (issue #41 follow-up
# on 2.7.6) that the error still happens 30 min after boot, suggesting
# the boot-time socket-passes-but-X-not-ready race wasn't the only thing
# going on. Switched to xdpyinfo which makes a real X11 protocol
# connection — only succeeds when X is genuinely ready. Issues #40 +
# #41 — 2026-05-16 / 2026-05-18.
echo "  Waiting for X server on $DISPLAY..."
X_READY=0
# Prefer xdpyinfo (actual X11 protocol probe — only succeeds when X
# answers). Falls back to socket-file polling when xdpyinfo isn't in
# the image (graceful upgrade path — earlier images shipped without
# x11-utils; users will get xdpyinfo on next pull).
if command -v xdpyinfo >/dev/null 2>&1; then
  for i in $(seq 1 60); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
      X_READY=1
      echo "  X server ready on $DISPLAY (xdpyinfo probe succeeded after ${i} tries)."
      break
    fi
    sleep 0.5
  done
else
  echo "  (xdpyinfo not installed in this image — falling back to socket-file check; pull the latest image for a proper probe)"
  for i in $(seq 1 60); do
    [ -S /tmp/.X11-unix/X1 ] && { X_READY=1; echo "  X11 socket appeared on $DISPLAY (after ${i} probes — note: socket can appear before X answers; xdpyinfo would be more reliable)."; break; }
    sleep 0.5
  done
fi
if [ "$X_READY" = "0" ]; then
  echo "  WARN: X server on $DISPLAY didn't become ready within 30s — panel will start anyway, but claim scripts will fail with 'Missing X server' until X comes up. Common causes: stale /tmp/.X1-lock, PUID mismatch on /home/fgc/.vnc/, insufficient /dev/shm in the container (try --shm-size=512m), or vncserver crashed."
  echo "  --- last 30 lines of /fgc/data/TurboVNC.log ---"
  tail -30 /fgc/data/TurboVNC.log 2>/dev/null || echo "  (log file not present)"
  echo "  --- end TurboVNC.log ---"
fi

# The panel process owns claim scheduling, session-lock coordination, and the
# HTTP/noVNC surface. It reads LOOP / MS_SCHEDULE_HOURS / MS_SCHEDULE_START / CLAIM_CMD
# and runs the claim scripts internally. LOGIN_MODE is a deprecated no-op — the
# panel is always available now.
if [ "$LOGIN_MODE" = "1" ]; then
  echo "  (LOGIN_MODE=1 is deprecated — panel is always running; you can remove this env var)"
fi
exec tini -s -g -- node interactive-login.js
