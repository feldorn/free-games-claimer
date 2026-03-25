# free-games-claimer

## Overview
A Node.js CLI automation tool that uses patchright (Chromium) to automatically claim free games on:
- Amazon Luna (formerly Prime Gaming) - `luna.amazon.com/claims`
- Epic Games Store - `store.epicgames.com` (requires initial manual session)
- GOG - `gog.com`
- Steam - `store.steampowered.com` (free-to-keep promotions only, with quality filtering)

Includes an interactive VNC login mode for establishing browser sessions manually (solving captchas, MFA, etc.) via a web-based control panel.

## Project Structure
- `prime-gaming.js` - Amazon Luna/Prime Gaming claimer
- `epic-games.js` - Epic Games Store claimer
- `gog.js` - GOG claimer
- `steam.js` - Steam free-to-keep game claimer (discovers via SteamDB, claims on Steam store, with rating/price filtering)
- `interactive-login.js` - Web-based VNC login control panel (Docker-only, launched with LOGIN_MODE=1)
- `run.sh` - Launcher script that sets LD_LIBRARY_PATH for patchright's Chromium and execs `node`
- `src/util.js` - Shared utilities (DB, notifications, prompts, file helpers, handleSIGINT)
- `src/config.js` - Configuration via environment variables
- `src/epic-games-mobile.js` - Epic Games mobile games helper
- `data/` - Runtime data (browser profiles, JSON databases, screenshots)
- `scripts/post-merge.sh` - Post-merge setup script (npm install + patchright install)

## Key Architecture
- **Browser engine**: patchright (Chromium fork with stealth/anti-detection built-in, replaces playwright-firefox)
- **Browser profiles**: All scripts share `data/browser/` persistent browser context
- **Launcher**: `run.sh` resolves Nix mesa libgbm path for Chromium, then execs `node`

## Configuration
All configuration is done via environment variables. Key variables:
- `EG_EMAIL`, `EG_PASSWORD`, `EG_OTPKEY` - Epic Games credentials
- `PG_EMAIL`, `PG_PASSWORD`, `PG_OTPKEY` - Prime Gaming/Luna credentials
- `GOG_EMAIL`, `GOG_PASSWORD` - GOG credentials
- `STEAM_EMAIL`, `STEAM_PASSWORD` - Steam credentials
- `STEAM_MIN_RATING` - Minimum review rating 1-9 (default: 6 = Mostly Positive)
- `STEAM_MIN_PRICE` - Minimum original price in USD (default: 10)
- `NOTIFY` - Apprise notification URL (Pushover)
- `NOTIFY_TITLE` - Notification title
- `PG_REDEEM=1` - Auto-redeem GOG/Xbox/Legacy codes from Prime Gaming
- `HCAPTCHA_ACCESSIBILITY` - hCaptcha accessibility cookie for Epic Games
- `LOGIN_MODE=1` - Launch interactive VNC login panel instead of automated claiming (Docker-only)
- `PANEL_PASSWORD` - Password for the interactive login panel (falls back to VNC_PASSWORD; if unset, panel is unprotected)
- `PANEL_PORT` - Port for the interactive login panel (default: 7080)
- `SHOW=1` - Show browser window
- `DEBUG=1` - Enable debug mode
- `DRYRUN=1` - Dry run (don't actually claim)
- `INTERACTIVE=1` - Confirm each claim interactively (enter to skip)

## Interactive VNC Login Mode
Set `LOGIN_MODE=1` in Docker to launch a web-based control panel instead of the automated claiming scripts.
- Control panel runs on port 7080 (configurable via `PANEL_PORT`)
- Password protected via `PANEL_PASSWORD` or `VNC_PASSWORD` env vars
- Embeds noVNC viewer to show the Playwright browser on the Xvfb display
- Four site buttons: Prime Gaming, Epic Games, GOG, Steam
- Click "Login" to launch a visible browser navigated to the site's login page
- Log in manually through noVNC (handle captchas, MFA, phone verification, etc.)
- Click "I'm Logged In" to verify the session and save the persistent browser profile
- Click "Check" to verify an existing session status without opening a browser
- After establishing sessions, switch back to normal mode (remove LOGIN_MODE=1) for automated claiming

## Runtime
- **Language**: Node.js 20 (ESM modules)
- **Package manager**: npm
- **Browser**: patchright Chromium (headless by default, stealth built-in)
- **Database**: lowdb (JSON files in `data/`)
- **Notifications**: apprise (Python) for Pushover

## Workflow
- **Start application**: `bash -c 'bash run.sh prime-gaming.js; bash run.sh epic-games.js; bash run.sh gog.js; bash run.sh steam.js; echo sleeping; sleep 1d'`
  - Runs sequentially: Prime Gaming → Epic Games → GOG → Steam → sleep 24h
  - Each script launched via `run.sh` which sets LD_LIBRARY_PATH for Chromium's libgbm

## Environment Variables (configured)
- `EMAIL`, `EG_EMAIL`, `GOG_EMAIL`, `PG_EMAIL` = 2ChrisOrr@gmail.com
- `NOTIFY_TITLE` = Free Games Claimer
- `PG_REDEEM` = 1
- Secrets: `EG_PASSWORD`, `PG_PASSWORD`, `GOG_PASSWORD`, `NOTIFY` (Pushover), `PG_PASSWORD`

## System Dependencies (Nix)
- chromium, nspr, nss, at-spi2-atk, cups, libxkbcommon, mesa
- xorg.libxcb, xorg.libX11, xorg.libXext, xorg.libXrandr, xorg.libXcomposite
- xorg.libXcursor, xorg.libXdamage, xorg.libXfixes, xorg.libXi, xorg.libXtst
- pango, atk, cairo, gdk-pixbuf, freetype, fontconfig, xorg.libXrender
- gtk3, glib, alsa-lib, libdrm, dbus, expat, systemdLibs
- gcc-unwrapped

## Notes
- Browser profiles saved to `data/browser/` to persist login sessions (shared by all scripts)
- Switching browser engines (Firefox→Chromium) invalidates existing browser profiles; use LOGIN_MODE=1 to re-establish sessions
- Epic Games login blocked by invisible hCaptcha on first login from new devices — use LOGIN_MODE=1
- GOG codes from Luna can be redeemed at gog.com/redeem (auto-redeem attempted with PG_REDEEM=1)
- Post-merge script at `scripts/post-merge.sh` handles npm install + patchright browser install
