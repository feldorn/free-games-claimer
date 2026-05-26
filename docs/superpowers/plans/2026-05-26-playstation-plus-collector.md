# PlayStation Plus Collector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `playstation-plus` claim collector that claims expiring monthly Essential picks unconditionally and drains the PS-Plus-included catalog at a configurable rate.

**Architecture:** Standalone Node runner at repo root (`playstation-plus.js`), spawned by the existing panel/scheduler as a child process via the `src/sites.js` registry. Two-source discovery (whats-new + catalog) in a new helper `src/playstation-plus-catalog.js`. Per-game claim flow reads `data-qa="mfeCtaMain#cta#action"`'s `data-telemetry-meta` to branch on `ctaType`. Access-Denied recovery via per-attempt bounce + run-level circuit breaker. Rate limit via `PSP_MAX_CLAIMS_PER_RUN`.

**Tech Stack:** Node 22 ESM, patchright Chromium, lowdb for the claim DB, otplib for TOTP, existing project helpers (`jsonDb`, `datetime`, `notify`, `awaitUserCaptchaSolve`, `log`, `cleanProfileLocks`, `handleSIGINT`, `closeContextSafely`).

**Spec:** [`docs/superpowers/specs/2026-05-26-playstation-plus-collector-design.md`](../specs/2026-05-26-playstation-plus-collector-design.md). The spec is the design source of truth; this plan is the build sequence.

> **2026-05-26 spec revision (post-Task-0 finding):** The Task 0 probe revealed that Sony's whats-new page links monthly Essentials to `playstation.com/en-us/games/<slug>/` (marketing pages), not `store.playstation.com/concept/<id>` (the claim surface). The spec was revised to scrape slug URLs in `discoverMonthlyRaw`, then **join to the catalog by fuzzy title match** (`matchMonthlyToCatalog` + `normalizeTitle`) so all claims still route through the unified concept-URL flow. Task 1 and Task 5 task descriptions reflect the revised API (`discoverMonthlyRaw`, `matchMonthlyToCatalog`, `normalizeTitle`); the bodies inline below in this plan document predate the revision and should not be followed verbatim — read the live TaskGet output for the canonical instructions.

---

## File Structure

**Created:**
- `playstation-plus.js` — runner entrypoint (~400 lines).
- `src/playstation-plus-catalog.js` — discovery helpers (~150 lines).
- `test/ps-catalog.js` — ad-hoc verification script for `parseConceptId` (~30 lines).

**Modified:**
- `src/sites.js` — add PS Plus registry entry; bump `aliexpress.claimOrder` from 5 → 6.
- `src/config.js` — add `psp_*` exports reading from `services['playstation-plus']` + env fallbacks; expose `psp_email`/`psp_password`/`psp_otpkey` as env-only.
- `docs/REFERENCE.md` — add a PS Plus row under "Bot detection — what works, what doesn't" (Category B, Akamai-pressured).
- `docs/CONFIGURATION.md` — add `PSP_*` env vars + onboarding (cookie-only vs. fully-automated paths).
- `CHANGELOG.md` — release-note entry.

**Untouched but referenced for patterns:**
- `epic-games.js` — captcha pause, success-signal race, retry loop precedent.
- `steam.js` — per-game filter-and-skip precedent.
- `aliexpress.js` — isolated browser profile precedent.

---

## Task 0: Pre-merge probe — confirm monthly anchors exist on whats-new

**Goal:** Resolve spec risk R2 before writing the runner. The earlier inspection scanned only *inside* the `#monthly-games` block and found zero anchors. This task scans the whole page and confirms at least one `store.playstation.com/{locale}/concept/<id>` anchor is reachable.

**Files:**
- Create: `test/ps-monthly-probe.js`

**Acceptance Criteria:**
- [ ] Probe reports ≥ 1 concept-URL anchor whose containing block's heading or nearby text mentions "monthly" or contains a known June 2026 monthly title (Grounded / Nickelodeon All-Star Brawl 2 / Warhammer Darktide).
- [ ] If 0 anchors found, halt the plan: open a follow-up to revise the spec so FGF/GamerPower becomes the primary monthly source, and document the live whats-new structure.

**Verify:** `node test/ps-monthly-probe.js` → final line `MONTHLY ANCHORS FOUND: N` where N ≥ 1.

**Steps:**

- [ ] **Step 1: Write the probe script**

Create `test/ps-monthly-probe.js`:

```js
// One-shot probe: scan https://www.playstation.com/en-us/ps-plus/whats-new/ for
// store.playstation.com/{locale}/concept/<id> anchors. Resolves spec risk R2
// (whats-new lost its per-game anchors during a Sony refactor — confirm
// they're still discoverable somewhere on the page).
//
// Reuses the data/browser-playstation profile from the inspection session
// (already logged in).

import { chromium } from 'patchright';
import path from 'node:path';

const PROFILE_DIR = path.resolve('data/browser-playstation');
const URL_WHATS_NEW = 'https://www.playstation.com/en-us/ps-plus/whats-new/';
const CONCEPT_RE = /^https:\/\/store\.playstation\.com\/[a-z]{2}-[a-z]{2}\/concept\/(\d+)\b/;

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  locale: 'en-US',
  args: ['--hide-crash-restore-bubble'],
});
const page = context.pages()[0] || await context.newPage();

await page.goto(URL_WHATS_NEW, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(3000);

// Scroll through the page to trigger any lazy-loaded sibling blocks.
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
  await page.waitForTimeout(500);
}

const results = await page.evaluate((reSrc) => {
  const re = new RegExp(reSrc);
  const seen = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const m = re.exec(href);
    if (!m) continue;
    const conceptId = m[1];
    if (seen.has(conceptId)) continue;
    // Capture context: the anchor text + nearest heading text above it.
    let h = a.closest('section, div')?.querySelector('h1, h2, h3')?.textContent?.trim().slice(0, 80) || null;
    seen.set(conceptId, {
      conceptId,
      href,
      text: (a.textContent || '').trim().slice(0, 80),
      nearestHeading: h,
    });
  }
  return [...seen.values()];
}, CONCEPT_RE.source);

console.log('--- ANCHORS ---');
for (const r of results) console.log(JSON.stringify(r));
console.log(`MONTHLY ANCHORS FOUND: ${results.length}`);

await context.close();
process.exit(0);
```

- [ ] **Step 2: Run the probe**

Run: `node test/ps-monthly-probe.js`

Expected: closes browser cleanly after 10-15s. Prints one JSON line per discovered anchor, then `MONTHLY ANCHORS FOUND: N`.

- [ ] **Step 3: Inspect output and decide**

- If `N >= 1` and at least one entry's `nearestHeading` contains "monthly" OR the `text` field matches a known monthly title (Grounded, Nickelodeon, Warhammer for June 2026): **proceed to Task 1**. Note the count and the heading text in a comment in this task's task description so the next agent sees what was observed.
- If `N == 0` or all matches look unrelated to monthlies (catalog links bleeding through nav): **STOP**. Open a follow-up to revise the spec — FGF/GamerPower cross-reference becomes the primary monthly source. Do not proceed to Task 1 without first revising the spec.

- [ ] **Step 4: Commit the probe**

```bash
git add test/ps-monthly-probe.js
git commit -m "$(cat <<'EOF'
test: ad-hoc probe for PS Plus whats-new monthly anchors

Resolves spec risk R2 before writing the runner. Kept under test/ alongside
other ad-hoc verification scripts (test/notify.js, test/webgl.js).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1: Discovery module + parseConceptId unit test

**Goal:** Create `src/playstation-plus-catalog.js` exposing `discoverMonthly(page)`, `discoverCatalog(page)`, and pure helper `parseConceptId(href)`. Add a tiny self-test for `parseConceptId` in `test/ps-catalog.js` following the project's existing ad-hoc test convention.

**Files:**
- Create: `src/playstation-plus-catalog.js`
- Create: `test/ps-catalog.js`

**Acceptance Criteria:**
- [ ] `parseConceptId` handles: bare concept URL, URL with `?smcid=...` query, URL with locale variants (`en-us`, `en-gb`, `de-de`), and non-concept URLs (returns `null`).
- [ ] `discoverMonthly(page)` returns an array of `{ conceptId, conceptUrl, title, source: 'whats-new' }`, deduped by conceptId.
- [ ] `discoverCatalog(page)` returns an array of `{ conceptId, conceptUrl, title, source: 'catalog' }`, deduped by conceptId, with `?smcid=...` stripped.
- [ ] `npm run lint` passes after adding the file.

**Verify:** `node test/ps-catalog.js` → prints `parseConceptId tests: 8/8 OK` and exits 0.

**Steps:**

- [ ] **Step 1: Write `src/playstation-plus-catalog.js`**

Create `src/playstation-plus-catalog.js`:

```js
// PlayStation Plus discovery helpers. Two scrapes per run:
//   discoverMonthly(page) → current month's Essential picks (priority claim)
//   discoverCatalog(page) → full PS-Plus-included catalog (~200+ titles)
//
// Each returns: [{ conceptId, conceptUrl, title, source }]
// Concept URLs all live on store.playstation.com/{locale}/concept/<id>.

const URL_WHATS_NEW = 'https://www.playstation.com/en-us/ps-plus/whats-new/';
const URL_CATALOG   = 'https://www.playstation.com/en-us/ps-plus/games/';
const CONCEPT_RE    = /^https:\/\/store\.playstation\.com\/[a-z]{2}-[a-z]{2}\/concept\/(\d+)\b/;

// Pure helper — extract concept id from any concept URL, regardless of query.
// Returns null on non-match. Exposed for testability.
export function parseConceptId(href) {
  if (!href || typeof href !== 'string') return null;
  const m = CONCEPT_RE.exec(href);
  return m ? m[1] : null;
}

// Strip ?smcid=... and other marketing tracking params so two URLs differing
// only by tracking dedup correctly.
function canonicalizeConceptUrl(href) {
  const m = CONCEPT_RE.exec(href);
  if (!m) return href;
  return `https://store.playstation.com/en-us/concept/${m[1]}`;
}

// Scrape https://www.playstation.com/en-us/ps-plus/whats-new/ for the current
// month's Essential picks. The #monthly-games heading block on this page is
// pure marketing — per-game anchors live in sibling blocks lower on the page
// (verified pre-merge in test/ps-monthly-probe.js).
export async function discoverMonthly(page) {
  await page.goto(URL_WHATS_NEW, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  // Cheap insurance against lazy-loaded sibling blocks.
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await page.waitForTimeout(500);
  }
  const raw = await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc);
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href) continue;
      const m = re.exec(href);
      if (!m) continue;
      const conceptId = m[1];
      if (seen.has(conceptId)) continue;
      seen.set(conceptId, {
        conceptId,
        href,
        title: (a.textContent || '').trim().slice(0, 160)
          || a.getAttribute('aria-label')?.slice(0, 160)
          || `Concept ${conceptId}`,
      });
    }
    return [...seen.values()];
  }, CONCEPT_RE.source);
  return raw.map(r => ({
    conceptId: r.conceptId,
    conceptUrl: canonicalizeConceptUrl(r.href),
    title: r.title,
    source: 'whats-new',
  }));
}

// Scrape https://www.playstation.com/en-us/ps-plus/games/ for the full
// catalog. Returns 200+ entries on a healthy run; < 50 is a strong signal
// the scrape failed or the user isn't logged in (caller treats this as a
// soft warning and skips the drain pass).
export async function discoverCatalog(page) {
  await page.goto(URL_CATALOG, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4000);
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await page.waitForTimeout(700);
  }
  const raw = await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc);
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const m = re.exec(href);
      if (!m) continue;
      const conceptId = m[1];
      if (seen.has(conceptId)) continue;
      seen.set(conceptId, {
        conceptId,
        href,
        title: (a.textContent || '').trim().slice(0, 160)
          || a.getAttribute('aria-label')?.slice(0, 160)
          || `Concept ${conceptId}`,
      });
    }
    return [...seen.values()];
  }, CONCEPT_RE.source);
  return raw.map(r => ({
    conceptId: r.conceptId,
    conceptUrl: canonicalizeConceptUrl(r.href),
    title: r.title,
    source: 'catalog',
  }));
}

export { URL_WHATS_NEW, URL_CATALOG };
```

- [ ] **Step 2: Write the parseConceptId self-test**

Create `test/ps-catalog.js`:

```js
// Manual smoke test for src/playstation-plus-catalog.js. Project pattern:
// ad-hoc test scripts under test/, runnable directly with node.

import { parseConceptId } from '../src/playstation-plus-catalog.js';

const cases = [
  // [input, expected]
  ['https://store.playstation.com/en-us/concept/10009923',               '10009923'],
  ['https://store.playstation.com/en-us/concept/228903',                 '228903'],
  ['https://store.playstation.com/en-us/concept/10009923?smcid=foo',     '10009923'],
  ['https://store.playstation.com/en-gb/concept/10009923',               '10009923'],
  ['https://store.playstation.com/de-de/concept/10003817?smcid=pdc:bar', '10003817'],
  ['https://www.playstation.com/en-us/games/another-crab/',              null],
  ['https://store.playstation.com/en-us/product/UP7131-PPSA20422_00',    null],
  ['',                                                                    null],
];

let pass = 0, fail = 0;
for (const [input, expected] of cases) {
  const got = parseConceptId(input);
  if (got === expected) { pass++; }
  else { fail++; console.error(`FAIL: ${JSON.stringify(input)} → expected ${JSON.stringify(expected)} got ${JSON.stringify(got)}`); }
}
console.log(`parseConceptId tests: ${pass}/${pass + fail} OK`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 3: Run the test**

Run: `node test/ps-catalog.js`

Expected: `parseConceptId tests: 8/8 OK`, exit 0.

- [ ] **Step 4: Lint**

Run: `npm run lint`

Expected: clean exit.

- [ ] **Step 5: Commit**

```bash
git add src/playstation-plus-catalog.js test/ps-catalog.js
git commit -m "$(cat <<'EOF'
feat(ps-plus): discovery module + parseConceptId tests

discoverMonthly / discoverCatalog scrape playstation.com for PS-Plus-included
concept URLs. parseConceptId is a pure helper with 8 round-trip tests under
test/ps-catalog.js following the project's ad-hoc test convention.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Registry entry + config plumbing

**Goal:** Register PS Plus in `src/sites.js`, bump AliExpress claimOrder from 5 to 6, and add `psp_*` exports to `src/config.js`. After this task the panel's Settings UI renders the PS Plus row with all three configurable fields, and `node` can `import { cfg } from './src/config.js'` and see the new `psp_*` keys.

**Files:**
- Modify: `src/sites.js` (insert PS Plus entry, renumber AliExpress)
- Modify: `src/config.js` (add `psp_*` exports)

**Acceptance Criteria:**
- [ ] `src/sites.js` exports a `SITES` array containing a `playstation-plus` entry with the registry shape from the spec.
- [ ] `aliexpress` entry's `claimOrder` is 6 (was 5).
- [ ] `src/config.js` exports `psp_email`, `psp_password`, `psp_otpkey`, `psp_max_claims_per_run`, `psp_claim_pause_min_sec`, `psp_claim_pause_max_sec` on the `cfg` object.
- [ ] Quick smoke import test confirms defaults and overrides work.
- [ ] `npm run lint` passes.

**Verify:** `node -e "import('./src/config.js').then(({cfg}) => console.log({max: cfg.psp_max_claims_per_run, min: cfg.psp_claim_pause_min_sec, max_sec: cfg.psp_claim_pause_max_sec}))"` → `{ max: 5, min: 30, max_sec: 60 }` (or env overrides if set).

**Steps:**

- [ ] **Step 1: Read the area we're editing in `src/sites.js`**

Read `src/sites.js` to confirm the current ordering of SITES entries and the AliExpress `claimOrder: 5` line is still where we expect it (referencing spec Section 1 of the design doc).

- [ ] **Step 2: Bump AliExpress claimOrder from 5 to 6 in `src/sites.js`**

Find the `aliexpress` entry. Change:

```js
claimOrder: 5,
```

To:

```js
claimOrder: 6,
```

- [ ] **Step 3: Insert the PS Plus registry entry after the `steam` entry in `src/sites.js`**

Locate the closing `},` of the `steam` entry. Insert the following block immediately after it:

```js
  {
    id: 'playstation-plus',
    name: 'PlayStation Plus',
    version: '1.0',
    subtitle: 'Monthly Essentials (priority) + Extra/Premium catalog drain. Requires an active PS Plus subscription.',
    script: 'playstation-plus.js',
    claimOrder: 5,
    loginUrl: 'https://www.playstation.com/en-us/ps-plus/whats-new/',
    homeUrl:  'https://www.playstation.com/en-us/ps-plus/whats-new/',
    get browserDir() { return cfg.dir.browser + '-playstation'; },
    contextOptions: null,
    defaultActive: false,
    activeEnv: 'PSP_ACTIVE',
    linkedWith: null,
    claimDbFile: 'playstation-plus.json',
    scheduleKind: 'daily-chain',
    features: ['captcha-marker'],
    configFields: [
      { key: 'maxClaimsPerRun',  env: 'PSP_MAX_CLAIMS_PER_RUN',  type: 'number', default: 5,
        label: 'Max backlog claims per run', unit: 'games',
        hint: 'Monthly Essentials are always claimed in full (priority pass); this caps only the Extra/Premium catalog drain.',
        coerce: { kind: 'numberBounded', min: 0, fallback: 5 } },
      { key: 'claimPauseMinSec', env: 'PSP_CLAIM_PAUSE_MIN_SEC', type: 'number', default: 30,
        label: 'Min pause between claims', unit: 'seconds',
        coerce: { kind: 'numberBounded', min: 0, fallback: 30 } },
      { key: 'claimPauseMaxSec', env: 'PSP_CLAIM_PAUSE_MAX_SEC', type: 'number', default: 60,
        label: 'Max pause between claims', unit: 'seconds',
        coerce: { kind: 'numberBounded', min: 0, fallback: 60 } },
    ],
    async checkLogin(page) {
      try {
        await page.goto('https://www.playstation.com/en-us/ps-plus/whats-new/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        if (/my\.account\.sony\.com|signin\.account\.sony\.com/.test(page.url())) return { loggedIn: false };
        const userEl = page.locator('.psw-c-secondary').first();
        if (await userEl.count() === 0) return { loggedIn: false };
        const user = (await userEl.innerText()).trim();
        return { loggedIn: true, user: user || 'unknown' };
      } catch (e) {
        return { loggedIn: false, error: (e && e.message ? e.message.split('\n')[0] : String(e)).slice(0, 200) };
      }
    },
  },
```

- [ ] **Step 4: Add the PS Plus accessor block in `src/config.js`**

Find the existing per-service destructuring near the top of `src/config.js`. Add a new line alongside the others:

```js
const psp   = svc['playstation-plus'] || {};
```

Then add the `psp_*` accessors at the end of the `cfg` object literal (before the closing `};`). Insert this block:

```js
  // auth playstation plus (credentials stay env-only — see CONTRIBUTING.md)
  psp_email:    process.env.PSP_EMAIL    || process.env.EMAIL,
  psp_password: process.env.PSP_PASSWORD || process.env.PASSWORD,
  psp_otpkey:   process.env.PSP_OTPKEY,
  // Drain pace — Monthly Essentials are claimed unconditionally; this caps
  // only the Extra/Premium catalog drain. 5 with 30-60s jitter drains ~242
  // games in ~7 weeks at one run/day. Tunable via Settings → PS Plus.
  psp_max_claims_per_run: psp.maxClaimsPerRun ?? 5,
  psp_claim_pause_min_sec: psp.claimPauseMinSec ?? 30,
  psp_claim_pause_max_sec: psp.claimPauseMaxSec ?? 60,
```

- [ ] **Step 5: Smoke-test the config import**

Run:

```
node -e "import('./src/config.js').then(({cfg}) => console.log({max: cfg.psp_max_claims_per_run, min: cfg.psp_claim_pause_min_sec, max_sec: cfg.psp_claim_pause_max_sec, hasEmail: !!cfg.psp_email}))"
```

Expected (when env unset): `{ max: 5, min: 30, max_sec: 60, hasEmail: false }`.

Run again with overrides:

```
PSP_MAX_CLAIMS_PER_RUN=10 PSP_EMAIL=foo@example.com node -e "import('./src/config.js').then(({cfg}) => console.log({max: cfg.psp_max_claims_per_run, hasEmail: !!cfg.psp_email}))"
```

Expected: `{ max: 10, hasEmail: true }`.

- [ ] **Step 6: Lint**

Run: `npm run lint`

Expected: clean exit.

- [ ] **Step 7: Commit**

```bash
git add src/sites.js src/config.js
git commit -m "$(cat <<'EOF'
feat(ps-plus): registry entry + config plumbing

claimOrder 5 (slots after Steam, AliExpress bumps to 6). defaultActive false
because the service requires an active PS Plus subscription. configFields
expose maxClaimsPerRun / claimPauseMin/MaxSec. Credentials stay env-only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Runner skeleton + login flow

**Goal:** Create `playstation-plus.js` end-to-end up to the point where the runner successfully signs in (or already is signed in via persistent profile), reads the username, prepares the DB, and exits cleanly without attempting any claims. Validates Section 6 of the spec.

**Files:**
- Create: `playstation-plus.js`

**Acceptance Criteria:**
- [ ] Running `node playstation-plus.js` with the already-logged-in `data/browser-playstation` profile prints `Signed in as 'FurorPotentia'` and exits 0.
- [ ] Running with a fresh profile + `PSP_EMAIL`/`PSP_PASSWORD`/`PSP_OTPKEY` set drives the Sony Auth flow to completion.
- [ ] Running with no credentials + headless = false waits for manual sign-in via the visible browser.
- [ ] Running with `NOWAIT=1` and a stale session exits 1 quickly without prompting.
- [ ] `npm run lint` passes.

**Verify:** `node playstation-plus.js` (with the existing logged-in profile) → final lines include `Signed in as 'FurorPotentia'` and `Run summary: claimed 0` (or similar — counts are zero since claim logic comes in Task 4).

**Steps:**

- [ ] **Step 1: Create `playstation-plus.js` with the imports, log header, DB init, browser context, login flow, and a placeholder summary**

Create `playstation-plus.js`:

```js
import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  jsonDb, datetime, filenamify, prompt, notify, html_game_list,
  handleSIGINT, closeContextSafely, log, cleanProfileLocks, awaitUserCaptchaSolve,
} from './src/util.js';
import { cfg } from './src/config.js';
import { siteVersion } from './src/sites.js';
import { discoverMonthly, discoverCatalog, URL_WHATS_NEW } from './src/playstation-plus-catalog.js';

const screenshot = (...a) => path.resolve(cfg.dir.screenshots, 'playstation-plus', ...a);

log.section(`PlayStation Plus (v${siteVersion('playstation-plus')})`);
log.status('Time', datetime());
log.status('Max backlog/run', cfg.psp_max_claims_per_run);
log.status('Pause range', `${cfg.psp_claim_pause_min_sec}-${cfg.psp_claim_pause_max_sec}s`);

const db = await jsonDb('playstation-plus.json', {});
const notify_games = [];
let user;

const PROFILE_DIR = cfg.dir.browser + '-playstation';
cleanProfileLocks(PROFILE_DIR);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US',
  handleSIGINT: false,
  args: ['--hide-crash-restore-bubble'],
});
handleSIGINT(context);
if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
const page = context.pages().length ? context.pages()[0] : await context.newPage();

try {
  await ensureLoggedIn(page);
  user = (await page.locator('.psw-c-secondary').first().innerText().catch(() => '')).trim() || 'unknown';
  log.status('User', user);
  db.data[user] ||= {};

  // Claim logic comes in Task 4. For now, just report and exit.
  log.summary({
    siteId: 'playstation-plus',
    claimed: 0,
    skipped: 0,
    display: 'alreadyOwned',
    alreadyOwned: 0,
    failed: 0,
  });
} catch (error) {
  process.exitCode ||= 1;
  log.exception(error);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode != 130) {
    await notify(`playstation-plus failed: ${error.message.split('\n')[0]}`, { attachLatestScreenshot: true });
  }
} finally {
  await db.write();
  if (notify_games.length) {
    const hasActionable = notify_games.some(g => g.status === 'failed' || g.status === 'action' || /^failed:/.test(g.status));
    await notify(`playstation-plus (${user || 'unknown'}):<br>${html_game_list(notify_games)}`, { kind: hasActionable ? 'action' : 'summary' });
  }
  await closeContextSafely(context);
}

async function ensureLoggedIn(page) {
  await page.goto(URL_WHATS_NEW, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const userEl = page.locator('.psw-c-secondary').first();
  const signIn = page.locator('span:has-text("Sign in"), a:has-text("Sign in")').first();
  const detected = await Promise.race([
    userEl.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'logged-in'),
    signIn.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'signed-out'),
  ]).catch(() => 'unknown');

  if (detected === 'logged-in') return;

  if (cfg.nowait) {
    log.warn('Not signed in and NOWAIT set — exiting.');
    if (cfg.novnc_port) log.info(`Open http://localhost:${cfg.novnc_port} to sign in via the panel.`);
    process.exit(1);
  }

  log.warn('Not signed in');
  if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
  log.status('Login timeout', `${cfg.login_timeout / 1000}s`);

  await signIn.click().catch(() => {});
  await page.waitForURL(/my\.account\.sony\.com|signin\.account\.sony\.com/, { timeout: cfg.login_timeout }).catch(() => {});

  if (cfg.psp_email && cfg.psp_password) {
    log.info('Using credentials from environment');
    await page.locator('#signin-entrance-input-signinId').fill(cfg.psp_email);
    await page.locator('#signin-entrance-button').click();
    await page.waitForSelector('#signin-password-input-password', { timeout: cfg.login_timeout });
    await page.locator('#signin-password-input-password').fill(cfg.psp_password);
    await page.locator('#signin-password-button').click();

    // FunCaptcha handoff — Sony's Arkose challenge. Hand off to noVNC via the
    // existing helper. The captcha-marker feature flag on the registry entry
    // tells the panel to watch for the [CAPTCHA-START]/[CAPTCHA-END] markers
    // this helper emits.
    page.locator('#FunCaptcha').waitFor({ timeout: cfg.login_timeout }).then(async () => {
      log.warn('Got FunCaptcha challenge during PSN login');
      await awaitUserCaptchaSolve(page, {
        service: 'playstation-plus',
        label: 'FunCaptcha (PSN login)',
        captchaCheck: async () => (await page.locator('#FunCaptcha').count()) === 0,
      });
    }).catch(() => {});

    // 2FA / TOTP via PSP_OTPKEY when set, otherwise prompt or notify.
    page.locator('input[title="Enter Code"]').waitFor({ timeout: cfg.login_timeout }).then(async () => {
      log.info('Two-Step Verification — entering code');
      const otp = cfg.psp_otpkey
        ? authenticator.generate(cfg.psp_otpkey)
        : await prompt({ type: 'text', message: 'Enter PSN two-factor code', validate: n => n.toString().length === 6 || 'Must be 6 digits' });
      await page.locator('input[title="Enter Code"]').pressSequentially(otp.toString());
      // "Trust this Browser" — opt-in, ignore if absent.
      await page.locator('.checkbox-container input[type="checkbox"]').first().check().catch(() => {});
      await page.locator('button.primary-button, button[type="submit"]').first().click();
    }).catch(() => {});
  } else {
    log.info('No PSP_EMAIL/PSP_PASSWORD — waiting for manual sign-in via the browser');
    await notify('playstation-plus: not signed in and no credentials configured. Sign in via the panel.');
    if (cfg.headless) {
      log.info('Run `SHOW=1 node playstation-plus` to login in an opened browser.');
      await context.close();
      process.exit(1);
    }
  }

  await page.waitForURL(/^https:\/\/www\.playstation\.com\//, { timeout: cfg.login_timeout });
  await page.locator('.psw-c-secondary').waitFor({ state: 'visible', timeout: 15000 });
  if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
}
```

- [ ] **Step 2: Smoke-test against the existing logged-in profile**

The `data/browser-playstation` profile already has a valid session from the inspection work. Run:

```
node playstation-plus.js
```

Expected:
- A visible Chromium opens (cfg.headless=false on bare-metal because SHOW isn't set unless docker entrypoint sets it).
- The page navigates to whats-new.
- Within a few seconds, log lines: `User FurorPotentia` and a run-summary `[playstation-plus] Run summary: claimed 0, ...`.
- Process exits 0.

If username comes back as `unknown` or `Sign in` is still visible, the persistent profile lost its cookie. Re-login by running `node test/ps-monthly-probe.js` (from Task 0 — has the same persistent context), sign in via the visible browser, then re-run this step.

- [ ] **Step 3: Lint**

Run: `npm run lint`

Expected: clean exit.

- [ ] **Step 4: Commit**

```bash
git add playstation-plus.js
git commit -m "$(cat <<'EOF'
feat(ps-plus): runner skeleton + Sony Auth login flow

Reaches "Signed in as <user>" against the persistent profile and exits with
zero claims (claim flow lands in next commit). Sony Auth selectors ported from
the OJ7 prototype (verified live during the inspection session) and integrated
with this project's captcha pause + apprise notify helpers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Claim mechanics — claimOne + Access-Denied recovery

**Goal:** Implement the per-game claim mechanic (`claimOne`) and its retry wrapper (`attemptClaimWithBlockRecovery`). After this task, the runner can claim a single game when given a hardcoded test entry; the full discovery+loop comes in Task 5.

**Files:**
- Modify: `playstation-plus.js`

**Acceptance Criteria:**
- [ ] `claimOne(page, entry, opts)` reads the visible CTA's `data-telemetry-meta` JSON and branches on `ctaType`.
- [ ] On `ADD_TO_LIBRARY`: clicks the button, waits for state transition or toast confirmation, marks DB entry as `claimed`.
- [ ] On `OWNED`/`IN_LIBRARY`: marks `existed`, does not click.
- [ ] On any other `ctaType`: marks `skipped:not-included`.
- [ ] On `<title>Access Denied</title>`: bounces off the catalog page, waits 15-30s, retries once; if still blocked, returns `failed:access-denied`.
- [ ] All outcomes update `lastAttemptedAt` on the DB row.
- [ ] Failures take a screenshot to `data/screenshots/playstation-plus/<conceptId>_<timestamp>.png`.

**Verify:** Modify the `try` block in `playstation-plus.js` temporarily to call `claimOne(page, { conceptId: '10009923', conceptUrl: 'https://store.playstation.com/en-us/concept/10009923', title: "Another Crab's Treasure", source: 'catalog' }, { priority: false })` after the username readout. Run `node playstation-plus.js`. Expect one of: `Claimed`, `Already in library`, or `Skipped (not-included)` log line and a matching entry in `data/playstation-plus.json`. **Revert the temporary call before committing.**

**Steps:**

- [ ] **Step 1: Add the helper functions to `playstation-plus.js`**

Add these helpers above the `try {` block:

```js
async function attemptClaimWithBlockRecovery(page, entry) {
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await page.goto(entry.conceptUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const title = await page.title().catch(() => '');
    if (!/^Access Denied/i.test(title)) {
      // Wait for the CTA to attach so the caller can read it.
      await page.locator('button[data-qa="mfeCtaMain#cta#action"]').waitFor({ state: 'attached', timeout: cfg.timeout }).catch(() => {});
      return 'ok';
    }
    log.warn(`Access Denied on ${entry.title} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    if (attempt < MAX_ATTEMPTS) {
      // Bounce off the catalog page to refresh the referer/session signal,
      // then wait a random 15-30s before retrying the concept URL.
      await page.goto('https://www.playstation.com/en-us/ps-plus/games/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      const pause = 15000 + Math.floor(Math.random() * 15000);
      await page.waitForTimeout(pause);
    }
  }
  return 'access-denied';
}

async function readCtaMeta(page) {
  const handle = page.locator('button[data-qa="mfeCtaMain#cta#action"]').first();
  if (await handle.count() === 0) return null;
  const raw = await handle.getAttribute('data-telemetry-meta').catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function claimOne(page, entry, opts = { priority: false }) {
  const now = datetime();
  db.data[user][entry.conceptId] ||= { title: entry.title, url: entry.conceptUrl, source: entry.source, conceptId: entry.conceptId, time: now };
  const row = db.data[user][entry.conceptId];
  row.lastAttemptedAt = now;
  row.source = entry.source;

  const notify_game = { title: entry.title, url: entry.conceptUrl, status: 'failed' };
  notify_games.push(notify_game);

  const blockOutcome = await attemptClaimWithBlockRecovery(page, entry);
  if (blockOutcome === 'access-denied') {
    log.fail(`${entry.title} — Access Denied (retry next run)`);
    row.status = notify_game.status = 'failed:access-denied';
    const p = screenshot(`${entry.conceptId}_${filenamify(now)}.png`);
    await page.screenshot({ path: p, fullPage: false }).catch(() => {});
    return 'access-denied';
  }

  const meta = await readCtaMeta(page);
  if (!meta) {
    log.fail(`${entry.title} — CTA not found (unexpected page state)`);
    row.status = notify_game.status = 'failed';
    const p = screenshot(`${entry.conceptId}_${filenamify(now)}.png`);
    await page.screenshot({ path: p, fullPage: false }).catch(() => {});
    return 'failed';
  }
  row.ctaType = meta.ctaType || 'unknown';
  if (meta.productId) row.productId = meta.productId;

  const cta = String(meta.ctaType || '').toUpperCase();
  if (cta === 'ADD_TO_LIBRARY') {
    if (cfg.dryrun) {
      log.warn(`${entry.title} — dry run, would have clicked Add to Library`);
      row.status = notify_game.status = 'skipped';
      return 'skipped';
    }
    log.game(entry.title, `claiming (${opts.priority ? 'monthly priority' : 'catalog drain'})`);
    await page.locator('button[data-qa="mfeCtaMain#cta#action"]').first().click({ delay: 11 });
    // Race three success signals: button text → "In Library", confirmation
    // toast renders, or ctaType re-read flips to OWNED. First to fire wins.
    const success = await Promise.race([
      page.locator('button[data-qa="mfeCtaMain#cta#action"]').filter({ hasText: /in library/i }).first().waitFor({ state: 'visible', timeout: cfg.timeout }).then(() => 'btn-flip'),
      page.locator('[data-qa^="inline-toast"]:has-text("Added to library"), [data-qa^="inline-toast"]:has-text("in library")').first().waitFor({ state: 'visible', timeout: cfg.timeout }).then(() => 'toast'),
      (async () => {
        const start = Date.now();
        while (Date.now() - start < cfg.timeout) {
          const m = await readCtaMeta(page);
          if (m && /OWNED|IN_LIBRARY/i.test(String(m.ctaType || ''))) return 'meta-flip';
          await page.waitForTimeout(500);
        }
        throw new Error('no meta-flip');
      })(),
    ]).catch(() => null);
    if (success) {
      log.ok(`${entry.title} — claimed (${success})`);
      row.status = notify_game.status = 'claimed';
      row.time = datetime();
      return 'claimed';
    }
    log.fail(`${entry.title} — claim click did not confirm`);
    row.status = notify_game.status = 'failed';
    const p = screenshot(`${entry.conceptId}_${filenamify(now)}.png`);
    await page.screenshot({ path: p, fullPage: false }).catch(() => {});
    return 'failed';
  }

  if (cta === 'OWNED' || cta === 'IN_LIBRARY') {
    log.owned(entry.title);
    row.status = notify_game.status = 'existed';
    return 'existed';
  }

  // Anything else — BUY, PRE_ORDER, COMING_SOON, REGION_LOCKED, etc.
  log.skip(entry.title, `not included (ctaType=${cta || 'unknown'})`);
  row.status = notify_game.status = `skipped:not-included`;
  return 'skipped';
}
```

- [ ] **Step 2: Temporarily add a smoke-test call to verify**

Inside the `try {` block in `playstation-plus.js`, **temporarily** insert this just after the `db.data[user] ||= {};` line:

```js
  // ⚠ TEMPORARY — remove before commit. Verifies claimOne against one game.
  await claimOne(page, {
    conceptId: '10009923',
    conceptUrl: 'https://store.playstation.com/en-us/concept/10009923',
    title: "Another Crab's Treasure",
    source: 'catalog',
  }, { priority: false });
```

Run: `node playstation-plus.js`

Expected: one of these log lines fires —
- `✓ Another Crab's Treasure — claimed (btn-flip|toast|meta-flip)` → claimOne worked end-to-end.
- `Already in library` → existed branch worked.
- `Skipped — not included (ctaType=BUY)` → skipped branch worked (would happen if subscription lapsed or the game left the catalog).
- `Access Denied (retry next run)` → blocked branch worked, recovery attempted.

Check `data/playstation-plus.json` — the user's object should contain a `10009923` entry with the matching `status` and a `lastAttemptedAt` timestamp.

If a "Get this game" overlay or unfamiliar modal interferes, capture the screenshot from `data/screenshots/playstation-plus/` and adjust selectors. The most likely deviation is the success-toast `data-qa` selector — if observed text differs, update the third Promise.race branch accordingly.

- [ ] **Step 3: Revert the temporary smoke-test call**

Remove the temporary `await claimOne(...)` block. The `try` block should be back to the Task 3 shape (username → db init → log summary).

- [ ] **Step 4: Lint**

Run: `npm run lint`

Expected: clean exit.

- [ ] **Step 5: Commit**

```bash
git add playstation-plus.js
git commit -m "$(cat <<'EOF'
feat(ps-plus): claimOne + Access-Denied retry

Per-game claim mechanic reads data-qa="mfeCtaMain#cta#action"'s
data-telemetry-meta JSON to branch on ctaType (ADD_TO_LIBRARY / OWNED /
IN_LIBRARY / other). Three-signal success race covers Sony copy refreshes.
attemptClaimWithBlockRecovery bounces off the catalog page and retries once
on <title>Access Denied</title>.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Priority + drain pass loop with pacing, circuit breaker, rotate-to-bottom

**Goal:** Wire `discoverMonthly` + `discoverCatalog` into the runner's `try` block. Run the priority pass (every monthly, no rate limit) followed by the drain pass (rotate-to-bottom queue, up to `psp_max_claims_per_run`, with jitter pauses and the consecutive-Access-Denied circuit breaker).

**Files:**
- Modify: `playstation-plus.js`

**Acceptance Criteria:**
- [ ] `discoverMonthly` returns ≥ 1 entry; zero monthlies pushes a `status: 'action'` warning into `notify_games` and continues (does not throw).
- [ ] `discoverCatalog` returns ≥ 50 entries; < 50 logs a soft warning and skips the drain pass.
- [ ] Priority pass iterates monthlies, skips those whose DB status is `claimed` or `existed`, claims the rest with no rate limit.
- [ ] Drain pass sorts catalog candidates by `lastAttemptedAt ASC, conceptId ASC`, slices to `psp_max_claims_per_run`, claims each.
- [ ] Catalog-rotation pruning: candidates not present in the current catalog scrape are excluded silently.
- [ ] Between any two consecutive claim attempts (in either pass), a jittered pause of `psp_claim_pause_min_sec` to `psp_claim_pause_max_sec` runs.
- [ ] Three consecutive `failed:access-denied` outcomes trip the circuit breaker — abort run, push `status: 'action'` notification, but still write DB.
- [ ] Run summary reports `claimed`, `alreadyOwned`, `skipped`, `failed` counts.

**Verify:** Run `PSP_MAX_CLAIMS_PER_RUN=2 PSP_CLAIM_PAUSE_MIN_SEC=2 PSP_CLAIM_PAUSE_MAX_SEC=4 node playstation-plus.js`. Observe in the log: monthly discovery count, catalog discovery count, attempts on the priority pass, up to 2 attempts on the drain pass, at least one jitter pause line. `data/playstation-plus.json` ends with ≥ 2 new entries (assuming a fresh DB for `FurorPotentia`).

**Steps:**

- [ ] **Step 1: Replace the contents of the `try` block in `playstation-plus.js`**

Replace the entire `try { ... } catch ... finally ...` body with:

```js
try {
  await ensureLoggedIn(page);
  user = (await page.locator('.psw-c-secondary').first().innerText().catch(() => '')).trim() || 'unknown';
  log.status('User', user);
  db.data[user] ||= {};

  // --- Discovery ----------------------------------------------------------
  let monthlyEntries = [];
  try {
    monthlyEntries = await discoverMonthly(page);
    log.status('Monthly Essentials found', monthlyEntries.length);
    if (monthlyEntries.length === 0) {
      log.warn('Zero monthly Essentials discovered — Sony may have refactored whats-new.');
      notify_games.push({
        title: '⚠ Monthly Essentials detection failed — check manually this month',
        url: 'https://www.playstation.com/en-us/ps-plus/whats-new/',
        status: 'action',
        details: 'Sony may have refactored /ps-plus/whats-new/. Run test/ps-monthly-probe.js and update discoverMonthly().',
      });
    }
  } catch (e) {
    log.warn(`Monthly discovery failed — ${e.message.split('\n')[0]}`);
  }

  let catalogEntries = [];
  try {
    catalogEntries = await discoverCatalog(page);
    log.status('Catalog entries found', catalogEntries.length);
    if (catalogEntries.length < 50) {
      log.warn(`Catalog scrape returned only ${catalogEntries.length} entries (< 50) — skipping drain pass this run`);
      catalogEntries = [];  // disable drain pass; priority pass still runs
    }
  } catch (e) {
    log.warn(`Catalog discovery failed — ${e.message.split('\n')[0]}`);
  }

  const monthlyIds = new Set(monthlyEntries.map(e => e.conceptId));

  // --- Helpers shared across passes --------------------------------------
  const isTerminal = id => {
    const s = db.data[user][id]?.status;
    return s === 'claimed' || s === 'existed';
  };
  const jitterPause = async () => {
    const min = Math.max(0, cfg.psp_claim_pause_min_sec * 1000);
    const max = Math.max(min, cfg.psp_claim_pause_max_sec * 1000);
    const pause = min + Math.floor(Math.random() * (max - min + 1));
    if (pause > 0) {
      log.info(`Pausing ${(pause / 1000) | 0}s before next claim…`);
      await page.waitForTimeout(pause);
    }
  };

  // --- Build per-pass work lists -----------------------------------------
  const monthlyWork = monthlyEntries.filter(e => !isTerminal(e.conceptId));

  // Drain candidates: catalog entries that (a) aren't monthly (handled above),
  // (b) aren't already claimed/existed, (c) still appear in the current
  // catalog scrape (silent prune of catalog-rotation churn).
  const drainCandidates = catalogEntries
    .filter(e => !monthlyIds.has(e.conceptId))
    .filter(e => !isTerminal(e.conceptId))
    .sort((a, b) => {
      const aLast = db.data[user][a.conceptId]?.lastAttemptedAt || '';
      const bLast = db.data[user][b.conceptId]?.lastAttemptedAt || '';
      return aLast.localeCompare(bLast) || a.conceptId.localeCompare(b.conceptId);
    })
    .slice(0, cfg.psp_max_claims_per_run);

  // --- Execute passes -----------------------------------------------------
  const ACCESS_DENIED_RUN_BUDGET = 3;
  let consecutiveBlocks = 0;
  let circuitBroken = false;

  const runOne = async (entry, opts) => {
    if (circuitBroken) return;
    const outcome = await claimOne(page, entry, opts);
    if (outcome === 'access-denied') {
      consecutiveBlocks++;
      if (consecutiveBlocks >= ACCESS_DENIED_RUN_BUDGET) {
        log.fail(`Access-Denied circuit breaker tripped after ${consecutiveBlocks} consecutive blocks — aborting run`);
        notify_games.push({
          title: '⚠ PS Plus run aborted — Sony bot block',
          url: 'https://store.playstation.com/',
          status: 'action',
          details: 'Akamai bot manager scored this session too high. Run aborted to avoid raising the score further. Will retry on the next scheduled run.',
        });
        circuitBroken = true;
      }
    } else {
      consecutiveBlocks = 0;
    }
  };

  // Priority pass — every monthly not terminal, NO rate limit.
  log.status('Priority pass', `${monthlyWork.length} monthly title(s) pending`);
  for (let i = 0; i < monthlyWork.length; i++) {
    if (circuitBroken) break;
    await runOne(monthlyWork[i], { priority: true });
    const hasMoreWork = i < monthlyWork.length - 1 || drainCandidates.length > 0;
    if (hasMoreWork && !circuitBroken) await jitterPause();
  }

  // Drain pass — up to maxClaimsPerRun from the candidate queue.
  log.status('Drain pass', `${drainCandidates.length} backlog entry(ies) this run (cap ${cfg.psp_max_claims_per_run})`);
  for (let i = 0; i < drainCandidates.length; i++) {
    if (circuitBroken) break;
    await runOne(drainCandidates[i], { priority: false });
    if (i < drainCandidates.length - 1 && !circuitBroken) await jitterPause();
  }

  // --- Run summary -------------------------------------------------------
  const counts = { claimed: 0, existed: 0, skipped: 0, failed: 0 };
  for (const g of notify_games) {
    if (g.status === 'claimed') counts.claimed++;
    else if (g.status === 'existed') counts.existed++;
    else if (/^skipped/.test(g.status)) counts.skipped++;
    else if (/^failed/.test(g.status)) counts.failed++;
  }
  log.summary({
    siteId: 'playstation-plus',
    claimed: counts.claimed,
    skipped: counts.skipped,
    display: 'alreadyOwned',
    alreadyOwned: counts.existed,
    failed: counts.failed,
  });
} catch (error) {
  process.exitCode ||= 1;
  log.exception(error);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode != 130) {
    await notify(`playstation-plus failed: ${error.message.split('\n')[0]}`, { attachLatestScreenshot: true });
  }
} finally {
  await db.write();
  if (notify_games.length) {
    const hasActionable = notify_games.some(g => g.status === 'failed' || g.status === 'action' || /^failed:/.test(g.status));
    await notify(`playstation-plus (${user || 'unknown'}):<br>${html_game_list(notify_games)}`, { kind: hasActionable ? 'action' : 'summary' });
  }
  await closeContextSafely(context);
}
```

- [ ] **Step 2: Smoke run with small caps and short pauses**

Run:

```
PSP_MAX_CLAIMS_PER_RUN=2 PSP_CLAIM_PAUSE_MIN_SEC=2 PSP_CLAIM_PAUSE_MAX_SEC=4 node playstation-plus.js
```

Expected log structure (timestamps elided):
```
[playstation-plus] PlayStation Plus (v1.0)
  Time: 2026-05-26 …
  Max backlog/run: 2
  Pause range: 2-4s
  User: FurorPotentia
  Monthly Essentials found: 3
  Catalog entries found: 242
  Priority pass: 3 monthly title(s) pending
  ▶ <Monthly title 1> claiming (monthly priority)
  ✓ <Monthly title 1> — claimed (btn-flip)
  Pausing 3s before next claim…
  …
  Drain pass: 2 backlog entry(ies) this run (cap 2)
  ▶ <Catalog title> claiming (catalog drain)
  …
  Run summary: claimed N, alreadyOwned M, skipped 0, failed 0
```

Check `data/playstation-plus.json` — it should contain `FurorPotentia` with entries for each attempted concept (status `claimed`/`existed`, `lastAttemptedAt` timestamp).

- [ ] **Step 3: Tweak selectors if any surprise**

If a claim attempt logs `failed — claim click did not confirm` despite the game appearing to be added: open Sony's DevTools on the live page, inspect what selector confirms success, and adjust the third Promise.race branch in `claimOne`. Refer to `data/ps-concept-catalog-another-crab.html` from the inspection session for the rendered DOM structure.

- [ ] **Step 4: Lint**

Run: `npm run lint`

Expected: clean exit.

- [ ] **Step 5: Commit**

```bash
git add playstation-plus.js
git commit -m "$(cat <<'EOF'
feat(ps-plus): priority + drain passes with pacing and circuit breaker

Priority pass claims all monthly Essentials unconditionally each run.
Drain pass sorts catalog candidates by lastAttemptedAt ASC (never-attempted
first, then oldest), slices to PSP_MAX_CLAIMS_PER_RUN. Jitter pause between
every two consecutive claim attempts. Three consecutive Access-Denied
outcomes trip a run-level circuit breaker that aborts further claims and
pushes an action notification.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Documentation

**Goal:** Document the new service in the project's user-facing docs and CHANGELOG.

**Files:**
- Modify: `docs/REFERENCE.md`
- Modify: `docs/CONFIGURATION.md`
- Modify: `CHANGELOG.md`

**Acceptance Criteria:**
- [ ] `docs/REFERENCE.md` "Bot detection — per-store reality" table has a `PlayStation Plus` row with Category B (fingerprint pressure) and a note about Akamai bot scoring + occasional Access-Denied.
- [ ] `docs/CONFIGURATION.md` lists `PSP_EMAIL`, `PSP_PASSWORD`, `PSP_OTPKEY`, `PSP_ACTIVE`, `PSP_MAX_CLAIMS_PER_RUN`, `PSP_CLAIM_PAUSE_MIN_SEC`, `PSP_CLAIM_PAUSE_MAX_SEC` with the cookie-only vs. fully-automated onboarding paths.
- [ ] `CHANGELOG.md` has a new top entry describing the feature.

**Verify:** `git diff docs/REFERENCE.md docs/CONFIGURATION.md CHANGELOG.md` shows the additions, and `npm run lint` still passes.

**Steps:**

- [ ] **Step 1: Add the PS Plus row to `docs/REFERENCE.md` "Per-store reality" table**

Find the "Per-store reality" table in `docs/REFERENCE.md`. After the `Microsoft Rewards` row and before `AliExpress`, insert:

```
| **PlayStation Plus** | Reliable with caveats | Akamai bot manager occasionally returns Access Denied on `store.playstation.com/concept/<id>` navigations. Runner has per-claim retry + run-level circuit breaker. Conservative pacing defaults (5 catalog claims/run, 30-60s jitter). Monthly Essentials are always claimed first regardless of rate limit. |
```

- [ ] **Step 2: Add the PSP env vars to `docs/CONFIGURATION.md`**

Append (or insert into the relevant table) the following block in `docs/CONFIGURATION.md`:

```markdown
### PlayStation Plus

Opt-in service (requires an active PS Plus subscription, any tier). Default off.

| Env var | Default | Purpose |
|---|---|---|
| `PSP_ACTIVE` | `0` | Set to `1` (or toggle in Settings → PS Plus) to enable. |
| `PSP_EMAIL` | (falls back to `EMAIL`) | PSN account email for automated relogin. Optional — see below. |
| `PSP_PASSWORD` | (falls back to `PASSWORD`) | PSN account password. Optional. |
| `PSP_OTPKEY` | (unset) | Base32 TOTP secret from authenticator-app 2FA. Optional. |
| `PSP_MAX_CLAIMS_PER_RUN` | `5` | Catalog drain cap. Monthly Essentials bypass this. |
| `PSP_CLAIM_PAUSE_MIN_SEC` | `30` | Min jitter pause between consecutive claims. |
| `PSP_CLAIM_PAUSE_MAX_SEC` | `60` | Max jitter pause. |

**Two onboarding paths:**

1. **Cookie-only (simplest).** Click *Login* on the PS Plus card in the Sessions tab. A visible browser opens via noVNC. Sign in by hand (2FA via your phone authenticator app). The browser profile cookie persists in `data/browser-playstation/`. No `PSP_*` credential env vars needed. Re-login only required when the session expires (weeks to months); the panel notifies you.

2. **Fully automated relogin.** Set `PSP_EMAIL`, `PSP_PASSWORD`, and `PSP_OTPKEY` in your `docker-compose.yml` `environment:` block or in `data/config.env`. The runner re-authenticates without user interaction when the session expires.

**Obtaining `PSP_OTPKEY`:**
Sign in to https://www.playstation.com/acct/management/security/ → 2-Step Verification. If authenticator-app 2FA is already enabled, disable and re-enable to see the secret. During QR-code setup look for *"Can't scan?"* / *"Enter manually"* — that reveals the Base32 secret. Save it as `PSP_OTPKEY`. Also scan the QR with your authenticator app so your phone still works alongside the bot. **Caveat:** users on SMS-based 2FA can't use `PSP_OTPKEY`; either switch to authenticator-app 2FA or accept that every relogin pauses for manual MFA via noVNC.

**Bot detection note:** Sony's Akamai layer occasionally returns Access Denied. The runner retries once per game (bouncing off the catalog page first) and trips a run-level circuit breaker after three consecutive blocks. See `docs/REFERENCE.md` Category B for context.
```

- [ ] **Step 3: Add the CHANGELOG entry**

Bump version in `package.json` (e.g. `2.8.13` → `2.9.0` for the feature add) and add the matching entry at the top of `CHANGELOG.md`:

```markdown
## 2.9.0 — feat(ps-plus): PlayStation Plus collector

Adds an opt-in `playstation-plus` collector that claims expiring monthly
Essential picks unconditionally and drains the PS-Plus-included catalog at
a configurable rate (default 5 backlog claims per run with 30-60s jitter
pauses). Requires an active PS Plus subscription (any tier).

- Two-source discovery: monthly Essentials from `/ps-plus/whats-new/`,
  catalog backlog from `/ps-plus/games/`. Both scrape concept URLs on
  `store.playstation.com/concept/<id>`.
- Per-game claim reads `data-qa="mfeCtaMain#cta#action"`'s `data-telemetry-meta`
  to branch on `ctaType` (ADD_TO_LIBRARY / OWNED / IN_LIBRARY / other).
- Access-Denied recovery: per-claim retry-via-catalog-bounce + run-level
  circuit breaker after 3 consecutive blocks.
- Rotate-to-bottom retry queue: failed catalog candidates sort to the back
  of the queue by `lastAttemptedAt`, so a persistently-failing game never
  blocks budget.
- FunCaptcha (Sony's Arkose vendor) handoff via the existing noVNC pause
  helper.
- Settings UI surfaces `maxClaimsPerRun`, `claimPauseMin/MaxSec`. Credentials
  (`PSP_EMAIL`, `PSP_PASSWORD`, `PSP_OTPKEY`) are env-only.

See `docs/CONFIGURATION.md` for onboarding (cookie-only or fully-automated).
```

- [ ] **Step 4: Lint**

Run: `npm run lint`

Expected: clean exit.

- [ ] **Step 5: Commit**

```bash
git add docs/REFERENCE.md docs/CONFIGURATION.md CHANGELOG.md package.json
git commit -m "$(cat <<'EOF'
docs(ps-plus): user-facing docs + 2.9.0 release notes

REFERENCE.md adds the bot-detection row (Akamai pressure, Category B).
CONFIGURATION.md documents PSP_* env vars + cookie-only vs. fully-automated
onboarding paths. CHANGELOG.md gets the 2.9.0 entry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

**Spec coverage check:** Each spec section has a corresponding task:

| Spec section | Task(s) |
|---|---|
| Registry entry (§1) | Task 2 |
| Runner contract (§2) | Tasks 3, 4, 5 |
| Discovery module (§3) | Task 1 |
| Claim DB shape (§4) | Tasks 4, 5 (built incrementally) |
| Rate limit + pacing (§5) | Task 5 |
| Login flow (§6) | Task 3 |
| Access-Denied recovery (§7) | Tasks 4 (per-game), 5 (circuit breaker) |
| Open risks (§8) — R2 | Task 0 (pre-merge probe) |
| Open risks (§8) — R3 | Task 4 step 2 (live observation during smoke test) |
| Onboarding / config docs | Task 6 |

**Deviation from spec:** Spec mentioned lifting `randomMs(min, max)` to `src/util.js`. The existing `randomMs(maxSeconds)` in `microsoft.js` is single-arg with different units (ms not seconds). Plan inlines the 3-line jitter math in `playstation-plus.js` Task 5 instead — smaller diff, no util.js change required.

**Verify commands cross-reference:** Each task uses commands that are available in this project (Node 22, `npm run lint`, ad-hoc `node test/*.js` scripts following the existing `test/` convention). No invented test framework.
