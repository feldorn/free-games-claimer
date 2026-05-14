# Changelog

Release notes for [Feldorn's Free Games Claimer](README.md). Most recent at the top.

---

## What's new in 2.5.9

**Run-log header stamps the panel version.** The `=== Free Games Run — 2026-05-14 ===` header at the top of each run now reads `=== Free Games Run v2.5.9 — 2026-05-14 ===` (or whichever version is active). Visible in `docker logs`, in the Logs tab live view, and — since the header is captured in the persisted run record — also visible when browsing past runs via the Past Runs dropdown. Helps when triaging "did this behavior land before or after I upgraded" kinds of questions from a single log line.

---

## What's new in 2.5.8

**Lenovo Gaming — configurable notification priority.** A user missed a "drop is LIVE NOW" alert because their phone was in Do-Not-Disturb mode. Lenovo notifications were always firing at default (normal) priority, which respects DnD/quiet hours on Pushover and most other notifiers — exactly the wrong default for a time-critical "claim within minutes" alert. New per-service setting in **Settings → Services → Lenovo Gaming Key Drops → Notification priority** (env: `LENOVO_NOTIFY_PRIORITY`) with apprise's standard ladder: `low` / `moderate` / `normal` (default) / `high` (bypasses Pushover quiet hours) / `emergency` (requires acknowledgment on Pushover). Applies to all Lenovo notifications — new-drop discovery, 1h/5min/at-drop wakes, restock alerts. Default `normal` preserves existing-deploy behavior; users opt into higher priority via the dropdown.

Apprise translates the level to whatever the configured notifier supports — Pushover honors high/emergency literally, Telegram maps to the silent-notification flag, Discord ignores. Notifier-specific behavior is on the user to know.

Under the hood: `notify()` in `src/util.js` now accepts `opts.priority` and passes `--priority <value>` to apprise when set to anything non-`normal`. Other call sites (claim summaries, captcha pause, watcher alerts) continue to use default normal priority and are unaffected.

---

## What's new in 2.5.7

**Scheduler — fix LOOP-without-anchor drift across restarts ([#32](https://github.com/feldorn/free-games-claimer/issues/32)).** Found while diagnosing xh43k's "MS didn't run for 2 days" report: a deployment with `LOOP=86400` set but no `START_TIME` was supposed to mean "every 24 hours" but the bare-LOOP code path in `computeMainWakeMs` returned `LOOP * 1000` regardless of when the last run actually completed. That meant every panel restart (image pulls, host reboots, panel updates) reset the wake clock to "24 hours from now" and silently skipped days. Users restarting the container at intervals shorter than `LOOP` were watching their scheduler keep getting pushed forward without firing. Now persisted to `data/scheduler-state.json` on every scheduler-main close: a single `lastMainCompletedAt` ISO timestamp. On boot, `computeMainWakeMs` reads it and computes `wake = max(60s, lastMainCompletedAt + LOOP - now)` — past-due fires immediately, future sleeps the remainder. First-run-ever (no state file) falls back to the original sleep-from-now behavior so existing deployments don't suddenly fire on first upgrade. Independent of the TZ display fix in 2.5.6.

---

## What's new in 2.5.6

**Schedule tab — accurate display + countdown when browser TZ ≠ server TZ.** Spotted while viewing a CDT-server panel from an ET browser: the displayed "Next run: 07:30" was being misread as 07:30 ET when the scheduler will actually fire at 07:30 CDT (08:30 ET), and the live countdown was off by an hour because JavaScript parses naked `"YYYY-MM-DD HH:mm:ss"` strings as browser-local. Two fixes: (a) state response now includes UTC-ISO timestamps (`nextScheduledRunIso`, `nextMainRunIso`, `nextMsRunIso`, `lastRun.atIso`) plus a `serverTimezone` field, so the panel can do accurate cross-TZ math; (b) the Schedule tab renders wall times in the *server's* TZ (matching the `START_TIME` the user actually configured and what `docker logs` shows) with a `(8:30 AM EDT your local)` annotation appended only when server TZ differs from browser TZ. Countdown now uses the UTC anchor so it's always correct regardless of which TZ the panel is viewed from. Same-TZ deployments see no visible change.

---

## What's new in 2.5.5

**Honest baseline on bot detection — what we will and won't chase.** Added a top-level [Bot detection — what works, what doesn't](README.md#bot-detection--what-works-what-doesnt) section to the README documenting three categories of detection failure: (A) UI workflow drift we routinely fix, (B) browser fingerprint scoring against signals that come from real hardware (WebGL renderer, audio context, font enumeration, TLS handshake) — architecturally outside what a containerized self-hosted tool can shim past, (C) account-level risk scoring that decays naturally over weeks. Per-store reality table sets concrete expectations: Prime / Epic / GOG / Steam / MS Rewards stay reliable; AliExpress is deprecated by the upstream platform itself and accepted as best-effort. Explicit "what we won't build and why" subsection covers chromedp sidecars, cloud BaaS, Android emulators, and whole-project Firefox migration. The last was PoC'd on a [separate experiment branch](https://github.com/feldorn/free-games-claimer/tree/experiment/camoufox-poc) (see #28); one Tier 0 test on a real AliExpress account hit the same AWSC slider as patchright, suggesting the ceiling is account/hardware-bound rather than JS-injection-bound. The branch remains open for further volunteer testing but no production integration is planned.

**AliExpress reframed as deprecated channel, not as a bot-detection bug.** Subtitle on the AliExpress service entry now reads "Deprecated by AliExpress — web coin collection is being phased out in favor of the mobile app. Works for some accounts on a degradation curve." Service tables in the README append `**deprecated**` with a link to the Bot detection section. The script and toggle remain in place — some accounts still work — but the framing makes clear this is a sunset path, not a bug we're hunting. Background on upstream reality: [vogler/free-games-claimer#391](https://github.com/vogler/free-games-claimer/issues/391) (closed) confirms AliExpress moved coin collection to mobile-only as of December 2024.

---

## What's new in 2.5.4

**MS Rewards — bail out instead of retry-spamming when Chromium dies mid-run ([#32](https://github.com/feldorn/free-games-claimer/issues/32)).** When the underlying browser process was lost mid-run (user closed the Chromium window via VNC, OOM-killer, container restart, etc.), `microsoft.js`'s per-search retry loop kept logging `Target page, context or browser has been closed` for every search × every retry — 90+ identical error lines back-to-back instead of giving up. Now the retry loop classifies `target/browser/context closed` as a *fatal* error and `throw`s to the caller, so the desktop/mobile session block logs a clean single-line failure and the run-complete summary still emits. The user-facing behavior change is just "obvious clean failure in the log" rather than "wall of identical retry warnings."

---

## What's new in 2.5.3

**Run-Now picker modal ([#32](https://github.com/feldorn/free-games-claimer/issues/32)).** The main page's **Run Now** button now opens a picker modal listing all active services with checkboxes, grouped by category (Claimers / Point-coin collectors / Watchers). Defaults match the historical `CLAIM_CMD_MANUAL` behavior — everything checked except Microsoft Rewards (which adds ~30-45 min to the run because of the humanlike search pacing). User can opt MS in for this specific run, opt anything else out, or use the Select-all / Select-none shortcuts. Click outside or hit Esc to cancel.

Server-side: `POST /api/run-all` now accepts an optional `{ sites: [...] }` body. Backward compatible — no body still fires the historical "everything except MS" chain. With a `sites` body, the chain runs exactly the selected services and `runAllScripts` auto-applies `MS_SKIP_WINDOW=1` if Microsoft Rewards is among them, so a manual MS run doesn't sleep until tomorrow's window.

Surfaced the long-running-MS design as a UI control rather than a silent exclusion — the per-card Run buttons still work for one-off single-service runs, but Run-Now no longer requires per-card-clicking to fire a mixed subset including MS.

---

## What's new in 2.5.2

**Logs tab — fix empty body when returning to a past-log view.** If you selected a past run from the dropdown, then switched to another tab, then came back, the body went blank — `startLogsTabPoll` reset the body to a "Loading…" placeholder and then `pollLogsTab` early-returned in history mode without ever repopulating it. Now we re-fetch and re-render the past log entry whenever the dropdown selection is non-empty on tab re-entry, so the view honors the dropdown state. The dropdown selection is intentionally preserved across tab switches — to see live output from a run that started while you were away, click the dropdown and pick `Live (current run)`.

---

## What's new in 2.5.1

**Notification verbosity control ([#31](https://github.com/feldorn/free-games-claimer/issues/31)).** New `notifications.notifyLevel` setting (env `NOTIFY_LEVEL`, also editable in **Settings → Notifications → Verbosity**) with three values: `all` (default — current behavior), `actions` (silences per-run summary notifications when nothing in the run needed user attention; keeps everything else), `off` (silences all notifications globally — including captchas and login errors). Default `all` preserves existing-deploy behavior; users opt into quieter modes via the new dropdown. Six summary call sites tagged: per-run game-list summaries on Prime / Epic / GOG / Steam (auto-promoted to `action` if any game in the list has `failed` or `action` status — so failures still surface even under `actions` mode), MS Rewards points-earned summary, AliExpress coins-earned summary. Watchers (Humble, Fanatical, Ubisoft, Lenovo, GOG-catalog) and the captcha-pause helper continue to fire under `actions` mode since their notifications are by definition action-required ("new free game found" = "go claim it").

---

## What's new in 2.5.0

**Run-log persistence on the Logs tab ([#29](https://github.com/feldorn/free-games-claimer/issues/29)).** Each completed claim run now writes a full record to `data/runs.json` — start time, source (scheduler-main / scheduler-ms / panel / etc.), exit code, duration, the aggregate `[run]` summary counters per service, and the full ordered log buffer. The Logs tab gets a **Past runs** dropdown above the log view: `Live (current run)` keeps the existing tail-poll behaviour; selecting a past run swaps to read-only mode showing that run's lines with the same timestamp / type-color rendering. Dropdown auto-refreshes when a run completes so you don't need to reload to see the just-finished entry. Capped at `RUN_HISTORY_MAX` entries (default 200, editable via env or in **Settings → Advanced → Logs** — the cap is read dynamically at each persist so a save takes effect on the next run without a panel restart). New API endpoints: `GET /api/runs` for the summary list (no log payload — fast), `GET /api/runs/:at` for a single run's full record. Existing users have no history before this version; first scheduled or Run-Now after upgrade is the first entry. Storage: ~10 MB max at the default 200-entry cap, so no concern.

---

## What's new in 2.4.2

**Epic Games — fix login stall on new-device / new-IP sessions ([#28](https://github.com/feldorn/free-games-claimer/issues/28)).** Epic shows a "Is this the right account?" confirmation prompt between credentials-submitted and the redirect to the claim URL when the login is coming from a new device, IP, or browser fingerprint — a cold start in a fresh container hits this every time. Without an auto-click on the prompt, our flow waited for `URL_CLAIM` that never arrived (the prompt was blocking the redirect) and timed out, presenting as "captcha completed but login fails." Ported the prompt handler from [P-Adamiec/free-games-claimer](https://github.com/P-Adamiec/free-games-claimer) (commit e421633): fire-and-forget `waitForSelector('button#yes, button[aria-label="Yes, continue"]')` with a 30s timeout and a silent `catch`, so already-logged-in or non-prompted sessions see zero behavior change. Surfaced by @DoSpamu's report on issue #28 plus a side-by-side review of the two forks' epic-games.js / aliexpress.js / gog.js (the GOG and AliExpress comparisons surfaced no gaps — feldorn is strictly ahead on those).

---

## What's new in 2.4.1

`RUN_ON_STARTUP` lets the panel fire a claim run immediately after the boot session-check and (optionally) exit afterwards. Built for setups that wake the container on demand — [Sablier](https://github.com/SablierApp/sablier) scale-to-zero, host cron driving `docker start`/`docker stop`, ad-hoc `docker run --rm` — where keeping the panel up 24×7 wastes resources. Requested in [#27](https://github.com/feldorn/free-games-claimer/issues/27).

Three values:

- `0` — Off (default). No behavior change for existing deploys.
- `1` — Run on startup, panel keeps running. Pairs with Sablier-style traffic-based scaling.
- `2` — One-shot (run + exit). Container terminates cleanly after the run completes; cron / `docker run --rm` path.

Editable via env or **Settings → Schedule** as a dropdown. Picking `One-shot` in the UI shows a confirmation modal explaining the post-exit recovery paths (data/config.json wins over env, so env=0 alone won't revert a UI-saved one-shot) and warns when `NOTIFY` is empty. Boot logs print a headless-mode banner with inline disable instructions so anyone tailing logs sees the why and how-to-stop, and an exit banner repeats the same hints right before `process.exit(0)`. Notifications drain on a 1.5s settle before exit. Mode 1 fires the manual chain (`CLAIM_CMD_MANUAL` — claimers + watchers, microsoft.js excluded) so the still-running MS scheduler can handle MS at its proper window without double-running. Mode 2 fires the full chain (`CLAIM_CMD` including `microsoft.js`) with `MS_SKIP_WINDOW=1` so MS runs before the container exits. Both modes pass `NOWAIT=1` so stale sessions fail fast.

**Richer end-of-run notifications for Microsoft Rewards and AliExpress.** Instead of `microsoft-rewards: completed desktop and mobile reward sessions.`, the MS notification now reads `Microsoft Rewards: +120 desktop, +90 mobile, balance 11,540 pts` — falls back gracefully when one or both sessions failed login, with a final fallback to a "no points data captured" line if neither session produced a balance read. AliExpress (which previously sent no notification at all) now emits `AliExpress: +20 coins, balance 480, 14-day streak (+30 tomorrow)` after each daily check-in run, matching the same shape; suppressed when the run produced no data so a notification with no numbers in it isn't sent.

**One-shot UI banner.** When `RUN_ON_STARTUP=2` is the effective config the panel renders an amber banner on every tab — "One-shot mode active — container will exit after the next claim run" — with a sub-line explaining how to revert. Switches to "claim run in progress, container will exit when it finishes" while a startup run is running, so the user sees the impending exit clearly before navigating away or starting something that depends on the panel staying up.

**README warning on restart-policy + mode 2.** The shipped compose template uses `restart: unless-stopped`, which would form an infinite restart loop with mode 2 (exit → docker restarts → run → exit → repeat). Documented in the new Run-on-startup subsection: set `restart: no` (or remove the line) for mode 2 and let the orchestrator own the lifecycle. Mode 1 is unaffected.

---

## What's new in 2.4

New collector: **Lenovo Gaming Key Drops** (watch-only, Phase 1 of a planned auto-claim build-out).

Lenovo runs scheduled key-drops at `gaming.lenovo.com/game-key-drops` — first-come-first-served once they go live, often exhausted within minutes. The default daily-poll watcher pattern (Humble, Fanatical, Ubisoft) doesn't fit: a drop scheduled for 11am could be over before the next morning's watcher run picks it up. Phase 1 builds the schedule-aware infrastructure to land that first round of usefulness — Phase 2 will layer auto-claim + GamesPlanet voucher redemption on top.

What ships:

- **Watcher script (`lenovo-gaming.js`)** — fetches the listing, parses each drop (status from title prefix, region, restock flag), and for new/changed drops descends into the embedded TickCounter widget on the detail page to extract the absolute scheduled datetime. Treats the widget's wall-clock as Eastern Time, converts to UTC via `Intl.DateTimeFormat` round-trip (handles DST automatically), and stores in `data/lenovo-gaming-watch.json`. Diffs against the previous cycle and fires push notifications on: new drop discovered, status transition (coming-soon → active), and restock detection.
- **Per-drop scheduler loop (`lenovoSchedulerLoop`)** — reads the watch JSON, computes pending wakes (1h before / 5min before / at drop-time per upcoming drop), sleeps until the nearest, fires the appropriate push notification, and stamps the per-notification timestamp so the same wake doesn't re-fire on next loop. `fs.watch` on the state file fires scheduler wakeups when the watcher updates it (new drops, collected toggles, etc.) so the next-wake recomputes immediately. Past-target wakes (system was suspended, container restarted) get marked sent without notifying — the user already knows the drop happened. Mirrors the existing main + MS Rewards scheduler pattern.
- **Sessions card UI** — the Lenovo watcher card lists user-actionable drops inline with status pill (Live now / Restocked / Coming soon), title, scheduled time + countdown, "Got it" button, and ↗ open-link. Clicking "Got it" sets `userCollected` on the drop and suppresses subsequent pre-claim wakes for that drop (restock notifications continue, since a restock = new key pool).
- **API endpoint** — `POST /api/lenovo/drops/:id/collected` toggles the collected flag.
- **Activation** — opt-in via `LENOVO_ACTIVE=1` env or Settings → Services. First run establishes a baseline (no notification spam); subsequent runs notify on changes.
- **Engine bump 2.3.x → 2.4.0** marking the new collector + scheduler loop addition.

What's deferred to Phase 2:

- Auto-claim of vouchers from Lenovo (requires login + queue-handling + per-drop UI variation)
- GamesPlanet voucher redemption (requires a second login + per-voucher form submission)
- Steam-key forwarding into the existing batch redeemer

---

## What's new in 2.3.19

- **Prime Gaming summary `skipped` count is no longer hardcoded 0**. The Prime claim loop has three pre-claim bailouts (`PG_TIMELEFT` filter, `DRYRUN` mode, `INTERACTIVE` confirm-cancel) that `continue`d without incrementing any counter; the summary call hardcoded `skipped: 0`. Result: runs with those flags active silently dropped skipped games from the summary. Added a `skippedCount` counter, incremented at each of the three bailout sites (across the main claim loop, the external-store loop, and the DLC loop), and wired it into the `log.summary` call. No-op for default-mode users (none of those bailouts fire by default); accurate for users with the flags set.

---

## What's new in 2.3.18

- **Epic run summary now includes DB-fast-path titles in the already-owned count**. When epic-games.js sees a title's claim DB entry already marked `claimed` (claimed in a prior run), it `continue`s past the full claim flow — but didn't push to `notify_games`, so the run summary's `uniqueByTitle('existed')` count missed those titles. Result: a run where every title was already in library showed "1 already owned" in the summary even when the body listed three titles all logged as already-claimed/already-owned. Fixed by pushing `{ status: 'existed' }` to `notify_games` from the early-bailout path so the summary count matches the body.

---

## What's new in 2.3.17

- **AliExpress coin balance parser handles the new response shape** ([#22](https://github.com/feldorn/free-games-claimer/issues/22)). KairuByte's runs reported `Summary: 0 claimed, 0 skipped, 0 coins` regardless of their actual balance. The `pre_auth.coins` listener was only handling the old name/value array response shape (`d.data.data: [{ name: 'userCoinsNum', value: '1234' }, ...]`). AliExpress shifted some regions to a direct-object shape (`d.data.data: { userCoinsNum: 1234, ... }`) which the parser silently dropped to null. Extended to handle both shapes, plus added a debug dump of the actual response when extraction still produces null — so the next mutation surfaces in the run log instead of disappearing. Also fixed an edge case where a real-zero balance would coerce to null via `Number(0) || null`. AliExpress collector bumped to v2.3.

---

## What's new in 2.3.16

- **Epic claim flow no longer waits 60s per game** ([#21](https://github.com/feldorn/games-claimer/issues/21), [#23](https://github.com/feldorn/free-games-claimer/issues/23) follow-up). 2.3.15's regex selector for the success modal still missed for some users — the modal would render visibly but `text=/Thanks for your order|It.s all yours/i` wouldn't match (likely the heading text is split across multiple span children, or curly-quote rendering differs). The CTA-fallback path correctly recovered claims as `claimed` via the post-click CTA check, but each game still burned the full 60s timeout before falling through. Replaced the single `waitFor` call with a `Promise.race` of three signals: the modal-text regex (kept as a fast-path), the modal's "Continue browsing"/"Download launcher" button selectors (more stable per-popup identifiers), and a `waitForFunction` that polls the page CTA for "In Library" (ground-truth success state). Whichever fires first wins. Steady-state per-claim wait drops from 60s to ~1-2s.

---

## What's new in 2.3.15

- **Epic Games claim detection: handle the new "It's all yours" success popup** ([#21](https://github.com/feldorn/free-games-claimer/issues/21), [#23](https://github.com/feldorn/free-games-claimer/issues/23)). Epic refreshed their post-purchase confirmation in 2026 — heading changed from "Thanks for your order!" to "It's all yours" with the older phrase relegated to subtitle text. The script's `text=Thanks for your order!` selector stopped matching → claim flow logged as failed → fallback CTA-check found the game in library and reported it as "already in library." Result: every Epic claim today logged as `existed` instead of `claimed`. Fixed by switching to a regex selector that matches either phrasing (`text=/Thanks for your order|It.s all yours/i`). Also reclassified the post-failure CTA-check fallback path: if the CTA reads "In Library" after this run's Get-button click, log as `claimed` (the in-library state IS the result of our click), not `existed`. Epic collector bumped to v2.1.
- **`NOVNC_URL` env var to override the noVNC iframe URL** ([#20](https://github.com/feldorn/free-games-claimer/issues/20)). Reverse-proxy users with split subdomains (e.g. `getgames.example.com` for the panel and `getgamesbrowser.example.com` for noVNC) couldn't make the embedded browser view work because the panel hardcoded the iframe URL to `<panel-host>:6080`. Set `NOVNC_URL=https://browser.example.com` (or whatever path serves your noVNC root) and the panel uses that verbatim — both for the embedded iframe and the "Pop out ↗" new-tab button. Falls through to the existing port-suffix construction when unset, so direct-access deployments are unchanged.

---

## What's new in 2.3.14

Panel polling cleanup ([#17](https://github.com/feldorn/free-games-claimer/issues/17)).

- **Pending-redeem counts folded into `/api/state`**. The panel's 10-second background poll previously fired three sequential requests per tick (`/api/state` + `/api/pending-gog-count` + `/api/pending-steam-count`). Counts are cheap to compute (one small JSON read each) and now ride along with state, so the steady-state load drops from 3 requests per cycle to 1. Standalone `/api/pending-gog-count` and `/api/pending-steam-count` endpoints remain for one-off post-redeem refreshes.
- **Polling pauses when the tab is hidden** (Page Visibility API). When you switch away from the panel's browser tab, the poll loop stops entirely — zero requests until you switch back. Re-focusing the tab triggers an immediate refresh so the view is never stale, then the regular 10-second cadence resumes.

Combined effect: a backgrounded panel now generates **zero** background traffic, and a foregrounded panel generates **one-third** of the previous traffic. Bandwidth was always negligible, but the DevTools-network noise is gone.

---

## What's new in 2.3.13

- **Sessions card "↗" icon: handle iframed-panel + cross-origin-isolated destinations**. Sites like Epic Games, Microsoft Rewards, and Steam all send strict cross-origin isolation headers (`Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Opener-Policy: same-origin`). When the panel is iframed inside Organizr (or any sandboxed iframe), Chromium's interaction between iframe sandbox flags and cross-origin isolation requirements blocks `target="_blank"` navigation to those destinations with `ERR_BLOCKED_BY_RESPONSE` — even with the `allow-popups-to-escape-sandbox` token. Added an `onclick` handler that detects iframe context and uses `window.top.location.href` to navigate the top browsing context instead, escaping the iframe entirely. Top-level panel users still get new-tab behaviour as before. Middle-click on the icon also still produces a new tab via the browser's native mechanism. GOG and Ubisoft (which don't set the strict isolation headers) work either way; this fix specifically unblocks the strict-isolation set.

---

## What's new in 2.3.12

- **Sessions card "open in new tab" icon now works inside Organizr's iframe**. The 2.3.11 attempt (`window.open(url, '_blank', 'noopener')`) still failed with `ERR_BLOCKED_BY_RESPONSE` when the panel was iframed inside Organizr — turns out the `noopener` feature interacts badly with iframe sandbox restrictions on cross-origin top-level navigation. Reverted to a plain `<a target="_blank">` anchor with no `rel` attribute, which matches what Organizr's own bookmarks plugin uses (and works in the same sandbox context). Modern browsers (Chrome 88+, Firefox 79+, Safari 12.1+) default `target=_blank` to noopener for cross-origin links anyway, so dropping the `rel` attribute doesn't lose security.

---

## What's new in 2.3.11

- **Sessions card "open in new tab" icon now uses `window.open` instead of `<a target="_blank">`**. Reverse proxies that inject `Cross-Origin-Embedder-Policy: require-corp` (a SWAG default in some configs) can cause Chromium to block cross-origin top-level anchor navigations with `ERR_BLOCKED_BY_RESPONSE` — even for benign destinations like google.com. Switched to a `<button>` that calls `window.open(url, '_blank', 'noopener')` from a click handler; this opens a fresh top-level browsing context and bypasses the policy enforcement that was blocking the anchor flow.

---

## What's new in 2.3.10

- **Microsoft Rewards: claim pending bonus points before they expire**. The dashboard shows a separate banner at the top — `Claim your N bonus points before they start expiring on <date>` with its own Claim button — distinct from the daily activity cards. The script's existing `mee-card:has(.mee-icon-AddMedium)` selector only matched the activity cards, missing the banner entirely. Result: bonus points sat unclaimed until they actually expired. Added `claimPendingBonusPoints()` that locates the `<mee-rewards-pointclaim-banner>` element and clicks its Claim button; runs in both desktop and mobile session blocks after the activity cards. No-op when the banner isn't present (most days). Microsoft collectors bumped to v2.1.
- **"Open in new tab" icon on Sessions and Watcher cards**. Each card's header now has a small `↗` link next to the existing `↻` reset-login icon. Click to open the relevant site in a new tab — useful for checking your account state outside the panel (e.g. seeing your MS Rewards balance, browsing Epic's free-games page). Per-site target picks `homeUrl ?? loginUrl`; Steam and Epic got explicit `homeUrl` registry fields so the link goes to the store landing page instead of the login form. Watchers (Ubisoft, Humble, Fanatical) got `homeUrl` populated to their respective free-items pages.

---

## What's new in 2.3.9

Two reports from #15/#16:

- **Healthcheck no longer 401s when `PANEL_PASSWORD` is set** ([#16](https://github.com/feldorn/free-games-claimer/issues/16)). The Docker `HEALTHCHECK` previously hit `/api/state`, which is gated by the panel-auth middleware — once a password was set, the check returned 401 and orchestrators (TrueNAS, Portainer, etc.) marked the container unhealthy even though the panel was fine. Added a dedicated unauthenticated `/api/health` endpoint that returns `{"ok":true}` and pointed the Dockerfile healthcheck at it. No state is exposed beyond "the process is alive".
- **Microsoft card-fail diagnostic dumps moved to a subfolder** ([#15](https://github.com/feldorn/free-games-claimer/issues/15)). When the Bing-rewards card-click retry fails, the script saves a screenshot + page HTML for later debugging. Those previously landed at `data/ms-card-fail-*.png` / `*.html` next to the per-service JSON DBs, cluttering the data folder. Now writes to `data/diagnostics/microsoft/` (auto-created on first failure).

---

## What's new in 2.3.8

Polish on the 2.3.7 log refactor.

- **Epic dedupes summary counts by title** — the body lines were already deduped (one row per unique title even when Epic returns each game twice for PC + Mobile), but the summary count was still adding up the variants. So the body would list 4 owned games and the summary would say "6 already owned". Both numbers now agree on the unique-title count.
- **Visual gap between service blocks** — runner injects a blank runLog entry above each `───` section header so per-service blocks read as discrete chunks in the panel's Logs tab.
- **No more timestamp jam against `───` / `===`** — section headers and run delimiters render without the per-line `HH:MM:SS` prefix (panel renderer skips the time span entirely when `l.time` is null). Plus a hard space added after the time span on regular lines so even copy-pasted plaintext keeps timestamps visually separated from content (CSS margins don't survive copy-paste).
- **Humble Bundle and Fanatical drop their own name from their own field labels** — `Humble API responses captured: 20` → `API responses captured: 20`, `Free Fanatical products on page: 0` → `Free products on page: 0`. The section header already says which service is running.

---

## What's new in 2.3.7

Run log second pass — strict consistency, less noise.

- **One marker per service instead of two**: collapsed `[RUN-SUMMARY]` + `[RUN-SUCCESS]` into a single `[run] service=<id> ok claimed=N skipped=N <key>=<v> …` line. The `ok` token is the success signal; metrics ride along. Three lines saying the same thing → two (`summary:` for humans, `[run]` for the runner).
- **Strict 3-field summary shape**: every service now emits exactly `summary: <claimed> claimed, <skipped> skipped, <n> <context>` — same column layout, scannable vertically. Service-specific metrics still ride in the `[run]` marker but stop crowding the human line. Watchers always show `0 claimed, 0 skipped` for consistency. Per-service third field: GOG `tracked`, Prime/Epic/Steam `already owned`, Ubisoft/Humble/Fanatical `on page`, Microsoft `points earned`, AliExpress `coins`.
- **Date header / run-complete footer no longer get timestamp-prefixed in the panel**. The header (`=== Free Games Run — 2026-05-06 ===`) is meant as a visual delimiter, not another data row; the runner pushes its `runLog` entry with `time: null` so the Logs tab renders without a `HH:MM:SS` column.
- **Removed the `Scripts finished with exit code N` line** that immediately followed the run-complete footer. The footer already carries the exit code.
- **Run-complete footer always shows `claimed`** (even at 0) so users can scan vertically across days for the headline number.
- **Removed all closing `─────` rulers** at end of service blocks — they were inconsistent (claim scripts had them, watchers didn't) and the leading blank line in `log.section` is enough delimiter. `log.sectionEnd` helper deleted.
- **Steam's `Source:` line dropped** — informational only, didn't pull weight against the consistency cost.

---

## What's new in 2.3.6

Run log readability pass.

- **Run header** at the start of each claim run: `=== Free Games Run — YYYY-MM-DD ===`. Makes it cheap to scroll back through `docker logs` and find a specific day.
- **Run footer** at the end: `=== Run complete: 7 services, 1 claimed, 2 skipped, 142 points earned, exit 0 ===`. Aggregated from per-service markers so it always reflects what actually happened.
- **Universal per-service summary** — every service now ends its block with a one-line `summary: …` (claim services: claimed/skipped/failed/needs manual redeem/already owned; watchers: tracked/new; Microsoft: points earned). Previously only Steam reliably emitted one. Drives the run footer too.
- **Drop redundant `Time:` lines** from each section. The runner already prefixes every log line with HH:MM:SS, so the second timestamp added nothing.
- **`•` glyph for already-owned games** (`log.owned()` helper) — distinguishes "no work needed" from "new action this run" (`✓` via `log.ok`). Applied on Epic and Steam already-in-library messages and GOG already-claimed messages.
- **Epic dedups platform-variant noise** — Epic's API returns each free game twice (PC + Mobile), and the script processed both. The "already in library" log line now appears once per title instead of repeating per platform; per-variant DB state is still updated.

`[RUN-SUMMARY]` markers are emitted alongside `[RUN-SUCCESS]` (parser-friendly key=value shape) so the runner aggregates without scraping human-readable text.

---

## What's new in 2.3.5

- **Sessions cards show last successful run** — replaced the ambiguous `(HH:MM:SS)` session-check suffix with a meaningful "Last Successful Run YYYY-MM-DD HH:MM:SS" line. Each service script emits a `[RUN-SUCCESS] service=<id>` marker via `process.on('exit')` only on clean exit; the runner parses these from stdout and persists per-site completion timestamps to `data/last-runs.json`. Microsoft Rewards is split per-session (microsoft + microsoft-mobile), so each card shows its own last-success time independently. Cards with no recorded run (fresh install) just show the login status without the second sentence.

---

## What's new in 2.3.4

GOG username detection regression fix + DB cleanup ([#9](https://github.com/feldorn/free-games-claimer/issues/9)), plus a small Settings UX tweak.

- **Cookie / profile-link fallback now actually fires when DOM returns a nav label**. The 2.3 (`0665aeb`) fix added "Reviews" to the nav-label guard so it stopped showing as the username, but a latent ordering bug meant the cookie/profile fallback was *before* the guard. So when DOM returned "Reviews", the fallback was skipped (`user` was truthy), the guard then discarded "Reviews", and the script fell straight to the email-prefix last-resort — surfacing as e.g. `User: 2chrisorr` instead of `User: feldorn`. Restructured detection: each source (DOM text, DOM title, cookie/profile-link, email-prefix) is independently run through `cleanCandidate`, cascading until one returns a valid name.
- **One-time DB cleanup**: prior versions of the detection bug fragmented one user's claim history across multiple buckets (`Reviews`, `Games 0`, `Games\n                0`, `unknown`). On next run, gog.js merges any unambiguously-bad legacy username keys into the canonical bucket and deletes the source keys. Idempotent — once merged, subsequent runs find nothing to migrate. Email-prefix-shaped legacy keys are *not* auto-merged (could be a real second account); manual cleanup if needed.
- GOG collector bumped to v2.2.
- **Settings save/discard footer pinned to viewport bottom**. Previously, when the panel grew taller than viewport (iPad / narrow windows), the save bar scrolled off-screen and users had to scroll to find it. `position: sticky; bottom: 0` + a subtle drop shadow makes it always reachable; no-op on desktop where the layout already fits.

---

## What's new in 2.3.3

AliExpress post-collect false-positive fix ([#2](https://github.com/feldorn/free-games-claimer/issues/2)).

- **Recognise "already collected today" as logged-in** — both `aliexpress.js` auth() and the panel's `checkLogin` raced two markers: `button:has-text("Log in")` (logged out) vs `h3:text-is("day streak")` (logged in). When the user had already collected today's coins (manually on another device, or on an earlier run), the streak h3 disappears and the page shows "Earn more coins" — neither marker visible, so both code paths false-failed with "AliExpress page never finished loading" or "Login not detected". Added `button:has-text("Earn more coins")` as a third logged-in signal in both spots. Surfaced by dabziuebu4egh2 in #2 after their cookie-upload login worked at the API level (coin balance returned correctly) but the DOM check still failed. AliExpress collector bumped to v2.2.

---

## What's new in 2.3.2

Prime Gaming pending-redeem age filter ([#14](https://github.com/feldorn/free-games-claimer/issues/14)).

- **Hide stale pending entries** — Settings → Per-Store → Prime Gaming → "Hide pending manual-redeem entries older than N days" (env: `PG_PENDING_MAX_AGE_DAYS`). Filters the per-run notification only; DB entries are preserved so flipping the value off restores them. Default unset = old behavior, every pending entry always shown. Designed for the Microsoft Store / Xbox tail where there's no automated library reconciliation: codes that were either redeemed long ago or have since expired stop spamming the daily notification once you set a sensible cutoff (180 days is a reasonable starting point).

---

## What's new in 2.3.1

Anti-detection hardening (Layers 1+2 of the [#2](https://github.com/feldorn/free-games-claimer/issues/2) plan).

- **Viewport unification** — the panel's session-status check (`checkSiteStatus`) now uses the configured `cfg.width × cfg.height` instead of a hardcoded 1280×720. Sites whose `contextOptions` set their own viewport (AliExpress's Pixel 7 device profile) still win for that site; everywhere else the launch viewport matches the claim-run viewport so the bot-scoring "device dimensions changed between sessions" signal goes quiet.
- **AliExpress fingerprint persistence** — `src/util.js#getOrCreateFingerprint` saves the generated UA + headers to `<profileDir>/.fgc-fingerprint.json` on first run and reloads them on every subsequent run. Sites that already use `fingerprint-injector` (currently only AliExpress) now stop emitting a fresh device-id each launch, which is itself a flag in some bot-scoring systems. AliExpress collector bumped to v2.1; other sites unchanged this release.

---

## What's new in 2.3

Cookie upload on the Sessions dashboard.

- **Cookie upload** — paste an EditThisCookie / Cookie-Editor JSON export into a per-site card and the panel writes it to that site's persistent profile, then re-runs `checkSiteStatus` to confirm the session took. Uses the same mutex that gates Login / Check / Run so it can't race a concurrent claim. Validation rejects malformed payloads before they touch the profile dir.
- **Status-driven login button** — the Sessions card now shows **Login** when the site is not authenticated and **Check** when it is, instead of two buttons that look the same. A small bare ↻ icon in the card header re-runs Login on demand even when the session is healthy (rare, but useful for forced re-auth before suspected bans).
- **Change-accounts confirm modal** — clicking ↻ on a logged-in card now prompts before nuking the existing profile, so a stray click can't lose a working session.

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
