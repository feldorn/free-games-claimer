# free-games-claimer

<p align="center">
<img alt="logo-free-games-claimer" src="https://user-images.githubusercontent.com/493741/214588518-a4c89998-127e-4a8c-9b1e-ee4a9d075715.png" />
</p>

Fork of [vogler/free-games-claimer](https://github.com/vogler/free-games-claimer) (dev branch) with additional features and fixes.

Claims free games periodically on:
- <img alt="logo prime-gaming" src="https://github.com/user-attachments/assets/7627a108-20c6-4525-a1d8-5d221ee89d6e" width="32" align="middle" /> [Amazon Prime Gaming](https://gaming.amazon.com)
- <img alt="logo epic-games" src="https://github.com/user-attachments/assets/82e9e9bf-b6ac-4f20-91db-36d2c8429cb6" width="32" align="middle" /> [Epic Games Store](https://www.epicgames.com/store/free-games)
- <img alt="logo gog" src="https://github.com/user-attachments/assets/49040b50-ee14-4439-8e3c-e93cafd7c3a5" width="32" align="middle" /> [GOG](https://www.gog.com)
- <img alt="logo steam" src="https://store.steampowered.com/favicon.ico" width="32" align="middle" /> [Steam](https://store.steampowered.com) — free-to-keep promotions only (not F2P or free weekends)
- 🎯 [Microsoft Rewards](https://rewards.bing.com) — daily Bing searches and activity cards for points

Uses [patchright](https://github.com/nicbarker/patchright) (Chromium with built-in anti-detection). Runs in Docker with a virtual display and VNC access.

See [MODIFICATIONS.md](MODIFICATIONS.md) for a full list of changes from the upstream dev branch.

---

## Quick Start (Docker)

```sh
docker run --rm -it -p 6080:6080 -p 7080:7080 -v fgc:/fgc/data --pull=always ghcr.io/feldorn/free-games-claimer
```

This runs all 4 claimers (`prime-gaming`, `epic-games`, `gog`, `steam`), claims any available free games, and exits.

### First Run — Login Setup

On the first run, you need to establish browser sessions for each store. The easiest way is to use the interactive login panel:

```sh
docker run --rm -it -p 6080:6080 -p 7080:7080 -v fgc:/fgc/data \
  -e LOGIN_MODE=1 \
  ghcr.io/feldorn/free-games-claimer
```

Then open **http://localhost:7080** in your browser. The panel lets you:

1. Click **Login** for each site to open a visible browser via noVNC
2. Log in manually (handle captchas, MFA, phone verification as needed)
3. Click **I'm Logged In** to verify and save the session
4. Click **Check All Sessions** to confirm everything is green
5. Optionally click **Test Run All Scripts** to verify claiming works

Once all sessions are established, stop the container and restart without `LOGIN_MODE=1`.

Sessions are stored in the `fgc` Docker volume and persist across container restarts. You should not need to log in again unless a session expires (you'll get a notification if that happens).

---

## Docker Compose

```yaml
services:
  free-games-claimer:
    image: ghcr.io/feldorn/free-games-claimer
    container_name: fgc
    ports:
      - "6080:6080"   # noVNC (browser-based VNC viewer)
      - "7080:7080"   # interactive login panel (LOGIN_MODE=1)
    volumes:
      - fgc:/fgc/data
    environment:
      - EMAIL=your@email.com
      - EG_PASSWORD=your-epic-password
      - PG_PASSWORD=your-prime-password
      - GOG_PASSWORD=your-gog-password
      - STEAM_PASSWORD=your-steam-password
      - NOTIFY=pover://user@token          # Pushover, Telegram, Slack, etc.
      - LOOP=86400                          # repeat every 24 hours
      # - LOGIN_MODE=1                      # uncomment for first-time login setup
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

Options are set via environment variables. You can pass them directly, use `--env-file`, or put them in `data/config.env` (loaded automatically by dotenv).

### General

| Option | Default | Description |
|--------|---------|-------------|
| `EMAIL` | | Default email for all logins |
| `PASSWORD` | | Default password for all logins |
| `NOTIFY` | | Notification URL(s) for [apprise](https://github.com/caronc/apprise) (Pushover, Telegram, Slack, etc.) |
| `NOTIFY_TITLE` | | Optional title for notifications |
| `LOOP` | | Repeat claiming every N seconds (e.g., `86400` = 24h). Omit to run once and exit. |
| `LOGIN_MODE` | `0` | Set to `1` to launch the interactive login panel instead of automated claiming |
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
| Prime Gaming | `PG_EMAIL` | `PG_PASSWORD` | `PG_OTPKEY` | `PG_REDEEM=1`, `PG_CLAIMDLC=1` |
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

The recommended approach is to use `LOOP` in Docker:

```yaml
environment:
  - LOOP=86400  # run every 24 hours
```

The entrypoint will run all claimers, sleep for the specified interval, and repeat. Combined with `restart: unless-stopped`, this keeps claiming running indefinitely.

**How often to run?**
- **Epic Games**: New free games weekly (daily before Christmas)
- **Prime Gaming**: New games monthly (more during Prime days)
- **GOG**: New giveaway every couple of weeks
- **Steam**: Varies — free-to-keep promotions are infrequent

Running once daily (`86400`) is recommended.

**Alternative scheduling** (without `LOOP`):
- Linux/macOS: `crontab -e`
- macOS: launchd
- Windows: Task Scheduler
- Any OS: [pm2](https://pm2.keymetrics.io/docs/usage/restart-strategies/)

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
| `data/ms-used-terms.json` | Microsoft Rewards — search terms used in the last 30 days (dedup window) |
| `data/screenshots/` | Screenshots of claim results |

---

## Troubleshooting

- **Can't see the browser?** Open http://localhost:6080 for the noVNC viewer
- **Captcha or MFA needed?** Use `LOGIN_MODE=1` to access the interactive panel at http://localhost:7080
- **Session expired?** You'll get a notification. Restart with `LOGIN_MODE=1` to re-authenticate.
- **Script skipping a game?** Check the console output — games are skipped for reasons like: already owned, below rating/price threshold (Steam), requires base game, region locked
- **Debug mode:** Set `DEBUG=1` for verbose output including page text dumps and full stack traces

For issues specific to this fork, open an issue at [feldorn/free-games-claimer](https://github.com/feldorn/free-games-claimer/issues).
For upstream issues, see [vogler/free-games-claimer](https://github.com/vogler/free-games-claimer/issues).

---

## Credits

Based on [vogler/free-games-claimer](https://github.com/vogler/free-games-claimer) by [@vogler](https://github.com/vogler). See the upstream repository for the original project history and contributors.
