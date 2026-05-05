// Site registry — the single declarative source of truth for every service
// the engine knows about. Phase 0 of the engine refactor (issue #11): this
// file holds the data; engine code in interactive-login.js + app-config.js
// is migrated commit-by-commit to derive its hand-edited tables from here.
//
// Each entry carries everything the engine needs about a service:
//
//   id              stable identifier used in config keys + UI deep links
//   name            human-readable label shown in cards and notifications
//   subtitle        optional second-line note rendered under name (Settings)
//   script          per-service runner ('foo.js') or null for sub-services
//                   that share their parent's script (microsoft-mobile)
//   loginUrl        page to navigate to for interactive login (null = no
//                   login flow, e.g. ubisoft watch-only)
//   browserDir      persistent profile dir; null if no browser is launched
//   contextOptions  extra Playwright launchPersistentContext opts (mobile
//                   fingerprint emulation for AliExpress + microsoft-mobile)
//   defaultActive   default for services.<id>.active when neither config
//                   file nor env sets it. false = opt-in service.
//   activeEnv       env var that gates services.<id>.active (PG_ACTIVE etc)
//   linkedWith      paired sub-service id whose active flag follows ours
//                   (microsoft → microsoft-mobile). The parent carries the
//                   pointer; the sub-service has linkedWith: null.
//   claimDbFile     filename under data/ holding this service's claim
//                   history, or null for services with no claim DB
//                   (Microsoft = points-based, Ubisoft = watch-only).
//   scheduleKind    'daily-chain' (runs in the main scheduler chain),
//                   'daily-window' (its own random-pick scheduler loop —
//                   Microsoft today), or 'watch-only' (Ubisoft pattern).
//   features        named opt-ins the engine reads to enable per-site
//                   special handling without hard-coding the service id.
//                   Examples (consumers added in later commits):
//                     'ms-window-skip'    accepts MS_SKIP_WINDOW=1 env
//                     'captcha-marker'    emits [CAPTCHA-START/END] lines
//                     'batch-redeem-source' provides codes for GOG batch
//   configFields    per-service config rows beyond `active`. Each entry:
//                     { key, env, type, default, label,
//                       hint?, unit?, prefix?, nullable?, coerce? }
//                   The `coerce` field is a {kind, ...args} descriptor so
//                   commit 6 can derive CONFIG_SCHEMA without dragging
//                   coerce-function imports into this data file.
//   checkLogin      async (page) => { loggedIn, user? } — null when the
//                   service has no login surface.
//
// Note that Phase 0 commit 1 only populates the structure; subsequent
// commits add consumers (CLAIM_SCRIPT_ORDER, activeServices(), CONFIG_SCHEMA,
// SERVICE_ROWS, …) that read these fields. Until then the new fields are
// metadata-only and safe to ignore.

import { devices } from 'patchright';
import { cfg } from './config.js';

// Read the signed-in Microsoft Rewards user via the dashboard's own
// dapi/me endpoint. page.request inherits the browser context's cookies, so a
// valid session authenticates automatically. Returns null on any failure so
// callers can fall back to a generic label without invalidating the session.
// Read the signed-in user's display name from Microsoft's ME Control — the
// account widget rendered across every authenticated MS property. The primary
// span holds the display name ("Chris Orr"), the secondary span holds the
// email. Caller has already navigated to rewards.bing.com, so the widget is
// populated (or will be shortly).
//
// (The dapi/me and getuserinfo APIs were tried first — dapi/me 401s without
// extra auth headers, and getuserinfo is a dashboard blob that doesn't carry
// user identity. The ME widget has been in place for years across MS, so the
// DOM path is actually the more stable choice here.)
async function readMicrosoftRewardsUser(page) {
  try {
    // state: 'attached' rather than the default 'visible' — the ME Control
    // renders the name into hidden DOM until the widget is opened, so the
    // default visible-wait would time out even though the text is present.
    await page.waitForSelector('#mectrl_currentAccount_primary', { timeout: 8000, state: 'attached' });
    const name = await page.evaluate(() => {
      const primary = document.getElementById('mectrl_currentAccount_primary');
      const secondary = document.getElementById('mectrl_currentAccount_secondary');
      const p = primary && primary.textContent && primary.textContent.trim();
      const s = secondary && secondary.textContent && secondary.textContent.trim();
      return p || s || null;
    });
    if (name) return name;
  } catch (e) {
    console.log(`[ms] readUser: ${e.message}`);
  }
  return null;
}

export const SITES = [
  {
    id: 'prime-gaming',
    name: 'Prime Gaming',
    version: '2.0',
    subtitle: null,
    script: 'prime-gaming.js',
    claimOrder: 2,
    loginUrl: 'https://luna.amazon.com/claims',
    get browserDir() { return cfg.dir.browser; },
    contextOptions: null,
    defaultActive: true,
    activeEnv: 'PG_ACTIVE',
    linkedWith: null,
    claimDbFile: 'prime-gaming.json',
    scheduleKind: 'daily-chain',
    features: [],
    configFields: [
      { key: 'redeem',       env: 'PG_REDEEM',   type: 'boolean', default: false,
        label: 'Redeem keys on external stores' },
      { key: 'claimDlc',     env: 'PG_CLAIMDLC', type: 'boolean', default: false,
        label: 'Claim in-game DLC content',
        hint: 'Amazon removed the in-game content tab from Prime Gaming — this toggle is currently a no-op. The script skips cleanly when the tab is missing; will resume claiming if/when Amazon brings it back.' },
      { key: 'timeLeftDays', env: 'PG_TIMELEFT', type: 'number',  default: null, nullable: true,
        label: 'Skip if more than N days remain to claim',
        unit: 'days',
        hint: 'Leave blank to claim everything regardless of how long is left.',
        coerce: { kind: 'nullableNumber' } },
    ],
    async checkLogin(page) {
      try {
        await page.goto('https://luna.amazon.com/claims', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        // Amazon redirects stale sessions to /ap/signin — check final URL first (real auth signal).
        if (/\/ap\/signin|\/sign[-_]?in/i.test(page.url())) return { loggedIn: false };
        const signInBtn = await page.locator('button:has-text("Sign in")').count();
        if (signInBtn > 0) return { loggedIn: false };
        const userEl = page.locator('[data-a-target="user-dropdown-first-name-text"]');
        if (await userEl.count() > 0) {
          const user = await userEl.first().innerText();
          return { loggedIn: true, user };
        }
        return { loggedIn: false };
      } catch {
        return { loggedIn: false };
      }
    },
  },
  {
    id: 'epic-games',
    name: 'Epic Games',
    version: '2.0',
    subtitle: null,
    script: 'epic-games.js',
    claimOrder: 3,
    loginUrl: 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=https://store.epicgames.com/en-US/free-games',
    get browserDir() { return cfg.dir.browser; },
    contextOptions: null,
    defaultActive: true,
    activeEnv: 'EG_ACTIVE',
    linkedWith: null,
    claimDbFile: 'epic-games.json',
    scheduleKind: 'daily-chain',
    features: ['captcha-marker'],
    configFields: [
      { key: 'claimMobile', env: 'EG_MOBILE', type: 'boolean', default: true,
        label: 'Claim mobile games',
        coerce: { kind: 'boolDefaultTrue' } },
    ],
    async checkLogin(page) {
      try {
        await page.goto('https://store.epicgames.com/en-US/free-games', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        const nav = page.locator('egs-navigation');
        const isLoggedIn = await nav.getAttribute('isloggedin');
        if (isLoggedIn === 'true') {
          const user = await nav.getAttribute('displayname');
          return { loggedIn: true, user: user || 'unknown' };
        }
        return { loggedIn: false };
      } catch {
        return { loggedIn: false };
      }
    },
  },
  {
    id: 'gog',
    name: 'GOG',
    version: '2.0',
    subtitle: null,
    script: 'gog.js',
    claimOrder: 1,
    loginUrl: 'https://www.gog.com/en',
    get browserDir() { return cfg.dir.browser; },
    contextOptions: null,
    defaultActive: true,
    activeEnv: 'GOG_ACTIVE',
    linkedWith: null,
    claimDbFile: 'gog.json',
    scheduleKind: 'daily-chain',
    features: ['batch-redeem-source'],
    configFields: [
      { key: 'keepNewsletter', env: 'GOG_NEWSLETTER', type: 'boolean', default: false,
        label: 'Keep newsletter subscription after claiming' },
    ],
    async checkLogin(page) {
      try {
        // Navigate to /account — GOG server-side requires a valid session here;
        // stale sessions get redirected to the homepage with an #openlogin overlay.
        // The final URL is the definitive session-validity signal.
        await page.goto('https://www.gog.com/account', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        const url = page.url();
        if (url.includes('openlogin') || url.includes('/login')) return { loggedIn: false };
        if (!url.includes('/account')) return { loggedIn: false };

        // Primary username source: GOG's own account APIs. page.request
        // inherits the browser context's cookies, so a valid session
        // authenticates automatically. This sidesteps the DOM path entirely
        // — the legacy #menuUsername element carries data-hj-suppress (PII
        // suppression) and is frequently hidden or renamed across GOG's
        // header redesigns.
        let user = null;
        const apis = [
          'https://menu.gog.com/v1/account/basic',
          'https://www.gog.com/userData.json',
          'https://embed.gog.com/userData.json',
        ];
        for (const endpoint of apis) {
          try {
            const res = await page.request.get(endpoint, { timeout: 10000 });
            if (!res.ok()) continue;
            const data = await res.json();
            const name = data && (data.username || data.userName || data.name);
            if (name) { user = String(name).trim(); break; }
          } catch { /* try next endpoint */ }
        }

        // DOM fallback: open the account dropdown and parse the block of text
        // next to "Your account". Used only if all APIs fail.
        if (!user) {
          try {
            await page.goto('https://www.gog.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
            const trigger = page.locator([
              'header [class*="menu-user"]',
              'header [class*="account"]',
              'header button[aria-haspopup]:has(svg)',
            ].join(', ')).first();
            await trigger.waitFor({ state: 'visible', timeout: 8000 });
            await trigger.hover();
            const dropdown = page.locator('[class*="menu-user-dropdown"], [class*="account-menu"], [class*="menu-user"]')
              .filter({ hasText: 'Your account' }).first();
            try {
              await dropdown.waitFor({ state: 'visible', timeout: 3000 });
            } catch {
              await trigger.click();
              await dropdown.waitFor({ state: 'visible', timeout: 4000 });
            }
            const text = await dropdown.innerText({ timeout: 2000 }).catch(() => '');
            const m = text.match(/Your account\s*\n?\s*([^\n]+)/);
            if (m && m[1]) user = m[1].trim() || null;
            await page.keyboard.press('Escape').catch(() => {});
          } catch { /* DOM path failed — fall through */ }
        }

        // Tertiary: legacy cookie that some GOG builds still set.
        if (!user) {
          const cookieUser = await page.evaluate(() => {
            for (const c of document.cookie.split(';')) {
              const [k, v] = c.trim().split('=');
              if (k === 'gog_username' || k === 'gog-username') return decodeURIComponent(v);
            }
            return null;
          });
          if (cookieUser) user = cookieUser;
        }
        return { loggedIn: true, user: user || 'unknown' };
      } catch {
        return { loggedIn: false };
      }
    },
  },
  {
    id: 'steam',
    name: 'Steam',
    version: '2.0',
    subtitle: null,
    script: 'steam.js',
    claimOrder: 4,
    loginUrl: 'https://store.steampowered.com/login/',
    get browserDir() { return cfg.dir.browser; },
    contextOptions: null,
    defaultActive: true,
    activeEnv: 'STEAM_ACTIVE',
    linkedWith: null,
    claimDbFile: 'steam.json',
    scheduleKind: 'daily-chain',
    features: [],
    configFields: [
      { key: 'minRating', env: 'STEAM_MIN_RATING', type: 'number', default: 6,
        label: 'Minimum review rating (1–9)',
        hint: '6 = Mostly Positive; 7 = Very Positive; 8 = Overwhelmingly Positive.',
        coerce: { kind: 'numberOr', fallback: 6 } },
      { key: 'minPrice',  env: 'STEAM_MIN_PRICE',  type: 'number', default: 10,
        label: 'Minimum original price',
        prefix: '$',
        hint: 'Filters out shovelware that was free or near-free before the giveaway.',
        coerce: { kind: 'numberOr', fallback: 10 } },
    ],
    async checkLogin(page) {
      try {
        // /account/ is auth-gated — stale sessions get redirected to /login/.
        await page.goto('https://store.steampowered.com/account/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        if (page.url().includes('/login/')) return { loggedIn: false };
        const pulldown = page.locator('#account_pulldown');
        if (await pulldown.count() > 0) {
          const user = (await pulldown.innerText()).trim();
          if (user.length > 0) return { loggedIn: true, user };
        }
        return { loggedIn: false };
      } catch {
        return { loggedIn: false };
      }
    },
  },
  {
    id: 'aliexpress',
    name: 'AliExpress',
    version: '2.0',
    subtitle: null,
    script: 'aliexpress.js',
    claimOrder: 5,
    // AliExpress's coin collector only works on the mobile site; desktop just
    // says "install the app". Use a dedicated browser profile so its
    // fingerprint-injected session doesn't collide with the desktop services'
    // profiles.
    loginUrl: 'https://m.aliexpress.com/p/coin-index/index.html',
    get browserDir() { return cfg.dir.browser + '-aliexpress'; },
    contextOptions: devices['Pixel 7'],
    defaultActive: false,
    activeEnv: 'AE_ACTIVE',
    linkedWith: null,
    claimDbFile: null,
    scheduleKind: 'daily-chain',
    features: [],
    configFields: [],
    async checkLogin(page) {
      const loginBtn = page.locator('button:has-text("Log in")');
      const streak = page.locator('h3:text-is("day streak")');
      // AliExpress mobile frequently hangs on initial load — same issue as in
      // aliexpress.js auth(). Auto-reload up to 3 times until either the login
      // button or the logged-in "day streak" marker appears, then short-circuit.
      const QUICK_WAIT_MS = 15000;
      const MAX_RELOADS = 3;
      try {
        for (let attempt = 0; attempt <= MAX_RELOADS; attempt++) {
          if (attempt === 0) {
            await page.goto('https://m.aliexpress.com/p/coin-index/index.html', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          } else {
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          }
          const which = await Promise.any([
            loginBtn.waitFor({ state: 'visible', timeout: QUICK_WAIT_MS }).then(() => 'login'),
            streak.waitFor({ state: 'visible', timeout: QUICK_WAIT_MS }).then(() => 'streak'),
          ]).catch(() => null);
          if (which === 'streak') return { loggedIn: true, user: 'member' };
          if (which === 'login') return { loggedIn: false };
        }
        return { loggedIn: false };
      } catch {
        return { loggedIn: false };
      }
    },
  },
  {
    id: 'microsoft',
    name: 'Microsoft Rewards',
    version: '2.0',
    subtitle: 'Runs both desktop and mobile sessions in one script.',
    script: 'microsoft.js',
    claimOrder: 9,
    loginUrl: 'https://rewards.bing.com',
    get browserDir() { return cfg.dir.browser; },
    contextOptions: null,
    defaultActive: true,
    activeEnv: 'MS_ACTIVE',
    linkedWith: 'microsoft-mobile',
    claimDbFile: null,
    scheduleKind: 'daily-window',
    features: ['ms-window-skip'],
    configFields: [
      // Scheduler-window fields surface under the MS row in Settings even
      // though their config paths live under scheduler.* — kept inline here
      // so the Settings UI rendering can consume one registry entry per
      // visible row. Marked schedulerScope so the CONFIG_SCHEMA derivation
      // (commit 6) skips them: scheduler.* fields are owned by the scheduler
      // section of CONFIG_SCHEMA, not per-service.
      { schedulerScope: true, path: 'scheduler.msScheduleHours',
        label: 'Schedule window width (hours)',
        unit: 'hours',
        hint: 'Width of the daily Microsoft Rewards window, anchored to the start time. 0 runs immediately without anchoring.' },
      { schedulerScope: true, path: 'scheduler.msScheduleStart',
        label: 'Schedule window start (local time)',
        kind: 'hour-of-day' },
      { key: 'searchDelayMaxSec', env: 'MS_SEARCH_DELAY_MAX_SEC', type: 'number', default: 180,
        label: 'Max delay between Bing searches (seconds)',
        unit: 'seconds',
        hint: 'Upper bound for the random pause before each Bing search. Default 180 mimics a human pace; lower values shorten runs significantly (~60 searches × this/2 avg = total search time) but increase the risk of MS flagging the account as a bot.',
        coerce: { kind: 'numberBounded', min: 1, fallback: 180 } },
      { key: 'redeemThreshold', env: 'MS_REDEEM_THRESHOLD', type: 'number', default: 6500,
        label: 'Redeem reminder threshold (points)',
        unit: 'points',
        hint: 'When your balance crosses this each MS run sends a Pushover reminder with the deep-link below. Defaults to 6,500 (US $5 Amazon GC at the current 2026 catalog price). Set to 0 to disable. The reminder re-fires every run until you redeem, since stock can sell out within hours.',
        coerce: { kind: 'numberBounded', min: 0, fallback: 0 } },
      { key: 'redeemLabel', env: 'MS_REDEEM_LABEL', type: 'string', default: '$5 Amazon GC',
        label: 'Reward label (shown in notification)',
        hint: 'Free-text label for the reward you are chasing — appears in the Pushover message ("redeem <label>: <url>"). Update together with the URL when switching rewards.' },
      { key: 'redeemUrl', env: 'MS_REDEEM_URL', type: 'string', default: 'https://rewards.bing.com/redeem/000800000000',
        label: 'Reward deep-link URL',
        hint: 'Direct link to the reward catalog page. Find it at https://rewards.bing.com/redeem/all — click the reward you want and copy the address-bar URL (looks like https://rewards.bing.com/redeem/000800000000).' },
    ],
    async checkLogin(page) {
      try {
        await page.goto('https://rewards.bing.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        const url = page.url();
        if (url.includes('login.live.com') || url.includes('login.microsoftonline.com') || url.includes('account.microsoft.com') || url.includes('/welcome')) {
          return { loggedIn: false };
        }
        const user = await readMicrosoftRewardsUser(page);
        return { loggedIn: true, user: user || 'Microsoft account' };
      } catch {
        return { loggedIn: false };
      }
    },
  },
  {
    id: 'microsoft-mobile',
    name: 'Microsoft Rewards (Mobile)',
    version: '2.0',
    subtitle: null,
    // microsoft.js drives both desktop and mobile in one run; this entry is
    // a session-only sibling so the Sessions tab can show login state for
    // each profile independently.
    script: null,
    loginUrl: 'https://rewards.bing.com',
    get browserDir() { return cfg.dir.browser + '-mobile'; },
    contextOptions: devices['Pixel 7'],
    defaultActive: true,
    activeEnv: 'MS_MOBILE_ACTIVE',
    linkedWith: null,
    claimDbFile: null,
    scheduleKind: 'daily-window',
    features: [],
    configFields: [],
    async checkLogin(page) {
      try {
        await page.goto('https://rewards.bing.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(5000); // mobile redirects settle more slowly
        const url = page.url();
        if (url.includes('login.live.com') || url.includes('login.microsoftonline.com') || url.includes('account.microsoft.com') || url.includes('/welcome')) {
          return { loggedIn: false };
        }
        // Same account as the desktop entry; the card title already says "(Mobile)",
        // so don't append it here too.
        const user = await readMicrosoftRewardsUser(page);
        return { loggedIn: true, user: user || 'Microsoft account' };
      } catch {
        return { loggedIn: false };
      }
    },
  },
  {
    id: 'ubisoft',
    name: 'Ubisoft Connect',
    version: '2.0',
    subtitle: 'Watch-only: pings you when a new free game appears at store.ubisoft.com/us/free-games. No login, no auto-claim — go grab it manually.',
    script: 'ubisoft.js',
    claimOrder: 6,
    loginUrl: null,
    browserDir: null,
    contextOptions: null,
    defaultActive: false,
    activeEnv: 'UBISOFT_ACTIVE',
    linkedWith: null,
    claimDbFile: null,
    scheduleKind: 'watch-only',
    features: [],
    configFields: [],
    checkLogin: null,
  },
  {
    id: 'humble-bundle',
    name: 'Humble Bundle',
    version: '0.1',
    subtitle: 'Watch-only: pings you when new free items appear at humblebundle.com store. No login, no auto-claim — go grab manually. Scaffolded scratch — selectors and URL paths may need iteration as Humble updates their store layout.',
    script: 'humble-bundle.js',
    claimOrder: 7,
    loginUrl: null,
    browserDir: null,
    contextOptions: null,
    defaultActive: false,
    activeEnv: 'HUMBLE_ACTIVE',
    linkedWith: null,
    claimDbFile: null,
    scheduleKind: 'watch-only',
    features: [],
    configFields: [],
    checkLogin: null,
  },
  {
    id: 'fanatical',
    name: 'Fanatical',
    version: '0.1',
    subtitle: 'Watch-only: pings you when new free Steam keys appear at fanatical.com/en/free-games-keys. No login, no auto-claim — go grab manually. Scaffolded — Fanatical\'s API endpoint and product shape may need iteration over time.',
    script: 'fanatical.js',
    claimOrder: 8,
    loginUrl: null,
    browserDir: null,
    contextOptions: null,
    defaultActive: false,
    activeEnv: 'FANATICAL_ACTIVE',
    linkedWith: null,
    claimDbFile: null,
    scheduleKind: 'watch-only',
    features: [],
    configFields: [],
    checkLogin: null,
  },
];

export const SITES_BY_ID = Object.fromEntries(SITES.map(s => [s.id, s]));

// The login-capable subset (everything with a checkLogin function). The
// existing engine code paths (Sessions tab, checkAllSites, launchSite,
// verifyAndClose, closeBrowser) only iterate over login-capable sites.
// Returning a fresh map per call keeps the data immutable from callers.
export function getLoginSitesById() {
  return Object.fromEntries(SITES.filter(s => typeof s.checkLogin === 'function').map(s => [s.id, s]));
}

// Run-order list consumed by buildClaimCommand. Sorted by claimOrder so the
// registry's display ordering (used by the Sessions tab) stays decoupled from
// the script execution sequence — gog runs first because it's the fastest
// and most stable, microsoft runs last because microsoft.js has an internal
// wait-until-window that blocks the process. linkedWith is preserved verbatim
// so a single 'microsoft' entry covers both microsoft + microsoft-mobile via
// the same microsoft.js invocation.
export function getClaimScriptOrder() {
  return SITES
    .filter(s => s.script && Number.isFinite(s.claimOrder))
    .slice()
    .sort((a, b) => a.claimOrder - b.claimOrder)
    .map(s => s.linkedWith
      ? { id: s.id, script: s.script, linkedWith: s.linkedWith }
      : { id: s.id, script: s.script });
}

// Settings-tab "Active" toggle linking. Each parent entry's linkedWith
// pointer fans out to a list whose first element is the parent and second
// element is the linked sub-service — toggling either id flips both. Today
// only Microsoft is linked (microsoft + microsoft-mobile share a settings
// row, credentials, and the microsoft.js script). Shape matches the
// previous LINKED_ACTIVE literal so the client-side panel JS that consumes
// this map can stay identical.
export function getLinkedActiveMap() {
  const out = {};
  for (const s of SITES) {
    if (s.linkedWith) out[s.id] = [s.id, s.linkedWith];
  }
  return out;
}

// id → JSON-DB filename map for stats aggregation. Only services that
// write a claim DB are included — Microsoft Rewards is points-based,
// AliExpress is coin-based, Ubisoft is watch-only, all four return null
// from claimDbFile and are skipped here. Iteration order matches SITES
// (prime-gaming, epic-games, gog, steam) so any consumer relying on
// insertion order sees the same sequence as the previous literal.
export function getClaimDbFiles() {
  return Object.fromEntries(
    SITES.filter(s => s.claimDbFile).map(s => [s.id, s.claimDbFile]),
  );
}

// Hours-of-day dropdown options (00:00 … 23:00). Lives here because the
// only consumer is getServiceRows() below for the MS schedule-window-start
// field; if any other field needs the same options, importing it from
// here keeps the data co-located with the registry.
const HOURS_OF_DAY = (() => {
  const out = [];
  for (let h = 0; h < 24; h++) out.push({ value: h, label: String(h).padStart(2, '0') + ':00' });
  return out;
})();

// Settings-tab service rows. Walks SITES, skipping any entry that is a
// linkedWith target of another (microsoft-mobile is rolled into the
// microsoft row). Each configField becomes a [path, label, extra?]
// tuple — the format the existing fieldRow() helper consumes. Entries
// flagged schedulerScope keep their full path verbatim (scheduler.*);
// regular entries get services.<id>.<key>. Empty configFields produce
// fields: [] so the row still renders a toggle-only card.
export function getServiceRows() {
  const subServiceIds = new Set(SITES.map(s => s.linkedWith).filter(Boolean));
  return SITES
    .filter(s => !subServiceIds.has(s.id))
    .map(s => {
      // Settings-tab category. Three buckets:
      //   'watch'  — scheduleKind 'watch-only' (notify-only collectors)
      //   'game'   — has a claimDbFile (writes a per-service claim DB)
      //   'points' — neither: collects points/coins/rewards (Microsoft,
      //              AliExpress today; Temu daily check-in et al later)
      const category = s.scheduleKind === 'watch-only' ? 'watch'
        : s.claimDbFile ? 'game'
        : 'points';
      const row = { id: s.id, title: s.name, version: s.version || null, scheduleKind: s.scheduleKind || 'daily-chain', category };
      if (s.subtitle) row.subtitle = s.subtitle;
      row.fields = (s.configFields || []).map(f => {
        const path = f.schedulerScope ? f.path : `services.${s.id}.${f.key}`;
        const extra = {};
        if (f.unit)   extra.unit   = f.unit;
        if (f.hint)   extra.hint   = f.hint;
        if (f.prefix) extra.prefix = f.prefix;
        if (f.kind === 'hour-of-day') extra.options = HOURS_OF_DAY;
        return Object.keys(extra).length ? [path, f.label, extra] : [path, f.label];
      });
      return row;
    });
}
