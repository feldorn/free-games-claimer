import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { watch, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __panelDirname = path.dirname(fileURLToPath(import.meta.url));
import { chromium } from 'patchright';
import { datetime, notify, jsonDb, normalizeTitle } from './src/util.js';
import { cfg } from './src/config.js';
import { describeConfig, patchConfig, describeEnv, getSchedulerConfig, CONFIG_FILE_PATH } from './src/app-config.js';
import { SITES as SITE_REGISTRY, getLoginSitesById, getClaimScriptOrder, getLinkedActiveMap, getClaimDbFiles, getServiceRows } from './src/sites.js';

const PANEL_PORT = Number(process.env.PANEL_PORT) || 7080;
const NOVNC_PORT = process.env.NOVNC_PORT || 6080;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || process.env.VNC_PASSWORD || '';
const BASE_PATH = cfg.base_path; // e.g. "/free-games" when behind a subfolder proxy, or ""
const PUBLIC_URL = cfg.public_url || `http://localhost:${PANEL_PORT}${BASE_PATH}`;
const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(__panelDirname, 'package.json'), 'utf8')).version || ''; }
  catch { return ''; }
})();

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
<title>Sign in — Feldorn's Free Games Claimer</title>
<link rel="icon" type="image/x-icon" href="${BASE_PATH}/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="${BASE_PATH}/assets/icon-32.png">
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

// SITES is sourced from src/sites.js (Phase 0 of the engine refactor —
// issue #11). The local binding is the login-capable subset, matching the
// previous shape (id-keyed object containing only services with a
// checkLogin function). Future commits migrate CLAIM_SCRIPT_ORDER,
// activeServices(), CONFIG_SCHEMA, SERVICE_ROWS, etc. to derive from the
// full registry too.
const SITES = getLoginSitesById();

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
      viewport: { width: cfg.width, height: cfg.height },
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

// Cookie import — accepts a JSON-array cookie export (EditThisCookie /
// Cookie-Editor browser extensions both produce this shape with minor
// field-name variation), normalizes to Playwright's addCookies signature,
// validates that at least one cookie's domain matches the target site,
// applies them via a fresh persistent context against the site's
// browserDir, then re-runs checkSiteStatus to confirm the session was
// activated. Used by the Sessions-tab "↑ Cookie" button on each card.
const COOKIE_MAX_COUNT = 500;
const COOKIE_MAX_BYTES = 256 * 1024;

function normalizeCookieEntry(c) {
  if (!c || typeof c !== 'object') return null;
  if (!c.name || c.value == null || !c.domain) return null;
  const out = {
    name: String(c.name),
    value: String(c.value),
    domain: String(c.domain),
    path: c.path ? String(c.path) : '/',
  };
  // EditThisCookie uses expirationDate (seconds since epoch as float);
  // Playwright wants `expires` as a number (-1 means session cookie).
  const expRaw = c.expires != null ? c.expires : c.expirationDate;
  if (expRaw != null) {
    const n = Number(expRaw);
    if (Number.isFinite(n)) out.expires = Math.floor(n);
  }
  if (c.httpOnly) out.httpOnly = true;
  if (c.secure)   out.secure = true;
  if (c.sameSite) {
    const s = String(c.sameSite).toLowerCase();
    out.sameSite = s === 'strict' ? 'Strict' : s === 'none' ? 'None' : 'Lax';
  }
  return out;
}

async function importSiteCookies(siteId, rawCookies) {
  const site = SITES[siteId];
  if (!site) throw new Error(`Unknown site: ${siteId}`);
  if (!site.loginUrl) throw new Error(`${site.name} has no login flow — cookie import doesn't apply`);

  const busy = browserBusy({ allowActiveBrowser: true });
  if (busy) throw new Error(`Cannot import cookies — ${busy}.`);
  if (activeBrowser) await closeBrowser();

  // Coerce single-cookie object into a one-element array; reject anything
  // that isn't object-or-array.
  let arr = rawCookies;
  if (!Array.isArray(arr)) {
    if (arr && typeof arr === 'object') arr = [arr];
    else throw new Error('cookies must be a JSON array of cookie objects');
  }
  if (arr.length === 0) throw new Error('no cookies in upload');
  if (arr.length > COOKIE_MAX_COUNT) throw new Error(`too many cookies (${arr.length} > ${COOKIE_MAX_COUNT})`);

  // Approximate byte cap to prevent runaway uploads. JSON-stringify is
  // the cheapest way to count without storing payloads server-side.
  const approxBytes = JSON.stringify(arr).length;
  if (approxBytes > COOKIE_MAX_BYTES) throw new Error(`cookie payload too large (${approxBytes} > ${COOKIE_MAX_BYTES} bytes)`);

  const normalized = arr.map(normalizeCookieEntry).filter(Boolean);
  if (!normalized.length) throw new Error('no valid cookies (each cookie needs name, value, and domain)');

  // Domain match: cookie domain (with or without leading dot) must be
  // a suffix of the site's loginUrl host. Catches the common foot-gun
  // of pasting cookies for the wrong site into the wrong card.
  const targetHost = new URL(site.loginUrl).hostname;
  const matches = normalized.filter(c => {
    const cd = c.domain.replace(/^\./, '');
    return targetHost === cd || targetHost.endsWith('.' + cd);
  });
  if (!matches.length) {
    const sample = normalized[0].domain;
    throw new Error(`no cookies for ${targetHost} (uploaded cookies appear to be for ${sample})`);
  }

  console.log(`[${datetime()}] Importing ${normalized.length} cookie(s) into ${site.name} profile (${matches.length} match host ${targetHost})`);
  let context;
  try {
    context = await chromium.launchPersistentContext(site.browserDir, {
      headless: false,
      viewport: { width: cfg.width, height: cfg.height },
      locale: 'en-US',
      handleSIGINT: false,
      args: ['--hide-crash-restore-bubble'],
      ...(site.contextOptions || {}),
    });
    await context.addCookies(normalized);
  } finally {
    if (context) { try { await context.close(); } catch {} }
  }

  // Re-check the session so the Sessions card flips to "logged in" if
  // the cookies actually activated a session, or stays at "not logged
  // in" if they didn't (expired, missing the auth cookie, etc.).
  const checkResult = await checkSiteStatus(siteId);
  return {
    applied: normalized.length,
    matchedDomain: matches.length,
    targetHost,
    loggedIn: !!checkResult.loggedIn,
    user: checkResult.user || null,
  };
}

let runProcess = null;
let runDone = null; // Promise that resolves when runProcess finishes (for scheduler to await)
let runLog = [];
let runStatus = 'idle';
let runSource = null; // 'panel' | 'scheduler'
let lastRun = null; // { at, source, exitCode, status, startedAt, durationSec }
let runStartedAt = null;
// Set when a runner script emits [CAPTCHA-START] on stdout, cleared on
// [CAPTCHA-END] or run process exit. Drives the captcha banner + the
// ?focus=captcha deep link target. { service, label, since } when active.
let captchaPending = null;
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
// Claim script order is derived from src/sites.js (Phase 0 of the engine
// refactor — issue #11). Each registry entry carries a claimOrder integer;
// getClaimScriptOrder() filters to entries with a script and sorts by it.
// microsoft.js is intentionally last (claimOrder 7) — it has an internal
// wait-until-window that blocks the process; running it after everything
// else lets the rest finish promptly. microsoft.js is shared between the
// 'microsoft' (desktop) and 'microsoft-mobile' site cards — invoked once
// via the linkedWith pointer and runs both sessions internally.
const CLAIM_SCRIPT_ORDER = getClaimScriptOrder();

// The valid-service enum and opt-in defaults are sourced from the registry
// (src/sites.js — Phase 0 of #11). Each entry's defaultActive flag drives
// the fallback when no config or env value is present: false means opt-in
// (aliexpress, ubisoft today), true means default-on (the rest).
function activeServices() {
  const svc = describeConfig().effective.services || {};
  const isActive = entry => {
    const s = svc[entry.id];
    if (s && typeof s.active === 'boolean') return s.active;
    return entry.defaultActive;
  };
  return new Set(SITE_REGISTRY.filter(isActive).map(s => s.id));
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
  if (steamRedeem && steamRedeem.phase !== 'done' && steamRedeem.phase !== 'stopped' && steamRedeem.phase !== 'error') {
    return 'Steam batch redeem in progress';
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

// ----- Steam batch redeem -----
// Drives store.steampowered.com/account/registerkey for each pending Steam
// key found across any service's claim DB (CLAIM_DB_FILES). An entry is
// "pending" when it has store=steampowered.com, a code, and the status
// hasn't already been marked redeemed/expired/invalid/locked. Steam's
// activation page returns a structured AJAX JSON response we intercept
// to determine outcome; we cross-check ambiguous "already_owned" cases
// only via response text since Steam responses are usually unambiguous
// (no library cross-check, unlike GOG where code_used is overloaded).
//
// Anti-bot: Steam occasionally serves a captcha mid-batch and rate-limits
// after ~10 failed attempts in a short window. Captcha → pause and let
// the user solve via VNC, same pattern as GOG. Rate-limit → bail the
// batch so we don't burn through more keys than necessary.
let steamRedeem = null;

const STEAM_REDEEM_URL = 'https://store.steampowered.com/account/registerkey';
const STEAM_AJAX_URL = 'https://store.steampowered.com/account/ajaxregisterkey/';

function collectPendingSteamCodes(dbs) {
  const pending = [];
  for (const [dbFile, db] of Object.entries(dbs)) {
    for (const [user, games] of Object.entries(db.data || {})) {
      if (!games || typeof games !== 'object') continue;
      for (const [title, entry] of Object.entries(games)) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.store !== 'steampowered.com' || !entry.code) continue;
        if (/redeemed|expired|invalid|locked|not available/i.test(String(entry.status || ''))) continue;
        pending.push({ db, dbFile, user, title, entry });
      }
    }
  }
  return pending;
}

async function countPendingSteamCodes() {
  try {
    const dbs = {};
    for (const file of Object.values(getClaimDbFiles())) {
      try { dbs[file] = await jsonDb(file, {}); } catch { /* DB doesn't exist yet */ }
    }
    return collectPendingSteamCodes(dbs).length;
  } catch {
    return 0;
  }
}

// Parse Steam's ajaxregisterkey JSON response into a normalized outcome.
// The actual discriminator is `purchase_result_details` (Steam's enum)
// — not `success`, which is just 1 (any success) / 2 (any failure).
// `error_text` is reliably populated only for a small subset of failures;
// most go through the numeric detail code with empty error_text. Codes
// observed in this account's test run plus documented values:
//   0   NoDetail (paired with success=1 → genuine activation)
//   5   InvalidKey
//   9   AlreadyOwned by this account
//   14  alternate already-owned bucket some packages return
//   15  AlreadyActivatedDifferentAccount
//   24  RegionLocked / not available in this country
//   36  ItemAlreadyClaimed
//   50  ExpiredCdKey
//   53  RateLimitExceeded
//   71  RestrictedCountry
function classifySteamResponse(json) {
  if (!json || typeof json !== 'object') return { outcome: 'unknown', raw: json };
  const success = Number(json.success);
  const detail = Number(
    json.purchase_result_details ??
    json.purchase_receipt_info?.result_detail,
  );
  const productTitle = json.purchase_receipt_info?.line_items?.[0]?.line_item_description || null;
  const errText = String(json.error_text || json.errorText || '').toLowerCase();

  // Genuine new activation: success=1 with no failure detail.
  if (success === 1 && (!Number.isFinite(detail) || detail === 0)) {
    return { outcome: 'redeemed', productTitle };
  }

  switch (detail) {
    case 5:  return { outcome: 'invalid',        productTitle };
    case 9:  return { outcome: 'already-owned',  productTitle };
    case 14: return { outcome: 'already-owned',  productTitle };
    case 15: return { outcome: 'used-elsewhere', productTitle };
    case 24: return { outcome: 'region-locked',  productTitle };
    case 36: return { outcome: 'used-elsewhere', productTitle };
    case 50: return { outcome: 'invalid',        productTitle };
    case 53: return { outcome: 'rate-limited',   productTitle };
    case 71: return { outcome: 'region-locked',  productTitle };
  }

  // Fall back to error_text matching for any code not enumerated above.
  if (errText.includes('already activated by a different steam account')) return { outcome: 'used-elsewhere', productTitle };
  if (errText.includes('already owns') || errText.includes('already in your steam library')) return { outcome: 'already-owned', productTitle };
  if (errText.includes('not valid') || errText.includes('does not appear to be valid') || errText.includes('expired')) return { outcome: 'invalid', productTitle };
  if (errText.includes('not available') || errText.includes('region')) return { outcome: 'region-locked', productTitle };
  if (errText.includes('too many') || errText.includes('try again later')) return { outcome: 'rate-limited', productTitle };
  if (errText.includes('captcha')) return { outcome: 'captcha', productTitle };

  return { outcome: 'unknown', raw: json };
}

async function processOneSteamKey(page, key) {
  await page.goto(STEAM_REDEEM_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  // The activation form is straightforward: product_key input, agreement
  // checkbox (not always present on every account), and #register_btn.
  try { await page.fill('#product_key', key); } catch (e) {
    return { outcome: 'error', error: 'product_key input not found: ' + e.message };
  }
  try { await page.check('#accept_ssa'); } catch { /* checkbox not always present */ }
  const respPromise = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().startsWith(STEAM_AJAX_URL),
    { timeout: 30000 },
  ).catch(() => null);
  try {
    if (await page.locator('#register_btn').count() > 0) await page.click('#register_btn');
    else if (await page.locator('button:has-text("Continue")').count() > 0) await page.click('button:has-text("Continue")');
    else await page.click('button[type="submit"], a.btnv6_blue_hoverfade');
  } catch (e) {
    return { outcome: 'error', error: 'register button click failed: ' + e.message };
  }
  const resp = await respPromise;
  if (!resp) return await scrapeDomOutcome(page);
  let json = {};
  try { json = await resp.json(); } catch { json = {}; }
  const result = classifySteamResponse(json);
  if (result.outcome === 'unknown') {
    // Augment with DOM scrape — covers any future success=2 case where
    // the JSON shape changes but Steam still renders a recognizable
    // error in the page text.
    const dom = await scrapeDomOutcome(page);
    if (dom.outcome !== 'unknown') return dom;
    // Log just enough to diagnose if we ever miss a code in the wild —
    // not the full body since that includes packageids and timestamps.
    console.log(`[${datetime()}] Steam redeem: unknown response — success=${json.success} detail=${json.purchase_result_details ?? json.purchase_receipt_info?.result_detail} errText="${(json.error_text || '').slice(0, 100)}"`);
  }
  return result;
}

async function scrapeDomOutcome(page) {
  try {
    if (await page.locator('text=/Welcome to your new game|Your transaction is complete/i').count() > 0) {
      return { outcome: 'redeemed', productTitle: null };
    }
    if (await page.locator('text=/already owns this product|already in your Steam library/i').count() > 0) {
      return { outcome: 'already-owned' };
    }
    if (await page.locator('text=/already activated by a different/i').count() > 0) {
      return { outcome: 'used-elsewhere' };
    }
    if (await page.locator('text=/not valid|expired|incorrect/i').count() > 0) {
      return { outcome: 'invalid' };
    }
    if (await page.locator('text=/not available .* country|region/i').count() > 0) {
      return { outcome: 'region-locked' };
    }
    if (await page.locator('text=/too many .* attempts|try again later/i').count() > 0) {
      return { outcome: 'rate-limited' };
    }
  } catch { /* selector errors fall through */ }
  return { outcome: 'unknown' };
}

async function waitForSteamCaptchaResolution(page) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (!steamRedeem || steamRedeem.phase === 'stopped') return 'stopped';
    const dom = await scrapeDomOutcome(page).catch(() => ({ outcome: 'unknown' }));
    if (dom.outcome !== 'unknown' && dom.outcome !== 'captcha') return dom.outcome;
    await new Promise(r => setTimeout(r, 2000));
  }
  return 'timeout';
}

async function runSteamRedeemLoop() {
  while (steamRedeem && steamRedeem.index < steamRedeem.pending.length && steamRedeem.phase !== 'stopped') {
    const { db, title, entry } = steamRedeem.pending[steamRedeem.index];
    steamRedeem.currentTitle = title;
    steamRedeem.currentCode = entry.code;
    steamRedeem.message = `Processing ${title}…`;
    steamRedeem.updatedAt = datetime();

    let result;
    try {
      result = await processOneSteamKey(steamRedeem.page, entry.code);
    } catch (e) {
      console.error(`[${datetime()}] Steam redeem: ${title} — ${e.message}`);
      result = { outcome: 'error', error: e.message };
    }

    let finalOutcome = result.outcome;
    if (result.outcome === 'captcha') {
      steamRedeem.phase = 'awaiting-captcha';
      steamRedeem.message = `Solve captcha for "${title}" in the browser — auto-continuing when done.`;
      steamRedeem.updatedAt = datetime();
      finalOutcome = await waitForSteamCaptchaResolution(steamRedeem.page);
      if (finalOutcome === 'stopped') break;
      steamRedeem.phase = 'running';
    }

    if (finalOutcome === 'redeemed') {
      entry.status = 'claimed and redeemed (Steam batch)';
      steamRedeem.stats.redeemed++;
    } else if (finalOutcome === 'already-owned') {
      entry.status = 'claimed and redeemed (Steam: already owned)';
      steamRedeem.stats.alreadyOwned++;
    } else if (finalOutcome === 'used-elsewhere') {
      entry.status = 'claimed, code activated on a different Steam account';
      steamRedeem.stats.usedElsewhere++;
    } else if (finalOutcome === 'invalid') {
      entry.status = 'claimed, code expired or invalid (Steam)';
      steamRedeem.stats.invalid++;
    } else if (finalOutcome === 'region-locked') {
      entry.status = 'claimed, code not available in this region';
      steamRedeem.stats.regionLocked++;
    } else if (finalOutcome === 'rate-limited') {
      // Stop the batch — Steam will start failing every key and we don't
      // want to burn through more attempts.
      steamRedeem.message = `Steam rate-limited at "${title}" — stopping batch to avoid burning more keys. Retry later.`;
      steamRedeem.stats.rateLimited++;
      console.log(`[${datetime()}] Steam redeem: rate-limited at ${title}, halting batch.`);
      try { await db.write(); } catch {}
      steamRedeem.phase = 'stopped';
      break;
    } else if (finalOutcome === 'timeout') {
      steamRedeem.stats.timeouts++;
      console.log(`[${datetime()}] Steam redeem: ${title} — timed out, moving on`);
    } else if (finalOutcome === 'error') {
      steamRedeem.stats.errors++;
    } else {
      steamRedeem.stats.unknown++;
    }
    try { await db.write(); } catch {}
    steamRedeem.index++;
  }

  if (steamRedeem) {
    steamRedeem.phase = steamRedeem.phase === 'stopped' ? 'stopped' : 'done';
    const s = steamRedeem.stats;
    const summaryBits = [];
    if (s.redeemed) summaryBits.push(`${s.redeemed} redeemed`);
    if (s.alreadyOwned) summaryBits.push(`${s.alreadyOwned} already owned`);
    if (s.usedElsewhere) summaryBits.push(`${s.usedElsewhere} used elsewhere`);
    if (s.invalid) summaryBits.push(`${s.invalid} invalid`);
    if (s.regionLocked) summaryBits.push(`${s.regionLocked} region-locked`);
    if (s.rateLimited) summaryBits.push(`rate-limited`);
    if (s.errors) summaryBits.push(`${s.errors} errors`);
    steamRedeem.message = `Steam batch ${steamRedeem.phase} — ${summaryBits.join(', ') || 'no results'}`;
    steamRedeem.updatedAt = datetime();
    try { await steamRedeem.context.close(); } catch {}
    steamRedeem.context = null;
    steamRedeem.page = null;
    console.log(`[${datetime()}] Steam redeem ${steamRedeem.phase}: ${steamRedeem.message}`);
  }
}

async function startSteamRedeem() {
  const busy = browserBusy({ allowActiveBrowser: true });
  if (busy) throw new Error(`Cannot start Steam batch redeem — ${busy}.`);
  if (activeBrowser) await closeBrowser();

  // Open every claim DB that the registry knows about. Pending keys can
  // come from any of them — today only prime-gaming.json carries Steam
  // entries (rare), but Humble/Fanatical collectors will write into their
  // own DBs and this loop picks those up automatically.
  const dbs = {};
  for (const file of Object.values(getClaimDbFiles())) {
    try { dbs[file] = await jsonDb(file, {}); }
    catch (e) { console.warn(`[${datetime()}] Steam redeem: couldn't open ${file}: ${e.message}`); }
  }
  const pending = collectPendingSteamCodes(dbs);
  if (!pending.length) throw new Error('No pending Steam keys to redeem.');

  console.log(`[${datetime()}] Starting Steam batch redeem for ${pending.length} key(s)...`);
  const context = await chromium.launchPersistentContext(cfg.dir.browser, {
    headless: false,
    viewport: { width: cfg.width, height: cfg.height },
    locale: 'en-US',
    handleSIGINT: false,
    args: ['--hide-crash-restore-bubble'],
  });
  const page = context.pages()[0] || await context.newPage();
  try { await page.setViewportSize({ width: cfg.width, height: cfg.height }); } catch {}
  context.setDefaultTimeout(0);

  steamRedeem = {
    context, page, pending,
    index: 0,
    stats: {
      redeemed: 0, alreadyOwned: 0, usedElsewhere: 0,
      invalid: 0, regionLocked: 0, rateLimited: 0,
      errors: 0, timeouts: 0, unknown: 0,
    },
    phase: 'running',
    currentTitle: null, currentCode: null,
    message: `Starting — ${pending.length} key(s) queued`,
    startedAt: datetime(), updatedAt: datetime(),
  };

  runSteamRedeemLoop().catch(e => {
    console.error(`[${datetime()}] Steam redeem loop crashed:`, e);
    if (steamRedeem) {
      steamRedeem.phase = 'error';
      steamRedeem.message = `Error: ${e.message}`;
    }
  });

  return { success: true, total: pending.length };
}

async function stopSteamRedeem() {
  if (!steamRedeem) return { success: false, error: 'No Steam batch redeem active.' };
  steamRedeem.phase = 'stopped';
  steamRedeem.message = 'Stopped by user';
  steamRedeem.updatedAt = datetime();
  try { if (steamRedeem.context) await steamRedeem.context.close(); } catch {}
  return { success: true, stats: steamRedeem.stats };
}

function clearFinishedSteamRedeem() {
  if (steamRedeem && (steamRedeem.phase === 'done' || steamRedeem.phase === 'stopped' || steamRedeem.phase === 'error')) {
    steamRedeem = null;
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

function runAllScripts({ source = 'panel', sites = null, extraEnv = null } = {}) {
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
  const isScheduler = source.startsWith('scheduler');
  const childEnv = isScheduler
    ? { ...process.env, NOWAIT: '1' }
    : { ...process.env };
  if (extraEnv) Object.assign(childEnv, extraEnv);
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
  // Scheduler sources ('scheduler', 'scheduler-main', 'scheduler-ms') all
  // count as non-manual so a user's CLAIM_CMD env override still applies in
  // legacy combined mode (sites=null).
  const cmd = resolveClaimCommand({ manual: !isScheduler, sites });
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
      const text = data.toString();
      // Captcha markers from src/util.js#awaitUserCaptchaSolve. Parsed here
      // (not in the per-line forEach below) so multi-line buffers still match.
      const startMatch = text.match(/\[CAPTCHA-START\] service=(\S+)\s+label=(.*?)(?:\r?\n|$)/);
      if (startMatch) {
        captchaPending = { service: startMatch[1], label: startMatch[2].trim(), since: datetime() };
      }
      const endMatch = text.match(/\[CAPTCHA-END\] service=(\S+)/);
      if (endMatch && captchaPending && captchaPending.service === endMatch[1]) {
        captchaPending = null;
      }
      // Run-success markers from src/util.js#log.runSuccess, emitted by each
      // service's process.on('exit') handler at clean exit. matchAll because
      // microsoft.js can emit two markers (microsoft + microsoft-mobile) in
      // one stdout chunk at the very end of the run.
      for (const m of text.matchAll(/\[RUN-SUCCESS\] service=(\S+)/g)) {
        recordLastRunSuccess(m[1]);
      }
      const lines = text.split('\n').filter(l => l.length);
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
      // If this run included microsoft.js (any source — scheduled, manual,
      // per-card test), mark today's MS schedule fired so the decoupled MS
      // loop won't re-fire later the same day. Without this, a manual
      // 09:00 click + scheduled 10:48 fire would double-run MS.
      if (code === 0 && /\bnode microsoft\.js\b/.test(cmd)) {
        try { markMsRunFiredToday(); } catch {}
      }
      runProcess = null;
      runSource = null;
      runStartedAt = null;
      captchaPending = null; // safety-net in case END marker was missed
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
      captchaPending = null;
      resolve(-1);
    });
  });

  return { success: true };
}

// ----- Scheduler -----
// Two independent schedules:
//   * Main schedule — fires non-MS active services. Driven by START_TIME
//     (anchor + LOOP interval) or bare LOOP (sleep N seconds after last run).
//   * MS schedule  — fires microsoft.js alone, at MS_SCHEDULE_START + a
//     random offset within MS_SCHEDULE_HOURS. Today's pick is persisted to
//     data/ms-schedule-today.json so config saves don't reshuffle the
//     visible "next MS run" timestamp.
//
// Legacy combined mode (back-compat for pre-#10 deploys): when the user has
// neither START_TIME nor LOOP set but does have MS_SCHEDULE_HOURS, the main
// loop wakes 30min before the MS window and fires the FULL chain (including
// microsoft.js, which sleeps internally until its random pick). The MS loop
// is suspended in this mode. Setting START_TIME or LOOP opts into decoupled.
const LOOP_SECONDS = cfg.loop;
const MS_SCHEDULE_HOURS = cfg.ms_schedule_hours;
const MS_SCHEDULE_START = cfg.ms_schedule_start;

let nextMainRun = null;       // Date | null — main chain wake
let nextMsRun = null;         // Date | null — MS-only wake (decoupled mode)
let msTodayState = null;      // last-read MS schedule state, for getState()

const MS_SCHEDULE_FILE = path.resolve(__panelDirname, 'data', 'ms-schedule-today.json');

function todayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function nextDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 1);
  return todayKey(dt);
}

function readMsScheduleToday() {
  try {
    if (!existsSync(MS_SCHEDULE_FILE)) return null;
    const raw = readFileSync(MS_SCHEDULE_FILE, 'utf8');
    if (!raw.trim()) return null;
    const p = JSON.parse(raw);
    if (!p || !p.date || !p.target || !p.status) return null;
    return p;
  } catch { return null; }
}
function writeMsScheduleToday(state) {
  try {
    mkdirSync(path.dirname(MS_SCHEDULE_FILE), { recursive: true });
    writeFileSync(MS_SCHEDULE_FILE, JSON.stringify(state, null, 2) + '\n');
  } catch (e) {
    console.error(`[${datetime()}] Scheduler (MS): failed to persist schedule: ${e.message}`);
  }
}
function pickMsTargetFor(dateKey, c) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const startHour = c.msStart;
  const offsetMinutes = Math.floor(Math.random() * c.msHours * 60);
  target.setHours(startHour, offsetMinutes, 0, 0);
  return { date: dateKey, target: target.toISOString(), status: 'pending' };
}

// Per-service last-success-run timestamps. Updated when service scripts
// emit their `[RUN-SUCCESS] service=<id>` marker (parsed in the stdout
// handler), persisted to data/last-runs.json so the Sessions tab can show
// "Last Successful Run …" on each card across panel restarts.
const LAST_RUNS_FILE = path.resolve(__panelDirname, 'data', 'last-runs.json');
let lastRunSuccess = {};
function loadLastRuns() {
  try {
    if (!existsSync(LAST_RUNS_FILE)) return;
    const raw = readFileSync(LAST_RUNS_FILE, 'utf8');
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') lastRunSuccess = parsed;
  } catch (e) {
    console.error(`[${datetime()}] last-runs: failed to load: ${e.message}`);
  }
}
function saveLastRuns() {
  try {
    mkdirSync(path.dirname(LAST_RUNS_FILE), { recursive: true });
    writeFileSync(LAST_RUNS_FILE, JSON.stringify(lastRunSuccess, null, 2) + '\n');
  } catch (e) {
    console.error(`[${datetime()}] last-runs: failed to persist: ${e.message}`);
  }
}
function recordLastRunSuccess(siteId, ts = datetime()) {
  if (!siteId) return;
  // Trim millisecond suffix so cards render "2026-05-06 09:13:43" not
  // "…09:13:43.137" — the user-visible value is to-the-second precision.
  lastRunSuccess[siteId] = String(ts).slice(0, 19);
  saveLastRuns();
}
loadLastRuns();

// Called from runAllScripts close handler when any successful run included
// microsoft.js. Flips today's MS schedule to fired so the msSchedulerLoop
// won't re-fire the same day. Idempotent — writes a synthetic fired entry
// for today if no file exists yet (per-card Run before any scheduled day).
function markMsRunFiredToday() {
  const today = todayKey();
  const cur = readMsScheduleToday();
  if (cur && cur.date === today) {
    if (cur.status === 'fired') return; // already fired
    cur.status = 'fired';
    writeMsScheduleToday(cur);
    return;
  }
  // No file or stale file — synthesize a fired record for today using "now"
  // as the target. Tomorrow's pick happens on the next computeMsWakeMs call.
  writeMsScheduleToday({ date: today, target: new Date().toISOString(), status: 'fired' });
}

// True when the user has neither START_TIME nor LOOP set but does have an
// MS window — preserves pre-#10 single-chain-anchored-on-MS behavior.
function legacyCombinedMode(sched = getSchedulerConfig(), active = activeServices()) {
  const msActive = active.has('microsoft') || active.has('microsoft-mobile');
  return !sched.dailyStartTime && !sched.loop && msActive && sched.msHours > 0;
}

function computeMainWakeMs() {
  const c = getSchedulerConfig();
  const active = activeServices();

  // START_TIME anchor + interval (default 24h). Step forward in interval-ms
  // chunks from today's anchor until we land past now. e.g. 08:00 + 4h with
  // restart at 11:00 → wake at 12:00.
  if (c.dailyStartTime) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(c.dailyStartTime);
    if (m) {
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      const intervalMs = (c.loop > 0 ? c.loop : 86400) * 1000;
      const wake = new Date();
      wake.setHours(hh, mm, 0, 0);
      while (wake.getTime() <= Date.now()) wake.setTime(wake.getTime() + intervalMs);
      return Math.max(wake.getTime() - Date.now(), 60 * 1000);
    }
  }

  // Legacy combined: wake 30min before the MS window, fire full chain.
  if (legacyCombinedMode(c, active)) {
    const wakeHour = c.msStart > 0 ? c.msStart - 1 : 23;
    const wake = new Date();
    wake.setHours(wakeHour, 30, 0, 0);
    if (wake.getTime() <= Date.now()) wake.setDate(wake.getDate() + 1);
    return Math.max(wake.getTime() - Date.now(), 60 * 1000);
  }

  // Bare LOOP (no anchor) — sleep N seconds from "now" (caller schedules
  // the post-run sleep too, so this also serves as the from-completion wait).
  if (c.loop > 0) return c.loop * 1000;

  return 0; // disabled
}

// Compute the next MS-only wake. Walks forward through the persisted state:
// if today is fired/missed or the pending target is past, eagerly picks
// tomorrow so getState() can always show a real upcoming timestamp.
function computeMsWakeMs() {
  const c = getSchedulerConfig();
  const active = activeServices();
  const msActive = active.has('microsoft') || active.has('microsoft-mobile');
  if (!msActive || c.msHours <= 0) { msTodayState = null; return 0; }
  if (legacyCombinedMode(c, active)) { msTodayState = null; return 0; }

  const now = Date.now();
  for (let safety = 0; safety < 14; safety++) {
    let st = readMsScheduleToday();
    const today = todayKey();
    const needsFresh = !st
      || st.date < today
      || (st.date === today && (st.status === 'fired' || st.status === 'missed'));
    if (needsFresh) {
      const day = (!st || st.date < today) ? today : nextDayKey(today);
      st = pickMsTargetFor(day, c);
      writeMsScheduleToday(st);
    }
    msTodayState = st;
    const target = new Date(st.target).getTime();
    if (!Number.isFinite(target)) {
      // Corrupted target — repick and loop.
      st = pickMsTargetFor(todayKey(), c);
      writeMsScheduleToday(st);
      msTodayState = st;
      continue;
    }
    if (st.status === 'pending' && target <= now) {
      // Picked time has already passed (container restart inside window
      // after the pick, or saved file with old target). Mark missed —
      // user can manually fire via the per-card Run button.
      st.status = 'missed';
      writeMsScheduleToday(st);
      continue;
    }
    return Math.max(target - now, 60 * 1000);
  }
  console.error(`[${datetime()}] Scheduler (MS): pick loop exhausted, disabling.`);
  msTodayState = null;
  return 0;
}

// Multi-subscriber wakeup set — both schedulerLoops park in sleepUntilWakeup,
// and any of them must re-arm when config changes.
const schedulerWakeups = new Set();

function sleepUntilWakeup(ms) {
  return new Promise(resolve => {
    let entry;
    const t = setTimeout(() => {
      schedulerWakeups.delete(entry);
      resolve('tick');
    }, ms);
    entry = () => {
      clearTimeout(t);
      schedulerWakeups.delete(entry);
      resolve('reload');
    };
    schedulerWakeups.add(entry);
  });
}

function fireSchedulerWakeups() {
  const list = Array.from(schedulerWakeups);
  schedulerWakeups.clear();
  for (const fn of list) { try { fn(); } catch {} }
}

function watchConfigForScheduler() {
  const dir = path.dirname(CONFIG_FILE_PATH);
  const base = path.basename(CONFIG_FILE_PATH);
  let debounce = null;
  try {
    watch(dir, { persistent: false }, (eventType, filename) => {
      if (filename !== base) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        console.log(`[${datetime()}] Scheduler: config changed — recomputing next wakes.`);
        fireSchedulerWakeups();
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

// Mutex serializing the two scheduler loops through the shared browser-profile
// dir. Two loops can wake at the same instant (e.g. main at 08:00, MS at 08:00
// after a random pick); this lock ensures one fires while the other waits its
// turn instead of both racing on browserBusy.
let scheduleLock = Promise.resolve();
function withScheduleLock(fn) {
  const previous = scheduleLock;
  let release;
  scheduleLock = new Promise(r => { release = r; });
  return previous.then(fn).finally(() => release());
}

async function fireScheduledRun({ label, sites, extraEnv, postRun }) {
  return withScheduleLock(async () => {
    if (sites && sites.length === 0) {
      console.log(`[${datetime()}] Scheduler (${label}): no active services — skipping.`);
      return false;
    }
    const res = runAllScripts({ source: 'scheduler-' + label, sites, extraEnv });
    if (!res.success) {
      console.log(`[${datetime()}] Scheduler (${label}): ${res.error}`);
      return false;
    }
    if (runDone) {
      try { await runDone; } catch (e) { console.error(`[${datetime()}] Scheduler (${label}) run error:`, e); }
    }
    if (postRun) {
      try { await postRun(); } catch (e) { console.error(`[${datetime()}] Scheduler (${label}) post-run error:`, e); }
    }
    return true;
  });
}

function nonMsActiveSiteIds() {
  const active = activeServices();
  active.delete('microsoft');
  active.delete('microsoft-mobile');
  return Array.from(active);
}

// Main loop — drives the non-MS chain (or, in legacy combined mode, the full
// chain including microsoft.js with its internal sleep).
async function mainSchedulerLoop() {
  while (true) {
    const sleepMs = computeMainWakeMs();
    if (sleepMs <= 0) {
      nextMainRun = null;
      console.log(`[${datetime()}] Scheduler (main): disabled — waiting for config change.`);
      await sleepUntilWakeup(2 ** 31 - 1);
      continue;
    }
    nextMainRun = new Date(Date.now() + sleepMs);
    console.log(`[${datetime()}] Scheduler (main): next run at ${datetime(nextMainRun)}.`);
    const how = await sleepUntilWakeup(sleepMs);
    if (how === 'reload') continue;

    const sched = getSchedulerConfig();
    const active = activeServices();
    // Legacy combined mode: sites=null lets a user's CLAIM_CMD env override
    // apply (the same env-override path the original single-loop scheduler
    // used). Decoupled mode: explicit non-MS list, which intentionally
    // bypasses CLAIM_CMD because the override would re-include microsoft.
    const sites = legacyCombinedMode(sched, active) ? null : nonMsActiveSiteIds();
    await fireScheduledRun({
      label: 'main',
      sites,
      postRun: () => postRunSessionCheck(),
    });
  }
}

// MS loop — fires microsoft.js alone at today's persisted random pick.
// MS_SKIP_WINDOW=1 bypasses microsoft.js's own internal wait since the
// scheduler has already done the waiting.
async function msSchedulerLoop() {
  while (true) {
    const sleepMs = computeMsWakeMs();
    if (sleepMs <= 0) {
      nextMsRun = null;
      console.log(`[${datetime()}] Scheduler (MS): disabled — waiting for config change.`);
      await sleepUntilWakeup(2 ** 31 - 1);
      continue;
    }
    nextMsRun = new Date(Date.now() + sleepMs);
    console.log(`[${datetime()}] Scheduler (MS): next run at ${datetime(nextMsRun)}.`);
    const how = await sleepUntilWakeup(sleepMs);
    if (how === 'reload') continue;

    // Re-validate after the wake — config may have flipped to legacy mode,
    // MS may have been deactivated, the file may have been edited.
    const c = getSchedulerConfig();
    const active = activeServices();
    const msActive = active.has('microsoft') || active.has('microsoft-mobile');
    if (!msActive || c.msHours <= 0 || legacyCombinedMode(c, active)) continue;
    const st = readMsScheduleToday();
    if (!st || st.status !== 'pending') continue;

    // status=fired is written by runAllScripts' close handler whenever a
    // run includes microsoft.js — that path also covers per-card Run, so
    // we don't need to mark fired here too.
    await fireScheduledRun({
      label: 'ms',
      sites: ['microsoft', 'microsoft-mobile'],
      extraEnv: { MS_SKIP_WINDOW: '1' },
    });
  }
}

function getState() {
  const active = activeServices();
  // allLoggedIn counts only services the user opted into — an inactive
  // service can't invalidate the "All sessions OK" summary strip.
  const allLoggedIn = Object.entries(siteStatus)
    .filter(([id]) => active.has(id))
    .every(([, s]) => s.status === 'logged_in');
  // Always derive next-run timestamps from config so the UI never sits at
  // "Calculating…" before the loops populate their cached values.
  const sched = getSchedulerConfig();
  const msActive = active.has('microsoft') || active.has('microsoft-mobile');
  const legacyMode = legacyCombinedMode(sched, active);
  const dailyAnchored = !!sched.dailyStartTime;
  const mainEnabled = legacyMode || dailyAnchored || sched.loop > 0;
  const msScheduled = !legacyMode && msActive && sched.msHours > 0;
  const schedEnabled = mainEnabled || msScheduled;

  const computedMain = mainEnabled ? new Date(Date.now() + computeMainWakeMs()) : null;
  const computedMs = msScheduled ? new Date(Date.now() + computeMsWakeMs()) : null;
  const effectiveMain = nextMainRun || computedMain;
  const effectiveMs = nextMsRun || computedMs;
  const effectiveNext = [effectiveMain, effectiveMs]
    .filter(Boolean)
    .reduce((a, b) => (!a || b.getTime() < a.getTime() ? b : a), null);

  const msState = msScheduled ? (msTodayState || readMsScheduleToday()) : null;

  return {
    sites: Object.entries(SITES).map(([id, site]) => ({
      id,
      name: site.name,
      version: site.version || null,
      active: active.has(id),
      lastSuccessfulRun: lastRunSuccess[id] || null,
      ...siteStatus[id],
    })),
    // Active watch-only collectors (scheduleKind: 'watch-only'). They are
    // not in `sites` because they have no checkLogin / session state, but
    // the Sessions tab renders them as compact "Run" cards next to the
    // login-capable cards. Only active watchers are listed; inactive ones
    // surface in Settings → Services.
    watchers: SITE_REGISTRY
      .filter(s => s.scheduleKind === 'watch-only' && active.has(s.id))
      .map(s => ({ id: s.id, name: s.name, version: s.version || null })),
    activeBrowser: activeBrowser ? { site: activeBrowser.siteId, name: SITES[activeBrowser.siteId].name } : null,
    allLoggedIn,
    runStatus,
    runSource,
    runLogLength: runLog.length,
    nextScheduledRun: effectiveNext ? datetime(effectiveNext) : null,
    nextMainRun: effectiveMain ? datetime(effectiveMain) : null,
    nextMsRun: effectiveMs ? datetime(effectiveMs) : null,
    msTodayStatus: msState ? msState.status : null,
    legacyCombinedMode: legacyMode,
    mainEnabled,
    msScheduled,
    loopEnabled: schedEnabled,
    loopSeconds: sched.loop,
    dailyStartTime: sched.dailyStartTime,
    dailyAnchored,
    msScheduleHours: sched.msHours,
    msScheduleStart: sched.msStart,
    msAnchored: legacyMode, // legacy alias — UI now reads legacyCombinedMode/msScheduled
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
    steamRedeem: steamRedeem ? {
      phase: steamRedeem.phase,
      message: steamRedeem.message,
      index: steamRedeem.index,
      total: steamRedeem.pending.length,
      currentTitle: steamRedeem.currentTitle,
      stats: steamRedeem.stats,
      startedAt: steamRedeem.startedAt,
      updatedAt: steamRedeem.updatedAt,
    } : null,
    startupAutoCheck,
    lastRun,
    captchaPending,
  };
}

// ----- Stats -----
// Aggregates claim history from per-service JSON DBs written by the claim
// scripts. Scripts set entry.status starting with "claimed" (plain,
// "claimed and redeemed", "claimed on gog.com", etc.) once a claim succeeds;
// anything else (existed/failed/skipped) is excluded from game counts.
// Microsoft Rewards is points-based and has no claim DB, so it appears in
// the per-service table as N/A.

// Sourced from the registry's claimDbFile fields (Phase 0 of #11).
const CLAIM_DB_FILES = getClaimDbFiles();

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
    buckets.push({ date: localDateKey(d), count: 0, items: [] });
  }
  const byDate = Object.fromEntries(buckets.map(b => [b.date, b]));
  for (const c of claims) {
    const key = localDateKey(c.at);
    if (!byDate[key]) continue;
    byDate[key].count++;
    byDate[key].items.push({
      service: c.service,
      serviceName: (SITES[c.service] && SITES[c.service].name) || c.service,
      title: c.title,
    });
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
<title>Feldorn's Free Games Claimer</title>
<link rel="icon" type="image/x-icon" href="${BASE_PATH}/favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="${BASE_PATH}/assets/icon-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="${BASE_PATH}/assets/icon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="${BASE_PATH}/assets/icon-192.png">
<link rel="apple-touch-icon" sizes="192x192" href="${BASE_PATH}/assets/icon-192.png">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }

  .header { background: #16213e; padding: 12px 20px 14px; border-bottom: 2px solid #0f3460; flex-shrink: 0; position: relative; }
  .header h1 { display: flex; align-items: center; gap: 10px; }
  .header h1 img { height: 32px; width: 32px; flex-shrink: 0; }
  .header-collapse { position: absolute; right: 10px; bottom: 2px; background: transparent; border: none; color: #a0b4d4; opacity: 0.6; cursor: pointer; padding: 2px 6px; font-size: 13px; line-height: 1; font-family: inherit; }
  .header-collapse:hover { opacity: 1; color: #e0e0e0; }
  .compact-sessions { display: none; flex-wrap: wrap; gap: 6px; padding: 4px 0 0; }
  body[data-tab="sessions"] .compact-sessions.shown { display: flex; cursor: pointer; }
  .compact-sessions.shown:hover .mini-card { filter: brightness(1.15); }
  .compact-sessions .mini-card { display: inline-flex; align-items: center; gap: 5px; background: #1e2a47; padding: 3px 9px; border-radius: 4px; font-size: 12px; color: #a0b4d4; }
  .compact-sessions .mini-card .mini-glyph { font-weight: 600; }
  .compact-sessions .mini-card.logged-in     .mini-glyph { color: #4ecca3; }
  .compact-sessions .mini-card.not-logged-in .mini-glyph { color: #e94560; }
  .compact-sessions .mini-card.error         .mini-glyph { color: #f0c040; }
  .compact-sessions .mini-card.unknown       .mini-glyph { color: #888; }
  .captcha-banner { background: #2a1a1e; border: 1px solid #e94560; color: #e94560; padding: 10px 14px; border-radius: 6px; margin: 6px 0; display: flex; align-items: center; gap: 12px; cursor: pointer; }
  .captcha-banner:hover { filter: brightness(1.2); }
  .captcha-banner .cb-icon { font-size: 18px; flex-shrink: 0; }
  .captcha-banner .cb-text { flex: 1; font-weight: 500; line-height: 1.35; }
  .captcha-banner .cb-cta  { font-weight: 600; opacity: 0.9; white-space: nowrap; }
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
  .settings-rail { background: #12213a; border-right: 1px solid #233454; padding: 14px 0; overflow-y: auto; display: flex; flex-direction: column; }
  .settings-rail .rail-btn { display: block; width: 100%; text-align: left; padding: 9px 18px; background: transparent; border: none; border-left: 3px solid transparent; color: #a0b4d4; font-size: 13px; cursor: pointer; font-family: inherit; }
  .settings-rail .rail-btn:hover { background: #1a2a48; color: #e0e0e0; }
  .settings-rail .rail-btn.active { background: rgba(78, 204, 163, 0.08); color: #fff; border-left-color: #4ecca3; font-weight: 600; }
  .settings-rail-version { margin-top: auto; padding: 12px 18px 4px; font-size: 13px; color: #6a7e9d; font-variant-numeric: tabular-nums; }
  .settings-pane { overflow-y: auto; padding: 24px 32px 24px; }
  /* Cap the settings content to a comfortable form width (Strategy A from the
     UX brief). Stretching label/control pairs across the full 1900px panel
     hurts pairing — eye has to track too far. 720px matches GitHub/Linear/
     Stripe-style settings pages. */
  .settings-pane > * { max-width: 720px; }
  .settings-pane-title { font-size: 11px; color: #8aa0c2; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 16px; display: flex; align-items: center; gap: 12px; }
  .settings-pane-title .spacer { flex: 1; }

  /* Keep the old class names working for in-section rendering */
  .settings-view { flex: 1; overflow-y: auto; padding: 24px 32px 16px; }
  .settings-section { margin-bottom: 28px; }
  .settings-section-head { font-size: 11px; color: #8aa0c2; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; display: flex; align-items: center; gap: 12px; }
  .settings-section-head .spacer { flex: 1; }

  @media (max-width: 720px) {
    .settings-layout { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    .settings-rail { display: flex; flex-direction: row; overflow-x: auto; gap: 4px; padding: 8px 12px; border-right: none; border-bottom: 1px solid #233454; }
    .settings-rail .rail-btn { width: auto; flex-shrink: 0; white-space: nowrap; border-left: none; border-bottom: 3px solid transparent; border-radius: 6px; padding: 6px 12px; }
    .settings-rail .rail-btn.active { border-left-color: transparent; border-bottom-color: #4ecca3; }
    .settings-rail-version { margin-top: 0; margin-left: auto; align-self: center; padding: 0 8px; }
    .settings-pane { padding: 16px; }
  }

  .env-view-head { padding: 20px 32px 8px; display: flex; align-items: flex-start; gap: 16px; flex-shrink: 0; }
  .env-view-head .env-view-title { font-size: 16px; color: #e0e0e0; font-weight: 600; margin: 0 0 4px; }
  .env-view-head .env-view-sub { font-size: 12px; color: #8aa0c2; line-height: 1.45; max-width: 540px; }
  .env-view-head > button { margin-left: auto; flex-shrink: 0; }
  .env-view-body { flex: 1; overflow-y: auto; padding: 0 32px 24px; }

  /* Field chrome */
  /* Label uses normal text flow; the (i) icon glues to the last word via an
     inline-flex tail (atomic unit, can't break internally). gap handles the
     spacing so the icons null out their own margin-left inside the tail to
     avoid doubled-up spacing. */
  .setting .setting-help-popover { grid-column: 1 / -1; }
  .setting-label-tail { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; vertical-align: baseline; }
  .setting-label-tail .setting-info { flex-shrink: 0; margin-left: 0; }
  .setting-label-tail .setting-dot { flex-shrink: 0; margin-left: 0; }
  /* Currency / unit prefix sits inside the input box (absolute-positioned)
     instead of as a separate flex item — so the $ visually attaches to the
     value rather than floating in its own micro-column. */
  .setting-input .input-with-prefix { position: relative; display: inline-block; flex: 0 0 auto; }
  .setting-input .input-with-prefix .input-prefix { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); color: #8aa0c2; font-size: 13px; pointer-events: none; }
  .setting-input .input-with-prefix input[type="number"] { padding-left: 22px; }
  .setting-info { background: transparent; border: 1px solid #233454; color: #8aa0c2; width: 18px; height: 18px; border-radius: 50%; font-size: 11px; cursor: pointer; padding: 0; line-height: 1; margin-left: 6px; display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; }
  .setting-info:hover { background: #1a2a48; color: #e0e0e0; border-color: #2a3a5a; }
  .setting-info.open { background: #0f3460; color: #fff; border-color: #4ecca3; }
  .setting-help-popover { margin-top: 4px; padding: 8px 10px; background: #0d1830; border: 1px solid #233454; border-radius: 6px; font-size: 12px; color: #a0b4d4; line-height: 1.5; display: none; }
  .setting-help-popover.open { display: block; }
  .setting-help-popover .env-tag { font-family: 'Menlo', 'Consolas', monospace; font-size: 11px; color: #8aa0c2; display: block; margin-top: 4px; }

  /* Per-service accordion */
  .svc-row { border-top: 1px solid #1a2a48; }
  .svc-row:first-of-type { border-top: none; }
  /* Section header rows inside Settings → Services. Splits Full Collectors
     from Notify-Only Collectors so the watcher list grows without diluting
     the main collector area. */
  .svc-section-header { padding: 14px 0 6px; font-size: 11px; color: #6a7e9e; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; border-top: 1px solid #1a2a48; margin-top: 4px; }
  .svc-section-header:first-of-type { border-top: none; margin-top: 0; padding-top: 4px; }
  .svc-section-header + .svc-row { border-top: none; }
  /* Strategy A: the expand button sizes to its content (no flex:1) so the
     master toggle lands ~16px after the count pill, not the far-right edge. */
  .svc-head { display: flex; align-items: center; gap: 16px; }
  .svc-expand { display: grid; grid-template-columns: 14px 1fr; grid-template-rows: auto auto; column-gap: 12px; row-gap: 2px; padding: 12px 12px; cursor: pointer; background: transparent; border: none; color: inherit; font-family: inherit; text-align: left; transition: background 0.12s, box-shadow 0.12s; }
  .svc-row.expandable .svc-expand:hover { background: rgba(78, 204, 163, 0.05); box-shadow: inset 3px 0 0 #4ecca3; }
  .svc-expand[disabled] { cursor: default; }
  .svc-expand .svc-caret { grid-row: 1 / 3; grid-column: 1; align-self: center; color: #8aa0c2; font-size: 13px; }
  .svc-expand .svc-caret.svc-caret-disabled { opacity: 0.3; }
  .svc-expand .svc-name-line { grid-row: 1; grid-column: 2; display: flex; align-items: baseline; gap: 10px; }
  .svc-expand .svc-name { font-size: 15px; font-weight: 600; color: #ffffff; letter-spacing: 0.01em; }
  .svc-expand .svc-count { font-size: 11px; color: #6a7e9e; font-weight: 400; letter-spacing: 0.02em; padding: 2px 7px; border: 1px solid #233454; border-radius: 10px; line-height: 1; }
  .svc-row.expandable .svc-expand:hover .svc-count { color: #4ecca3; border-color: #2a4a3e; }
  .svc-expand .svc-version { font-size: 10px; color: #4a5e7e; font-weight: 400; letter-spacing: 0.04em; line-height: 1; margin-left: 2px; }
  .svc-expand .svc-summary { grid-row: 2; grid-column: 2; font-size: 12.5px; color: #8aa0c2; line-height: 1.4; }
  .svc-row.inactive .svc-name { color: #c0c8d8; font-weight: 500; }
  .svc-row.inactive .svc-summary { color: #6a7e9e; }
  /* Per-service master toggle — a real switch, not a checkbox. Different
     semantic from sub-boolean settings inside the expanded body. */
  .svc-toggle { position: relative; display: inline-flex; align-items: center; cursor: pointer; flex-shrink: 0; }
  .svc-toggle input[type="checkbox"] { position: absolute; opacity: 0; pointer-events: none; }
  .svc-toggle-track { width: 32px; height: 18px; background: #233454; border-radius: 9px; position: relative; transition: background 0.15s; flex-shrink: 0; }
  .svc-toggle-thumb { width: 14px; height: 14px; background: #c0c8d8; border-radius: 50%; position: absolute; top: 2px; left: 2px; transition: left 0.15s, background 0.15s; }
  .svc-toggle input[type="checkbox"]:checked + .svc-toggle-track { background: #4ecca3; }
  .svc-toggle input[type="checkbox"]:checked + .svc-toggle-track .svc-toggle-thumb { left: 16px; background: #fff; }
  .svc-toggle:hover .svc-toggle-track { box-shadow: 0 0 0 3px rgba(78, 204, 163, 0.12); }
  /* Expanded sub-settings: 2px accent left border + indent so the parent/child
     relationship is visually obvious. Border sits ~under the caret (toggle
     32 + gap 16 + expand-padding 12 + half-caret 7 = 67px), and content
     padding aligns the body with the service name (caret-col 14 + col-gap 12
     past the border = 86px). */
  .svc-body { display: none; margin-left: 66px; padding: 6px 12px 16px 18px; border-left: 2px solid rgba(78, 204, 163, 0.35); }
  .svc-body.open { display: block; }
  .svc-body .svc-subtitle { font-size: 12px; color: #8aa0c2; margin: 0 0 12px; font-style: italic; }
  /* Strategy A layout: label takes only the space it needs and the control
     sits ~24px to its right. No more stretched grid pushing controls to a
     far-edge column. flex-wrap allows revert + popover to wrap onto extra
     rows when needed. */
  .setting { display: flex; align-items: center; gap: 24px; padding: 12px 0; border-bottom: 1px solid #1a2a48; flex-wrap: wrap; }
  .setting:last-child { border-bottom: none; }
  .setting > .setting-label { flex: 0 0 auto; white-space: nowrap; min-width: 0; }
  .setting > .setting-input { flex: 0 0 auto; }
  .setting > .setting-help-popover { flex-basis: 100%; }
  /* Below 640px: labels wrap naturally and controls drop below.
     Boolean Variant C keeps its checkbox-left inline layout. */
  @media (max-width: 640px) {
    .setting:not(.setting-bool) { flex-direction: column; align-items: flex-start; gap: 8px; }
    .setting:not(.setting-bool) > .setting-label { white-space: normal; }
  }
  /* Grouped fields: small-caps subheader replaces the per-field hairline so
     related settings (Timeouts, Debug, Viewport, etc.) read as one cluster. */
  .setting-group { margin-bottom: 24px; }
  .setting-group:last-child { margin-bottom: 0; }
  .setting-group-head { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #6a7e9e; margin: 0 0 4px; padding-bottom: 6px; border-bottom: 1px solid #1a2a48; }
  .setting-group .setting { border-bottom: none; padding: 8px 0; }
  .setting-label { font-size: 13px; color: #e0e0e0; line-height: 1.4; }
  .setting-env { font-size: 11px; color: #8aa0c2; font-family: 'Menlo', 'Consolas', monospace; margin-left: 6px; }
  .setting-dot { width: 6px; height: 6px; border-radius: 50%; background: #4ecca3; display: inline-block; margin-left: 6px; vertical-align: middle; }
  .setting-hint { font-size: 11px; color: #8aa0c2; margin-top: 3px; line-height: 1.4; font-style: italic; }
  .setting-input { display: flex; align-items: center; gap: 8px; }
  .setting-input input[type="number"], .setting-input input[type="text"], .setting-input select, .setting-input textarea {
    background: #0d1830; color: #e0e0e0; border: 1px solid #233454; border-radius: 4px; padding: 6px 8px; font-size: 13px; font-family: inherit;
  }
  /* Default widths by control type — Strategy A's flex layout means inputs
     don't auto-fill a stretched column anymore, so each gets a sensible
     content-width that matches the typical input length. */
  .setting-input input[type="text"] { width: 320px; max-width: 100%; }
  .setting-input textarea { width: 480px; max-width: 100%; }
  .setting-input select { min-width: 120px; }
  /* Numeric inputs: cap width and right-align so "60" doesn't share the same
     stretched width as a long Apprise URL. The unit suffix sits to the right. */
  .setting-input input[type="number"] { width: 110px; flex: 0 0 auto; text-align: right; }
  .setting-input .input-suffix { color: #8aa0c2; font-size: 12px; white-space: nowrap; }
  .setting-input input[type="number"]:focus, .setting-input input[type="text"]:focus, .setting-input select:focus, .setting-input textarea:focus {
    outline: none; border-color: #4ecca3;
  }
  .setting-input textarea { min-height: 60px; resize: vertical; font-family: 'Menlo', 'Consolas', monospace; font-size: 12px; }
  /* Variant C: boolean fields render as one inline cluster (checkbox-left + label),
     not the default label/input two-column grid — the whole row is one click target. */
  .setting.setting-bool { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 0; }
  .setting.setting-bool .setting-bool-cluster { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: #e0e0e0; font-size: 13px; line-height: 1.4; }
  .setting.setting-bool .setting-bool-cluster input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; margin: 0; flex-shrink: 0; }
  .setting.setting-bool .setting-revert { margin-top: 0; margin-left: auto; }
  .setting.setting-bool .setting-help-popover { flex-basis: 100%; }
  .setting-revert { background: transparent; border: 1px solid #233454; border-radius: 4px; padding: 5px 10px; color: #8aa0c2; cursor: pointer; font-size: 11px; white-space: nowrap; margin-top: 3px; }
  .setting-revert:hover:not(:disabled) { background: #1a2a48; color: #e0e0e0; border-color: #2a3a5a; }
  .setting-revert:disabled { opacity: 0.25; cursor: not-allowed; }

  /* Composite day/hour/minute interval input — narrow number boxes inline with
     unit labels and a live human-readable summary. */
  .setting-interval-grid { flex-wrap: wrap; }
  .setting-interval-grid input[type="number"] { width: 64px !important; }
  .setting-interval-grid .interval-unit { color: #8aa0c2; font-size: 12px; margin-right: 6px; }
  .setting-interval-grid .interval-summary { color: #8aa0c2; font-size: 12px; font-style: italic; margin-left: 8px; }
  .setting-help-inline { color: #8aa0c2; font-size: 12px; line-height: 1.5; max-width: 720px; }
  .setting-input input[type="time"] { width: 110px; padding: 6px 8px; background: #0e1726; border: 1px solid #233454; border-radius: 4px; color: #e0e0e0; font-size: 13px; }
  .setting-input input[type="time"]:focus { outline: none; border-color: #4ecca3; }

  .settings-footer { background: #16233c; border-top: 1px solid #233454; padding: 12px 32px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; position: sticky; bottom: 0; z-index: 10; box-shadow: 0 -8px 16px rgba(0, 0, 0, 0.25); }
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

  .status-strip { display: none; align-items: center; gap: 10px; padding: 6px 12px; font-size: 13px; line-height: 1.35; border-radius: 6px; margin-bottom: 8px; cursor: pointer; }
  .status-strip:hover { filter: brightness(1.1); }
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
  /* Compact card variant for watch-only collectors. Lower visual weight
     (smaller min-height, muted bg) so they sit alongside the main grid
     without competing for attention. */
  .site-card.watcher { background: #0a2440; border: 1px solid #1a3a5a; min-height: 78px; gap: 4px; }
  .site-card.watcher .name { font-weight: 600; font-size: 14px; }
  .site-card.watcher .status { font-size: 11px; color: #6a7e9e; flex: 0; }
  .site-card.watcher .card-actions { margin-top: auto; }
  .watcher-section { margin-top: 16px; }
  .watcher-section-title { font-size: 11px; color: #6a7e9e; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; margin-bottom: 8px; }
  .watcher-cards { display: grid; grid-template-columns: repeat(1, 1fr); gap: 10px; }
  @media (min-width: 640px)  { .watcher-cards { grid-template-columns: repeat(2, 1fr); } }
  @media (min-width: 960px)  { .watcher-cards { grid-template-columns: repeat(3, 1fr); } }
  @media (min-width: 1400px) { .watcher-cards { grid-template-columns: repeat(4, 1fr); } }

  .available-drawer { margin-top: 12px; background: #12213a; border: 1px solid #233454; border-radius: 8px; }
  .available-drawer .drawer-head { width: 100%; text-align: left; padding: 10px 14px; background: transparent; border: none; color: #a0b4d4; font-size: 13px; cursor: pointer; font-family: inherit; display: flex; align-items: center; gap: 8px; }
  .available-drawer .drawer-head:hover { color: #e0e0e0; }
  .available-drawer .drawer-head .caret { display: inline-block; width: 12px; }
  .available-drawer .drawer-body { padding: 0 14px 12px; display: grid; grid-template-columns: repeat(1, 1fr); gap: 10px; }
  /* The .drawer-body rule above sets display:grid, which beats the UA default
     [hidden]{display:none} on specificity — without this override, toggling
     the caret flipped the hidden attribute but the cards stayed visible. */
  .available-drawer .drawer-body[hidden] { display: none; }
  @media (min-width: 640px)  { .available-drawer .drawer-body { grid-template-columns: repeat(2, 1fr); } }
  @media (min-width: 960px)  { .available-drawer .drawer-body { grid-template-columns: repeat(3, 1fr); } }
  @media (min-width: 1400px) { .available-drawer .drawer-body { grid-template-columns: repeat(4, 1fr); } }
  .site-card-header { display: flex; align-items: center; gap: 8px; }
  .site-card .name { font-weight: 600; font-size: 14px; }
  .site-card-version { margin-left: auto; font-size: 10px; color: #6a7e9e; font-weight: 400; letter-spacing: 0.04em; line-height: 1; }
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

  /* Unsaved-changes confirmation modal — gates navigation away from
     Settings while settingsDirty is non-empty. Three actions: stay,
     save and continue, discard and continue. Backdrop click and
     Escape both behave as "stay". */
  .unsaved-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 200; display: flex; align-items: center; justify-content: center; }
  .unsaved-modal-card { background: #16213e; border: 1px solid #2a3a5a; border-radius: 8px; padding: 22px 24px; max-width: 460px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
  .unsaved-modal-title { font-size: 16px; font-weight: 600; color: #ffffff; margin-bottom: 10px; }
  .unsaved-modal-body { font-size: 14px; color: #c0c8d8; line-height: 1.5; margin-bottom: 18px; }
  .unsaved-modal-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .unsaved-modal-actions .btn { font-size: 13px; padding: 8px 14px; }
  /* Cookie-import modal — paste-or-upload entry, file input above the
     textarea, with a status line that flips between info / error /
     success below. Reuses the unsaved-modal overlay styling for
     consistency, just larger card to fit the textarea. */
  .cookie-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 200; display: flex; align-items: center; justify-content: center; }
  .cookie-modal-card { background: #16213e; border: 1px solid #2a3a5a; border-radius: 8px; padding: 22px 24px; max-width: 580px; width: 92%; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
  .cookie-modal-title { font-size: 16px; font-weight: 600; color: #ffffff; margin-bottom: 10px; }
  .cookie-modal-body { font-size: 14px; color: #c0c8d8; line-height: 1.5; margin-bottom: 18px; }
  .cookie-modal-help { font-size: 12.5px; color: #8aa0c2; margin: 0 0 12px 0; }
  .cookie-modal-body textarea { width: 100%; box-sizing: border-box; background: #0e1726; color: #e0e0e0; border: 1px solid #233454; border-radius: 4px; padding: 8px 10px; font-family: monospace; font-size: 12px; resize: vertical; margin-top: 8px; }
  .cookie-modal-body textarea:focus { outline: none; border-color: #4ecca3; }
  .cookie-modal-body input[type="file"] { color: #c0c8d8; font-size: 13px; }
  .cookie-modal-msg { font-size: 12px; margin-top: 10px; min-height: 16px; }
  .cookie-modal-msg.info  { color: #8aa0c2; }
  .cookie-modal-msg.error { color: #e94560; }
  .cookie-modal-msg.success { color: #4ecca3; }
  .cookie-modal-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .cookie-modal-actions .btn { font-size: 13px; padding: 8px 14px; }
  /* Change-accounts confirm — small, two-button modal. */
  .relogin-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 200; display: flex; align-items: center; justify-content: center; }
  .relogin-modal-card { background: #16213e; border: 1px solid #2a3a5a; border-radius: 8px; padding: 22px 24px; max-width: 460px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
  .relogin-modal-title { font-size: 16px; font-weight: 600; color: #ffffff; margin-bottom: 10px; }
  .relogin-modal-body { font-size: 14px; color: #c0c8d8; line-height: 1.5; margin-bottom: 18px; }
  .relogin-modal-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .relogin-modal-actions .btn { font-size: 13px; padding: 8px 14px; }
  /* Bare-icon affordance in the card header (top-right) for force
     re-login. Same subdued color as the version stamp; lights up on
     hover. Not styled like a button — it's metadata-adjacent. */
  .site-card-relogin { background: none; border: none; color: #6a7e9e; font-size: 14px; cursor: pointer; padding: 0 2px; line-height: 1; margin-left: 4px; }
  .site-card-relogin:hover:not(:disabled) { color: #4ecca3; }
  .site-card-relogin:disabled { opacity: 0.3; cursor: not-allowed; }
  /* Cookie-import button in the card-actions row. Styled like the other
     action buttons but in a slightly muted blue so it sits between
     Login (red) and Check (gray) in visual weight. */
  .btn-cookie { background: #2a3a5a; color: #c0c8d8; }
  .btn-cookie:hover:not(:disabled) { background: #3a4a6a; color: #ffffff; }
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
    <h1><img src="${BASE_PATH}/assets/icon-64.png" alt=""><span>Feldorn's Free Games Claimer</span></h1>
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
  <div class="captcha-banner" id="captchaBanner" style="display:none" onclick="focusCaptcha()" title="Open the browser to solve the pending captcha"></div>
  <div class="steps sessions-only" id="steps"></div>
  <div class="status-strip sessions-only" id="statusStrip" onclick="toggleSessionsCollapsed()" title="Click to collapse session details"></div>
  <div class="site-cards sessions-only" id="siteCards"></div>
  <div class="watcher-section sessions-only" id="watcherCards" style="display:none"></div>
  <div class="available-drawer sessions-only" id="availableDrawer" style="display:none"></div>
  <div class="sessions-only" id="batchRedeemInfo" style="display:none; margin-top: 10px;"></div>
  <div class="sessions-only" id="steamRedeemInfo" style="display:none; margin-top: 10px;"></div>
  <div class="sessions-only" id="activeSession" style="display:none"></div>
  <div class="compact-sessions sessions-only" id="compactSessions" onclick="toggleSessionsCollapsed()" title="Click to expand session details"></div>
  <button class="header-collapse sessions-only" id="btnHeaderCollapse" onclick="toggleSessionsCollapsed()" title="Collapse session details" aria-label="Collapse session details">▴</button>
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
        <div class="settings-rail-version" title="App version (from package.json)">v${APP_VERSION}</div>
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
<div class="unsaved-modal" id="unsavedModal" role="dialog" aria-modal="true" aria-labelledby="unsavedModalTitle" style="display:none">
  <div class="unsaved-modal-card">
    <div class="unsaved-modal-title" id="unsavedModalTitle">Unsaved changes</div>
    <div class="unsaved-modal-body">You have unsaved settings changes. What would you like to do?</div>
    <div class="unsaved-modal-actions">
      <button class="btn btn-cancel unsaved-stay">Stay on Settings</button>
      <button class="btn btn-stop unsaved-discard">Discard and continue</button>
      <button class="btn btn-run unsaved-save">Save and continue</button>
    </div>
  </div>
</div>
<div class="cookie-modal" id="cookieModal" role="dialog" aria-modal="true" aria-labelledby="cookieModalTitle" style="display:none">
  <div class="cookie-modal-card">
    <div class="cookie-modal-title" id="cookieModalTitle">Import cookies — <span id="cookieModalSite"></span></div>
    <div class="cookie-modal-body">
      <p class="cookie-modal-help">Paste a JSON cookie export below, or upload a file. Compatible with EditThisCookie and Cookie-Editor browser extensions. Cookies whose domain doesn't match this site are rejected.</p>
      <input type="file" id="cookieFileInput" accept=".json,application/json,.txt" />
      <textarea id="cookiePasteInput" placeholder="Or paste JSON here..." rows="8"></textarea>
      <div class="cookie-modal-msg" id="cookieModalMsg"></div>
    </div>
    <div class="cookie-modal-actions">
      <button class="btn btn-cancel cookie-cancel">Cancel</button>
      <button class="btn btn-run cookie-submit">Import</button>
    </div>
  </div>
</div>
<div class="relogin-modal" id="reloginModal" role="dialog" aria-modal="true" aria-labelledby="reloginModalTitle" style="display:none">
  <div class="relogin-modal-card">
    <div class="relogin-modal-title" id="reloginModalTitle">Change accounts?</div>
    <div class="relogin-modal-body">Open the Login flow for <span id="reloginModalSite"></span>? Use this when you want to switch accounts or force a fresh login despite the current session looking healthy.</div>
    <div class="relogin-modal-actions">
      <button class="btn btn-cancel relogin-cancel">No</button>
      <button class="btn btn-run relogin-confirm">Yes, log in</button>
    </div>
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
let pendingSteamCount = 0;

// Drawer expand state lives in JS rather than the DOM because render() rebuilds
// availableDrawer.innerHTML on every poll — pre-this fix, clicking the caret
// flipped the DOM but the next render reset it from a stale localStorage flag,
// so the drawer "did nothing" for the user.
let drawerExpanded = localStorage.getItem('drawerSeen') !== '1';

function toggleAvailableDrawer() {
  drawerExpanded = !drawerExpanded;
  localStorage.setItem('drawerSeen', '1');
  render();
}

// User-controlled collapse for the entire sessions strip below the status
// line — hides session cards, the available-services drawer, batch redeem
// info, and the active-session row, leaving just the status strip visible
// as a one-line summary so the VNC iframe / run log gets full vertical
// space below. Persisted across reloads.
let sessionsCollapsed = localStorage.getItem('sessionsCollapsed') === '1';

function toggleSessionsCollapsed() {
  sessionsCollapsed = !sessionsCollapsed;
  localStorage.setItem('sessionsCollapsed', sessionsCollapsed ? '1' : '0');
  render();
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

// Modal helper — returns 'stay' | 'save' | 'discard' based on user
// click, backdrop click, or Escape key. Used by switchTab to gate
// navigation away from Settings while there are unsaved drafts.
function confirmUnsavedChanges() {
  return new Promise(resolve => {
    const modal = document.getElementById('unsavedModal');
    if (!modal) { resolve('stay'); return; }
    const stay = modal.querySelector('.unsaved-stay');
    const save = modal.querySelector('.unsaved-save');
    const discard = modal.querySelector('.unsaved-discard');
    const onKey = (e) => { if (e.key === 'Escape') onChoice('stay'); };
    const onChoice = (choice) => {
      modal.style.display = 'none';
      stay.onclick = save.onclick = discard.onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(choice);
    };
    stay.onclick = () => onChoice('stay');
    save.onclick = () => onChoice('save');
    discard.onclick = () => onChoice('discard');
    modal.onclick = (e) => { if (e.target === modal) onChoice('stay'); };
    document.addEventListener('keydown', onKey);
    modal.style.display = 'flex';
    stay.focus();
  });
}

async function switchTab(tab) {
  // Guard against navigating away from Settings with unsaved drafts.
  // settingsDirty is a flat path → value map; non-empty means the
  // Save / Discard footer is showing, and the user has changes that
  // would be lost on a tab switch.
  const currentTab = document.body.dataset.tab;
  if (currentTab === 'settings' && tab !== 'settings' && Object.keys(settingsDirty).length > 0) {
    const choice = await confirmUnsavedChanges();
    if (choice === 'stay') return;
    if (choice === 'save') {
      await saveSettings();
      // saveSettings clears settingsDirty on success and leaves it
      // populated on validation/network failure. If anything is still
      // dirty, the save didn't fully apply — keep the user on Settings
      // rather than losing their changes silently.
      if (Object.keys(settingsDirty).length > 0) return;
    }
    if (choice === 'discard') discardSettings();
  }
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

// Native browser dialog for tab close / reload while drafts exist.
// Browser shows a generic localized message; can't customise the text.
window.addEventListener('beforeunload', e => {
  if (Object.keys(settingsDirty).length > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

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

// Formats a numeric field value into a human-readable conversion shown as
// an inline suffix next to the input ("60 [seconds] = 1m"). Returns '' when
// no useful conversion exists (e.g. zero/negative, or units that don't divide
// cleanly), so the suffix slot stays empty rather than showing "= 0m".
function unitSuffix(unit, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (unit === 'seconds') {
    if (n % 86400 === 0) return '= ' + (n / 86400) + 'd';
    if (n % 3600 === 0)  return '= ' + (n / 3600) + 'h';
    if (n % 60 === 0)    return '= ' + (n / 60) + 'm';
    return '';
  }
  if (unit === 'hours') {
    if (n % 24 === 0)    return '= ' + (n / 24) + 'd';
    return '';
  }
  if (unit === 'days') {
    if (n >= 7 && n % 7 === 0) return '= ' + (n / 7) + 'w';
    return '';
  }
  return '';
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

// Wrap a set of fieldRow strings in a labeled group with a small-caps
// subheader. Used on Advanced + Notifications to break the page into
// logical clusters (Timeouts, Debug, Viewport, …) instead of one long list.
function settingGroup(title, body) {
  return '<div class="setting-group">' +
    '<div class="setting-group-head">' + escapeHtml(title) + '</div>' +
    body +
  '</div>';
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

  const revertBtn = overridden
    ? '<button type="button" class="setting-revert" onclick="revertSettingValue(\\'' + path + '\\')">Revert</button>'
    : '';

  // Glue the (i) icon (and overridden-dot) to the last word of the label so
  // they wrap together rather than orphaning onto a new line below the text.
  const labelStr = String(label);
  const lastSpace = labelStr.lastIndexOf(' ');
  const labelHead = lastSpace > 0 ? labelStr.slice(0, lastSpace + 1) : '';
  const labelTail = lastSpace > 0 ? labelStr.slice(lastSpace + 1) : labelStr;
  const labelHtml = escapeHtml(labelHead) +
    '<span class="setting-label-tail">' + escapeHtml(labelTail) + dot + infoBtn + '</span>';

  // Variant C — booleans render as one inline cluster (checkbox-left + label),
  // not the label/input two-column grid. The (i) button lives inside <label>:
  // HTML5 suppresses label activation when clicking interactive descendants,
  // so the help popover opens without toggling the checkbox.
  if (f.type === 'boolean') {
    return '<div class="setting setting-bool" data-path="' + path + '">' +
      '<label class="setting-bool-cluster">' +
        '<input type="checkbox" ' + (value ? 'checked' : '') + ' onchange="setSettingValue(\\'' + path + '\\', this.checked)">' +
        '<span>' + escapeHtml(labelHead) + '<span class="setting-label-tail">' + escapeHtml(labelTail) + dot + infoBtn + '</span></span>' +
      '</label>' +
      revertBtn +
      popover +
    '</div>';
  }

  let inputHtml;
  if (extra.options) {
    const options = extra.options.map(o => '<option value="' + o.value + '"' + (String(value) === String(o.value) ? ' selected' : '') + '>' + escapeHtml(o.label) + '</option>').join('');
    const cast = f.type === 'number' ? 'Number(this.value)' : 'this.value';
    inputHtml = '<select onchange="setSettingValue(\\'' + path + '\\', ' + cast + ')">' + options + '</select>';
  } else if (f.type === 'number') {
    const v = value == null ? '' : value;
    const suffixText = extra.unit ? unitSuffix(extra.unit, value) : '';
    const suffix = suffixText ? '<span class="input-suffix">' + escapeHtml(suffixText) + '</span>' : '';
    const inputEl = '<input type="number" value="' + v + '" oninput="setSettingValue(\\'' + path + '\\', this.value === \\'\\' ? null : Number(this.value))">';
    const inputCore = extra.prefix
      ? '<span class="input-with-prefix"><span class="input-prefix">' + escapeHtml(extra.prefix) + '</span>' + inputEl + '</span>'
      : inputEl;
    inputHtml = inputCore + suffix;
  } else if (extra.multiline) {
    inputHtml = '<textarea oninput="setSettingValue(\\'' + path + '\\', this.value)">' + escapeHtml(value || '') + '</textarea>';
  } else {
    inputHtml = '<input type="text" value="' + escapeHtml(value || '') + '" oninput="setSettingValue(\\'' + path + '\\', this.value)">';
  }

  return '<div class="setting" data-path="' + path + '">' +
    '<div class="setting-label">' + labelHtml + '</div>' +
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
// Sessions tab for per-session login-state visibility. Sourced from the
// registry's linkedWith pointers (Phase 0 of #11) so adding a new linked
// sub-service is one field on its parent entry.
const LINKED_ACTIVE = ${JSON.stringify(getLinkedActiveMap())};

// Settings-tab service rows derived from the registry (Phase 0 of #11).
// Microsoft's MS_SCHEDULE_ fields are rendered under its row even though
// their config paths live under scheduler.* — they're flagged
// schedulerScope on the registry's configFields and getServiceRows
// preserves the full path. Sub-services (microsoft-mobile) are rolled into
// their parent row via the registry's linkedWith pointer. This block is
// inside PANEL_HTML so the server pre-computes the array as a JSON
// literal (see the assignment below) — a literal getServiceRows call
// here would reference a Node-only symbol that doesn't exist in the
// browser. NOTE: do not write a server-substitution placeholder inside
// any comment in this file. Even inside // single-line comments, Node
// parses the surrounding PANEL_HTML template literal eagerly and crashes.
const SERVICE_ROWS = ${JSON.stringify(getServiceRows())};

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
  const versionLabel = entry.version ? '<span class="svc-version">v' + escapeHtml(entry.version) + '</span>' : '';
  return '<div class="svc-row' + (active ? '' : ' inactive') + (expandable ? ' expandable' : '') + '">' +
    '<div class="svc-head">' +
      '<label class="svc-toggle" title="' + (active ? 'Active' : 'Inactive') + '" aria-label="' + (active ? 'Disable' : 'Enable') + ' ' + escapeHtml(entry.title) + '">' +
        '<input type="checkbox" ' + (active ? 'checked' : '') +
          ' onchange="setActiveService(\\'' + entry.id + '\\', this.checked)">' +
        '<span class="svc-toggle-track"><span class="svc-toggle-thumb"></span></span>' +
      '</label>' +
      '<button type="button" class="svc-expand" ' + onclick + (expandable ? '' : ' disabled') + '>' +
        '<span class="svc-caret' + (expandable ? '' : ' svc-caret-disabled') + '">' + caret + '</span>' +
        '<span class="svc-name-line">' +
          '<span class="svc-name">' + escapeHtml(entry.title) + '</span>' +
          (expandable ? countLabel : '') +
          versionLabel +
        '</span>' +
        '<span class="svc-summary">' + escapeHtml(serviceSummary(entry.id)) + '</span>' +
      '</button>' +
    '</div>' +
    body +
  '</div>';
}

// Decompose loopSeconds into days/hours/minutes for the composite input.
// Sub-minute residue is reported in the summary so the user knows touching
// any field will round to a whole minute.
function decomposeLoopSeconds(loop) {
  loop = Math.max(0, Math.floor(Number(loop) || 0));
  return {
    days: Math.floor(loop / 86400),
    hours: Math.floor((loop % 86400) / 3600),
    minutes: Math.floor((loop % 3600) / 60),
    seconds: loop % 60,
  };
}

function formatIntervalPretty(loop, fromCompletion) {
  loop = Math.max(0, Math.floor(Number(loop) || 0));
  if (loop <= 0) {
    return fromCompletion ? '· disabled' : '· once daily at start time';
  }
  const p = decomposeLoopSeconds(loop);
  const parts = [];
  if (p.days)    parts.push(p.days + 'd');
  if (p.hours)   parts.push(p.hours + 'h');
  if (p.minutes) parts.push(p.minutes + 'm');
  if (p.seconds) parts.push(p.seconds + 's');
  let txt = '· every ' + parts.join(' ') + ' (' + loop + 's)';
  if (p.seconds) txt += ' — touching a field rounds to the minute';
  return txt;
}

// Stash the previous start time when toggling to from-completion mode so
// flipping back restores it instead of forcing the user to re-enter.
let _stashedStartTime = '';

function setScheduleMode(fromCompletion) {
  const cur = draftValue('scheduler.dailyStartTime') || '';
  if (fromCompletion) {
    if (cur) _stashedStartTime = cur;
    setSettingValue('scheduler.dailyStartTime', '');
  } else {
    const restore = _stashedStartTime || cur || '08:00';
    setSettingValue('scheduler.dailyStartTime', restore);
  }
  paintSettings();
}

function setIntervalPart(part, raw) {
  const n = Math.max(0, Math.floor(Number(raw) || 0));
  const cur = Number(draftValue('scheduler.loopSeconds')) || 0;
  const p = decomposeLoopSeconds(cur);
  if (part === 'days') p.days = n;
  else if (part === 'hours') p.hours = n;
  else if (part === 'minutes') p.minutes = n;
  const total = p.days * 86400 + p.hours * 3600 + p.minutes * 60;
  setSettingValue('scheduler.loopSeconds', total);
  // Update the live summary in place so the user sees the recomposed value
  // without losing input focus to a full repaint.
  const summary = document.getElementById('schedIntervalSummary');
  if (summary) {
    const fromCompletion = !(draftValue('scheduler.dailyStartTime') || '');
    summary.textContent = formatIntervalPretty(total, fromCompletion);
  }
}

function renderSchedulerSection() {
  const startTime = draftValue('scheduler.dailyStartTime') || '';
  const loop = Number(draftValue('scheduler.loopSeconds')) || 0;
  const fromCompletion = !startTime;
  const p = decomposeLoopSeconds(loop);
  const pretty = formatIntervalPretty(loop, fromCompletion);
  const startOverridden = isOverriddenInForm('scheduler.dailyStartTime');
  const loopOverridden = isOverriddenInForm('scheduler.loopSeconds');
  const startDot = startOverridden ? '<span class="setting-dot" title="Overrides environment"></span>' : '';
  const loopDot = loopOverridden ? '<span class="setting-dot" title="Overrides environment"></span>' : '';
  const startRevert = startOverridden ? '<button type="button" class="setting-revert" onclick="revertSettingValue(\\'scheduler.dailyStartTime\\')">Revert</button>' : '';
  const loopRevert = loopOverridden ? '<button type="button" class="setting-revert" onclick="revertSettingValue(\\'scheduler.loopSeconds\\')">Revert</button>' : '';

  const startTimeRow = fromCompletion ? '' : (
    '<div class="setting" data-path="scheduler.dailyStartTime">' +
      '<div class="setting-label">Start time' + startDot + '</div>' +
      '<div class="setting-input">' +
        '<input type="time" value="' + escapeHtml(startTime) +
          '" onchange="if(this.value) _stashedStartTime = this.value; setSettingValue(\\'scheduler.dailyStartTime\\', this.value)"' +
          ' onblur="paintSettings()">' +
      '</div>' +
      startRevert +
    '</div>'
  );

  return '<div class="settings-pane-title">Scheduler</div>' +
    '<div class="setting-help-inline" style="margin-bottom:14px">' +
      'Drives the main claim chain — Prime, Epic, GOG, Steam, Ubisoft, AliExpress. Microsoft Rewards has its own independent schedule under Services → Microsoft Rewards.' +
    '</div>' +
    '<div class="setting setting-bool">' +
      '<label class="setting-bool-cluster">' +
        '<input type="checkbox" ' + (fromCompletion ? 'checked' : '') +
          ' onchange="setScheduleMode(this.checked)">' +
        '<span>Run interval after each completion <span class="muted">(no fixed clock time — drifts by run duration)</span></span>' +
      '</label>' +
    '</div>' +
    startTimeRow +
    '<div class="setting" data-path="scheduler.loopSeconds">' +
      '<div class="setting-label">Interval' + loopDot + '</div>' +
      '<div class="setting-input setting-interval-grid">' +
        '<input type="number" min="0" max="365" value="' + p.days + '" oninput="setIntervalPart(\\'days\\', this.value)">' +
        '<span class="interval-unit">days</span>' +
        '<input type="number" min="0" max="23" value="' + p.hours + '" oninput="setIntervalPart(\\'hours\\', this.value)">' +
        '<span class="interval-unit">hours</span>' +
        '<input type="number" min="0" max="59" value="' + p.minutes + '" oninput="setIntervalPart(\\'minutes\\', this.value)">' +
        '<span class="interval-unit">minutes</span>' +
        '<span class="interval-summary" id="schedIntervalSummary">' + escapeHtml(pretty) + '</span>' +
      '</div>' +
      loopRevert +
    '</div>';
}

function paintSettings() {
  const view = document.getElementById('settingsView');
  if (!view || !settingsData) return;

  let html = '';
  if (currentSettingsSection === 'scheduler') {
    html = renderSchedulerSection();
  } else if (currentSettingsSection === 'notifications') {
    html =
      '<div class="settings-pane-title">Notifications' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-check-all" onclick="testNotify()" id="btnTestNotify">Send test</button>' +
      '</div>' +
      settingGroup('Destinations',
        fieldRow('notifications.notify', 'Apprise URL(s)',
          { multiline: true, hint: 'One URL per line (or comma-separated). Examples: pover://token@user, tgram://botid/chatid.' }) +
        fieldRow('notifications.notifyTitle', 'Title prefix') +
        fieldRow('notifications.attachScreenshots', 'Attach screenshot to failures',
          { hint: 'When a claim fails, attach the most recent .png from data/screenshots/ to the notification. Off if you prefer to keep notifications text-only (privacy or bandwidth).' })
      ) +
      settingGroup('Panel link',
        fieldRow('panel.publicUrl', 'Public URL',
          { hint: 'External URL used in notifications so tap-targets land on the panel.' })
      );
  } else if (currentSettingsSection === 'services') {
    // Three-way split by row category (set by getServiceRows in
    // src/sites.js): 'game' (claims free games — writes a claim DB),
    // 'points' (collects points/coins for redemption), 'watch'
    // (notify-only watcher).
    const gameRows   = SERVICE_ROWS.filter(r => r.category === 'game');
    const pointRows  = SERVICE_ROWS.filter(r => r.category === 'points');
    const watchRows  = SERVICE_ROWS.filter(r => r.category === 'watch');
    let svcInner = '';
    if (gameRows.length) {
      svcInner += '<div class="svc-section-header">Game Collectors</div>';
      svcInner += gameRows.map(serviceRow).join('');
    }
    if (pointRows.length) {
      svcInner += '<div class="svc-section-header">Point Collectors</div>';
      svcInner += pointRows.map(serviceRow).join('');
    }
    if (watchRows.length) {
      svcInner += '<div class="svc-section-header">Notify-Only Collectors</div>';
      svcInner += watchRows.map(serviceRow).join('');
    }
    html = '<div class="settings-pane-title">Services</div>' +
      '<div class="svc-list">' +
        svcInner +
      '</div>';
  } else if (currentSettingsSection === 'advanced') {
    // Order reflects what someone opening Advanced is usually there for:
    // first timeouts (most common debug tweak), then dry-run / recording,
    // then viewport.
    html =
      '<div class="settings-pane-title">Advanced</div>' +
      settingGroup('Timeouts',
        fieldRow('advanced.timeoutSec',      'Default timeout (seconds)', { unit: 'seconds', hint: 'Applies to Playwright page operations.' }) +
        fieldRow('advanced.loginTimeoutSec', 'Login timeout (seconds)',   { unit: 'seconds', hint: 'Separate timeout used during the login flow.' })
      ) +
      settingGroup('Debug',
        fieldRow('advanced.dryrun', 'Dry run — skip actual claiming',     { hint: 'Runs the claim pipeline without actually claiming anything. Useful for testing.' }) +
        fieldRow('advanced.record', 'Record HAR + video for debugging',   { hint: 'Writes per-run .webm + .har to data/record/. Heavier runs.' })
      ) +
      settingGroup('Viewport',
        fieldRow('advanced.width',  'Browser viewport width') +
        fieldRow('advanced.height', 'Browser viewport height')
      );
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
    // Refresh the shared state so Sessions, Schedule, Stats, and any
    // other tab that reads from in-memory state reflects the new
    // effective config immediately rather than waiting for the next
    // 10-second poll. refreshState also calls render, so the Sessions
    // card grid, Watchers section, and Available drawer all reconcile
    // in one round trip; tabs that derive from state only on entry
    // pick it up the next time they open.
    await refreshState();
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
  // Native tooltip uses &#10; for line breaks so each "Service: Title" lands on
  // its own row. Each line is escaped first; the entity is appended after so
  // it survives as a real newline when the browser parses the title attribute.
  const escAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const bars = daily.map(d => {
    const pct = (d.count / yMax) * 100;
    const cls = d.count === 0 ? ' zero' : '';
    const lines = [d.date + ': ' + d.count].concat(
      (d.items || []).map(it => (it.serviceName || it.service) + ': ' + it.title)
    );
    const tip = lines.map(escAttr).join('&#10;');
    return '<div class="bar' + cls + '" style="height:' + pct + '%" title="' + tip + '"></div>';
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
  const fmtH = h => String(h).padStart(2, '0') + ':00';

  if (state.legacyCombinedMode) {
    // Legacy: single combined chain anchored 30m before MS window.
    if (state.nextScheduledRun) {
      parts.push(
        '<div class="sched-row"><div class="sched-label">Next run</div>' +
        '<div><span class="sched-value big" title="' + state.nextScheduledRun + '">' + formatTimestamp(state.nextScheduledRun, 'short') + '</span>' +
        '<span class="sched-count" id="schedCountdown"></span></div></div>'
      );
    } else {
      parts.push('<div class="sched-row"><div class="sched-label">Next run</div><div class="sched-value muted">Calculating…</div></div>');
    }
    const s = state.msScheduleStart || 0;
    const w = state.msScheduleHours;
    parts.push('<div class="sched-row"><div class="sched-label">MS window</div>' +
      '<div><span class="sched-value">' + fmtH(s) + ' &rarr; ' + fmtH((Number(s) + Number(w)) % 24) + ' daily</span></div></div>');
    parts.push('<div class="sched-row"><div class="sched-label">Mode</div><div class="sched-value">Legacy combined — anchored 30m before MS window. <span class="muted">Set START_TIME or LOOP for two independent schedules.</span></div></div>');
  } else {
    // Decoupled: separate rows per schedule.
    if (state.mainEnabled) {
      if (state.nextMainRun) {
        parts.push(
          '<div class="sched-row"><div class="sched-label">Next run · Claimers</div>' +
          '<div><span class="sched-value big" title="' + state.nextMainRun + '">' + formatTimestamp(state.nextMainRun, 'short') + '</span>' +
          '<span class="sched-count" id="mainCountdown"></span></div></div>'
        );
      } else {
        parts.push('<div class="sched-row"><div class="sched-label">Next run · Claimers</div><div class="sched-value muted">Calculating…</div></div>');
      }
      // Interval description for the main schedule.
      let mainInterval;
      if (state.dailyAnchored) {
        const loop = state.loopSeconds || 0;
        if (loop === 0 || loop === 86400) mainInterval = 'Daily at ' + state.dailyStartTime;
        else {
          const hrs = loop / 3600;
          const span = (hrs >= 1 && Number.isInteger(hrs)) ? hrs + 'h'
            : (loop >= 60 ? Math.round(loop / 60) + 'm' : loop + 's');
          mainInterval = 'Every ' + span + ', anchored at ' + state.dailyStartTime;
        }
      } else if (state.loopSeconds > 0) {
        const hrs = state.loopSeconds / 3600;
        if (hrs >= 1 && Number.isInteger(hrs)) mainInterval = 'Every ' + hrs + ' hour' + (hrs === 1 ? '' : 's') + ' from completion';
        else if (state.loopSeconds >= 60) mainInterval = 'Every ' + Math.round(state.loopSeconds / 60) + ' minutes from completion';
        else mainInterval = 'Every ' + state.loopSeconds + ' seconds from completion';
      } else {
        mainInterval = '';
      }
      if (mainInterval) parts.push('<div class="sched-row"><div class="sched-label">Interval · Claimers</div><div class="sched-value muted">' + mainInterval + '</div></div>');
    } else {
      parts.push('<div class="sched-row"><div class="sched-label">Claimers</div><div class="sched-value muted">Not scheduled — set START_TIME or LOOP in Settings → Scheduler.</div></div>');
    }

    if (state.msScheduled) {
      const statusBadge = state.msTodayStatus === 'missed'
        ? ' <span class="muted">(missed today — Run manually from the MS card)</span>'
        : state.msTodayStatus === 'fired'
          ? ' <span class="muted">(today already fired)</span>'
          : '';
      if (state.nextMsRun) {
        parts.push(
          '<div class="sched-row"><div class="sched-label">Next run · MS Rewards</div>' +
          '<div><span class="sched-value big" title="' + state.nextMsRun + '">' + formatTimestamp(state.nextMsRun, 'short') + '</span>' +
          '<span class="sched-count" id="msCountdown"></span>' + statusBadge + '</div></div>'
        );
      } else {
        parts.push('<div class="sched-row"><div class="sched-label">Next run · MS Rewards</div><div class="sched-value muted">Calculating…</div></div>');
      }
      const s = state.msScheduleStart || 0;
      const w = state.msScheduleHours;
      parts.push('<div class="sched-row"><div class="sched-label">Interval · MS Rewards</div><div class="sched-value muted">Random within ' + fmtH(s) + ' &rarr; ' + fmtH((Number(s) + Number(w)) % 24) + ' daily</div></div>');
    }

    if (!state.mainEnabled && !state.msScheduled) {
      parts.push('<div class="sched-row"><div class="sched-label">Status</div><div class="sched-value muted">Scheduler disabled — set START_TIME, LOOP, or MS_SCHEDULE_HOURS to enable.</div></div>');
    }
  }

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
    if ((state.msScheduleHours || 0) > 0) {
      // Window itself shown in dedicated MS-window row above; keep this
      // bullet behavioural only.
      svcLines.push('<b>Microsoft Rewards</b> — searches inside MS window');
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

function formatCountdown(target) {
  const delta = target - Date.now();
  if (delta <= 0) return ' · due now';
  const mins = Math.floor(delta / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return ' · in ' + days + 'd ' + (hrs % 24) + 'h';
  if (hrs > 0) return ' · in ' + hrs + 'h ' + (mins % 60) + 'm';
  return ' · in ' + Math.max(mins, 1) + 'm';
}
function updateScheduleCountdown() {
  const apply = (id, ts) => {
    const el = document.getElementById(id);
    if (!el || !ts) return;
    const t = new Date(ts.replace(' ', 'T')).getTime();
    if (Number.isFinite(t)) el.textContent = formatCountdown(t);
  };
  apply('schedCountdown', state.nextScheduledRun);
  apply('mainCountdown', state.nextMainRun);
  apply('msCountdown', state.nextMsRun);
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

async function refreshPendingSteamCount() {
  try {
    const r = await api('GET', '/pending-steam-count');
    pendingSteamCount = r.count || 0;
  } catch { pendingSteamCount = 0; }
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

  // Steam batch-redeem panel — same pattern, separate state.
  const steamInfo = document.getElementById('steamRedeemInfo');
  const sr = state.steamRedeem;
  if (sr) {
    steamInfo.style.display = 'block';
    const s = sr.stats || {};
    const progressBar = '<span style="color:#888">' + sr.index + ' / ' + sr.total + ' keys</span>';
    const statsBits = [];
    if (s.redeemed) statsBits.push(s.redeemed + ' redeemed');
    if (s.alreadyOwned) statsBits.push(s.alreadyOwned + ' already owned');
    if (s.usedElsewhere) statsBits.push(s.usedElsewhere + ' used elsewhere');
    if (s.invalid) statsBits.push(s.invalid + ' invalid');
    if (s.regionLocked) statsBits.push(s.regionLocked + ' region-locked');
    if (s.rateLimited) statsBits.push('rate-limited');
    if (s.timeouts) statsBits.push(s.timeouts + ' timeouts');
    if (s.errors) statsBits.push(s.errors + ' errors');
    const statsLine = statsBits.join(', ');
    const bgColor = sr.phase === 'awaiting-captcha' ? '#3a1a1e' : sr.phase === 'done' ? '#1a3a2e' : sr.phase === 'stopped' || sr.phase === 'error' ? '#3a2a1e' : '#0f3460';
    const borderColor = sr.phase === 'awaiting-captcha' ? '#e94560' : sr.phase === 'done' ? '#4ecca3' : '#555';
    let buttonsHtml = '';
    if (sr.phase === 'running' || sr.phase === 'awaiting-captcha') {
      buttonsHtml = '<button class="btn btn-stop" onclick="stopSteamRedeem()">Stop</button>';
    } else {
      buttonsHtml = '<button class="btn btn-cancel" onclick="clearSteamRedeem()">Dismiss</button>';
    }
    steamInfo.innerHTML =
      '<div style="background:' + bgColor + ';border:1px solid ' + borderColor + ';border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
      '  <div style="flex:1;min-width:240px">' +
      '    <div style="font-weight:600;margin-bottom:2px">Steam batch redeem — ' + sr.phase + '</div>' +
      '    <div style="font-size:13px;margin-bottom:4px">' + sr.message + '</div>' +
      '    <div style="font-size:12px;color:#888">' + progressBar + ' · ' + (statsLine || 'no results yet') + '</div>' +
      '  </div>' +
      '  <div>' + buttonsHtml + '</div>' +
      '</div>';
  } else if (pendingSteamCount > 0) {
    steamInfo.style.display = 'block';
    steamInfo.innerHTML =
      '<div style="background:#0f3460;border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:12px">' +
      '  <div style="flex:1"><b>' + pendingSteamCount + ' pending Steam key' + (pendingSteamCount === 1 ? '' : 's') + '</b> — auto-redeems each via store.steampowered.com</div>' +
      '  <button class="btn btn-run" onclick="startSteamRedeem()">Batch Redeem on Steam</button>' +
      '</div>';
  } else {
    steamInfo.style.display = 'none';
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
  // during an active login (so the VNC iframe has more room) or whenever the
  // user has clicked the chevron in the status strip to collapse the session
  // panel manually.
  steps.style.display = (state.allLoggedIn || state.activeBrowser || sessionsCollapsed) ? 'none' : 'flex';
  cards.style.display = (state.activeBrowser || sessionsCollapsed) ? 'none' : 'grid';

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
    const ownedElsewhere = !!(state.activeBrowser || state.batchRedeem || state.steamRedeem);
    btnShowBrowser.disabled = ownedElsewhere;
    btnShowBrowser.textContent = ownedElsewhere ? 'Browser shown' : (userShowBrowser ? 'Hide browser' : 'Show browser');
    btnShowBrowser.classList.toggle('active', userShowBrowser || ownedElsewhere);
  }
  const btnPopoutBrowser = document.getElementById('btnPopoutBrowser');
  if (btnPopoutBrowser) {
    // Pop out only makes sense as a follow-up to Show browser — it'd be noise
    // (or worse, a dead link in degraded networks) if always visible.
    const iframeMounted = !!(userShowBrowser || state.activeBrowser || state.batchRedeem || state.steamRedeem);
    btnPopoutBrowser.style.display = iframeMounted ? '' : 'none';
  }

  const placeholder = document.getElementById('vncPlaceholder');
  if (placeholder && !state.activeBrowser && !state.batchRedeem && !state.steamRedeem && !showingLog && !userShowBrowser) {
    placeholder.style.display = 'flex';
    const wrap = inner => '<div style="max-width:520px;font-size:14px;line-height:1.7;color:#a0b4d4">' + inner + '</div>';
    if (state.startupAutoCheck) {
      placeholder.innerHTML = wrap('Checking sessions (' + state.startupAutoCheck.current + '/' + state.startupAutoCheck.total + ')…');
    } else if (state.allLoggedIn && state.sites.length > 0) {
      // Status strip in the header already communicates "all sessions OK" —
      // don't repeat it here. Just explain what this empty space is for.
      placeholder.innerHTML = wrap(
        'Click <b style="color:#e0e0e0">Run Now</b> to trigger an immediate claim, or let the scheduler handle it on its next tick.<br><br>' +
        'Click <b style="color:#e0e0e0">Login</b> on a session card or <b style="color:#e0e0e0">Show browser</b> in the header to mount the live browser view here. ' +
        'Run output streams in the <b style="color:#e0e0e0">Logs</b> tab.'
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
    // runSource carries a richer identifier than the original 'scheduler'/
    // 'panel' constants — the scheduler tags it 'scheduler-main' or
    // 'scheduler-ms' (with an optional ':site+site' suffix), and the panel's
    // per-card Run uses 'panel:<id>'. Treat any prefix as the run kind.
    const src = (state.runSource && /^scheduler/.test(state.runSource)) ? 'scheduler' : 'manual';
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

  if (stripText && !sessionsCollapsed) {
    strip.style.display = 'flex';
    strip.className = 'status-strip sessions-only ' + stripKind;
    strip.innerHTML =
      '<span class="strip-primary">' + stripText + '</span>' +
      (stripSecondary ? '<span class="strip-secondary">' + stripSecondary + '</span>' : '');
  } else {
    strip.style.display = 'none';
  }

  // Compact session row — replaces the full cards strip when collapsed.
  // One mini-card per active service: name + status glyph (✓ / ✕ / ? / !).
  const compact = document.getElementById('compactSessions');
  if (compact) {
    if (sessionsCollapsed) {
      compact.classList.add('shown');
      const glyphFor = s =>
        s.status === 'logged_in'      ? '✓' :
        s.status === 'not_logged_in'  ? '✕' :
        s.status === 'error'          ? '!' :
                                        '?';
      compact.innerHTML = activeSites.map(s =>
        '<span class="mini-card ' + s.status + '" title="' + s.name + ': ' + s.status.replace('_', ' ') + '">' +
          escapeHtml(s.name) +
          '<span class="mini-glyph">' + glyphFor(s) + '</span>' +
        '</span>'
      ).join('');
    } else {
      compact.classList.remove('shown');
      compact.innerHTML = '';
    }
  }
  const btnHeaderCollapse = document.getElementById('btnHeaderCollapse');
  if (btnHeaderCollapse) {
    btnHeaderCollapse.textContent = sessionsCollapsed ? '▾' : '▴';
    const t = sessionsCollapsed ? 'Expand session details' : 'Collapse session details';
    btnHeaderCollapse.title = t;
    btnHeaderCollapse.setAttribute('aria-label', t);
  }

  // Captcha banner — shows on every tab when a runner has flagged a captcha.
  // Click drops the user straight into Sessions tab + collapsed + browser shown.
  const captchaBanner = document.getElementById('captchaBanner');
  if (captchaBanner) {
    if (state.captchaPending) {
      captchaBanner.style.display = 'flex';
      const since = state.captchaPending.since
        ? ' · started ' + formatTimestamp(state.captchaPending.since, 'relative')
        : '';
      captchaBanner.innerHTML =
        '<span class="cb-icon">⚠</span>' +
        '<span class="cb-text">' +
          escapeHtml(state.captchaPending.service) + ' captcha — ' +
          escapeHtml(state.captchaPending.label) + since +
        '</span>' +
        '<span class="cb-cta">Open browser →</span>';
    } else {
      captchaBanner.style.display = 'none';
    }
  }

  // Split sites into active (main grid) and inactive (drawer below).
  const activeCards = state.sites.filter(s => s.active !== false);
  const inactiveCards = state.sites.filter(s => s.active === false);

  cards.innerHTML = activeCards.map(s => {
    const dotClass = s.status === 'logged_in' ? 'logged-in' : s.status === 'not_logged_in' ? 'not-logged-in' : s.status === 'error' ? 'error' : 'unknown';
    const statusClass = dotClass;
    let statusText = 'Not checked';
    if (s.status === 'logged_in') statusText = 'Logged in' + (s.user ? ' as ' + s.user : '') + '.';
    else if (s.status === 'not_logged_in') statusText = 'Not logged in.';
    else if (s.status === 'error') statusText = 'Error checking.';
    if (s.lastSuccessfulRun) statusText += ' Successful Run ' + s.lastSuccessfulRun + '.';
    else statusText += ' Successful Run: never.';
    const versionLabel = s.version ? '<div class="site-card-version">v' + escapeHtml(s.version) + '</div>' : '';
    // Login OR Check button, status-driven. The "force re-login" override
    // is rendered separately as a small bare icon in the card header
    // (top-right, next to the version) so it doesn't look like a primary
    // action button — only shown when logged in, since when not-logged-in
    // the Login button is already directly available.
    const isLoggedIn = s.status === 'logged_in';
    const loginOrCheck = isLoggedIn
      ? '<button class="btn btn-check" onclick="checkSite(\\'' + s.id + '\\')" ' + (disabled ? 'disabled' : '') + '>Check</button>'
      : '<button class="btn btn-login" onclick="launchSite(\\'' + s.id + '\\')" ' + (disabled ? 'disabled' : '') + '>Login</button>';
    const reloginIcon = isLoggedIn
      ? '<button class="site-card-relogin" onclick="confirmRelogin(\\'' + s.id + '\\')" ' + (disabled ? 'disabled' : '') + ' title="Change account / force re-login" aria-label="Change account">↻</button>'
      : '';
    return '<div class="site-card">' +
      '<div class="site-card-header">' +
        '<div class="dot ' + dotClass + '"></div>' +
        '<div class="name">' + s.name + '</div>' +
        versionLabel +
        reloginIcon +
      '</div>' +
      '<div class="status ' + statusClass + '">' + statusText + '</div>' +
      '<div class="card-actions">' +
        loginOrCheck +
        '<button class="btn btn-cookie" onclick="openCookieModal(\\'' + s.id + '\\')" ' + (disabled ? 'disabled' : '') + ' title="Import cookies for this site (paste JSON or upload a file)">↑ Cookie</button>' +
        '<button class="btn btn-run-single" onclick="runSite(\\'' + s.id + '\\')" ' + (disabled ? 'disabled' : '') + ' title="Run this service now">Run</button>' +
      '</div>' +
    '</div>';
  }).join('');

  // Compact cards for active watch-only collectors. Smaller than full
  // session cards (no dot, no Login/Check, just a Run button) so the
  // page stays scannable as the watcher list grows. Inactive watchers
  // are surfaced in Settings → Services rather than here, to keep
  // this page focused on what's currently in play.
  const watcherEl = document.getElementById('watcherCards');
  const watchers = state.watchers || [];
  if (watcherEl) {
    if (watchers.length === 0 || sessionsCollapsed) {
      watcherEl.style.display = 'none';
      watcherEl.innerHTML = '';
    } else {
      watcherEl.style.display = 'block';
      const watcherCardsHtml = watchers.map(w => {
        const versionLabel = w.version ? '<div class="site-card-version">v' + escapeHtml(w.version) + '</div>' : '';
        return '<div class="site-card watcher">' +
          '<div class="site-card-header">' +
            '<div class="name">' + escapeHtml(w.name) + '</div>' +
            versionLabel +
          '</div>' +
          '<div class="status">Watch-only</div>' +
          '<div class="card-actions">' +
            '<button class="btn btn-run-single" onclick="runSite(\\'' + w.id + '\\')" ' + (disabled ? 'disabled' : '') + ' title="Run this watcher now">Run</button>' +
          '</div>' +
        '</div>';
      }).join('');
      watcherEl.innerHTML =
        '<div class="watcher-section-title">Watchers</div>' +
        '<div class="watcher-cards">' + watcherCardsHtml + '</div>';
    }
  }

  // "Available services" drawer — inactive sites with a single Enable button.
  const drawer = document.getElementById('availableDrawer');
  if (drawer) {
    if (inactiveCards.length === 0 || sessionsCollapsed) {
      drawer.style.display = 'none';
    } else {
      drawer.style.display = 'block';
      const expanded = drawerExpanded;
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

// Drop the user straight onto the captcha. Used by both the in-panel banner
// click and the ?focus=captcha deep link from notification pushes — the link
// arrives via a phone or whatever and we want the next tap to be solving the
// challenge, not navigating tabs.
function focusCaptcha() {
  if (document.body.dataset.tab !== 'sessions') switchTab('sessions');
  if (!sessionsCollapsed) {
    sessionsCollapsed = true;
    localStorage.setItem('sessionsCollapsed', '1');
  }
  if (!userShowBrowser && !state.activeBrowser && !state.batchRedeem && !state.steamRedeem) {
    userShowBrowser = true;
    showVnc();
  }
  render();
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
  if (state.activeBrowser || state.batchRedeem || state.steamRedeem) return;
  userShowBrowser = !userShowBrowser;
  if (userShowBrowser) {
    showVnc(); // mounts iframe; also calls hideRunLog() which hides the log el
  } else {
    const container = document.getElementById('vncContainer');
    const iframe = container.querySelector('iframe');
    if (iframe) iframe.remove();
    // Don't auto-restore the run log here — earlier versions did, but a user
    // peeking at the browser mid-run then closing got jarring "log bleed-
    // through" on the Sessions tab. The Logs tab is one click away if they
    // want it; render() falls through to the placeholder.
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

// One-shot guard for the ?focus=captcha deep link — applied after the first
// successful state load (so we know which tab/collapsed state is current)
// and the URL param is then stripped so a refresh doesn't re-trigger.
let initialUrlFocusApplied = false;
function applyUrlFocus() {
  if (initialUrlFocusApplied) return;
  initialUrlFocusApplied = true;
  const params = new URLSearchParams(location.search);
  if (params.get('focus') === 'captcha') {
    focusCaptcha();
    params.delete('focus');
    const search = params.toString();
    history.replaceState({}, '', location.pathname + (search ? '?' + search : ''));
  }
}

async function refreshState() {
  try {
    state = await api('GET', '/state');
    render();
    if (typeof updateBatchPolling === 'function') updateBatchPolling();
    applyUrlFocus();
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

// Cookie-import modal — paste-or-upload entry, validate JSON shape on
// the client before sending so trivial typos surface fast, then
// dispatch to /api/site/cookies which handles domain validation,
// addCookies, and a follow-up checkSiteStatus.
let cookieModalSiteId = null;
function openCookieModal(siteId) {
  cookieModalSiteId = siteId;
  const site = state.sites.find(s => s.id === siteId);
  if (!site) return;
  const modal = document.getElementById('cookieModal');
  document.getElementById('cookieModalSite').textContent = site.name;
  document.getElementById('cookieFileInput').value = '';
  document.getElementById('cookiePasteInput').value = '';
  setCookieMsg('', '');
  modal.style.display = 'flex';
  // Wire up the action buttons each open so closures capture the
  // current siteId without a global handler reference.
  const cancelBtn = modal.querySelector('.cookie-cancel');
  const submitBtn = modal.querySelector('.cookie-submit');
  cancelBtn.onclick = closeCookieModal;
  submitBtn.onclick = () => submitCookies();
  modal.onclick = (e) => { if (e.target === modal) closeCookieModal(); };
  document.addEventListener('keydown', cookieModalEscHandler);
}
function cookieModalEscHandler(e) { if (e.key === 'Escape') closeCookieModal(); }
function closeCookieModal() {
  const modal = document.getElementById('cookieModal');
  modal.style.display = 'none';
  modal.onclick = null;
  cookieModalSiteId = null;
  document.removeEventListener('keydown', cookieModalEscHandler);
}
function setCookieMsg(text, kind) {
  const el = document.getElementById('cookieModalMsg');
  el.textContent = text;
  el.className = 'cookie-modal-msg ' + (kind || '');
}
async function submitCookies() {
  if (!cookieModalSiteId) return;
  const fileInput = document.getElementById('cookieFileInput');
  const pasteInput = document.getElementById('cookiePasteInput');
  let raw = pasteInput.value.trim();
  if (fileInput.files && fileInput.files[0]) {
    try { raw = await fileInput.files[0].text(); }
    catch (e) { setCookieMsg('Could not read file: ' + e.message, 'error'); return; }
  }
  if (!raw) { setCookieMsg('Paste a cookie JSON or pick a file first', 'error'); return; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { setCookieMsg('Invalid JSON: ' + e.message, 'error'); return; }
  setCookieMsg('Importing...', 'info');
  const submitBtn = document.querySelector('#cookieModal .cookie-submit');
  if (submitBtn) submitBtn.disabled = true;
  try {
    const result = await api('POST', '/site/cookies', { site: cookieModalSiteId, cookies: parsed });
    if (result.success) {
      const note = result.loggedIn
        ? 'Imported ' + result.applied + ' cookie(s); session check passed' + (result.user ? ' (logged in as ' + result.user + ')' : '')
        : 'Imported ' + result.applied + ' cookie(s); session check still says not logged in (cookies may be expired or missing the auth cookie)';
      closeCookieModal();
      showToast(note, result.loggedIn ? 'success' : 'info', 6000);
      await refreshState();
    } else {
      setCookieMsg(result.error || 'Import failed', 'error');
    }
  } catch (e) {
    setCookieMsg('Upload failed: ' + e.message, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// Change-accounts confirm — opens the Login flow for the site only
// after the user confirms, so a stray click on ↻ next to a working
// session doesn't drop them into a fresh browser cold-start.
function confirmRelogin(siteId) {
  const site = state.sites.find(s => s.id === siteId);
  if (!site) return;
  const modal = document.getElementById('reloginModal');
  document.getElementById('reloginModalSite').textContent = site.name;
  const cancelBtn = modal.querySelector('.relogin-cancel');
  const confirmBtn = modal.querySelector('.relogin-confirm');
  const close = () => {
    modal.style.display = 'none';
    cancelBtn.onclick = confirmBtn.onclick = null;
    modal.onclick = null;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  cancelBtn.onclick = close;
  confirmBtn.onclick = () => { close(); launchSite(siteId); };
  modal.onclick = (e) => { if (e.target === modal) close(); };
  document.addEventListener('keydown', onKey);
  modal.style.display = 'flex';
  cancelBtn.focus();
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

async function startSteamRedeem() {
  busy = true; render();
  try {
    const r = await api('POST', '/steam-redeem/start');
    if (r.success) {
      showToast('Steam batch redeem started — ' + r.total + ' key(s) queued.', 'success');
      showVnc();
    } else {
      showToast(r.error || 'Failed to start Steam batch redeem.', 'error');
    }
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  busy = false;
  await refreshState();
}

async function stopSteamRedeem() {
  try {
    await api('POST', '/steam-redeem/stop');
    showToast('Steam batch redeem stopped.', 'info');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  await refreshState();
}

async function clearSteamRedeem() {
  try {
    await api('POST', '/steam-redeem/clear');
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
  await refreshPendingSteamCount();
  await refreshState();
}

// Faster poll when batch-redeem is active so progress updates feel live.
// Same timer covers both GOG and Steam batches; only one runs at a time
// (browserBusy mutex prevents overlap), so a single 2s tick when either
// is active is enough.
let batchPollTimer = null;
function updateBatchPolling() {
  const gogActive = state.batchRedeem && (state.batchRedeem.phase === 'running' || state.batchRedeem.phase === 'awaiting-captcha');
  const steamActive = state.steamRedeem && (state.steamRedeem.phase === 'running' || state.steamRedeem.phase === 'awaiting-captcha');
  const active = gogActive || steamActive;
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
  await refreshPendingSteamCount();
  await refreshState();
  updateBatchPolling();
  await handleDeepLink();
}
initialLoad();
setInterval(async () => {
  await refreshState();
  if (!state.batchRedeem) await refreshPendingGogCount();
  if (!state.steamRedeem) await refreshPendingSteamCount();
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

    if (req.method === 'POST' && req.url === '/api/site/cookies') {
      try {
        const body = await parseBody(req);
        if (!body || !body.site || body.cookies == null) {
          sendJson(res, { success: false, error: 'site and cookies required' }, 400);
          return;
        }
        const result = await importSiteCookies(body.site, body.cookies);
        sendJson(res, { success: true, ...result });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
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
        captchaPending = null;
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

    if (req.method === 'GET' && req.url === '/api/pending-steam-count') {
      const count = await countPendingSteamCodes();
      sendJson(res, { count });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/steam-redeem/start') {
      try {
        const result = await startSteamRedeem();
        sendJson(res, result);
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 400);
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/api/steam-redeem/stop') {
      const result = await stopSteamRedeem();
      sendJson(res, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/steam-redeem/clear') {
      clearFinishedSteamRedeem();
      sendJson(res, { success: true });
      return;
    }

    // Static asset serving — branding (logo + favicon set). Path-allowlisted
    // to /assets/ + /favicon.ico to avoid traversal; we never serve arbitrary
    // files. Browser tab favicon hits /favicon.ico without the prefix on
    // some browsers, so we map both.
    if (req.method === 'GET') {
      let assetPath = null;
      if (req.url === '/favicon.ico') assetPath = 'favicon.ico';
      else if (req.url.startsWith('/assets/')) {
        const rel = req.url.slice('/assets/'.length).split('?')[0];
        if (rel && !rel.includes('..') && !rel.includes('/')) assetPath = rel;
      }
      if (assetPath) {
        const full = path.join(__panelDirname, 'assets', assetPath);
        if (existsSync(full)) {
          const ext = path.extname(assetPath).toLowerCase();
          const ct = { '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
          res.end(readFileSync(full));
          return;
        }
      }
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
  if (steamRedeem) {
    steamRedeem.phase = 'stopped';
    try { if (steamRedeem.context) await steamRedeem.context.close(); } catch {}
  }
  await closeBrowser();
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.listen(PANEL_PORT, async () => {
  console.log(`[${datetime()}] Free Games Claimer ${APP_VERSION ? 'v' + APP_VERSION + ' ' : ''}— panel + scheduler`);
  console.log(`[${datetime()}] Control panel: http://localhost:${PANEL_PORT}${BASE_PATH}`);
  if (cfg.public_url) console.log(`[${datetime()}] Public URL:    ${PUBLIC_URL}`);
  console.log(`[${datetime()}] noVNC viewer:  http://localhost:${NOVNC_PORT}${BASE_PATH ? ` (proxied at ${BASE_PATH}/novnc/)` : ''}`);
  console.log(`[${datetime()}] Password protection: ${PANEL_PASSWORD ? 'ENABLED' : 'DISABLED (set PANEL_PASSWORD or VNC_PASSWORD to enable)'}`);
  const startTime = cfg.daily_start_time;
  const legacyMode = !startTime && !LOOP_SECONDS && MS_SCHEDULE_HOURS > 0;
  if (legacyMode) {
    console.log(`[${datetime()}] Scheduler (legacy combined): enabled (full chain anchored 30m before MS window start ${MS_SCHEDULE_START}:00)`);
  } else {
    if (startTime) {
      console.log(`[${datetime()}] Scheduler (main): enabled (anchored at ${startTime}, interval ${LOOP_SECONDS > 0 ? LOOP_SECONDS : 86400}s)`);
    } else if (LOOP_SECONDS > 0) {
      console.log(`[${datetime()}] Scheduler (main): enabled (every ${LOOP_SECONDS}s from completion)`);
    } else {
      console.log(`[${datetime()}] Scheduler (main): disabled (set START_TIME or LOOP to enable)`);
    }
    if (MS_SCHEDULE_HOURS > 0) {
      console.log(`[${datetime()}] Scheduler (MS): enabled (random within ${MS_SCHEDULE_START}:00 → ${(MS_SCHEDULE_START + MS_SCHEDULE_HOURS) % 24}:00)`);
    } else {
      console.log(`[${datetime()}] Scheduler (MS): disabled (set MS_SCHEDULE_HOURS to enable)`);
    }
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

  // Kick off the two scheduler loops after session auto-check so first runs
  // see fresh status. Loops always start — disabled paths park inside
  // sleepUntilWakeup and re-arm on config change via watchConfigForScheduler.
  mainSchedulerLoop().catch(err => {
    console.error(`[${datetime()}] Scheduler (main) crashed:`, err);
  });
  msSchedulerLoop().catch(err => {
    console.error(`[${datetime()}] Scheduler (MS) crashed:`, err);
  });
  watchConfigForScheduler();
});
