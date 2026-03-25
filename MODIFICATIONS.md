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

## GOG Selector Fix

### Problem
- `gog.js` timed out waiting for `#menuUsername` selector (60s timeout)
- GOG appears to have changed their page structure — the `#menuUsername` element is no longer reliably present
- The `while` loop condition `signIn.isVisible() && !username.isVisible()` would evaluate to `false` when neither element existed, skipping the login flow entirely and then crashing at username detection

### Fix
- Login detection loop changed from `while (signIn visible AND username not visible)` to `while (username not visible)` with fallback: if no sign-in button either, check for account-related links as a secondary logged-in indicator
- Username selector broadened: `#menuUsername, .menu-username, [ng-click*="account"]`
- Username reading wrapped in try/catch with 10s timeout — falls back to `'unknown'` if element exists but text can't be read, or throws a clear error if no login indicators found at all
- Added 3s wait after page load to let GOG's Angular app hydrate before checking selectors

### Files changed
- `gog.js`: Lines 50-122 (login detection and username reading)

---

## Task #5: Steam Free-to-Keep Game Claimer

### New file: `steam.js`
Automatically discovers and claims temporarily free games on Steam (100% off promotions for normally-paid games). Does NOT claim permanently free-to-play games or free weekend trials.

### Discovery
- Searches Steam store for games with 100% discount (`/search/?maxprice=free&specials=1`)
- Parses search results for title, original price, discount percentage, and review rating

### Quality filtering
- `STEAM_MIN_RATING` (default: 6 = Mostly Positive) — Rating scale 1-9:
  - 9: Overwhelmingly Positive, 8: Very Positive, 7: Positive, 6: Mostly Positive
  - 5: Mixed, 4: Mostly Negative, 3: Negative, 2: Very Negative, 1: Overwhelmingly Negative
- `STEAM_MIN_PRICE` (default: 10 = $10 USD) — Minimum original price to filter out cheap/shovelware titles
- Games with no rating AND no price data are skipped (cannot verify quality)

### Claiming flow
- Navigates to each game's store page
- Handles Steam age verification gates (date-of-birth selector)
- Clicks "Add to Account" button
- Verifies claim by checking for success message or "already owned" indicator
- Tracks all results in `data/steam.json`

### Login
- Uses `STEAM_EMAIL` / `STEAM_PASSWORD` environment variables (falls back to `EMAIL` / `PASSWORD`)
- Handles Steam Guard two-factor authentication (5-character code input)
- Supports manual browser login via VNC (same pattern as other claimers)

### Integration
- `src/config.js`: Added `steam_email`, `steam_password`, `steam_min_rating`, `steam_min_price`
- `interactive-login.js`: Added Steam as 4th site with login check, login URL, and session verification
- `Dockerfile`: Added `node steam` to default CMD
- `docker-compose.yml`: Added `STEAM_MIN_RATING` and `STEAM_MIN_PRICE` documentation
- `docker-compose.test.yml`: Added `STEAM_EMAIL`, `STEAM_PASSWORD`, `STEAM_MIN_RATING`, `STEAM_MIN_PRICE`
- `run.sh` / Replit workflow: Added `bash run.sh steam.js` to the execution chain

---

## Task #6: Refactor Steam Discovery to Use SteamDB

### Discovery source change
- Replaced Steam store search (`/search/?maxprice=free&specials=1`) with SteamDB's curated free promotions page (`steamdb.info/upcoming/free/`)
- SteamDB pre-separates "Free to Keep" promotions from "Free Weekend" / "Play for Free" events, eliminating the need for fragile heuristic detection

### Removed complexity
- **`parseSearchPage()`** — Entire function removed (parsed Steam search result rows for -100% discount badges)
- **`discoverFreeGames()` pagination** — Replaced 5-page pagination loop with single SteamDB page scrape
- **`isFreeToPlay` detection** — Removed from `getGameDetails()` (SteamDB excludes F2P games)
- **`isFreeWeekend` detection** — Removed from `getGameDetails()` (SteamDB separates free weekends)
- **`isTemporaryPromo` detection** — Removed countdown element / "Free to keep" text scanning (SteamDB only lists temporary promos)
- **`isFree` check** — Removed (SteamDB confirms the game is currently free)
- **Pre-filter by rating/price from search results** — Removed (rating/price now checked only from store page)
- **`URL_SEARCH_FREE` constant** — Replaced with `URL_STEAMDB_FREE`

### New discovery flow
1. Navigate to `steamdb.info/upcoming/free/`
2. Find all store links (`store.steampowered.com/app/`) in containers with "Free to Keep" text
3. Skip any container with "Play for Free" or "Free Weekend" text
4. Extract app ID, game name, and end date from each entry
5. Visit each game's Steam store page for rating, price, ownership check, and claiming

### End date logging
- SteamDB provides promotion end dates — now logged per game in console output

### Files changed
- `steam.js`: Discovery rewritten, `getGameDetails` simplified, ~100 lines of filtering logic removed
- `MODIFICATIONS.md`: Documented discovery source change

---

## Logging Improvements

### Shared logging helpers in `src/util.js`
- Added `log` object with structured output methods: `section()`, `sectionEnd()`, `status()`, `game()`, `skip()`, `ok()`, `warn()`, `fail()`, `summary()`
- Consistent 50-character-wide section dividers using `─` characters
- Color-coded output: blue for game names, green checkmarks for success, yellow for warnings/skips, red for failures, dim for secondary info

### Startup banner in `docker-entrypoint.sh`
- Replaced flat text output with boxed banner using `═` characters
- Shows version, source URL, branch (if non-main), and build timestamp
- VNC/noVNC info formatted with consistent indentation

### Per-script section headers and footers
- Each script now opens with `─── Site Name ───` section header via `log.section()`
- Shows structured metadata: time, user, filters (Steam), game counts
- Closes with `───` footer via `log.sectionEnd()`
- Exception output simplified to one-line `log.fail()` (full stack trace only with `DEBUG=1`)

### Noise reduction
- `waitUntilStable` debug output in `prime-gaming.js` now gated behind `DEBUG=1`
- Raw URL arrays in `epic-games.js` now gated behind `DEBUG=1` (shows count instead)
- Replaced verbose `--- Exception:` + full stack dump with single-line `log.fail()` message

### Full console.log/error/info audit (all 4 scripts)
- **Login flows**: Converted all raw `console.error`/`console.info` to `log.warn`/`log.info`/`log.status` across Prime Gaming, Epic Games, GOG, and Steam login handlers (sign-in prompts, MFA, captcha warnings, timeout info)
- **Claim flows**: Converted `console.log('Current free game:')` to `log.game()`, claim results to `log.ok()`, failures to `log.fail()`, region/requirements to `log.skip()`
- **Redeem flows** (Prime Gaming): Converted all code/URL/status output to `log.ok`/`log.info`/`log.warn` — captcha warnings, code-not-found, redeemed confirmations, store-specific messages
- **DLC flows** (Prime Gaming): Converted progress/status to `log.info`/`log.status`/`log.game`/`log.warn`/`log.fail`, formatted unlinked accounts summary
- **Debug-gated**: `skipBasedOnTime` timing data, `dismissAgeGate` message, mature content notice, bundle-includes errors, EULA HTML dumps, full exception stacks
- **Em-dash consistency**: Normalized all `" - "` separators to `" — "` in `log.warn`/`log.fail`/`log.skip` messages
- **Epic Games platform dedup**: Shows unique game count with platform variant note, e.g. `Free games found: 3 (4 incl. platform variants)` and per-game `(2 platforms)` suffix

### Files changed
- `src/util.js`: Added `chalk` import and `log` helper object
- `docker-entrypoint.sh`: Startup banner redesign
- `prime-gaming.js`, `epic-games.js`, `gog.js`, `steam.js`: Section headers/footers, structured game output, reduced noise, full console audit

---

## Summary of All Changed Files

| File | Changes |
|------|---------|
| `prime-gaming.js` | Patchright import, login bug fix, awaited notify() |
| `epic-games.js` | Patchright import, awaited notify() |
| `gog.js` | Patchright import, awaited notify() |
| `steam.js` | **New file** — Steam free-to-keep game claimer with quality filtering |
| `interactive-login.js` | **New file** — interactive VNC login panel; added Steam as 4th site |
| `src/util.js` | Removed stealth() and launchChromium() |
| `src/config.js` | Removed AliExpress config, added login_mode, added Steam config |
| `src/epic-games-mobile.js` | New from dev branch — mobile game claiming |
| `Dockerfile` | Patchright, PANEL_PORT/EXPOSE 7080, CMD order, added `node steam` |
| `docker-compose.yml` | Port 7080, LOGIN_MODE docs, Steam config docs |
| `docker-compose.test.yml` | Added Steam environment variables |
| `docker-entrypoint.sh` | LOGIN_MODE=1 check, LOOP scheduling |
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
