# free-games-claimer

## Overview
A Node.js CLI automation tool that uses Playwright (headless Firefox) to automatically claim free games on:
- Amazon Luna (formerly Prime Gaming) - `luna.amazon.com/claims`
- Epic Games Store - `store.epicgames.com` (separate browser profile, requires initial manual session)
- GOG - `gog.com`

## Project Structure
- `prime-gaming.js` - Amazon Luna/Prime Gaming claimer
- `epic-games.js` - Epic Games Store claimer (separate browser profile at `data/browser-eg/`)
- `gog.js` - GOG claimer
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

## Configuration
All configuration is done via environment variables. Key variables:
- `EG_EMAIL`, `EG_PASSWORD`, `EG_OTPKEY` - Epic Games credentials
- `PG_EMAIL`, `PG_PASSWORD`, `PG_OTPKEY` - Prime Gaming/Luna credentials
- `GOG_EMAIL`, `GOG_PASSWORD` - GOG credentials
- `NOTIFY` - Apprise notification URL (Pushover)
- `NOTIFY_TITLE` - Notification title
- `PG_REDEEM=1` - Auto-redeem GOG/Xbox/Legacy codes from Prime Gaming
- `HCAPTCHA_ACCESSIBILITY` - hCaptcha accessibility cookie for Epic Games
- `SHOW=1` - Show browser window
- `DEBUG=1` - Enable debug mode
- `DRYRUN=1` - Dry run (don't actually claim)

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
- This is a pure CLI tool with no web frontend
- Browser profiles saved to `data/browser/` and `data/browser-eg/` to persist login sessions
- First run on a new device requires Amazon CVF verification (code sent to phone)
- Epic Games login is blocked by invisible hCaptcha on first login from new devices
  - Once a session is established, the persistent browser profile keeps it alive
  - The script detects captcha blocking and exits gracefully with notification
- GOG codes from Luna can be redeemed at gog.com/redeem (auto-redeem attempted with PG_REDEEM=1)
