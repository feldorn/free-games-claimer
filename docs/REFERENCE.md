← [Back to README](../README.md)

# Reference

Bot detection posture, data storage, HTTP API, and troubleshooting.

---

## Bot detection — what works, what doesn't

Some stores actively try to detect that they're being scraped. We ship fixes when we can; some failure modes are architecturally outside what a containerized self-hosted tool can solve. Setting expectations honestly here so reports don't repeat indefinitely.

### Three categories

**A. UI workflow drift** — sites rename selectors, add modals, change the order of redirects. Hits all stores eventually. Our fork-style response is to ship a fix when we see the breakage. Recent examples: Epic's "Is this the right account?" prompt (added 2.4.2), GOG's `menuUsername` → `menuAccountButton` rename, AliExpress's coin balance API switching response shapes. **Cost: routine maintenance. We keep up with this.**

**B. Browser fingerprint detection** — sites with real anti-automation budgets (AliExpress AWSC, parts of Epic, Cloudflare-fronted endpoints) score the browser on signals that come from physical hardware and OS state. A containerized Chromium loses most of these signals regardless of what shim we add:

| Signal | Real desktop Chrome | Our containerized Chromium |
|---|---|---|
| WebGL renderer/vendor | Real GPU strings | Software-rendered (Mesa llvmpipe) |
| Audio context fingerprint | Hardware-specific drift | No audio device → uniform across all containerized installs |
| Font enumeration | ~200 system fonts | ~30 minimal Docker fonts |
| TLS handshake (JA3) | Chrome's actual TLS stack | Patchright Chromium's, slightly off |
| Browsing history / 3rd-party cookies / Topics | 100s of sites visited weekly | Only ever visits the target store |

We've shipped what the JS layer can shim — viewport unification, persistent fingerprint (2.3.1), captcha awareness/notification (2.0.2), patchright over vanilla playwright. The remaining ceiling is the *hardware* signal layer, which requires either real desktop Chrome attached via CDP (out of scope for users who self-host on a NUC) or a paid browser-as-a-service (out of scope for a free self-hosted tool). **We will not chase this layer further on patchright.**

**C. Account-level risk scoring** — once an account has triggered detection N times, the *account* accumulates a risk score regardless of what client connects. AWSC has been observed to flag accounts for weeks after repeated automation attempts. Decays naturally; nothing we ship fixes it. **Recovery = wait it out.**

### Per-store reality

| Store | Status | What you should expect |
|---|---|---|
| **Prime Gaming** | Reliable | Login persists. Occasional UI drift, ~1 fix/quarter. |
| **Epic Games** | Reliable | hCaptcha occasionally requires noVNC solve. New-device "Is this the right account?" prompt handled in 2.4.2. |
| **GOG** | Reliable | Soft captcha occasionally. |
| **Steam** | Reliable | Free-to-keep flow has no fingerprint scoring. |
| **Microsoft Rewards** | Reliable | Humanlike search timing required (built-in); runs take 30–45 min by design. |
| **PlayStation Plus** | Reliable with caveats | Sony's Akamai bot manager occasionally returns Access Denied on `store.playstation.com/concept/<id>` navigations (~30% during inspection). Per-claim retry bounces off the catalog page; run-level circuit breaker aborts after 3 consecutive blocks to avoid raising the account's bot score. Monthly Essentials are always claimed first (priority pass, no rate limit) because they expire each month. Conservative pacing defaults: 5 catalog drains per run with 30-60s jitter between claims. See [`docs/superpowers/specs/2026-05-26-playstation-plus-collector-design.md`](superpowers/specs/2026-05-26-playstation-plus-collector-design.md) for full design + risks. |
| **AliExpress** | **Deprecated channel — declining reliability** | Web coin collection is being phased out by AliExpress in favor of the mobile app (upstream confirms since Dec 2024). Works for some accounts, gates others with the AWSC slider, escalates long-running accounts to the "Network and device" prompt. **Manual cookie refresh every few weeks** is the realistic posture. We do not recommend depending on it. |
| **Watchers** (Lenovo, Humble, Fanatical, Ubisoft) | Reliable | No login, no scoring, no detection issues. |

### What we won't build, and why

- **Sidecar headless Chromium / Chromium-as-a-service via CDP**: marginal improvement (different Chromium build) at the cost of a long-term sidecar dependency. Doesn't conjure real hardware out of a container.
- **Cloud browser-as-a-service** (Browserless, Browserbase, Bright Data): real money (~$10–50/month) for one store worth ~$0.05/day in coins. Unit economics don't work for free-game claiming.
- **Android emulator path for AliExpress**: feasible (`amrka/android-emulator` + Appium), but a separate codebase, separate flows, separate fingerprint surface, and the AliExpress app has its own anti-tampering. 2–3 weekends of work for trivial ongoing value. Not happening.
- **Whole-project migration to a Firefox-based engine** (e.g. [Camoufox](https://github.com/daijro/camoufox), which spoofs at the C++ engine layer rather than via JS shim): genuinely changes the calculus on Category B for fingerprint-pressured stores. Tracked as a [PoC experiment](https://github.com/feldorn/free-games-claimer/tree/experiment/camoufox-poc) on a separate branch — does not land here unless results justify it.

### What you can do as a user

- **For AliExpress**: treat it as best-effort. Expect periodic manual cookie refresh via the **Cookie button** on the Sessions card. If it stops working entirely on your account, accept it — that's the channel deprecation tail catching up.
- **For other stores**: file an issue if a flow breaks. Category A drift is what we exist to chase.
- **For everything**: keep `NOTIFY` set so failures surface immediately — silent failures are how you discover a store has rolled out new detection three weeks late.

---

## Data Storage

All data lives in the `data/` directory (mounted as a Docker volume).

<details>
<summary><strong>File-by-file reference</strong></summary>

| Path | Contents |
|------|----------|
| `data/browser/` | Browser profiles with saved sessions (one per store) |
| `data/epic-games.json` | Claimed/seen Epic Games titles |
| `data/prime-gaming.json` | Claimed Prime Gaming titles, redeemed codes |
| `data/gog.json` | Claimed GOG titles |
| `data/gog-catalog-watch.json` | GOG catalog watch — slug-keyed state for the 100%-off-promo notification loop. Each entry stores `{title, url, firstSeen, lastSeenAt}`; re-notify fires when `lastSeenAt` ages past 30 days. Only relevant if you're seeing GOG-catalog notifications. |
| `data/steam.json` | Claimed Steam titles |
| `data/microsoft-rewards.json` | MS Rewards run history — `{at, session, before, after, earned}` per run (capped at 500 entries). Feeds the Stats tab's points KPIs. |
| `data/aliexpress.json` | AliExpress daily coin-collect history — `{at, balance, streak, tomorrow, collected, earned}` per run (capped at 500). Drives the AliExpress row in the Stats tab. Only written when the service is enabled. |
| `data/ubisoft-watch.json` · `data/humble-bundle-watch.json` · `data/fanatical-watch.json` · `data/lenovo-gaming-watch.json` | Watcher state — last-seen titles per site so re-notify only fires on genuinely new items. Lenovo's file additionally tracks per-drop scheduledAt, `userCollected` flags, and the next-wake offset for the panel scheduler. Only written when the corresponding watcher is enabled. |
| `data/ms-used-terms.json` | Microsoft Rewards — search terms used in the last 30 days (dedup window) |
| `data/config.json` | App-level config overrides written by the Settings tab. Missing = env/defaults in effect. Deleted = same as missing. |
| `data/runs.json` | Run-history log — per-run record (start time, source, exit code, duration, summary counters, full log buffer) for the last `RUN_HISTORY_MAX` runs (default 200). Powers the Logs tab's **Past runs** dropdown. Auto-trims; deleting clears history. |
| `data/scheduler-state.json` | Persistent wake anchor for the main scheduler — currently just `{ lastMainCompletedAt }`. Used by the LOOP-without-`START_TIME` path so panel restarts don't reset the 24h clock. Updated on every scheduler-main close; created lazily on first run. Safe to delete (next run falls back to "24h from boot" until the file is rewritten). |
| `data/screenshots/` | Screenshots of claim results |

</details>

---

## HTTP API

The panel exposes a small JSON API, useful for scripting or dashboard
integration. All endpoints are rooted at `<BASE_PATH>/api`.

<details>
<summary><strong>Endpoint reference</strong></summary>

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/state` | Current state: per-site status, scheduler info, last run, active browser, batch-redeem progress |
| `POST` | `/launch` | Open a visible browser for a site: `{ "site": "gog" }` |
| `POST` | `/verify` | After a manual login — verify + persist the session |
| `POST` | `/check` | Run a headless session probe: `{ "site": "microsoft" }` |
| `POST` | `/run-all` | Fire a claim run (background). Optional `{ sites: [...] }` body limits the run to those service ids; without a body, uses `CLAIM_CMD_MANUAL` semantics (everything except microsoft.js). The panel's Run-Now picker uses the body form. |
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
| `GET`  | `/runs` | List of past run summaries (no log payload — fast, used by the Logs-tab dropdown) |
| `GET`  | `/runs/:at` | Full record for one run, including its log buffer. `:at` is the URL-encoded `at` timestamp from the summary list |

</details>

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
