← [Back to README](../README.md)

# Installation

How to get Free Games Claimer running — Docker, Docker Compose, bare-metal Node, and non-root mode.

---

## Quick Start (Docker)

```sh
docker run --rm -it -p 6080:6080 -p 7080:7080 -v fgc:/fgc/data --pull=always ghcr.io/feldorn/free-games-claimer
```

This starts the container, brings up the control panel on port 7080, and stays running. No claims happen on boot — sign in via the panel first, then either click **Run Now** or set `LOOP` (and optionally `START_TIME`) so the built-in scheduler fires daily on its own.

The image is published for both `linux/amd64` and `linux/arm64`, so the same tag works on x86 servers, Apple Silicon, and Raspberry Pi (64-bit).

### First Run — Login Setup

The control panel is always available at **http://localhost:7080**. On first run, open it and:

1. Click **Login** for each site to open a visible browser via noVNC
2. Log in manually (handle captchas, MFA, phone verification as needed)
3. Click **I'm Logged In** to verify and save the session
4. Click **Check All Sessions** to confirm everything is green
5. Optionally click **Run Now** to claim any games that are currently available

If you set `LOOP=86400` (or similar), the panel's built-in scheduler will then claim every N seconds automatically — no need to restart the container or toggle any mode.

Sessions are stored in the `fgc` Docker volume and persist across container restarts. You should not need to log in again unless a session expires (you'll get a notification if that happens — come back to the panel and click **Login** on the affected site).

If a site's in-container login is too brittle to complete (AliExpress's slider, Cloudflare gating, hardware MFA, etc.), use **Cookie upload** instead: solve login on your desktop with the EditThisCookie or Cookie-Editor extension, export to JSON, paste into the panel's Cookie button on that site's card. See [Cookie upload](AUTH.md#cookie-upload).

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
      - LOOP=86400                          # scheduler interval in seconds (24h)
      # - START_TIME=08:00                  # optional wall-clock anchor (HH:MM). e.g. with LOOP=86400, runs daily at 08:00
      # - BASE_PATH=/free-games             # URL prefix for reverse-proxy subfolder setups
      # - PUBLIC_URL=https://example.com/free-games
      # - STEAM_MIN_RATING=6               # minimum review rating (default: 6 = Mostly Positive)
      # - STEAM_MIN_PRICE=10               # minimum original price in USD (default: 10)
    restart: unless-stopped

volumes:
  fgc:
```

> **Important:** Don't override `command:` or `entrypoint:`. The image's entrypoint launches the control panel, and the panel owns scheduling, the Run-Now button, and the per-service active toggles. Replacing it with a hand-rolled `node prime-gaming; node epic-games; …` pipeline disables all of that.

---

## Keeping the image up to date

There are two complementary mechanisms:

### Built-in update notification

The panel polls GitHub every 6 hours and shows a small **`vX.Y.Z → vX.Y.Z+N available`** pill in the header when a newer release is published. Click the pill to read the release notes, then run `docker compose pull && docker compose up -d` (or your equivalent) to apply the update. The pill stays hidden when you're current.

Set `UPDATE_CHECK=0` in your environment to disable the poll entirely — useful for offline / air-gapped deployments. See [docs/CONFIGURATION.md](CONFIGURATION.md) for the full env reference.

### Fully-automatic pulls (recommended for unattended deployments)

If you'd rather have the image pulled and restarted automatically when a new tag lands, run a watcher container alongside FGC. Three good options — pick one:

| Tool | Notes |
|---|---|
| **[Watchtower](https://github.com/containrrr/watchtower)** | The classic. Drop it into your compose with `command: --schedule "0 0 4 * * *"` (daily 4am) or use the polling default. Watches all containers with the right label and pulls+restarts when a new image is published. |
| **[Diun](https://github.com/crazy-max/diun)** | Notify-only by default — pings you when a new image lands instead of auto-applying. Useful if you want the heads-up but want to time the restart yourself. |
| **[Komodo](https://github.com/mbecker20/komodo)** | Full multi-host Docker management with an in-app upgrade button. Heavier than Watchtower but worth it if you're managing several stacks. |

The panel's update pill works fine alongside any of these — it just stops appearing once the watcher applies the update.

**We deliberately do not run `docker pull` from inside the container.** That would require mounting `/var/run/docker.sock` into the container, which gives any process inside it root on the host (it can spawn arbitrary privileged containers, mount host paths, etc.). For a tool that executes JavaScript scraped from third-party storefronts inside Chromium, that's not an acceptable default. The two-piece pattern above — pull-aware watcher + pull-naive app — is the right shape. See [issue #39](https://github.com/feldorn/free-games-claimer/issues/39) for the full rationale.

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

## Running as a non-root user

Default is root, unchanged from the upstream image. Opt in to non-root by setting `PUID` (and optionally `PGID`) in compose.

<details>
<summary><strong>Setup, migration, and caveats</strong></summary>

The entrypoint reconciles a `fgc` user with those IDs, chowns `/fgc/data`
and the runtime user's home dirs, then drops privileges via `gosu` before
starting TurboVNC and the panel.

```yaml
environment:
  - PUID=1000
  - PGID=1000
```

When this is the way you want to run, files created in your bind-mounted volume
(`data/browser/`, `data/*.json`, etc.) will be owned by `1000:1000` on the host
instead of root, so backups and direct edits don't need sudo.

### Migrating an existing volume

If you've been running the root-default and later set `PUID`, the existing
contents of `data/` are still root-owned. The first start with `PUID` set will
chown `data/` to the new IDs. After that, normal operation resumes.

If you flip back and forth between root and non-root modes, expect a chown pass
each time. To freeze ownership, pick a mode and stick with it.

### Caveats

- Don't combine `PUID`/`PGID` with the docker-compose `user:` directive.
  When `user:` is set, the container starts as that user immediately and our
  entrypoint's root-only block is skipped — no chown happens. Pick one mechanism.
- The browser binaries live at `/usr/local/share/ms-playwright` (set via
  `PLAYWRIGHT_BROWSERS_PATH`) instead of `/root/.cache`. They're world-readable.
  If you've extended the image and assumed the old `/root/.cache/ms-playwright`
  path, update accordingly.

</details>
