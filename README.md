# free-games-claimer

<p align="center">
<img alt="logo-free-games-claimer" src="https://user-images.githubusercontent.com/493741/214588518-a4c89998-127e-4a8c-9b1e-ee4a9d075715.png" />
</p>

Fork of [vogler/free-games-claimer](https://github.com/vogler/free-games-claimer) (dev branch) with a full-featured control panel, in-app settings, claim-history stats, and Microsoft Rewards points tracking.

Claims free games periodically on:
- <img alt="logo prime-gaming" src="https://github.com/user-attachments/assets/7627a108-20c6-4525-a1d8-5d221ee89d6e" width="32" align="middle" /> [Amazon Prime Gaming](https://gaming.amazon.com)
- <img alt="logo epic-games" src="https://github.com/user-attachments/assets/82e9e9bf-b6ac-4f20-91db-36d2c8429cb6" width="32" align="middle" /> [Epic Games Store](https://www.epicgames.com/store/free-games)
- <img alt="logo gog" src="https://github.com/user-attachments/assets/49040b50-ee14-4439-8e3c-e93cafd7c3a5" width="32" align="middle" /> [GOG](https://www.gog.com)
- <img alt="logo steam" src="https://store.steampowered.com/favicon.ico" width="32" align="middle" /> [Steam](https://store.steampowered.com) — free-to-keep promotions only (not F2P or free weekends)
- 🎯 [Microsoft Rewards](https://rewards.bing.com) — daily Bing searches and activity cards for points, with before/after balance tracking

Uses [patchright](https://github.com/nicbarker/patchright) (Chromium with built-in anti-detection). Runs in Docker with a virtual display and VNC access.

See [MODIFICATIONS.md](MODIFICATIONS.md) for the full history of changes from the upstream dev branch.

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

---

## Quick Start (Docker)

```sh
docker run --rm -it -p 6080:6080 -p 7080:7080 -v fgc:/fgc/data --pull=always ghcr.io/feldorn/free-games-claimer
```

This runs all 4 claimers (`prime-gaming`, `epic-games`, `gog`, `steam`), claims any available free games, and exits.

### First Run — Login Setup

The control panel is always available at **http://localhost:7080**. On first run, open it and:

1. Click **Login** for each site to open a visible browser via noVNC
2. Log in manually (handle captchas, MFA, phone verification as needed)
3. Click **I'm Logged In** to verify and save the session
4. Click **Check All Sessions** to confirm everything is green
5. Optionally click **Run Now** to claim any games that are currently available

If you set `LOOP=86400` (or similar), the panel's built-in scheduler will then claim every N seconds automatically — no need to restart the container or toggle any mode.

Sessions are stored in the `fgc` Docker volume and persist across container restarts. You should not need to log in again unless a session expires (you'll get a notification if that happens — come back to the panel and click **Login** on the affected site).

---

## Docker Compose

```yaml
services:
  free-games-claimer:
    image: ghcr.io/feldorn/free-games-claimer
    container_name: fgc
    ports:
      - "6080:6080"   # noVNC (browser-based VNC viewer)
      - "7080:7080"   # control panel (always running)
    volumes:
      - fgc:/fgc/data
    environment:
      - EMAIL=your@email.com
      - EG_PASSWORD=your-epic-password
      - PG_PASSWORD=your-prime-password
      - GOG_PASSWORD=your-gog-password
      - STEAM_PASSWORD=your-steam-password
      - NOTIFY=pover://user@token          # Pushover, Telegram, Slack, etc.
      - LOOP=86400                          # scheduler interval in seconds; omit to disable
      # - BASE_PATH=/free-games             # URL prefix for reverse-proxy subfolder setups
      # - PUBLIC_URL=https://example.com/free-games
      # - STEAM_MIN_RATING=6               # minimum review rating (default: 6 = Mostly Positive)
      # - STEAM_MIN_PRICE=10               # minimum original price in USD (default: 10)
    restart: unless-stopped

volumes:
  fgc:
```

> **Important:** Do not add a `command:` override unless you intentionally want to skip some claimers. The default CMD runs all 4 scripts, and the `LOOP` variable handles scheduling via the entrypoint.

---

## Without Docker

1. Install [Node.js](https://nodejs.org/en/download) (v18+)
2. Clone this repository and `cd` into it
3. Install dependencies:
   ```sh
   npm install && npx patchright install chromium
   ```
4. Run individual claimers:
   ```sh
   node prime-gaming
   node epic-games
   node gog
   node steam
   ```
5. Optional: install [apprise](https://github.com/caronc/apprise) for notifications (`pipx install apprise`)
6. To update: `git pull && npm install`

---

## Configuration

Options can be set in two places:

1. **Settings tab in the control panel** (recommended for runtime tweaks) —
   writes `data/config.json` and takes priority over env. Every field shows
   its env var name in muted monospace for reference. See
   [Settings](#settings-in-app-configuration) for details.
2. **Environment variables** — initial defaults. Pass directly, use
   `--env-file`, or put them in `data/config.env` (loaded automatically by
   dotenv). Env is also the only way to set things that stay env-only:
   panel ports, `PANEL_PASSWORD`, credentials.

The env-var tables below document what each variable does; anything in them
that's also on the Settings tab can be edited there at runtime instead.

### General

| Option | Default | Description |
|--------|---------|-------------|
| `EMAIL` | | Default email for all logins |
| `PASSWORD` | | Default password for all logins |
| `NOTIFY` | | Notification URL(s) for [apprise](https://github.com/caronc/apprise) (Pushover, Telegram, Slack, etc.) |
| `NOTIFY_TITLE` | | Optional title for notifications |
| `LOOP` | | Repeat claiming every N seconds (e.g., `86400` = 24h). Omit to run once and exit. |
| `LOGIN_MODE` | — | **Deprecated no-op** — the control panel is always running on port 7080. Safe to remove from your config. |
| `CLAIM_CMD` | (all 5 scripts in sequence) | Shell command the scheduler runs at its anchored wake. Includes microsoft.js, which sleeps internally until `MS_SCHEDULE_START`. |
| `CLAIM_CMD_MANUAL` | (4 scripts, microsoft.js excluded) | Shell command the "Run Now" button runs. Excludes microsoft.js by default so a manual run actually finishes in a few minutes instead of hanging overnight. |
| `BASE_PATH` | | URL prefix when serving the panel under a reverse-proxy subfolder (e.g. `/free-games`). Leave empty for root or subdomain. See [Reverse-Proxy Setup](#reverse-proxy-setup) below. |
| `PUBLIC_URL` | | Full external URL of the panel (e.g. `https://example.com/free-games`). Used in notifications so tap-targets land on the panel. |
| `SHOW` | `1` (Docker) | Show browser GUI. Default is headless outside Docker. |
| `WIDTH` | `1920` | Browser/screen width |
| `HEIGHT` | `1080` | Browser/screen height |
| `VNC_PASSWORD` | | VNC password. No password by default. |
| `BROWSER_DIR` | `data/browser` | Browser profile directory |
| `TIMEOUT` | `60` | Timeout in seconds for page actions |
| `LOGIN_TIMEOUT` | `180` | Timeout in seconds for login |
| `DEBUG` | `0` | Set to `1` for verbose debug output |

### Per-Store Credentials

Each store can use the default `EMAIL`/`PASSWORD` or be overridden individually:

| Store | Email | Password | OTP Key | Other |
|-------|-------|----------|---------|-------|
| Epic Games | `EG_EMAIL` | `EG_PASSWORD` | `EG_OTPKEY` | `EG_PARENTALPIN` |
| Prime Gaming | `PG_EMAIL` | `PG_PASSWORD` | `PG_OTPKEY` | `PG_REDEEM=1`, `PG_CLAIMDLC=1` *(currently a no-op — Amazon removed the in-game DLC section in 2026; flag still respected for when it returns)* |
| GOG | `GOG_EMAIL` | `GOG_PASSWORD` | | `GOG_NEWSLETTER=1` |
| Steam | `STEAM_EMAIL` | `STEAM_PASSWORD` | | `STEAM_MIN_RATING`, `STEAM_MIN_PRICE` |
| Microsoft Rewards | `MS_EMAIL` | `MS_PASSWORD` | `MS_OTPKEY` | `MS_SCHEDULE_HOURS` |

### Steam-Specific Options

| Option | Default | Description |
|--------|---------|-------------|
| `STEAM_MIN_RATING` | `6` | Minimum review rating (1-9). 9=Overwhelmingly Positive, 6=Mostly Positive, 1=Overwhelmingly Negative |
| `STEAM_MIN_PRICE` | `10` | Minimum original price in USD. Filters out cheap/shovelware titles. |

Steam discovers free-to-keep games via [SteamDB](https://steamdb.info/upcoming/free/) and only claims temporarily free promotions (100% off games that normally cost money). Free-to-play games and free weekend trials are excluded.

### Microsoft Rewards Options

| Option | Default | Description |
|--------|---------|-------------|
| `MS_EMAIL` | | Microsoft account email (falls back to `EMAIL`) |
| `MS_PASSWORD` | | Microsoft account password (falls back to `PASSWORD`) |
| `MS_OTPKEY` | | TOTP secret for automatic 2FA (otplib). Only needed if the account uses app-based TOTP, not phone push approval. |
| `MS_SCHEDULE_HOURS` | `0` | Schedule window width in hours. When set, picks a random time within the window each day and waits until then. Use with `MS_SCHEDULE_START`. `0` = run immediately. |
| `MS_SCHEDULE_START` | `8` | Window start hour (0–23). With `MS_SCHEDULE_HOURS=4` and `MS_SCHEDULE_START=8`, runs land randomly between 8am and 12pm each day. The LOOP sleep anchors to this time to prevent daily drift. |

Microsoft Rewards collects daily points by running a desktop Bing session (33–37 searches) and a mobile session emulating a Pixel 7 (23–27 searches), plus clicking any pending activity cards. Search terms are sourced fresh each run from Google Trends and BBC/ESPN RSS feeds, with a 30-day dedup window to avoid repeating terms. The existing 800-term pool is used as fallback when live sources are unreachable.

---

## Notifications

Notifications are sent via [apprise](https://github.com/caronc/apprise) for:
- Successfully claimed games
- Failed claims
- Login issues (expired sessions, captchas)

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

---

## Automatic Login / Two-Factor Authentication

If you set email, password, and OTP key, logins happen automatically without prompts. This is optional — sessions persist via cookies and should rarely need re-authentication.

To get OTP keys for automatic 2FA:
- **Epic Games**: [Password & Security](https://www.epicgames.com/account/password) → enable 'third-party authenticator app' → copy 'Manual Entry Key' → set `EG_OTPKEY`
- **Prime Gaming**: Amazon 'Your Account → Login & security' → 2-step verification → Manage → Add new app → 'Can't scan the barcode' → copy the bold key → set `PG_OTPKEY`
- **GOG**: Only offers OTP via email (no key to configure)
- **Steam**: Uses Steam Guard (5-character code prompted in terminal or via VNC)

> **Security note:** Storing passwords and OTP keys as environment variables in plain text is a security risk. Use unique/generated passwords.

---

## Scheduling

Set `LOOP` to enable the built-in scheduler:

```yaml
environment:
  - LOOP=86400  # wake every 24 hours
```

The control panel process owns the scheduler — it sleeps until the next anchored
wake time, fires the full claim sequence (including `microsoft.js` which has its
own internal window-based timing), then sleeps again. No immediate run on
container boot — the panel stays interactive at startup so you can log in, use
**Run Now**, or **Batch Redeem** right away. First scheduled run happens at the
next anchored time.

**How often to run?**
- **Epic Games**: New free games weekly (daily before Christmas)
- **Prime Gaming**: New games monthly (more during Prime days)
- **GOG**: New giveaway every couple of weeks
- **Steam**: Varies — free-to-keep promotions are infrequent

Running once daily (`86400`) is recommended.

---

## Control Panel

The control panel at **`http://localhost:7080`** is always running and
organises everything under five tabs. The header compresses to ~70px once
setup is complete, so the main area is free for whichever tool you're in.

### Sessions tab (default)

Responsive grid of cards — one per site (Prime, Epic, GOG, Steam, MS Rewards,
MS Mobile). Grid layout auto-adapts between 1/2/3/4 columns depending on
viewport width.

- **Status dot** (green / red / gray) backed by real URL-based auth checks
  (`/account` redirects, ME Control DOM presence, etc.), not cached UI.
- **Logged in as \<username\>** pulled per-site from the right source for each
  — GOG via API, Microsoft via the ME Control widget, Prime / Epic / Steam
  via the persistent chrome on their respective dashboards.
- **Login button** launches a visible Chromium in the embedded noVNC window.
  Solve captchas / MFA / phone verification manually, then click **I'm Logged
  In** to verify and persist the session. The browser's yours while it's open
  — clear captcha cookies, verify game ownership, redeem codes in a side tab;
  anything stays in the session.
- **Check button** re-runs the session probe without opening a visible
  browser.
- During an active login the stepper and cards auto-hide so the noVNC
  viewport gets the full remaining vertical space.
- The top-of-tab status strip rolls up "All N sessions OK", "Login needed
  for X", "Run in progress", and startup auto-check into one row, with
  "Next run in 1h 15m · Last run 3h ago (success, 4m)" on the right.

**Batch Redeem** surfaces automatically when Prime Gaming has delivered GOG
codes that weren't successfully redeemed (captcha-gated, script interrupted,
etc.). Opens the GOG redeem page per pending code — solve the captcha once
in noVNC and the panel drives the rest of the queue; re-challenges pause
and wait for you.

### Stats tab

Derived entirely from the existing per-service JSON DBs plus
`data/microsoft-rewards.json` (see [Data Storage](#data-storage)). No new
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

- **Next run:** wall time (`2026-04-20 07:30`) with a live countdown
  (`in 22h 8m`) updated every 30s.
- **Interval:** human-readable translation of `LOOP` / `MS_SCHEDULE_*`
  (e.g. "Every 6 hours" or "Daily, anchored to MS window start 08:00 local
  time").
- **Last run:** short wall time + source + status (success/error/finished) +
  duration.
- Pause/resume and per-run history are planned follow-ups.

### Logs tab

Monospaced scrollable viewer for the most recent run output. Polls
`/api/run-log` at 1s while a run is active and 3s otherwise, stops polling
when you switch tabs. Independent of the Sessions tab — you can leave the
noVNC visible on Sessions while a run's log streams here.

### Settings tab

Full in-app configuration. Every field listed in `CONFIG_SCHEMA` (see
[Settings](#settings-in-app-configuration)) is editable here. Docker env is
the initial default; in-app saves take priority.

### Notification deep-links

When `PUBLIC_URL` is set (the panel's externally-reachable URL), Pushover /
Telegram / etc. notifications include tap-targets that go straight to the
relevant action:

- Stale-session notification: per-site link like `?login=gog` that auto-opens
  the Login flow when you land.
- Pending-redeem notification: includes `?batch=gog` header link that
  auto-starts the batch-redeem when you land.

### First-time setup

1. Start the container (see [Docker Compose](#docker-compose)).
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
[Discard] · [Save]`) that replaces per-section buttons. All dirty fields
commit together in one PUT. Each field shows the environment variable it
overrides in a muted monospace label so you can see the docker-env mapping
at a glance, and a green dot when the app config is the authoritative
source.

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

- **Schedule** — `LOOP`, `MS_SCHEDULE_HOURS`, `MS_SCHEDULE_START`.
  Changes apply immediately via `fs.watch` — the scheduler wakes up and
  recomputes its next run. No container restart.
- **Notifications** — `NOTIFY`, `NOTIFY_TITLE`, `PUBLIC_URL`. A
  **Send test** button fires apprise with the *current* effective config,
  so you can tweak the URL and test without a restart.
- **Per-service** — grouped sub-headings: Prime Gaming (`PG_REDEEM`,
  `PG_CLAIMDLC`, `PG_TIMELEFT`), Epic Games (`EG_MOBILE`), GOG
  (`GOG_NEWSLETTER`), Steam (`STEAM_MIN_RATING`, `STEAM_MIN_PRICE`).
- **Advanced** — `DRYRUN`, `RECORD`, `TIMEOUT`, `LOGIN_TIMEOUT`, `WIDTH`,
  `HEIGHT`.
- **Environment (read-only)** — every env var the app reads, grouped by
  Panel / Data paths / Credentials (sub-grouped by service) / Debug. Non-
  sensitive values render in full; credentials show as `set (hidden)` by
  default and require an explicit `[Reveal credentials]` click (with
  confirmation) to show last-4-masked values like `••••••2bM!`.

### What stays env-only

Credentials (`*_EMAIL`, `*_PASSWORD`, `*_OTPKEY`, `*_PARENTALPIN`),
panel infrastructure (`PANEL_PORT`, `NOVNC_PORT`, `BASE_PATH`,
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

---

## Reverse-Proxy Setup

The interactive-login panel can be served behind a reverse proxy at either a subdomain
(e.g. `https://fgc.example.com`) or a subfolder (e.g. `https://example.com/free-games`).

### Subdomain (simplest)

No special configuration needed on the app side. Point your reverse proxy at
`http://fgc:7080/` and `http://fgc:6080/` for the panel and noVNC respectively.

### Subfolder

Set `BASE_PATH` to the prefix and `PUBLIC_URL` to the full external URL:

```yaml
environment:
  - BASE_PATH=/free-games
  - PUBLIC_URL=https://example.com/free-games
```

The app will:
- Strip `BASE_PATH` from incoming request URLs before routing.
- Build all client-side URLs (`fetch`, noVNC iframe `src`) with the prefix.
- Include `PUBLIC_URL` in notifications so tap-targets land on the panel.

Example SWAG / nginx config (save as `free-games.subfolder.conf` in
`proxy-confs/`). **Important**: `proxy_pass` must not have a trailing slash —
the app handles prefix stripping itself. The `^~` modifier ensures this
location wins over any regex locations elsewhere in your nginx config.

```nginx
location ^~ /free-games/ {
    # auth_request /auth-1;   # optional Organizr / Authelia
    include /config/nginx/proxy.conf;
    include /config/nginx/resolver.conf;
    set $upstream_app free-games-claimer;
    set $upstream_port 7080;
    set $upstream_proto http;
    proxy_pass $upstream_proto://$upstream_app:$upstream_port;
}

location ^~ /free-games/novnc/ {
    # auth_request /auth-1;
    include /config/nginx/proxy.conf;
    include /config/nginx/resolver.conf;
    set $upstream_app free-games-claimer;
    set $upstream_port 6080;
    set $upstream_proto http;
    proxy_pass $upstream_proto://$upstream_app:$upstream_port;
    rewrite /free-games/novnc/(.*) /$1 break;
}

# noVNC hard-codes its WebSocket at /websockify (origin root), so we expose it
# there too. Without this block the VNC viewer loads but can't connect.
location = /websockify {
    # auth_request /auth-1;
    include /config/nginx/proxy.conf;
    include /config/nginx/resolver.conf;
    set $upstream_app free-games-claimer;
    set $upstream_port 6080;
    set $upstream_proto http;
    proxy_pass $upstream_proto://$upstream_app:$upstream_port;
}
```

The `/novnc/` block strips the prefix via `rewrite` (not `proxy_pass` trailing
slash — that doesn't reliably pass subpaths in this setup) so noVNC sees
`/vnc.html`, `/app/styles/base.css`, etc. at the root path it expects. The
`/websockify` block handles the WebSocket upgrade — noVNC's JS hard-codes this
path relative to the origin root, so we proxy it there rather than fighting
the noVNC URL config. Your `proxy.conf` must pass `Upgrade` / `Connection`
headers for the WebSocket to work (SWAG's default `proxy.conf` already does).

---

## Data Storage

All data is stored in the `data/` directory (mounted as a Docker volume):

| Path | Contents |
|------|----------|
| `data/browser/` | Browser profiles with saved sessions (one per store) |
| `data/epic-games.json` | Claimed/seen Epic Games titles |
| `data/prime-gaming.json` | Claimed Prime Gaming titles, redeemed codes |
| `data/gog.json` | Claimed GOG titles |
| `data/steam.json` | Claimed Steam titles |
| `data/microsoft-rewards.json` | MS Rewards run history — `{at, session, before, after, earned}` per run (capped at 500 entries). Feeds the Stats tab's points KPIs. |
| `data/ms-used-terms.json` | Microsoft Rewards — search terms used in the last 30 days (dedup window) |
| `data/config.json` | App-level config overrides written by the Settings tab. Missing = env/defaults in effect. Deleted = same as missing. |
| `data/screenshots/` | Screenshots of claim results |

---

## HTTP API

The panel exposes a small JSON API, useful for scripting or dashboard
integration. All endpoints are rooted at `<BASE_PATH>/api`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/state` | Current state: per-site status, scheduler info, last run, active browser, batch-redeem progress |
| `POST` | `/launch` | Open a visible browser for a site: `{ "site": "gog" }` |
| `POST` | `/verify` | After a manual login — verify + persist the session |
| `POST` | `/check` | Run a headless session probe: `{ "site": "microsoft" }` |
| `POST` | `/runall` | Fire a claim run (background) — uses `CLAIM_CMD_MANUAL` |
| `POST` | `/stop-run` | SIGTERM the current run |
| `GET`  | `/run-log?since=N` | Stream run output from offset `N`, returns `{lines, total, status}` |
| `GET`  | `/config` | Effective config + schema: `{app, effective, fields[]}` |
| `PUT`  | `/config` | Patch app config: body `{path: value, ...}`; `null` removes an override |
| `GET`  | `/env` | Read-only env view; add `?reveal=1` to unmask credentials (last-4 only) |
| `POST` | `/notifications/test` | Fire a test apprise notification with current effective config |
| `GET`  | `/stats/summary` | KPI numbers for the Stats tab |
| `GET`  | `/stats/by-service` | Per-service claim counts + last-claim time |
| `GET`  | `/stats/daily?days=30` | Daily claim counts for the 30-day chart |
| `GET`  | `/activity?limit=10` | Recent successful claims |

---

## Troubleshooting

- **Can't see the browser?** Open http://localhost:6080 for the raw noVNC viewer, or http://localhost:7080 for the control panel with site cards and scheduler info
- **Captcha or MFA needed?** Open the control panel at http://localhost:7080 and click **Login** on the affected site — solve the challenge in the embedded browser
- **Session expired?** You'll get a notification. Come back to the control panel and click **Login** on the affected site
- **Script skipping a game?** Check the console output — games are skipped for reasons like: already owned, below rating/price threshold (Steam), requires base game, region locked
- **Settings tab save doesn't apply?** Scheduler changes land within 1s (`fs.watch`-driven). Everything else takes effect on the next claim run because each claim script re-reads config at startup. If neither happens, check `data/config.json` — it should contain your override. Deleting the file reverts everything to env/defaults.
- **Settings "Send test" notification fails?** Check `NOTIFY` parses as an apprise URL, and that the `apprise` CLI is installed inside the container (it is on `ghcr.io/feldorn/free-games-claimer`). The test uses the *current* effective config so no restart is needed between edits.
- **Stats tab shows "Pending" for MS Rewards?** The balance captures on the next `microsoft.js` run. Run `microsoft.js` once (or let the scheduler fire it) and both the balance tile and the per-session points rows populate.
- **Prime DLC toggle does nothing?** Amazon removed the in-game content section from the Prime Gaming UI in 2026. The flag is still respected; the script detects the missing tab and skips quickly rather than hanging for 60s. It'll resume claiming automatically if Amazon brings the section back.
- **Debug mode:** Set `DEBUG=1` for verbose output including page text dumps and full stack traces

For issues specific to this fork, open an issue at [feldorn/free-games-claimer](https://github.com/feldorn/free-games-claimer/issues).
For upstream issues, see [vogler/free-games-claimer](https://github.com/vogler/free-games-claimer/issues).

---

## Credits

Based on [vogler/free-games-claimer](https://github.com/vogler/free-games-claimer) by [@vogler](https://github.com/vogler). See the upstream repository for the original project history and contributors.
