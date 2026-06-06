# Changelog

Release notes for [Feldorn's Free Games Claimer](README.md). Most recent at the top.

---

## What's new in 2.8.30

**New opt-in toggle: `MS_RUN_WITH_MAIN_CHAIN`** — collapses Microsoft Rewards into the main daily run instead of the decoupled MS scheduler. Settings → Services → Microsoft Rewards → *Run Microsoft inline with main chain (skip decoupled scheduler)*, or env `MS_RUN_WITH_MAIN_CHAIN=1`. Default off (existing behavior preserved).

Background: the decoupled MS scheduler (introduced in #10) runs MS on its own daily window — anchored to `MS_SCHEDULE_START` / `MS_SCHEDULE_HOURS` — completely independently from the main Prime/Epic/GOG/Steam loop. That's the right architecture for most users (lets the MS window track Bing's daily score-reset clock), but a handful of users have reported the decoupled scheduler quietly not firing in their environment (#62, #69) and would rather just have MS run back-to-back with everything else. With the new flag on, `legacyCombinedMode()` returns true regardless of `dailyStartTime`/`loop`, so MS rolls into the same daily chain as the other claim scripts — same loop that already works reliably for them. No schedule-window settings apply in this mode.

When to flip it: turn it on if your MS Rewards scheduler has been silent ("no logs, no runs") for multiple days *despite* a configured window and active service. Turn it off (default) for the standard decoupled behavior — independent MS timing, MS continues even if the main chain breaks, etc.

---

## What's new in 2.8.29

**Prime Gaming → GOG auto-redeem is now self-healing on rate-limit.** Previously, when GOG's `/v1/bonusCodes/` endpoint returned `{ reason: "captcha" }` (their rate-limit signal — not a human-solvable challenge), `prime-gaming.js` gave up immediately, the code sat pending in `prime-gaming.json`, and the user had to manually click the panel's Batch Redeem button to retry. That's contrary to the platform's "unattended to the extent possible" philosophy: the rate-limit is transient and a delayed retry almost always succeeds.

New behavior — keeps the user out of the loop on the common case:

- **Same-day cooldown retry in `gog.js`.** The existing reconcile/probe pass now waits **90 seconds** and retries any code that gets a captcha response. That alone catches most rate-limits, since GOG's cooldown is typically under a minute for the kind of bursty traffic Prime Gaming's redeem flow creates.
- **Cross-run retry across multiple days.** Each pending GOG code tracks a `redeemAttempts` counter in the DB. Each daily GOG run advances the counter on persistent rate-limits, until **`PG_REDEEM_MAX_ATTEMPTS`** (default `3`, settable per Settings → Services → Prime Gaming or env) is reached. After that the code is terminal-flagged `claimed, redeem retries exhausted` and surfaces in the Prime Gaming pending-redeem reminder — the genuine "human, please intervene" signal.
- **Actually redeems valid codes.** The probe pass previously detected "valid and redeemable" codes but left them pending for manual redeem; it now clicks through to actually redeem them inline. (Same protocol as the panel's `processOneRedeemCode` — GET to confirm validity, then POST to redeem.)
- **Quieter notifications.** During the auto-retry window, Prime Gaming's pending-redeem reminder skips codes still in budget — they're being handled and don't need to surface in every daily notification. The initial-claim notification reads `"<game>: queued for next run on GOG"` instead of the older `"redeem (got captcha)"` framing that implied user action. Only the genuine give-up state (post-`MAX_ATTEMPTS`) routes back to the manual-redeem notification flow.
- **Batch Redeem button still works as the manual override.** Pending codes (in-budget or exhausted) remain visible to the panel's Batch Redeem flow — users who want to accelerate redemption without waiting for the next daily run can still click the button.

Scope: GOG only for now. Microsoft Store / Xbox / Legacy Games redeems use different protocols and haven't shown the same rate-limit pattern in reports; if it surfaces there, the same model extends naturally.

---

## What's new in 2.8.28

**Two log/notification-text clarifications — no behavior changes, just clearer wording.** Reported by the maintainer after reading their own logs and being puzzled twice:

- **Prime Gaming "captcha" redeem status was misleading.** When `PG_REDEEM=true` and the script tried to auto-redeem a GOG code on `gog.com/redeem`, GOG's `/v1/bonusCodes/` endpoint sometimes returns `{ reason: "captcha" }` — but that's GOG's **rate-limit response**, not a human-solvable challenge. The notification read `"<game>: redeem (got captcha) on GOG"`, which sounds like the user needs to solve a captcha. In practice, the panel's **Batch Redeem** button retries the same code after the rate-limit cools and usually succeeds without intervention. The status now reads `"rate-limited (use Batch Redeem) on GOG"` and the log warn names the right next step (`"GOG rate-limited the redeem (their 'captcha' reason); click Batch Redeem in the panel to retry"`). Internal state machine is identical — just the user-facing text changed.

- **FreeGameFindings Reddit 403 message is now self-explanatory.** The warn line `FreeGameFindings discovery skipped — reddit API: 403` left users wondering whether something was broken (it isn't — Reddit's unauthenticated API rate-limits aggressively, especially on container egress IPs). The thrown error from `src/freegamefindings.js` is now a full sentence: `Reddit API rate-limited (HTTP 403) — supplementary discovery skipped; GamerPower coverage still applies`. Same code path, the log just doesn't leave you guessing.

---

## What's new in 2.8.27

**Stop button no longer triggers a false-positive diagnostic banner.** Pair to 2.8.26: when SIGTERM tears down a script mid-Playwright-operation, the navigation/click in progress throws `Target page, context or browser has been closed` — a perfectly expected side-effect of the user pressing Stop, *not* a bug. But our diagnostics-banner regex was capturing it as a `page.goto` error and prompting the user to share it. Reported by the maintainer immediately after exercising 2.8.26's new fast-stop.

Fix: `src/util.js` now tracks a `shutdownRequested` flag (set by the same SIGTERM/SIGINT handler that aborts pending `delay()` calls). `log.exception` checks it: when shutdown was requested *and* the error message matches the "browser closed" family, it logs `⏹ Aborted (stop requested): <msg>` instead of `✗ Exception: <msg>`. The new prefix doesn't match the diagnostics-banner regex, so no false positive. Other errors during shutdown (e.g. unrelated TypeError) still surface normally — only the known-benign pattern is suppressed.

---

## What's new in 2.8.26

**The Stop button can now interrupt long sleeps mid-run.** Previously, hitting Stop during a long `await delay(...)` (e.g. `MS_SEARCH_DELAY_MAX_SEC=1200` could mean a 20-minute pause between Bing searches) sent SIGTERM but the script would just sit in the timer until it fired — Node's default behavior is to keep the event loop alive while a `setTimeout` is pending. So Stop "worked" but you'd wait minutes for the run to actually exit. Reported during a config-change-mid-run case.

Two complementary fixes:

1. **`delay()` is now interruptible.** `src/util.js`'s sleep helper now registers SIGTERM/SIGINT handlers that abort all pending delays on signal. A 20-minute sleep aborts in ~200 ms when the signal arrives. Every caller (`await delay(ms)`) gets the new behavior with no API change.
2. **`/api/stop-run` now escalates to SIGKILL after 15 s.** Belt-and-braces: if any other operation (Playwright nav, a stuck redirect, a hanging websocket) doesn't bubble up the SIGTERM cleanly, the panel force-kills the process group. 15 s is enough headroom for the script to unwind voluntarily; anything still running after that is genuinely hung.

Combined, Stop now goes from "indefinite wait" → "sub-second cancel" in the common case, with a hard ceiling at 15 s for the exotic stuck-on-something-else case.

Note: configuration changes still don't propagate mid-run (each claim script reads `cfg` once at boot). The clean pattern remains: change config, click Stop, the run exits fast now, hit Run again to start fresh with the new settings.

---

## What's new in 2.8.25

**Steam unrated-game filter is now opt-out, not always-on** ([#61](https://github.com/feldorn/free-games-claimer/issues/61)). The Steam claim filter has always skipped games with zero Steam reviews (`details.rating === null`) under the assumption that "no rating = probably shovelware." But launch-day free indies often legitimately have zero reviews and get missed — @hanafytech reported wanting *IQ Under Construction* (Steam appId 3771740) which was free but got skipped on `no reviews (unrated)`.

New setting **`services.steam.skipUnrated`** (env `STEAM_SKIP_UNRATED`) controls the behavior:

- **Default `true`** — preserves long-standing behavior, no surprises for existing users
- **Set `false`** — unrated games pass the rating filter and proceed to the price filter (so a $10 minPrice still applies; this isn't "claim everything"). Useful for catching launch-day freebies before reviews accumulate.

Available on the Settings tab → Services → Steam, or via the `STEAM_SKIP_UNRATED` env var (legacy fallback). Either way, it's a one-toggle change with backwards-compatible default.

---

## What's new in 2.8.24

**Scheduler no longer gets permanently stuck on a phantom `runProcess`** ([#62](https://github.com/feldorn/free-games-claimer/issues/62)). @dabziuebu4egh2 reported the main scheduler logging `Cannot start run — claim run in progress (panel:microsoft)` once per minute for 20+ minutes, but with no actual MS process running in the logs. Root cause: the `runProcess` cleanup only fires on the child's `close` / `error` events. If the child dies via a path that doesn't trigger those (host OOM-kill, signal swallowed, abnormal exit), `runProcess` stays set forever and every scheduler tick reports "busy" against a phantom.

Two fixes:

1. **Defensive aliveness check in `browserBusy`.** When `runProcess` is set, the function now verifies the underlying pid is actually alive via a `process.kill(pid, 0)` signal-0 probe (costs nothing — no signal sent, just probes the kernel). If the pid is gone, state is cleared automatically with a log line, and the panel proceeds as not-busy. Self-healing on the next scheduler tick.

2. **10-minute backoff in `mainSchedulerLoop` on blocked attempts.** Mirrors 2.8.11's MS-scheduler fix: when `fireScheduledRun` returns false (blocker — another run in progress, batch redeem, interactive Login, etc.), back off 10 min before the next wake instead of tight-looping at `computeMainWakeMs`'s 60 s floor. Even with a *genuinely-long* blocker (not a stale pid), this prevents 60 "Cannot start run" log lines per hour.

Together: stale state self-clears on next scheduler tick (#1); real long-lived blockers no longer spam logs (#2).

---

## What's new in 2.8.23

**Prime Gaming Legacy Games redeem now bails cleanly when `LG_EMAIL` isn't set** ([#63](https://github.com/feldorn/free-games-claimer/issues/63)). With `PG_REDEEM=true` and no `LG_EMAIL` / `PG_EMAIL` / `EMAIL` env var, `cfg.lg_email` was `undefined` and got passed straight to `page.fill('[name=email]', undefined)` — Playwright threw `page.fill: value: expected string, got undefined`, surfacing as a generic cryptic exception that silently failed the redemption. Reported by @bgiesing trying to redeem Nordic Storm Solitaire.

Fix: a pre-check guards the Legacy Games redeem branch. If `cfg.lg_email` is unset, the redeem action is marked `redeem (LG_EMAIL not set)`, the DB row gets `status: 'failed:LG_EMAIL not set'`, and the notification body says exactly which env var to set. The code is still preserved in the DB so a later run with `LG_EMAIL` configured can redeem it.

---

## What's new in 2.8.22

**Privacy fix: diagnostics now redacts apprise webhook URLs and embedded credentials before storing** ([#66](https://github.com/feldorn/free-games-claimer/issues/66)). When an apprise CLI call failed, the full command line — including the live discord webhook / pushover token / mailto password — was being captured verbatim into `data/diagnostics-state.json` and surfaced in the Share-to-GitHub flow. @bgiesing had to manually redact a discord webhook from their auto-generated issue body before posting. That's a real credential-exposure risk: users with less time or attention could paste their webhook publicly.

Fix: a `_redactCredentials` pre-processor now runs on every message and stack line before it's fingerprinted, stored, or shared. It targets:

- **Apprise notifier URLs** across 26 schemes (`discord://`, `pover://`, `tgram://`, `slack://`, `mailto[s]://`, `msteams://`, `ntfy[s]://`, `pushbullet://`, `pushover://`, `gotify://`, `matrix[s]://`, `twilio://`, `signal://`, `rocket[s]://`, `xmpp[s]://`, `webex[api]://`, `wxteams[api]://`, `mattermost[s]://`) — replaced with `<scheme>://<redacted>`
- **URL-embedded credentials** (`scheme://user:password@host`) in any scheme — replaced with `<scheme>://<credentials-redacted>@host`
- **Bearer tokens** and `api_key=...` / `token=...` patterns in body text — replaced with `<redacted>`

The fingerprint is computed AFTER redaction, so the same error across token rotations still collapses to one DB row. 9/9 sandbox cases pass; pure error messages without credentials (ReferenceError, page.goto network errors, etc.) are untouched.

**If you've previously used the Share button on a diagnostic involving an apprise failure**, please review your `data/diagnostics-state.json` and consider rotating any webhooks/tokens that may have appeared in submitted issue bodies. Existing entries on disk can be retroactively scrubbed with the same redaction logic — happy to provide the one-liner if you ask.

---

## What's new in 2.8.21

**Stats now counts manually-rescued Epic claims.** Epic's claim script sets `status: 'manual'` on entries where a previous attempt was marked `failed:*` but a later run found the game in the user's library — i.e. the user manually rescued it through Epic's website after our script gave up. The game *is* claimed; the `manual` label just records that the user, not the script, completed it. `readAllClaims` was filtering on `status.startsWith('claimed')` only, so these rescued claims were invisible to Stats — same shape as the pre-2.8.20 Prime bug, just narrower scope.

Fix: the filter now accepts `manual` alongside `claimed*`. Same precedent as Discoveries-marked manual claims being counted since 2.8.1 (it's still a real claim from the user's POV, even though the script didn't drive it).

Plus a small Steam DB-hygiene chore: a one-time backfill at script start stamps `status: 'skipped:legacy'` on any historical Steam row without a status field — these were rows tracked for games no longer in Steam's current free-games-list, so they couldn't self-heal through the regular filter loop. No user-visible behavior change from the Steam piece; just makes a cold read of `steam.json` self-explanatory.

---

## What's new in 2.8.20

**Pure-Prime claims now actually show up in Stats** — fixing a long-standing data-completeness bug. The internal-Prime claim path in `prime-gaming.js` wrote DB rows with `time`, `url`, `store: 'internal'` — but **no `status` field**. External-store paths (Epic/GOG/MS Store/Legacy) always set `status: 'claimed'` after their click; the internal path never did. `readAllClaims` filters on `status.startsWith('claimed')`, so **every pure-Prime claim ever made on this fork was silently missing from the Stats tab** (KPIs, Per-service, Daily chart, Recent Claims).

The bug is at least as old as the fork. Caught by the maintainer noticing 2 games in Stats vs 3 actually claimed today (Pro Basketball Manager 2026 was the missing one — pure Prime). On the maintainer's instance, the backfill recovered **19 historical claims** (all-time jumped 113 → 132).

Fix in two parts:
1. **Write site (`prime-gaming.js:229-ish`):** internal path now mirrors the external pattern — `db.data[user][title].status = 'claimed'` after the click, matching how Epic/Legacy/GOG redeems already set their status.
2. **One-time auto-backfill (top of `prime-gaming.js`):** at the start of every run, sweep `db.data` and set `status: 'claimed'` on any `store: 'internal'` row that's missing one. Safe because the row only exists if the click landed (line 229 runs after the await). Idempotent on already-set entries. Anyone with historical pure-Prime claims will see their Stats correct themselves on the next Prime run.

No changes needed on the user's end beyond pulling `:latest` and letting the next scheduled Prime run execute (or hitting Run Now). The Stats tab will reflect the backfilled history.

---

## What's new in 2.8.19

**Epic Games: all claims were silently failing — checkout button text changed.** Around 2026-05-28 Epic relabeled the confirm button in their checkout modal (`#webPurchaseContainer` iframe) from **"Place Order"** to **"Add to library"**. The script's two click sites still targeted the old text, so the click never fired and `Promise.race()` timed out without any captcha — every Epic claim silently failed and got mis-classified as "captcha-failed." Caught and diagnosed in detail by @amphoterism on [#59](https://github.com/feldorn/free-games-claimer/issues/59), with the exact selector locations and a screenshot of the new button.

Fix: both locators (main claim path, `epic-games.js` ~line 500, and retry path ~line 637) now match **either** button text — `button:has-text("Add to library")` *or* `button:has-text("Place Order")`. Both preserve the existing `:not(:has(.payment-loading--loading))` guard. Keeping the old text as a fallback means we stay resilient if Epic flips back or surfaces "Place Order" in some regions / flows.

Pull `:latest` (build is auto-publishing) — Epic claims work again. Three free games this week (Calico, LONESTAR, Northgard) are still available, so a manual run after the pull should catch them.

---

## What's new in 2.8.18

**MS Rewards: SwiftShader + explicit WebGL flags to harden the WebGL fingerprint.** Follow-on to 2.8.15 after @mzernetsch's data on [#56](https://github.com/feldorn/free-games-claimer/issues/56) made clear that result-clicking alone wasn't his lever — his solution was a bundle, and GPU/WebGL flags were in it. In a container with no GPU passthrough, Chromium without these flags can end up with WebGL either disabled or in a weird "broken-WebGL" state — both are stronger bot tells than a clean software-rendered WebGL fingerprint.

`microsoft.js`'s `createContext` now passes `--use-gl=swiftshader --enable-webgl` alongside the existing `--ignore-gpu-blocklist --enable-unsafe-webgpu`. SwiftShader gives Chromium a known, consistent software renderer (vendor "Google Inc.", renderer "Google SwiftShader") that looks like a real browser doing software rendering, instead of "no WebGL." Isolated to microsoft.js — other claim scripts use their own launches and aren't affected.

Paired (this same day) with a Settings-side bump of `MS_SEARCH_DELAY_MAX_SEC` to 1200 s (was 180 s) — wider random delay between searches further lowers the cumulative-volume signal MS's risk model tracks. Deliberately bundled (vs. staged single-variable testing) because the cost of waiting on an account already showing the banner is real and the per-flag risk is low.

---

## What's new in 2.8.17

**Lenovo "drop is LIVE" notification now fires even if we're catching up late.** The wake-firing path suppressed *any* wake more than 5 minutes past its target (to avoid stale backlog pings after a container restart). That's right for the pre-alerts — a late "drop in 1 hour" is just confusing — but wrong for the at-drop "LIVE NOW" wake: a limited-key Lenovo drop is usually still claimable for a while after it opens, so a late "it's live, hurry" is still actionable.

Now the suppression threshold is per-kind: `1h-before` / `5min-before` stay at 5 minutes; `wentLive` is allowed up to **12 hours** late before suppressing — long enough to cover a same-day restart across the drop moment, bounded so we don't ping about a drop that's days gone. (`computeNextLenovoWake` already excludes ended/expired/postponed drops, so a `wentLive` wake only exists for one we still believe is live.) When it does fire late, the body is honest about it — "drop is LIVE … Went live ~Nh ago — keys may be limited" instead of an inaccurate "LIVE NOW".

---

## What's new in 2.8.16

**Lenovo drop notifications now re-arm when Lenovo reschedules a drop** — follow-up to 2.8.6. That release fixed the stale-`scheduledAt` refetch (a "Coming Soon" drop whose date Lenovo had bumped), but it corrected only the *date*, not the per-drop wake flags. So a drop whose `1h-before` / `5min-before` / `wentLive` wakes had already been marked sent — against the earlier, now-past date — inherited those "done" flags after the date was corrected, and the real drop-time notification never fired.

Concretely: "Heavy Rain - Game Key Drops pt. 2" was scheduled Apr 15, its three wakes got marked sent on May 14 (suppressed as ">5min late" against the stale April date), 2.8.6 corrected the date to May 27, and then the May 27 drop went live with **no notification** because `computeNextLenovoWake` skips wakes already flagged sent.

Fix: when the watcher detects a drop's `scheduledAt` has actually changed, it now resets the `1h-before` / `5min-before` / `wentLive` flags (keeping `discovered` and `restocked`) so all three pushes re-fire against the new date. Same-date re-confirmations don't reset anything. Verified across reschedule / unchanged / new-drop cases.

Note: a drop that already fired silently before this release (its date is now correct but flags are stale) won't retroactively notify — its wakes are in the past and get suppressed as late. This fix prevents the silent-miss on the *next* reschedule.

---

## What's new in 2.8.15

**MS Rewards search loop now clicks results occasionally, to look more human.** A maintainer hit the *"Unusual search activity may limit your ability to earn points"* banner on a clean residential IP with default timing and matching geo — which rules out IP reputation, velocity, and geo-mismatch, pointing at behavioral detection. The biggest tell: our search loop searched and left **every** time, never clicking a result. Real users who search almost always click something.

`executeBingSearch` now, ~30% of the time, clicks one of the top organic results (biased toward the top 5, where humans click), dwells 2.5–6.5 s like someone reading, and occasionally scrolls — then the next search re-navigates to bing.com as before. The click registers engagement via Bing's own tracking; the destination navigation is incidental. The whole block is best-effort and wrapped — a missing or odd result can never break the search loop.

This is a behavioral-detection mitigation, not a guarantee. If you're on a datacenter/VPS/VPN IP, that's a separate (and stronger) trigger we can't fix from code. See the tracking issue for the full detection-signal breakdown and to report whether you're seeing the banner too.

---

## What's new in 2.8.14

**New "Hide rewards / DLC" filter on the Discoveries tab.** r/FreeGameFindings posts a lot of non-game freebies — in-game outfits, skins, currency packs, GPU/points-gated cosmetic rewards — that land in the "Other" bucket with no price. Because they have no price, the "Min price" filter couldn't catch them (it deliberately keeps unknown-price items so it doesn't false-hide real games we couldn't price), so they cluttered the games view. Example: two `007 First Light - … Outfit` rows that looked like duplicates but were distinct cosmetic giveaways.

The new checkbox (default on, alongside "Hide claimed" / "Hide ignored / skipped") filters items whose title matches a conservative keyword list — `outfit, skin, cosmetic, emote, avatar, wrap, charm, currency, coin(s), gem(s), credit(s), booster, loot, in-game item, dlc` — with word-boundary matching (so "Cities: **Skylines**" doesn't trip "skin"). `bundle` and `pack` are intentionally excluded since they appear in legitimate free-game titles. Items you've explicitly marked as manually-claimed are never hidden by this filter. The toggle state persists per-browser like the others.

Note: this was **not** a dedup bug — the two 007 rows were genuinely different outfits with distinct titles/URLs. 2.8.5's dedup only collapses the *same* item appearing across GamerPower + FGF.

---

## What's new in 2.8.13

**Two root causes behind 2026-05-25's MS-blocked-by-Epic incident finally chased down** (2.8.11 + 2.8.12 were the safety nets; this is the primary fix).

- **False-positive "session expired" notifications.** Every site's `checkLogin()` had a bare `} catch {} → return { loggedIn: false }`. When Epic's `page.goto()` timed out 21 s into a 20 s budget right after a heavy claim run, the timeout was silently swallowed and reported as "definitely logged out." `postRunSessionCheck` only filters out entries with an `error` field — which the catch never set — so a network blip masqueraded as a real logout and fired the notification. All 7 site `checkLogin` catches now `catch (e)` and return `error: e.message`; `postRunSessionCheck`'s existing filter then correctly classifies it as "couldn't check" and stays quiet.

- **Double-launch on notification taps.** `launchSite()` had `if (activeBrowser) await closeBrowser()` — unconditional. When a Pushover notification tap fires the `?login=epic-games` deep-link twice in rapid succession (common across mobile clients), the second call closed the first's browser and opened a fresh context. The user's "I'm Logged In" click then raced the second launch — the verify hit a stale UI or never reached the new context — and the second `activeBrowser` was orphaned. Now: if the request is for the *same* siteId as the existing `activeBrowser`, the launch is idempotent and reuses the existing context with a log line.

Together with 2.8.11's 10-min blocked-attempt backoff and 2.8.12's 30-min stale-session timeout, the morning's exact sequence wouldn't have produced a missed MS slot: the false-positive notification doesn't fire, the double-launch doesn't orphan a second context, and even if it did the timeout cleans it up.

---

## What's new in 2.8.12

**Stale interactive Login sessions now auto-close after 30 minutes.** Companion fix to 2.8.11 — the underlying cause of yesterday's MS slot rolling over was an Epic Games **Login** session left open for 5+ hours (the Login button on a site card sets a server-side `activeBrowser` flag that only clears when the user clicks "I'm Logged In" or the browser is explicitly closed). Without a timeout, a forgotten Login session blocks every scheduler attempt and every manual Run until someone notices.

Fix:
- `activeBrowser` now records an `openedAt` timestamp at launch.
- A new `expireStaleActiveBrowser()` helper auto-closes the session when it's been open longer than 30 minutes. 30 min is generous — typical logins complete in <5 min, captcha solves take <10 min, so anything older is "the user forgot."
- `fireScheduledRun` (the scheduler fire path) and `/api/run-all` / `/api/run-service` (manual Run buttons) call the helper before checking the busy lock. A stale session is closed, then the run proceeds normally.
- A session inside the 30-min window is still respected — won't disrupt a real in-progress login.

A clean Auto-close emits a log line: `Auto-closing stale Epic Games login session — open 47 min, exceeded 30-min idle threshold.` so it's discoverable in the panel logs without being invisible.

This + 2.8.11's blocked-attempt backoff together mean: short blockers ride out the 10-min retries; longer-lived stale sessions get preempted. The MS slot survives both modes.

---

## What's new in 2.8.11

**MS scheduler now backs off cleanly when blocked by another site's session.** Observed on 2026-05-25: the MS run was scheduled for 09:58 inside an 8:00–12:00 window, but Epic Games' interactive browser session was held for the entire morning (likely a "Show browser" tab left open). Every blocked attempt fell through to the v2.8.3 sub-case 2 (repick within remaining window) — which tightens as time passes — yielding 7 rapid retries between 09:58 and 11:59, then rolled to tomorrow when the remaining window dropped below the 90s floor.

Fix: when `fireScheduledRun` returns `false` for a blocked attempt (another site's interactive browser, an in-progress run, batch redeem in flight, …), the MS scheduler pushes the target forward by a fixed **10-minute backoff** instead of recomputing via remaining-window jitter. If the backed-off target would land past today's window end, the slot is marked missed and rolls to tomorrow. The remaining-window-jitter path stays in use for its actual purpose — recovering a fresh container boot inside today's window or a target lost to a restart (v2.8.3, #47).

Today's missed slot can't be recovered programmatically (the window passed by 2.5 hours by the time the fix shipped) — clicking **Run** on the Microsoft Rewards Sessions card runs MS now regardless of schedule. The fix protects future blocked attempts.

---

## What's new in 2.8.10

**Richer diagnostics submissions** (driven by [#50](https://github.com/feldorn/free-games-claimer/issues/50) — flipside101's `[diagnostics] Error in Prime Gaming: All promises were rejected` had a single-line stack with no signal about which selector race actually failed). Three changes work together so future reports auto-include the bits we'd otherwise have to ask the reporter for:

- **Source-side: new `log.exception(err)` helper.** Replaces the `log.fail(\`Exception: ${error.message || error}\`)` boilerplate in every claim script's top-level catch (prime-gaming, epic-games, gog, steam, lenovo-gaming). For `AggregateError` (the shape `Promise.any` rejects with), it also emits `cause[i]: …` lines with the first 2 lines of each inner failure — so a Playwright `Promise.any(['Sign in', 'logged-in marker'])` race that fails now records the timeout error AND the specific selector that didn't match, instead of just the generic "All promises were rejected" message.

- **Capture-side: leading context.** The diagnostics scanner now grabs **6 lines before** the match in addition to **14 lines after** (was 0 + 10), and bumps the per-entry stack cap from 2 KB to 4 KB. The matched line is prefixed with `>> ` so a reader can find it inside the captured block. Section header, prior status lines, and `log.warn` breadcrumbs that preceded the crash are now in the captured stack — usually more useful for triage than 10 lines of Node-internal frames.

- **Fingerprint distinction across `Promise.any` sites.** Previously, two different `Promise.any` failures in the same script (e.g. Prime Gaming's login-state race vs its claim-button race) both collapsed to the fingerprint `(prime-gaming, Error, "All promises were rejected")` — a user shares one and future hits on the *other* site go silent. The fingerprint now also incorporates the first cause line + its selector continuation, so the two sites get distinct fingerprints while same-site repeats (with only line:col differences) still dedup.

Sandbox-tested: 8/8 `log.exception` output cases, 5/5 capture-window assertions, 5/5 fingerprint-distinction cases.

---

## What's new in 2.8.9

**Two follow-ups to 2.8.8's `PG_BASE_URL`:**

- **Settings UI exposure.** The Luna base URL is now a regular Settings → Services → Prime Gaming field (next to "Redeem keys on external stores", etc.) — same as every other per-service setting. The `PG_BASE_URL` env var still works as a fallback when nothing is set in the UI; the resolution order is Settings > env > default, matching every other config field. Removed the redundant Environment-tab entry from 2.8.8 — it now appears in Settings only.
- **`checkLogin()` regression fix.** `src/sites.js`'s prime-gaming `checkLogin()` still had a literal `'https://luna.amazon.com/claims'` from before 2.8.8's `PG_BASE_URL` refactor — meaning the session-status check would hit the US domain even when `PG_BASE_URL` was set. Now uses `this.loginUrl` so it follows the same configured base.

---

## What's new in 2.8.8

**Country-specific Amazon Luna domains now supported via `PG_BASE_URL` ([#52](https://github.com/feldorn/free-games-claimer/issues/52)).** atulrnt reported that Amazon BE redirects users to `luna.amazon.com.be` and the panel rejected cookies from that domain (host-mismatch in the cookie-import check) while `luna.amazon.com` was hard-coded in two places: `prime-gaming.js`'s `BASE_URL` and `SITES['prime-gaming'].loginUrl`.

Set `PG_BASE_URL=https://luna.amazon.com.be` (or whatever country-specific host Amazon redirected you to) and both paths follow: the cookie-import host check accepts cookies from that domain, the per-card "Open browser" button navigates there, and `prime-gaming.js` constructs all claim URLs against that base. The `SITES.loginUrl` is now a getter so the env-var resolves at access time — no module-level snapshot.

Default remains `https://luna.amazon.com` so existing deploys see no behavior change. Trailing slash is trimmed at config-read time. The variable also shows up under Environment → Prime Gaming with usage notes.

---

## What's new in 2.8.7

**Boot-time X server hang on container restarts ([#41](https://github.com/feldorn/free-games-claimer/issues/41), [#51](https://github.com/feldorn/free-games-claimer/issues/51)).** Sahibishere's TurboVNC log finally showed the smoking gun: `_XSERVTransmkdir: Cannot create /tmp/.X11-unix with root ownership`, followed by `Killing Xvnc process ID 24 / Xvnc seems to be deadlocked`, and only ~2 minutes later does a second Xvnc successfully start. WaBiiZ's diagnostics-banner-submitted issue (#51) was the same root cause — Steam's `browserType.launchPersistentContext: Target page, context or browser has been closed`, with `Looks like you launched a headed browser without having a XServer running` in the stack — the panel had spawned a claim run inside that 2-minute hang window.

Root cause: `/tmp/.X11-unix` was persisting across runs with mismatched ownership (different PUID between restarts, podman userns mapping, prior-root-now-non-root flip). When TurboVNC came up as a non-root user, its `_XSERVTransmkdir` couldn't reset the dir's ownership, so the first Xvnc instance hung on the retry, got killed by the supervisor, and a fresh Xvnc started ~2 min later. The existing entrypoint cleanup only removed the inner `X1` socket file, not the dir itself.

Fix: while still root (i.e. before any `gosu` drop to PUID/PGID), the entrypoint now `rm -rf /tmp/.X11-unix` and recreates it as `drwxrwxrwt root:root` (mode 1777 — the standard X11 socket dir convention). The block is guarded on `id -u == 0` so the re-exec'd, non-root second pass of the entrypoint skips it correctly. Verified end-to-end: poisoned `/tmp/.X11-unix` (mode 700, owned by an unmapped uid) recovers cleanly on restart — Xvnc creates its socket inside the freshly-permissioned dir and xdpyinfo's protocol probe succeeds on the first try, no 2-minute deadlock.

---

## What's new in 2.8.6

**Lenovo Gaming "Coming Soon" drops no longer stick at a stale `due now` date when Lenovo reschedules.** A drop's date is pulled once from the embedded tickcounter.com countdown widget on the drop's detail page and then cached in `data/lenovo-gaming-watch.json`. Previously the scraper only re-fetched the detail page when the drop was newly discovered or when its `scheduledAt` was missing entirely — so if Lenovo bumped the date (e.g. April 15 postponed to May 27), our copy stayed on April 15 forever and the panel kept showing `Apr 15 · due now`.

Fix: refetch the detail page whenever a `coming-soon` drop's stored `scheduledAt` is in the past. The condition is narrow (active drops with past `scheduledAt` are correctly "live now" — no refetch needed) and only fires per-drop, so it doesn't add meaningful overhead to a watch cycle. Verified end-to-end against a real Lenovo drop ("Heavy Rain pt. 2") that had drifted 5 weeks stale: one watch run picked up the new date.

---

## What's new in 2.8.5

**GOG notifications no longer list the same game twice ([#48](https://github.com/feldorn/free-games-claimer/issues/48)).** xeropresence reported the "Warhammer Skulls 2026 Digital Goodie Bag" appearing twice in a single GOG notification — once as `(existed)` from the library scan, again as `(via FGF)` from the FreeGameFindings supplementary discovery loop. Steam dedups by appId and Epic uses an "already in queue" check, but GOG's GP/FGF blocks didn't dedup against the library-scan entries already in `notify_games`.

Fix: when GamerPower or FGF iterate their entries, they now check the normalized title against the set of titles the GOG library scan already pushed (regardless of status — claimed or existed) and skip pushing a duplicate. Cross-source dedup also works in both directions (GP-first then FGF, or vice versa). The "Tower of Time" mass-listing test case from 2.8.4's Discoveries-marked-games dedup still passes — the two checks are complementary.

---

## What's new in 2.8.4

**Discoveries-tab marks now suppress duplicate notifications.** If you marked a game as manually-claimed or ignored on the Discoveries tab, subsequent Steam/GOG claim runs no longer emit notification lines for that same game when they re-discover it via GamerPower or FreeGameFindings. Previously a "Tower of Time (via GamerPower)" or "(existed)" line would still show up in the notify body, despite the user having already triaged it in the panel — exactly the spam case the Discoveries-tab marks were supposed to silence.

What the fix does: each claim script loads `data/discoveries-state.json` at start, builds the same `${collector}::${matchKey(title)}` dedup-key set the panel uses, and skips notify-list pushes for any GamerPower / FGF / already-owned entry whose key matches. The shared helper lives in `src/util.js` (`matchKey`, `stripGpTail`, `getDiscoveryUserMarkedKeys`) so all scripts agree on the key shape.

Edge case worth knowing: the GamerPower title-suffix stripper only matches the "(Storefront) Giveaway" shape — GP listings like "Tower of Time (Steam) **Key** Giveaway" keep the "Steam Key Giveaway" in their dedup key. A bare Steam product title ("Tower of Time") won't match that fuller key, so the very next Steam run might still emit one (existed) line. After that, the steam-games.json DB records `status='existed'` and future runs skip silently.

---

## What's new in 2.8.3

**Today's MS Rewards slot no longer gets skipped when the container restarts mid-window ([#47](https://github.com/feldorn/free-games-claimer/issues/47)).** Two related bugs in the decoupled MS scheduler conspired to drop today's run:

- **Fresh-boot picker.** When the panel booted inside the MS window with no prior state file, `pickMsTargetFor` chose a uniform-random offset across the *full* `[msStart, msStart+msHours]` window — including hours already past. The very next check ("pending + target ≤ now") then marked the slot missed and rolled to tomorrow. With an 8–12 window and a 10am first boot, ~50% of users were silently losing today's MS run.
- **Restart inside the window.** If a container update (watchtower, image pull, host reboot) happened between the picked target and run completion, the persisted state was still `pending` and `target ≤ now` on next boot. The same one-shot "mark missed" path triggered.

Fix:
- `pickMsTargetFor` now constrains the random offset to the *remaining* window when picking for today mid-window. The full window is still fair game for tomorrow's pick.
- Boot-time `computeMsWakeMs` now distinguishes three sub-cases when it finds a pending+past target: (1) `last-runs.json` shows MS already ran successfully today between target and now → mark fired and move on; (2) still inside today's MS window → repick a fresh target in the remaining window (60s minimum delay, randomized for anti-detection variance); (3) past window end → mark missed as before.

The "missed runs need manual recovery" principle is preserved for true wake-drift (`feedback_missed_runs_manual_recovery.md`) — this fix only auto-recovers when we can plausibly still fit in today's window.

5/5 sandbox sub-cases pass, plus 100/100 fresh-boot-mid-window picks land in the remaining window (was ~50%).

---

## What's new in 2.8.2

**Two follow-ups to 2.8.1.**

**Manual claims now persist the store URL.** When you mark an item on the Discoveries tab, the source URL (Steam page, itch.io page, GamerPower entry, …) is saved alongside the title and timestamp. Recent Claims rows then become clickable links the same way auto-claimed entries always have been. Existing manual claims from before this version don't have a URL stored — they now render in italic with a "· no link" hint so you can tell at a glance which rows are clickable vs not. Mark them again from the Discoveries tab to attach a URL.

**Update-available link goes to the CHANGELOG.** The "Update available" pill previously pointed at GitHub's bare `/releases/tag/vX.Y.Z` page, which just shows the tagged commit with no notes. It now jumps directly to the matching `## What's new in X.Y.Z` section in `CHANGELOG.md` so you can read what's in the new version before pulling.

---

## What's new in 2.8.1

**Discoveries manual-claims now count toward Stats.** When you mark a game as manually-claimed on the Discoveries tab (✓ button), it now shows up on the Stats tab — KPIs (this week / this month / all-time), Recent Claims, the 30-day chart, and the per-service table all include manual claims alongside auto-claims. New "discovery-only" storefronts (IndieGala, itch.io, STOVE, Mobile, Console, VR, Other) get their own row in the per-service table when you've manually-claimed at least one item from that source — empty rows aren't added for users who don't use Discoveries.

Manual claims for storefronts that also have an auto-claim script (Epic, Steam, GOG, Prime, Ubisoft) roll into that script's existing row — the per-game dedup (by `service` + normalized title) keeps the most-recent record, so marking an item manually that the auto-claimer later picks up doesn't double-count it.

Reported in the 2.8.0 dev cycle: "in discovery, if i mark a game as collected, it's not showing in stats."

---

## What's new in 2.8.0

**Error reporting — opt-out telemetry that helps the project ship faster, without ever sending anything you didn't approve.** Three pieces ship together:

- **Detection.** Every run's stdout/stderr is scanned for crashes (`ReferenceError`, `TypeError`, `Error:`, Playwright `browserType.*` / `page.*` / `locator.*`, apprise `Command failed:`, and the `Exception:` wrapper our claim scripts use). Each error is fingerprinted (SHA-1 of script + class + normalized message) so the same crash hitting on every run counts up instead of stacking duplicates. State persists at `data/diagnostics-state.json`.
- **Banner.** When an unresolved error is detected, a warm-amber banner appears at the top of the panel with three buttons: **Share** (opens a pre-filled GitHub issue in a new tab — you review and edit the body before submitting), **Don't Share** (dismiss just this one), **Never Share** (turn off the feature entirely; a Settings → Notifications checkbox flips it back on). Decisions are sticky per-error.
- **Diagnostics tab.** Full history of detected errors with a fourth `Resolved` state for tracking whether an upstream issue got fixed. Per-row actions adapt to the row's state: Share / Dismiss / Mark resolved / Delete. Toolbar has a global enable/disable toggle and Clear history.

Detection coverage was cross-validated against every GitHub issue with log output (15 bug reports): 12 of 12 regex-shaped bugs would have been caught, plus the controlled live-run test (deliberate `throw` in `fanatical.js` triggered via `/api/run-service`) end-to-end populated the banner and DB correctly. Six issues are behavioral / silent-failure bugs (e.g. "Epic missed 2 free games") that no stack-trace regex can catch — out of scope for this feature.

**Privacy posture:** nothing leaves your host without an explicit Share click. The Share button opens GitHub's `issues/new` with a pre-filled title and body; you see the body before submitting and can redact whatever you want. Set `DIAGNOSTICS_BANNER=0` to hard-disable at boot independent of any DB state.

---

## What's new in 2.7.7

**X-server readiness probe now actually probes X ([#41](https://github.com/feldorn/free-games-claimer/issues/41) follow-up).** The 2.7.3 fix polled for the X11 socket file at `/tmp/.X11-unix/X1` and called it ready when the file appeared. Turns out TurboVNC writes that socket *early* in init — sometimes before X is actually answering connections — so the wait could pass too soon. Sahibishere reported the same `Missing X server or $DISPLAY` errors still hitting on 2.7.6, with the failures happening 30+ minutes after boot. Upgraded the probe:

- Added `x11-utils` to the Dockerfile so `xdpyinfo` is available.
- Entrypoint now waits using `xdpyinfo -display :1` — that makes an actual X11 protocol connection and only succeeds when X is genuinely ready. Falls back to the old socket-file check on older images that don't have `xdpyinfo` yet (graceful upgrade path).
- When the 30-second wait expires without success, the entrypoint now dumps the last 30 lines of `/fgc/data/TurboVNC.log` and points at common causes (stale `/tmp/.X1-lock`, PUID mismatch on `/home/fgc/.vnc/`, insufficient `/dev/shm`, vncserver crash). Boot-time failure diagnosis no longer requires `docker exec` into the container.

Pull `ghcr.io/feldorn/free-games-claimer:latest` (or pin `v2.7.7`). If you still hit the error after the pull, the boot log will now tell you why.

---

## What's new in 2.7.6

**Fix NOTIFY split corrupting single URLs with whitespace ([#44](https://github.com/feldorn/free-games-claimer/issues/44)).** TwoPlayer's `mailto://user:PASSWORD WITH SPACES@gmail.com` URL got shredded into three garbage argv entries because the 2.6.8 fix for the multi-URL Telegram bug split `cfg.notify` on `/\s+/` — too aggressive. Spaces appear inside legitimate URLs (especially mailto passwords); newlines and commas don't.

Switched the split to `/[\n,]+/` with per-piece trim. Both still cover the original YAML-block multi-URL case (newlines) and the apprise comma-list idiom, but single-URL configs with spaces inside the URL now pass through intact. Verified on all three input shapes.

---

## What's new in 2.7.5

**Fix notification deep-links 404'ing on query strings.** User tapped a captcha push and got a download prompt instead of the panel. Root cause: the panel's root handler matched the URL with strict equality (`req.url === '/'`), so any deep-link with a query (`?focus=captcha`, `?login=gog`, `?batch=gog`) made `req.url === '/?focus=captcha'` fall through to the implicit 404. The 404 response carried no `Content-Type` header, so the browser treated it as a generic file and offered to save it.

Every notification deep-link we've shipped uses one of these query shapes — captcha alerts, stale-session login prompts, batch-redeem reminders — so every one of them has been silently 404'ing for anyone tapping them. Fix splits the query off `req.url` before the equality check; works identically for direct access and SWAG-proxied access.

Plus a small follow-on from earlier today (already on `main` since [f6c1ed8](https://github.com/feldorn/free-games-claimer/commit/f6c1ed8)): **dedupe Stats-tab Recent Claims and KPI counts** by `(service, normalized-title)` so platform-variant Epic entries (iOS / Android / locale-stamped slugs) don't double-count. User saw Arranger and Teacup each twice in the Recent Claims list — that's gone now, and the `gamesThisWeek / gamesThisMonth / gamesAllTime` KPI counts reflect unique titles.

---

## What's new in 2.7.4

**Fix apprise priority — pass via URL query param, not the nonexistent `--priority` CLI flag ([#42](https://github.com/feldorn/free-games-claimer/issues/42)).** When the Lenovo notify-priority + captcha-priority features landed in 2.5.8 / 2.7.0, our `notify()` helper appended `--priority <level>` as an apprise CLI flag. **That flag doesn't exist** — apprise's CLI has never had a generic priority option. Priority is per-notifier and configured via URL query string. The bug was silent until apprise actually rejected the arg: JxPv2 hit it on apprise v1.10.0 with `Error: No such option: --priority` whenever a captcha notify fired (Lenovo notifies were probably failing too, just less visibly because Lenovo wakes are infrequent).

Notifies that used the default `normal` priority worked fine — the flag was only emitted for non-normal calls, which is why **Send test** and per-run summary notifications worked while captcha alerts failed.

Fix: when `opts.priority` is non-normal, append `?priority=<value>` to each NOTIFY URL before passing them as positional argv to apprise. URL-encoded; correctly uses `&` when the URL already has a query string. Apprise translates the generic level (low/moderate/normal/high/emergency) to whatever the notifier supports — Pushover honors high/emergency literally, ntfy maps to 1-5, Telegram silent flag, Discord ignores.

No user action needed — existing deployments stay correct without config changes. Captcha and Lenovo alerts will fire with the correct priority on the next image pull.

---

## What's new in 2.7.3

**Wait for TurboVNC X server before starting the panel ([#40](https://github.com/feldorn/free-games-claimer/issues/40), [#41](https://github.com/feldorn/free-games-claimer/issues/41)).** Two reports of `browserType.launchPersistentContext: Target page, context or browser has been closed` accompanied by Playwright's `Looks like you launched a headed browser without having a XServer running` message. Root cause: `/opt/TurboVNC/bin/vncserver` is non-blocking — it forks the X server and returns immediately. The panel was then exec'd before the X socket was actually live, and any auto-session-check (or RUN_ON_STARTUP claim chain) that fired in the next second or two raced the X-server initialisation and crashed.

Particularly common under systemd quadlet autostart on host reboot — the container races other services for I/O and the panel's first Chromium launch lands before TurboVNC has finished setting up `/tmp/.X11-unix/X1`. Both reporters saw their setup stabilise on its own after a manual restart, which is the classic shape of a startup race.

Fix: `docker-entrypoint.sh` now blocks for up to 30 seconds after invoking `vncserver`, polling for the X socket at `/tmp/.X11-unix/X1`. Once the socket appears (typically <2 seconds), the panel exec proceeds. If the socket never appears, a clear warning is printed pointing at `/fgc/data/TurboVNC.log` for diagnosis.

---

## What's new in 2.7.2

**Discoveries roll-up — performance + tab persistence + README callout.** Three small fixes from a single round of live testing.

- **Active tab survives iframe-bust + back.** Clicking a game on the Discoveries tab navigates the top window away; the browser-back button then reloads the panel from scratch. Previously the panel landed back on Sessions because the active-tab state was DOM-only. Initial fix (2.7.1.x intermediate) stashed the tab in the URL hash, but that didn't survive when the panel runs inside a dashboard iframe (Organizr / Homepage / etc.) — the iframe-bust navigates the top window away from the dashboard, browser-back returns to the dashboard URL with no visibility into the panel's hash. Switched to `localStorage` (per-origin, survives navigation cycles in both top-level and iframed contexts). The panel now reliably returns to the tab you came from.
- **Discoveries endpoint cached server-side.** `/api/discoveries` was re-fetching GamerPower + r/FreeGameFindings on every call (~800ms cold). On panel reload where localStorage restored the user to Discoveries, that synchronous fetch blocked first paint and made the page feel sluggish. Added a 5-minute in-memory cache; hit cost drops to <1ms. The Refresh button passes `?force=1` to bypass; mark/unmark POSTs also invalidate the cache so user actions take effect immediately.
- **README intro + Claimers-table callout for aggregator discovery.** The free-game-discovery story improved meaningfully in 2.6.x with the GamerPower + FGF integration, but the README still described the storefronts as if their own first-party feeds were the only source. Added one sentence to the intro and a one-paragraph callout under the Claimers table pointing readers at the live Discoveries view in `docs/PANEL.md`.

Also bundled into this version, originally pushed as small follow-up commits on top of 2.7.1:

- **Minimal noVNC `package.json` shim** baked into the Dockerfile so the connection no longer 404s on `/novnc/package.json` (noVNC's `ui.js` fetches it for the version label).
- **noVNC `mobile-web-app-capable` meta** added at build time in the Dockerfile alongside the existing `apple-mobile-web-app-capable` tag (the apple-only form is deprecated in Chrome).

---

## What's new in 2.7.1

**Settings UX overhaul, doc split, and update-check banner.** Three related polish items addressing usability and discoverability.

**Settings — grid alignment + section hierarchy + credential masking + cross-tab dirty indicator.** Every row is now a 3-column CSS grid (220px label · 1fr control · auto-width revert), so labels start at the same x-offset on every Settings sub-page — the eye no longer re-anchors when moving from Scheduler to Notifications to Advanced. Section headers bumped from 10px/0.08em to 12px/0.12em with a stronger divider rule so they visually dominate field labels. A small `● = field is overridden from default. Click Revert to restore.` legend appears at the top of each pane making the dot's meaning discoverable.

Apprise URL field is now masked by default with a **Reveal** toggle — the URL embeds bearer tokens (`pover://USER_KEY@APP_KEY`, `tgram://botid:chatid/`, etc.) that were leaking on every screen-share and screenshot. Sidebar tabs get a small yellow dirty-count badge when fields in another section have pending changes — easier to see at a glance which tabs have un-saved work.

**README split into `docs/`.** The README had grown to 1,100+ lines. New shape: a slim landing `README.md` (~110 lines: header, services tables, feature highlights, screenshots tour, quick-start, doc index) plus six topic-focused docs:

- [docs/INSTALL.md](docs/INSTALL.md) — Docker, Compose, bare-metal, non-root
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — Env vars, notifications, scheduling
- [docs/PANEL.md](docs/PANEL.md) — Tour of all seven panel tabs + Settings reference
- [docs/AUTH.md](docs/AUTH.md) — Automatic login + cookie upload + captcha pause
- [docs/NETWORKING.md](docs/NETWORKING.md) — Reverse-proxy setups
- [docs/REFERENCE.md](docs/REFERENCE.md) — Bot detection, data storage, HTTP API, troubleshooting

Discoveries tab gets its own screenshot in `docs/PANEL.md`; Settings screenshot refreshed to show the new grid alignment + legend.

**Update-available banner ([#39](https://github.com/feldorn/free-games-claimer/issues/39)).** New panel header pill that appears when a newer release is published. Polls `api.github.com/repos/feldorn/free-games-claimer/releases/latest` (and falls back to `/tags?per_page=20` when no releases are published — the fork uses git tags, not GitHub Releases) every six hours; cached in `data/update-check.json` so reloads don't hammer GitHub. Clicking the pill opens the release notes. Manual `docker pull` + restart still required to actually apply the update — we deliberately do **not** call the host docker socket (would need it mounted into the container, a real security concern).

Set `UPDATE_CHECK=0` to disable for offline / air-gapped deployments.

---

## What's new in 2.7.0

**Discoveries tab v2 — storefront sub-tabs, filter bar, per-row actions, user-state persistence.** Built in response to the user trigger "I want to highlight what needs my attention" — the v1 single-list view forced you to scan every entry across both aggregators every time. Now:

- **Sub-tabs by storefront.** Each destination store (Epic / Steam / GOG / Itch.io / IndieGala / STOVE / Mobile / Console / VR / Prime / Ubisoft / Other) gets its own tab with a count badge. Empty tabs hide automatically so the nav stays compact. "All" is the firehose; per-store tabs filter to one destination. Tab order is by coverage state (auto → manual) so the most actionable storefronts surface first.
- **Storefront classification extended.** FGF title-prefix patterns now cover Itch.io, IndieGala, STOVE, Mobile (`[Android]`/`[iOS]`/`[Mobile]`), Console (`[PS4]`/`[Xbox]`/`[Switch]`), and VR (`[Oculus]`/`[Rift]`/`[Quest]`). GamerPower entries fall back to a title-parenthetical hint (`<Name> (IndieGala) Giveaway`) when their platforms field is just `PC` — caught from real-world data where Indiegala / Stove / Itch.io entries were all bucketed as Other.
- **Sticky filter bar.** Search by title (live), Min-price dropdown ($0 / $5 / $10 / $15 / $20 / $25; hides items below threshold when worth is known, leaves unknown-price items alone), Hide claimed (default on), Hide ignored / skipped (default on — SKIP-forecast items are treated as implicitly ignored). State persists in localStorage so it survives panel reloads.
- **Per-row actions.** Each row gets 🚫 Ignore and ✓ Mark claimed buttons; ↺ Undo reverses them. Marks persist server-side in `data/discoveries-state.json`, keyed by `${collectorKey}::${normalizedTitle}` so the same game discovered by both GamerPower and FGF dedupes to one state entry — marking one flips both immediately (optimistic update, then server roundtrip). State entries auto-prune 14 days after their mark date when the game has dropped out of all aggregator feeds, so the file stays bounded.
- **CLAIMED + SKIP forecasts.** AUTO items the user already has in their store DB get a blue CLAIMED badge (cross-references claim DBs by URL slug + Steam appId + edition-stripped title). Steam items below `STEAM_MIN_PRICE` get a red SKIP badge with the worth chip highlighted, so you can see exactly which setting caused the skip.
- **ReadComments routing.** FGF posts with `link_flair_css_class === 'ReadComments'` (random-key distributions on NVIDIA/IndieGala/etc.) now link to the Reddit thread instead of the redeem endpoint — the redeem page is useless without a key from the comments. Coverage label gets a hint pointing back at the store URL for once-you-have-a-key redemption.

Backend: new `/api/discoveries/mark` + `/api/discoveries/unmark` endpoints; `/api/discoveries` now folds user-state into every item and includes a stable `dedupKey` field.

**Captcha notification deep-links + configurable priority.** When Epic / GOG / AliExpress hits a captcha mid-claim, the push notification now includes the panel's `?focus=captcha` deep link — tapping it auto-opens the browser view on the active service so you can solve the slider/hCaptcha without hunting through tabs. Plus a new Settings → Notifications → Captcha priority field (env `CAPTCHA_NOTIFY_PRIORITY`, default `high`) so the alert breaks through Pushover's DnD / quiet hours — captcha iframes time out in minutes and a delayed-by-2-hours notification is useless.

---

## What's new in 2.6.9

**Fix stale Chromium profile locks after container restart ([#37](https://github.com/feldorn/free-games-claimer/issues/37)).** Lifeng77X reported AliExpress refusing to launch with:

> The profile appears to be in use by another Chromium process (PID) on another computer (HOSTNAME). Chromium has locked the profile so that it doesn't get corrupted.

Root cause is a Docker + persistent-volume + Chromium interaction. Chromium writes `SingletonLock` / `SingletonCookie` / `SingletonSocket` files in the user-data-dir on every launch and removes them on clean shutdown. Ungraceful exits (container kill, host reboot, OOM) leave the files behind. The kicker: `SingletonCookie` stores the *hostname* that launched Chromium, and Docker assigns a *new* auto-generated hostname every container recreation. So the leftover lock from a previous container looks like "another computer", and Chromium refuses to use the profile. Once present, the lock never clears on its own.

Fix: every `launchPersistentContext` call site now runs `cleanProfileLocks(dir)` first, which removes the three known lock files. Belt-and-suspenders: the panel also sweeps all known profile dirs at startup, so a fresh container boot recovers instantly. The app's existing runtime mutex (`browserBusy`) already prevents two Chromium processes from racing on the same profile dir, so deleting the locks is safe.

If you hit this on an existing deployment before pulling 2.6.9 you can also remove the files manually:
```bash
docker exec <container> sh -c 'rm -f /fgc/data/browser*/Singleton*'
docker restart <container>
```

---

## What's new in 2.6.8

**Fix multi-URL `NOTIFY` ([#35](https://github.com/feldorn/free-games-claimer/issues/35)).** When `NOTIFY` was configured as a multi-line YAML block (one URL per line — the standard pattern for multiple notifier endpoints), the helper passed the entire string as one positional argv to apprise. Older apprise releases parsed the embedded newlines forgivingly; apprise ≥ 1.10 treats the concatenated string as a single URL and rejects the second protocol — Telegram's colon-heavy URL shape (`tgram://bot_token:chat_id/`) trips on this first, so it looked like "Telegram is broken" while Discord on the first line still went through. Fix: split `cfg.notify` on whitespace before assembling argv, so each URL becomes its own positional argument and apprise sees them independently. Existing single-URL deployments (the common case) keep working identically.

KairuByte's reproduction in the issue ran on apprise v1.10.0 with a YAML `NOTIFY: |\n  discord://…\n  tgram://…` shape — that's exactly the case this fix resolves.

---

## What's new in 2.6.7

**Discoveries tab polish.** Two small follow-ups to the SKIP work in 2.6.6:

- **Uniform badge widths.** AUTO / SKIP / NOTIFY / MANUAL / CLAIMED ranged from 4 to 7 characters, so the title column landed at different x-offsets row to row. `min-width:68px` + `text-align:center` gives every badge the same horizontal footprint.
- **Cross-source price bridge.** SKIP forecasting was only working on GamerPower (the only aggregator that exposes a `worth` field). The same Steam giveaway in r/FreeGameFindings still showed AUTO because Reddit posts don't carry price metadata. Now: when GamerPower lists the same title, the FGF entry inherits the price by edition-stripped title match, and the SKIP forecast fires consistently across both sections. Worth chip also displays in both sections now (was previously only on the GamerPower side).

---

## What's new in 2.6.6

**Discoveries tab — SKIP badge for items your settings will filter out.** When a Steam giveaway shows AUTO in Discoveries but its price is below your `STEAM_MIN_PRICE` threshold, the next run will skip it. Now Discoveries forecasts that and shows a red **SKIP** badge instead, with the offending price highlighted in red in the meta line so the cause is obvious at a glance. Tooltip on the badge explains exactly why ("Your Steam minimum price is $10 — this is $4.99…") with a hint at how to override (lower the threshold in Settings → Services → Steam, or claim manually via the link).

Currently forecasts Steam's price skip (visible in GamerPower's `worth` field). Steam's rating skip can't be forecast from aggregator data — only the live Steam page exposes review counts, and pre-fetching every Steam page would slow Discoveries down — so rating skips still show as AUTO and reveal themselves at runtime. Sort order updated to MANUAL → NOTIFY → SKIP → AUTO → CLAIMED so configured-to-skip items group near the other actionable states.

---

## What's new in 2.6.5

**Discoveries tab — CLAIMED badge for items already in your library.** The AUTO badge now means "will be auto-claimed on the next run if not already" — items that *are* already in your library get a separate **CLAIMED** badge (blue) so you can tell at a glance what still needs doing vs what's been handled. Cross-references each aggregator entry against the per-store claim DBs (`data/epic-games.json`, `data/steam.json`) using URL slug + Steam appId for Epic / Steam FGF entries, and falls back to a normalised-title match for GamerPower entries (which don't expose a direct store URL).

Also reordered the in-section sort: **MANUAL → NOTIFY → AUTO → CLAIMED**, top-to-bottom. Manual items (the ones requiring user action — Itch.io, mobile-only when EG_MOBILE is off, etc.) now surface first; already-claimed items drop to the bottom as informational. Matches the typical workflow: you open Discoveries to find what to do, not to admire what's done.

---

## What's new in 2.6.4

**External-link mode setting — Discoveries / footer links honor iframe context (and an explicit override).** User reported Discoveries-tab links erroring out *after* the GamerPower CF fix: clicking through landed on the GamerPower page fine, but then clicking GamerPower's "Open Giveaway" button failed because the panel was running inside a reverse-proxy dashboard iframe and the new tab inherited iframe sandboxing that Epic / Steam refuse to render in. The site-card and Lenovo-drop links already had an iframe-aware click handler (`openSiteUrl`) that navigates the top window when iframed — but the Discoveries-tab links and the GitHub footer links were plain `target="_blank"` without it. Now they all use the same handler.

Plus a new Settings field — **Panel link → External link behavior** — with three modes:
- **Auto** (default) — auto-detect iframe context; break out via top-nav when embedded, new tab when top-level.
- **Same tab** — always navigate the top window (replaces the current page). Useful if you prefer same-tab navigation regardless of context.
- **New tab** — always force new-tab semantics (may fail in some embedded contexts; included for unusual setups).

Env var: `EXTERNAL_LINK_MODE`.

---

## What's new in 2.6.3

**Discoveries tab — fix Cloudflare-gated link errors + footer GitHub links.** User reported many Discoveries-tab links erroring out when opened in a new tab. Root cause: we were linking to GamerPower's `open_giveaway_url` field, which is the `/open/<slug>` redirect page — Cloudflare gates it aggressively and a cold browser tab without a CF session gets a 403 challenge instead of the giveaway content. GamerPower's API also exposes `gamerpower_url` (the public listing page for the same giveaway), which is clean 200 with no CF challenge. Switched to that. The user lands on the public page, reads the offer, and clicks GamerPower's own "Open Giveaway" button, which establishes the CF session correctly so the subsequent click works. r/FreeGameFindings links were already direct store URLs and unaffected.

**Compact footer links — Repo · Issues · Discussions.** Always-visible footer below all tabs gives users a direct way to interact with the project. Tooltip on Discussions calls out that new aggregator-source suggestions belong there. Took the simplest path (plain links to the existing GitHub spaces) over a submission form — no auth, no submission backend, no spam exposure.

---

## What's new in 2.6.2

**Discoveries tab — surface aggregator listings with clickable links.** When 2.6.0/2.6.1 added GamerPower and r/FreeGameFindings as supplementary sources, anything we couldn't auto-claim (iOS / Android giveaways with EG_MOBILE off, Itch.io games, STOVE, etc.) only existed as log lines — no in-panel way to act on them. The new **Discoveries** tab fetches both aggregators live on open and renders every active listing with a clickable store link plus a coverage badge: **AUTO** (green) for items we auto-claim, **NOTIFY** (yellow) for notify-only items like GOG, and **MANUAL** (purple) for everything else — Itch.io, Epic Mobile when EG_MOBILE is off, platforms without a collector. The user's case that triggered this: spotting an iOS-only Epic giveaway in the FGF feed and wanting to claim it via the App Store on their phone — now a direct link to `store.epicgames.com/p/…-ios-…` is one click away.

Items sort within each source by coverage state (auto first, then notify, then manual) so what needs attention surfaces at the top. Refresh button does a force-refetch; otherwise re-entering the tab uses the JS-memory cache. Per-source errors degrade independently — if GamerPower is having a bad day, the FGF section still renders.

Backend: new `/api/discoveries` endpoint that parallel-fetches both aggregators and classifies every entry against the same collector-pattern map the claim scripts use, so the badges always reflect the *actual* runtime behavior (toggle EG_MOBILE off and the iOS giveaways flip from AUTO to MANUAL on the next refresh — no code change).

---

## What's new in 2.6.1

**Second aggregator source: r/FreeGameFindings ([#33](https://github.com/feldorn/free-games-claimer/issues/33) follow-up).** DoSpamu pointed at three third-party aggregators when reporting the Devil's Island gap; 2.6.0 covered [gamerpower.com](https://www.gamerpower.com/), and 2.6.1 adds the [r/FreeGameFindings](https://www.reddit.com/r/FreeGameFindings/) subreddit as the second source. The subreddit's posting rules enforce a structured `[Epic Games]`, `[Steam]`, `[GOG]`, `[Itch.io]`, `[STOVE]`, ... title prefix and a Reddit `link_flair_css_class` of `Expired` / `PreviouslyGiven` / `PSA` etc. that we use to drop stale and non-actionable posts cleanly.

Unlike GamerPower, Reddit posts link directly at the store URL — no Cloudflare-gated redirect step. That makes this aggregator both cheaper per entry (single HTTPS request, no patchright tab) and more reliable. The integration follows the same pattern as the GamerPower one: per-collector filter (Epic, Steam, GOG), URL validation against the collector's store domain, merge into the existing claim queue (Epic/Steam) or notify-only surface (GOG). The collectors' own dedupe logic (Epic `urls.includes`, Steam `knownIds`) catches the substantial overlap between the two aggregators silently.

Three subtle filter rules: (1) PSA megaposts that point back at the Reddit comments thread are skipped — selftext parsing them is Phase 2; the same games typically also show up as individual platform-tagged posts. (2) Cross-posts of Lenovo Key Drops giveaways (URL `gaming.lenovo.com`) are skipped because our Lenovo watcher already alerts on those — without this, every Lenovo drop would surface twice. (3) Posts older than 72h are skipped to keep the noise floor low.

Run log now shows two unhandled-platforms summaries (one per aggregator source) — e.g. `FreeGameFindings — platform tags without a collector/watcher: Itch.io (12), Amazon Prime (3), STOVE (2)` — covering "what to consider building next" from both sides.

Reddit identifies us as `free-games-claimer/2.6.1 (https://github.com/feldorn/free-games-claimer)` per their User-Agent policy. Single request per collector per run; well under the unauthenticated 60 req/min cap.

---

## What's new in 2.6.0

**Supplementary discovery via gamerpower.com ([#33](https://github.com/feldorn/free-games-claimer/issues/33)).** Some free games slip past our first-party feeds — DoSpamu reported on 2026-05-14 that *Devil's Island* and *Lost in the Hole* were free on Epic but absent from Epic's own `freeGamesPromotions` API and the `/free-games` page's "Free Now" section (third-party launch promos that Epic routes through their store without flagging on the surfaces our collectors scrape). [GamerPower](https://www.gamerpower.com/) aggregates these. We now query their public API once per collector and merge results into the run.

Coverage: **Epic**, **Steam**, **GOG** (the three collectors that work cleanly today). For Epic and Steam, GamerPower entries get auto-claimed — we follow each `gamerpower.com/open/…` redirect inside the collector's already-authenticated patchright context to capture the canonical store URL, then run the normal claim path. For Steam specifically, only `store.steampowered.com/app/N` results are auto-queued (sub/community/etc. paths are too varied to claim safely). For GOG, the integration is **notify-only** — same juice/squeeze framing as the existing GOG catalog watch: GOG claim UIs are too varied to auto-claim without live promos to test against. Unresolved or non-claim-shape entries surface as manual-action items in the run summary with the GamerPower link, tagged as `action` so they trigger notifications under the `actions` notify level.

Also: each run now logs a one-line summary (from `epic-games.js`, which typically runs first) of GamerPower platforms we don't currently handle — e.g. `GamerPower — platforms without a collector/watcher: Itch.io (7), Android (2), iOS (2)`. Per the user's request: if a platform shows up consistently across weeks, that's a candidate for a new collector or watcher.

Behavior is best-effort. The GamerPower /open/ page sits behind a Cloudflare challenge — patchright usually passes it (real Chromium executing the challenge JS), but when resolution fails we fall back to surfacing the title + GamerPower URL as a manual action so nothing silently drops. Run-summary counts and dashboard counters update normally.

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
