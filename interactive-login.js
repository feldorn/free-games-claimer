import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { chromium, devices } from 'patchright';
import { datetime, notify, jsonDb, normalizeTitle } from './src/util.js';
import { cfg } from './src/config.js';
import { describeConfig, patchConfig, describeEnv, getSchedulerConfig, CONFIG_FILE_PATH } from './src/app-config.js';

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
  'aliexpress': {
    name: 'AliExpress',
    // AliExpress's coin collector only works on the mobile site; desktop just
    // says "install the app". Use a dedicated browser profile so its
    // fingerprint-injected session doesn't collide with the desktop services'
    // profiles.
    loginUrl: 'https://m.aliexpress.com/p/coin-index/index.html',
    browserDir: cfg.dir.browser + '-aliexpress',
    contextOptions: devices['Pixel 7'],
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
// Claim script order when running every active service. microsoft.js is last
// because it has an internal wait-until-window that blocks the process; put
// it after everything else so the rest finishes promptly. microsoft.js is
// shared between the 'microsoft' (desktop) and 'microsoft-mobile' site cards
// — invoked once and runs both sessions internally.
const CLAIM_SCRIPT_ORDER = [
  { id: 'gog',              script: 'gog.js' },
  { id: 'prime-gaming',     script: 'prime-gaming.js' },
  { id: 'epic-games',       script: 'epic-games.js' },
  { id: 'steam',            script: 'steam.js' },
  { id: 'aliexpress',       script: 'aliexpress.js' },
  { id: 'microsoft',        script: 'microsoft.js', linkedWith: 'microsoft-mobile' }, // omitted from "manual" runs by default
];

function activeServices() {
  const svc = describeConfig().effective.services || {};
  const isActive = id => {
    const s = svc[id];
    if (s && typeof s.active === 'boolean') return s.active;
    return id !== 'aliexpress'; // defaults: all traditional services active, AliExpress off
  };
  return new Set(Object.keys({
    'prime-gaming': 1, 'epic-games': 1, 'gog': 1, 'steam': 1,
    'microsoft': 1, 'microsoft-mobile': 1, 'aliexpress': 1,
  }).filter(isActive));
}

// Build the shell command for a claim run.
//   opts.manual=true → drop microsoft.js (it has an internal wait-until-window
//                      that a "Run Now" press shouldn't trigger).
//   opts.sites=[...] → explicit list of service IDs to run, bypasses the
//                      active-set filter and the manual=true MS exclusion.
//                      Used by per-card "Run" buttons for single-service
//                      test runs.
// If nothing matches, returns null so the caller can report it.
function buildClaimCommand({ manual = false, sites = null } = {}) {
  const targetSet = sites ? new Set(sites) : activeServices();
  const parts = [];
  for (const entry of CLAIM_SCRIPT_ORDER) {
    if (!sites && manual && entry.id === 'microsoft') continue;
    // microsoft.js covers both desktop + mobile — invoke once if either ID
    // is in the target set.
    const ids = [entry.id].concat(entry.linkedWith ? [entry.linkedWith] : []);
    if (ids.some(id => targetSet.has(id))) parts.push('node ' + entry.script);
  }
  return parts.length ? parts.join('; ') : null;
}

// Env overrides let people keep the original hard-coded pipelines if they
// want (e.g. adding a custom pre/post step). Bypassed when sites is set —
// per-card Run runs exactly the requested service.
function resolveClaimCommand({ manual, sites = null }) {
  if (!sites) {
    const envKey = manual ? 'CLAIM_CMD_MANUAL' : 'CLAIM_CMD';
    if (process.env[envKey]) return process.env[envKey];
  }
  return buildClaimCommand({ manual, sites });
}

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
  const active = activeServices();
  for (const siteId of Object.keys(SITES)) {
    if (!active.has(siteId)) continue; // skip deactivated services
    if (activeBrowser) {
      results[siteId] = { error: 'Browser session active, close it first.' };
      continue;
    }
    results[siteId] = await checkSiteStatus(siteId);
  }
  return results;
}

function runAllScripts({ source = 'panel', sites = null } = {}) {
  const busy = browserBusy();
  if (busy) return { success: false, error: `Cannot start run — ${busy}.` };

  runLog = [];
  runStatus = 'running';
  runSource = sites ? source + ':' + sites.join('+') : source;
  runStartedAt = Date.now();
  const label = sites ? sites.join('+') : 'all';
  console.log(`[${datetime()}] Starting claim scripts (${source}/${label})...`);

  // For scheduled runs, set NOWAIT=1 so scripts exit fast on stale sessions
  // instead of waiting for interactive login. We follow up with a session
  // re-check to notify the user about any sites that now need manual action.
  const childEnv = source === 'scheduler'
    ? { ...process.env, NOWAIT: '1' }
    : { ...process.env };
  // Single-service / explicit Run bypasses the MS internal window so a test
  // click at 3 PM doesn't sleep 17 hours until the 8 AM window opens.
  // Can't just set MS_SCHEDULE_HOURS=0 here — the in-app config layer
  // (data/config.json) overrides env, so if the user has saved a value via
  // Settings the env change is ignored. MS_SKIP_WINDOW is read by
  // microsoft.js directly, outside the cfg-merge path, so it always wins.
  if (sites && (sites.includes('microsoft') || sites.includes('microsoft-mobile'))) {
    childEnv.MS_SKIP_WINDOW = '1';
  }

  // Manual "Run Now" uses the subset without microsoft.js so it actually ends.
  // Both paths build dynamically from the current active-service set so
  // deactivating a site takes effect on the next run without a restart.
  const cmd = resolveClaimCommand({ manual: source !== 'scheduler', sites });
  if (!cmd) {
    console.log(`[${datetime()}] Run (${source}): no matching services — skipping.`);
    runStatus = 'idle';
    return { success: false, error: sites
      ? 'Service "' + sites.join(', ') + '" not recognized or inactive.'
      : 'No active services configured. Enable at least one in Settings → Services.' };
  }

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
// Scheduler constants come from cfg (which merges data/config.json on top of
// env). This way the Settings tab's scheduler section takes effect at the
// next panel restart without rebuilding the container. Changes without a
// restart will land once the Phase 4 fs.watch hot-reload is in place.
const LOOP_SECONDS = cfg.loop;
const MS_SCHEDULE_HOURS = cfg.ms_schedule_hours;
const MS_SCHEDULE_START = cfg.ms_schedule_start;

let nextScheduledRun = null; // Date | null

function computeNextWakeMs() {
  const c = getSchedulerConfig();
  if (c.msHours > 0) {
    const wakeHour = c.msStart > 0 ? c.msStart - 1 : 23;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(wakeHour, 30, 0, 0);
    return Math.max(tomorrow.getTime() - Date.now(), 60 * 1000);
  }
  return c.loop * 1000;
}

// Set by watchConfigForScheduler() on save — lets the scheduler abandon
// its current sleep and recompute with the new interval immediately.
let schedulerWakeup = null;

// Cancellable sleep: resolves normally after ms, or early with 'reload' if
// schedulerWakeup() is invoked (by the config-file watcher).
function sleepUntilWakeup(ms) {
  return new Promise(resolve => {
    const t = setTimeout(() => { schedulerWakeup = null; resolve('tick'); }, ms);
    schedulerWakeup = () => { clearTimeout(t); schedulerWakeup = null; resolve('reload'); };
  });
}

function watchConfigForScheduler() {
  const dir = path.dirname(CONFIG_FILE_PATH);
  const base = path.basename(CONFIG_FILE_PATH);
  let debounce = null;
  try {
    // Watch the parent dir so we're robust to config.json being created
    // (first PUT), deleted (revert everything), or replaced via rename
    // (atomic write from patchConfig).
    watch(dir, { persistent: false }, (eventType, filename) => {
      if (filename !== base) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        console.log(`[${datetime()}] Scheduler: config changed — recomputing next wake.`);
        if (schedulerWakeup) schedulerWakeup();
      }, 150);
    });
  } catch (e) {
    console.error(`[${datetime()}] Scheduler: fs.watch setup failed (${e.message}). Config changes will need a restart to apply.`);
  }
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
    if (sleepMs <= 0) {
      // Scheduler disabled (LOOP=0 and MS_SCHEDULE_HOURS=0). Park indefinitely
      // and let a config change unstick us.
      nextScheduledRun = null;
      console.log(`[${datetime()}] Scheduler: disabled — waiting for config change.`);
      await sleepUntilWakeup(2 ** 31 - 1);
      continue;
    }
    nextScheduledRun = new Date(Date.now() + sleepMs);
    console.log(`[${datetime()}] Scheduler: next run at ${datetime(nextScheduledRun)}.`);
    const how = await sleepUntilWakeup(sleepMs);
    if (how === 'reload') {
      // Config changed mid-sleep — skip the run, recompute.
      continue;
    }

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
  const active = activeServices();
  // allLoggedIn counts only services the user opted into — an inactive
  // service can't invalidate the "All sessions OK" summary strip.
  const allLoggedIn = Object.entries(siteStatus)
    .filter(([id]) => active.has(id))
    .every(([, s]) => s.status === 'logged_in');
  return {
    sites: Object.entries(SITES).map(([id, site]) => ({
      id,
      name: site.name,
      active: active.has(id),
      ...siteStatus[id],
    })),
    activeBrowser: activeBrowser ? { site: activeBrowser.siteId, name: SITES[activeBrowser.siteId].name } : null,
    allLoggedIn,
    runStatus,
    runSource,
    runLogLength: runLog.length,
    nextScheduledRun: nextScheduledRun ? datetime(nextScheduledRun) : null,
    loopEnabled: (() => { const c = getSchedulerConfig(); return c.loop > 0 || c.msHours > 0; })(),
    loopSeconds: getSchedulerConfig().loop,
    msScheduleHours: getSchedulerConfig().msHours,
    msScheduleStart: getSchedulerConfig().msStart,
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

// AliExpress tracks a daily coin balance in data/aliexpress.json (written by
// aliexpress.js). Similar shape to MS Rewards — we surface the latest balance
// and per-window "earned" totals in the Stats tab.
async function getAliexpressData() {
  let db;
  try { db = await jsonDb('aliexpress.json', { runs: [] }); }
  catch { return { latestBalance: null, latestAt: null, weekEarned: 0, monthEarned: 0, row: null }; }
  const runs = (db.data && Array.isArray(db.data.runs)) ? db.data.runs : [];
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
  const toMs = s => { const d = parseLocalDateTime(s); return d ? d.getTime() : 0; };
  let latestBalance = null, latestAt = null, latestMs = 0;
  let weekEarned = 0, monthEarned = 0, allTimeEarned = 0;
  for (const r of runs) {
    const tMs = toMs(r.at);
    const earned = Number.isFinite(r.earned) ? Math.max(0, r.earned) : 0;
    allTimeEarned += earned;
    if (tMs >= weekAgo)  weekEarned  += earned;
    if (tMs >= monthAgo) monthEarned += earned;
    if (r.balance != null && tMs >= latestMs) { latestBalance = r.balance; latestAt = r.at; latestMs = tMs; }
  }
  const row = runs.length
    ? { thisWeek: weekEarned, thisMonth: monthEarned, allTime: allTimeEarned, lastClaimAt: latestAt, unit: 'coins' }
    : null;
  return { latestBalance, latestAt, weekEarned, monthEarned, row };
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
  const [claims, ms, ae] = await Promise.all([readAllClaims(), getMsRewards(), getAliexpressData()]);
  const rows = {};
  for (const svc of Object.keys(CLAIM_DB_FILES)) {
    rows[svc] = { id: svc, unit: 'games', thisWeek: 0, thisMonth: 0, allTime: 0, lastClaimAt: null };
  }
  // MS rows use real aggregates from the MS runs DB instead of the "N/A" stub.
  rows['microsoft']        = { id: 'microsoft',        ...ms.bySession['microsoft'] };
  rows['microsoft-mobile'] = { id: 'microsoft-mobile', ...ms.bySession['microsoft-mobile'] };
  if (ae.row) {
    rows['aliexpress'] = { id: 'aliexpress', ...ae.row };
  }
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
  body[data-tab="settings"] .tab-panel[data-panel="settings"] { display: flex; flex: 1; flex-direction: column; position: relative; }
  body[data-tab="environment"] .tab-panel[data-panel="environment"] { display: flex; flex: 1; flex-direction: column; }

  .settings-layout { flex: 1; display: grid; grid-template-columns: 180px 1fr; min-height: 0; }
  .settings-rail { background: #12213a; border-right: 1px solid #233454; padding: 14px 0; overflow-y: auto; }
  .settings-rail .rail-btn { display: block; width: 100%; text-align: left; padding: 9px 18px; background: transparent; border: none; border-left: 3px solid transparent; color: #a0b4d4; font-size: 13px; cursor: pointer; font-family: inherit; }
  .settings-rail .rail-btn:hover { background: #1a2a48; color: #e0e0e0; }
  .settings-rail .rail-btn.active { background: rgba(78, 204, 163, 0.08); color: #fff; border-left-color: #4ecca3; font-weight: 600; }
  .settings-pane { overflow-y: auto; padding: 24px 32px 24px; }
  .settings-pane-title { font-size: 11px; color: #8aa0c2; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 16px; display: flex; align-items: center; gap: 12px; }
  .settings-pane-title .spacer { flex: 1; }

  /* Keep the old class names working for in-section rendering */
  .settings-view { flex: 1; overflow-y: auto; padding: 24px 32px 16px; }
  .settings-section { margin-bottom: 28px; }
  .settings-section-head { font-size: 11px; color: #8aa0c2; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; display: flex; align-items: center; gap: 12px; }
  .settings-section-head .spacer { flex: 1; }

  @media (max-width: 720px) {
    .settings-layout { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    .settings-rail { display: flex; overflow-x: auto; gap: 4px; padding: 8px 12px; border-right: none; border-bottom: 1px solid #233454; }
    .settings-rail .rail-btn { width: auto; flex-shrink: 0; white-space: nowrap; border-left: none; border-bottom: 3px solid transparent; border-radius: 6px; padding: 6px 12px; }
    .settings-rail .rail-btn.active { border-left-color: transparent; border-bottom-color: #4ecca3; }
    .settings-pane { padding: 16px; }
  }

  .env-view-head { padding: 20px 32px 8px; display: flex; align-items: flex-start; gap: 16px; flex-shrink: 0; }
  .env-view-head .env-view-title { font-size: 16px; color: #e0e0e0; font-weight: 600; margin: 0 0 4px; }
  .env-view-head .env-view-sub { font-size: 12px; color: #8aa0c2; line-height: 1.45; max-width: 540px; }
  .env-view-head > button { margin-left: auto; flex-shrink: 0; }
  .env-view-body { flex: 1; overflow-y: auto; padding: 0 32px 24px; }

  /* Field chrome */
  .setting .setting-label { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .setting .setting-help-popover { grid-column: 1 / -1; }
  .setting-input .input-prefix { color: #8aa0c2; padding-right: 2px; }
  .setting-info { background: transparent; border: 1px solid #233454; color: #8aa0c2; width: 18px; height: 18px; border-radius: 50%; font-size: 11px; cursor: pointer; padding: 0; line-height: 1; margin-left: 6px; display: inline-flex; align-items: center; justify-content: center; }
  .setting-info:hover { background: #1a2a48; color: #e0e0e0; border-color: #2a3a5a; }
  .setting-info.open { background: #0f3460; color: #fff; border-color: #4ecca3; }
  .setting-help-popover { margin-top: 4px; padding: 8px 10px; background: #0d1830; border: 1px solid #233454; border-radius: 6px; font-size: 12px; color: #a0b4d4; line-height: 1.5; display: none; }
  .setting-help-popover.open { display: block; }
  .setting-help-popover .env-tag { font-family: 'Menlo', 'Consolas', monospace; font-size: 11px; color: #8aa0c2; display: block; margin-top: 4px; }

  /* Per-service accordion */
  .svc-row { border-top: 1px solid #1a2a48; }
  .svc-row:first-of-type { border-top: none; }
  .svc-head { display: flex; align-items: stretch; gap: 12px; }
  .svc-expand { flex: 1; display: grid; grid-template-columns: 14px 1fr; grid-template-rows: auto auto; column-gap: 12px; row-gap: 2px; padding: 12px 12px; cursor: pointer; background: transparent; border: none; color: inherit; font-family: inherit; text-align: left; transition: background 0.12s, box-shadow 0.12s; }
  .svc-row.expandable .svc-expand:hover { background: rgba(78, 204, 163, 0.05); box-shadow: inset 3px 0 0 #4ecca3; }
  .svc-expand[disabled] { cursor: default; }
  .svc-expand .svc-caret { grid-row: 1 / 3; grid-column: 1; align-self: center; color: #8aa0c2; font-size: 13px; }
  .svc-expand .svc-name-line { grid-row: 1; grid-column: 2; display: flex; align-items: baseline; gap: 10px; }
  .svc-expand .svc-name { font-size: 15px; font-weight: 600; color: #ffffff; letter-spacing: 0.01em; }
  .svc-expand .svc-count { font-size: 11px; color: #6a7e9e; font-weight: 400; letter-spacing: 0.02em; padding: 2px 7px; border: 1px solid #233454; border-radius: 10px; line-height: 1; }
  .svc-row.expandable .svc-expand:hover .svc-count { color: #4ecca3; border-color: #2a4a3e; }
  .svc-expand .svc-summary { grid-row: 2; grid-column: 2; font-size: 12.5px; color: #8aa0c2; line-height: 1.4; }
  .svc-row.inactive .svc-name { color: #c0c8d8; font-weight: 500; }
  .svc-row.inactive .svc-summary { color: #6a7e9e; }
  .svc-active { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; color: #8aa0c2; font-size: 12px; cursor: pointer; padding-right: 14px; }
  .svc-active input { width: 14px; height: 14px; cursor: pointer; }
  .svc-body { padding: 6px 16px 16px 38px; display: none; }
  .svc-body.open { display: block; }
  .svc-body .svc-subtitle { font-size: 12px; color: #8aa0c2; margin: 0 0 12px; font-style: italic; }
  .setting { display: grid; grid-template-columns: minmax(180px, 220px) 1fr auto; gap: 16px; align-items: start; padding: 12px 0; border-bottom: 1px solid #1a2a48; }
  .setting:last-child { border-bottom: none; }
  .setting-label { font-size: 13px; color: #e0e0e0; padding-top: 7px; line-height: 1.4; }
  .setting-env { font-size: 11px; color: #8aa0c2; font-family: 'Menlo', 'Consolas', monospace; margin-left: 6px; }
  .setting-dot { width: 6px; height: 6px; border-radius: 50%; background: #4ecca3; display: inline-block; margin-left: 6px; vertical-align: middle; }
  .setting-hint { font-size: 11px; color: #8aa0c2; margin-top: 3px; line-height: 1.4; font-style: italic; }
  .setting-input { display: flex; align-items: center; gap: 8px; }
  .setting-input input[type="number"], .setting-input input[type="text"], .setting-input select, .setting-input textarea {
    width: 100%; background: #0d1830; color: #e0e0e0; border: 1px solid #233454; border-radius: 4px; padding: 6px 8px; font-size: 13px; font-family: inherit;
  }
  .setting-input input[type="number"]:focus, .setting-input input[type="text"]:focus, .setting-input select:focus, .setting-input textarea:focus {
    outline: none; border-color: #4ecca3;
  }
  .setting-input textarea { min-height: 60px; resize: vertical; font-family: 'Menlo', 'Consolas', monospace; font-size: 12px; }
  .setting-checkbox { display: inline-flex; align-items: center; gap: 8px; color: #e0e0e0; font-size: 13px; cursor: pointer; }
  .setting-checkbox input { width: 16px; height: 16px; cursor: pointer; }
  .setting-revert { background: transparent; border: 1px solid #233454; border-radius: 4px; padding: 5px 10px; color: #8aa0c2; cursor: pointer; font-size: 11px; white-space: nowrap; margin-top: 3px; }
  .setting-revert:hover:not(:disabled) { background: #1a2a48; color: #e0e0e0; border-color: #2a3a5a; }
  .setting-revert:disabled { opacity: 0.25; cursor: not-allowed; }

  .settings-footer { background: #16233c; border-top: 1px solid #233454; padding: 12px 32px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  .settings-footer .dirty-count { color: #f0c040; font-size: 13px; margin-right: auto; font-weight: 500; }

  .settings-subhead { font-size: 12px; color: #c0c8d8; font-weight: 600; margin: 14px 0 4px; padding-top: 10px; border-top: 1px solid #1a2a48; display: flex; align-items: center; gap: 12px; }
  .settings-subhead:first-of-type { border-top: none; padding-top: 0; margin-top: 0; }
  .settings-active-toggle { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; color: #8aa0c2; font-size: 12px; font-weight: 400; cursor: pointer; text-transform: none; letter-spacing: 0; }
  .settings-active-toggle input { width: 14px; height: 14px; cursor: pointer; }
  .settings-subflag-placeholder { font-size: 11px; color: #8aa0c2; font-style: italic; padding: 10px 0 6px; margin-left: 4px; }

  .env-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
  .env-table th, .env-table td { padding: 5px 8px; text-align: left; border-bottom: 1px solid #1a2a48; vertical-align: top; }
  .env-table th { color: #8aa0c2; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; font-size: 10px; }
  .env-table tr.cat-row td { padding-top: 14px; padding-bottom: 4px; border-bottom: none; color: #8aa0c2; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
  .env-table tr.cat-row:first-child td { padding-top: 4px; }
  .env-table tr.group-row td { padding: 8px 8px 3px; border-bottom: none; color: #c0c8d8; font-size: 11px; font-weight: 600; padding-left: 20px; }
  .env-table tr.data-row td { padding-left: 8px; }
  .env-table tr.data-row.grouped td:first-child { padding-left: 28px; }
  .env-note { font-size: 10px; color: #8aa0c2; font-style: italic; margin-top: 3px; line-height: 1.45; max-width: 420px; }
  .env-name { font-family: 'Menlo', 'Consolas', monospace; color: #c0c8d8; white-space: nowrap; }
  .env-value { font-family: 'Menlo', 'Consolas', monospace; color: #4ecca3; word-break: break-all; }
  .env-masked { font-family: 'Menlo', 'Consolas', monospace; color: #f0c040; }
  .env-unset { color: #666; font-style: italic; }
  .env-set-badge { color: #4ecca3; font-size: 11px; font-style: italic; }
  body:not([data-tab="sessions"]) .sessions-only { display: none !important; }

  .stats-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .kpi { background: #16233c; border: 1px solid #233454; border-radius: 8px; padding: 14px 16px; }
  .kpi .kpi-label { font-size: 11px; color: #8aa0c2; text-transform: uppercase; letter-spacing: 0.06em; }
  .kpi .kpi-value { font-size: 28px; font-weight: 500; color: #fff; margin-top: 6px; line-height: 1.15; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; font-synthesis: none; }
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
  .chart-plot { display: flex; gap: 8px; }
  .chart-y-axis { display: flex; flex-direction: column-reverse; justify-content: space-between; font-size: 10px; color: #8aa0c2; padding-bottom: 20px; min-width: 18px; text-align: right; font-variant-numeric: tabular-nums; }
  .chart-area { flex: 1; min-width: 0; }
  .chart-bars { display: flex; align-items: flex-end; gap: 2px; height: 120px; border-bottom: 1px solid #233454; }
  .chart-bars .bar { flex: 1; min-width: 0; background: #4ecca3; min-height: 2px; border-radius: 2px 2px 0 0; }
  .chart-bars .bar.zero { background: #4a5a8a; }
  .chart-x-axis { display: flex; gap: 2px; font-size: 10px; color: #8aa0c2; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .chart-x-axis .xtick { flex: 1; text-align: center; white-space: nowrap; min-width: 0; }

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
  .sched-services { list-style: none; margin: 0; padding: 0; font-size: 13px; color: #c8d0dc; line-height: 1.75; }
  .sched-services li { position: relative; padding-left: 16px; }
  .sched-services li::before { content: '•'; position: absolute; left: 0; color: #4ecca3; font-weight: 700; }
  .sched-services b { color: #ffffff; font-weight: 600; }
  .sched-services .muted { color: #8aa0c2; font-weight: 400; font-size: 12px; }

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
  .site-card.card-inactive { background: #12213a; border: 1px dashed #2a3a5a; opacity: 0.85; }
  .site-card.card-inactive .name { color: #a0b4d4; }
  .site-card.card-inactive .status { color: #8aa0c2; font-style: italic; }

  .available-drawer { margin-top: 12px; background: #12213a; border: 1px solid #233454; border-radius: 8px; }
  .available-drawer .drawer-head { width: 100%; text-align: left; padding: 10px 14px; background: transparent; border: none; color: #a0b4d4; font-size: 13px; cursor: pointer; font-family: inherit; display: flex; align-items: center; gap: 8px; }
  .available-drawer .drawer-head:hover { color: #e0e0e0; }
  .available-drawer .drawer-head .caret { display: inline-block; width: 12px; }
  .available-drawer .drawer-body { padding: 0 14px 12px; display: grid; grid-template-columns: repeat(1, 1fr); gap: 10px; }
  @media (min-width: 640px)  { .available-drawer .drawer-body { grid-template-columns: repeat(2, 1fr); } }
  @media (min-width: 960px)  { .available-drawer .drawer-body { grid-template-columns: repeat(3, 1fr); } }
  @media (min-width: 1400px) { .available-drawer .drawer-body { grid-template-columns: repeat(4, 1fr); } }
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
  .btn-show-browser { background: #3a3a5c; color: #ccc; }
  .btn-show-browser:hover:not(:disabled) { background: #4a4a6c; }
  .btn-show-browser.active { background: #2a4a3e; color: #4ecca3; }
  .btn-popout-browser { background: #3a3a5c; color: #ccc; }
  .btn-popout-browser:hover:not(:disabled) { background: #4a4a6c; }
  .btn-run-single { background: #2a4a3e; color: #4ecca3; }
  .btn-run-single:hover:not(:disabled) { background: #3a5a4e; color: #5edcb3; }
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
      <button class="tab" data-tab="settings" onclick="switchTab('settings')">Settings</button>
      <button class="tab" data-tab="environment" onclick="switchTab('environment')">Environment</button>
    </nav>
    <div class="header-actions">
      <button class="btn btn-check-all sessions-only" onclick="checkAll()" id="btnCheckAll">Check All Sessions</button>
      <button class="btn btn-show-browser sessions-only" onclick="toggleBrowserView()" id="btnShowBrowser" title="Open the live browser view via noVNC — useful for diagnosing card-click failures or peeking at what a script is doing.">Show browser</button>
      <button class="btn btn-popout-browser sessions-only" onclick="popoutBrowser()" id="btnPopoutBrowser" title="Open the noVNC view in a new tab for full-screen viewing.">Pop out ↗</button>
      <button class="btn btn-run" onclick="runAll()" id="btnRunAll">Run Now</button>
    </div>
  </div>
  <div class="steps sessions-only" id="steps"></div>
  <div class="status-strip sessions-only" id="statusStrip"></div>
  <div class="site-cards sessions-only" id="siteCards"></div>
  <div class="available-drawer sessions-only" id="availableDrawer" style="display:none"></div>
  <div class="sessions-only" id="batchRedeemInfo" style="display:none; margin-top: 10px;"></div>
  <div class="sessions-only" id="activeSession" style="display:none"></div>
</div>
<div class="main-area" id="mainArea">
  <div class="tab-panel" data-panel="sessions">
    <div class="vnc-container" id="vncContainer">
      <div class="vnc-placeholder" id="vncPlaceholder">
        <div style="max-width:520px;font-size:14px;line-height:1.7;color:#a0b4d4">Loading…</div>
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
  <div class="tab-panel" data-panel="settings">
    <div class="settings-layout">
      <nav class="settings-rail" id="settingsRail">
        <button class="rail-btn active" data-section="scheduler"     onclick="selectSettingsSection('scheduler')">Scheduler</button>
        <button class="rail-btn"        data-section="notifications" onclick="selectSettingsSection('notifications')">Notifications</button>
        <button class="rail-btn"        data-section="services"      onclick="selectSettingsSection('services')">Services</button>
        <button class="rail-btn"        data-section="advanced"      onclick="selectSettingsSection('advanced')">Advanced</button>
      </nav>
      <div class="settings-pane" id="settingsView">Loading…</div>
    </div>
    <div class="settings-footer" id="settingsFooter" style="display:none">
      <span class="dirty-count" id="dirtyCount">0 unsaved changes</span>
      <button class="btn btn-cancel" onclick="discardSettings()" id="btnDiscardSettings">Discard</button>
      <button class="btn btn-run" onclick="saveSettings()" id="btnSaveSettings">Save</button>
    </div>
  </div>
  <div class="tab-panel" data-panel="environment">
    <div class="env-view-head">
      <div>
        <h3 class="env-view-title">Environment</h3>
        <div class="env-view-sub">Read-only view of every environment variable the app reads. Use <b>Settings → Services</b> to change runtime behaviour. <b>Reveal credentials</b> shows each secret as <code>••••••XXXX</code> — last 4 chars only — so don't tap it on a shared screen.</div>
      </div>
      <button class="btn btn-check-all" id="btnRevealCreds" onclick="toggleRevealEnv()">Reveal credentials</button>
    </div>
    <div class="env-view-body" id="envView">Loading…</div>
  </div>
</div>
<script>
const NOVNC_PORT = ${NOVNC_PORT};
const BASE_PATH = '${BASE_PATH}';
let state = { sites: [], activeBrowser: null, allLoggedIn: false, runStatus: 'idle' };
let busy = false;
let showingLog = false;
// User-toggled noVNC view via the "Show browser" header button. Independent
// of activeBrowser/showingLog so the user can peek at the live browser
// during a claim run (which normally swaps the iframe for the run log).
let userShowBrowser = false;
let logOffset = 0;
let logPollTimer = null;
let pendingGogCount = 0;

function toggleAvailableDrawer() {
  const body = document.querySelector('#availableDrawer .drawer-body');
  const head = document.querySelector('#availableDrawer .drawer-head');
  if (!body || !head) return;
  const nowOpen = body.hasAttribute('hidden');
  if (nowOpen) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
  head.setAttribute('aria-expanded', String(nowOpen));
  const caret = head.querySelector('.caret'); if (caret) caret.textContent = nowOpen ? '▾' : '▸';
  localStorage.setItem('drawerSeen', '1');
}

async function enableService(id) {
  localStorage.setItem('drawerSeen', '1');
  // Honour service → underlying-sites linking (Microsoft desktop + mobile
  // share a setting). The inverse lookup: if the clicked card is one of a
  // linked group, enable all siblings too.
  const sites = new Set([id]);
  for (const [primary, linked] of Object.entries(LINKED_ACTIVE)) {
    if (linked.includes(id)) linked.forEach(x => sites.add(x));
    if (primary === id)       linked.forEach(x => sites.add(x));
  }
  const patch = {};
  for (const s of sites) patch['services.' + s + '.active'] = true;
  try {
    await api('PUT', '/config', patch);
    showToast('Enabled — checking session…', 'success');
    await refreshState();
    // Kick off a session probe for each freshly-enabled card so the status
    // dot flips from gray to red/green without waiting for the next tick.
    for (const s of sites) {
      api('POST', '/check', { site: s }).then(refreshState).catch(() => {});
    }
  } catch (e) {
    showToast('Failed to enable: ' + (e && e.message || 'unknown'), 'error');
  }
}

function switchTab(tab) {
  document.body.dataset.tab = tab;
  document.querySelectorAll('.tab-nav .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  if (tab === 'logs') startLogsTabPoll();
  else stopLogsTabPoll();
  if (tab === 'schedule') renderScheduleTab();
  if (tab === 'stats') renderStatsTab();
  if (tab === 'settings') renderSettingsTab();
  if (tab === 'environment') renderEnvironmentTab();
}

async function renderEnvironmentTab() {
  // Environment is read-only; reuse the same loadEnvTable used to live
  // inside the Settings tab. No settings-config fetch needed.
  await loadEnvTable(envRevealed);
}

// --- Settings tab ---
// Holds the last /api/config response. Re-fetched on tab entry and after save.
let settingsData = null;
// path → proposed value. null means "revert this field to env/default".
let settingsDirty = {};

async function renderSettingsTab() {
  const view = document.getElementById('settingsView');
  if (!view) return;
  try {
    settingsData = await api('GET', '/config');
    settingsDirty = {};
    paintSettings();
  } catch (e) {
    view.innerHTML = '<div class="stats-empty" style="margin:24px">Failed to load config: ' + escapeHtml(e.message) + '</div>';
  }
}

// Which section the Settings rail currently has selected.
let currentSettingsSection = 'scheduler';
// Per-field help-popover + per-service accordion state. Kept across repaints.
const openHelp = new Set();
const openServices = new Set();

function selectSettingsSection(name) {
  currentSettingsSection = name;
  document.querySelectorAll('.settings-rail .rail-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.section === name);
  });
  paintSettings();
}

function toggleFieldHelp(path) {
  if (openHelp.has(path)) openHelp.delete(path); else openHelp.add(path);
  paintSettings();
}

function toggleServiceBody(id) {
  if (openServices.has(id)) openServices.delete(id); else openServices.add(id);
  paintSettings();
}

// Returns the value the form should show for a path, considering in-flight
// draft edits. For pending reverts (draft === null) falls back to env/default.
function draftValue(path) {
  if (!settingsData) return null;
  const f = settingsData.fields.find(x => x.path === path);
  if (!f) return null;
  if (Object.prototype.hasOwnProperty.call(settingsDirty, path)) {
    const v = settingsDirty[path];
    if (v !== null) return v;
    if (f.envValue !== null && f.envValue !== undefined) {
      return f.type === 'number' ? Number(f.envValue)
           : f.type === 'boolean' ? (f.envValue === '1' || f.envValue === 'true')
           : f.envValue;
    }
    return f.default;
  }
  return f.effective;
}

function isOverriddenInForm(path) {
  if (!settingsData) return false;
  const f = settingsData.fields.find(x => x.path === path);
  if (!f) return false;
  if (Object.prototype.hasOwnProperty.call(settingsDirty, path)) {
    return settingsDirty[path] !== null; // revert-pending flips overridden off
  }
  return f.overridden;
}

function isServiceActiveForUI(id) {
  return !!draftValue('services.' + id + '.active');
}

// Build the HTML for one settings row. Help + env-var name live inside a
// popover opened by the ⓘ button; Revert only renders when the field is
// overridden relative to env/default.
function fieldRow(path, label, extra) {
  if (!settingsData) return '';
  const f = settingsData.fields.find(x => x.path === path);
  if (!f) return '';
  extra = extra || {};
  const value = draftValue(path);
  const overridden = isOverriddenInForm(path);
  const dot = overridden ? '<span class="setting-dot" title="Overrides environment"></span>' : '';
  const hasPopover = !!(extra.hint || f.envVar);
  const helpOpen = openHelp.has(path);
  const infoBtn = hasPopover
    ? '<button type="button" class="setting-info' + (helpOpen ? ' open' : '') + '" onclick="toggleFieldHelp(\\'' + path + '\\')" title="Help">i</button>'
    : '';
  const popoverBody = (extra.hint ? escapeHtml(extra.hint) : '') +
    (f.envVar ? '<span class="env-tag">Env: ' + escapeHtml(f.envVar) + '</span>' : '');
  const popover = (hasPopover && helpOpen)
    ? '<div class="setting-help-popover open">' + popoverBody + '</div>'
    : '';

  let inputHtml;
  if (f.type === 'boolean') {
    inputHtml = '<label class="setting-checkbox"><input type="checkbox" ' + (value ? 'checked' : '') + ' onchange="setSettingValue(\\'' + path + '\\', this.checked)"></label>';
  } else if (extra.options) {
    const options = extra.options.map(o => '<option value="' + o.value + '"' + (String(value) === String(o.value) ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>').join('');
    const cast = f.type === 'number' ? 'Number(this.value)' : 'this.value';
    inputHtml = '<select onchange="setSettingValue(\\'' + path + '\\', ' + cast + ')">' + options + '</select>';
  } else if (f.type === 'number') {
    const v = value == null ? '' : value;
    const prefix = extra.prefix ? '<span class="input-prefix">' + escapeHtml(extra.prefix) + '</span>' : '';
    inputHtml = prefix + '<input type="number" value="' + v + '" oninput="setSettingValue(\\'' + path + '\\', this.value === \\'\\' ? null : Number(this.value))">';
  } else if (extra.multiline) {
    inputHtml = '<textarea oninput="setSettingValue(\\'' + path + '\\', this.value)">' + escapeHtml(value || '') + '</textarea>';
  } else {
    inputHtml = '<input type="text" value="' + escapeHtml(value || '') + '" oninput="setSettingValue(\\'' + path + '\\', this.value)">';
  }

  const revertBtn = overridden
    ? '<button type="button" class="setting-revert" onclick="revertSettingValue(\\'' + path + '\\')">Revert</button>'
    : '';
  return '<div class="setting" data-path="' + path + '">' +
    '<div class="setting-label">' + escapeHtml(label) + dot + infoBtn + '</div>' +
    '<div class="setting-input">' + inputHtml + '</div>' +
    revertBtn +
    popover +
  '</div>';
}

// Per-service summary string shown when the accordion row is collapsed.
function serviceSummary(id) {
  if (!isServiceActiveForUI(id)) return 'Enable to configure.';
  const v = k => draftValue('services.' + id + '.' + k);
  switch (id) {
    case 'prime-gaming': {
      const t = v('timeLeftDays');
      return 'Redeem ' + (v('redeem') ? 'on' : 'off') +
        ' · DLC ' + (v('claimDlc') ? 'on' : 'off') +
        ' · Timeleft ' + (t == null ? 'none' : t + ' days');
    }
    case 'epic-games':
      return 'Mobile ' + (v('claimMobile') ? 'on' : 'off');
    case 'gog':
      return 'Newsletter ' + (v('keepNewsletter') ? 'keep' : 'unsubscribe');
    case 'steam':
      return 'Min rating ' + v('minRating') + ' · Min price $' + v('minPrice');
    case 'microsoft': {
      const w = draftValue('scheduler.msScheduleHours') || 0;
      const s = draftValue('scheduler.msScheduleStart') || 0;
      if (!w) return 'Runs immediately · desktop + mobile sessions';
      const fmt = h => String(h).padStart(2, '0') + ':00';
      return 'Window ' + fmt(s) + ' → ' + fmt((Number(s) + Number(w)) % 24) + ' · desktop + mobile';
    }
    case 'aliexpress':
      return 'Daily check-in coins · mobile site';
    default:
      return '';
  }
}

// Services whose Active toggle controls more than one underlying site.
// Microsoft desktop + mobile share everything — settings, credentials, claim
// script (microsoft.js runs both sessions internally). We present them as a
// single service in the Settings UI but keep two session cards in the
// Sessions tab for per-session login-state visibility.
const LINKED_ACTIVE = {
  'microsoft': ['microsoft', 'microsoft-mobile'],
};

// Hours dropdown reused by multiple fields.
const HOURS_OF_DAY = (() => {
  const out = [];
  for (let h = 0; h < 24; h++) out.push({ value: h, label: String(h).padStart(2, '0') + ':00' });
  return out;
})();

// Settings-tab fields grouped per service so the accordion code can iterate.
const SERVICE_ROWS = [
  { id: 'prime-gaming', title: 'Prime Gaming', fields: [
    ['services.prime-gaming.redeem',       'Redeem keys on external stores'],
    ['services.prime-gaming.claimDlc',     'Claim in-game DLC content',
      { hint: 'Amazon removed the in-game content tab from Prime Gaming — this toggle is currently a no-op. The script skips cleanly when the tab is missing; will resume claiming if/when Amazon brings it back.' }],
    ['services.prime-gaming.timeLeftDays', 'Skip if more than N days remain to claim',
      { hint: 'Leave blank to claim everything regardless of how long is left.' }],
  ]},
  { id: 'epic-games', title: 'Epic Games', fields: [
    ['services.epic-games.claimMobile', 'Claim mobile games'],
  ]},
  { id: 'gog', title: 'GOG', fields: [
    ['services.gog.keepNewsletter', 'Keep newsletter subscription after claiming'],
  ]},
  { id: 'steam', title: 'Steam', fields: [
    ['services.steam.minRating', 'Minimum review rating (1–9)',
      { hint: '6 = Mostly Positive; 7 = Very Positive; 8 = Overwhelmingly Positive.' }],
    ['services.steam.minPrice', 'Minimum original price', { prefix: '$',
      hint: 'Filters out shovelware that was free or near-free before the giveaway.' }],
  ]},
  // Microsoft Rewards: one row controls both desktop and mobile sessions.
  // MS_SCHEDULE_* fields moved here from the Scheduler section because they
  // only affect the Microsoft Rewards run, not the global loop.
  { id: 'microsoft', title: 'Microsoft Rewards', subtitle: 'Runs both desktop and mobile sessions in one script.', fields: [
    ['scheduler.msScheduleHours', 'Schedule window width (hours)',
      { hint: 'Width of the daily Microsoft Rewards window, anchored to the start time. 0 runs immediately without anchoring.' }],
    ['scheduler.msScheduleStart', 'Schedule window start (local time)',
      { options: HOURS_OF_DAY }],
    ['services.microsoft.searchDelayMaxSec', 'Max delay between Bing searches (seconds)',
      { hint: 'Upper bound for the random pause before each Bing search. Default 180 mimics a human pace; lower values shorten runs significantly (~60 searches × this/2 avg = total search time) but increase the risk of MS flagging the account as a bot.' }],
  ]},
  { id: 'aliexpress', title: 'AliExpress', fields: [] },
];

function serviceRow(entry) {
  const active = isServiceActiveForUI(entry.id);
  const hasFields = entry.fields.length > 0;
  const open = active && openServices.has(entry.id) && hasFields;
  const caret = open ? '▾' : '▸';
  const subtitleHtml = (open && entry.subtitle)
    ? '<div class="svc-subtitle">' + escapeHtml(entry.subtitle) + '</div>'
    : '';
  const body = open
    ? '<div class="svc-body open">' + subtitleHtml + entry.fields.map(f => fieldRow(f[0], f[1], f[2])).join('') + '</div>'
    : '';
  const expandable = active && hasFields;
  const onclick = expandable ? 'onclick="toggleServiceBody(\\'' + entry.id + '\\')"' : '';
  const countLabel = hasFields
    ? '<span class="svc-count">' + entry.fields.length + ' setting' + (entry.fields.length === 1 ? '' : 's') + ' ' + (open ? '▾' : '▸') + '</span>'
    : '';
  return '<div class="svc-row' + (active ? '' : ' inactive') + (expandable ? ' expandable' : '') + '">' +
    '<div class="svc-head">' +
      '<button type="button" class="svc-expand" ' + onclick + (expandable ? '' : ' disabled') + '>' +
        '<span class="svc-caret">' + (expandable ? caret : '·') + '</span>' +
        '<span class="svc-name-line">' +
          '<span class="svc-name">' + escapeHtml(entry.title) + '</span>' +
          (expandable ? countLabel : '') +
        '</span>' +
        '<span class="svc-summary">' + escapeHtml(serviceSummary(entry.id)) + '</span>' +
      '</button>' +
      '<label class="svc-active">' +
        '<input type="checkbox" ' + (active ? 'checked' : '') +
          ' onchange="setActiveService(\\'' + entry.id + '\\', this.checked)">Active' +
      '</label>' +
    '</div>' +
    body +
  '</div>';
}

function paintSettings() {
  const view = document.getElementById('settingsView');
  if (!view || !settingsData) return;

  let html = '';
  if (currentSettingsSection === 'scheduler') {
    // Show the loop interval in human-readable units under the number input
    // so "86400" isn't the only thing the user sees.
    let loopHuman = '';
    const loopSec = draftValue('scheduler.loopSeconds') || 0;
    if (loopSec > 0) {
      let pretty;
      if (loopSec % 86400 === 0)      pretty = (loopSec / 86400) + 'd';
      else if (loopSec % 3600 === 0)  pretty = (loopSec / 3600) + 'h';
      else if (loopSec % 60 === 0)    pretty = (loopSec / 60) + 'm';
      else                            pretty = loopSec + 's';
      loopHuman = '<div class="setting-hint" style="margin:-6px 0 8px 4px">= ' + pretty + '</div>';
    }
    html =
      '<div class="settings-pane-title">Scheduler</div>' +
      fieldRow('scheduler.loopSeconds', 'Loop interval (seconds)',
        { hint: 'Time between scheduled runs. 0 disables the loop. Microsoft Rewards has its own window — set it under Services → Microsoft Rewards.' }) +
      loopHuman;
  } else if (currentSettingsSection === 'notifications') {
    html =
      '<div class="settings-pane-title">Notifications' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-check-all" onclick="testNotify()" id="btnTestNotify">Send test</button>' +
      '</div>' +
      fieldRow('notifications.notify', 'Apprise URL(s)',
        { multiline: true, hint: 'One URL per line (or comma-separated). Examples: pover://token@user, tgram://botid/chatid.' }) +
      fieldRow('notifications.notifyTitle', 'Title prefix') +
      fieldRow('panel.publicUrl', 'Public URL',
        { hint: 'External URL used in notifications so tap-targets land on the panel.' });
  } else if (currentSettingsSection === 'services') {
    html = '<div class="settings-pane-title">Services</div>' +
      '<div class="svc-list">' +
        SERVICE_ROWS.map(serviceRow).join('') +
      '</div>';
  } else if (currentSettingsSection === 'advanced') {
    // Order reflects what someone opening Advanced is usually there for:
    // first timeouts (most common debug tweak), then dry-run / recording,
    // then viewport.
    html =
      '<div class="settings-pane-title">Advanced</div>' +
      fieldRow('advanced.timeoutSec',      'Default timeout (seconds)',        { hint: 'Applies to Playwright page operations.' }) +
      fieldRow('advanced.loginTimeoutSec', 'Login timeout (seconds)',          { hint: 'Separate timeout used during the login flow.' }) +
      fieldRow('advanced.dryrun',          'Dry run — skip actual claiming',   { hint: 'Runs the claim pipeline without actually claiming anything. Useful for testing.' }) +
      fieldRow('advanced.record',          'Record HAR + video for debugging', { hint: 'Writes per-run .webm + .har to data/record/. Heavier runs.' }) +
      fieldRow('advanced.width',           'Browser viewport width') +
      fieldRow('advanced.height',          'Browser viewport height');
  }

  view.innerHTML = html;
  updateSettingsFooter();
}

// Environment (read-only) table. Credentials are hidden by default and need
// an explicit reveal click, which shows only the last 4 chars.
let envRevealed = false;
async function loadEnvTable(reveal) {
  const mount = document.getElementById('envView');
  if (!mount) return;
  try {
    const r = await api('GET', '/env' + (reveal ? '?reveal=1' : ''));
    const entries = (r && r.env) || [];
    // Group by category, preserving declaration order within each category.
    const catOrder = [];
    const byCat = {};
    for (const e of entries) {
      if (!byCat[e.category]) { byCat[e.category] = []; catOrder.push(e.category); }
      byCat[e.category].push(e);
    }
    const catLabel = { panel: 'Panel infrastructure', paths: 'Data paths', credentials: 'Credentials', debug: 'Debug / runtime' };
    const rows = [];
    for (const cat of catOrder) {
      rows.push('<tr class="cat-row"><td colspan="3">' + escapeHtml(catLabel[cat] || cat) + '</td></tr>');
      let lastGroup = null;
      for (const e of byCat[cat]) {
        if (e.group && e.group !== lastGroup) {
          rows.push('<tr class="group-row"><td colspan="3">' + escapeHtml(e.group) + '</td></tr>');
          lastGroup = e.group;
        }
        const name = '<span class="env-name">' + escapeHtml(e.env) + '</span>';
        let valueCell;
        if (!e.set) {
          valueCell = '<span class="env-unset">unset</span>';
        } else if (e.sensitive && !reveal) {
          valueCell = '<span class="env-set-badge">set (hidden)</span>';
        } else if (e.sensitive && reveal) {
          valueCell = '<span class="env-masked">' + escapeHtml(e.value || '') + '</span>';
        } else {
          valueCell = '<span class="env-value">' + escapeHtml(e.value || '') + '</span>';
        }
        const labelCell = escapeHtml(e.label) +
          (e.note ? '<div class="env-note">' + escapeHtml(e.note) + '</div>' : '');
        const rowClass = 'data-row' + (e.group ? ' grouped' : '');
        rows.push('<tr class="' + rowClass + '"><td>' + name + '</td><td>' + labelCell + '</td><td>' + valueCell + '</td></tr>');
      }
    }
    mount.innerHTML = '<table class="env-table">' +
      '<thead><tr><th>Variable</th><th>Purpose</th><th>Value</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody>' +
    '</table>';
  } catch (e) {
    mount.innerHTML = '<div class="stats-empty">Failed to load env: ' + escapeHtml(e.message) + '</div>';
  }
}

async function toggleRevealEnv() {
  // Previously wrapped in confirm() — iPad Safari sometimes silently blocks
  // modal confirm() dialogs fired from click handlers (especially after any
  // browser restart), so the reveal appeared to "not work". The warning now
  // lives inline in the Environment header sub-text; tapping the button
  // flips state directly.
  const btn = document.getElementById('btnRevealCreds');
  envRevealed = !envRevealed;
  if (btn) btn.textContent = envRevealed ? 'Hide credentials' : 'Reveal credentials';
  await loadEnvTable(envRevealed);
}

function setSettingValue(path, value) {
  const f = settingsData.fields.find(x => x.path === path);
  if (!f) return;
  // If the draft matches what's already effective AND there's no existing
  // app override, treat as "no change" and drop the dirty entry.
  if (!f.overridden && value !== null && String(value) === String(f.effective)) {
    delete settingsDirty[path];
  } else {
    settingsDirty[path] = value;
  }
  updateSettingsFooter();
  // Repaint whenever a service's Active flag flips so sub-flags appear or
  // disappear (progressive disclosure). Skip for other paths so text inputs
  // don't lose focus mid-typing.
  if (/^services\\.[^.]+\\.active$/.test(path)) paintSettings();
}

async function setActiveService(id, nextActive) {
  const sites = LINKED_ACTIVE[id] || [id];
  if (!nextActive) {
    // Confirm deactivation only when ANY linked site has history to lose.
    let hasHistory = false;
    try {
      const byService = await api('GET', '/stats/by-service');
      hasHistory = sites.some(sid => {
        const row = byService.find(r => r.id === sid);
        return row && ((typeof row.allTime === 'number' && row.allTime > 0) || row.lastClaimAt);
      });
    } catch {}
    if (hasHistory) {
      const label = ({
        'prime-gaming': 'Prime Gaming', 'epic-games': 'Epic Games', 'gog': 'GOG', 'steam': 'Steam',
        'microsoft': 'Microsoft Rewards', 'aliexpress': 'AliExpress',
      })[id] || id;
      const ok = confirm('Deactivate ' + label + '?\\n\\nClaim history already on record will be preserved, but scheduled runs will skip this service until you reactivate it.');
      if (!ok) { paintSettings(); return; }
    }
  }
  for (const siteId of sites) setSettingValue('services.' + siteId + '.active', nextActive);
  paintSettings();
}

function revertSettingValue(path) {
  const f = settingsData.fields.find(x => x.path === path);
  if (!f) return;
  if (f.overridden) {
    // Remove the on-disk override — queue a null patch.
    settingsDirty[path] = null;
  } else {
    // Just drop any in-flight edit.
    delete settingsDirty[path];
  }
  paintSettings();
}

function updateSettingsFooter() {
  const footer = document.getElementById('settingsFooter');
  const counter = document.getElementById('dirtyCount');
  if (!footer || !counter) return;
  const n = Object.keys(settingsDirty).length;
  if (n === 0) {
    footer.style.display = 'none'; // idle → footer disappears entirely
    return;
  }
  footer.style.display = 'flex';
  counter.textContent = n + ' unsaved change' + (n === 1 ? '' : 's');
}

function discardSettings() {
  settingsDirty = {};
  paintSettings();
}

async function saveSettings() {
  const btn = document.getElementById('btnSaveSettings');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await api('PUT', '/config', settingsDirty);
    if (res && res.errors) {
      showToast('Some changes failed: ' + res.errors.map(e => e.path + ' (' + e.error + ')').join('; '), 'error', 6000);
      return;
    }
    settingsData = res;
    settingsDirty = {};
    paintSettings();
    showToast('Settings saved. Scheduler changes apply after a restart.', 'success');
  } catch (e) {
    showToast('Save failed: ' + (e && e.message || 'unknown error'), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function testNotify() {
  const btn = document.getElementById('btnTestNotify');
  if (!btn) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await api('POST', '/notifications/test');
    if (res && res.ok) showToast('Test notification sent', 'success');
    else showToast('Test failed: ' + (res && res.error || 'unknown error'), 'error', 6000);
  } catch (e) {
    showToast('Test failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
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
// Uses slice(0, 16) rather than a \d regex — PANEL_HTML is itself a backtick
// template literal, and "\d" inside it is treated as an unknown escape and
// stripped, producing /^(d{4}-...)/ which never matches.
function formatTimestamp(ts, style) {
  if (!ts) return '';
  if (style === 'relative') return relativeTime(ts);
  return String(ts).replace('T', ' ').slice(0, 16);
}

// HTML+CSS 30-day bar chart. An earlier SVG version used
// preserveAspectRatio="none" to stretch bars to fill the container width,
// which also stretched the axis text glyphs horizontally — the bug the user
// reported as "font stretching". Pure HTML sidesteps that entirely: bars flex
// to fit, labels render at natural font metrics.
function renderDailyChart(daily) {
  if (!daily.length) return '<div class="stats-empty">No data yet.</div>';
  const rawMax = Math.max.apply(null, daily.map(d => d.count).concat(0));
  const step = rawMax <= 4 ? 1 : rawMax <= 10 ? 2 : rawMax <= 20 ? 5 : rawMax <= 50 ? 10 : 20;
  const yMax = Math.max(step, Math.ceil(rawMax / step) * step);
  const yTicks = [];
  for (let v = 0; v <= yMax; v += step) yTicks.push('<span>' + v + '</span>');
  const bars = daily.map(d => {
    const pct = (d.count / yMax) * 100;
    const cls = d.count === 0 ? ' zero' : '';
    return '<div class="bar' + cls + '" style="height:' + pct + '%" title="' + d.date + ': ' + d.count + '"></div>';
  }).join('');
  // Weekly ticks anchored at today's right edge. Empty xtick slots keep each
  // bar column aligned with its flex cell (preserving 1:1 bar<->label mapping).
  const labelIdx = new Set();
  for (let i = daily.length - 1; i >= 0; i -= 7) labelIdx.add(i);
  const xLabels = daily.map((_, i) => {
    const md = labelIdx.has(i) ? daily[i].date.slice(5) : '';
    return '<span class="xtick">' + md + '</span>';
  }).join('');
  return '<div class="chart-plot">' +
    '<div class="chart-y-axis">' + yTicks.join('') + '</div>' +
    '<div class="chart-area">' +
      '<div class="chart-bars">' + bars + '</div>' +
      '<div class="chart-x-axis">' + xLabels + '</div>' +
    '</div>' +
  '</div>';
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
    const unitSuffix = u => u === 'points' ? ' pts' : u === 'coins' ? ' coins' : '';
    const unitPlaceholder = u => u === 'points'
      ? 'points-based — balance appears after the next microsoft run'
      : u === 'coins'
        ? 'coins-based — appears after enabling AliExpress and running once'
        : u + '-based';
    const rows = byService.map(r => {
      const last = r.lastClaimAt
        ? '<span title="' + escapeHtml(r.lastClaimAt) + '">' + escapeHtml(formatTimestamp(r.lastClaimAt, 'relative')) + '</span>'
        : '<span class="muted">—</span>';
      const unit = r.unit || 'games';
      const isGame = unit === 'games';
      if (!isGame && !r.lastClaimAt) {
        return '<tr><td>' + escapeHtml(r.name) + '</td>' +
          '<td colspan="4" class="muted note">' + unitPlaceholder(unit) + '</td></tr>';
      }
      const suffix = unitSuffix(unit);
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
  // Interval row: pure LOOP description. MS-window info moved into the
  // Services row below so the two schedules show side-by-side.
  let intervalText;
  if (state.loopSeconds > 0) {
    const hrs = state.loopSeconds / 3600;
    if (hrs >= 1 && Number.isInteger(hrs)) intervalText = 'Every ' + hrs + ' hour' + (hrs === 1 ? '' : 's');
    else if (state.loopSeconds >= 60) intervalText = 'Every ' + Math.round(state.loopSeconds / 60) + ' minutes';
    else intervalText = 'Every ' + state.loopSeconds + ' seconds';
  } else if (state.msScheduleHours > 0) {
    intervalText = 'Anchored to Microsoft Rewards window (see Services below)';
  } else {
    intervalText = 'Not scheduled — set LOOP or enable Microsoft Rewards';
  }
  parts.push('<div class="sched-row"><div class="sched-label">Interval</div><div class="sched-value">' + intervalText + '</div></div>');

  // Services row: enumerate each active service and the behaviour it'll
  // exhibit on the next scheduled fire. Inactive services don't appear —
  // users deactivate to have them stop, so the schedule reflects reality.
  // microsoft-mobile is linked to microsoft in the UI, so we skip it here.
  const GAME_IDS = new Set(['prime-gaming', 'epic-games', 'gog', 'steam']);
  const sites = state.sites || [];
  const activeGames = sites.filter(s => s.active && GAME_IDS.has(s.id));
  const hasAE = sites.some(s => s.active && s.id === 'aliexpress');
  const hasMS = sites.some(s => s.active && s.id === 'microsoft');
  const activeCount = activeGames.length + (hasAE ? 1 : 0) + (hasMS ? 1 : 0);

  const svcLines = [];
  if (activeGames.length) {
    svcLines.push('<b>' + activeGames.map(s => escapeHtml(s.name)).join(', ') + '</b> — claim any available games');
  }
  if (hasAE) {
    svcLines.push('<b>AliExpress</b> — collect daily check-in coins <span class="muted">(no specific window; runs on each scheduled fire)</span>');
  }
  if (hasMS) {
    const w = state.msScheduleHours || 0;
    const s = state.msScheduleStart || 0;
    if (w > 0) {
      const fmt = h => String(h).padStart(2, '0') + ':00';
      svcLines.push('<b>Microsoft Rewards</b> — waits for <b>' + fmt(s) + ' → ' + fmt((Number(s) + Number(w)) % 24) + '</b> window each run, then searches');
    } else {
      svcLines.push('<b>Microsoft Rewards</b> — runs searches immediately (no window)');
    }
  }
  if (svcLines.length) {
    parts.push('<div class="sched-row"><div class="sched-label">Services (' + activeCount + ' active)</div>' +
      '<ul class="sched-services">' + svcLines.map(l => '<li>' + l + '</li>').join('') + '</ul></div>');
  } else {
    parts.push('<div class="sched-row"><div class="sched-label">Services</div><div class="sched-value muted">None active — enable services in Settings → Services.</div></div>');
  }

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
        const t = (l.time && String(l.time).slice(11, 19)) || '';
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
  // during an active login or while the user is watching the browser so the
  // VNC iframe has more room.
  steps.style.display = (state.allLoggedIn || state.activeBrowser || userShowBrowser) ? 'none' : 'flex';
  cards.style.display = (state.activeBrowser || userShowBrowser) ? 'none' : 'grid';

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
  const btnShowBrowser = document.getElementById('btnShowBrowser');
  if (btnShowBrowser) {
    // Login + batch-redeem flows already mount the iframe themselves and
    // would break if we removed it — show the button disabled with a label
    // that matches the actual state.
    const ownedElsewhere = !!(state.activeBrowser || state.batchRedeem);
    btnShowBrowser.disabled = ownedElsewhere;
    btnShowBrowser.textContent = ownedElsewhere ? 'Browser shown' : (userShowBrowser ? 'Hide browser' : 'Show browser');
    btnShowBrowser.classList.toggle('active', userShowBrowser || ownedElsewhere);
  }

  const placeholder = document.getElementById('vncPlaceholder');
  if (placeholder && !state.activeBrowser && !state.batchRedeem && !showingLog && !userShowBrowser) {
    placeholder.style.display = 'flex';
    const wrap = inner => '<div style="max-width:520px;font-size:14px;line-height:1.7;color:#a0b4d4">' + inner + '</div>';
    if (state.startupAutoCheck) {
      placeholder.innerHTML = wrap('Checking sessions (' + state.startupAutoCheck.current + '/' + state.startupAutoCheck.total + ')…');
    } else if (state.allLoggedIn && state.sites.length > 0) {
      // Status strip in the header already communicates "all sessions OK" —
      // don't repeat it here. Just explain what this empty space is for.
      placeholder.innerHTML = wrap(
        'Click <b style="color:#e0e0e0">Run Now</b> to trigger an immediate claim, or let the scheduler (if enabled) handle it.<br><br>' +
        'The browser login view will appear here when you click <b style="color:#e0e0e0">Login</b> on any session card; ' +
        'the claim log appears here during a run.'
      );
    } else {
      const activeSites = state.sites.filter(s => s.active !== false);
      const need = activeSites.filter(s => s.status === 'not_logged_in').length;
      const total = activeSites.length;
      if (need > 0) {
        placeholder.innerHTML = wrap(
          '<b style="color:#e94560">' + need + ' of ' + total + ' session' + (total === 1 ? '' : 's') + ' need' + (need === 1 ? 's' : '') + ' login.</b><br><br>' +
          'Click <b style="color:#e0e0e0">Login</b> on a red card — the browser will appear here so you can sign in (captchas, MFA, etc.).<br>' +
          'When done, click <span class="highlight">"I\\'m Logged In"</span> to save the session.'
        );
      } else {
        // Sites haven't all settled yet (some 'unknown' or 'error') and the
        // startupAutoCheck flag isn't set — render a neutral message rather
        // than the stale tutorial that used to live here.
        placeholder.innerHTML = wrap('Checking sessions…');
      }
    }
  }

  // Status strip — one line that rolls up the old green banner + "Next run" line.
  // Counts active services only; deactivated ones don't affect "All sessions OK".
  const activeSites = state.sites.filter(s => s.active !== false);
  const totalCount = activeSites.length;
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
  } else if (activeSites.some(s => s.status === 'not_logged_in')) {
    stripKind = 'err';
    const missing = activeSites.filter(s => s.status === 'not_logged_in').map(s => s.name).join(', ');
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

  // Split sites into active (main grid) and inactive (drawer below).
  const activeCards = state.sites.filter(s => s.active !== false);
  const inactiveCards = state.sites.filter(s => s.active === false);

  cards.innerHTML = activeCards.map(s => {
    const dotClass = s.status === 'logged_in' ? 'logged-in' : s.status === 'not_logged_in' ? 'not-logged-in' : s.status === 'error' ? 'error' : 'unknown';
    const statusClass = dotClass;
    let statusText = 'Not checked';
    if (s.status === 'logged_in') statusText = 'Logged in' + (s.user ? ' as ' + s.user : '');
    else if (s.status === 'not_logged_in') statusText = 'Not logged in';
    else if (s.status === 'error') statusText = 'Error checking';
    if (s.checkedAt) statusText += ' (' + String(s.checkedAt).slice(11, 19) + ')';
    return '<div class="site-card">' +
      '<div class="site-card-header">' +
        '<div class="dot ' + dotClass + '"></div>' +
        '<div class="name">' + s.name + '</div>' +
      '</div>' +
      '<div class="status ' + statusClass + '">' + statusText + '</div>' +
      '<div class="card-actions">' +
        '<button class="btn btn-login" onclick="launchSite(\\'' + s.id + '\\')" ' + (disabled ? 'disabled' : '') + '>Login</button>' +
        '<button class="btn btn-check" onclick="checkSite(\\'' + s.id + '\\')" ' + (disabled ? 'disabled' : '') + '>Check</button>' +
        '<button class="btn btn-run-single" onclick="runSite(\\'' + s.id + '\\')" ' + (disabled ? 'disabled' : '') + ' title="Run this service now">Run</button>' +
      '</div>' +
    '</div>';
  }).join('');

  // "Available services" drawer — inactive sites with a single Enable button.
  const drawer = document.getElementById('availableDrawer');
  if (drawer) {
    if (inactiveCards.length === 0) {
      drawer.style.display = 'none';
    } else {
      drawer.style.display = 'block';
      // localStorage gates whether the drawer opens expanded the first time.
      // Once the user interacts (expand or enable), it stays collapsed on
      // subsequent visits.
      const interacted = localStorage.getItem('drawerSeen') === '1';
      const expanded = !interacted;
      const cardsHtml = inactiveCards.map(s =>
        '<div class="site-card card-inactive">' +
          '<div class="site-card-header">' +
            '<div class="dot unknown"></div>' +
            '<div class="name">' + s.name + '</div>' +
          '</div>' +
          '<div class="status">Not active — enable to start using this service.</div>' +
          '<div class="card-actions">' +
            '<button class="btn btn-run" onclick="enableService(\\'' + s.id + '\\')">Enable</button>' +
          '</div>' +
        '</div>'
      ).join('');
      drawer.innerHTML =
        '<button class="drawer-head" onclick="toggleAvailableDrawer()" aria-expanded="' + expanded + '">' +
          '<span class="caret">' + (expanded ? '▾' : '▸') + '</span> ' +
          inactiveCards.length + ' service' + (inactiveCards.length === 1 ? '' : 's') + ' available' +
        '</button>' +
        '<div class="drawer-body" ' + (expanded ? '' : 'hidden') + '>' + cardsHtml + '</div>';
    }
  }

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

// Build the noVNC URL appropriate for the current deployment. Used both by
// the embedded iframe and the "Pop out" new-tab button so they stay in sync.
// Through a reverse proxy (BASE_PATH set) noVNC is proxied at BASE_PATH/novnc/
// and the WebSocket path must be told to noVNC explicitly — by default it
// assumes "/websockify" at the origin root, which won't exist when proxied at
// a subfolder. For direct access (no BASE_PATH) the container's noVNC port is
// reachable at the same host.
function buildNovncUrl() {
  if (BASE_PATH) {
    const wsPath = BASE_PATH.replace(/^\\//, '') + '/novnc/websockify';
    return BASE_PATH + '/novnc/vnc.html?autoconnect=true&resize=scale&path=' + encodeURIComponent(wsPath);
  }
  return location.protocol + '//' + location.hostname + ':' + NOVNC_PORT + '/vnc.html?autoconnect=true&resize=scale';
}

function showVnc() {
  hideRunLog();
  const container = document.getElementById('vncContainer');
  const placeholder = document.getElementById('vncPlaceholder');
  if (placeholder) placeholder.style.display = 'none';
  if (!container.querySelector('iframe')) {
    const iframe = document.createElement('iframe');
    iframe.src = buildNovncUrl();
    container.appendChild(iframe);
  }
}

function popoutBrowser() {
  window.open(buildNovncUrl(), '_blank', 'noopener');
}

function hideVnc() {
  const container = document.getElementById('vncContainer');
  const iframe = container.querySelector('iframe');
  if (iframe) iframe.remove();
  const placeholder = document.getElementById('vncPlaceholder');
  if (placeholder) placeholder.style.display = 'flex';
  // Iframe was just removed externally (login ended, batch finished). The
  // user-toggle state must follow or the button label will lie.
  userShowBrowser = false;
}

// Header "Show browser" toggle. Lets the user peek at the live noVNC view
// regardless of run state — during a claim run the iframe normally gets
// swapped out for the run log, but the user may want to see what the
// browser is actually doing (e.g. when MS card clicks all time out).
// No-op during active login / batch redeem — those flows own the iframe
// and removing it here would break them.
function toggleBrowserView() {
  if (state.activeBrowser || state.batchRedeem) return;
  userShowBrowser = !userShowBrowser;
  if (userShowBrowser) {
    showVnc(); // mounts iframe; also calls hideRunLog() which hides the log el
  } else {
    const container = document.getElementById('vncContainer');
    const iframe = container.querySelector('iframe');
    if (iframe) iframe.remove();
    // Restore run log if a run is in progress; render() will show the
    // placeholder otherwise.
    if (state.runStatus === 'running') showRunLog();
  }
  render();
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
        const timeSpan = '<span class="time">' + (l.time ? String(l.time).slice(11, 19) : '') + '</span>';
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

async function runSite(siteId) {
  const siteName = state.sites.find(s => s.id === siteId)?.name || siteId;
  busy = true; render();
  try {
    const r = await api('POST', '/run-service', { site: siteId });
    if (r && r.success === false) {
      showToast(r.error || 'Run failed', 'error', 5000);
    } else {
      showToast('Started ' + siteName + ' — open the Logs tab to watch output.', 'success', 4000);
    }
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
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(LOGIN_HTML);
        return;
      }
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
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

    if (req.method === 'POST' && req.url === '/api/run-service') {
      try {
        const body = await parseBody(req);
        const site = body && body.site;
        if (!site || typeof site !== 'string') {
          sendJson(res, { success: false, error: 'site required (e.g. {"site": "microsoft"})' }, 400);
          return;
        }
        // microsoft and microsoft-mobile are both served by microsoft.js;
        // passing either ID runs the shared script once.
        const result = runAllScripts({ source: 'panel', sites: [site] });
        sendJson(res, result);
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/api/run-log')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const since = parseInt(url.searchParams.get('since') || '0', 10);
      sendJson(res, { lines: runLog.slice(since), total: runLog.length, status: runStatus });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/notifications/test') {
      // Use describeConfig rather than cfg.* so the test picks up whatever is
      // currently in data/config.json — cfg was baked at process boot and
      // won't see post-boot edits without a restart.
      const { effective } = describeConfig();
      const url = effective.notifications && effective.notifications.notify;
      const title = (effective.notifications && effective.notifications.notifyTitle) || 'Free Games Claimer';
      if (!url) { sendJson(res, { ok: false, error: 'No NOTIFY URL configured' }, 400); return; }
      const html = '<p>Test notification from Free Games Claimer panel at ' + datetime() + '.</p>';
      const args = [url, '-i', 'html', '-t', title + ' — test', '-b', html];
      execFile('apprise', args, (err, stdout, stderr) => {
        if (err) { sendJson(res, { ok: false, error: stderr || err.message }, 500); return; }
        sendJson(res, { ok: true });
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/config') {
      sendJson(res, describeConfig());
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/env')) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const reveal = url.searchParams.get('reveal') === '1';
      sendJson(res, { env: describeEnv({ reveal }) });
      return;
    }
    if (req.method === 'PUT' && req.url === '/api/config') {
      try {
        const body = await parseBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, { error: 'body must be a JSON object of path→value (value=null removes override)' }, 400);
          return;
        }
        const { errors } = patchConfig(body);
        if (errors.length) { sendJson(res, { errors }, 400); return; }
        // Return the fresh merged view so clients can replace their in-memory
        // state with a single response.
        sendJson(res, describeConfig());
      } catch (e) {
        sendJson(res, { error: e.message }, 400);
      }
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
  const active = activeServices();
  const siteIds = Object.keys(SITES).filter(id => active.has(id));
  startupAutoCheck = { current: 0, total: siteIds.length, siteName: '' };
  for (const siteId of siteIds) {
    startupAutoCheck.siteName = SITES[siteId].name;
    await checkSiteStatus(siteId);
    startupAutoCheck.current++;
  }
  startupAutoCheck = null;
  console.log(`[${datetime()}] Auto-check complete (${siteIds.length} active, ${Object.keys(SITES).length - siteIds.length} skipped).`);

  // Kick off the scheduler after session auto-check so first run sees fresh
  // status. The loop always starts — when both LOOP and MS_SCHEDULE_HOURS
  // resolve to 0 it parks in sleepUntilWakeup and wakes on config change via
  // watchConfigForScheduler().
  schedulerLoop().catch(err => {
    console.error(`[${datetime()}] Scheduler crashed:`, err);
  });
  watchConfigForScheduler();
});
