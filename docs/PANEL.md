← [Back to README](../README.md)

# Control Panel

Tour of the seven panel tabs, plus the in-app Settings reference.

---

## Control Panel

The control panel at **`http://localhost:7080`** is always running and
organises everything under seven tabs. The header compresses to ~70px once
setup is complete, so the main area is free for whichever tool you're in.
A compact footer below the tabs links to the project's GitHub repo,
issues, and discussions — use **Discussions** to suggest new aggregator
sources or share tips with other users.

### Sessions tab (default)

<p align="center">
<a href="../assets/panel-show-browser.png" target="_blank"><img alt="Show browser — embedded noVNC view of an active claim run" src="../assets/panel-show-browser.png" width="800"/></a>
<br/>
<em>Show browser — embedded noVNC view with all session cards collapsed to mini-tiles. Click for full size.</em>
</p>

Responsive grid of cards — one per site (Prime, Epic, GOG, Steam, MS Rewards,
MS Mobile, AliExpress, plus active watchers: Ubisoft, Humble, Fanatical,
Lenovo). Grid layout auto-adapts between 1/2/3/4 columns depending on
viewport width. Cards within each group sort alphabetically.

- **Status dot** (green / red / gray) backed by real URL-based auth checks
  (`/account` redirects, ME Control DOM presence, etc.), not cached UI.
- **Logged in as \<username\>** pulled per-site from the right source for each
  — GOG via API, Microsoft via the ME Control widget, Prime / Epic / Steam
  via the persistent chrome on their respective dashboards.
- **Login button** launches a visible Chromium in the embedded noVNC window.
  Solve captchas / MFA / phone verification manually, then click **I'm Logged
  In** to verify and persist the session. The browser's yours while it's open
  — clear captcha cookies, verify game ownership, redeem codes in a side tab;
  anything stays in the session. The button label is status-driven: shows
  **Login** when the site is not authenticated and **Check** when it is.
- **Cookie button** writes a JSON cookie export from the browser of your
  choice into the site's persistent profile, then re-runs the session check
  to confirm login took. Solves the case where in-container login is too
  brittle (fingerprint-gated bot challenges, hardware MFA, etc.) — see
  [Cookie upload](AUTH.md#cookie-upload) below.
- **↻ icon** (top-right of card) forces a re-login on a session that's
  already healthy. Useful before a suspected ban or when rotating accounts.
  Prompts for confirmation so a stray click can't nuke a working session.
- **Run button** (per-card) triggers a single-service claim run. For
  Microsoft Rewards this also passes `MS_SKIP_WINDOW=1` so a manual test
  click doesn't sleep until the next scheduled MS window.
- **Show browser** (header) mounts the live noVNC iframe on demand,
  regardless of run state — peek at what a script is actually doing during
  a claim run, not only during interactive logins. **Pop out ↗** sibling
  appears once the iframe is mounted and opens the same view in a new tab
  for full-screen / second-monitor use.
- **Status strip** rolls up "All N sessions OK", "Login needed for X",
  "Run in progress", and startup auto-check into one row, with "Next run
  in 1h 15m · Last run 3h ago (success, 4m)" on the right.
- **Captcha banner** appears at the very top of every tab (not only
  Sessions) when a runner has flagged a pending captcha — see
  [Captcha pause](AUTH.md#captcha-pause) for the flow.
- **Collapse caret** in the bottom-right corner of the header folds the
  full session-cards strip down to a single row of mini-cards
  (`Prime Gaming ✓` / `GOG ✕` / etc.) so the noVNC iframe / run log gets
  full vertical space. Click the caret, the status strip itself, or the
  mini-card row to toggle. Persisted across reloads.
- During an active login the stepper and full cards auto-hide regardless
  of the user-collapse state, so the noVNC viewport gets the room it needs.

**Batch Redeem** surfaces automatically when Prime Gaming has delivered GOG
codes that weren't successfully redeemed (captcha-gated, script interrupted,
etc.). Opens the GOG redeem page per pending code — solve the captcha once
in noVNC and the panel drives the rest of the queue; re-challenges pause
and wait for you.

### Stats tab

<p align="center">
<a href="../assets/panel-stats.png" target="_blank"><img alt="Stats tab — KPI tiles, per-service table, 30-day chart, recent claims" src="../assets/panel-stats.png" width="800"/></a>
<br/>
<em>Stats tab — KPI tiles, per-service table, 30-day chart, recent claims. Click for full size.</em>
</p>

Derived entirely from the existing per-service JSON DBs plus
`data/microsoft-rewards.json` (see [Data Storage](REFERENCE.md#data-storage)). No new
instrumentation was added to the claim scripts beyond the MS balance
snapshot.

- **KPI tiles:** Games this week / this month / all-time · Last claim
  (relative time + service · title) · MS Rewards balance · MS points earned
  this week.
- **Per-service table:** this-week / this-month / all-time counts + last
  claim time for Prime / Epic / GOG / Steam. Microsoft rows use the same
  layout but show points-earned per session (desktop / mobile) with a `pts`
  suffix.
- **30-day chart:** flexbox bar chart with y-axis scale, weekly x-tick
  labels anchored to today, zero-count days shown as a faint stub so the
  axis stays continuous. Total appears in the section heading.
- **Recent claims:** last 10 successful claims as a grid with relative time,
  service, and the game title linking to its store URL.

### Schedule tab

<p align="center">
<a href="../assets/panel-schedule.png" target="_blank"><img alt="Schedule tab — next-run wall times, intervals, last-run status" src="../assets/panel-schedule.png" width="800"/></a>
<br/>
<em>Schedule tab — next-run wall times, intervals, services list, last-run status. Click for full size.</em>
</p>

- **Next run:** wall time (`2026-04-20 07:30`) with a live countdown
  (`in 22h 8m`) updated every 30s.
- **Next run · Claimers / Next run · MS Rewards:** in decoupled mode the two
  schedules each get their own row with wall time and a live countdown
  (`in 22h 8m`). Today's MS pick badge shows status (`pending` / `fired` /
  `missed today — Run manually`).
- **Interval rows** translate the active config: "Daily at 08:00", "Every 4h
  anchored at 08:00", "Every 6 hours from completion", or "Random within
  08:00 → 12:00 daily" for MS.
- In legacy combined mode (no `START_TIME` and no `LOOP` but
  `MS_SCHEDULE_HOURS` set) the panel falls back to a single "Next run" row
  plus an "MS window" row.
- **Last run:** short wall time + source + status (success/error/finished) +
  duration.
- Pause/resume is a planned follow-up.

### Logs tab

Monospaced scrollable viewer for run output. Polls `/api/run-log` at 1s
while a run is active and 3s otherwise, stops polling when you switch
tabs. Independent of the Sessions tab — you can leave the noVNC visible
on Sessions while a run's log streams here.

A **Past runs** dropdown above the log view switches between live tail
and historical runs. Each completed run is persisted to `data/runs.json`
with its full log buffer + summary counters; the dropdown lists the
last N runs (default 200, configurable via `RUN_HISTORY_MAX`) newest
first with a one-line summary `2026-05-09 07:30 · 8 svc, 2 claimed,
24 owned · 23s · success`. Selecting a past run swaps to read-only
mode; selecting `Live (current run)` resumes tail polling. Auto-refreshes
when a run completes so the just-finished entry appears without a
manual reload.

### Discoveries tab

<p align="center">
<a href="../assets/panel-discoveries.png" target="_blank"><img alt="Discoveries tab — community aggregator listings with coverage badges" src="../assets/panel-discoveries.png" width="800"/></a>
<br/>
<em>Discoveries tab — community aggregator listings with coverage badges. Click for full size.</em>
</p>

Live view of community aggregators
([gamerpower.com](https://www.gamerpower.com/) +
[r/FreeGameFindings](https://www.reddit.com/r/FreeGameFindings/)) — every
currently-active free-game listing, with a clickable store link and a
coverage badge that tells you exactly what the next run will do:

- **MANUAL** (purple) — outside our auto-claim coverage. Click to
  claim manually. Examples: Itch.io games, mobile-only giveaways when
  Epic mobile is off, STOVE / smaller storefronts.
- **NOTIFY** (yellow) — we send a notification but don't auto-claim
  (GOG; the claim UI varies too much for a safe auto-path).
- **SKIP** (red) — your settings will skip this on the next run.
  Currently fires for Steam entries below your `STEAM_MIN_PRICE`
  threshold. The offending field (the price chip) is highlighted in
  red and the tooltip says exactly which setting caused the skip —
  lower the threshold in Settings → Services → Steam if you want
  it claimed, or use the link to claim manually.
- **AUTO** (green) — will be auto-claimed on the next scheduled run
  (Epic, Steam, Epic Mobile when `EG_MOBILE=1`).
- **CLAIMED** (blue) — already in your library. The Discoveries tab
  cross-references each entry against the per-store claim DB by URL
  slug, Steam appId, and edition-stripped title — `Sunderfolk` on
  GamerPower correctly matches `Sunderfolk - Standard Edition` in
  the Epic DB.

Items sort top-to-bottom by actionability (MANUAL → NOTIFY → SKIP →
AUTO → CLAIMED) so anything needing your attention surfaces at the top.
Each row also shows the platform tag, upvote count (FGF) or end date
(GamerPower), and a tooltip explaining the coverage state. Per-source
errors degrade independently — a GamerPower fetch failure doesn't hide
the FGF section.

Use this when you spot something we can't auto-claim — an iOS-only Epic
launch promo for example — and want a direct link to the store to claim
it manually (open the link, claim through the storefront, done).

### Settings tab

<p align="center">
<a href="../assets/panel-settings.png" target="_blank"><img alt="Settings tab — Services accordion with per-service flags" src="../assets/panel-settings.png" width="800"/></a>
<br/>
<em>Settings tab — Services accordion. Every runtime flag <code>src/config.js</code> reads is editable in-app. Click for full size.</em>
</p>

Full in-app configuration. Four sections (Scheduler, Notifications, Services,
Advanced) accessible via a left rail so changing a single field takes one
click, not a scroll past every other section. Every field listed in
`CONFIG_SCHEMA` is editable here. Docker env is the initial default; in-app
saves take priority. See [Settings](#settings-in-app-configuration) for how
precedence, progressive disclosure, and hot-reload work.

### Environment tab

Read-only diagnostic view of every environment variable the app reads,
grouped by category (Panel infrastructure / Data paths / Credentials /
Debug). Credentials are hidden behind an explicit "Reveal credentials" click
with last-4-char masking. Separated from Settings so 40+ rows of
env reference don't compete with the settings controls.

### Alerts tab

The single place to see everything that needs your attention. Four sections, each hiding itself when empty:

#### Pending redeems

Prime Gaming manual-redemption codes (MS Store / Xbox / GOG) plus Steam keys collected from any service (Prime, Fanatical, etc.) that haven't been activated yet. Each row shows the game title, the source (Prime Gaming → MS Store / Steam key from `<service>`), the redeem URL, the code (styled as a monospace copy target with `user-select: all`), and two action buttons:

- **Mark redeemed** — sets `status: 'redeemed'` on the entry. Use this after you've entered the code externally.
- **Dismiss** — sets `status: 'dismissed'`. Use this when the offer expired, the code was invalid, region-locked, or you just want to stop being reminded without confirming an actual redemption.

Both actions write the terminal status back to the underlying JSON DB (`data/prime-gaming.json` for Prime entries; the per-service DB the code was collected from for Steam entries) so the pending-redeem notification loop stops surfacing them on future runs.

#### Stale sessions

Active services whose most recent session check reported `not_logged_in`. Each row has a **Log in** button that deep-links to the Sessions tab's login flow for that service. Uses the panel's cached session-status — for a fresh probe, use the **Check** button on the site's Sessions-tab card.

#### New in Discoveries

Count-only pointer to unread items in the Discoveries tab (GamerPower + r/FreeGameFindings picks not currently auto-claimed — iOS giveaways, Itch.io drops, GOG promos, etc.). Clicking **Go check** switches to the Discoveries tab so you can triage.

#### Errors (formerly the standalone Alerts tab)

Error history with one-click sharing back to the project. When a run
crashes, the panel scans the script's stderr for exception patterns
(JS standard classes, Playwright/patchright protocol errors, the
top-level `Exception:` line every claim script emits) and records each
failure as a deduplicated **fingerprint** in `data/diagnostics-state.json`.
The fingerprint is a hash over `(script, errorClass, message, normalized
stack)` so the same failure across many runs collapses into a single
row with `count`, `firstSeen`, `lastSeen`.

The tab shows every captured fingerprint as a table row with:

- **Script** (which claim flow failed)
- **Error class + message** (the actionable summary)
- **Count** + first/last seen (how often, when)
- **Stack / context** (the captured log lines around the failure)
- **Decided state** — `pending` (banner-eligible), `shared` (user clicked
  Share), or `dismissed` (user clicked Don't Share). Per-fingerprint
  sticky so the same error doesn't re-nag.
- **🗑 Delete** + **Share** row actions

#### Error-report banner

While the Alerts tab is the full history view, day-to-day the user
mostly sees the **banner** that surfaces on top of every panel tab when
there's an undecided fingerprint. Three buttons:

- **Share** — opens a pre-filled GitHub-issue URL in a new tab. The body
  includes script name, error class + message, count + first/last seen,
  app version, the captured log context (last ~25 lines before the
  exception + 15 after, clamped to 6000 chars), and a **Config & run
  state at error time** `<details>` block with:
  - Scheduler mode (`legacy-combined` / `decoupled` / `loop-only` /
    `manual`), `dailyStartTime`, loop seconds, `runOnStartup`
  - MS scheduler shape: window (`startHour + hours`) or
    `inline (MS_RUN_WITH_MAIN_CHAIN=1)` or off
  - Active services list
  - Per-service flags: `PG_REDEEM` + max attempts, Steam filters
    (`skipUnrated` / `minPrice` / `minRating`), MS pacing
    (`searchDelayMax` / `redeemThreshold`), notification level,
    `BASE_PATH` / `PUBLIC_URL` / `NOVNC_URL` presence
  - Credentials-set booleans per service (never the values)
  - Last 3 runs from `data/runs.json` (timestamp, status, claimed count)
  - Runtime: Node version, platform, arch, `LANG`, `TZ`

  You review the body on GitHub before submitting — nothing is auto-posted.

- **Don't Share** — marks this single fingerprint as `dismissed`. Banner
  hides until the next *new* error.

- **Never Share** — disables the banner entirely (writes
  `diagnostics.enabled=false` in `data/diagnostics-state.json`). The full
  Alerts tab still records errors and the toggle in
  Settings → Notifications can re-enable.

#### Redaction guarantee

Before any fingerprint is hashed or persisted, message + stack go through
a redaction pass that strips:

- Apprise notifier URLs (`discord://<webhook>`, `pover://<apptokens>`,
  `tgram://<bot:token>@<chat>`, `mailto://user:pass@host`, etc.) for all
  26 supported apprise schemes — replaced with `<scheme>://<redacted>`.
- URL-embedded credentials in any scheme (`https://user:pass@host` →
  `https://<credentials-redacted>@host`).
- Bearer tokens / `api_key=` / `token=` patterns of 8+ chars.

This was tightened after [#66](https://github.com/feldorn/free-games-claimer/issues/66),
where a Discord webhook leaked into a captured `Command failed:` line —
the same redaction now applies before write, so the in-disk JSON
(`data/diagnostics-state.json`) never holds live credentials either.

#### When false-positives are suppressed

Pressing the panel's **Stop** button gracefully terminates an in-flight
run by sending SIGTERM. Playwright then throws
`Target page, context or browser has been closed` from whatever
navigation/click was in progress — which without the suppression would
trip the diagnostics scanner and surface a banner for an error the user
just caused. `log.exception()` in `src/util.js` checks the
`shutdownRequested` flag set by our SIGTERM handler and rewrites the
log prefix to `⏹ Aborted (stop requested):` (which doesn't match the
diagnostics regex), so Stop-induced browser-closed errors stay off the
banner.

### Notification deep-links

When `PUBLIC_URL` is set (the panel's externally-reachable URL), Pushover /
Telegram / etc. notifications include tap-targets that go straight to the
relevant action:

- Stale-session notification: per-site link like `?login=gog` that auto-opens
  the Login flow when you land.
- Pending-redeem notification: includes `?batch=gog` header link that
  auto-starts the batch-redeem when you land.

### First-time setup

1. Start the container (see [Docker Compose](INSTALL.md#docker-compose)).
2. Open the panel at `http://localhost:7080` (or your `PUBLIC_URL` if
   reverse-proxied).
3. Wait for the startup auto-check banner to finish (~30s).
4. Click **Login** on each site showing red — solve whatever GOG / Amazon /
   Epic / etc. asks for in the embedded browser.
5. Once all site cards are green, visit **Settings** to tune
   scheduling / notifications / per-service flags. You're done. Come back
   to the panel if a session expires (Pushover will notify).

---

## Settings (in-app configuration)

The Settings tab ships a single **sticky save footer** (`N unsaved changes ·
[Discard] · [Save]`) that appears only when the form is dirty. All dirty
fields commit together in one PUT. Each field has an **ⓘ info button** that
reveals the help text and env-var name on demand, plus a green dot when the
app config is the authoritative source — no permanent per-row chrome. Revert
only renders on rows that actually have an override to revert.

### Precedence

```
data/config.json   (written by Settings tab)
     ↓  falls through when undefined
process.env.<VAR>  (docker env / .env file / config.env)
     ↓  falls through when missing or empty
hardcoded default
```

Revert a field to go back from `app` to `env`/`default` without editing
the file directly.

### Sections

- **Schedule** — `START_TIME`, `LOOP`, `MS_SCHEDULE_HOURS`, `MS_SCHEDULE_START`.
  Changes apply immediately via `fs.watch` — the scheduler wakes up and
  recomputes its next run. No container restart.
- **Notifications** — `NOTIFY`, `NOTIFY_TITLE`, `PUBLIC_URL`. A
  **Send test** button fires apprise with the *current* effective config,
  so you can tweak the URL and test without a restart.
- **Services** — one accordion row per registered service: claimers (Prime,
  Epic, GOG, Steam), point/coin collectors (Microsoft, Microsoft Mobile,
  AliExpress), and watchers (Ubisoft, Humble, Fanatical, Lenovo). Each row
  shows the service name, a summary like `Redeem on · DLC off · Timeleft
  none`, and an Active checkbox. Click the row to expand and edit
  per-service flags (Prime's `PG_REDEEM` / `PG_CLAIMDLC` / `PG_TIMELEFT`,
  Epic's `EG_MOBILE`, GOG's `GOG_NEWSLETTER`, Steam's `STEAM_MIN_RATING` /
  `STEAM_MIN_PRICE`). Deactivating hides the service from the Sessions grid
  and skips it in claim runs; reactivating requires one click.
- **Advanced** — `DRYRUN`, `RECORD`, `TIMEOUT`, `LOGIN_TIMEOUT`, `WIDTH`,
  `HEIGHT`.
(The read-only environment view has moved to its own top-level
[Environment tab](#environment-tab).)

### What stays env-only

Credentials (`*_EMAIL`, `*_PASSWORD`, `*_OTPKEY`, `*_PARENTALPIN`),
panel infrastructure (`PANEL_PORT`, `NOVNC_PORT`, `NOVNC_URL`, `BASE_PATH`,
`PANEL_PASSWORD`, `VNC_PASSWORD`), data paths (`BROWSER_DIR`,
`SCREENSHOTS_DIR`), and debug flags that only affect fresh subprocesses
(`DEBUG`, `DEBUG_NETWORK`, `TIME`, `INTERACTIVE`, `NOWAIT`, `SHOW`).
Credentials stay env-only by design — storing them in plaintext JSON on
disk is a net loss vs. an env var in docker-compose, and the session-
cookie flow already handles the steady state.

### Hot reload vs next-run reload

- **Scheduler settings** apply within one second via `fs.watch` on
  `data/config.json`.
- **Everything else** (notifications, per-service flags, advanced flags)
  is re-read by the claim scripts at the top of each run, so saving takes
  effect on the next claim run. No restart required.
