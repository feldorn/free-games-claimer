import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium, devices } from 'patchright';
import { datetime, notify, jsonDb, normalizeTitle } from './src/util.js';
import { cfg } from './src/config.js';

const PANEL_PORT = Number(process.env.PANEL_PORT) || 7080;
const NOVNC_PORT = process.env.NOVNC_PORT || 6080;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || process.env.VNC_PASSWORD || '';
const BASE_PATH = cfg.base_path; // e.g. "/free-games" when behind a subfolder proxy, or ""
const PUBLIC_URL = cfg.public_url || `http://localhost:${PANEL_PORT}${BASE_PATH}`;

import crypto from 'node:crypto';
const sessionTokens = new Set();

function generateToken() {
  const token = crypto.randomBytes(32).toString('hex');
  sessionTokens.add(token);
  return token;
}

function isAuthenticated(req) {
  if (!PANEL_PASSWORD) return true;
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/fgc_token=([a-f0-9]+)/);
  if (match && sessionTokens.has(match[1])) return true;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ') && sessionTokens.has(auth.slice(7))) return true;
  return false;
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login - Free Games Claimer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; align-items: center; justify-content: center; }
  .login-box { background: #16213e; padding: 40px; border-radius: 12px; border: 1px solid #0f3460; width: 360px; text-align: center; }
  .login-box h1 { color: #e94560; margin-bottom: 8px; font-size: 22px; }
  .login-box p { color: #888; margin-bottom: 24px; font-size: 14px; }
  .login-box input { width: 100%; padding: 10px 14px; border-radius: 6px; border: 1px solid #0f3460; background: #1a1a2e; color: #e0e0e0; font-size: 14px; margin-bottom: 16px; }
  .login-box button { width: 100%; padding: 10px; border-radius: 6px; border: none; background: #e94560; color: white; font-size: 14px; font-weight: 600; cursor: pointer; }
  .login-box button:hover { background: #d63851; }
  .error { color: #e94560; font-size: 13px; margin-bottom: 12px; display: none; }
</style></head><body>
<div class="login-box">
  <h1>Free Games Claimer</h1>
  <p>Enter the panel password to continue.</p>
  <div class="error" id="error">Incorrect password.</div>
  <input type="password" id="pw" placeholder="Password" autofocus>
  <button onclick="login()">Login</button>
</div>
<script>
document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
async function login() {
  const pw = document.getElementById('pw').value;
  const r = await fetch('${BASE_PATH}/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
  const j = await r.json();
  if (j.success) { location.reload(); }
  else { document.getElementById('error').style.display = 'block'; }
}
</script></body></html>`;

// Read the signed-in Microsoft Rewards user via the Rewards dashboard's own
// dapi/me endpoint. page.request inherits the browser context's cookies, so a
// valid session authenticates automatically. Returns null on any failure so
// callers can fall back to a generic label without invalidating the session.
async function readMicrosoftRewardsUser(page) {
  const endpoints = [
    'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=Rewards&options=600%2C700%2C888',
    'https://account.microsoft.com/profile/ProfileApi/GetBasicProfileInfo',
  ];
  for (const url of endpoints) {
    try {
      const res = await page.request.get(url, { timeout: 10000 });
      if (!res.ok()) continue;
      const data = await res.json();
      const attrs = data && data.response && data.response.userProfile && data.response.userProfile.attributes;
      const name = (attrs && (attrs.displayName || attrs.email))
        || (data && (data.displayName || data.firstName || data.DisplayName || data.email || data.Email));
      if (name) return String(name).trim();
    } catch { /* try next endpoint */ }
  }
  return null;
}

const SITES = {
  'prime-gaming': {
    name: 'Prime Gaming',
    loginUrl: 'https://luna.amazon.com/claims',
    browserDir: cfg.dir.browser,
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
  'epic-games': {
    name: 'Epic Games',
    loginUrl: 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=https://store.epicgames.com/en-US/free-games',
    browserDir: cfg.dir.browser,
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
  'gog': {
    name: 'GOG',
    loginUrl: 'https://www.gog.com/en',
    browserDir: cfg.dir.browser,
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
  'steam': {
    name: 'Steam',
    loginUrl: 'https://store.steampowered.com/login/',
    browserDir: cfg.dir.browser,
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
  'microsoft': {
    name: 'Microsoft Rewards',
    loginUrl: 'https://rewards.bing.com',
    browserDir: cfg.dir.browser,
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
  'microsoft-mobile': {
    name: 'Microsoft Rewards (Mobile)',
    loginUrl: 'https://rewards.bing.com',
    browserDir: cfg.dir.browser + '-mobile',
    contextOptions: devices['Pixel 7'],
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
};

let activeBrowser = null;
const siteStatus = {};
for (const id of Object.keys(SITES)) {
  siteStatus[id] = { status: 'unknown', user: null, checkedAt: null };
}

async function launchSite(siteId) {
  // launchSite may legitimately replace an existing activeBrowser, so we allow
  // that case and closeBrowser() below. Any other busy reason is a hard error.
  const busy = browserBusy({ allowActiveBrowser: true });
  if (busy) throw new Error(`Cannot launch browser — ${busy}.`);
  if (activeBrowser) {
    await closeBrowser();
  }
  const site = SITES[siteId];
  if (!site) throw new Error(`Unknown site: ${siteId}`);

  console.log(`[${datetime()}] Launching browser for ${site.name}...`);

  const context = await chromium.launchPersistentContext(site.browserDir, {
    headless: false,
    viewport: { width: cfg.width, height: cfg.height },
    locale: 'en-US',
    handleSIGINT: false,
    args: ['--hide-crash-restore-bubble'],
    ...(site.contextOptions || {}),
  });

  context.setDefaultTimeout(0);

  const page = context.pages().length ? context.pages()[0] : await context.newPage();
  if (!site.contextOptions?.viewport) await page.setViewportSize({ width: cfg.width, height: cfg.height });
  await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded' });

  activeBrowser = { siteId, context, page };
  console.log(`[${datetime()}] Browser launched for ${site.name}. User can now log in via VNC.`);
  return { success: true, site: siteId, name: site.name };
}

async function verifyAndClose() {
  if (!activeBrowser) {
    return { success: false, error: 'No browser is currently open.' };
  }
  const { siteId, context, page } = activeBrowser;
  const site = SITES[siteId];

  console.log(`[${datetime()}] Verifying login for ${site.name}...`);

  const result = await site.checkLogin(page);

  if (result.loggedIn) {
    console.log(`[${datetime()}] Login verified for ${site.name} as ${result.user}. Saving session.`);
    siteStatus[siteId] = { status: 'logged_in', user: result.user, checkedAt: datetime() };
    await context.close();
    activeBrowser = null;
    return { success: true, loggedIn: true, user: result.user, site: siteId };
  } else {
    console.log(`[${datetime()}] Login NOT detected for ${site.name}. Browser remains open.`);
    return { success: true, loggedIn: false, site: siteId, message: 'Login not detected. Please complete the login process and try again.' };
  }
}

async function closeBrowser() {
  if (!activeBrowser) return;
  console.log(`[${datetime()}] Closing browser for ${SITES[activeBrowser.siteId].name}.`);
  try {
    await activeBrowser.context.close();
  } catch {}
  activeBrowser = null;
}

let checkInProgress = false;

async function checkSiteStatus(siteId) {
  const site = SITES[siteId];
  if (!site) return { loggedIn: false, error: 'Unknown site' };

  const busy = browserBusy();
  if (busy) return { error: `Browser profile busy — ${busy}.` };

  checkInProgress = true;
  console.log(`[${datetime()}] Checking session status for ${site.name} (headless)...`);

  let context;
  try {
    context = await chromium.launchPersistentContext(site.browserDir, {
      headless: false,
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      handleSIGINT: false,
      args: ['--hide-crash-restore-bubble', '--no-sandbox', '--disable-gpu'],
      ...(site.contextOptions || {}),
    });

    const page = context.pages()[0] || await context.newPage();
    const result = await site.checkLogin(page);
    siteStatus[siteId] = {
      status: result.loggedIn ? 'logged_in' : 'not_logged_in',
      user: result.user || null,
      checkedAt: datetime(),
    };
    console.log(`[${datetime()}] ${site.name}: ${result.loggedIn ? `logged in as ${result.user}` : 'not logged in'}`);
    return { ...result, site: siteId };
  } catch (e) {
    console.error(`[${datetime()}] Check failed for ${site.name}:`, e.message);
    siteStatus[siteId] = { status: 'error', user: null, checkedAt: datetime() };
    return { loggedIn: false, site: siteId, error: e.message };
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
    checkInProgress = false;
  }
}

let runProcess = null;
let runDone = null; // Promise that resolves when runProcess finishes (for scheduler to await)
let runLog = [];
let runStatus = 'idle';
let runSource = null; // 'panel' | 'scheduler'
let lastRun = null; // { at, source, exitCode, status, startedAt, durationSec }
let runStartedAt = null;
let startupAutoCheck = null; // { current, total, siteName } while auto-check is walking sites

// gog.js runs first so its Prime-Gaming-code reconcile (library + redeem-endpoint
// probe) updates prime-gaming.json BEFORE prime-gaming.js fires its pending-redeem
// notification. Otherwise the notification goes out with a stale pending count.
// Two command sets so "Run Now" finishes in ~5 min instead of hanging until the
// next morning: microsoft.js has an internal MS_SCHEDULE_HOURS sleep that can
// hold the subprocess open for up to 20 hours, which is correct for the
// scheduled-daily path but wrong for interactive "run these now".
//   CLAIM_CMD         — full set, used by the scheduler at its anchored wake.
//   CLAIM_CMD_MANUAL  — subset (no microsoft.js), used by the "Run Now" button.
const CLAIM_CMD = process.env.CLAIM_CMD || 'node gog.js; node prime-gaming.js; node epic-games.js; node steam.js; node microsoft.js';
const CLAIM_CMD_MANUAL = process.env.CLAIM_CMD_MANUAL || 'node gog.js; node prime-gaming.js; node epic-games.js; node steam.js';

// Unified profile-busy check. The chromium user-data-dir only supports one
// process at a time — four distinct code paths can hold it: session-checks
// (checkSiteStatus), interactive login sessions (activeBrowser), scheduled
// or manual claim runs (runProcess), and batch redeem (batchRedeem). Any
// entry point that wants the profile must check this first. Returns a human
// description of what's busy, or null.
function browserBusy({ allowActiveBrowser = false } = {}) {
  if (checkInProgress) return 'auto-checking session status';
  if (runProcess) return `claim run in progress${runSource ? ' (' + runSource + ')' : ''}`;
  if (!allowActiveBrowser && activeBrowser) {
    const name = SITES[activeBrowser.siteId]?.name || activeBrowser.siteId;
    return `interactive browser session active for ${name}`;
  }
  if (batchRedeem && batchRedeem.phase !== 'done' && batchRedeem.phase !== 'stopped' && batchRedeem.phase !== 'error') {
    return 'batch redeem in progress';
  }
  return null;
}

// ----- Batch redeem -----
// Drives the GOG /redeem page programmatically for each entry in
// prime-gaming.json that's store=gog.com, has a code, and hasn't been
// marked redeemed. Auto-clicks Continue → Redeem for each code. When
// GOG demands a captcha, pauses and lets the user solve it via noVNC;
// polls the page DOM for completion then moves on.
let batchRedeem = null;

function collectPendingGogCodes(pgDb) {
  const pending = [];
  for (const games of Object.values(pgDb.data || {})) {
    if (!games || typeof games !== 'object') continue;
    for (const [title, entry] of Object.entries(games)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.store !== 'gog.com' || !entry.code) continue;
      if (/redeemed|expired|invalid/i.test(String(entry.status || ''))) continue;
      pending.push({ title, entry });
    }
  }
  return pending;
}

async function countPendingGogCodes() {
  try {
    const pgDb = await jsonDb('prime-gaming.json', {});
    return collectPendingGogCodes(pgDb).length;
  } catch {
    return 0;
  }
}

async function processOneRedeemCode(page, code) {
  await page.goto(`https://www.gog.com/redeem/${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  // URL-based pre-fill usually works; fall back to filling #codeInput explicitly.
  try { await page.fill('#codeInput', code); } catch {}
  // Click Continue — GOG fires GET /v1/bonusCodes/<code> in response.
  const r1Promise = page.waitForResponse(
    r => r.request().method() === 'GET' && r.url().startsWith('https://redeem.gog.com/v1/bonusCodes/'),
    { timeout: 20000 },
  );
  await page.click('[type="submit"]');
  const r1 = await r1Promise;
  const r1t = await r1.text();
  let r1j = {}; try { r1j = JSON.parse(r1t); } catch {}
  const reason1 = String(r1j.reason || '').toLowerCase();
  if (reason1 === 'code_used') return { outcome: 'used' };
  if (reason1 === 'code_not_found') return { outcome: 'not-found' };
  if (reason1.includes('captcha')) return { outcome: 'captcha', productTitle: null };
  // Valid — click Redeem; GOG fires POST /v1/bonusCodes/<code>.
  const r2Promise = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().startsWith('https://redeem.gog.com/v1/bonusCodes/'),
    { timeout: 20000 },
  );
  await page.click('[type="submit"]');
  const r2 = await r2Promise;
  const r2t = await r2.text();
  let r2j = {}; try { r2j = JSON.parse(r2t); } catch {}
  const reason2 = String(r2j.reason2 || r2j.reason || '').toLowerCase();
  if (r2j.type === 'async_processing') {
    await page.locator('h1:has-text("Code redeemed successfully!")').waitFor({ timeout: 15000 }).catch(() => {});
    return { outcome: 'redeemed', productTitle: r1j.products?.[0]?.title };
  }
  if (reason2.includes('captcha')) return { outcome: 'captcha', productTitle: r1j.products?.[0]?.title };
  return { outcome: 'unknown', raw: r2j };
}

async function waitForCaptchaResolution(page) {
  // User solves captcha + clicks Redeem themselves. Poll DOM for result.
  const deadline = Date.now() + 10 * 60 * 1000; // 10 min max per code
  while (Date.now() < deadline) {
    if (!batchRedeem || batchRedeem.phase === 'stopped') return 'stopped';
    try {
      if (await page.locator('h1:has-text("Code redeemed successfully!")').count() > 0) return 'redeemed';
      if (await page.locator('text=/already redeemed|already used|code was used|code used/i').count() > 0) return 'used';
      if (await page.locator('text=/not found|invalid code|doesn.t exist|incorrect/i').count() > 0) return 'not-found';
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  return 'timeout';
}

async function fetchGogLibraryTitles(page) {
  const titles = new Set();
  let pageNum = 1, totalPages = 1;
  do {
    const body = await page.evaluate(async p => {
      const r = await fetch(`https://www.gog.com/account/getFilteredProducts?mediaType=1&page=${p}&sortBy=title`, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }, pageNum);
    const j = JSON.parse(body);
    totalPages = j.totalPages || 1;
    for (const product of j.products || []) {
      if (product?.title) titles.add(normalizeTitle(product.title));
    }
    pageNum++;
  } while (pageNum <= totalPages && pageNum <= 30);
  return titles;
}

async function runBatchRedeemLoop() {
  // Load library once up front. When GOG returns code_used, we cross-check
  // against the library — "code_used" at GOG is the same response whether
  // the code actually added the game to your account or was consumed without
  // crediting (expired / old-account / GOG weirdness). The library is the
  // ground truth for whether you actually own it.
  let libraryTitles = new Set();
  try {
    batchRedeem.message = 'Loading GOG library…';
    batchRedeem.updatedAt = datetime();
    libraryTitles = await fetchGogLibraryTitles(batchRedeem.page);
    console.log(`[${datetime()}] Batch redeem: library has ${libraryTitles.size} titles`);
  } catch (e) {
    console.log(`[${datetime()}] Batch redeem: library fetch failed, can't verify code_used against ownership — ${e.message}`);
  }

  while (batchRedeem && batchRedeem.index < batchRedeem.pending.length && batchRedeem.phase !== 'stopped') {
    const { title, entry } = batchRedeem.pending[batchRedeem.index];
    batchRedeem.currentTitle = title;
    batchRedeem.currentCode = entry.code;
    batchRedeem.message = `Processing ${title}…`;
    batchRedeem.updatedAt = datetime();

    let result;
    try {
      result = await processOneRedeemCode(batchRedeem.page, entry.code);
    } catch (e) {
      console.error(`[${datetime()}] Batch redeem: ${title} — ${e.message}`);
      result = { outcome: 'error', error: e.message };
    }

    let finalOutcome = result.outcome;
    if (result.outcome === 'captcha') {
      batchRedeem.phase = 'awaiting-captcha';
      batchRedeem.message = `Solve captcha + click Redeem for "${title}" in the browser — auto-continuing when done.`;
      batchRedeem.updatedAt = datetime();
      finalOutcome = await waitForCaptchaResolution(batchRedeem.page);
      if (finalOutcome === 'stopped') break;
      batchRedeem.phase = 'running';
    }

    if (finalOutcome === 'redeemed') {
      entry.status = 'claimed and redeemed (batch)';
      batchRedeem.stats.redeemed++;
    } else if (finalOutcome === 'used') {
      // GOG says the code is consumed. Cross-check the library to distinguish
      // truly-redeemed (game in library) from consumed-but-lost (expired).
      if (libraryTitles.size > 0 && libraryTitles.has(normalizeTitle(title))) {
        entry.status = 'claimed and redeemed (verified via GOG)';
        batchRedeem.stats.used++;
      } else {
        entry.status = 'claimed, code consumed but not in library (likely expired)';
        batchRedeem.stats.notFound++; // count under "invalid" since it's not redeemable
        console.log(`[${datetime()}] Batch redeem: ${title} — GOG says code_used but title not in library; marking as expired`);
      }
    } else if (finalOutcome === 'not-found') {
      entry.status = 'claimed, code expired or invalid';
      batchRedeem.stats.notFound++;
    } else if (finalOutcome === 'timeout') {
      batchRedeem.stats.timeouts++;
      console.log(`[${datetime()}] Batch redeem: ${title} — timed out, moving on`);
    } else if (finalOutcome === 'error') {
      batchRedeem.stats.errors++;
    } else {
      batchRedeem.stats.unknown++;
    }
    try { await batchRedeem.pgDb.write(); } catch {}

    batchRedeem.index++;
  }

  if (batchRedeem) {
    batchRedeem.phase = batchRedeem.phase === 'stopped' ? 'stopped' : 'done';
    const s = batchRedeem.stats;
    batchRedeem.message = `Batch ${batchRedeem.phase} — ${s.redeemed} redeemed, ${s.used} already, ${s.notFound} invalid${s.errors ? `, ${s.errors} errors` : ''}`;
    batchRedeem.updatedAt = datetime();
    try { await batchRedeem.context.close(); } catch {}
    batchRedeem.context = null;
    batchRedeem.page = null;
    console.log(`[${datetime()}] Batch redeem ${batchRedeem.phase}: ${batchRedeem.message}`);
  }
}

async function startBatchRedeem() {
  const busy = browserBusy({ allowActiveBrowser: true });
  if (busy) throw new Error(`Cannot start batch redeem — ${busy}.`);
  if (activeBrowser) await closeBrowser();

  const pgDb = await jsonDb('prime-gaming.json', {});
  const pending = collectPendingGogCodes(pgDb);
  if (!pending.length) throw new Error('No pending GOG codes to redeem.');

  console.log(`[${datetime()}] Starting batch redeem for ${pending.length} GOG code(s)...`);
  const context = await chromium.launchPersistentContext(cfg.dir.browser, {
    headless: false,
    viewport: { width: cfg.width, height: cfg.height },
    locale: 'en-US',
    handleSIGINT: false,
    args: ['--hide-crash-restore-bubble'],
  });
  const page = context.pages()[0] || await context.newPage();
  try { await page.setViewportSize({ width: cfg.width, height: cfg.height }); } catch {}
  context.setDefaultTimeout(0); // batch-redeem drives its own timeouts

  batchRedeem = {
    context, page, pgDb, pending,
    index: 0,
    stats: { redeemed: 0, used: 0, notFound: 0, unknown: 0, errors: 0, timeouts: 0 },
    phase: 'running',
    currentTitle: null, currentCode: null,
    message: `Starting — ${pending.length} code(s) queued`,
    startedAt: datetime(), updatedAt: datetime(),
  };

  runBatchRedeemLoop().catch(e => {
    console.error(`[${datetime()}] Batch redeem loop crashed:`, e);
    if (batchRedeem) {
      batchRedeem.phase = 'error';
      batchRedeem.message = `Error: ${e.message}`;
    }
  });

  return { success: true, total: pending.length };
}

async function stopBatchRedeem() {
  if (!batchRedeem) return { success: false, error: 'No batch redeem active.' };
  batchRedeem.phase = 'stopped';
  batchRedeem.message = 'Stopped by user';
  batchRedeem.updatedAt = datetime();
  try { if (batchRedeem.context) await batchRedeem.context.close(); } catch {}
  return { success: true, stats: batchRedeem.stats };
}

function clearFinishedBatchRedeem() {
  if (batchRedeem && (batchRedeem.phase === 'done' || batchRedeem.phase === 'stopped' || batchRedeem.phase === 'error')) {
    batchRedeem = null;
  }
}

async function checkAllSites() {
  const results = {};
  for (const siteId of Object.keys(SITES)) {
    if (activeBrowser) {
      results[siteId] = { error: 'Browser session active, close it first.' };
      continue;
    }
    results[siteId] = await checkSiteStatus(siteId);
  }
  return results;
}

function runAllScripts({ source = 'panel' } = {}) {
  const busy = browserBusy();
  if (busy) return { success: false, error: `Cannot start run — ${busy}.` };

  runLog = [];
  runStatus = 'running';
  runSource = source;
  runStartedAt = Date.now();
  console.log(`[${datetime()}] Starting all claiming scripts (${source})...`);

  // For scheduled runs, set NOWAIT=1 so scripts exit fast on stale sessions
  // instead of waiting for interactive login. We follow up with a session
  // re-check to notify the user about any sites that now need manual action.
  const childEnv = source === 'scheduler'
    ? { ...process.env, NOWAIT: '1' }
    : process.env;

  // Manual "Run Now" uses the subset without microsoft.js so it actually ends.
  const cmd = source === 'scheduler' ? CLAIM_CMD : CLAIM_CMD_MANUAL;

  const child = spawn('bash', ['-c', cmd], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  runProcess = child;

  runDone = new Promise(resolve => {
    child.stdout.on('data', data => {
      process.stdout.write(data); // keep `docker logs` useful
      const lines = data.toString().split('\n').filter(l => l.length);
      lines.forEach(l => {
        runLog.push({ type: 'stdout', text: l, time: datetime() });
        if (runLog.length > 500) runLog.shift();
      });
    });

    child.stderr.on('data', data => {
      process.stderr.write(data);
      const lines = data.toString().split('\n').filter(l => l.length);
      lines.forEach(l => {
        runLog.push({ type: 'stderr', text: l, time: datetime() });
        if (runLog.length > 500) runLog.shift();
      });
    });

    child.on('close', code => {
      runStatus = code === 0 ? 'success' : 'finished';
      runLog.push({ type: 'system', text: `Scripts finished with exit code ${code}`, time: datetime() });
      lastRun = {
        at: datetime(),
        source: runSource,
        exitCode: code,
        status: runStatus,
        durationSec: runStartedAt ? Math.round((Date.now() - runStartedAt) / 1000) : null,
      };
      runProcess = null;
      runSource = null;
      runStartedAt = null;
      console.log(`[${datetime()}] All scripts finished (exit code ${code}).`);
      resolve(code);
    });

    child.on('error', err => {
      runStatus = 'error';
      runLog.push({ type: 'system', text: `Error: ${err.message}`, time: datetime() });
      lastRun = {
        at: datetime(),
        source: runSource,
        exitCode: -1,
        status: 'error',
        durationSec: runStartedAt ? Math.round((Date.now() - runStartedAt) / 1000) : null,
        error: err.message,
      };
      runProcess = null;
      runSource = null;
      runStartedAt = null;
      resolve(-1);
    });
  });

  return { success: true };
}

// ----- Scheduler -----
// Reads LOOP (seconds) and optional MS_SCHEDULE_HOURS / MS_SCHEDULE_START (hours) from env.
// Anchor-based wake time: if MS_SCHEDULE_HOURS is set we wake 30min before the window opens
// tomorrow, so the loop fires at ~the same clock time every day (no drift from run duration).
// Otherwise we sleep LOOP seconds after the previous run completes.
const LOOP_SECONDS = Number(process.env.LOOP) || 0;
const MS_SCHEDULE_HOURS = Number(process.env.MS_SCHEDULE_HOURS) || 0;
const MS_SCHEDULE_START = Number(process.env.MS_SCHEDULE_START) || 8;

let nextScheduledRun = null; // Date | null

function computeNextWakeMs() {
  if (MS_SCHEDULE_HOURS > 0) {
    const wakeHour = MS_SCHEDULE_START > 0 ? MS_SCHEDULE_START - 1 : 23;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(wakeHour, 30, 0, 0);
    return Math.max(tomorrow.getTime() - Date.now(), 60 * 1000);
  }
  return LOOP_SECONDS * 1000;
}

async function postRunSessionCheck() {
  // After a scheduled run, probe each site. Any that come back not-logged-in
  // get a single aggregated Pushover notification with per-site deep-links
  // (?login=<siteId>) so tapping the right line lands the user directly in
  // that site's Login flow instead of the dashboard root.
  console.log(`[${datetime()}] Scheduler: verifying session health...`);
  const results = await checkAllSites();
  const stale = [];
  for (const [siteId, r] of Object.entries(results)) {
    if (!r || r.error) continue;
    if (r.loggedIn === false) stale.push(siteId);
  }
  if (!stale.length) {
    console.log(`[${datetime()}] Scheduler: all sessions valid.`);
    return;
  }
  const names = stale.map(id => SITES[id]?.name || id);
  console.log(`[${datetime()}] Scheduler: stale sessions detected — ${names.join(', ')}.`);
  // Plain-text body; Pushover strips HTML but auto-linkifies full URLs, so
  // we put one URL per line per site and keep the text on separate lines.
  const plural = stale.length > 1 ? 's' : '';
  const lines = [`Free Games Claimer — ${stale.length} session${plural} expired. Tap to log in:`];
  for (const siteId of stale) {
    const name = SITES[siteId]?.name || siteId;
    lines.push(`- ${name}: ${PUBLIC_URL}/?login=${encodeURIComponent(siteId)}`);
  }
  const body = lines.join('<br>');
  try {
    await notify(body);
  } catch (e) {
    console.error(`[${datetime()}] Scheduler: notify failed:`, e.message);
  }
}

async function schedulerLoop() {
  // Wait for the first computed wake time BEFORE running — otherwise a mid-day
  // container restart fires an immediate claim run, and if MS_SCHEDULE_HOURS is
  // set microsoft.js will sleep internally for up to 20 hours keeping runProcess
  // non-null and locking the panel. Users who want an immediate run can click
  // "Run Now" in the panel (matches how cron, systemd timers, etc. behave).
  while (true) {
    const sleepMs = computeNextWakeMs();
    nextScheduledRun = new Date(Date.now() + sleepMs);
    console.log(`[${datetime()}] Scheduler: next run at ${datetime(nextScheduledRun)}.`);
    await new Promise(r => setTimeout(r, sleepMs));

    const busy = browserBusy();
    if (busy) {
      console.log(`[${datetime()}] Scheduler: skipping run — ${busy}.`);
      continue;
    }
    const res = runAllScripts({ source: 'scheduler' });
    if (res.success && runDone) {
      try { await runDone; } catch (e) { console.error(`[${datetime()}] Scheduler run error:`, e); }
    } else if (!res.success) {
      console.log(`[${datetime()}] Scheduler: ${res.error}`);
      continue;
    }
    // Run finished — check which sessions survived and notify about stale ones.
    try { await postRunSessionCheck(); } catch (e) { console.error(`[${datetime()}] Session check failed:`, e); }
  }
}

function getState() {
  const allLoggedIn = Object.values(siteStatus).every(s => s.status === 'logged_in');
  return {
    sites: Object.entries(SITES).map(([id, site]) => ({
      id,
      name: site.name,
      ...siteStatus[id],
    })),
    activeBrowser: activeBrowser ? { site: activeBrowser.siteId, name: SITES[activeBrowser.siteId].name } : null,
    allLoggedIn,
    runStatus,
    runSource,
    runLogLength: runLog.length,
    nextScheduledRun: nextScheduledRun ? datetime(nextScheduledRun) : null,
    loopEnabled: LOOP_SECONDS > 0 || MS_SCHEDULE_HOURS > 0,
    loopSeconds: LOOP_SECONDS,
    msScheduleHours: MS_SCHEDULE_HOURS,
    msScheduleStart: MS_SCHEDULE_START,
    batchRedeem: batchRedeem ? {
      phase: batchRedeem.phase,
      message: batchRedeem.message,
      index: batchRedeem.index,
      total: batchRedeem.pending.length,
      currentTitle: batchRedeem.currentTitle,
      stats: batchRedeem.stats,
      startedAt: batchRedeem.startedAt,
      updatedAt: batchRedeem.updatedAt,
    } : null,
    startupAutoCheck,
    lastRun,
  };
}

// ----- Stats -----
// Aggregates claim history from per-service JSON DBs written by the claim
// scripts. Scripts set entry.status starting with "claimed" (plain,
// "claimed and redeemed", "claimed on gog.com", etc.) once a claim succeeds;
// anything else (existed/failed/skipped) is excluded from game counts.
// Microsoft Rewards is points-based and has no claim DB, so it appears in
// the per-service table as N/A.

const CLAIM_DB_FILES = {
  'prime-gaming': 'prime-gaming.json',
  'epic-games': 'epic-games.json',
  'gog': 'gog.json',
  'steam': 'steam.json',
};

function parseLocalDateTime(s) {
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(s.replace(' ', 'T'));
  return Number.isFinite(d.getTime()) ? d : null;
}

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function readAllClaims() {
  const out = [];
  for (const [service, file] of Object.entries(CLAIM_DB_FILES)) {
    let db;
    try { db = await jsonDb(file, {}); }
    catch { continue; }
    const data = db.data || {};
    for (const user of Object.keys(data)) {
      const userRecords = data[user];
      if (!userRecords || typeof userRecords !== 'object') continue;
      for (const [gameId, entry] of Object.entries(userRecords)) {
        if (!entry || typeof entry !== 'object') continue;
        const status = typeof entry.status === 'string' ? entry.status : '';
        if (!status.startsWith('claimed')) continue;
        const at = parseLocalDateTime(entry.time);
        if (!at) continue;
        out.push({ service, user, gameId, title: entry.title || gameId, url: entry.url || null, at, status });
      }
    }
  }
  return out;
}

// Aggregate MS Rewards point history captured by microsoft.js. Each run
// records { at, session, before, after, earned } in microsoft-rewards.json
// — we can derive: latest visible balance, points earned in a window,
// per-session counts for the stats table.
async function getMsRewards() {
  let db;
  try { db = await jsonDb('microsoft-rewards.json', { runs: [] }); }
  catch { return { latestBalance: null, latestAt: null, weekEarned: 0, monthEarned: 0, bySession: {} }; }
  const runs = (db.data && Array.isArray(db.data.runs)) ? db.data.runs : [];
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const toMs = s => { const d = parseLocalDateTime(s); return d ? d.getTime() : 0; };
  let weekEarned = 0, monthEarned = 0;
  let latestBalance = null, latestAt = null, latestMs = 0;
  const bySession = {
    'microsoft':        { thisWeek: 0, thisMonth: 0, allTime: 0, lastClaimAt: null, unit: 'points' },
    'microsoft-mobile': { thisWeek: 0, thisMonth: 0, allTime: 0, lastClaimAt: null, unit: 'points' },
  };
  for (const r of runs) {
    const tMs = toMs(r.at);
    const earned = Number.isFinite(r.earned) ? Math.max(0, r.earned) : 0;
    if (tMs >= weekAgo) weekEarned += earned;
    if (tMs >= monthAgo) monthEarned += earned;
    if (r.after != null && tMs >= latestMs) { latestBalance = r.after; latestAt = r.at; latestMs = tMs; }
    const sKey = r.session === 'mobile' ? 'microsoft-mobile' : 'microsoft';
    const row = bySession[sKey];
    row.allTime += earned;
    if (tMs >= weekAgo) row.thisWeek += earned;
    if (tMs >= monthAgo) row.thisMonth += earned;
    if (!row.lastClaimAt || tMs > toMs(row.lastClaimAt)) row.lastClaimAt = r.at;
  }
  return { latestBalance, latestAt, weekEarned, monthEarned, bySession };
}

async function getStatsSummary() {
  const [claims, ms] = await Promise.all([readAllClaims(), getMsRewards()]);
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const thisWeek = claims.filter(c => c.at.getTime() >= weekAgo).length;
  const thisMonth = claims.filter(c => c.at.getTime() >= monthAgo).length;
  claims.sort((a, b) => b.at - a.at);
  const latest = claims[0] || null;
  return {
    gamesThisWeek: thisWeek,
    gamesThisMonth: thisMonth,
    gamesAllTime: claims.length,
    lastClaim: latest ? {
      at: datetime(latest.at),
      service: latest.service,
      serviceName: (SITES[latest.service] && SITES[latest.service].name) || latest.service,
      title: latest.title,
      url: latest.url,
    } : null,
    msPointsBalance: ms.latestBalance,
    msPointsBalanceAt: ms.latestAt,
    msPointsThisWeek: ms.weekEarned,
    msPointsThisMonth: ms.monthEarned,
  };
}

async function getStatsByService() {
  const [claims, ms] = await Promise.all([readAllClaims(), getMsRewards()]);
  const rows = {};
  for (const svc of Object.keys(CLAIM_DB_FILES)) {
    rows[svc] = { id: svc, unit: 'games', thisWeek: 0, thisMonth: 0, allTime: 0, lastClaimAt: null };
  }
  // MS rows use real aggregates from the MS runs DB instead of the "N/A" stub.
  rows['microsoft']        = { id: 'microsoft',        ...ms.bySession['microsoft'] };
  rows['microsoft-mobile'] = { id: 'microsoft-mobile', ...ms.bySession['microsoft-mobile'] };
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  for (const c of claims) {
    const row = rows[c.service];
    if (!row || row.unit !== 'games') continue;
    row.allTime++;
    if (c.at.getTime() >= weekAgo) row.thisWeek++;
    if (c.at.getTime() >= monthAgo) row.thisMonth++;
    const ts = datetime(c.at);
    if (!row.lastClaimAt || ts > row.lastClaimAt) row.lastClaimAt = ts;
  }
  return Object.values(rows).map(r => ({
    ...r,
    name: (SITES[r.id] && SITES[r.id].name) || r.id,
  }));
}

async function getStatsDaily(days = 30) {
  const claims = await readAllClaims();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    buckets.push({ date: localDateKey(d), count: 0 });
  }
  const byDate = Object.fromEntries(buckets.map(b => [b.date, b]));
  for (const c of claims) {
    const key = localDateKey(c.at);
    if (byDate[key]) byDate[key].count++;
  }
  return buckets;
}

async function getActivity(limit = 10) {
  const claims = await readAllClaims();
  claims.sort((a, b) => b.at - a.at);
  return claims.slice(0, limit).map(c => ({
    at: datetime(c.at),
    service: c.service,
    serviceName: (SITES[c.service] && SITES[c.service].name) || c.service,
    title: c.title,
    url: c.url,
    status: c.status,
  }));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Free Games Claimer - Login Panel</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }

  .header { background: #16213e; padding: 12px 20px; border-bottom: 2px solid #0f3460; flex-shrink: 0; }
  .header-top { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .header h1 { font-size: 18px; color: #e94560; white-space: nowrap; }
  .header-actions { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }

  .tab-nav { display: flex; gap: 2px; }
  .tab-nav .tab { padding: 5px 12px; background: transparent; color: #a0a0c0; font-size: 13px; cursor: pointer; border: none; border-radius: 6px; font-weight: 500; }
  .tab-nav .tab:hover { background: #1a2a4a; color: #e0e0e0; }
  .tab-nav .tab.active { background: #0f3460; color: #fff; }

  .tab-panel { display: none; }
  .tab-panel.stub { padding: 40px; color: #8aa0c2; text-align: center; line-height: 1.7; }
  .tab-panel.stub h2 { color: #e0e0e0; margin-bottom: 10px; font-size: 18px; }
  .tab-panel.stub p { font-size: 14px; max-width: 480px; margin: 0 auto; }
  body[data-tab="sessions"] .tab-panel[data-panel="sessions"] { display: flex; flex: 1; flex-direction: column; }
  body[data-tab="stats"] .tab-panel[data-panel="stats"] { display: block; overflow-y: auto; padding: 24px 32px; }
  body[data-tab="schedule"] .tab-panel[data-panel="schedule"] { display: block; overflow-y: auto; padding: 28px 32px; }
  body[data-tab="logs"] .tab-panel[data-panel="logs"] { display: flex; flex: 1; flex-direction: column; }
  body:not([data-tab="sessions"]) .sessions-only { display: none !important; }

  .stats-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .kpi { background: #16233c; border: 1px solid #233454; border-radius: 8px; padding: 14px 16px; }
  .kpi .kpi-label { font-size: 11px; color: #8aa0c2; text-transform: uppercase; letter-spacing: 0.06em; }
  .kpi .kpi-value { font-size: 28px; font-weight: 700; color: #fff; margin-top: 6px; line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .kpi .kpi-hint { font-size: 12px; color: #8aa0c2; margin-top: 6px; line-height: 1.4; }

  .stats-section { margin-top: 24px; }
  .stats-section-title { font-size: 11px; color: #8aa0c2; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; }

  .stats-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .stats-table th, .stats-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #233454; }
  .stats-table th { font-size: 11px; color: #8aa0c2; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
  .stats-table th.num, .stats-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .stats-table th.ts,  .stats-table td.ts  { text-align: left;  font-variant-numeric: tabular-nums; }
  .stats-table td.muted.note { text-align: right; }
  .stats-table .muted { color: #8aa0c2; font-style: italic; }

  .stats-chart-wrap { background: #0d1830; border-radius: 6px; padding: 10px 12px; }
  .stats-chart-wrap svg { display: block; width: 100%; height: auto; }

  .stats-activity { display: flex; flex-direction: column; gap: 4px; }
  .stats-activity .act { display: grid; grid-template-columns: 110px 160px 1fr; gap: 12px; padding: 8px 10px; background: #16233c; border-radius: 6px; font-size: 13px; align-items: center; }
  .stats-activity .act .at { color: #8aa0c2; font-size: 12px; font-variant-numeric: tabular-nums; }
  .stats-activity .act .svc { color: #4ecca3; font-weight: 500; }
  .stats-activity .act .title { color: #e0e0e0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stats-activity .act .title a,
  .stats-activity .act .title a:hover,
  .stats-activity .act .title a:visited,
  .stats-activity .act .title a:active { color: inherit; text-decoration: none; }
  .stats-empty { color: #8aa0c2; font-style: italic; padding: 20px; text-align: center; background: #16233c; border-radius: 6px; }

  .sched-row { display: flex; gap: 24px; margin-bottom: 22px; align-items: baseline; }
  .sched-label { font-size: 11px; color: #8aa0c2; text-transform: uppercase; letter-spacing: 0.06em; min-width: 110px; flex-shrink: 0; padding-top: 4px; }
  .sched-value { font-size: 15px; color: #e0e0e0; line-height: 1.5; }
  .sched-value.big { font-size: 26px; font-weight: 600; color: #fff; display: block; margin-bottom: 2px; }
  .sched-value.muted { color: #8aa0c2; font-style: italic; }
  .sched-count { font-size: 13px; color: #4ecca3; }
  .sched-note { margin-top: 28px; padding-top: 16px; border-top: 1px solid #233454; color: #8aa0c2; font-size: 13px; line-height: 1.6; }

  .logs-header { padding: 10px 20px; border-bottom: 1px solid #0f3460; font-size: 13px; color: #8aa0c2; flex-shrink: 0; display: flex; align-items: center; gap: 12px; }
  .logs-header .logs-count { margin-left: auto; font-size: 12px; }
  .logs-body { flex: 1; background: #0d0d1a; font-family: 'Menlo', 'Consolas', monospace; font-size: 13px; padding: 12px 16px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
  .logs-body .line { padding: 1px 0; }
  .logs-body .line.stderr { color: #e94560; }
  .logs-body .line.stdout { color: #c0c0d0; }
  .logs-body .line.system { color: #f0c040; font-weight: 600; }
  .logs-body .time { color: #555; margin-right: 8px; }
  .logs-empty { color: #8aa0c2; font-style: italic; padding: 40px; text-align: center; }

  .steps { display: flex; gap: 4px; align-items: center; font-size: 12px; color: #888; margin-bottom: 10px; flex-wrap: wrap; }
  .step { padding: 4px 10px; border-radius: 12px; background: #0f3460; white-space: nowrap; }
  .step.active { background: #e94560; color: white; }
  .step.done { background: #4ecca3; color: #1a1a2e; }
  .step.waiting { background: #2a2a4e; color: #f0c040; }
  .step-arrow { color: #555; }

  .status-strip { display: none; align-items: center; gap: 10px; padding: 6px 12px; font-size: 13px; line-height: 1.35; border-radius: 6px; margin-bottom: 8px; }
  .status-strip.ok   { background: #0e2a1f; color: #4ecca3; }
  .status-strip.warn { background: #2a2a1e; color: #f0c040; }
  .status-strip.err  { background: #2a1a1e; color: #e94560; }
  .status-strip.info { background: #12203a; color: #a0b4d4; }
  .status-strip .strip-primary   { font-weight: 500; }
  .status-strip .strip-secondary { margin-left: auto; opacity: 0.72; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .site-cards { display: grid; grid-template-columns: repeat(1, 1fr); gap: 10px; }
  @media (min-width: 640px)  { .site-cards { grid-template-columns: repeat(2, 1fr); } }
  @media (min-width: 960px)  { .site-cards { grid-template-columns: repeat(3, 1fr); } }
  @media (min-width: 1400px) { .site-cards { grid-template-columns: repeat(4, 1fr); } }
  .site-card { background: #0f3460; border-radius: 8px; padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; min-height: 110px; }
  .site-card-header { display: flex; align-items: center; gap: 8px; }
  .site-card .name { font-weight: 600; font-size: 14px; }
  .site-card .status { font-size: 12px; color: #888; flex: 1; }
  .site-card .status.logged-in { color: #4ecca3; }
  .site-card .status.not-logged-in { color: #e94560; }
  .site-card .status.checking { color: #f0c040; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .dot.unknown { background: #555; }
  .dot.logged-in { background: #4ecca3; }
  .dot.not-logged-in { background: #e94560; }
  .dot.checking { background: #f0c040; animation: pulse 1s infinite; }
  .dot.error { background: #ff6b6b; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .card-actions { display: flex; gap: 6px; margin-left: auto; }
  .site-card .card-actions { margin-left: 0; margin-top: auto; }
  .site-card .card-actions > .btn { flex: 1; padding: 7px 10px; }
  .btn { border: none; border-radius: 6px; padding: 6px 14px; font-size: 13px; cursor: pointer; font-weight: 500; transition: background 0.2s, transform 0.1s; }
  .btn:active { transform: scale(0.97); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-login { background: #e94560; color: white; }
  .btn-login:hover:not(:disabled) { background: #d63851; }
  .btn-check { background: #3a3a5c; color: #ccc; }
  .btn-check:hover:not(:disabled) { background: #4a4a6c; }
  .btn-check-all { background: #3a3a5c; color: #ccc; }
  .btn-check-all:hover:not(:disabled) { background: #4a4a6c; }
  .btn-run { background: #4ecca3; color: #1a1a2e; font-weight: 600; }
  .btn-run:hover:not(:disabled) { background: #3dbb92; }
  .btn-stop { background: #e94560; color: white; }
  .btn-stop:hover:not(:disabled) { background: #d63851; }
  .btn-verify { background: #4ecca3; color: #1a1a2e; font-weight: 600; }
  .btn-verify:hover:not(:disabled) { background: #3dbb92; }
  .btn-cancel { background: #555; color: #ccc; }
  .btn-cancel:hover:not(:disabled) { background: #666; }

  .active-session { background: #1a3a2e; border: 1px solid #4ecca3; border-radius: 8px; padding: 10px 16px; display: flex; align-items: center; gap: 12px; margin-top: 10px; }
  .active-session .label { color: #4ecca3; font-weight: 600; font-size: 14px; }
  .active-session .site-name { color: #fff; font-size: 14px; }

  .main-area { flex: 1; position: relative; display: flex; flex-direction: column; }
  .vnc-container { flex: 1; position: relative; }
  .vnc-container iframe { width: 100%; height: 100%; border: none; }
  .vnc-placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: #888; font-size: 15px; text-align: center; padding: 40px; line-height: 1.8; }
  .vnc-placeholder b { color: #e94560; }
  .vnc-placeholder .highlight { color: #4ecca3; }

  .run-log { flex: 1; background: #0d0d1a; font-family: 'Menlo', 'Consolas', monospace; font-size: 13px; padding: 12px 16px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
  .run-log .line { padding: 1px 0; }
  .run-log .line.stderr { color: #e94560; }
  .run-log .line.stdout { color: #c0c0d0; }
  .run-log .line.system { color: #f0c040; font-weight: 600; }
  .run-log .time { color: #555; margin-right: 8px; }

  .toast { position: fixed; bottom: 20px; right: 20px; background: #16213e; border: 1px solid #0f3460; border-radius: 8px; padding: 12px 20px; font-size: 14px; z-index: 100; animation: slideIn 0.3s ease; max-width: 400px; }
  .toast.success { border-color: #4ecca3; }
  .toast.error { border-color: #e94560; }
  .toast.info { border-color: #f0c040; }
  @keyframes slideIn { from { transform: translateX(100px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }

  /* Tablet (iPad): header-top wraps, step chips stay on their own row */
  @media (max-width: 900px) {
    .header-top { flex-wrap: wrap; row-gap: 8px; }
    .header-actions { margin-left: auto; }
  }

  /* Landscape tablet / large phone */
  @media (max-width: 700px) {
    .header h1 { font-size: 16px; }
    .btn { padding: 6px 10px; font-size: 12px; }
  }

  /* Phone portrait */
  @media (max-width: 480px) {
    .header { padding: 10px 14px; }
    .active-session { flex-wrap: wrap; }
    .active-session .card-actions { width: 100%; justify-content: flex-end; }
  }
</style>
</head>
<body data-tab="sessions">
<div class="header">
  <div class="header-top">
    <h1>Free Games Claimer</h1>
    <nav class="tab-nav">
      <button class="tab active" data-tab="sessions" onclick="switchTab('sessions')">Sessions</button>
      <button class="tab" data-tab="stats" onclick="switchTab('stats')">Stats</button>
      <button class="tab" data-tab="schedule" onclick="switchTab('schedule')">Schedule</button>
      <button class="tab" data-tab="logs" onclick="switchTab('logs')">Logs</button>
    </nav>
    <div class="header-actions">
      <button class="btn btn-check-all sessions-only" onclick="checkAll()" id="btnCheckAll">Check All Sessions</button>
      <button class="btn btn-run" onclick="runAll()" id="btnRunAll">Run Now</button>
    </div>
  </div>
  <div class="steps sessions-only" id="steps"></div>
  <div class="status-strip sessions-only" id="statusStrip"></div>
  <div class="site-cards sessions-only" id="siteCards"></div>
  <div class="sessions-only" id="batchRedeemInfo" style="display:none; margin-top: 10px;"></div>
  <div class="sessions-only" id="activeSession" style="display:none"></div>
</div>
<div class="main-area" id="mainArea">
  <div class="tab-panel" data-panel="sessions">
    <div class="vnc-container" id="vncContainer">
      <div class="vnc-placeholder" id="vncPlaceholder">
        <div>
          <div style="font-size: 20px; margin-bottom: 16px; color: #e94560; font-weight: 600;">How to set up your login sessions</div>
          <div style="text-align: left; max-width: 520px; margin: 0 auto;">
            <b>Step 1:</b> Click <b>Check All Sessions</b> above to see which sites need login.<br><br>
            <b>Step 2:</b> For each site showing <span style="color: #e94560;">red</span>, click its <b>Login</b> button.<br>
            &nbsp;&nbsp;&nbsp;&nbsp;A browser will appear here. Log in manually (handle captchas, MFA, etc.).<br>
            &nbsp;&nbsp;&nbsp;&nbsp;When done, click <span class="highlight">"I\'m Logged In"</span> to verify and save the session.<br><br>
            <b>Step 3:</b> Once all sites show <span class="highlight">green</span>, click <b>Run Now</b> to verify claiming works.<br><br>
            <b>Step 4:</b> You're done — the scheduler (if <span style="color: #f0c040;">LOOP</span> is set) runs claims automatically. Come back to this panel when a session expires.
          </div>
        </div>
      </div>
    </div>
  </div>
  <div class="tab-panel" data-panel="stats">
    <div class="stats-kpis" id="statsKpis"></div>
    <div class="stats-section">
      <div class="stats-section-title">Per service</div>
      <table class="stats-table" id="statsTable"></table>
    </div>
    <div class="stats-section">
      <div class="stats-section-title" id="chartSectionTitle">Claims over the last 30 days</div>
      <div class="stats-chart-wrap" id="chartArea"></div>
    </div>
    <div class="stats-section">
      <div class="stats-section-title">Recent claims</div>
      <div class="stats-activity" id="statsActivity"></div>
    </div>
  </div>
  <div class="tab-panel" data-panel="schedule">
    <div id="schedView"></div>
  </div>
  <div class="tab-panel" data-panel="logs">
    <div class="logs-header">
      <span>Run output from claim scripts</span>
      <span class="logs-count" id="logsCount"></span>
    </div>
    <div class="logs-body" id="logsBody">
      <div class="logs-empty">No run activity yet. The log will populate during a manual Run Now or scheduled run.</div>
    </div>
  </div>
</div>
<script>
const NOVNC_PORT = ${NOVNC_PORT};
const BASE_PATH = '${BASE_PATH}';
let state = { sites: [], activeBrowser: null, allLoggedIn: false, runStatus: 'idle' };
let busy = false;
let showingLog = false;
let logOffset = 0;
let logPollTimer = null;
let pendingGogCount = 0;

// Snapshot the initial setup-instructions HTML so render() can restore it
// after swapping in the shorter "all sessions verified" message.
const DEFAULT_PLACEHOLDER_HTML = document.getElementById('vncPlaceholder')?.innerHTML || '';

function switchTab(tab) {
  document.body.dataset.tab = tab;
  document.querySelectorAll('.tab-nav .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  if (tab === 'logs') startLogsTabPoll();
  else stopLogsTabPoll();
  if (tab === 'schedule') renderScheduleTab();
  if (tab === 'stats') renderStatsTab();
}

function relativeTime(dtStr) {
  if (!dtStr) return '';
  const d = new Date(String(dtStr).replace(' ', 'T'));
  if (!Number.isFinite(d.getTime())) return dtStr;
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const mins = Math.floor(abs / 60000);
  if (mins < 1) return 'just now';
  const prefix = diff < 0 ? 'in ' : '';
  const suffix = diff < 0 ? ''   : ' ago';
  if (mins < 60) {
    if (prefix && mins >= 2) {
      // "in 1h 15m" reads better than "in 75m" — combine hours + minutes for near-future.
      return prefix + mins + 'm' + suffix;
    }
    return prefix + mins + 'm' + suffix;
  }
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    if (prefix) {
      const rem = mins - hrs * 60;
      return prefix + hrs + 'h' + (rem ? ' ' + rem + 'm' : '') + suffix;
    }
    return hrs + 'h ago';
  }
  const days = Math.floor(hrs / 24);
  if (days < 30) return prefix + days + 'd' + suffix;
  const months = Math.floor(days / 30);
  if (months < 12) return prefix + months + 'mo' + suffix;
  return prefix + Math.floor(months / 12) + 'y' + suffix;
}

// Unified timestamp formatter.
//   style 'relative' → "2d ago" (via relativeTime)
//   style 'short'    → "YYYY-MM-DD HH:MM" (trims seconds + milliseconds)
// Any unparseable input is returned verbatim.
function formatTimestamp(ts, style) {
  if (!ts) return '';
  if (style === 'relative') return relativeTime(ts);
  const s = String(ts).replace('T', ' ');
  const m = s.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
  return m ? m[1] : s;
}

// SVG 30-day bar chart with a y-axis scale, horizontal gridlines, and weekly
// x-axis labels. Returns an SVG string ready to drop into a container. Uses
// plain string concatenation — inner backtick template literals would close
// the outer PANEL_HTML template literal and break parsing.
function renderDailyChart(daily) {
  if (!daily.length) return '<div class="stats-empty">No data yet.</div>';
  const W = 600, H = 180;
  const padL = 28, padR = 8, padT = 10, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const rawMax = Math.max.apply(null, daily.map(d => d.count).concat(0));
  const step = rawMax <= 4 ? 1 : rawMax <= 10 ? 2 : rawMax <= 20 ? 5 : rawMax <= 50 ? 10 : 20;
  const yMax = Math.max(step, Math.ceil(rawMax / step) * step);
  const barW = plotW / daily.length;
  const grid = [];
  for (let v = 0; v <= yMax; v += step) {
    const y = padT + plotH - (v / yMax) * plotH;
    grid.push('<line x1="' + padL + '" x2="' + (padL + plotW) + '" y1="' + y + '" y2="' + y + '" stroke="#233454" stroke-width="0.6"/>');
    grid.push('<text x="' + (padL - 6) + '" y="' + (y + 3) + '" fill="#8aa0c2" font-size="10" text-anchor="end">' + v + '</text>');
  }
  const bars = daily.map((d, i) => {
    const h = (d.count / yMax) * plotH;
    const x = padL + i * barW + 0.5;
    const w = Math.max(barW - 1, 1);
    const y = padT + plotH - h;
    const fill = d.count === 0 ? '#4a5a8a' : '#4ecca3';
    const minH = 2;
    const barY = d.count === 0 ? padT + plotH - minH : y;
    const barH = d.count === 0 ? minH : Math.max(h, 1);
    return '<rect x="' + x + '" y="' + barY + '" width="' + w + '" height="' + barH + '" fill="' + fill + '" rx="1"><title>' + d.date + ': ' + d.count + '</title></rect>';
  }).join('');
  // Weekly ticks anchored at the right edge (today), walking backwards
  // every 7 days. Avoids crowding the last tick against its neighbour and
  // gives clear 1-week buckets.
  const labelIdx = new Set();
  for (let i = daily.length - 1; i >= 0; i -= 7) labelIdx.add(i);
  const xLabels = Array.from(labelIdx).sort((a, b) => a - b).map(i => {
    const x = padL + i * barW + barW / 2;
    const md = daily[i].date.slice(5);
    return '<text x="' + x + '" y="' + (H - 8) + '" fill="#8aa0c2" font-size="10" text-anchor="middle">' + md + '</text>';
  }).join('');
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="height:180px">' + grid.join('') + bars + xLabels + '</svg>';
}

async function renderStatsTab() {
  const kpis = document.getElementById('statsKpis');
  const table = document.getElementById('statsTable');
  const chartArea = document.getElementById('chartArea');
  const chartSectionTitle = document.getElementById('chartSectionTitle');
  const activity = document.getElementById('statsActivity');
  if (!kpis) return;
  try {
    const [summary, byService, daily, recent] = await Promise.all([
      api('GET', '/stats/summary'),
      api('GET', '/stats/by-service'),
      api('GET', '/stats/daily?days=30'),
      api('GET', '/activity?limit=10'),
    ]);
    const fmt = n => (n == null ? '—' : new Intl.NumberFormat().format(n));
    const msPending = summary.msPointsBalance == null;
    const tiles = [
      { label: 'Games this week',  value: fmt(summary.gamesThisWeek) },
      { label: 'Games this month', value: fmt(summary.gamesThisMonth) },
      { label: 'Games all-time',   value: fmt(summary.gamesAllTime) },
      { label: 'Last claim',
        value: summary.lastClaim ? formatTimestamp(summary.lastClaim.at, 'relative') : '—',
        hint:  summary.lastClaim ? summary.lastClaim.serviceName + ' · ' + summary.lastClaim.title : '' },
      { label: 'MS Rewards balance',
        value: msPending ? 'Pending' : fmt(summary.msPointsBalance),
        hint:  msPending ? 'captured on next microsoft run' : 'as of ' + formatTimestamp(summary.msPointsBalanceAt, 'short') },
      { label: 'MS points this week',
        value: msPending ? 'Pending' : fmt(summary.msPointsThisWeek),
        hint:  msPending ? 'captured on next microsoft run' : 'via captured runs' },
    ];
    kpis.innerHTML = tiles.map(k =>
      '<div class="kpi"><div class="kpi-label">' + k.label + '</div>' +
      '<div class="kpi-value">' + escapeHtml(String(k.value)) + '</div>' +
      (k.hint ? '<div class="kpi-hint">' + escapeHtml(k.hint) + '</div>' : '') +
      '</div>'
    ).join('');

    const fmt2 = n => new Intl.NumberFormat().format(n);
    const rows = byService.map(r => {
      const last = r.lastClaimAt
        ? '<span title="' + escapeHtml(r.lastClaimAt) + '">' + escapeHtml(formatTimestamp(r.lastClaimAt, 'relative')) + '</span>'
        : '<span class="muted">—</span>';
      const isPts = r.unit === 'points';
      if (isPts && !r.lastClaimAt) {
        return '<tr><td>' + escapeHtml(r.name) + '</td>' +
          '<td colspan="4" class="muted note">points-based — balance appears after the next microsoft run</td></tr>';
      }
      const suffix = isPts ? ' pts' : '';
      return '<tr><td>' + escapeHtml(r.name) + '</td>' +
        '<td class="num">' + fmt2(r.thisWeek) + suffix + '</td>' +
        '<td class="num">' + fmt2(r.thisMonth) + suffix + '</td>' +
        '<td class="num">' + fmt2(r.allTime) + suffix + '</td>' +
        '<td class="ts">' + last + '</td></tr>';
    }).join('');
    table.innerHTML = '<thead><tr>' +
      '<th>Service</th>' +
      '<th class="num">This week</th>' +
      '<th class="num">This month</th>' +
      '<th class="num">All-time</th>' +
      '<th class="ts">Last claim</th>' +
      '</tr></thead><tbody>' + rows + '</tbody>';

    const totalInRange = daily.reduce((s, d) => s + d.count, 0);
    chartSectionTitle.textContent = 'Claims over the last 30 days · ' + totalInRange + ' total';
    chartArea.innerHTML = renderDailyChart(daily);

    if (!recent || !recent.length) {
      activity.innerHTML = '<div class="stats-empty">No claims recorded yet. The activity log will populate after your first successful claim run.</div>';
    } else {
      activity.innerHTML = recent.map(a => {
        const titleHtml = a.url
          ? '<a href="' + encodeURI(a.url) + '" target="_blank" rel="noopener">' + escapeHtml(a.title) + '</a>'
          : escapeHtml(a.title);
        return '<div class="act">' +
          '<span class="at" title="' + escapeHtml(a.at) + '">' + escapeHtml(formatTimestamp(a.at, 'relative')) + '</span>' +
          '<span class="svc">' + escapeHtml(a.serviceName) + '</span>' +
          '<span class="title">' + titleHtml + '</span>' +
          '</div>';
      }).join('');
    }
  } catch (e) {
    kpis.innerHTML = '<div style="color:#e94560;padding:20px;background:#2a1a1e;border-radius:6px">Failed to load stats: ' + escapeHtml((e && e.message) || 'unknown error') + '</div>';
  }
}

function renderScheduleTab() {
  const view = document.getElementById('schedView');
  if (!view) return;
  const parts = [];
  if (state.nextScheduledRun) {
    parts.push(
      '<div class="sched-row">' +
        '<div class="sched-label">Next run</div>' +
        '<div><span class="sched-value big" title="' + state.nextScheduledRun + '">' + formatTimestamp(state.nextScheduledRun, 'short') + '</span>' +
        '<span class="sched-count" id="schedCountdown"></span></div>' +
      '</div>'
    );
  } else {
    const txt = state.loopEnabled ? 'Calculating…' : 'Scheduler disabled';
    parts.push('<div class="sched-row"><div class="sched-label">Next run</div><div class="sched-value muted">' + txt + '</div></div>');
  }
  let intervalText;
  if (state.msScheduleHours > 0) {
    const start = state.msScheduleStart != null ? state.msScheduleStart : 8;
    intervalText = 'Daily, anchored to MS window start ' + String(start).padStart(2, '0') + ':00 local time';
  } else if (state.loopSeconds > 0) {
    const hrs = state.loopSeconds / 3600;
    if (hrs >= 1 && Number.isInteger(hrs)) intervalText = 'Every ' + hrs + ' hour' + (hrs === 1 ? '' : 's');
    else if (state.loopSeconds >= 60) intervalText = 'Every ' + Math.round(state.loopSeconds / 60) + ' minutes';
    else intervalText = 'Every ' + state.loopSeconds + ' seconds';
  } else {
    intervalText = 'Not scheduled — set LOOP or MS_SCHEDULE_HOURS to enable';
  }
  parts.push('<div class="sched-row"><div class="sched-label">Interval</div><div class="sched-value">' + intervalText + '</div></div>');
  if (state.lastRun) {
    const dur = state.lastRun.durationSec != null ? Math.round(state.lastRun.durationSec / 60) + 'm' : '';
    const statusCol = state.lastRun.status === 'success' ? '#4ecca3' : state.lastRun.status === 'error' ? '#e94560' : '#f0c040';
    parts.push(
      '<div class="sched-row"><div class="sched-label">Last run</div>' +
      '<div class="sched-value"><span title="' + state.lastRun.at + '">' + formatTimestamp(state.lastRun.at, 'short') + '</span>' +
        ' (' + state.lastRun.source + ') — ' +
        '<span style="color:' + statusCol + '">' + state.lastRun.status + '</span>' +
        (dur ? ' · ' + dur : '') +
      '</div></div>'
    );
  } else {
    parts.push('<div class="sched-row"><div class="sched-label">Last run</div><div class="sched-value muted">None yet</div></div>');
  }
  parts.push('<div class="sched-note">Pause/resume toggle and per-run history are on the way. Trigger an immediate claim from the Sessions tab via <b>Run Now</b>.</div>');
  view.innerHTML = parts.join('');
  updateScheduleCountdown();
}

function updateScheduleCountdown() {
  const el = document.getElementById('schedCountdown');
  if (!el || !state.nextScheduledRun) return;
  const target = new Date(state.nextScheduledRun.replace(' ', 'T')).getTime();
  if (!Number.isFinite(target)) return;
  const delta = target - Date.now();
  if (delta <= 0) { el.textContent = ' · due now'; return; }
  const mins = Math.floor(delta / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  let txt;
  if (days > 0) txt = 'in ' + days + 'd ' + (hrs % 24) + 'h';
  else if (hrs > 0) txt = 'in ' + hrs + 'h ' + (mins % 60) + 'm';
  else txt = 'in ' + Math.max(mins, 1) + 'm';
  el.textContent = ' · ' + txt;
}
setInterval(updateScheduleCountdown, 30000);

let logsTabOffset = 0;
let logsTabPollTimer = null;
function startLogsTabPoll() {
  if (logsTabPollTimer) return;
  logsTabOffset = 0;
  const body = document.getElementById('logsBody');
  if (body) body.innerHTML = '<div class="logs-empty">Loading…</div>';
  pollLogsTab();
}
function stopLogsTabPoll() {
  if (logsTabPollTimer) { clearTimeout(logsTabPollTimer); logsTabPollTimer = null; }
}
async function pollLogsTab() {
  if (document.body.dataset.tab !== 'logs') { stopLogsTabPoll(); return; }
  let interval = 3000;
  try {
    const r = await api('GET', '/run-log?since=' + logsTabOffset);
    const body = document.getElementById('logsBody');
    const count = document.getElementById('logsCount');
    if (body && r.lines && r.lines.length) {
      if (logsTabOffset === 0) body.innerHTML = '';
      r.lines.forEach(l => {
        const div = document.createElement('div');
        div.className = 'line ' + l.type;
        const t = (l.time && l.time.split(' ')[1]) || '';
        div.innerHTML = '<span class="time">' + t + '</span>' + escapeHtml(l.text);
        body.appendChild(div);
      });
      body.scrollTop = body.scrollHeight;
    } else if (body && logsTabOffset === 0 && (!r.lines || !r.lines.length)) {
      body.innerHTML = '<div class="logs-empty">No run activity yet. The log will populate during a manual Run Now or scheduled run.</div>';
    }
    if (typeof r.total === 'number') logsTabOffset = r.total;
    if (count) count.textContent = logsTabOffset + ' line' + (logsTabOffset === 1 ? '' : 's');
    if (r && r.status === 'running') interval = 1000;
  } catch {}
  logsTabPollTimer = setTimeout(pollLogsTab, interval);
}

async function refreshPendingGogCount() {
  try {
    const r = await api('GET', '/pending-gog-count');
    pendingGogCount = r.count || 0;
  } catch { pendingGogCount = 0; }
}

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE_PATH + '/api' + path, opts);
  return res.json();
}

function showToast(message, type = 'info', duration = 4000) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

function getStep() {
  const anyChecked = state.sites.some(s => s.status !== 'unknown');
  if (!anyChecked) return 1;
  if (!state.allLoggedIn) return 2;
  if (state.runStatus === 'running') return 3;
  if (state.lastRun) return 4;
  // Logged in, no run yet. If scheduler is enabled the scheduler will handle
  // it — return 'waiting' so the step shows subtle yellow instead of active
  // red (which would imply the user needs to act).
  return state.loopEnabled ? 'waiting' : 3;
}

function render() {
  const cards = document.getElementById('siteCards');
  const session = document.getElementById('activeSession');
  const strip = document.getElementById('statusStrip');
  const steps = document.getElementById('steps');
  const batchInfo = document.getElementById('batchRedeemInfo');
  const btnRunAll = document.getElementById('btnRunAll');
  const btnCheckAll = document.getElementById('btnCheckAll');
  const currentStep = getStep();

  if (document.body.dataset.tab === 'schedule') renderScheduleTab();

  // Batch-redeem panel: shows when there are pending GOG codes OR a batch is active.
  const br = state.batchRedeem;
  if (br) {
    batchInfo.style.display = 'block';
    const s = br.stats || {};
    const progressBar = '<span style="color:#888">' + br.index + ' / ' + br.total + ' codes</span>';
    const statsLine = [s.redeemed + ' redeemed', s.used + ' already', s.notFound + ' invalid', s.timeouts ? s.timeouts + ' timeouts' : null, s.errors ? s.errors + ' errors' : null].filter(Boolean).join(', ');
    const bgColor = br.phase === 'awaiting-captcha' ? '#3a1a1e' : br.phase === 'done' ? '#1a3a2e' : br.phase === 'stopped' || br.phase === 'error' ? '#3a2a1e' : '#0f3460';
    const borderColor = br.phase === 'awaiting-captcha' ? '#e94560' : br.phase === 'done' ? '#4ecca3' : '#555';
    let buttonsHtml = '';
    if (br.phase === 'running' || br.phase === 'awaiting-captcha') {
      buttonsHtml = '<button class="btn btn-stop" onclick="stopBatchRedeem()">Stop</button>';
    } else {
      buttonsHtml = '<button class="btn btn-cancel" onclick="clearBatchRedeem()">Dismiss</button>';
    }
    batchInfo.innerHTML =
      '<div style="background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
      '  <div style="flex:1;min-width:240px">' +
      '    <div style="font-weight:600;margin-bottom:2px">Batch redeem — ' + br.phase + '</div>' +
      '    <div style="font-size:13px;margin-bottom:4px">' + br.message + '</div>' +
      '    <div style="font-size:12px;color:#888">' + progressBar + ' · ' + (statsLine || 'no results yet') + '</div>' +
      '  </div>' +
      '  <div>' + buttonsHtml + '</div>' +
      '</div>';
  } else if (pendingGogCount > 0) {
    batchInfo.style.display = 'block';
    batchInfo.innerHTML =
      '<div style="background:#0f3460;border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:12px">' +
      '  <div style="flex:1"><b>' + pendingGogCount + ' pending GOG code' + (pendingGogCount === 1 ? '' : 's') + '</b> — solve captcha once, remaining auto-process</div>' +
      '  <button class="btn btn-run" onclick="startBatchRedeem()">Batch Redeem</button>' +
      '</div>';
  } else {
    batchInfo.style.display = 'none';
  }

  const stepLabels = ['Check sessions', 'Log in to sites', 'First run', 'Done!'];
  steps.innerHTML = stepLabels.map((label, i) => {
    const num = i + 1;
    let cls = 'step';
    if (currentStep === 'waiting') {
      if (num <= 2) cls += ' done';
      else if (num === 3) cls += ' waiting';
    } else {
      if (num < currentStep) cls += ' done';
      else if (num === currentStep) cls += ' active';
    }
    if (num === 4 && state.allLoggedIn && state.lastRun) cls += ' done';
    return (i > 0 ? '<span class="step-arrow">&rarr;</span>' : '') + '<span class="' + cls + '">' + num + '. ' + label + '</span>';
  }).join('');

  // Once all sessions are OK the stepper is no longer actionable — the strip
  // below communicates current state more compactly. Also hide stepper + cards
  // during an active login so the VNC iframe has more room.
  steps.style.display = (state.allLoggedIn || state.activeBrowser) ? 'none' : 'flex';
  cards.style.display = state.activeBrowser ? 'none' : 'grid';

  const isRunning = state.runStatus === 'running';
  const disabled = busy || !!state.activeBrowser || isRunning;
  btnCheckAll.disabled = disabled;
  btnRunAll.disabled = disabled && !isRunning;

  if (isRunning) {
    btnRunAll.textContent = 'Stop Scripts';
    btnRunAll.className = 'btn btn-stop';
    btnRunAll.disabled = false;
    btnRunAll.onclick = stopRun;
  } else {
    btnRunAll.textContent = 'Run Now';
    btnRunAll.className = 'btn btn-run';
    btnRunAll.onclick = runAll;
  }

  // Placeholder: swap between first-time setup instructions and a shorter
  // "ready" message when all sessions are logged in. Leaving the main area
  // empty was confusing — there's no banner anymore, and the VNC iframe only
  // appears during active login or claim runs.
  const placeholder = document.getElementById('vncPlaceholder');
  if (placeholder && !state.activeBrowser && !state.batchRedeem && !showingLog) {
    placeholder.style.display = 'flex';
    const setupDone = state.allLoggedIn && state.sites.length > 0;
    if (setupDone) {
      // Status strip in the header already communicates "all sessions OK" —
      // don't repeat it here. Just explain what this empty space is for.
      placeholder.innerHTML =
        '<div style="max-width:520px;font-size:14px;line-height:1.7;color:#a0b4d4">' +
        '  Click <b style="color:#e0e0e0">Run Now</b> to trigger an immediate claim, or let the scheduler (if enabled) handle it.<br><br>' +
        '  The browser login view will appear here when you click <b style="color:#e0e0e0">Login</b> on any session card;' +
        '  the claim log appears here during a run.' +
        '</div>';
    } else {
      placeholder.innerHTML = DEFAULT_PLACEHOLDER_HTML;
    }
  }

  // Status strip — one line that rolls up the old green banner + "Next run" line.
  const totalCount = state.sites.length;
  const secondaryParts = [];
  if (!isRunning && state.nextScheduledRun) secondaryParts.push('Next run ' + formatTimestamp(state.nextScheduledRun, 'relative'));
  if (state.lastRun) {
    const dur = state.lastRun.durationSec != null ? Math.round(state.lastRun.durationSec / 60) + 'm' : '';
    secondaryParts.push('Last run ' + formatTimestamp(state.lastRun.at, 'relative') + ' (' + state.lastRun.status + (dur ? ', ' + dur : '') + ')');
  }
  let stripSecondary = secondaryParts.join(' · ');
  let stripKind = 'info';
  let stripText = null;
  if (state.startupAutoCheck) {
    stripKind = 'warn';
    stripText = '⏳ Startup: checking sessions (' + state.startupAutoCheck.current + '/' + state.startupAutoCheck.total + ') — ' + state.startupAutoCheck.siteName + '…';
    stripSecondary = '';
  } else if (state.activeBrowser) {
    stripText = null; // activeSession row owns this state
  } else if (isRunning) {
    stripKind = 'warn';
    const src = state.runSource === 'scheduler' ? 'scheduler' : 'manual';
    stripText = '● Run in progress (' + src + ')…';
  } else if (state.sites.some(s => s.status === 'not_logged_in')) {
    stripKind = 'err';
    const missing = state.sites.filter(s => s.status === 'not_logged_in').map(s => s.name).join(', ');
    stripText = '● Login needed for: ' + missing;
  } else if (state.allLoggedIn && totalCount > 0) {
    const label = totalCount === 1 ? 'session' : 'sessions';
    if (state.runStatus === 'finished') {
      stripKind = 'warn';
      stripText = '● All ' + totalCount + ' ' + label + ' OK · last run had errors — check Logs';
    } else {
      stripKind = 'ok';
      stripText = '● All ' + totalCount + ' ' + label + ' OK';
    }
  } else if (totalCount > 0) {
    stripKind = 'info';
    stripText = 'Click "Check All Sessions" to get started';
  }

  if (stripText) {
    strip.style.display = 'flex';
    strip.className = 'status-strip sessions-only ' + stripKind;
    strip.innerHTML =
      '<span class="strip-primary">' + stripText + '</span>' +
      (stripSecondary ? '<span class="strip-secondary">' + stripSecondary + '</span>' : '');
  } else {
    strip.style.display = 'none';
  }

  cards.innerHTML = state.sites.map(s => {
    const dotClass = s.status === 'logged_in' ? 'logged-in' : s.status === 'not_logged_in' ? 'not-logged-in' : s.status === 'error' ? 'error' : 'unknown';
    const statusClass = dotClass;
    let statusText = 'Not checked';
    if (s.status === 'logged_in') statusText = 'Logged in' + (s.user ? ' as ' + s.user : '');
    else if (s.status === 'not_logged_in') statusText = 'Not logged in';
    else if (s.status === 'error') statusText = 'Error checking';
    if (s.checkedAt) statusText += ' (' + s.checkedAt.split(' ')[1] + ')';
    return '<div class="site-card">' +
      '<div class="site-card-header">' +
        '<div class="dot ' + dotClass + '"></div>' +
        '<div class="name">' + s.name + '</div>' +
      '</div>' +
      '<div class="status ' + statusClass + '">' + statusText + '</div>' +
      '<div class="card-actions">' +
        '<button class="btn btn-login" onclick="launchSite(\\'' + s.id + '\\')" ' + (disabled ? 'disabled' : '') + '>Login</button>' +
        '<button class="btn btn-check" onclick="checkSite(\\'' + s.id + '\\')" ' + (disabled ? 'disabled' : '') + '>Check</button>' +
      '</div>' +
    '</div>';
  }).join('');

  if (state.activeBrowser) {
    session.style.display = 'flex';
    session.innerHTML =
      '<div class="label">Active:</div>' +
      '<div class="site-name">' + state.activeBrowser.name + ' - Complete the login in the browser below, then click "I\\\'m Logged In"</div>' +
      '<div class="card-actions">' +
        '<button class="btn btn-verify" onclick="verifyLogin()" ' + (busy ? 'disabled' : '') + '>I\\'m Logged In</button>' +
        '<button class="btn btn-cancel" onclick="cancelLogin()" ' + (busy ? 'disabled' : '') + '>Cancel</button>' +
      '</div>';
    showVnc();
  } else {
    session.style.display = 'none';
  }
}

function showVnc() {
  hideRunLog();
  const container = document.getElementById('vncContainer');
  const placeholder = document.getElementById('vncPlaceholder');
  if (placeholder) placeholder.style.display = 'none';
  if (!container.querySelector('iframe')) {
    const iframe = document.createElement('iframe');
    // Through a reverse proxy (BASE_PATH set) noVNC is proxied at \${BASE_PATH}/novnc/.
    // We must also tell noVNC where to open its WebSocket — by default it assumes
    // "/websockify" at the origin root, which won't exist when proxied at a subfolder.
    // For direct access (no BASE_PATH) the container's noVNC port is reachable at the same host.
    if (BASE_PATH) {
      const wsPath = BASE_PATH.replace(/^\\//, '') + '/novnc/websockify';
      iframe.src = BASE_PATH + '/novnc/vnc.html?autoconnect=true&resize=scale&path=' + encodeURIComponent(wsPath);
    } else {
      iframe.src = location.protocol + '//' + location.hostname + ':' + NOVNC_PORT + '/vnc.html?autoconnect=true&resize=scale';
    }
    container.appendChild(iframe);
  }
}

function hideVnc() {
  const container = document.getElementById('vncContainer');
  const iframe = container.querySelector('iframe');
  if (iframe) iframe.remove();
  const placeholder = document.getElementById('vncPlaceholder');
  if (placeholder) placeholder.style.display = 'flex';
}

function showRunLog() {
  showingLog = true;
  const container = document.getElementById('vncContainer');
  const placeholder = document.getElementById('vncPlaceholder');
  if (placeholder) placeholder.style.display = 'none';
  const iframe = container.querySelector('iframe');
  if (iframe) iframe.style.display = 'none';
  let logEl = document.getElementById('runLog');
  if (!logEl) {
    logEl = document.createElement('div');
    logEl.id = 'runLog';
    logEl.className = 'run-log';
    container.appendChild(logEl);
  }
  logEl.style.display = 'block';
  pollLog();
}

function hideRunLog() {
  showingLog = false;
  if (logPollTimer) { clearTimeout(logPollTimer); logPollTimer = null; }
  const logEl = document.getElementById('runLog');
  if (logEl) logEl.style.display = 'none';
  const iframe = document.getElementById('vncContainer')?.querySelector('iframe');
  if (iframe) iframe.style.display = 'block';
}

async function pollLog() {
  if (!showingLog) return;
  try {
    const r = await api('GET', '/run-log?since=' + logOffset);
    const logEl = document.getElementById('runLog');
    if (logEl && r.lines.length) {
      r.lines.forEach(l => {
        const div = document.createElement('div');
        div.className = 'line ' + l.type;
        const timeSpan = '<span class="time">' + (l.time?.split(' ')[1] || '') + '</span>';
        div.innerHTML = timeSpan + escapeHtml(l.text);
        logEl.appendChild(div);
      });
      logEl.scrollTop = logEl.scrollHeight;
      logOffset = r.total;
    }
    if (r.status === 'running') {
      logPollTimer = setTimeout(pollLog, 1000);
    } else {
      await refreshState();
    }
  } catch {
    logPollTimer = setTimeout(pollLog, 2000);
  }
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function refreshState() {
  try {
    state = await api('GET', '/state');
    render();
    if (typeof updateBatchPolling === 'function') updateBatchPolling();
  } catch {}
}

async function launchSite(siteId) {
  busy = true; render();
  try {
    const r = await api('POST', '/launch', { site: siteId });
    if (r.success) {
      showToast('Browser launched for ' + r.name + '. Log in now!', 'success');
    } else {
      showToast(r.error || 'Failed to launch browser.', 'error');
    }
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  busy = false;
  await refreshState();
}

async function verifyLogin() {
  busy = true; render();
  try {
    const r = await api('POST', '/verify');
    if (r.loggedIn) {
      showToast('Logged in as ' + r.user + '! Session saved.', 'success');
      hideVnc();
    } else {
      showToast(r.message || 'Login not detected. Keep trying.', 'error');
    }
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  busy = false;
  await refreshState();
}

async function cancelLogin() {
  busy = true; render();
  try {
    await api('POST', '/close');
    showToast('Browser closed.', 'info');
    hideVnc();
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  busy = false;
  await refreshState();
}

async function checkSite(siteId) {
  busy = true; render();
  const siteName = state.sites.find(s => s.id === siteId)?.name || siteId;
  showToast('Checking ' + siteName + '...', 'info', 2000);
  try {
    const r = await api('POST', '/check', { site: siteId });
    if (r.error) showToast(r.error, 'error');
    else if (r.loggedIn) showToast(siteName + ': logged in as ' + r.user, 'success');
    else showToast(siteName + ': not logged in', 'error');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  busy = false;
  await refreshState();
}

async function checkAll() {
  busy = true; render();
  showToast('Checking all sessions...', 'info', 3000);
  try {
    await api('POST', '/check-all');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  busy = false;
  await refreshState();
}

async function runAll() {
  busy = true; render();
  try {
    const r = await api('POST', '/run-all');
    if (r.success) {
      logOffset = 0;
      showRunLog();
      showToast('Scripts started! Watch the output below.', 'success');
    } else {
      showToast(r.error || 'Failed to start scripts.', 'error');
    }
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  busy = false;
  await refreshState();
}

async function stopRun() {
  try {
    await api('POST', '/stop-run');
    showToast('Scripts stopped.', 'info');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  await refreshState();
}

async function startBatchRedeem() {
  busy = true; render();
  try {
    const r = await api('POST', '/batch-redeem/start');
    if (r.success) {
      showToast('Batch redeem started — ' + r.total + ' code(s) queued. Solve captcha in the browser when prompted.', 'success');
      showVnc();
    } else {
      showToast(r.error || 'Failed to start batch redeem.', 'error');
    }
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  busy = false;
  await refreshState();
}

async function stopBatchRedeem() {
  try {
    await api('POST', '/batch-redeem/stop');
    showToast('Batch redeem stopped.', 'info');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  await refreshState();
}

async function clearBatchRedeem() {
  try {
    await api('POST', '/batch-redeem/clear');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  await refreshPendingGogCount();
  await refreshState();
}

// Faster poll when batch-redeem is active so progress updates feel live.
let batchPollTimer = null;
function updateBatchPolling() {
  const active = state.batchRedeem && (state.batchRedeem.phase === 'running' || state.batchRedeem.phase === 'awaiting-captcha');
  if (active && !batchPollTimer) {
    batchPollTimer = setInterval(refreshState, 2000);
    showVnc();
  } else if (!active && batchPollTimer) {
    clearInterval(batchPollTimer);
    batchPollTimer = null;
  }
}

async function handleDeepLink() {
  // Deep-links from Pushover notifications:
  //   ?login=<siteId>  → auto-open the Login flow for that site
  //   ?batch=gog       → auto-start batch redeem for pending GOG codes
  // After triggering, strip the query so a refresh doesn't re-fire.
  const params = new URLSearchParams(location.search);
  const loginSite = params.get('login');
  const batch = params.get('batch');
  if (!loginSite && !batch) return;
  const stripQuery = () => {
    const url = location.pathname + location.hash;
    history.replaceState(null, '', url);
  };
  // Wait for state to have loaded so busy-checks are accurate.
  if (loginSite) {
    if (state.sites.find(s => s.id === loginSite)) {
      showToast('Opening Login flow for ' + loginSite + '…', 'info');
      stripQuery();
      await launchSite(loginSite);
    } else {
      showToast('Unknown site: ' + loginSite, 'error');
      stripQuery();
    }
  } else if (batch === 'gog') {
    if (pendingGogCount > 0 && !state.batchRedeem) {
      showToast('Starting batch redeem…', 'info');
      stripQuery();
      await startBatchRedeem();
    } else if (state.batchRedeem) {
      showToast('Batch redeem already running.', 'info');
      stripQuery();
    } else {
      showToast('No pending GOG codes to redeem.', 'info');
      stripQuery();
    }
  }
}

async function initialLoad() {
  await refreshPendingGogCount();
  await refreshState();
  updateBatchPolling();
  await handleDeepLink();
}
initialLoad();
setInterval(async () => {
  await refreshState();
  if (!state.batchRedeem) await refreshPendingGogCount();
  updateBatchPolling();
}, 10000);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    // Strip BASE_PATH prefix if present so existing route matchers keep working for both
    // direct access (http://host:7080/...) and subfolder-proxied access (https://host/base/...).
    if (BASE_PATH && (req.url === BASE_PATH || req.url.startsWith(BASE_PATH + '/') || req.url.startsWith(BASE_PATH + '?'))) {
      req.url = req.url.slice(BASE_PATH.length) || '/';
    }

    if (req.method === 'POST' && req.url === '/api/auth') {
      const { password } = await parseBody(req);
      if (password === PANEL_PASSWORD) {
        const token = generateToken();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `fgc_token=${token}; Path=/; HttpOnly; SameSite=Strict` });
        res.end(JSON.stringify({ success: true }));
      } else {
        sendJson(res, { success: false }, 401);
      }
      return;
    }

    if (!isAuthenticated(req)) {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(LOGIN_HTML);
        return;
      }
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PANEL_HTML);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/state') {
      sendJson(res, getState());
      return;
    }

    if (req.method === 'POST' && req.url === '/api/launch') {
      const { site } = await parseBody(req);
      if (!site || !SITES[site]) {
        sendJson(res, { success: false, error: 'Invalid site.' }, 400);
        return;
      }
      try {
        const result = await launchSite(site);
        sendJson(res, result);
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/verify') {
      const result = await verifyAndClose();
      sendJson(res, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/close') {
      await closeBrowser();
      sendJson(res, { success: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/check') {
      const { site } = await parseBody(req);
      if (!site || !SITES[site]) {
        sendJson(res, { error: 'Invalid site.' }, 400);
        return;
      }
      const result = await checkSiteStatus(site);
      sendJson(res, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/check-all') {
      const results = await checkAllSites();
      sendJson(res, results);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/run-all') {
      const result = runAllScripts({ source: 'panel' });
      sendJson(res, result);
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/run-log')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const since = parseInt(url.searchParams.get('since') || '0', 10);
      sendJson(res, { lines: runLog.slice(since), total: runLog.length, status: runStatus });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/stats/summary') {
      sendJson(res, await getStatsSummary());
      return;
    }
    if (req.method === 'GET' && req.url === '/api/stats/by-service') {
      sendJson(res, await getStatsByService());
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/stats/daily')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));
      sendJson(res, await getStatsDaily(days));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/activity')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '10', 10)));
      sendJson(res, await getActivity(limit));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/stop-run') {
      if (runProcess) {
        runProcess.kill('SIGTERM');
        runLog.push({ type: 'system', text: 'Scripts stopped by user.', time: datetime() });
        runStatus = 'stopped';
        runProcess = null;
        sendJson(res, { success: true });
      } else {
        sendJson(res, { success: false, error: 'No scripts are running.' });
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/pending-gog-count') {
      const count = await countPendingGogCodes();
      sendJson(res, { count });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/batch-redeem/start') {
      try {
        const result = await startBatchRedeem();
        sendJson(res, result);
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/batch-redeem/stop') {
      const result = await stopBatchRedeem();
      sendJson(res, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/batch-redeem/clear') {
      clearFinishedBatchRedeem();
      sendJson(res, { success: true });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    console.error(`[${datetime()}] Server error:`, e);
    sendJson(res, { error: e.message }, 500);
  }
});

async function gracefulShutdown(sig) {
  console.log(`[${datetime()}] Received ${sig}, shutting down...`);
  if (runProcess) {
    try { runProcess.kill('SIGTERM'); } catch {}
  }
  if (batchRedeem) {
    batchRedeem.phase = 'stopped';
    try { if (batchRedeem.context) await batchRedeem.context.close(); } catch {}
  }
  await closeBrowser();
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.listen(PANEL_PORT, async () => {
  console.log(`[${datetime()}] Free Games Claimer — panel + scheduler`);
  console.log(`[${datetime()}] Control panel: http://localhost:${PANEL_PORT}${BASE_PATH}`);
  if (cfg.public_url) console.log(`[${datetime()}] Public URL:    ${PUBLIC_URL}`);
  console.log(`[${datetime()}] noVNC viewer:  http://localhost:${NOVNC_PORT}${BASE_PATH ? ` (proxied at ${BASE_PATH}/novnc/)` : ''}`);
  console.log(`[${datetime()}] Password protection: ${PANEL_PASSWORD ? 'ENABLED' : 'DISABLED (set PANEL_PASSWORD or VNC_PASSWORD to enable)'}`);
  if (LOOP_SECONDS > 0 || MS_SCHEDULE_HOURS > 0) {
    const desc = MS_SCHEDULE_HOURS > 0 ? `anchored to MS window start ${MS_SCHEDULE_START}:00` : `every ${LOOP_SECONDS}s`;
    console.log(`[${datetime()}] Scheduler: enabled (${desc})`);
  } else {
    console.log(`[${datetime()}] Scheduler: disabled (set LOOP or MS_SCHEDULE_HOURS to enable)`);
  }
  if (cfg.notify && !cfg.public_url) {
    console.log(`[${datetime()}] ⚠  NOTIFY is set but PUBLIC_URL is not — notification tap-targets will point to http://localhost:${PANEL_PORT}${BASE_PATH} which won't work from a mobile device. Set PUBLIC_URL to the externally-reachable panel URL.`);
  }
  console.log(`[${datetime()}] Open the control panel URL in your browser.`);
  console.log(`[${datetime()}] Auto-checking all sessions...`);
  const siteIds = Object.keys(SITES);
  startupAutoCheck = { current: 0, total: siteIds.length, siteName: '' };
  for (const siteId of siteIds) {
    startupAutoCheck.siteName = SITES[siteId].name;
    await checkSiteStatus(siteId);
    startupAutoCheck.current++;
  }
  startupAutoCheck = null;
  console.log(`[${datetime()}] Auto-check complete.`);

  // Kick off the scheduler after session auto-check so first run sees fresh status.
  if (LOOP_SECONDS > 0 || MS_SCHEDULE_HOURS > 0) {
    schedulerLoop().catch(err => {
      console.error(`[${datetime()}] Scheduler crashed:`, err);
    });
  }
});
