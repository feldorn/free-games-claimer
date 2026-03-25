# free-games-claimer

## Overview
A Node.js CLI automation tool that uses Playwright (headless Firefox) to automatically claim free games on:
- Amazon Luna (formerly Prime Gaming) - `luna.amazon.com/claims`
- Epic Games Store - `store.epicgames.com` (separate browser profile, requires initial manual session)
- GOG - `gog.com`

Includes an interactive VNC login mode for establishing browser sessions manually (solving captchas, MFA, etc.) via a web-based control panel.

## Project Structure
- `prime-gaming.js` - Amazon Luna/Prime Gaming claimer
- `epic-games.js` - Epic Games Store claimer (separate browser profile at `data/browser-eg/`)
- `gog.js` - GOG claimer
- `interactive-login.js` - Web-based VNC login control panel (Docker-only, launched with LOGIN_MODE=1)
- `src/browser.js` - Shared browser launch, stealth plugin, and SIGINT handling
- `src/config.js` - Configuration via environment variables
- `src/util.js` - Shared utilities (DB, notifications, prompts, file helpers)
- `data/` - Runtime data (browser profiles, JSON databases, screenshots)

## Key Changes from Upstream
- **Prime Gaming → Luna migration**: Updated URLs from `gaming.amazon.com` to `luna.amazon.com/claims`
- **Amazon login fix**: Added handling for two-step password page and Customer Verification Flow (CVF)
- **GOG selector updates**: Updated login detection to use `state: 'attached'`; dynamic signed-in check; fallback selectors
- **Epic Games login**: Two-step login flow support (email page → password page); separate browser profile
- **Notification splitting**: Long notifications auto-split into multiple messages (Pushover 1024-char limit)
- **Auto-redeem enabled**: `PG_REDEEM=1` tries to redeem GOG/Xbox/Legacy codes, falls back to notification on captcha
- **Await notifications**: All `notify()` calls in catch/finally blocks are properly awaited
- **Redeem error handling**: Auto-redeem wrapped in try/catch to prevent crashes on redeem failures
- **DLC link detection**: Uses precise `[data-a-target="LinkAccountModal"]` instead of broad text match
- **Shared browser module**: `src/browser.js` centralizes browser launch, stealth, and SIGINT handling for all 3 scripts
- **Code cleanup**: Removed dead scripts (aliexpress, steam, unrealengine, migrate), commented-out code, and stale TODOs
- **Interactive VNC login mode**: Web control panel for manual login via noVNC (Docker-only, LOGIN_MODE=1)

## Configuration
All configuration is done via environment variables. Key variables:
- `EG_EMAIL`, `EG_PASSWORD`, `EG_OTPKEY` - Epic Games credentials
- `PG_EMAIL`, `PG_PASSWORD`, `PG_OTPKEY` - Prime Gaming/Luna credentials
- `GOG_EMAIL`, `GOG_PASSWORD` - GOG credentials
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

## Interactive VNC Login Mode
Set `LOGIN_MODE=1` in Docker to launch a web-based control panel instead of the automated claiming scripts.
- Control panel runs on port 7080 (configurable via `PANEL_PORT`)
- Embeds noVNC viewer to show the Playwright browser on the Xvfb display
- Three site buttons: Prime Gaming, Epic Games, GOG
- Click "Login" to launch a visible browser navigated to the site's login page
- Log in manually through noVNC (handle captchas, MFA, phone verification, etc.)
- Click "I'm Logged In" to verify the session and save the persistent browser profile
- Click "Check" to verify an existing session status without opening a browser
- After establishing sessions, switch back to normal mode (remove LOGIN_MODE=1) for automated claiming

## Runtime
- **Language**: Node.js 20 (ESM modules)
- **Package manager**: npm
- **Browser**: Playwright Firefox (headless by default)
- **Database**: lowdb (JSON files in `data/`)
- **Notifications**: apprise (Python) for Pushover

## Workflow
- **Start application**: `bash -c "node prime-gaming.js; node epic-games.js; node gog.js; echo sleeping; sleep 1d"`
  - Runs sequentially: Prime Gaming → Epic Games → GOG → sleep 24h
  - Each script uses its own browser profile (EG uses `data/browser-eg/`, others use `data/browser/`)

## Environment Variables (configured)
- `EMAIL`, `EG_EMAIL`, `GOG_EMAIL`, `PG_EMAIL` = 2ChrisOrr@gmail.com
- `NOTIFY_TITLE` = Free Games Claimer
- `PG_REDEEM` = 1
- Secrets: `EG_PASSWORD`, `PG_PASSWORD`, `GOG_PASSWORD`, `NOTIFY` (Pushover)

## System Dependencies (Nix)
- firefox, xvfb-run, dbus, gtk3, glib, nss, alsa-lib, libdrm, mesa
- xorg.libxcb, xorg.libX11, xorg.libXext, xorg.libXrandr, xorg.libXcomposite
- xorg.libXcursor, xorg.libXdamage, xorg.libXfixes, xorg.libXi
- pango, atk, cairo, gdk-pixbuf, freetype, fontconfig, xorg.libXrender
- gcc-unwrapped

## Notes
- This is a pure CLI tool with no web frontend (except the interactive login panel in Docker)
- Browser profiles saved to `data/browser/` and `data/browser-eg/` to persist login sessions
- First run on a new device requires Amazon CVF verification (code sent to phone)
- Epic Games login is blocked by invisible hCaptcha on first login from new devices
  - Once a session is established, the persistent browser profile keeps it alive
  - The script detects captcha blocking and exits gracefully with notification
  - Use `LOGIN_MODE=1` in Docker to manually establish the first session
- GOG codes from Luna can be redeemed at gog.com/redeem (auto-redeem attempted with PG_REDEEM=1)
