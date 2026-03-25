# Modifications from Upstream

This document tracks all changes made to the `free-games-claimer` fork for potential contribution back to the upstream repository ([vogler/free-games-claimer](https://github.com/vogler/free-games-claimer)).

---

## Task #1: Remove Deprecated Scripts and Dead Code

### Dead scripts removed
- `aliexpress.js` — AliExpress coin collector (experimental, unused)
- `steam-games.js` — Steam games library scraper (not a game claimer)
- `unrealengine.js` — Unreal Engine asset claimer (duplicate of epic-games.js logic, WIP)

### Dead code removed from `src/util.js`
- `stealth()` function (~35 lines) — Puppeteer stealth evasions injected via `addInitScript`. No longer needed since patchright has built-in anti-detection.
- `launchChromium()` function (~20 lines) — Wrapper for launching Chromium persistent context. Defined but never actually called by any script; each script launches its own context directly.

### Dead config removed from `src/config.js`
- `ae_email` and `ae_password` — AliExpress credentials config entries for the deleted script.

---

## Task #2: Interactive VNC Login Mode

### New file: `interactive-login.js`
A web-based control panel for establishing browser sessions manually. Designed for Docker environments where you need to solve captchas, handle MFA, or complete phone verification through a visible browser.

### Features
- Runs on port 7080 (configurable via `PANEL_PORT`)
- Password protection via `PANEL_PASSWORD` or `VNC_PASSWORD`
- Embeds noVNC viewer showing the Chromium browser on the Xvfb display
- Three site buttons: Prime Gaming, Epic Games, GOG
- "Login" launches a visible browser navigated to the site's login page
- "I'm Logged In" verifies the session and saves the persistent browser profile
- "Check" verifies an existing session status without opening a browser

### Docker integration
- `docker-entrypoint.sh`: Added `LOGIN_MODE=1` check — when set, launches the interactive panel instead of the automated claiming scripts
- `Dockerfile`: Added `ENV PANEL_PORT=7080` and `EXPOSE 7080`
- `docker-compose.yml`: Added port `7080:7080` mapping and `LOGIN_MODE` documentation
- `package.json`: Added `-p 7080:7080` to the docker run script

### Config
- `src/config.js`: Added `login_mode: process.env.LOGIN_MODE == '1'`

---

## Task #3: Switch from Playwright Firefox to Patchright Chromium

### Browser engine change
- Replaced `playwright-firefox` with `patchright` (a Chromium fork with built-in stealth/anti-detection)
- All 3 scripts (`prime-gaming.js`, `epic-games.js`, `gog.js`) now use `chromium.launchPersistentContext` from patchright
- `interactive-login.js` also uses patchright

### Dependencies changed
- Removed: `playwright-firefox`
- Added: `patchright`

### Replit-specific
- `run.sh`: Launcher script that resolves Nix mesa/libgbm `LD_LIBRARY_PATH` for Chromium, then execs `node`
- `scripts/post-merge.sh`: Runs `npm install` and `npx patchright install chromium` after merges

### Note
- Switching browser engines invalidates all existing Firefox browser profiles in `data/browser/`
- Sessions must be re-established (use `LOGIN_MODE=1` in Docker or manually)

---

## Task #4: Post-Merge Cleanup and Bug Fixes

### Bug fix: `prime-gaming.js` login error detection
- **Line 65**: Changed `error.trim.length` to `error.trim().length`
- `.trim` is a function reference with arity 0, so `.length` always returned 0
- The check `!error.trim.length` was therefore always truthy, meaning login errors (wrong password, account locked, etc.) were **never detected or reported**
- This bug existed in the upstream codebase

### Notification reliability
- Added `await` to all `notify()` calls in `catch` and `finally` blocks across all 3 claimer scripts
- Without `await`, the Node.js process could exit before the Pushover/apprise notification was actually sent
- Affected files: `epic-games.js` (2 calls), `prime-gaming.js` (2 calls), `gog.js` (2 calls)

### Stale imports cleaned
- Removed commented-out `// import { chromium } from 'playwright-chromium'` and `// import { firefox } from 'playwright-firefox'` lines from top of all 3 scripts

### Dockerfile CMD order
- Changed default CMD from `node epic-games; node prime-gaming; node gog` to `node prime-gaming; node epic-games; node gog`
- Prime Gaming is the most reliable/fastest, so it runs first

---

## Summary of All Changed Files

| File | Changes |
|------|---------|
| `prime-gaming.js` | Patchright import, login bug fix, awaited notify() |
| `epic-games.js` | Patchright import, awaited notify() |
| `gog.js` | Patchright import, awaited notify() |
| `interactive-login.js` | **New file** — interactive VNC login panel |
| `src/util.js` | Removed stealth() and launchChromium() |
| `src/config.js` | Removed AliExpress config, added login_mode |
| `src/epic-games-mobile.js` | New from dev branch — mobile game claiming |
| `Dockerfile` | Patchright, PANEL_PORT/EXPOSE 7080, CMD order |
| `docker-compose.yml` | Port 7080, LOGIN_MODE docs |
| `docker-entrypoint.sh` | LOGIN_MODE=1 check |
| `package.json` | Patchright dep, docker port 7080 |
| `run.sh` | **New file** — Nix/Replit Chromium launcher |
| `scripts/post-merge.sh` | **New file** — post-merge setup |

## Interactive Login Panel UX Improvements

### Workflow guidance
- Added a 4-step progress indicator at the top: Check sessions -> Log in to sites -> Test run -> Done!
- Added clear instructions in the main area explaining exactly what to do
- Added contextual status banners that change based on current state (needs login, all green, scripts running)

### New features
- **Check All Sessions** button — verifies login status for all 3 sites in one click
- **Test Run All Scripts** button — runs all 3 claiming scripts from within the panel with live log output
- **Stop Scripts** button — appears while scripts are running, allows canceling
- **Live log viewer** — shows real-time stdout/stderr from the claiming scripts with color-coded output
- **Contextual "what's next" messaging** — when all sites are green, tells the user to remove LOGIN_MODE=1 and restart

### Files deleted
- `aliexpress.js`
- `steam-games.js`
- `unrealengine.js`
- `src/migrate.js`
- `src/version.js`
