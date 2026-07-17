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
    // Getter so PG_BASE_URL takes effect at access time. Reads on each
    // cookie-import (interactive-login.js#deriveTargetHost) and each
    // panel-opened browser-login — both happen long after module load,
    // so this resolves to the live cfg value without a restart.
    get loginUrl() { return `${cfg.pg_base_url}/claims`; },
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
      { key: 'pendingMaxAgeDays', env: 'PG_PENDING_MAX_AGE_DAYS', type: 'number', default: null, nullable: true,
        label: 'Hide pending manual-redeem entries older than N days',
        unit: 'days',
        hint: 'Filters the per-run notification only — DB entries are preserved. Leave blank to show all pending entries regardless of age.',
        coerce: { kind: 'nullableNumber' } },
      { key: 'baseUrl', env: 'PG_BASE_URL', type: 'string', default: 'https://luna.amazon.com',
        label: 'Luna base URL',
        hint: 'For non-US users: when Amazon redirects you to a country-specific Luna host (e.g. luna.amazon.com.be), set this so the cookie-import host check accepts cookies from that domain and the script navigates to the right host. Trailing slash is stripped.' },
      { key: 'redeemMaxAttempts', env: 'PG_REDEEM_MAX_ATTEMPTS', type: 'number', default: 3,
        label: 'Max redeem retries before giving up',
        hint: 'When GOG rate-limits the auto-redeem (their "captcha" reason), gog.js retries on each daily run. This caps the total retries before the code is flagged for manual intervention via the panel\'s Batch Redeem button. 3 daily attempts is a reasonable balance — long enough to cover transient rate-limits, short enough that expiring offers don\'t sit indefinitely.',
        coerce: { kind: 'numberBounded', min: 1, fallback: 3 } },
    ],
    async checkLogin(page) {
      try {
        // Use the PG_BASE_URL-aware loginUrl so country-specific deploys
        // (luna.amazon.com.be, etc.) check the right host. Hard-coded
        // luna.amazon.com here was a 2.8.8 regression.
        await page.goto(this.loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
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
      } catch (e) {
        // Surface the error so postRunSessionCheck can distinguish "page
        // rendered, said not logged in" from "couldn't check at all"
        // (timeout, network, page changed shape). The notification
        // path skips entries with .error set — without this, a goto
        // timeout right after a heavy claim run silently became a
        // false "session expired" notification (observed 2026-05-25).
        return { loggedIn: false, error: (e && e.message ? e.message.split('\n')[0] : String(e)).slice(0, 200) };
      }
    },
  },
  {
    id: 'epic-games',
    name: 'Epic Games',
    version: '2.1',
    subtitle: null,
    script: 'epic-games.js',
    claimOrder: 3,
    loginUrl: 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=https://store.epicgames.com/en-US/free-games',
    // Sessions tab "open in new tab" target. loginUrl points to the login
    // form which is unhelpful for an already-authenticated user; homeUrl
    // sends them to the free-games landing page where they actually want
    // to go to verify their library or check what's on offer.
    homeUrl: 'https://store.epicgames.com/en-US/free-games',
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
      } catch (e) {
        // Surface the error so postRunSessionCheck can distinguish "page
        // rendered, said not logged in" from "couldn't check at all"
        // (timeout, network, page changed shape). The notification
        // path skips entries with .error set — without this, a goto
        // timeout right after a heavy claim run silently became a
        // false "session expired" notification (observed 2026-05-25).
        return { loggedIn: false, error: (e && e.message ? e.message.split('\n')[0] : String(e)).slice(0, 200) };
      }
    },
  },
  {
    id: 'fab',
    name: 'FAB',
    version: '0.1',
    subtitle: 'Claims the monthly "Limited-Time Free" assets on fab.com (Epic\'s 3D content marketplace) using your existing Epic Games session. Opt-in. Scaffolded — fab.com\'s DOM/selectors may need iteration as Epic updates the store.',
    script: 'fab.js',
    // Runs right after Epic so the shared browser profile already holds a
    // warm Epic session — FAB authenticates via Epic SSO, so no second
    // login is needed in the common case. 3.5 slots between epic-games (3)
    // and steam (4) in the claim chain ordering.
    claimOrder: 3.5,
    // FAB sign-in redirects to Epic's OAuth. Point the interactive-login
    // target at the free-assets page; an unauthenticated visit surfaces the
    // Sign In control, and an authenticated one lands where the user wants.
    loginUrl: 'https://www.fab.com/limited-time-free',
    homeUrl: 'https://www.fab.com/limited-time-free',
    // Same persistent profile as Epic Games — the Epic SSO cookies that FAB
    // relies on live here, so sharing the dir means a single Epic login
    // covers both services.
    get browserDir() { return cfg.dir.browser; },
    contextOptions: null,
    // Opt-in: not everyone wants Unreal/3D marketplace assets, and the flow
    // is newly scaffolded. Mirrors AliExpress's opt-in default.
    defaultActive: false,
    activeEnv: 'FAB_ACTIVE',
    linkedWith: null,
    claimDbFile: 'fab.json',
    scheduleKind: 'daily-chain',
    features: [],
    configFields: [],
    async checkLogin(page) {
      try {
        await page.goto('https://www.fab.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        // FAB (page + /i/ API) sits behind Cloudflare, so a non-OK response
        // from the session endpoint can be a bot-challenge rather than a
        // real auth signal. Treat the API as a POSITIVE-ONLY source (confirm
        // a name, never deny login) and let the DOM make the logged-out
        // decision. page.request inherits the context's Cloudflare clearance
        // + cookies the live browser already earned via the goto above.
        let user = null;
        try {
          const res = await page.request.get('https://www.fab.com/i/users/me', { timeout: 10000 });
          if (res.ok()) {
            const data = await res.json().catch(() => null);
            const name = data && (data.username || data.sellerName || data.name || data.email);
            if (name) user = String(name).trim();
          }
        } catch { /* fall through to DOM check */ }
        // DOM decision: a *visible* Sign In control means not authenticated.
        // FAB's sign-in is an icon-only avatar button (aria-label="Sign in",
        // no text), so match the aria-label, not just visible text. Count
        // visible matches only — FAB keeps hidden auth nodes in the DOM that
        // would trip a plain .count() into a false "logged out".
        const sel = '[aria-label="Sign in" i], a[href*="/login" i], a:has-text("Sign In"), button:has-text("Sign In")';
        const n = await page.locator(sel).count();
        let visible = 0;
        for (let i = 0; i < n; i++) if (await page.locator(sel).nth(i).isVisible().catch(() => false)) visible++;
        if (visible > 0) return { loggedIn: false };
        return { loggedIn: true, user: user || 'Epic account' };
      } catch (e) {
        // Surface the error so postRunSessionCheck can distinguish "page
        // rendered, said not logged in" from "couldn't check at all".
        return { loggedIn: false, error: (e && e.message ? e.message.split('\n')[0] : String(e)).slice(0, 200) };
      }
    },
  },
  {
    id: 'gog',
    name: 'GOG',
    version: '2.2',
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
      { key: 'otpBackupCodes', env: 'GOG_OTP_BACKUP_CODES', type: 'string', default: '',
        label: 'GOG 2FA backup codes (comma-separated)',
        hint: 'For users who have GOG two-step verification enabled on their account. Paste your 8-character backup codes from GOG → Account Settings → Security, comma-separated (e.g. "AAAA1111,BBBB2222,..."). When 2FA prompts during the daily run, the script will consume one code automatically and persist it as used in data/gog-used-otp-codes.txt so it is not retried. When all listed codes are exhausted, falls back to interactive VNC login. Leave empty if you don\'t use GOG 2FA — the existing TOTP / SMS flow is unaffected.' },
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
      } catch (e) {
        // Surface the error so postRunSessionCheck can distinguish "page
        // rendered, said not logged in" from "couldn't check at all"
        // (timeout, network, page changed shape). The notification
        // path skips entries with .error set — without this, a goto
        // timeout right after a heavy claim run silently became a
        // false "session expired" notification (observed 2026-05-25).
        return { loggedIn: false, error: (e && e.message ? e.message.split('\n')[0] : String(e)).slice(0, 200) };
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
    homeUrl: 'https://store.steampowered.com/',
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
      { key: 'skipUnrated', env: 'STEAM_SKIP_UNRATED', type: 'boolean', default: true,
        label: 'Skip unrated games (no reviews yet)',
        hint: 'Default ON — unrated games (zero reviews) are usually low-quality or brand-new shovelware. Turn OFF to let unrated games through (still subject to the Min price filter). Helpful for catching launch-day free indies before they accumulate reviews (#61).' },
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
      } catch (e) {
        // Surface the error so postRunSessionCheck can distinguish "page
        // rendered, said not logged in" from "couldn't check at all"
        // (timeout, network, page changed shape). The notification
        // path skips entries with .error set — without this, a goto
        // timeout right after a heavy claim run silently became a
        // false "session expired" notification (observed 2026-05-25).
        return { loggedIn: false, error: (e && e.message ? e.message.split('\n')[0] : String(e)).slice(0, 200) };
      }
    },
  },
  {
    id: 'aliexpress',
    name: 'AliExpress',
    version: '2.3',
    subtitle: 'Deprecated by AliExpress — web coin collection is being phased out in favor of the mobile app. Works for some accounts on a degradation curve. See README → Bot detection.',
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
      // Structural selectors (locale-blind) first, English-text fallback
      // second — same pattern as aliexpress.js auth() / coins() shipped in
      // v2.8.35. Caught here in v2.8.37 after oat1 reported in #75 that
      // their Polish account was logged in on the actual coin page but
      // the panel's session check still said "not logged in" — the
      // session check uses *this* function, not the daily-run auth(),
      // and this one was missed in the v2.8.35 sweep.
      const STRUCT_LOGIN_LINK = 'a[href*="/login"], a[href*="/signin" i], button[data-spm*="login" i]';
      const STRUCT_CLAIMABLE  = '#signButton[class*="aecoin-checkInButton"], [id="signButton"][class*="checkInButton"]';
      const STRUCT_DONE       = '#signButton[class*="aecoin-taskButton"], [id="signButton"][class*="taskButton"]';
      const loginBtn = page.locator(STRUCT_LOGIN_LINK + ', button:has-text("Log in")');
      const streak = page.locator(STRUCT_CLAIMABLE + ', h3:text-is("day streak")');
      // Post-collect state — the "day streak" h3 disappears once the user has
      // claimed today's coins, but "Earn more coins" stays visible. Treat that
      // as logged-in too so users who already collected manually don't get a
      // false "session expired" report from the panel.
      const collectedToday = page.locator(STRUCT_DONE + ', button:has-text("Earn more coins")');
      // AliExpress mobile frequently hangs on initial load — same issue as in
      // aliexpress.js auth(). Auto-reload up to 3 times until either the login
      // button or either logged-in marker appears, then short-circuit.
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
            collectedToday.waitFor({ state: 'visible', timeout: QUICK_WAIT_MS }).then(() => 'collectedToday'),
          ]).catch(() => null);
          if (which === 'streak' || which === 'collectedToday') return { loggedIn: true, user: 'member' };
          if (which === 'login') return { loggedIn: false };
        }
        return { loggedIn: false };
      } catch (e) {
        // Surface the error so postRunSessionCheck can distinguish "page
        // rendered, said not logged in" from "couldn't check at all"
        // (timeout, network, page changed shape). The notification
        // path skips entries with .error set — without this, a goto
        // timeout right after a heavy claim run silently became a
        // false "session expired" notification (observed 2026-05-25).
        return { loggedIn: false, error: (e && e.message ? e.message.split('\n')[0] : String(e)).slice(0, 200) };
      }
    },
  },
  {
    id: 'microsoft',
    name: 'Microsoft Rewards',
    version: '2.1',
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
        hint: 'Width of the daily Microsoft Rewards window, anchored to the start time. 0 disables the dedicated MS scheduler entirely — MS will not run unless you also enable "Run Microsoft inline with main chain" below.' },
      { schedulerScope: true, path: 'scheduler.msScheduleStart',
        label: 'Schedule window start (local time)',
        kind: 'hour-of-day' },
      { key: 'searchDelayMaxSec', env: 'MS_SEARCH_DELAY_MAX_SEC', type: 'number', default: 180,
        label: 'Max delay between Bing searches (seconds)',
        unit: 'seconds',
        hint: 'Upper bound for the random pause before each Bing search. Default 180 mimics a human pace; lower values shorten runs significantly (~60 searches × this/2 avg = total search time) but increase the risk of MS flagging the account as a bot.',
        coerce: { kind: 'numberBounded', min: 1, fallback: 180 } },
      { key: 'desktopSearchCount', env: 'MS_DESKTOP_SEARCH_COUNT', type: 'number', default: 35,
        label: 'Desktop searches per run',
        unit: 'searches',
        hint: 'Number of Bing searches the desktop session runs. The default 35 covers MS\'s daily desktop cap (~30 searches × 3 points = 90 points). Lower it if you have a small bonus-points cap and want to avoid running the claimer multiple times per day; raise it if your account caps higher. A ±2 jitter is applied at runtime to keep the count human-varying. Caution: setting this much higher than the default (e.g. >50) runs many searches in rapid succession from one session, which raises bot-detection risk — splitting the same total across 2 runs per day (e.g. cron-driven, 12 hours apart) is safer.',
        coerce: { kind: 'numberBounded', min: 1, fallback: 35 } },
      { key: 'mobileSearchCount', env: 'MS_MOBILE_SEARCH_COUNT', type: 'number', default: 25,
        label: 'Mobile searches per run',
        unit: 'searches',
        hint: 'Number of Bing searches the mobile session runs. The default 25 covers MS\'s daily mobile cap (~20 searches × 3 points = 60 points). Same trade-offs as the desktop count — lower for smaller caps, higher if needed. A ±2 jitter is applied at runtime. Same caution: very high values raise bot-detection risk; splitting across multiple runs per day is safer than maxing one run.',
        coerce: { kind: 'numberBounded', min: 1, fallback: 25 } },
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
      { key: 'runWithMainChain', env: 'MS_RUN_WITH_MAIN_CHAIN', type: 'boolean', default: false,
        label: 'Run Microsoft inline with main chain (skip decoupled scheduler)',
        hint: 'Off (default): MS runs on its own daily window via the decoupled scheduler. On: MS runs back-to-back with Prime/Epic/GOG/Steam in the main daily run, ignoring the schedule-window settings above. Useful if your decoupled MS schedule never fires for an unknown reason — turning this on collapses MS into the same loop that already works for everything else.' },
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
      } catch (e) {
        // Surface the error so postRunSessionCheck can distinguish "page
        // rendered, said not logged in" from "couldn't check at all"
        // (timeout, network, page changed shape). The notification
        // path skips entries with .error set — without this, a goto
        // timeout right after a heavy claim run silently became a
        // false "session expired" notification (observed 2026-05-25).
        return { loggedIn: false, error: (e && e.message ? e.message.split('\n')[0] : String(e)).slice(0, 200) };
      }
    },
  },
  {
    id: 'microsoft-mobile',
    name: 'Microsoft Rewards (Mobile)',
    version: '2.1',
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
      } catch (e) {
        // Surface the error so postRunSessionCheck can distinguish "page
        // rendered, said not logged in" from "couldn't check at all"
        // (timeout, network, page changed shape). The notification
        // path skips entries with .error set — without this, a goto
        // timeout right after a heavy claim run silently became a
        // false "session expired" notification (observed 2026-05-25).
        return { loggedIn: false, error: (e && e.message ? e.message.split('\n')[0] : String(e)).slice(0, 200) };
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
    homeUrl: 'https://store.ubisoft.com/us/free-games',
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
    homeUrl: 'https://www.humblebundle.com/store/search?sort=discount&filter=onsale&min=0&max=0',
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
    // Fanatical removed the dedicated /en/free-games-keys landing page from
    // their SPA routing (the URL still loads enough of the shell for the
    // watcher script's API interception to work, but a browser visit shows
    // their not-found view). /en/on-sale is the canonical deals surface
    // per their sitemap; free items show at the top sorted by discount.
    homeUrl: 'https://www.fanatical.com/en/on-sale',
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
  {
    id: 'lenovo-gaming',
    name: 'Lenovo Gaming Key Drops',
    version: '0.1',
    subtitle: 'Watch-only: tracks scheduled key-drops at gaming.lenovo.com/game-key-drops. Notifies on discovery + 1h before / 5min before / at drop time. Drops are first-come-first-served once they go live, so the script is paired with a per-drop wake scheduler that fires push notifications on time. Auto-claim is a future phase — keys are first-come-first-served and the redemption flow goes through GamesPlanet.',
    script: 'lenovo-gaming.js',
    claimOrder: 10,
    loginUrl: null,
    homeUrl: 'https://gaming.lenovo.com/game-key-drops',
    browserDir: null,
    contextOptions: null,
    defaultActive: false,
    activeEnv: 'LENOVO_ACTIVE',
    linkedWith: null,
    claimDbFile: null,
    scheduleKind: 'watch-only',
    features: [],
    configFields: [
      // Notification priority. Apprise translates the level to whatever the
      // configured notifier supports (Pushover: high bypasses quiet hours,
      // emergency requires acknowledgment; other notifiers map similarly or
      // ignore). Default 'normal' preserves existing-deploy behavior; user
      // bumps to 'high' if they're in DnD-mode and would otherwise miss the
      // at-drop-time alert. Applies to all Lenovo notifications: new-drop
      // discovery, the per-drop 1h/5min/at-drop wakes, and restock alerts.
      { key: 'notifyPriority', env: 'LENOVO_NOTIFY_PRIORITY', type: 'string', default: 'normal',
        label: 'Notification priority',
        hint: 'Apprise-standard ladder. Passes through to your apprise notifier — Pushover maps "high" to bypass-quiet-hours and "emergency" to require-acknowledgment. Other notifiers may ignore the value or map differently. Applies to all Lenovo alerts (discovery, the 1h/5min/at-drop wakes, restock).',
        options: [
          { value: 'low',       label: 'Low' },
          { value: 'moderate',  label: 'Moderate' },
          { value: 'normal',    label: 'Normal (default)' },
          { value: 'high',      label: 'High — bypass quiet hours on Pushover' },
          { value: 'emergency', label: 'Emergency — require ack on Pushover' },
        ],
        coerce: { kind: 'priorityEnum' } },
    ],
    checkLogin: null,
  },
];

export const SITES_BY_ID = Object.fromEntries(SITES.map(s => [s.id, s]));

// Lookup helper for runner scripts that want to stamp their version into
// the run log header. Returns the registry's `version` string for the
// given id, or null if the id isn't registered. Pattern:
//   log.section(`Epic Games (v${siteVersion('epic-games')})`);
export function siteVersion(id) {
  return SITES_BY_ID[id]?.version || null;
}

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
        // Generic options pass-through for enum-style configFields. The
        // service entry supplies `options` as a list of { value, label }
        // pairs; the Settings UI renders it as a dropdown via fieldRow.
        if (f.options && !extra.options) extra.options = f.options;
        return Object.keys(extra).length ? [path, f.label, extra] : [path, f.label];
      });
      // Synthetic sub-service toggle for microsoft (#116 xh43k, 2026-07-17):
      // the microsoft row rolls up microsoft-mobile via linkedWith, so
      // the Settings UI has no way to disable JUST the mobile session
      // without also disabling desktop. Expose `services.microsoft-mobile
      // .active` inline as a boolean checkbox at the top of the microsoft
      // row so users can skip the mobile pass explicitly (useful on
      // new-UI accounts where MS removed mobile earning). microsoft.js
      // v2.8.69+ already reads this flag and short-circuits the mobile
      // session; this change is UI-only.
      if (s.id === 'microsoft') {
        row.fields.unshift([
          'services.microsoft-mobile.active',
          'Run mobile session',
          { hint: 'Uncheck to skip the mobile MS Rewards session entirely — its inter-session wait, mobile-UA browser context, and search loop are all skipped. Default: on. On new-UI accounts the mobile session is already auto-skipped at runtime (MS removed mobile earning from the redesign), so toggling this off just makes the skip explicit in your config for old-UI accounts too. Unchecking the parent Microsoft Rewards toggle above disables both desktop and mobile together.' }
        ]);
      }
      return row;
    });
}
