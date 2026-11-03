# CLAUDE.md — Free Games Claimer (sellwanger fork)

## What this is

- Fork of [feldorn/free-games-claimer](https://github.com/feldorn/free-games-claimer), which itself derives from [vogler/free-games-claimer](https://github.com/vogler/free-games-claimer).
- Automated free-game claimer + rewards farmer for Amazon Prime Gaming, Epic Games Store, FAB, GOG, Steam, Microsoft Rewards; watch-only notifiers for IndieGala, PSN, Xbox, Fanatical, Humble, Lenovo, Ubisoft.
- Control panel on :7080, noVNC on :6080 for manual captcha/login handoff.
- Node.js + patchright (anti-detect Chromium) in Docker; `src/panel/panel.js` is the panel + scheduler.
- Runs self-hosted on a Raspberry Pi 5 (arm64), built from this repo.

## Fork-specific changes

- Timeout hardening for Prime Gaming and Epic (bounded waits, per-game error handling).
- `FGC_REGION=de`: Prime + Epic on the German sites (luna.amazon.de, store.epicgames.com/de, de-DE browser). Locators accept German and English.
- Neutral branding ("Free Games Claimer", own icon set in `assets/`, source `assets/icon.svg`).

## Repo layout

```
src/
  panel/panel.js      panel HTTP server, HTML template (PANEL_HTML), scheduler
  platforms/          per-site runner scripts, spawned as child processes
  sites.js            site registry — single source of truth for every service
  config.js           cfg object from env vars + data/config.json
  app-config.js       Settings-panel schema / describeConfig() / patchConfig()
  util.js             notify(), log, jsonDb, siteLocale(), helpers
  browser.js          launchContext() + gotoWithRetry()
  epic-session.js     Epic account-session probe + account-switcher resume
test/                 node test scripts (non-interactive ones: node test/<file>.js)
docs/                 user docs linked from README
data/                 runtime state (mounted volume, not in repo)
```

## Conventions

- One logical change per commit/PR; branch first, PR into `main`.
- CHANGELOG entry for every user-visible change.
- Version is single-sourced from `package.json`.
- Stage files explicitly (no `git add .`).
- New behaviour that changes existing deploys is opt-in (env flag, default = old behaviour).

## Landmines

- **PANEL_HTML is one giant backtick template literal.** Regex escapes need doubling (`\\d`, `\\s`); a bare backtick ends the template and Node crashes at import. Regex inside a client string building an HTML attribute goes through two escape passes.
- **`disabled` means different things pre- vs post-click.** Pre-click = already owned; post-click = loading spinner. Never treat `disabled` as a success signal after clicking.
- **Never race several `page.click()` / `waitForSelector()` with `Promise.any`.** Losers keep running for the full timeout and can click on the next page; if none match, the AggregateError ends the run. Use one combined locator (`a.or(b)`) with an explicit timeout.
- **Fire-and-forget watchers need a short timeout**, otherwise they outlive the current game.
- **Text locators must cover English and German** (Prime + Epic with `FGC_REGION=de`). Prefer data attributes / hrefs over visible text; anchor regexes so body copy can't match.
- **Two code paths for login checks:** per-script login in `src/platforms/*.js` and `checkLogin()` in `src/sites.js`. Change both.
- **MS Store redeem is client-side** (`buynowui` iframe URL slugs `redeemnow` → `redeem-confirm` → `redeem-success`); validation failures are silent.
- **`cfg` is a module-load snapshot.** Panel code must live-read settings via `describeConfig().effective`; spawned runner scripts are fine.
- **Pushover strips HTML** — put full URLs as plain text in notifications.
- **No local copies of shared helpers** — import from `src/util.js`.
- **No native `confirm()` / `alert()` in the panel** — they auto-cancel under noVNC/iframes; use custom modals.
