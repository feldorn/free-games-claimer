# Changelog

Release notes for [Feldorn's Free Games Claimer](README.md). Most recent at the top.

---

## What's new in 2.2

First two collectors built on the new framework, plus Settings/Sessions polish.

- **Humble Bundle (watch-only, opt-in)** — pings you when a new free item appears in the Humble store. Uses Patchright + response interception to bypass Cloudflare's bot management, captures the `/api/all-promotions/en` response, filters to the no-spend tier, diffs against `data/humble-bundle-watch.json`, and sends an apprise notification on new items. No login, no auto-claim — Humble's claim flow varies enough across promo formats (community freebie vs Choice unlock vs Trove drop) that watch-only is the cheaper-to-maintain default. v0.1 — selectors and the URL strategy may need iteration as Humble updates their store layout. Enable in **Settings → Per-service → Humble Bundle**.
- **Fanatical (watch-only, opt-in)** — pings you when a new free Steam-key giveaway appears at fanatical.com/en/free-games-keys. Same Playwright + response-interception pattern, hits Fanatical's `/api/all-promotions/en` endpoint, walks `freeProducts[*].products[*].freegames[*]` for items at min_spend $0, filters to `type === 'game'` so comic and book freebies don't spam notifications. Enable in **Settings → Per-service → Fanatical**.
- **Three-way Services grouping** — Settings → Services now splits into Game Collectors (Prime, Epic, GOG, Steam), Point Collectors (Microsoft Rewards, AliExpress), and Notify-Only Collectors (Ubisoft, Humble Bundle, Fanatical). Data-driven from the registry: `claimDbFile` presence + `scheduleKind` decide which group an entry lands in. Headers render as small uppercased labels with subtle separators.
- **Watchers section on Sessions tab** — active watch-only collectors get their own compact card row between the main session grid and the Available drawer. Run-button-only (no Login, no Check). Hidden when no watchers are active or the sessions area is collapsed. Inactive watchers stay surfaced in Settings → Services rather than this tab.
- **Unsaved-changes guard** — toggle a setting and try to navigate away without saving, and a centered modal asks: Stay on Settings / Discard and continue / Save and continue. Backdrop click and Escape both behave as Stay. If Save is chosen and the request fails, the user is held on Settings rather than losing changes silently. Page close and reload trigger the browser's native beforeunload dialog.
- **Post-save state refresh** — saving Settings now refreshes the in-memory state object so the Sessions card grid, Watchers section, and Available drawer reconcile immediately rather than waiting for the next 10-second poll. Schedule and Stats tabs read the same fresh state on next entry.

---

## What's new in 2.1

Engine refactor. Same user-facing tool, much cleaner internals — adding a new collector no longer means hand-edits across the panel HTML, the scheduler dispatch, the config schema, the active-services enum, and the stats DB list.

- **Sites registry framework** — Phase 0 of [issue #11](https://github.com/feldorn/free-games-claimer/issues/11). `src/sites.js` is the new declarative source of truth for every service the engine knows about. Each registry entry carries its own metadata (id, name, version, schedule kind, claim DB filename, configFields, etc.). `CONFIG_SCHEMA`, the scheduler chain, the stats DB list, the active-services enum, and the Settings → Services rendering are all derived from the registry at boot. Adding a new collector now requires one entry in `src/sites.js` plus the per-site `<id>.js` runner — zero engine touches for normal cases.
- **"Adding a new collector" guide** — [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-new-collector) covers the registry entry fields, configFields shape, coerce descriptor kinds, runner contract, claim DB entry shape, and a smoke checklist. Spec for adding a site without touching the engine.
- **Steam batch redemption** — parallel to the existing GOG batch redeem flow. Scans every claim DB for entries with `store: 'steampowered.com'` and a `code`, drives Steam's `account/registerkey` page programmatically, classifies responses into redeemed / already-owned / used-elsewhere / invalid / region-locked / rate-limited buckets, and writes status back to the source DB. Surfaces in the panel as a separate "Batch Redeem on Steam" button alongside GOG's. Halts on rate-limit so a long batch can't burn through more keys after Steam starts blocking.
- **Per-site versioning** — every registry entry carries a `version` string (existing services baselined at `2.0`; brand-new collectors start lower per their maturity). Surfaces in the Sessions tab cards (small subdued `vN.N` upper-right) and Settings → Services rows (next to the settings count). The contributor bumps it as their script evolves.
- **Branch-tagged Docker builds** — `feat/*`, `fix/*`, `refactor/*`, and `dev` branches now produce `:<branch-name>` images via the existing GHA workflow, with `concurrency: cancel-in-progress` so rapid pushes don't race the moving tag. `:latest` stays gated to `main` only.

---

## What's new in 2.0

Major refactor of the control panel and configuration story.

- **Five-tab workspace** — Sessions / Stats / Schedule / Logs / Settings. Header auto-collapses to a single compact status strip once setup is done, freeing the main area for the noVNC browser or the current run's log.
- **Settings tab** — every runtime flag that `src/config.js` reads is editable in-app. Docker env becomes the *initial default*; in-app saves take priority. Scheduler changes take effect immediately via `fs.watch`, no container restart needed.
- **Stats tab** — claim history derived from the existing per-service JSON DBs. KPI tiles (this week / month / all-time / last claim / MS points balance / MS points this week), per-service table, 30-day activity chart, recent-claims list with deep links to the stores.
- **Schedule tab** — next-run wall time with live countdown, human-readable interval (e.g. "Daily, anchored to MS window start 08:00 local time"), last-run summary with status.
- **Logs tab** — scrollable run-log viewer that polls independently of the Sessions tab so the main noVNC area stays clear.
- **Microsoft Rewards points tracking** — `microsoft.js` scrapes the Rewards counter before and after each desktop/mobile session. Deltas land in `data/microsoft-rewards.json` and feed the Stats tab's points KPIs.
- **Username capture fixes** — GOG reads `menu.gog.com/v1/account/basic` directly (no more "Logged in as unknown"); Microsoft reads the ME Control widget in the header.
- **Prime DLC graceful no-op** — Amazon removed the in-game content tab in 2026; the claim script now probes for it and skips in <1s instead of hanging for 60s on a missing selector.
- **Cache-Control: no-store** on panel HTML so iPad Safari and other aggressive caches can't serve stale inline JS after a push.

Existing users: pull the new image, open the **Settings** tab, and everything you had set via docker env is already there as a fallback. Edit anything you want to change at runtime — the docker-compose file only needs to change for things that stay env-only (ports, `PANEL_PASSWORD`, paths, credentials).

### Added in 2.0.1

- **AliExpress** restored as an opt-in service (previously deleted in the fork's 2026-03-25 cleanup). Disabled by default; enable in **Settings → Per-service → AliExpress**. Collects the daily check-in coins via mobile-site emulation and surfaces a per-service row in the Stats tab with its coin history. Needs `AE_EMAIL`/`AE_PASSWORD` only if you want unattended re-login — otherwise click Login on the AliExpress card and cookies persist.

### Added in 2.0.4 — non-root docker, screenshot-on-failure attachments, panel-API healthcheck

Three small-but-asked-for improvements, mostly closing the loop on
self-host ergonomics.

- **Opt-in non-root runtime via `PUID`/`PGID`.** Set them in the env and the
  entrypoint reconciles a runtime user `fgc` with those IDs, chowns
  `/fgc/data`, and drops privileges via `gosu` before TurboVNC and the panel
  start. Files created in your bind-mount or volume end up owned by the
  intended user instead of root. Default behavior unchanged when the vars
  are unset — the entrypoint's root-only block is skipped entirely, no
  surprise migration. Closes upstream
  [#525](https://github.com/vogler/free-games-claimer/issues/525) +
  [#468](https://github.com/vogler/free-games-claimer/issues/468); see
  [Running as a non-root user](#running-as-a-non-root-user) below.

- **Failure notifications now attach the most recent screenshot.** When a
  claim script crashes, `notify()` looks for the newest `.png` under
  `data/screenshots/` written since this run started and passes it to
  apprise via `-a`. Pushover, Discord webhooks, Telegram, etc. render the
  attachment inline. Useful when the failure is visual (captcha, broken
  layout, unexpected modal). Off-switch via `NOTIFY_ATTACH_SCREENSHOTS=0`
  or **Settings → Notifications → Attach screenshot to failures** for
  privacy / bandwidth-conscious deploys.

- **Panel-API healthcheck.** Docker `HEALTHCHECK` now hits
  `http://localhost:7080/api/state` instead of `:6080`. A passing check
  means the panel can actually serve its state, not just that noVNC's HTTP
  listener accepts connections — more diagnostic, same `unless-stopped`
  recovery semantics.

- **GOG catalog watch (notify-only).** In addition to the existing
  homepage spotlight-giveaway claim flow, `gog.js` now queries GOG's
  catalog API for free games not surfaced on the homepage banner — the
  Heartlight-type cases where a paid game becomes free with GOG's
  curated `freegame` tag rather than a discount flag. Baseline-diff
  pattern, same as the Ubisoft watcher: first run after upgrade silently
  records the current free-games list (~60 entries, including long-time
  permafree titles like Witcher 3 REDkit and GWENT), subsequent runs
  notify only on **new** additions to GOG's free-games tag. State lives
  in `data/gog-catalog-watch.json`. Closes feldorn-fork issue
  [#9](https://github.com/feldorn/free-games-claimer/issues/9) (the GOG
  half).

### Added in 2.0.3 — Steam discovery durability + Ubisoft watcher

Two notable changes plus an Epic Games stability fix.

- **Steam discovery moved off SteamDB.** SteamDB sits behind Cloudflare with Private Access Token enforcement, and the patchright Chromium can't satisfy PAT (it requires real Apple/Google attestation signing keys). SteamDB started returning 403 with no recoverable challenge — a manual solve in noVNC didn't help because the underlying request was rejected before any Turnstile widget rendered. **Discovery now uses Steam's own `search/results/?specials=1&maxprice=free` endpoint** — Steam's own infra, no Cloudflare in the way. Steam's `specials=1` filter naturally excludes free-to-play games (since they have a $0 baseline price and aren't "specials"), so the cleaner filter actually drops the per-app "free to keep vs free weekend vs free to play" parsing pass we used to need. Validated against live Free-to-Keep promotions during the migration.

- **Ubisoft Connect (watch-only, opt-in).** New service that pings you via Apprise when a new free-week promo appears at `store.ubisoft.com/us/free-games`. **No login, no auto-claim** — Ubisoft free-week events fire only every few months and the AAA back-catalog they offer is something most users have already played, so a daily check + manual claim is much better juice/squeeze than building login persistence + captcha handling for a quarterly event. Enable in **Settings → Per-service → Ubisoft Connect**. First run silent (establishes baseline); subsequent runs notify only on new promo-edition titles. State persists in `data/ubisoft-watch.json`.

- **Epic Games "ownership-lag" crash fix.** Epic's storefront shows a placeholder "Get" button while the ownership lookup resolves, then flips to "In Library" 1-2s later if you already own the game. The script was reading the placeholder, clicking it, and timing out 60s waiting for a purchase iframe that never appears (Epic shows an already-owned modal instead) — the uncaught timeout exited the whole script with code 1, skipping any remaining games in the queue. Three layers of defense now: a `networkidle` wait after the initial CTA-text wait, a last-second re-read just before clicking, and a CTA re-probe in the catch block that marks the game as `existed` (not `failed`) when the lag turned out to be the cause.

### Added in 2.0.2 — captcha pause + manual-solve handoff (feedback wanted)

When a runner script hits a captcha that needs a human, the run no longer just fails — it now pauses, pings you, and hands off to noVNC for a manual solve. See [Captcha pause](#captcha-pause) below for the full flow. **This is brand new and currently wired into GOG's login captcha; we want feedback** on the timeout window, the notification copy, and edge cases before we generalize it to AliExpress's slider, hCaptcha, and friends. File issues at [feldorn/free-games-claimer/issues](https://github.com/feldorn/free-games-claimer/issues) or comment on a recent captcha-related issue.

Other small panel improvements that landed alongside:

- **Show browser** button on the Sessions tab header (with **Pop out ↗** sibling) — peek at the live noVNC view during a run instead of only during interactive logins.
- **Sessions panel collapse** — click the chevron in the bottom-right of the header (or the status strip itself) to fold the cards down to a one-line row of mini-cards (`name ✓` / `name ✕`). Useful on phones / when watching the browser full-screen.
- **MS Bing-search delay** is now configurable via `MS_SEARCH_DELAY_MAX_SEC` / **Settings → Microsoft Rewards** — drops a typical run from ~90 minutes to whatever you want at your own bot-detection risk.
- **State-aware Sessions placeholder** — the four-step setup tutorial that used to greet every visit (with a misleading "click Check All Sessions" step that's already automatic) is replaced with a context message: "checking sessions (n/N)" during startup auto-check, "N of M sessions need login" if any are red, the existing "Run Now / scheduler" line when all are green.

Bug fixes in 2.0.2:

- **noVNC refresh loop** at `:6080/` — `vnc_auto.html` is a symlink to `vnc.html` in noVNC 1.3.0-2, so the previous Dockerfile `tee` clobbered the real noVNC UI with our self-referential meta-refresh and produced an infinite loop. Closes [#8](https://github.com/feldorn/free-games-claimer/issues/8).
- **MS Rewards activity cards** were timing out for everyone after Microsoft started rendering multiple `#popUpModal` templates (streak-protection, autoredeem warning, etc.) and toggling `ng-hide` to show one. The dismiss helper picked `.first()` and almost always grabbed a hidden one — silent no-op while the visible streak-protection modal blocked every card click. Now scoped to `:not(.ng-hide)`.
- **MS log format** collapsed from three lines per card / search to one. With ~16 cards and ~60 searches per run, drops ~150 lines of churn from each MS run log.
- **"Available services" drawer caret** wasn't actually toggling — JS state was correct but `.drawer-body { display: grid }` beat the UA-default `[hidden] { display: none }` on specificity, so the cards stayed laid out regardless of the hidden attribute.

---
