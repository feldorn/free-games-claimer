← [Back to README](../README.md)

# Configuration

Environment variables, notifications, and scheduling — everything you can tune without touching code.

> Many of these settings are also editable in the panel — see [Settings tab](PANEL.md#settings-tab).

---

## Configuration

Options can be set in two places:

1. **Settings tab in the control panel** (recommended for runtime tweaks) —
   writes `data/config.json` and takes priority over env. Every field shows
   its env var name in muted monospace for reference. See
   [Settings](PANEL.md#settings-in-app-configuration) for details.
2. **Environment variables** — initial defaults. Pass directly, use
   `--env-file`, or put them in `data/config.env` (loaded automatically by
   dotenv). Env is also the only way to set things that stay env-only:
   panel ports, `PANEL_PASSWORD`, credentials.

The env-var tables below document what each variable does; anything in them
that's also on the Settings tab can be edited there at runtime instead.

### General

The recommended-for-Docker set — same shape as the [docker-compose
example](INSTALL.md#docker-compose) above:

| Option | Default | Description |
|--------|---------|-------------|
| `EMAIL` | | Default email for all logins (per-store override available below) |
| `PASSWORD` | | Default password for all logins (per-store override available below) |
| `NOTIFY` | | Notification URL(s) for [apprise](https://github.com/caronc/apprise) (Pushover, Telegram, Slack, etc.) — used for claim summaries, login issues, and captcha pause |
| `LOOP` | | Main-schedule interval in seconds (e.g. `86400` = 24h). Without `START_TIME`, sleeps N seconds after each run completes (drifts by run duration). Drives the non-MS chain only — Microsoft Rewards is on its own schedule. |
| `START_TIME` | | Wall-clock anchor `HH:MM` (24h) for the main schedule. When set, the non-MS chain wakes at this time each day; with a sub-daily `LOOP` (e.g. `14400` = 4h) the anchor seeds the sequence and runs land at `08:00, 12:00, 16:00, 20:00, 00:00, 04:00`. Microsoft Rewards is independent — see [Microsoft Rewards Options](#microsoft-rewards-options). |
| `START_DAYS` | `0,1,2,3,4,5,6` | Day-of-week mask on the anchored schedule (comma-separated, `0=Sun … 6=Sat`). Only consulted when `START_TIME` is set. Default = all seven days (backward-compatible). Examples: `START_DAYS=4` (Thursdays only), `START_DAYS=1,3,5` (Mon/Wed/Fri). See [Day-of-week filter](#day-of-week-filter). |
| `GH_USERNAME` | | Your GitHub username. When set, the panel polls your issues on `feldorn/free-games-claimer` once a day (anonymous REST, no token) and surfaces new reply activity as an Alerts-tab section. Opt-in via a one-time modal at first Share-to-GitHub click — skipping keeps this empty and the feature silently disabled. Change requires a panel restart. |

**Behind a reverse proxy?** See [Reverse-Proxy Setup](NETWORKING.md#reverse-proxy-setup)
for `BASE_PATH`, `PUBLIC_URL`, and `NOVNC_URL`.

<details>
<summary><strong>Advanced env vars (rarely-touched defaults)</strong></summary>

| Option | Default | Description |
|--------|---------|-------------|
| `NOTIFY_TITLE` | | Optional title for notifications |
| `NOTIFY_ATTACH_SCREENSHOTS` | `1` | Attach the most recent screenshot to failure notifications. Set to `0` to keep notifications text-only (privacy / bandwidth). Also editable in **Settings → Notifications**. |
| `CLAIM_CMD` | (active services in claim order) | Shell command the scheduler runs at its anchored wake. Built dynamically from the active services in the registry's claim order; set this to override with a fixed pipeline. |
| `CLAIM_CMD_MANUAL` | (active services minus microsoft) | Shell command for a manual chain run *with no sites picker* (e.g. driven from an external invocation). Since 2.5.3 the panel's **Run Now** button opens a per-run picker modal where the user checks specific services for that run; the picker defaults match this exclusion (everything except microsoft.js, since a paced MS run adds ~30-45 min). Override this env only if you have a CLI / cron caller that needs a fixed pipeline. |
| `SHOW` | `1` (Docker) | Show browser GUI. Default is headless outside Docker. |
| `WIDTH` | `1920` | Browser/screen width |
| `HEIGHT` | `1080` | Browser/screen height |
| `VNC_PASSWORD` | | VNC password. No password by default. |
| `BROWSER_DIR` | `data/browser` | Browser profile directory |
| `TIMEOUT` | `60` | Timeout in seconds for page actions |
| `LOGIN_TIMEOUT` | `180` | Timeout in seconds for login |
| `DEBUG` | `0` | Set to `1` for verbose debug output |
| `PUID` | | **Opt-in non-root mode.** When set, the entrypoint reconciles a runtime user `fgc` with this UID, chowns `/fgc/data`, and drops privileges via `gosu`. Unset = container runs as root (default, unchanged). See [Running as a non-root user](INSTALL.md#running-as-a-non-root-user). |
| `PGID` | `$PUID` | GID to pair with `PUID`. Defaults to the same value if only `PUID` is set. |
| `RUN_HISTORY_MAX` | `200` | Cap on entries kept in `data/runs.json` (the Logs-tab "Past runs" history). Older entries are trimmed when this limit is exceeded. Each entry is one full run including its log buffer; ~10 MB max at the default. Also editable in **Settings → Advanced → Logs**. |
| `LOGIN_MODE` | — | **Deprecated no-op** — the control panel is always running on port 7080. Safe to remove from your config. |

</details>

### Per-Store Credentials

Each store can use the default `EMAIL`/`PASSWORD` or be overridden individually:

| Store | Email | Password | OTP Key | Other |
|-------|-------|----------|---------|-------|
| Epic Games | `EG_EMAIL` | `EG_PASSWORD` | `EG_OTPKEY` | `EG_PARENTALPIN` |
| Prime Gaming | `PG_EMAIL` | `PG_PASSWORD` | `PG_OTPKEY` | `PG_REDEEM=1`, `PG_CLAIMDLC=1` *(currently a no-op — Amazon removed the in-game DLC section in 2026; flag still respected for when it returns)* |
| GOG | `GOG_EMAIL` | `GOG_PASSWORD` | | `GOG_NEWSLETTER=1` |
| Steam | `STEAM_EMAIL` | `STEAM_PASSWORD` | | `STEAM_MIN_RATING`, `STEAM_MIN_PRICE` |
| Microsoft Rewards | `MS_EMAIL` | `MS_PASSWORD` | `MS_OTPKEY` | `MS_SCHEDULE_HOURS` |
| AliExpress | `AE_EMAIL` | `AE_PASSWORD` | | `AE_ENABLED=1` (opt-in; disabled by default; **deprecated** — web channel being phased out by AliExpress, see [Bot detection](REFERENCE.md#bot-detection--what-works-what-doesnt)) |
| Ubisoft Connect | — | — | — | `UBISOFT_ACTIVE=1` (opt-in; disabled by default). Watch-only — no login, no auto-claim. |
| Humble Bundle | — | — | — | `HUMBLE_ACTIVE=1` (opt-in). Watch-only. |
| Fanatical | — | — | — | `FANATICAL_ACTIVE=1` (opt-in). Watch-only. |
| Lenovo Gaming Key Drops | — | — | — | `LENOVO_ACTIVE=1` (opt-in). Watch-only with per-drop wakes (1h / 5min / at drop time push notifications). |

### Steam-Specific Options

| Option | Default | Description |
|--------|---------|-------------|
| `STEAM_MIN_RATING` | `6` | Minimum review rating (1-9). 9=Overwhelmingly Positive, 6=Mostly Positive, 1=Overwhelmingly Negative |
| `STEAM_MIN_PRICE` | `10` | Minimum original price in USD. Filters out cheap/shovelware titles. |

Steam discovery uses [Steam's own search endpoint](https://store.steampowered.com/search/?specials=1&maxprice=free) (`specials=1&maxprice=free` — discounted-to-zero items). Free-to-play games and free-weekend trials are excluded automatically by Steam's specials filter. The script then checks each candidate's review rating and original price against the thresholds above before claiming. Previously discovery was via SteamDB; that source is now blocked by Cloudflare for our Chromium fingerprint, see [2.0.3](../CHANGELOG.md) for the full migration story.

### Microsoft Rewards Options

| Option | Default | Description |
|--------|---------|-------------|
| `MS_EMAIL` | | Microsoft account email (falls back to `EMAIL`) |
| `MS_PASSWORD` | | Microsoft account password (falls back to `PASSWORD`) |
| `MS_OTPKEY` | | TOTP secret for automatic 2FA (otplib). Only needed if the account uses app-based TOTP, not phone push approval. |
| `MS_SCHEDULE_HOURS` | `0` | MS-schedule window width in hours. When set (and `START_TIME` or `LOOP` is also set), the scheduler picks a random clock time inside the window each day and fires `microsoft.js` independently of the main chain. `0` = MS rides the main chain (no separate window). |
| `MS_SCHEDULE_START` | `8` | Window start hour (0–23). With `MS_SCHEDULE_HOURS=4` and `MS_SCHEDULE_START=8`, MS runs land randomly between 8am and 12pm each day. Today's pick is persisted to `data/ms-schedule-today.json` so config saves don't reshuffle the displayed timestamp. |
| `MS_SEARCH_DELAY_MAX_SEC` | `180` | Upper bound (seconds) for the random pause before each Bing search and between consecutive searches. With ~60 searches per run, this dominates total runtime: avg ≈ N × value/2 seconds. Default 180 paces searches like a human; lower values (e.g. `30`) shorten runs to a few minutes but increase the risk of MS flagging the account as a bot. Lower bound stays 1s. |

Microsoft Rewards collects daily points by running a desktop Bing session (33–37 searches) and a mobile session emulating a Pixel 7 (23–27 searches), plus clicking any pending activity cards. Search terms are sourced fresh each run from Google Trends and BBC/ESPN RSS feeds, with a 30-day dedup window to avoid repeating terms. The existing 800-term pool is used as fallback when live sources are unreachable.

---

## Notifications

Notifications are sent via [apprise](https://github.com/caronc/apprise) for:
- Successfully claimed games
- Failed claims (the most recent screenshot from `data/screenshots/` is attached
  when the apprise target supports attachments — Pushover, Discord webhooks,
  Telegram, etc. Useful when the failure is visual: captcha, broken layout,
  unexpected modal)
- Login issues (expired sessions, captchas — see [Captcha pause](AUTH.md#captcha-pause))

Set `NOTIFY` to one or more apprise service URLs. Examples:

```sh
# Pushover
NOTIFY='pover://user@token'

# Telegram
NOTIFY='tgram://bottoken/ChatID'

# Multiple services
NOTIFY='pover://user@token' 'tgram://bottoken/ChatID'
```

See [apprise documentation](https://github.com/caronc/apprise#supported-notifications) for all supported services.

### Verbosity (`NOTIFY_LEVEL`)

Four levels, settable via env or **Settings → Notifications → Verbosity**:

| Level | Per-run summaries (claim list, points, coins) | Action-required (login issues, captchas, errors, watcher new-items, redeem reminders) |
|---|---|---|
| `all` (default) | ✓ fires | ✓ fires |
| `actions` | ✗ silenced (when nothing in the summary needs attention) | ✓ fires |
| `digest` | 📅 buffered → one aggregated notification per day at `NOTIFY_DIGEST_HOUR` local time | ✓ fires real-time |
| `off` | ✗ silenced | ✗ silenced |

Per-run game-list notifications on Prime / Epic / GOG / Steam are automatically promoted from "summary" to "action" when any game in the list has `failed` or `action` status — so failures still notify under `actions` and `digest`. The summary buffering only applies to the boring "0 claimed, 24 already owned" case.

Watcher notifications (Humble, Fanatical, Ubisoft, Lenovo, GOG-catalog) and the [captcha-pause](AUTH.md#captcha-pause) helper always fire under `actions` because their notifications are by definition asking the user to do something. `off` silences everything globally — captchas and login errors included — so use it deliberately.

**Digest mode specifics:** The summary buffer lives in `data/notification-digest.json` so a mid-day container restart doesn't lose accumulated entries. The daily aggregated notification body includes the list of buffered run summaries plus a top-line hint of any outstanding items on the Alerts tab (pending redeems, stale sessions) so noise-reduction doesn't hide items that actually need your attention.

Configure the flush time via `NOTIFY_DIGEST_HOUR` (env) or **Settings → Notifications → Verbosity → Digest hour**. Default is `8` (08:00 local — arrives at breakfast for most schedules). Valid range 0-23. Only consulted when `NOTIFY_LEVEL=digest`.

---

## Scheduling

The built-in scheduler runs **two independent schedules** so the long Microsoft
Rewards window doesn't block the rest of the claim chain.

```yaml
environment:
  - LOOP=86400          # main-chain interval in seconds
  - START_TIME=08:00    # main-chain wall-clock anchor (HH:MM)
  - MS_SCHEDULE_HOURS=4 # Microsoft Rewards window width (hours)
  - MS_SCHEDULE_START=8 # Microsoft Rewards window start hour
```

- **Main schedule** (`START_TIME` + `LOOP`) fires the non-MS chain — every
  active claimer and watcher in the registry's claim order (GOG, Prime, Epic,
  Steam, AliExpress, Ubisoft, Humble, Fanatical, Lenovo). With `START_TIME`
  set, runs land on the wall clock; without, `LOOP` sleeps N seconds after
  each run completes. Lenovo additionally registers per-drop wakes (1h
  before / 5min before / at drop time) on top of the daily chain pass.
- **MS schedule** (`MS_SCHEDULE_HOURS` + `MS_SCHEDULE_START`) fires
  `microsoft.js` alone at a random clock time inside the window. The picked
  time is persisted to `data/ms-schedule-today.json` so config saves don't
  reshuffle the displayed "Next MS run" timestamp.

If a run is already in progress when the other schedule fires, the second
one queues behind it (single shared browser profile). If the MS pick has
already passed by the time the container restarts, today's MS run is marked
**missed** rather than auto-firing late — trigger it manually from the MS
card if needed. Tomorrow's pick is fresh.

**Legacy combined mode (back-compat).** If you have neither `START_TIME` nor
`LOOP` set but do have `MS_SCHEDULE_HOURS`, the scheduler keeps the pre-#10
behavior: a single chain anchored 30 minutes before the MS window, with
`microsoft.js` doing its own internal wait. Set `START_TIME` or `LOOP` to opt
into the decoupled two-schedule mode.

### Day-of-week filter

The anchored main schedule accepts an optional **day-of-week mask** so you can
run only on specific days (e.g. weekly Thursdays, or Mon/Wed/Fri) without
resorting to cron. Only consulted in anchored mode (`START_TIME` set) — pure
interval-from-completion has no wall-clock day-of-week semantics.

- **Env var**: `START_DAYS` — comma-separated ints where **`0 = Sunday`** …
  **`6 = Saturday`** (matches JavaScript `Date.getDay()` numbering).
- **In Settings**: `Scheduler → Run on days` — 7 checkboxes rendered whenever
  Start time is set. Default: all seven days checked (backward-compatible;
  existing deploys see no change).
- **At least one day required.** The Settings validator (and the API's
  `PUT /api/config` endpoint) reject an empty mask so a misclick can't
  silently disable the scheduler.

Examples:

- `START_TIME=11:00, START_DAYS=4` — every Thursday at 11:00 local.
- `START_TIME=07:30, START_DAYS=1,3,5` — Mon/Wed/Fri at 07:30 local.
- `START_TIME=08:00, START_DAYS=0,6` — weekends only at 08:00 local.

**Missed days do not queue backfill runs.** If the container is off on a
scheduled Thursday and comes back Friday morning, the next run is *next
Thursday*, not a delayed run today. This matches the existing "past-target
wakes mark as missed, don't auto-fire late" policy — the tool is designed
to run once per scheduled slot, never retroactively.

The Schedule tab surfaces the mask when it isn't all-days (e.g. "Days ·
Claimers: Mon, Wed, Fri only"), so at a glance you can see which days will
fire. No line is shown on the default (all-days) mask.

**Applies to the main claim chain only.** Microsoft Rewards has its own
random-within-window daily schedule (`MS_SCHEDULE_START` / `MS_SCHEDULE_HOURS`);
extending the days-of-week filter to MS is a separate feature deferred
to a follow-up.

The control panel process owns the scheduler. No immediate run on container
boot — the panel stays interactive at startup so you can log in, use
**Run Now**, or **Batch Redeem** right away.

### Run on startup (Sablier / cron)

For setups that wake the container on demand — [Sablier](https://github.com/SablierApp/sablier)
scale-to-zero, host cron driving `docker start` / `docker stop`, ad-hoc
`docker run --rm` — set `RUN_ON_STARTUP` (also editable in **Settings →
Schedule** as a dropdown). Three values:

| Value | Behavior |
|---|---|
| `0` | Off (default — panel boots and waits for the scheduler or Run Now). |
| `1` | After the boot session-check, fire one claim run; panel keeps running afterward. Pairs with Sablier-style traffic-based scaling — Sablier handles the eventual scale-down. |
| `2` | Same as `1`, then exit cleanly after the run completes. **One-shot** mode for cron-driven start/stop or `docker run --rm`. The panel becomes unreachable until something restarts the container. |

**MS Rewards behavior differs by mode:**

- **Mode `1`** runs claimers + watchers only (Prime, Epic, GOG, Steam,
  AliExpress, Ubisoft, Humble, Fanatical, Lenovo). Microsoft Rewards is
  excluded — the panel stays running, so the existing MS scheduler will
  fire `microsoft.js` at its window or via the main-chain `LOOP`.
  Including MS at startup *and* on the scheduler would double-run it.
- **Mode `2`** runs the full chain *including* `microsoft.js`, with
  `MS_SKIP_WINDOW=1` so MS doesn't sleep until its scheduled window. This
  is MS's only chance to run before the container exits.

Both modes pass `NOWAIT=1` so stale sessions fail fast rather than
waiting for interactive login. Each stale session fires its usual
login-needed apprise notification and the chain continues to the next
service — the panel never blocks on human action during an automated
run. (`NOWAIT` itself is env-only and chosen automatically by the runner;
the Run-Now button in the panel deliberately leaves it unset so
interactive prompts in the embedded browser keep working.)

When mode `2` is the effective config the panel renders an amber
**One-shot** banner at the top of every tab so you can't miss that the
container will exit when the next claim run completes, with the revert
options inline. The banner switches to "claim run in progress, container
will exit when it finishes" once the boot run starts.

Setting both `RUN_ON_STARTUP` and `LOOP` gives you a boot run plus the
scheduled cadence.

**One-shot caveats:**

- ⚠ **Disable Docker's auto-restart policy in compose** when using mode
  `2`. The shipped `docker-compose.yml` template has
  `restart: unless-stopped`, which will immediately bring the container
  back up after `process.exit(0)` — that triggers another startup run,
  which exits, which restarts → **infinite restart loop**. For mode `2`
  set `restart: no` (or remove the line entirely) and let your
  orchestrator (Sablier, cron, manual `docker run --rm`) own the
  lifecycle. Mode `1` is fine with `restart: unless-stopped` since the
  panel keeps running.
- Without `NOTIFY` set, you have no post-exit visibility into what the run
  did. The Settings dropdown warns you if you switch to mode `2` while
  apprise is unconfigured.
- If your orchestrator kills the container mid-run (cron with a fixed
  window, Sablier inactivity timeout), notifications may not flush.
  Consider `stop_grace_period: 5m` on the compose service.
- To revert from mode `2` once the panel is exiting on every boot:
  - **Edit `data/config.json`** and remove the `scheduler.runOnStartup`
    key (saved settings win over env, so this is the most reliable path),
  - or **race the panel** — open it before the claim run completes and
    change the dropdown back via Settings → Schedule,
  - or **set `RUN_ON_STARTUP=0` in env *and* remove the `data/config.json`
    override** if the value got there via the Settings tab. Env alone is
    not enough when `data/config.json` has a saved value.

**Cron example (mode 2 + env override).** Pattern courtesy of @reverendj1
in [#27](https://github.com/feldorn/free-games-claimer/issues/27): keep
the long-running compose service on `RUN_ON_STARTUP=1` (or unset) for
the panel-up case, then drop into a fresh one-shot via
`docker compose run` whenever a cronjob fires:

```bash
# Daily at 01:25 — fire a one-shot claim run, then exit + remove the
# transient container. Keeps the panel-up service untouched.
25 1 * * * cd /path/to/freegamesclaimer && docker compose run --remove-orphans --rm -e RUN_ON_STARTUP=2 free-games-claimer
```

`docker compose run` ignores the service's `restart` policy by default,
so this avoids the loop trap even if your main service is on
`restart: unless-stopped`. The `-e` flag injects the env var only into
the cron-spawned container, leaving the panel-up service unchanged.

**How often to run?**
- **Epic Games**: New free games weekly (daily before Christmas)
- **Prime Gaming**: New games monthly (more during Prime days)
- **GOG**: New giveaway every couple of weeks
- **Steam**: Varies — free-to-keep promotions are infrequent

Running once daily (`86400`) is recommended.
