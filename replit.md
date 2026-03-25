# free-games-claimer

## Overview
A Node.js CLI automation tool that uses Patchright (Chromium) to automatically claim free games on:
- Amazon Luna (formerly Prime Gaming) - `luna.amazon.com/claims`
- Epic Games Store - `store.epicgames.com`
- GOG - `gog.com`

Based on the `dev` branch of `feldorn/free-games-claimer` which uses Patchright (a patched Chromium) instead of Playwright Firefox for better captcha handling.

## Project Structure
- `epic-games.js` - Epic Games Store claimer
- `prime-gaming.js` - Amazon Luna/Prime Gaming claimer
- `gog.js` - GOG claimer
- `aliexpress.js` - AliExpress claimer
- `unrealengine.js` - Unreal Engine claimer
- `steam-games.js` - Steam games claimer
- `interactive-login.js` - Web-based VNC login control panel (Replit-specific, needs updating)
- `src/config.js` - Configuration via environment variables
- `src/util.js` - Shared utilities (DB, notifications, prompts, browser launch via `launchChromium`)
- `src/epic-games-mobile.js` - Epic Games mobile game claiming
- `src/migrate.js` - Data migration utilities
- `run.sh` - Launcher script that sets up LD_LIBRARY_PATH for Chromium
- `data/` - Runtime data (browser profiles, JSON databases, screenshots)

## Key Architecture
- Browser engine: Patchright (patched Chromium) - replaces Playwright Firefox
- Browser launch: `launchChromium()` in `src/util.js` (no separate `src/browser.js`)
- Stealth: `stealth()` function in `src/util.js` using puppeteer-extra-plugin-stealth evasions
- Docker: TurboVNC replaces Xvfb+x11vnc, ubuntu:noble base image
- Fingerprint injection: `fingerprint-injector` package for browser fingerprint randomization

## Configuration
All configuration is done via environment variables. Key variables:
- `EG_EMAIL`, `EG_PASSWORD`, `EG_OTPKEY` - Epic Games credentials
- `PG_EMAIL`, `PG_PASSWORD`, `PG_OTPKEY` - Prime Gaming/Luna credentials
- `GOG_EMAIL`, `GOG_PASSWORD` - GOG credentials
- `NOTIFY` - Apprise notification URL
- `NOTIFY_TITLE` - Notification title
- `PG_REDEEM=1` - Auto-redeem codes from Prime Gaming
- `EG_MOBILE` - Claim mobile games (default: enabled, set to 0 to disable)
- `SHOW=1` - Show browser window (non-headless)
- `DEBUG=1` - Enable debug mode
- `DRYRUN=1` - Dry run (don't actually claim)
- `NOWAIT=1` - Fail fast instead of waiting for user input

## Runtime
- **Language**: Node.js 20 (ESM modules)
- **Package manager**: npm
- **Browser**: Patchright (Chromium) - headless by default
- **Database**: lowdb (JSON files in `data/`)
- **Notifications**: apprise (Python)

## Workflow
- **Start application**: `bash run.sh epic-games.js` (or other script)
  - `run.sh` sets up LD_LIBRARY_PATH for Chromium shared libraries (libgbm from mesa)
  - Each script uses browser profile in `data/browser/`

## Environment Variables (configured)
- `EMAIL`, `EG_EMAIL`, `GOG_EMAIL`, `PG_EMAIL` = 2ChrisOrr@gmail.com
- `NOTIFY_TITLE` = Free Games Claimer
- `PG_REDEEM` = 1
- Secrets: `EG_PASSWORD`, `PG_PASSWORD`, `GOG_PASSWORD`, `NOTIFY`

## System Dependencies (Nix)
- chromium, xvfb-run, dbus, gtk3, glib, nss, nspr, alsa-lib, libdrm, mesa
- xorg.libxcb, xorg.libX11, xorg.libXext, xorg.libXrandr, xorg.libXcomposite
- xorg.libXcursor, xorg.libXdamage, xorg.libXfixes, xorg.libXi, xorg.libXtst
- pango, atk, at-spi2-atk, cairo, gdk-pixbuf, freetype, fontconfig, xorg.libXrender
- cups, libxkbcommon, expat, systemdLibs
- gcc-unwrapped

## Notes
- This is a pure CLI tool with no web frontend
- Browser profiles saved to `data/browser/` to persist login sessions
- `run.sh` must be used to launch node scripts so Chromium can find libgbm.so
- The `interactive-login.js` still references old playwright-firefox imports and needs updating in a future task
- Patchright's chromium is downloaded to `.cache/ms-playwright/` via `npx patchright install chromium --no-shell`
