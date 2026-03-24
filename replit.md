# free-games-claimer

## Overview
A Node.js CLI automation tool that uses Playwright (headless Firefox) to automatically claim free games on:
- Amazon Luna (formerly Prime Gaming) - `luna.amazon.com/claims`
- GOG - `gog.com`
- Epic Games Store (disabled in current workflow)
- Unreal Engine (Assets)
- AliExpress (experimental)
- Steam (experimental)

## Project Structure
- `epic-games.js` - Epic Games Store claimer
- `prime-gaming.js` - Amazon Luna/Prime Gaming claimer (updated for Luna rebrand)
- `gog.js` - GOG claimer (updated selectors for current site)
- `unrealengine.js` - Unreal Engine Assets claimer
- `aliexpress.js` - AliExpress claimer (experimental)
- `steam-games.js` - Steam claimer (experimental)
- `src/config.js` - Configuration via environment variables
- `src/util.js` - Shared utilities (DB, browser helpers, etc.)
- `src/migrate.js` - Data migration utilities
- `data/` - Runtime data (browser profiles, JSON databases, screenshots)

## Key Changes from Upstream
- **Prime Gaming → Luna migration**: Updated URLs from `gaming.amazon.com` to `luna.amazon.com/claims`
- **Amazon login fix**: Added handling for two-step password page (visible password field detection) and Customer Verification Flow (CVF)
- **GOG selector updates**: Updated login detection to use `state: 'attached'` instead of `state: 'visible'` since GOG hides some menu elements; added fallback selectors for username detection
- **Apprise installed**: Python `apprise` package for Pushover notifications

## Configuration
All configuration is done via environment variables. Key variables:
- `EG_EMAIL`, `EG_PASSWORD`, `EG_OTPKEY` - Epic Games credentials
- `PG_EMAIL`, `PG_PASSWORD`, `PG_OTPKEY` - Prime Gaming/Luna credentials
- `GOG_EMAIL`, `GOG_PASSWORD` - GOG credentials
- `NOTIFY` - Apprise notification URL (Pushover)
- `NOTIFY_TITLE` - Notification title
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
- **Start application**: `bash -c "node prime-gaming.js; node gog.js; echo sleeping; sleep 1d"` (console output, checks Luna/Prime Gaming and GOG)

## Environment Variables (configured)
- `EMAIL`, `EG_EMAIL`, `GOG_EMAIL`, `PG_EMAIL` = 2ChrisOrr@gmail.com
- `NOTIFY_TITLE` = Free Games Claimer
- Secrets: `EG_PASSWORD`, `PG_PASSWORD`, `GOG_PASSWORD`, `NOTIFY` (Pushover)

## System Dependencies (Nix)
- firefox, xvfb-run, dbus, gtk3, glib, nss, alsa-lib, libdrm, mesa
- xorg.libxcb, xorg.libX11, xorg.libXext, xorg.libXrandr, xorg.libXcomposite
- xorg.libXcursor, xorg.libXdamage, xorg.libXfixes, xorg.libXi
- pango, atk, cairo, gdk-pixbuf, freetype, fontconfig, xorg.libXrender
- gcc-unwrapped

## Notes
- This is a pure CLI tool with no web frontend
- Browser profiles are saved to `data/browser/` to persist login sessions
- First run on a new device requires Amazon CVF verification (code sent to phone)
- Once logged in, subsequent runs use the saved browser session
- Epic Games games from Luna require account linking to claim
- GOG codes from Luna can be redeemed at gog.com/redeem
