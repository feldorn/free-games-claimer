# Partially from https://github.com/microsoft/playwright/blob/main/utils/docker/Dockerfile.noble
# Ubuntu 24.04 LTS (Noble Numbat)
FROM ubuntu:noble

# Configuration variables are at the end!

# https://github.com/hadolint/hadolint/wiki/DL4006
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG DEBIAN_FRONTEND=noninteractive

# Install nodejs and deps for virtual display, noVNC, chromium, and pip for installing apprise.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && mkdir -p /etc/apt/keyrings \
    # Node.js
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    # TurboVNC & VirtualGL instead of Xvfb+X11vnc
    && curl --proto "=https" --tlsv1.2 -fsSL https://packagecloud.io/dcommander/virtualgl/gpgkey | gpg --dearmor -o /etc/apt/trusted.gpg.d/VirtualGL.gpg \
    && curl --proto "=https" --tlsv1.2 -fsSL  https://packagecloud.io/dcommander/turbovnc/gpgkey | gpg --dearmor -o /etc/apt/trusted.gpg.d/TurboVNC.gpg \
    && curl --proto "=https" --tlsv1.2 -fsSL https://raw.githubusercontent.com/VirtualGL/repo/main/VirtualGL.list > /etc/apt/sources.list.d/VirtualGL.list \
    && curl --proto "=https" --tlsv1.2 -fsSL https://raw.githubusercontent.com/TurboVNC/repo/main/TurboVNC.list > /etc/apt/sources.list.d/TurboVNC.list \
    # update lists and install
    && apt-get update \
    && apt-get install --no-install-recommends -y \
      virtualgl turbovnc ratpoison \
      novnc websockify \
      tini \
      nodejs \
      dos2unix \
      # gosu enables clean privilege-drop in docker-entrypoint.sh when
      # PUID/PGID are set (opt-in non-root mode). When those are unset, gosu
      # is unused and the container runs as root exactly like before.
      gosu \
      # apprise is installed below via `pip install --break-system-packages`
      # rather than apt's apprise package (1.7.2 vs upstream 1.9.3) or pipx
      # (overkill for a single package, and needs $PATH tweaking).
      pip \
    # RUN npx patchright install-deps chromium
    # ^ installing deps manually instead saved ~130MB:
    && apt-get install -y --no-install-recommends \
      libnss3 \
      libnspr4 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libxkbcommon0 \
      libatspi2.0-0 \
      libxcomposite1 \
      libgbm1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2t64 \
      libxfixes3 \
      libxdamage1 \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf \
      /var/lib/apt/lists/* \
      /var/cache/* \
      /var/tmp/* \
      /tmp/* \
      /usr/share/doc/* \
    # Ubuntu Noble's novnc 1.3.0-2 ships index.html as a symlink to
    # vnc_auto.html, whose JS chain imports `dragThreshold` from
    # core/util/browser.js — a symbol this build doesn't export, so visiting
    # http://localhost:6080/ blew up with a SyntaxError. Replace the index.html
    # symlink with a tiny meta-refresh that lands users on vnc.html (the
    # working noVNC entry point) with autoconnect.
    #
    # Do NOT also overwrite vnc_auto.html: in this package it's a symlink to
    # vnc.html, so a tee through it clobbers the real noVNC UI with the
    # self-referential redirect and produces an infinite reload loop. Bookmarks
    # to /vnc_auto.html still resolve through the symlink to the working
    # vnc.html, so no separate redirect is needed.
    && printf '%s\n' '<!doctype html><meta http-equiv="refresh" content="0;url=vnc.html?autoconnect=true&resize=scale">' > /usr/share/novnc/index.html \
    && pip install apprise --break-system-packages --no-cache-dir

WORKDIR /fgc
COPY package*.json ./

# Install patchright's Chromium to a system-wide location instead of the
# default ~/.cache/ms-playwright. This is required for the optional non-root
# mode (entrypoint drops privileges to PUID/PGID) — the runtime user needs
# to be able to read the browser binaries, and a path under /root is mode
# 700 by default. PLAYWRIGHT_BROWSERS_PATH is honored both at install time
# and at runtime by patchright/playwright, so root mode resolves to the
# same location and continues working.
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/ms-playwright

# --no-shell to avoid installing chromium_headless_shell (307MB) since headless mode could be detected without patching the browser itself
RUN npm install --ignore-scripts && npx patchright install chromium --no-shell && du -h -d1 "$PLAYWRIGHT_BROWSERS_PATH" \
    && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

COPY . .

# Shell scripts need Linux line endings. On Windows, git might be configured to check out dos/CRLF line endings, so we convert them for those people in case they want to build the image. They could also use --config core.autocrlf=input
RUN dos2unix ./*.sh && chmod +x ./*.sh
COPY docker-entrypoint.sh /usr/local/bin/

# set by .github/workflows/docker.yml
ARG COMMIT=""
ARG BRANCH=""
ARG NOW=""
# need as env vars to log in docker-entrypoint.sh
ENV COMMIT=${COMMIT}
ENV BRANCH=${BRANCH}
ENV NOW=${NOW}

# added by docker/metadata-action using data from GitHub
# LABEL org.opencontainers.image.title="free-games-claimer" \
#       org.opencontainers.image.url="https://github.com/vogler/free-games-claimer" \
#       org.opencontainers.image.source="https://github.com/vogler/free-games-claimer"

# Configure VNC via environment variables:
ENV VNC_PORT=5900
ENV NOVNC_PORT=6080
ENV PANEL_PORT=7080
EXPOSE 5900
EXPOSE 6080
EXPOSE 7080

# Configure Xvfb via environment variables:
ENV WIDTH=1920
ENV HEIGHT=1080
ENV DEPTH=24

# Show browser instead of running headless
ENV SHOW=1

# Health check hits the always-on control panel API. /api/state returns JSON
# describing per-site session status, scheduler info, etc., so a passing check
# means the panel process is responsive (not just that noVNC's HTTP listener
# is up). With LOOP mode the claim scripts finish and the container sleeps
# between cycles — that's normal, the panel stays up regardless.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD curl --fail http://localhost:7080/api/state || exit 1

# Script to setup display server & VNC is always executed.
ENTRYPOINT ["docker-entrypoint.sh"]
# Default command to run. This is replaced by appending own command, e.g. `docker run ... node prime-gaming` to only run this script.
CMD node prime-gaming; node epic-games; node gog; node steam; node microsoft
