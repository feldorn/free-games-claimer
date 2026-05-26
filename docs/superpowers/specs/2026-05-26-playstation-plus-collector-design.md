# PlayStation Plus Collector — Design Spec

**Status:** approved, pre-implementation
**Date:** 2026-05-26
**Author:** Jason Coyne (designed jointly with Claude Code in the brainstorming skill)
**Related:** upstream issue [vogler/free-games-claimer#141](https://github.com/vogler/free-games-claimer/issues/141), discussion [#107](https://github.com/vogler/free-games-claimer/discussions/107), prototype branch [OJ7:psn](https://github.com/OJ7/free-games-claimer/tree/psn)

## Summary

Add a new claim collector for PlayStation Plus that runs as part of the daily-chain alongside Prime Gaming, Epic, GOG, and Steam. Each run claims (a) all current monthly PS Plus Essential picks unconditionally because they expire, then (b) a configurable number of additional PS-Plus-included catalog titles, rotating through the 200+ game backlog over several weeks.

Requires an active PS Plus subscription (any tier — Essential, Extra, or Premium). Default-off; opted in via `PSP_ACTIVE=1` or the Settings UI.

## Goals & non-goals

### In scope
- Discover the current month's Essential picks from `https://www.playstation.com/en-us/ps-plus/whats-new/`.
- Discover the full PS-Plus-included catalog from `https://www.playstation.com/en-us/ps-plus/games/`.
- For each game, navigate to its `store.playstation.com/{locale}/concept/<id>` page, read the CTA state via `data-qa="mfeCtaMain#cta#action"` + `data-telemetry-meta`, and click "Add to Library" when applicable.
- Configurable rate limit on the catalog drain. Monthly Essentials are always claimed in full (no budget cap).
- Login automation via `PSP_EMAIL` / `PSP_PASSWORD` / `PSP_OTPKEY` env vars, with fallback to manual login via the panel's noVNC handoff.
- FunCaptcha handoff using the existing `awaitUserCaptchaSolve` helper.
- Per-claim "rotate to bottom" retry: failed attempts get re-queued behind never-attempted entries, so a persistently-failing game doesn't block budget.

### Out of scope (deliberately)
- Non-US regions / locales. Hardcoded `en-us` for v1.
- A Discoveries-tab cross-reference. PS Plus listings on GamerPower / FreeGameFindings are noted as a fallback signal but not consumed for claiming.
- PSN API integration (`psnawp` / `npsso`-token flow). Browser scrape only.
- Anything beyond the catalog scrape — Day-One Plus releases, time-limited trials, region-exclusive bonuses, classic catalog (PS1-PS3 streaming).

## Architecture overview

### Two-source discovery, single runner

Each run does two independent discovery scrapes (both static HTML pages, ~1s each) and produces two lists:

| List | Source | Treatment |
|---|---|---|
| `monthlyEntries` | `/ps-plus/whats-new/` — the current month's expiring Essentials | **Priority pass** — claim all, no rate limit. Each retries every run until claimed or until they fall out of the monthly set. |
| `catalogEntries` | `/ps-plus/games/` — the full PS-Plus-included catalog (~242 titles) | **Drain pass** — up to `maxClaimsPerRun` per run, rotate-to-bottom on failure. |

The two sources have independent failure modes. Hard-failing the run is reserved for the case where *both* sources fail (extremely unlikely simultaneous breakage).

### Schedule + execution flow

```
daily-chain LOOP fires → existing claimers run → playstation-plus runs (claimOrder: 5)

  ensureLoggedIn(page)
  user = readUsername(page)   // .psw-c-secondary

  monthlyEntries = discoverMonthly(page)    // hard-warn if zero
  catalogEntries = discoverCatalog(page)    // soft-warn if < 50

  // Priority pass — every monthly not in DB, NO rate limit
  for entry in monthlyEntries where DB[entry.conceptId].status not in ('claimed','existed'):
    claimOne(page, entry, { priority: true })

  // Drain pass — rotate-to-bottom queue, up to maxClaimsPerRun
  candidates = catalogEntries
    .filter(e => not in monthly set)
    .filter(e => DB[e.conceptId].status not in ('claimed','existed'))
    .sort by (lastAttemptedAt asc, conceptId asc)
  for entry in candidates.slice(0, maxClaimsPerRun):
    claimOne(page, entry, { priority: false })
    jitterPause(claimPauseMinSec, claimPauseMaxSec)
    if consecutive Access-Denied >= 3: circuit-breaker abort
```

## Components

### `src/sites.js` — registry entry

```js
{
  id: 'playstation-plus',
  name: 'PlayStation Plus',
  version: '1.0',
  subtitle: 'Monthly Essentials (priority) + Extra/Premium catalog drain. Requires an active PS Plus subscription.',
  script: 'playstation-plus.js',
  claimOrder: 5,                            // after steam (4); aliexpress bumps to 6
  loginUrl: 'https://www.playstation.com/en-us/ps-plus/whats-new/',
  homeUrl:  'https://www.playstation.com/en-us/ps-plus/whats-new/',
  get browserDir() { return cfg.dir.browser + '-playstation'; },
  contextOptions: null,
  defaultActive: false,                     // opt-in (requires subscription)
  activeEnv: 'PSP_ACTIVE',
  linkedWith: null,
  claimDbFile: 'playstation-plus.json',
  scheduleKind: 'daily-chain',
  features: ['captcha-marker'],
  configFields: [
    { key: 'maxClaimsPerRun',    env: 'PSP_MAX_CLAIMS_PER_RUN',    type: 'number', default: 5,
      label: 'Max backlog claims per run', unit: 'games',
      hint: 'Monthly Essentials are always claimed in full (priority pass); this caps only the Extra/Premium catalog drain.',
      coerce: { kind: 'numberBounded', min: 0, fallback: 5 } },
    { key: 'claimPauseMinSec',   env: 'PSP_CLAIM_PAUSE_MIN_SEC',   type: 'number', default: 30,
      label: 'Min pause between claims', unit: 'seconds',
      coerce: { kind: 'numberBounded', min: 0, fallback: 30 } },
    { key: 'claimPauseMaxSec',   env: 'PSP_CLAIM_PAUSE_MAX_SEC',   type: 'number', default: 60,
      label: 'Max pause between claims', unit: 'seconds',
      coerce: { kind: 'numberBounded', min: 0, fallback: 60 } },
  ],
  async checkLogin(page) { /* see §Login */ },
}
```

**Isolated browser profile** (`-playstation` suffix) keeps Sony's cookies and fingerprint separate from the shared `data/browser/` profile, limiting cross-contamination from other sites' anti-bot states. Same pattern AliExpress already uses.

`claimOrder: 5` slots PlayStation Plus after Steam (4). AliExpress (currently 5) renumbers to 6.

### `playstation-plus.js` — runner

Standalone Node entrypoint at repo root, spawned by the panel as a child process. Mirrors `epic-games.js` / `steam.js` structure: imports, log header, db init, persistent Chromium context, SIGINT handling, claim loop, run summary, finalizer.

Key responsibilities:
1. Launch isolated patchright Chromium context.
2. Call `ensureLoggedIn(page)` — see Login section.
3. Read `user` via `.psw-c-secondary`. Initialise `db.data[user] ||= {}`.
4. Call `discoverMonthly(page)` and `discoverCatalog(page)`.
5. Run priority pass over monthlies (no rate limit).
6. Run drain pass over candidates with jitter pauses.
7. Watch Access-Denied circuit breaker.
8. `log.summary({ siteId, claimed, alreadyOwned, skipped, failed })` and notify.

### `src/playstation-plus-catalog.js` — discovery module

New file under `src/` matching the convention of `src/gamerpower.js` / `src/freegamefindings.js`.

```js
// Constants
const URL_WHATS_NEW = 'https://www.playstation.com/en-us/ps-plus/whats-new/';
const URL_CATALOG   = 'https://www.playstation.com/en-us/ps-plus/games/';
const CONCEPT_RE    = /^https:\/\/store\.playstation\.com\/[a-z]{2}-[a-z]{2}\/concept\/(\d+)\b/;

// API
export async function discoverMonthly(page)   // → [{ conceptId, conceptUrl, title, source:'whats-new' }]
export async function discoverCatalog(page)   // → [{ conceptId, conceptUrl, title, source:'catalog' }]
export function   parseConceptId(href)        // → string|null (pure helper, testable)
```

**`discoverMonthly` strategy:**
1. `page.goto(URL_WHATS_NEW)` → wait for networkidle (best-effort 15s) → 3s settle.
2. Probe the entire page for anchors matching `CONCEPT_RE`. Dedup by concept id.
3. **Sanity guard:** zero results → push a `status: 'action'` entry into the run summary with the message *"⚠ Monthly Essentials detection failed — Sony may have refactored /ps-plus/whats-new/. Check manually this month."* (so the user is notified that a deadline-critical claim may have slipped).
4. **Cross-reference logging** (informational): match titles against `fetchFGFPosts()` / `fetchGamerPowerGiveaways()` for the `playstation-plus` platform tag. If those aggregators list a monthly we missed, log it as an unhandled-discovery line. Does NOT trigger claiming on its own — just surfaces the gap.

**`discoverCatalog` strategy:**
1. `page.goto(URL_CATALOG)` → wait for networkidle (best-effort 20s) → 4s settle.
2. Scroll down ~5 viewport heights with 700ms pauses to trigger any lazy-load.
3. Match all anchors against `CONCEPT_RE`, dedup by concept id, strip `?smcid=…` query strings.
4. **Sanity guard:** count < 50 → log warning, skip the drain pass for this run but still attempt the priority pass.

### `data/playstation-plus.json` — claim database

Standard `{ user: { conceptId: entry } }` map. Keyed by `conceptId` (Sony's stable game identifier).

```js
db.data['FurorPotentia']['10009923'] = {
  title:           "Another Crab's Treasure",
  url:             'https://store.playstation.com/en-us/concept/10009923',
  status:          'claimed',
  time:            '2026-05-26 14:32:11',
  source:          'monthly' | 'catalog',
  conceptId:       '10009923',
  productId:       'UP7131-PPSA20422_00-ANOTHERCRABS4US5',
  ctaType:         'ADD_TO_LIBRARY',
  lastAttemptedAt: '2026-05-26 14:32:11',
};
```

**Status values:**
| Status | Treated as | Re-queue on next run? |
|---|---|---|
| `claimed` | success | no — terminal |
| `existed` | success (already in library) | no — terminal |
| `failed:access-denied` | failure | yes — rotated to back of queue |
| `failed` (generic) | failure | yes — rotated to back of queue |
| `skipped:not-included` | skip (CTA was `BUY` / `PRE_ORDER` / etc.) | yes — rotated to back of queue |

`lastAttemptedAt` updates on every attempt regardless of outcome. The drain-pass candidate sort uses it to push attempted entries to the back of the queue.

**Pruning churn:** every run, intersect the candidate list with the current `catalogEntries` scrape. Entries that no longer appear in the catalog are dropped from the candidate list silently (no notify, no DB mutation — history preserved). This handles Sony's monthly catalog rotation.

## Configuration & onboarding

**Active flag:**
- `PSP_ACTIVE=1` env var, or toggle in Settings → Per-service → PlayStation Plus.
- Defaults to **off** (subscription required; opt-in choice).

**Tunable behavior** (Settings UI + env vars):
| Setting | Env var | Default |
|---|---|---|
| Max backlog claims per run | `PSP_MAX_CLAIMS_PER_RUN` | 5 |
| Min pause between claims (sec) | `PSP_CLAIM_PAUSE_MIN_SEC` | 30 |
| Max pause between claims (sec) | `PSP_CLAIM_PAUSE_MAX_SEC` | 60 |

**Credentials (env-only, not exposed in Settings UI):**
- `PSP_EMAIL` (falls back to `EMAIL`)
- `PSP_PASSWORD` (falls back to `PASSWORD`)
- `PSP_OTPKEY` — TOTP secret for automated 2FA

**Two onboarding paths:**

1. **Cookie-only (simplest, recommended)** — Click *Login* on the PS Plus card in the Sessions tab. A visible browser opens via noVNC. Sign in manually (including any 2FA challenge from your phone). The browser profile cookie persists. No `PSP_*` env vars need to be set. Re-login required only when the session expires (typically weeks to months); the panel notifies you when it does.

2. **Fully automated relogin** — Set `PSP_EMAIL`, `PSP_PASSWORD`, and `PSP_OTPKEY` via `docker-compose.yml` `environment:` block or `data/config.env`. The runner will re-authenticate without user intervention when the session expires.

**Obtaining `PSP_OTPKEY`:**
1. Sign in to https://www.playstation.com/acct/management/security/ → 2-Step Verification.
2. If authenticator-app 2FA is already configured, disable and re-enable to see the secret (Sony does not show it after initial setup).
3. During the QR code step, look for *"Can't scan?"* or *"Enter manually"* — that reveals the Base32 secret.
4. Save the secret as `PSP_OTPKEY=...`. Also scan the QR with your authenticator app so your phone still works alongside the bot.

Caveat: users on SMS-based 2FA cannot use `PSP_OTPKEY` — either switch to authenticator-app 2FA, or accept that every relogin pauses and notifies for manual MFA via noVNC.

## Login flow

`ensureLoggedIn(page)` lives inside `playstation-plus.js`. Mirrors the OJ7 prototype's Sony Auth selectors (`my.account.sony.com`), ported to patchright Chromium and integrated with this project's helpers.

```js
1. page.goto(URL_WHATS_NEW).
2. Probe .psw-c-secondary (logged-in marker) vs. "Sign in" CTA with 8s timeout, return early if logged in.
3. If NOWAIT=1, exit(1).
4. Click "Sign in" → waits for redirect to my.account.sony.com.
5. If PSP_EMAIL+PSP_PASSWORD present:
     a. Fill #signin-entrance-input-signinId, click #signin-entrance-button.
     b. Fill #signin-password-input-password, click #signin-password-button.
     c. Race three fire-and-forget handlers:
        - #FunCaptcha → awaitUserCaptchaSolve(page, { service: 'playstation-plus', captchaCheck: ... })
        - input[title="Enter Code"] (MFA) → otplib.authenticator.generate(cfg.psp_otpkey) → fill + check "Trust this Browser" + submit
        - URL redirect back to playstation.com → success
   Else (no creds): notify + exit if headless, else wait for manual login.
6. Final wait for URL on playstation.com AND .psw-c-secondary visible.
```

**Registry-level `checkLogin(page)`** (panel session probe — separate from `ensureLoggedIn`):
```js
async checkLogin(page) {
  try {
    await page.goto(URL_WHATS_NEW, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    if (/my\.account\.sony\.com|signin\.account\.sony\.com/.test(page.url())) return { loggedIn: false };
    const userEl = page.locator('.psw-c-secondary').first();
    if (await userEl.count() === 0) return { loggedIn: false };
    const user = (await userEl.innerText()).trim();
    return { loggedIn: true, user: user || 'unknown' };
  } catch (e) {
    return { loggedIn: false, error: (e?.message || String(e)).split('\n')[0].slice(0, 200) };
  }
}
```

## Claim mechanics

Per-game (`claimOne(page, entry, { priority })`):

1. Call `attemptClaimWithBlockRecovery(page, entry)` — max 2 attempts:
   - `page.goto(entry.conceptUrl, { waitUntil: 'domcontentloaded' })`.
   - Wait networkidle (10s best-effort) + button selector `button[data-qa="mfeCtaMain#cta#action"]`.
   - Check `page.title()` — if matches `/^Access Denied/i`, on first attempt bounce off `URL_CATALOG`, pause 15–30s random, retry.
   - On second Access-Denied: return `'access-denied'`.
2. Parse `data-telemetry-meta` JSON from the CTA button. Branch on `ctaType`:
   - `ADD_TO_LIBRARY` → click. Race three success signals: button text → "In Library", `inline-toast` confirmation render, or `ctaType` re-read flips to `OWNED`. First to fire wins.
   - `OWNED` / `IN_LIBRARY` → mark `existed`, skip.
   - `BUY` / `PRE_ORDER` / other → mark `skipped:not-included`.
3. Persist DB row (title, url, status, time, source, conceptId, productId, ctaType, lastAttemptedAt). Screenshot on failure.
4. If there's another claim attempt coming after this one (in either pass), `jitterPause(claimPauseMinSec, claimPauseMaxSec)`. Pacing applies between any two attempts within the run, regardless of pass.

Selectors confirmed live during inspection (2026-05-26):
- `button[data-qa="mfeCtaMain#cta#action"]` — primary CTA (clickable)
- `data-telemetry-meta` attribute on the same button — JSON with `ctaType`, `productId`, `conceptId`, `ctaSubType`
- `[data-qa="mfeCtaMain#offer0#serviceIcon#ps-plus"]` — confirms offer 0 is PS-Plus-included
- `.psw-c-secondary` — username

## Access-Denied recovery

**Per-claim retry loop** (described in claim mechanics above): 2 attempts, second one prefixed by a bounce off `URL_CATALOG` to refresh the natural traffic referer.

**Run-level circuit breaker:**
```js
const ACCESS_DENIED_RUN_BUDGET = 3;
let consecutiveBlocks = 0;
// after every drain-pass attempt:
if (outcome === 'access-denied') {
  if (++consecutiveBlocks >= ACCESS_DENIED_RUN_BUDGET) {
    log.fail('Access-Denied circuit breaker tripped — aborting run');
    notify_games.push({
      title: '⚠ PS Plus run aborted — Sony bot block',
      url:   'https://store.playstation.com/',
      status: 'action',
      details: 'Akamai bot manager scored this session too high. Run aborted to avoid raising the score further. Will retry on the next scheduled run.',
    });
    break;
  }
} else {
  consecutiveBlocks = 0;
}
```

Per-game `failed:access-denied` entries do NOT trigger push notifications (they show in the body table only). The circuit-breaker abort DOES trigger a push (`kind: 'action'`).

## Captcha handling

Sony's Arkose **FunCaptcha** is the captcha vendor. Expected vector: login flow (`my.account.sony.com`), not store browsing.

Detection + handoff uses the existing project helper:
```js
await awaitUserCaptchaSolve(page, {
  service: 'playstation-plus',
  label: 'FunCaptcha (PSN login)',
  captchaCheck: async () => (await page.locator('#FunCaptcha').count()) === 0,
});
```

This:
- Emits the `[CAPTCHA-START]` / `[CAPTCHA-END]` markers the panel parses.
- Sends an apprise notification with `priority: cfg.captcha_notify_priority` and the panel deep-link.
- Polls every 2s for `captchaCheck()` to return truthy. Times out after 10 min.

The `captcha-marker` feature in the registry entry tells the engine this service participates.

## Rate limiting & pacing

Three config knobs (described in Configuration). Pacing is applied between catalog drain claims AND between monthly priority claims:

```js
const pause = randomMs(cfg.psp_claim_pause_min_sec * 1000, cfg.psp_claim_pause_max_sec * 1000);
if (!isLastAttempt) await page.waitForTimeout(pause);
```

`randomMs(min, max)` already exists in `microsoft.js`; lifted to `src/util.js` if not already exported.

**Run-time estimate at defaults** (5 drain + ~3 monthly):
- 8 page loads × ~5s each = 40s navigation
- 7 inter-claim pauses × 45s avg = 5min 15s
- Total: ~6 min per run

Acceptable for `daily-chain` placement.

**Special values:**
- `PSP_MAX_CLAIMS_PER_RUN=0` disables drain but keeps monthly priority.
- `claimPauseMin=0` removes jitter (debug only).

## Run summary & notifications

Standard `log.summary({ siteId, claimed, alreadyOwned, skipped, failed })` at end of run. The `claimed` / `alreadyOwned` counters split monthlies and catalog totals internally for human-readable summary text:

> *"PlayStation Plus (FurorPotentia): claimed 2 monthly + 4 catalog, 1 already owned, 0 failed."*

`notify_games` is built as the standard array of `{ title, url, status, details? }`. Statuses that flow into the per-run notification body:
- `claimed`, `existed`, `failed`, `failed:access-denied`, `skipped:not-included`, `action` (circuit breaker / monthly-detection-failed warning).

Notification `kind` follows the project convention:
- Any `action` or `failed:*` entry → `kind: 'action'` (surfaces above noise).
- All-`claimed` / `existed` → `kind: 'summary'` (respects `NOTIFY_LEVEL=actions`).

## Open risks

### High
| ID | Risk | Mitigation |
|---|---|---|
| R1 | Akamai bot scoring is account-level and can persist for days. | Conservative defaults, isolated browser profile, circuit breaker. Accepted residual risk: users may need to manually pause the service for days. Will be documented in README bot-detection addendum. |
| R2 | Whats-new page may not contain per-game anchors at all. We confirmed the `#monthly-games` heading block is empty but assumed sibling blocks contain CTAs. Not verified live. | `discoverMonthly` sanity guard fails loudly (notify) when zero monthlies detected. Pre-merge testing (below) verifies the discovery selectors return ≥ 1 entry. If absent, FGF/GamerPower cross-reference becomes mandatory, not optional — we'd revise this spec before implementation. |
| R3 | "Add to Library → In Library" state transition not observed live. | Three-signal race (Epic pattern): button-text flip + toast render + ctaType re-read. **First test run, observe live transition and tune.** |

### Medium
| ID | Risk | Mitigation |
|---|---|---|
| R4 | Catalog rotation: games leave the catalog between attempts. | Every run, intersect candidate list with current catalog scrape. Drop missing entries silently from candidate list. Keep DB record for stats history. |
| R5 | Hardcoded `en-us` locale. | Out of scope for v1. Add `PSP_LOCALE` field if/when a non-US user complains. |
| R6 | Catalog page anchors had `hasImg: false` during inspection — possible lazy-load skew. | Production discovery scrolls 5 viewport heights to trigger lazy-load. Verify count stability on first real run. |

### Low
| ID | Risk | Mitigation |
|---|---|---|
| R7 | Subscription lapse → all catalog CTAs read `BUY`, runner correctly skips all as `skipped:not-included`. | Add a `log.warn` when drain-pass success rate is exactly 0 ("subscription lapsed or CTA enum renamed"). |
| R8 | Sony renames `ctaType` enum values. | Persist `ctaType` to DB. `log.warn` on any unknown enum value. |
| R9 | First-ever run claims ~8 games in quick succession (no DB history). | Accepted. Alternative (warmup mode) is over-engineering. |

## Testing & verification

### Pre-merge
1. `npm run lint` passes.
2. **Before writing the runner:** re-probe whats-new with the full-page regex match from `discoverMonthly` (not the prototype's child-of-`#monthly-games` selector). Confirm at least one `store.playstation.com/.../concept/<id>` anchor is returned on the live page (resolves R2). If zero, revise this spec to make FGF/GamerPower cross-reference the primary monthly source, not just a sanity log.
3. Manually trigger one test run with `PSP_MAX_CLAIMS_PER_RUN=1`. Observe:
   - Login flow completes (cookie-based; we already have a logged-in profile from inspection).
   - Username extraction returns `FurorPotentia`.
   - Monthly discovery returns ≥ 1 entry.
   - Catalog discovery returns ≥ 100 entries.
   - Claim attempt on one entry either succeeds (state transition observed and locked in — resolves R3) OR cleanly skips with a `skipped:not-included` if `ctaType` isn't `ADD_TO_LIBRARY` for that one entry.
4. Settings → Per-service → PS Plus renders all three configurable fields.
5. Toggling `PSP_ACTIVE` round-trips through `/api/config` and is honored on next run.
6. Container boots clean with PS Plus enabled.

### Post-merge (longer-horizon)
- First week: monitor for `failed:access-denied` rate. If above ~30%, tune defaults.
- First month: confirm a monthly Essential transition is captured correctly (priority pass claims it within the month).
- Three months: confirm rotate-to-bottom queue completes a full lap (242 / 5 ≈ 49 days at default settings).

## Implementation notes (for the writing-plans handoff)

Files to add:
- `playstation-plus.js` (repo root, ~400 lines)
- `src/playstation-plus-catalog.js` (~150 lines)

Files to modify:
- `src/sites.js` — add registry entry, bump AliExpress `claimOrder` from 5 to 6.
- `src/config.js` — add `psp_*` exports reading from the new `services['playstation-plus']` block + env fallbacks.
- `src/util.js` — export `randomMs` if not already (`microsoft.js` defines it locally; verify before importing). `awaitUserCaptchaSolve` already exists with the signature `(page, { service, label, captchaCheck, timeoutMs, pollMs })` — confirmed during spec review.
- `docs/REFERENCE.md` — add PlayStation Plus row under "Bot detection — what works, what doesn't" with the Category B classification (real fingerprint pressure, intermittent Access-Denied).
- `docs/CONFIGURATION.md` — add `PSP_*` env vars + onboarding notes.
- `CHANGELOG.md` — version bump entry once shipped.

Files unchanged but worth re-reading during implementation:
- `epic-games.js` — closest precedent for captcha pause + post-click success race + cart fallback (we don't need cart fallback but the success race is the model).
- `steam.js` — closest precedent for per-game filter logic (skip-if-rating-below pattern; ours is skip-if-ctaType-not-ADD_TO_LIBRARY).
- `aliexpress.js` — closest precedent for isolated browser profile + mobile-style discovery (our discovery is desktop but the profile-isolation rationale is the same).

## Decisions ledger

| # | Decision | Rationale |
|---|---|---|
| 1 | Single runner, two scrapes (not separate runners) | Both scrapes serve one claim flow; splitting them adds operational complexity for zero gain. |
| 2 | `daily-chain` schedule, not `daily-window` | Our run is short (~6 min). Random-window scheduling is overkill; randomized per-claim pauses already provide timing variation. |
| 3 | Isolated browser profile (`-playstation` suffix) | Sony's bot scoring is account-level. Avoiding cross-contamination with other sites' anti-bot state buys insurance for little cost. |
| 4 | Rotate-to-bottom queue, not 3-strikes-abandonment | Every game stays retriable indefinitely; a persistently-failing game gets one attempt per "lap" through the catalog instead of blocking budget every run. |
| 5 | Credentials env-only, not Settings UI | Project-wide convention from CONTRIBUTING.md. `data/config.json` is exposed via `/api/config`; secrets don't belong there. |
| 6 | Read `ctaType` from `data-telemetry-meta`, not button text | More stable than visible text. Survives copy refreshes (Sony has rotated button labels at least twice historically). |
| 7 | Hard-fail (notify) on zero monthlies discovered | A silent zero-monthlies result would let a deadline-critical claim slip — worse than a noisy false alarm. |
| 8 | Don't claim from GamerPower/FGF, only log gaps | Catalog scrape is the canonical source; the aggregators are noisier and slower-updated. Use them as a sanity signal, not a claim source. |
