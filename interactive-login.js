import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { watch, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __panelDirname = path.dirname(fileURLToPath(import.meta.url));
import { chromium } from 'patchright';
import { datetime, notify, jsonDb, normalizeTitle, cleanProfileLocks, localeArgs } from './src/util.js';
import { cfg } from './src/config.js';
import { describeConfig, patchConfig, describeEnv, getSchedulerConfig, CONFIG_FILE_PATH } from './src/app-config.js';
import { SITES as SITE_REGISTRY, getLoginSitesById, getClaimScriptOrder, getLinkedActiveMap, getClaimDbFiles, getServiceRows } from './src/sites.js';
import { fetchGamerPowerGiveaways, filterFor as filterGpFor, COLLECTOR_PATTERNS as GP_COLLECTOR_PATTERNS, GP_TITLE_HINTS } from './src/gamerpower.js';
import { fetchFGFPosts, filterFor as filterFgfFor, cleanTitle as fgfCleanTitle, COLLECTOR_TITLE_PATTERNS as FGF_COLLECTOR_PATTERNS } from './src/freegamefindings.js';

const PANEL_PORT = Number(process.env.PANEL_PORT) || 7080;
const NOVNC_PORT = process.env.NOVNC_PORT || 6080;
// Optional explicit override for the noVNC iframe URL — needed when noVNC
// lives behind a reverse proxy at a different hostname/path than the panel
// (e.g. Traefik routing /panel to fgc.example.com and /novnc to
// browser.example.com — the default `<panel-host>:6080` construction
// can't reach it). When set, buildNovncUrl() returns this verbatim and
// skips host/port assembly. Issue #20.
const NOVNC_URL = (process.env.NOVNC_URL || '').replace(/\/+$/, '');
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
  // If the *same* site is already open, treat the request as idempotent and
  // re-use the existing context. Mobile push clients (Pushover, Apple Mail,
  // etc.) commonly re-fire a tap as two HTTP requests; without this guard
  // the second request closed the first browser and opened a fresh one,
  // orphaning the verify the user was about to do — observed 2026-05-25
  // when two ?login=epic-games hits 2 s apart left the second context
  // dangling and blocked MS for the rest of the morning.
  if (activeBrowser && activeBrowser.siteId === siteId) {
    const site = SITES[siteId];
    console.log(`[${datetime()}] Browser already open for ${site.name} — reusing existing session.`);
    return { success: true, site: siteId, name: site.name, reused: true };
  }
  if (activeBrowser) {
    await closeBrowser();
  }
  const site = SITES[siteId];
  if (!site) throw new Error(`Unknown site: ${siteId}`);

  console.log(`[${datetime()}] Launching browser for ${site.name}...`);

  cleanProfileLocks(site.browserDir);
  const context = await chromium.launchPersistentContext(site.browserDir, {
    headless: false,
    viewport: { width: cfg.width, height: cfg.height },
    locale: 'en-US',
    handleSIGINT: false,
    args: ['--hide-crash-restore-bubble', ...localeArgs()],
    ...(site.contextOptions || {}),
  });

  context.setDefaultTimeout(0);

  const page = context.pages().length ? context.pages()[0] : await context.newPage();
  if (!site.contextOptions?.viewport) await page.setViewportSize({ width: cfg.width, height: cfg.height });
  await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded' });

  activeBrowser = { siteId, context, page, openedAt: Date.now() };
  console.log(`[${datetime()}] Browser launched for ${site.name}. User can now log in via VNC.`);
  return { success: true, site: siteId, name: site.name };
}

// How long an interactive browser session can sit before we assume the
// user forgot it open. Anything > 30 min is well beyond any normal
// login flow (typically <5 min, captcha solves <10 min). Without this
// timeout a forgotten Login session blocks the MS scheduler (and
// everything else that needs the profile) indefinitely — observed
// 2026-05-25 when Epic's session was held the full morning and the
// MS slot rolled to tomorrow.
const ACTIVE_BROWSER_STALE_MS = 30 * 60 * 1000;
async function expireStaleActiveBrowser() {
  if (!activeBrowser) return false;
  const age = Date.now() - (activeBrowser.openedAt || 0);
  if (age < ACTIVE_BROWSER_STALE_MS) return false;
  const name = SITES[activeBrowser.siteId]?.name || activeBrowser.siteId;
  console.log(`[${datetime()}] Auto-closing stale ${name} login session — open ${Math.round(age / 60000)} min, exceeded ${ACTIVE_BROWSER_STALE_MS / 60000}-min idle threshold.`);
  await closeBrowser();
  return true;
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
    cleanProfileLocks(site.browserDir);
    context = await chromium.launchPersistentContext(site.browserDir, {
      headless: false,
      viewport: { width: cfg.width, height: cfg.height },
      locale: 'en-US',
      handleSIGINT: false,
      args: ['--hide-crash-restore-bubble', '--no-sandbox', '--disable-gpu', ...localeArgs()],
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
    cleanProfileLocks(site.browserDir);
    context = await chromium.launchPersistentContext(site.browserDir, {
      headless: false,
      viewport: { width: cfg.width, height: cfg.height },
      locale: 'en-US',
      handleSIGINT: false,
      args: ['--hide-crash-restore-bubble', ...localeArgs()],
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

// Per-run history persistence — issue #29. Each completed run gets one
// entry in data/runs.json (lowdb). The Logs tab can browse past runs
// via a dropdown that calls /api/runs (list) and /api/runs/:at (full
// log). Cap is read dynamically at persist time via describeConfig()
// so Settings → Advanced edits take effect on the next run without
// requiring a panel restart.
let runHistoryDb = null;

// Persisted scheduler state — issue #32. Without this, the LOOP-without-
// anchor mode (bare LOOP, no START_TIME) resets its wake clock to
// "24h from now" on every panel restart. That silently skips daily
// runs when a user restarts the container at all (image pulls, host
// reboots, panel updates). We persist the last successful main-chain
// completion timestamp and use it as the wake anchor on boot so the
// scheduler honors "24h from last completion" across restarts —
// firing immediately when past-due, sleeping the remainder when not.
let schedulerStateDb = null;

// Persisted user-state for the Discoveries tab — per-item "ignored" or
// "manually-claimed" markers the user applies via row actions. Keyed by
// `${collectorKey}::${normalizedTitle}` so the same game discovered by
// both GamerPower and FGF dedupes to one state entry. Entries auto-prune
// 14d after their `at` timestamp when the corresponding game has dropped
// out of the active aggregator feeds (so the state file doesn't grow
// unbounded). Loaded lazily in the /api/discoveries endpoint.
let discoveriesStateDb = null;

// In-memory cache of the /api/discoveries response body. Aggregator
// fetches (GamerPower + Reddit) total ~800ms — too slow to fire on
// every panel render. With this cache, repeat visits within the TTL
// window return in <5ms; the user only pays the aggregator latency
// once per TTL or when they hit Refresh (force=1 bypasses cache).
const DISC_CACHE_TTL_MS = 5 * 60 * 1000;
let discResponseCache = null; // { body, builtAt (ms) }

// Update check (issue #39). Periodic poll of GitHub releases to detect
// when a newer image is published; surfaces in the panel header as a
// small pill linking to the changelog. Manual pull / restart still
// required — we never call docker.sock (would need the host's socket
// mounted, security smell). Disabled by env UPDATE_CHECK=0 for offline
// / air-gapped deployments. Cached in JS memory + persisted to
// data/update-check.json so we don't hammer GitHub on every panel
// reload. Check cadence: once every 6 hours.
const UPDATE_CHECK_INTERVAL_MS = 6 * 3600 * 1000;
const UPDATE_CHECK_DISABLED = (() => {
  const v = String(process.env.UPDATE_CHECK || '').toLowerCase().trim();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
})();
let updateCheckCache = null; // { latest, current, behind, checkedAt, releaseUrl }
let updateCheckDb = null;
let updateCheckTimer = null;
async function loadUpdateCheckCache() {
  if (updateCheckDb) return;
  try { updateCheckDb = await jsonDb('update-check.json', {}); }
  catch { updateCheckDb = { data: {}, write: async () => {} }; }
  if (updateCheckDb.data && updateCheckDb.data.checkedAt) updateCheckCache = updateCheckDb.data;
}
// Compare semver-ish strings ("2.7.0" vs "2.8.0"). Returns true when
// `latest` is strictly newer than `current`. Tolerant of trailing -beta
// / -rc / + build metadata — those get sorted lexically after the bare
// version, so 2.7.0 < 2.7.0-rc1 (a release candidate published after
// the stable would be considered newer, which is correct).
function isNewerVersion(latest, current) {
  if (!latest || !current) return false;
  const norm = s => String(s).replace(/^v/i, '').split(/[.\-+]/).map(p => /^\d+$/.test(p) ? p.padStart(8, '0') : p);
  const a = norm(latest);
  const b = norm(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] || '';
    const bi = b[i] || '';
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}
async function fetchLatestRelease() {
  // Primary: /releases/latest. Returns a real release if one is published.
  // Falls back to /tags when no releases exist on the repo — covers the
  // case where the maintainer pushes a version-shaped git tag (v2.7.0)
  // without going through GitHub's "create release" workflow. /tags is
  // always available as long as any tag is pushed.
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': `free-games-claimer/${APP_VERSION || '0.0.0'}` };
  try {
    const r = await fetch('https://api.github.com/repos/feldorn/free-games-claimer/releases/latest', {
      headers, signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const j = await r.json();
      if (j.tag_name) return { tag: j.tag_name, url: j.html_url || '' };
    } else if (r.status !== 404) {
      console.warn(`[${datetime()}] update check: /releases/latest returned ${r.status}`);
      return null;
    }
    // 404 → fall through to /tags
  } catch (e) {
    console.warn(`[${datetime()}] update check: /releases fetch failed — ${e.message}`);
    return null;
  }
  // Tags fallback. Returns array of tags newest-first by commit date.
  // Pick the first one that parses as a version (vN.N.N or N.N.N).
  try {
    const r = await fetch('https://api.github.com/repos/feldorn/free-games-claimer/tags?per_page=20', {
      headers, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      console.warn(`[${datetime()}] update check: /tags returned ${r.status}`);
      return null;
    }
    const tags = await r.json();
    if (!Array.isArray(tags)) return null;
    // GitHub's /tags ordering isn't strictly by version — pick the
    // highest semver-shaped tag explicitly to avoid latching onto an
    // old back-tagged hotfix as "newest".
    const versioned = tags.filter(t => /^v?\d+(\.\d+)+/.test(t.name || ''));
    if (!versioned.length) return null;
    versioned.sort((a, b) => isNewerVersion(a.name, b.name) ? -1 : 1);
    const top = versioned[0];
    // Link directly to the CHANGELOG section so users see *what's in*
    // the new release, not just the bare tag commit. GitHub's anchor
    // formula for "## What's new in 2.8.1" is `#whats-new-in-281`
    // (lowercase, apostrophes/dots stripped, spaces to hyphens).
    const ver = String(top.name).replace(/^v/, '').replace(/\./g, '');
    return { tag: top.name, url: `https://github.com/feldorn/free-games-claimer/blob/main/CHANGELOG.md#whats-new-in-${ver}` };
  } catch (e) {
    console.warn(`[${datetime()}] update check: /tags fetch failed — ${e.message}`);
    return null;
  }
}
async function runUpdateCheck() {
  if (UPDATE_CHECK_DISABLED) return;
  await loadUpdateCheckCache();
  const latest = await fetchLatestRelease();
  if (!latest) return;
  const current = APP_VERSION || '0.0.0';
  const behind = isNewerVersion(latest.tag, current);
  updateCheckCache = { latest: latest.tag, current, behind, checkedAt: new Date().toISOString(), releaseUrl: latest.url };
  if (updateCheckDb) {
    updateCheckDb.data = updateCheckCache;
    try { await updateCheckDb.write(); } catch {}
  }
}
function startUpdateCheckLoop() {
  if (UPDATE_CHECK_DISABLED) return;
  if (updateCheckTimer) return;
  // Initial check after panel boot (delayed 30s so first-paint isn't
  // gated on a network round-trip), then every UPDATE_CHECK_INTERVAL_MS.
  setTimeout(() => { runUpdateCheck().catch(() => {}); }, 30000);
  updateCheckTimer = setInterval(() => { runUpdateCheck().catch(() => {}); }, UPDATE_CHECK_INTERVAL_MS);
}
function getRunHistoryMax() {
  try {
    const eff = describeConfig().effective;
    const v = eff && eff.advanced && eff.advanced.runHistoryMax;
    return Math.max(1, Number(v) || 200);
  } catch { return 200; }
}
let runSource = null; // 'panel' | 'scheduler'
let lastRun = null; // { at, source, exitCode, status, startedAt, durationSec }
let runStartedAt = null;
// Set when a runner script emits [CAPTCHA-START] on stdout, cleared on
// [CAPTCHA-END] or run process exit. Drives the captcha banner + the
// ?focus=captcha deep link target. { service, label, since } when active.
let captchaPending = null;

// --- Diagnostics / error reporting (phase 1 — detection + DB) -------------
// Stream-side detection of crashes and uncaught exceptions from spawned
// claim scripts. The stdout/stderr handlers below scan each chunk for
// known error signatures; on a match we fingerprint the error and store
// it in data/diagnostics-state.json with dedup + occurrence counts.
//
// Phase 2 surfaces these via a header banner with three actions: Share
// (opens prefilled GitHub issues/new URL), Don't Share (per-fingerprint
// dismissal — same error never re-prompts), Never Share (global opt-out,
// flips diagnostics.enabled=false). Phase 3 ships a Diagnostics tab with
// full history. Env DIAGNOSTICS_BANNER=0 disables before any UI shows.
//
// Default = enabled. Per user discussion 2026-05-19: first error IS the
// prompt; the banner's Never Share button is the discoverable opt-out
// path. Existing-deploys see banner on next pull when they hit any
// error — first banner explains the feature.
const DIAGNOSTICS_BANNER_DISABLED_ENV = (() => {
  const v = String(process.env.DIAGNOSTICS_BANNER || '').toLowerCase().trim();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
})();
let diagnosticsDb = null;
// Tracks the most-recent ─── Section ─── header seen so subsequent
// error matches are attributed to the right script.
let _currentSection = null;
// Token-bucket guard: when an error pattern matches multiple lines of
// one stack (uncommon but possible), avoid recording duplicate hits
// for the same fingerprint within a 5-second window.
const _recentFingerprintHits = new Map();
async function loadDiagnosticsDb() {
  if (diagnosticsDb) return;
  try { diagnosticsDb = await jsonDb('diagnostics-state.json', { enabled: true, version: 1, errors: {} }); }
  catch { diagnosticsDb = { data: { enabled: true, version: 1, errors: {} }, write: async () => {} }; }
  if (!diagnosticsDb.data) diagnosticsDb.data = { enabled: true, version: 1, errors: {} };
  if (typeof diagnosticsDb.data.enabled !== 'boolean') diagnosticsDb.data.enabled = true;
  if (!diagnosticsDb.data.errors) diagnosticsDb.data.errors = {};
}
function _fingerprintError(script, errorClass, message, stackLines) {
  // Strip volatile bits — line:col refs, hex/numeric IDs, ISO timestamps
  // — so the SAME bug across runs and minor edits hashes to one entry
  // instead of fragmenting per-occurrence.
  const normalize = (s) => String(s || '')
    .replace(/:\d+:\d+\b/g, '')                              // file:LINE:COL → file:
    .replace(/\b0x[0-9a-f]+\b/gi, '0x…')                     // hex addresses
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.Z+-]+\b/g, '<ts>')    // ISO timestamps
    .replace(/\b\d{10,}\b/g, '<num>')                        // long numbers (epoch ms, IDs)
    .trim();
  let key = `${script}::${errorClass}::${normalize(message)}`;
  // AggregateError ("All promises were rejected") on its own under-
  // specifies the failure — two different Promise.any sites in the same
  // script would dedup to one fingerprint, so the user shares one and
  // future hits on the OTHER site go silent. Mix in the first cause's
  // first line when present (the log.exception helper emits `cause[0]:`)
  // so distinct Promise.any sites get distinct fingerprints.
  if (Array.isArray(stackLines)) {
    const causeIdx = stackLines.findIndex(l => /cause\[0\]:/.test(String(l || '')));
    if (causeIdx >= 0) {
      const causeLine = String(stackLines[causeIdx]).replace(/^.*cause\[0\]:\s*/, '');
      // Include the next line too if it's an indented continuation —
      // log.exception splits Playwright's "locator.waitFor: Timeout …"
      // onto line 1 and the actual selector (`waiting for locator(…)`)
      // onto line 2, and the selector is what distinguishes two
      // Promise.any sites in the same script (both timeouts look
      // identical on line 1). Without this, a Prime Gaming login race
      // and a claim-button race fingerprint identically.
      const next = stackLines[causeIdx + 1];
      const continuation = next && /^\s/.test(String(next)) && !/cause\[/.test(String(next))
        ? String(next).replace(/^>>\s+|^\s+/, '').trim()
        : '';
      key += `::${normalize(causeLine)}`;
      if (continuation) key += `::${normalize(continuation)}`;
    }
  }
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}
// Redact credentials and webhook URLs from captured diagnostic text
// before we persist or surface it. Apprise notifier URLs in particular
// embed bot tokens / webhook secrets directly (discord://<webhook>,
// pover://<apptoken>@<usertoken>, tgram://<bot-id>:<token>@<chat-id>,
// mailto://user:password@host, slack://<token>, etc.) — without this,
// any apprise CLI failure pulls the live credential into
// diagnostics-state.json and into the Share-to-GitHub flow. Reported
// as #66 — bgiesing had to manually redact a discord webhook before
// posting their auto-generated issue body.
const APPRISE_SCHEMES = [
  'discord', 'pover', 'tgram', 'slack', 'mailto', 'mailtos', 'msteams',
  'ntfy', 'ntfys', 'pushbullet', 'pushover', 'gotify', 'matrix', 'matrixs',
  'twilio', 'signal', 'rocket', 'rockets', 'xmpp', 'xmpps', 'wxteams',
  'wxteamsapi', 'webex', 'webexapi', 'mattermost', 'mattermosts',
];
const APPRISE_URL_RE = new RegExp('\\b(' + APPRISE_SCHEMES.join('|') + ')://[^\\s\'"]+', 'gi');
function _redactCredentials(s) {
  if (typeof s !== 'string' || !s) return s;
  return s
    // Apprise / webhook URLs — scheme://everything-until-whitespace
    .replace(APPRISE_URL_RE, '$1://<redacted>')
    // URL-embedded credentials in any scheme: foo://user:password@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s'"@/]*:[^\s'"@/]*@/gi, '$1<credentials-redacted>@')
    // Bearer tokens / generic API-key patterns the apprise libs sometimes emit
    .replace(/\b(Bearer\s+|api[_-]?key=|token=)[A-Za-z0-9._-]{8,}/gi, '$1<redacted>');
}

// Snapshot of config + run-state at error time. Goes into the issue body
// the panel pre-fills for diagnostics submissions, eliminating the rounds
// of "what's your scheduler config? which services are active? did you
// have PG_REDEEM on?" follow-ups that 6+ recent issues all needed. Pulls
// only from non-sensitive fields — no notification creds, no auth secrets,
// no DB contents beyond a per-service "credentials present? yes/no" flag.
// Failures here must not block diagnostics recording, so the entire body
// is wrapped in try/catch and falls back to {}.
function _captureErrorContext() {
  try {
    const sched = getSchedulerConfig();
    const active = activeServices();
    const combined = legacyCombinedMode(sched, active);
    const has = (k) => Boolean(process.env[k] || cfg[k.toLowerCase()]);
    // Recent runs from data/runs.json — last 3, status only.
    let recentRuns = [];
    try {
      const runs = (runHistoryDb && runHistoryDb.data && runHistoryDb.data.runs) || [];
      recentRuns = runs.slice(-3).map(r => ({
        at: r.startedAt || r.at || '',
        status: r.status || (r.exitCode === 0 ? 'success' : 'error'),
        claimed: r.summary && typeof r.summary.claimed === 'number' ? r.summary.claimed : undefined,
        exit: r.exitCode,
      }));
    } catch {}
    return {
      scheduler: {
        mode: combined ? 'legacy-combined' : (sched.dailyStartTime ? 'decoupled' : (sched.loop ? 'loop-only' : 'manual')),
        dailyStartTime: sched.dailyStartTime || null,
        loopSeconds: sched.loop || 0,
        runOnStartup: cfg.run_on_startup || 0,
        msWindow: sched.msHours > 0
          ? { startHour: (sched.msScheduleStart != null ? sched.msScheduleStart : 8), hours: sched.msHours, runWithMainChain: !!cfg.ms_run_with_main_chain }
          : { off: true, runWithMainChain: !!cfg.ms_run_with_main_chain },
      },
      activeServices: Array.from(active).sort(),
      // Per-service flags that have shaped recent triage. "credsSet" is
      // a boolean — never the value itself.
      flags: {
        pg_redeem: !!cfg.pg_redeem,
        pg_redeem_max_attempts: cfg.pg_redeem_max_attempts,
        pg_baseUrl: cfg.pg_base_url,
        steam_skip_unrated: !!cfg.steam_skip_unrated,
        steam_min_price: cfg.steam_min_price,
        steam_min_rating: cfg.steam_min_rating,
        ms_search_delay_max: cfg.ms_search_delay_max,
        ms_redeem_threshold: cfg.ms_redeem_threshold,
        ms_run_with_main_chain: !!cfg.ms_run_with_main_chain,
        ae_credsSet: has('AE_EMAIL') && has('AE_PASSWORD'),
        pg_credsSet: has('PG_EMAIL') || has('EMAIL'),
        eg_credsSet: has('EG_EMAIL') || has('EMAIL'),
        steam_credsSet: has('STEAM_EMAIL') || has('EMAIL'),
        gog_credsSet: has('GOG_EMAIL') || has('EMAIL'),
        ms_credsSet: has('MS_EMAIL') || has('EMAIL'),
        notify_level: cfg.notify_level,
        base_path_set: !!cfg.base_path,
        public_url_set: !!cfg.public_url,
        novnc_url_set: !!process.env.NOVNC_URL,
      },
      recentRuns,
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        lang: process.env.LANG || process.env.LC_ALL || null,
        tz: process.env.TZ || null,
      },
    };
  } catch (e) {
    return { _captureError: String(e && e.message || e).slice(0, 200) };
  }
}

function _recordDiagnosticError(script, errorClass, message, stackLines) {
  if (!diagnosticsDb || !diagnosticsDb.data) return; // not loaded yet
  if (!diagnosticsDb.data.enabled) return;            // user opted out via Never Share
  // Redact before fingerprinting AND storing — the fingerprint should
  // stably collapse the same error across token rotations, and the
  // stored row must not contain live credentials.
  message = _redactCredentials(String(message || ''));
  const redactedStack = Array.isArray(stackLines) ? stackLines.map(_redactCredentials) : stackLines;
  const fp = _fingerprintError(script, errorClass, message, redactedStack);
  const now = Date.now();
  const recent = _recentFingerprintHits.get(fp);
  if (recent && (now - recent) < 5000) return;       // within 5s of last hit → skip
  _recentFingerprintHits.set(fp, now);
  const nowIso = new Date(now).toISOString();
  const errors = diagnosticsDb.data.errors;
  if (!errors[fp]) {
    errors[fp] = {
      script: script || 'unknown',
      errorClass: errorClass || 'Error',
      message: message.slice(0, 500),
      stack: Array.isArray(redactedStack) ? redactedStack.slice(0, 50).join('\n').slice(0, 6000) : '',
      context: _captureErrorContext(),
      firstSeen: nowIso,
      lastSeen: nowIso,
      count: 1,
      decided: null,
    };
  } else {
    errors[fp].lastSeen = nowIso;
    errors[fp].count = (errors[fp].count || 0) + 1;
    if (Array.isArray(redactedStack) && redactedStack.length) {
      errors[fp].stack = redactedStack.slice(0, 50).join('\n').slice(0, 6000);
    }
    // Refresh context on each occurrence — config can change between
    // first-seen and last-seen, and the reporter cares about the state
    // at the point they shared the banner (now), not the original.
    errors[fp].context = _captureErrorContext();
  }
  // Best-effort persist; failures here don't block the run.
  diagnosticsDb.write().catch(e => console.warn(`[${datetime()}] diagnostics-state write failed: ${e.message}`));
}
// Patterns: each entry produces (errorClass, message) pairs from a buffer.
// stdout/stderr chunks pass through these — first match wins per line.
// Lines are pre-stripped of ANSI codes and leading log markers
// ("  ✗ ", "  ! ", " ✓ ") so the patterns can stay anchored.
const DIAG_PATTERNS = [
  // Standard JS exception classes (the most actionable signal). Includes
  // bare `Error:` to catch the very common `throw new Error('...')`
  // shape that wasn't covered before — codebase has ~10 of those.
  /^(?<cls>ReferenceError|TypeError|SyntaxError|RangeError|EvalError|URIError|Error):\s+(?<msg>.+)$/,
  // Node's child_process error wrapper (apprise CLI failures, etc.)
  /^error:\s+(?<msg>Command failed:.*)$/,
  // Playwright / patchright protocol errors — common across the codebase.
  /^(?<cls>browserType\.\w+|page\.\w+|locator\.\w+):\s+(?<msg>.+)$/,
  // log.fail(`Exception: ${error.message || error}`) pattern used in
  // every claim script's top-level catch. After marker stripping, the
  // line reads "Exception: <message>" where <message> often contains
  // an inner Playwright/Node error — capture the whole thing as msg.
  /^Exception:\s+(?<msg>.+)$/,
];
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LEADING_MARKERS_RE = /^\s*[✓✗!✅❌]\s+/;
// Per-stream rolling tail of recent cleaned lines. Each invocation of
// _scanForErrors prepends the tail of the matching stream to the new
// chunk before scanning so the pre-error context window can reach
// across stderr `data` event boundaries. Without this, a script that
// prints a multi-line diagnostic dump and then throws on the next
// event-loop tick lands the dump in one chunk and the throw in
// another — the per-chunk 25-line window then captures only the throw
// stack with no preceding context (HelpMePleasepls's #78 AliExpress
// page-snapshot diagnostic dump was lost this way under v2.8.33).
// Bounded at TAIL_KEEP lines per stream so a long-running run can't
// accumulate unbounded memory. Reset between child processes via
// resetScanState().
const TAIL_KEEP = 60;
const _scanTails = new Map(); // streamKey → string[] of cleaned lines
function resetScanState() {
  _scanTails.clear();
  _currentSection = null;
}
function _scanForErrors(buffer, streamKey = 'default') {
  if (DIAGNOSTICS_BANNER_DISABLED_ENV) return;
  // Update the current section tracker from ─── headers.
  const sectionRe = /^─{3,}\s+(.+?)\s+(?:\(v[^)]+\))?\s*─{3,}\s*$/;
  const rawLines = String(buffer || '').split('\n');
  // Pre-clean each line: strip ANSI escape codes (chalk wraps the
  // status markers even when stdout isn't a TTY in some configs), then
  // strip the leading log marker so pattern anchors hold.
  const newLines = rawLines.map(l => l.replace(ANSI_RE, ''));
  const prevTail = _scanTails.get(streamKey) || [];
  // `lines` = prior tail concatenated with the just-arrived chunk. We
  // ONLY iterate i in [tailStart, lines.length) so old tail lines don't
  // re-trigger matches (the scanner deduplicates on fingerprint anyway,
  // but skipping re-scan is cheaper and avoids re-updating
  // _currentSection from stale section headers).
  const tailStart = prevTail.length;
  const lines = prevTail.concat(newLines);
  for (let i = tailStart; i < lines.length; i++) {
    const raw = lines[i];
    const sec = sectionRe.exec(raw);
    if (sec) { _currentSection = sec[1].trim(); continue; }
    const line = raw.replace(LEADING_MARKERS_RE, '');
    for (const pat of DIAG_PATTERNS) {
      const m = pat.exec(line);
      if (!m) continue;
      const cls = (m.groups && m.groups.cls) || 'Error';
      const msg = (m.groups && m.groups.msg) || '';
      // Capture 25 lines BEFORE + the match + 15 lines AFTER (cleaned)
      // for stack context. Now `lines` includes the prior chunk's tail,
      // so the window can reach into earlier stderr events for the
      // diagnostic-dump-then-throw pattern. Leading context carries
      // the most triage signal — flipside101's #50 single-line "All
      // promises were rejected" had no surrounding context at all, and
      // HelpMePleasepls's #78 AliExpress page-snapshot dump was lost
      // under v2.8.33 because the dump arrived in a separate stderr
      // chunk from the throw. Marker `>>` flags the match line so the
      // reader can find it. Final length is also capped at 6000 chars
      // in _recordDiagnosticError so an extra-noisy stack can't blow
      // out the diagnostics-state DB.
      const startIdx = Math.max(0, i - 25);
      const endIdx   = Math.min(lines.length, i + 16);
      const stack = lines.slice(startIdx, endIdx).map((l, idx) => {
        const cleaned = l.replace(/^\s*\d+:\d+:\d+\s+/, '');
        return (startIdx + idx === i) ? '>> ' + cleaned : '   ' + cleaned;
      });
      _recordDiagnosticError(_currentSection || 'unknown', cls, msg, stack);
      break;
    }
  }
  // Persist the last TAIL_KEEP lines as the new tail. Use the freshly-
  // appended `lines` (combined buffer) so the next event sees the most
  // recent context regardless of whether it came from the tail or the
  // current chunk.
  _scanTails.set(streamKey, lines.slice(-TAIL_KEEP));
}
// --- end diagnostics phase 1 ----------------------------------------------
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
// Aliveness check via signal-0 — costs nothing (no actual signal sent),
// just probes whether the kernel still has the pid. Used by browserBusy
// to detect stale runProcess state after a child died without firing
// 'close' or 'error' (host OOM-kill, signal swallowed by an exotic
// runtime, etc.). Reported as #62 (dabziuebu4egh2): panel showed
// "claim run in progress (panel:microsoft)" forever, but no MS process
// was actually running.
function _processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }   // exists
  catch (e) {
    if (e.code === 'EPERM') return true;       // exists but unsignalable — still alive
    return false;                              // ESRCH or anything else — gone
  }
}

function browserBusy({ allowActiveBrowser = false } = {}) {
  if (checkInProgress) return 'auto-checking session status';
  if (runProcess) {
    // Defensive: verify the child is actually alive. If runProcess is
    // set but the underlying pid is gone, the close/error handlers
    // didn't fire and the scheduler would otherwise treat the panel
    // as permanently busy.
    if (!_processAlive(runProcess.pid)) {
      console.warn(`[${datetime()}] Detected stale runProcess (pid=${runProcess.pid}, source=${runSource}) — resetting state.`);
      runProcess = null;
      runSource = null;
      runStartedAt = null;
    } else {
      return `claim run in progress${runSource ? ' (' + runSource + ')' : ''}`;
    }
  }
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
  cleanProfileLocks(cfg.dir.browser);
  const context = await chromium.launchPersistentContext(cfg.dir.browser, {
    headless: false,
    viewport: { width: cfg.width, height: cfg.height },
    locale: 'en-US',
    handleSIGINT: false,
    args: ['--hide-crash-restore-bubble', ...localeArgs()],
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
  cleanProfileLocks(cfg.dir.browser);
  const context = await chromium.launchPersistentContext(cfg.dir.browser, {
    headless: false,
    viewport: { width: cfg.width, height: cfg.height },
    locale: 'en-US',
    handleSIGINT: false,
    args: ['--hide-crash-restore-bubble', ...localeArgs()],
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

  // Run header — one line per claim run with the date, so the docker
  // logs / Logs tab clearly delimit one day's run from the next. The
  // runLog entry sets time:null so the Logs tab renders the header
  // without a redundant timestamp prefix (`=== Free Games Run — … ===`
  // is meant to be a clean visual delimiter, not another data row).
  const runDate = new Date().toISOString().slice(0, 10);
  // Include the panel's APP_VERSION inline so a glance at the run-log
  // header (in docker logs or the Past Runs picker) tells you which
  // version of the fork produced this run — important when triaging
  // "did this bug land before or after I upgraded" kinds of questions.
  const versionTag = APP_VERSION ? ` v${APP_VERSION}` : '';
  const runHeader = `=== Free Games Run${versionTag} — ${runDate} ===`;
  process.stdout.write(`\n${runHeader}\n\n`);
  runLog.push({ type: 'system', text: runHeader, time: null });

  // Aggregator for the run-level footer. Each service emits one [run]
  // marker on clean exit; the runner sums the metrics across all of
  // them into a single run-complete line.
  const runAgg = { services: 0, claimed: 0, skipped: 0, failed: 0, alreadyOwned: 0, tracked: 0, new: 0, pointsEarned: 0, onPage: 0, coins: 0 };

  // detached:true makes bash the leader of a new process group so the
  // Stop endpoint can SIGTERM the whole group (bash + node children +
  // their patchright Chromium descendants) via `process.kill(-child.pid)`.
  // Without this, signalling the immediate child only reaches bash, which
  // doesn't forward signals mid-pipeline, so SIGTERM was effectively a
  // no-op — children kept running while runProcess was cleared, causing
  // overlapping pipelines to fight over /fgc/data/browser (2026-05-14).
  const child = spawn('bash', ['-c', cmd], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  runProcess = child;
  // Reset the diagnostics scanner's per-stream tail buffers so the
  // previous run's tail can't bleed into this run's first-event window
  // (would re-trigger fingerprints we already recorded). Also clears
  // the section-header pointer so this run starts in `unknown` until
  // it actually hits its first ─── header.
  resetScanState();
  // Per-stream keys for _scanForErrors's tail buffer — keeps stdout
  // and stderr lookback independent. Including child.pid so two child
  // processes can't collide if their lifetimes overlap (shouldn't
  // happen in normal scheduler flow, but cheap insurance).
  const scanStdoutKey = `stdout:${child.pid}`;
  const scanStderrKey = `stderr:${child.pid}`;

  runDone = new Promise(resolve => {
    child.stdout.on('data', data => {
      process.stdout.write(data); // keep `docker logs` useful
      const text = data.toString();
      // Diagnostics detection — pattern-match for crashes/uncaught
      // exceptions and dedupe-record them to data/diagnostics-state.json.
      // Banner UI in phase 2 reads from there. No-op when env disables
      // the feature or the DB hasn't loaded yet.
      _scanForErrors(text, scanStdoutKey);
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
      // [run] markers from src/util.js#log.summary — combined success +
      // metrics signal, replacing the prior separate [RUN-SUCCESS] +
      // [RUN-SUMMARY] pair. Shape:
      //   [run] service=<id> ok claimed=<n> skipped=<n> <key>=<v> ...
      // The `ok` keyword carries success — `recordLastRunSuccess` only
      // fires when present. matchAll because microsoft.js emits two
      // markers (microsoft + microsoft-mobile) at the end of the run.
      for (const m of text.matchAll(/\[run\] service=(\S+) ok((?:\s+\w+=\d+)*)/g)) {
        recordLastRunSuccess(m[1]);
        runAgg.services++;
        for (const f of m[2].matchAll(/(\w+)=(\d+)/g)) {
          if (runAgg[f[1]] != null) runAgg[f[1]] += Number(f[2]);
        }
      }
      const lines = text.split('\n').filter(l => l.length);
      lines.forEach(l => {
        // [run] markers are the parser-only sibling of the human "summary:"
        // line — same data, twice. Hide them from the panel's Logs tab
        // (they still show up in `docker logs` for developer debugging,
        // and the matchAll above has already extracted what the runner
        // needs for lastSuccessfulRun + footer aggregation).
        if (/^\s*\[run\]\s/.test(l)) return;
        // Structural lines (─── section headers, === run delimiters) render
        // without a per-line timestamp prefix — they're visual delimiters,
        // not log events. ─── headers also get a synthetic blank line above
        // them so per-service blocks read as discrete chunks.
        const isSection = /^───/.test(l);
        const isHeader  = /^===/.test(l);
        if (isSection) {
          const last = runLog[runLog.length - 1];
          if (last && last.text !== '') runLog.push({ type: 'stdout', text: '', time: null });
        }
        runLog.push({ type: 'stdout', text: l, time: (isSection || isHeader) ? null : datetime() });
        if (runLog.length > 500) runLog.shift();
      });
    });

    child.stderr.on('data', data => {
      process.stderr.write(data);
      const text = data.toString();
      // Diagnostics: uncaught exceptions land on stderr (node:internal/
      // modules/run_main:NN preamble), so scan stderr too. Same dedup +
      // fingerprint path as stdout — pattern set isn't stream-specific.
      _scanForErrors(text, scanStderrKey);
      const lines = text.split('\n').filter(l => l.length);
      lines.forEach(l => {
        runLog.push({ type: 'stderr', text: l, time: datetime() });
        if (runLog.length > 500) runLog.shift();
      });
    });

    // Persist the scheduler-main wake anchor (issue #32). Updated from
    // the close handler whenever a scheduler-main run finishes; used by
    // computeMainWakeMs on boot so a panel restart doesn't reset the
    // bare-LOOP wake clock. Persist regardless of exit code — partial
    // failure still counts as "we fired today, don't fire again on
    // restart." Best-effort; write failures fall back to the original
    // sleep-from-now behavior.
    const persistMainCompletion = async () => {
      if (!schedulerStateDb) return;
      try {
        schedulerStateDb.data.lastMainCompletedAt = new Date().toISOString();
        await schedulerStateDb.write();
      } catch (e) {
        console.error(`[${datetime()}] failed to persist scheduler state: ${e.message}`);
      }
    };

    // Persist a finished run to data/runs.json so the Logs tab can
    // surface history. Called from both close and error handlers below.
    // Captures runLog at this exact moment (before runAllScripts resets
    // it on the next run) plus a snapshot of runAgg's aggregate counters
    // and metadata. Best-effort — DB write failures don't break the run.
    const persistRunHistory = async (exitCode, errorMsg) => {
      if (!runHistoryDb) return;
      try {
        runHistoryDb.data.runs.push({
          at: runStartedAt ? datetime(new Date(runStartedAt)) : datetime(),
          source: runSource,
          exitCode,
          status: runStatus,
          durationSec: runStartedAt ? Math.round((Date.now() - runStartedAt) / 1000) : null,
          summary: { ...runAgg },
          error: errorMsg || null,
          log: runLog.slice(),
        });
        const cap = getRunHistoryMax();
        if (runHistoryDb.data.runs.length > cap) {
          runHistoryDb.data.runs = runHistoryDb.data.runs.slice(-cap);
        }
        await runHistoryDb.write();
      } catch (e) {
        console.error(`[${datetime()}] failed to persist run history: ${e.message}`);
      }
    };

    child.on('close', code => {
      runStatus = code === 0 ? 'success' : 'finished';
      // Run-level footer summarises the aggregated [run] markers. claimed
      // and skipped always show (even when zero) so users can scan
      // vertically for the headline counts. Other fields appear only when
      // non-zero to avoid clutter. Footer skipped entirely if no service
      // reported in (config error, all services skipped).
      if (runAgg.services > 0) {
        const footerParts = [
          `${runAgg.services} services`,
          `${runAgg.claimed} claimed`,
          `${runAgg.skipped} skipped`,
        ];
        if (runAgg.failed) footerParts.push(`${runAgg.failed} failed`);
        if (runAgg.alreadyOwned) footerParts.push(`${runAgg.alreadyOwned} already owned`);
        if (runAgg.new) footerParts.push(`${runAgg.new} new tracked`);
        if (runAgg.pointsEarned) footerParts.push(`${runAgg.pointsEarned} points earned`);
        const footer = `=== Run complete: ${footerParts.join(', ')}, exit ${code} ===`;
        process.stdout.write(`\n${footer}\n`);
        // time:null suppresses the Logs tab's per-line timestamp prefix —
        // the "===" delimiter reads cleaner without it.
        runLog.push({ type: 'system', text: footer, time: null });
      }
      // "Scripts finished with exit code N" runLog push removed —
      // the run-complete footer above carries the exit code, and
      // duplicating it in two consecutive lines was redundant.
      lastRun = {
        at: datetime(),
        atIso: new Date().toISOString(),
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
      // Persist the scheduler-main completion timestamp so a panel
      // restart doesn't reset the bare-LOOP wake clock (issue #32).
      // We persist regardless of exit code — the intent is "scheduler
      // woke up and fired today", a partial-failure shouldn't cause us
      // to fire again immediately on next restart.
      if (runSource && runSource.startsWith('scheduler-main')) {
        void persistMainCompletion();
      }
      // Persist before clearing the closure-captured runSource/runStartedAt
      // so the history entry has the right metadata.
      void persistRunHistory(code, null);
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
        atIso: new Date().toISOString(),
        source: runSource,
        exitCode: -1,
        status: 'error',
        durationSec: runStartedAt ? Math.round((Date.now() - runStartedAt) / 1000) : null,
        error: err.message,
      };
      void persistRunHistory(-1, err.message);
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
  // When picking for today and we're already inside the window, constrain
  // the random offset to the *remaining* window — otherwise a uniform pick
  // can land in the past on first boot mid-window, and the immediate
  // pending+past check marks it missed before it ever ran (issue #47).
  // For a future day, the full window is fair game as before.
  const now = Date.now();
  const windowStart = new Date(y, m - 1, d, startHour, 0, 0, 0).getTime();
  const windowEnd = windowStart + c.msHours * 3600 * 1000;
  let minOffsetMin = 0;
  let maxOffsetMin = c.msHours * 60;
  if (dateKey === todayKey() && now > windowStart && now < windowEnd) {
    // 60s floor so the very first wake isn't a no-op tight-loop.
    minOffsetMin = Math.ceil((now - windowStart) / 60000) + 1;
    // If the floor sits at or past the ceiling, leave it equal — the
    // boot-time recovery in computeMsWakeMs will still reschedule the
    // remaining-window pick (sub-case 2) or mark missed (sub-case 3).
    if (minOffsetMin >= maxOffsetMin) minOffsetMin = maxOffsetMin - 1;
  }
  const span = Math.max(1, maxOffsetMin - minOffsetMin);
  const offsetMinutes = minOffsetMin + Math.floor(Math.random() * span);
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
// MS window — preserves pre-#10 single-chain-anchored-on-MS behavior. Also
// true when MS_RUN_WITH_MAIN_CHAIN is on, which lets users opt MS into the
// main daily run even when they have dailyStartTime/loop set (workaround
// for #69: decoupled scheduler quietly not firing in some environments).
function legacyCombinedMode(sched = getSchedulerConfig(), active = activeServices()) {
  const msActive = active.has('microsoft') || active.has('microsoft-mobile');
  if (!msActive) return false;
  if (cfg.ms_run_with_main_chain) return true;
  return !sched.dailyStartTime && !sched.loop && sched.msHours > 0;
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

  // Bare LOOP (no anchor) — anchor on the last persisted main-chain
  // completion so a panel restart doesn't push the next-wake forward
  // by however long the container was down (issue #32). Without
  // persistence, "every 24h" silently became "every 24h from boot"
  // and skipped days whenever the panel restarted.
  if (c.loop > 0) {
    const intervalMs = c.loop * 1000;
    const lastAt = schedulerStateDb && schedulerStateDb.data && schedulerStateDb.data.lastMainCompletedAt;
    if (lastAt) {
      const last = new Date(lastAt).getTime();
      if (Number.isFinite(last)) {
        // Past-due → fire immediately (caller's sleepUntilWakeup floors
        // negative values). The +60s floor below avoids tight loops on
        // a clock-skew or last-completion-in-the-future edge case.
        return Math.max(60 * 1000, last + intervalMs - Date.now());
      }
    }
    // No persisted state — first boot after upgrade, or first run ever.
    // Sleep the full interval from now; once that fires and completes,
    // the state file is populated and future restarts honor the anchor.
    return intervalMs;
  }

  return 0; // disabled
}

// Compute the next MS-only wake. Walks forward through the persisted state:
// if today is fired/missed or the pending target is past, eagerly picks
// tomorrow so getState() can always show a real upcoming timestamp.
// True when a persisted MS target falls within the active window bounds
// per the current config. Used by computeMsWakeMs to detect config-drift
// — when the user changes MS_SCHEDULE_HOURS or MS_SCHEDULE_START via the
// Settings UI, the previously-picked target may now lie completely
// outside the new window. Before this check the stale pick was honored,
// firing MS at the old time (Dr4w's #88). Validating against the live
// config invalidates the pick the next time computeMsWakeMs runs (which
// fireSchedulerWakeups already triggers on every config write), so no
// extra plumbing needed in watchConfigForScheduler.
function msTargetInWindow(st, c) {
  if (!st || !st.target || !st.date) return false;
  const target = new Date(st.target).getTime();
  if (!Number.isFinite(target)) return false;
  const [y, mo, d] = String(st.date).split('-').map(Number);
  if (!y || !mo || !d) return false;
  const windowStartMs = new Date(y, mo - 1, d, c.msStart, 0, 0, 0).getTime();
  const windowEndMs = windowStartMs + c.msHours * 3600 * 1000;
  return target >= windowStartMs && target < windowEndMs;
}

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
    // Persisted pick is stale if: file missing, date rolled forward, today
    // already fired/missed, OR the stored target now falls outside the
    // window bounds (Dr4w's #88 — config change after pick wasn't
    // invalidating the persisted target).
    const outOfWindow = st && st.date === today && st.status === 'pending'
      && !msTargetInWindow(st, c);
    if (outOfWindow) {
      console.log(`[${datetime()}] Scheduler (MS): persisted target ${st.target} is outside the current ${c.msStart}:00 + ${c.msHours}h window — repicking.`);
    }
    const needsFresh = !st
      || st.date < today
      || (st.date === today && (st.status === 'fired' || st.status === 'missed'))
      || outOfWindow;
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
      // Picked time is in the past. Three sub-cases handled in order:
      //
      //   1. A successful MS run happened between target and now —
      //      run completed before the restart, status just wasn't
      //      persisted. Promote to fired (no re-fire) and move on.
      //
      //   2. We're still inside today's MS window. Most common cause
      //      is a fresh container boot inside the window where
      //      pickMsTargetFor randomly chose an offset that's already
      //      past, OR a watchtower restart that consumed the pick.
      //      Repick a fresh target in the remaining window so today's
      //      slot still fires (60s minimum delay so we don't tight-loop;
      //      randomized so anti-detection variance is preserved).
      //      Distinct from "auto-fire late" (memory: missed-runs-need-
      //      manual-recovery) — that was about wake drift, not boot.
      //
      //   3. Past today's window end. Mark missed as before; user can
      //      manually fire via the per-card Run button.
      const [y, mo, d] = String(st.date).split('-').map(Number);
      const windowStartMs = new Date(y, (mo || 1) - 1, d || 1, c.msStart, 0, 0, 0).getTime();
      const windowEndMs = windowStartMs + c.msHours * 3600 * 1000;
      // Sub-case 1: did MS already run successfully today after target?
      const lastMsIso = lastRunSuccess && lastRunSuccess.microsoft;
      if (lastMsIso) {
        const lastMs = new Date(lastMsIso).getTime();
        if (Number.isFinite(lastMs) && lastMs >= target && lastMs <= now) {
          st.status = 'fired';
          writeMsScheduleToday(st);
          continue;
        }
      }
      // Sub-case 2: still inside today's window — repick remaining slot.
      const remainingMs = windowEndMs - now;
      if (remainingMs >= 90 * 1000) {
        const maxDelay = Math.max(60 * 1000, remainingMs - 30 * 1000);
        const delayMs = 60 * 1000 + Math.floor(Math.random() * (maxDelay - 60 * 1000));
        st.target = new Date(now + delayMs).toISOString();
        writeMsScheduleToday(st);
        continue;
      }
      // Sub-case 3: window has passed.
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
  // Preempt a forgotten/stale interactive Login session before checking
  // for a busy lock. Without this, a Login session left open for hours
  // (e.g. user clicked Login on Epic, then walked away) would block
  // every scheduled run until manually closed — observed 2026-05-25
  // costing the MS slot. Inside the 30-min staleness threshold, the
  // session is assumed live and we still respect the lock.
  await expireStaleActiveBrowser();
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
    const fired = await fireScheduledRun({
      label: 'main',
      sites,
      postRun: () => postRunSessionCheck(),
    });
    // Mirror 2.8.11's MS-scheduler backoff: when fireScheduledRun returns
    // false (blocker — another run in progress, batch redeem in flight,
    // interactive Login session active, etc.), back off 10 minutes before
    // the next wake. Without this, computeMainWakeMs's wake-floor of 60 s
    // means we tight-loop "Cannot start run — claim run in progress" once
    // per minute against a long-running or stuck blocker. Reported by
    // @dabziuebu4egh2 on #62 — 20+ minutes of one-line-per-minute log
    // spam against a phantom runProcess. The browserBusy aliveness check
    // (just added) auto-clears truly-dead runProcess state on the next
    // tick, but if the blocker is real-but-long, this prevents noise.
    if (!fired) {
      await sleepUntilWakeup(10 * 60 * 1000);
    }
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
    const fired = await fireScheduledRun({
      label: 'ms',
      sites: ['microsoft', 'microsoft-mobile'],
      extraEnv: { MS_SKIP_WINDOW: '1' },
    });
    // If the attempt was blocked (interactive browser session held by
    // another site, a claim run in progress, batch redeem running, …)
    // fireScheduledRun returns false. Without an explicit backoff here,
    // the next loop iteration calls computeMsWakeMs which sees a still-
    // pending past target and runs sub-case 2 (repick remaining window).
    // The remaining-window jitter shrinks as time passes, so retries get
    // tighter and tighter until the window runs out and we mark missed.
    // That's exactly what happened on 2026-05-25 when Epic's interactive
    // browser session was held for the full MS window — 7 retries
    // between 09:58 and 11:59, then rolled to tomorrow.
    //
    // Fix: when blocked, push the target forward by a fixed BLOCKED_BACKOFF
    // (10 minutes) so a typical short-lived blocker can clear without
    // burning multiple cycles. If the backed-off target would land past
    // today's window end, mark missed and roll to tomorrow.
    if (!fired) {
      const BLOCKED_BACKOFF_MS = 10 * 60 * 1000;
      const cNow = getSchedulerConfig();
      const stNow = readMsScheduleToday();
      if (stNow && stNow.status === 'pending') {
        const [y, mo, d] = String(stNow.date).split('-').map(Number);
        const windowStartMs = new Date(y, (mo || 1) - 1, d || 1, cNow.msStart, 0, 0, 0).getTime();
        const windowEndMs = windowStartMs + cNow.msHours * 3600 * 1000;
        const proposed = Date.now() + BLOCKED_BACKOFF_MS;
        if (proposed < windowEndMs) {
          stNow.target = new Date(proposed).toISOString();
          writeMsScheduleToday(stNow);
          console.log(`[${datetime()}] Scheduler (MS): blocked attempt — backed off ${BLOCKED_BACKOFF_MS / 60000} min, next try at ${datetime(new Date(proposed))}.`);
        } else {
          stNow.status = 'missed';
          writeMsScheduleToday(stNow);
          console.log(`[${datetime()}] Scheduler (MS): blocked attempt — backed-off retry would exceed today's window, marked missed.`);
        }
      }
    }
  }
}

// ----- Lenovo Gaming key drops scheduler -----
// Wakes at dynamic per-drop times computed from data/lenovo-gaming-watch.json
// (written by lenovo-gaming.js on each cycle). Three wakes per upcoming drop:
// 1 hour before, 5 minutes before, and at drop-time. Each wake fires a push
// notification and stamps the per-drop notifications.* field so the same wake
// doesn't re-fire on next loop iteration.

const LENOVO_STATE_FILE = path.resolve(__panelDirname, 'data', 'lenovo-gaming-watch.json');
let nextLenovoWake = null; // { dropId, kind, target } | null

function readLenovoState() {
  try {
    if (!existsSync(LENOVO_STATE_FILE)) return { drops: {} };
    const raw = readFileSync(LENOVO_STATE_FILE, 'utf8');
    if (!raw.trim()) return { drops: {} };
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? { drops: p.drops || {} } : { drops: {} };
  } catch { return { drops: {} }; }
}

function saveLenovoState(state) {
  try {
    mkdirSync(path.dirname(LENOVO_STATE_FILE), { recursive: true });
    writeFileSync(LENOVO_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`[${datetime()}] Lenovo: failed to persist state: ${e.message}`);
  }
}

// For each upcoming drop, returns the next un-fired wake (kind: '1h-before',
// '5min-before', 'wentLive') across all drops, or null if nothing pending.
// Skips drops the user marked as collected — those suppress pre-claim wakes.
// Restock notifications come from the watcher script directly, not this loop.
function computeNextLenovoWake() {
  const state = readLenovoState();
  const now = Date.now();
  let best = null;
  for (const drop of Object.values(state.drops)) {
    if (drop.userCollected) continue;
    if (!drop.scheduledAt) continue;
    if (drop.status === 'ended' || drop.status === 'expired' || drop.status === 'postponed') continue;
    const scheduledMs = new Date(drop.scheduledAt).getTime();
    if (!Number.isFinite(scheduledMs)) continue;
    const wakes = [
      { kind: '1h-before',   target: scheduledMs - 60 * 60 * 1000 },
      { kind: '5min-before', target: scheduledMs - 5 * 60 * 1000 },
      { kind: 'wentLive',    target: scheduledMs },
    ];
    for (const w of wakes) {
      if (drop.notifications?.[w.kind]) continue; // already fired
      // If wake is more than 5 minutes in the past, treat as missed and
      // mark sent next time we wake — don't pile up backlog notifications.
      const candidate = { kind: w.kind, target: new Date(w.target), dropId: drop.id, drop };
      if (!best || candidate.target.getTime() < best.target.getTime()) best = candidate;
    }
  }
  return best;
}

async function fireLenovoWake(wake) {
  const fresh = readLenovoState();
  const drop = fresh.drops[wake.dropId];
  if (!drop) return; // dropped from state somehow
  if (drop.userCollected) return; // user collected between schedule and fire

  // Past-target safety. Pre-alerts ("drop in 1h / 5min") are worthless
  // once stale — a late one is just confusing — so suppress them beyond
  // 5 min late (system suspended, container restarted across the wake).
  // The at-drop "LIVE NOW" wake is different: a limited-key drop is
  // usually still claimable for a while after it opens, so a late
  // "it's live, hurry" is still actionable. Allow wentLive up to 12h
  // late before suppressing — long enough to cover a same-day restart,
  // bounded so we don't ping about a drop that's days gone. (computeNext-
  // LenovoWake already excludes ended/expired/postponed drops, so a
  // wentLive wake only exists for one we still believe is live.)
  const lateBy = Date.now() - wake.target.getTime();
  const SUPPRESS_LATE_THRESHOLD = wake.kind === 'wentLive' ? 12 * 60 * 60 * 1000 : 5 * 60 * 1000;
  if (lateBy > SUPPRESS_LATE_THRESHOLD) {
    console.log(`[${datetime()}] Lenovo: ${wake.kind} for "${drop.title}" is ${Math.round(lateBy / 60000)}m late — marking sent without notify`);
    drop.notifications = drop.notifications || {};
    drop.notifications[wake.kind] = datetime();
    fresh.drops[wake.dropId] = drop;
    saveLenovoState(fresh);
    return;
  }

  // Compose per-kind notification body
  const localTimeStr = new Date(drop.scheduledAt).toLocaleString('en-US', {
    timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short',
  }) + ' ET';
  let body;
  if (wake.kind === '1h-before') {
    body = `Lenovo Gaming: drop in 1 hour — ${drop.title}<br>Going live: ${localTimeStr}<br>${drop.url}`;
  } else if (wake.kind === '5min-before') {
    body = `Lenovo Gaming: drop in 5 minutes — ${drop.title}<br>Get in queue<br>${drop.url}`;
  } else { // wentLive
    // When we're fired on time the "LIVE NOW" framing is accurate; when
    // we're catching up after a restart, say how long ago it opened so
    // the user knows keys may already be limited rather than expecting a
    // fresh drop.
    const lateMin = Math.round(lateBy / 60000);
    const liveNote = lateBy > 10 * 60 * 1000
      ? `Went live ~${lateMin >= 120 ? Math.round(lateMin / 60) + 'h' : lateMin + 'm'} ago — keys may be limited`
      : 'Claim before keys run out';
    const header = lateBy > 10 * 60 * 1000 ? 'drop is LIVE' : 'drop is LIVE NOW';
    body = `Lenovo Gaming: ${header} — ${drop.title}<br>${liveNote}<br>${drop.url}`;
    drop.status = 'active'; // promote local view; watcher will confirm next cycle
    drop.lastStatusChange = datetime();
  }
  console.log(`[${datetime()}] Lenovo: firing ${wake.kind} for "${drop.title}"`);
  // Read priority via describeConfig() so a Settings tab save takes effect
  // on the next wake without requiring a panel restart — cfg.lenovo_notify_priority
  // is module-scoped from boot and wouldn't see live edits.
  let lenovoPriority = 'normal';
  try {
    const eff = describeConfig().effective;
    lenovoPriority = (eff?.services?.['lenovo-gaming']?.notifyPriority) || 'normal';
  } catch { /* fall back to normal */ }
  await notify(body, { kind: 'action', priority: lenovoPriority })
    .catch(e => console.error(`[${datetime()}] Lenovo notify failed: ${e.message.split('\n')[0]}`));

  drop.notifications = drop.notifications || {};
  drop.notifications[wake.kind] = datetime();
  fresh.drops[wake.dropId] = drop;
  saveLenovoState(fresh);
}

async function lenovoSchedulerLoop() {
  while (true) {
    const wake = computeNextLenovoWake();
    if (!wake) {
      nextLenovoWake = null;
      // No upcoming drops with pending wakes — park until state file
      // changes (watcher writes new drops) or we hit the 1h re-poll fallback.
      await sleepUntilWakeup(60 * 60 * 1000);
      continue;
    }
    nextLenovoWake = { dropId: wake.dropId, kind: wake.kind, target: wake.target };
    const sleepMs = wake.target.getTime() - Date.now();
    if (sleepMs > 0) {
      console.log(`[${datetime()}] Scheduler (Lenovo): next wake at ${datetime(wake.target)} (${wake.kind} for "${wake.drop.title}")`);
      const how = await sleepUntilWakeup(sleepMs);
      if (how === 'reload') continue; // state file changed — recompute
    }
    await fireLenovoWake(wake);
  }
}

// Watches data/lenovo-gaming-watch.json and fires scheduler wakeups when the
// watcher updates it (new drops, collected toggles, etc.). Mirrors the
// existing watchConfigForScheduler() pattern.
function watchLenovoStateForScheduler() {
  const dir = path.dirname(LENOVO_STATE_FILE);
  const base = path.basename(LENOVO_STATE_FILE);
  let debounce = null;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    watch(dir, { persistent: false }, (eventType, filename) => {
      if (filename !== base) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        console.log(`[${datetime()}] Scheduler (Lenovo): state changed — recomputing next wake.`);
        fireSchedulerWakeups();
      }, 250);
    });
  } catch (e) {
    console.error(`[${datetime()}] Scheduler (Lenovo): fs.watch setup failed (${e.message}).`);
  }
}

async function getState() {
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
      // scheduleKind exposed so the Run-Now picker (and any other
      // category-aware UI) can group services without re-deriving from
      // hardcoded ID lists. Mirrors the registry value as-is.
      scheduleKind: site.scheduleKind || null,
      lastSuccessfulRun: lastRunSuccess[id] || null,
      // External-link target for the Sessions card "↗" icon. homeUrl
      // (where the user actually wants to land — store landing page,
      // rewards dashboard, etc.) wins; loginUrl is the fallback for
      // sites where it's already a useful destination (Prime, GOG,
      // MS, AliExpress all have homeUrl == loginUrl semantically).
      siteUrl: site.homeUrl || site.loginUrl || null,
      ...siteStatus[id],
    })),
    // Active watch-only collectors (scheduleKind: 'watch-only'). They are
    // not in `sites` because they have no checkLogin / session state, but
    // the Sessions tab renders them as compact "Run" cards next to the
    // login-capable cards. Only active watchers are listed; inactive ones
    // surface in Settings → Services.
    watchers: SITE_REGISTRY
      .filter(s => s.scheduleKind === 'watch-only' && active.has(s.id))
      .map(s => ({ id: s.id, name: s.name, version: s.version || null, siteUrl: s.homeUrl || s.loginUrl || null })),
    activeBrowser: activeBrowser ? { site: activeBrowser.siteId, name: SITES[activeBrowser.siteId].name } : null,
    allLoggedIn,
    runStatus,
    runSource,
    runLogLength: runLog.length,
    // Server-local timestamps (legacy fields — naked strings, no TZ marker).
    // Kept for any external /api/state consumers; the panel now prefers
    // the *Iso fields below for accurate display + countdown across TZs.
    nextScheduledRun: effectiveNext ? datetime(effectiveNext) : null,
    nextMainRun: effectiveMain ? datetime(effectiveMain) : null,
    nextMsRun: effectiveMs ? datetime(effectiveMs) : null,
    // ISO timestamps (UTC with Z) — unambiguous across browser/server TZs.
    // Panel uses these for both display formatting and countdown math so a
    // browser in a different TZ from the server sees the right wall time.
    nextScheduledRunIso: effectiveNext ? effectiveNext.toISOString() : null,
    nextMainRunIso: effectiveMain ? effectiveMain.toISOString() : null,
    nextMsRunIso: effectiveMs ? effectiveMs.toISOString() : null,
    serverTimezone: (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
      catch { return null; }
    })(),
    serverTimeIso: new Date().toISOString(),
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
    runOnStartup: cfg.run_on_startup || 0,
    appVersion: APP_VERSION || '',
    // Update-check pill — present only when a newer release is published
    // (issue #39). Null if checks disabled or no newer version found.
    updateAvailable: (updateCheckCache && updateCheckCache.behind)
      ? { current: updateCheckCache.current, latest: updateCheckCache.latest, releaseUrl: updateCheckCache.releaseUrl }
      : null,
    // Diagnostics banner state (phase 2). Surfaces the most-recent
    // undecided error fingerprint so the panel can show the
    // Share / Don't Share / Never Share banner. enabled=false means
    // the user clicked Never Share — banner stays hidden regardless
    // of any pending fingerprints (Settings tab can re-enable).
    diagnostics: (() => {
      if (!diagnosticsDb || !diagnosticsDb.data) return { enabled: true, pending: null };
      const enabled = diagnosticsDb.data.enabled !== false;
      if (!enabled) return { enabled: false, pending: null };
      const errs = diagnosticsDb.data.errors || {};
      // Find the most recently seen undecided fingerprint.
      let latest = null;
      for (const [fp, e] of Object.entries(errs)) {
        if (e.decided) continue;
        if (!latest || (e.lastSeen || '') > (latest.lastSeen || '')) {
          latest = { fingerprint: fp, ...e };
        }
      }
      if (!latest) return { enabled: true, pending: null };
      // Trim payload — client doesn't need full stack here, just enough
      // for the banner label. Full stack goes in the prefilled GitHub
      // URL constructed client-side.
      return {
        enabled: true,
        pending: {
          fingerprint: latest.fingerprint,
          script: latest.script,
          errorClass: latest.errorClass,
          message: latest.message,
          stack: latest.stack,
          count: latest.count,
          firstSeen: latest.firstSeen,
          lastSeen: latest.lastSeen,
          context: latest.context || null,
        },
      };
    })(),
    externalLinkMode: (() => {
      // Read via describeConfig() so the Settings tab can hot-update
      // this without needing a panel restart (same pattern as the other
      // panel-UI knobs that affect render-time decisions).
      try {
        const eff = describeConfig().effective;
        const v = eff?.panel?.externalLinkMode;
        return (v === 'same-tab' || v === 'new-tab') ? v : 'auto';
      } catch { return 'auto'; }
    })(),
    // Pending batch-redeem counts rolled into the main state response
    // (issue #17). Previously the panel polled /api/pending-gog-count
    // and /api/pending-steam-count separately on every cycle, tripling
    // the request count. Both helpers read small JSON files and are
    // cheap; folding them in here drops the steady-state poll load
    // from 3 requests to 1 per cycle.
    pendingGogCount: await countPendingGogCodes(),
    pendingSteamCount: await countPendingSteamCodes(),
    // Lenovo Gaming key drops state — surfaced for the watcher card UI.
    // The watcher keeps the file fresh; the scheduler fires per-drop wakes.
    lenovoGaming: (() => {
      const s = readLenovoState();
      const drops = Object.values(s.drops || {});
      return {
        drops,
        nextWake: nextLenovoWake ? {
          dropId: nextLenovoWake.dropId,
          kind: nextLenovoWake.kind,
          target: datetime(nextLenovoWake.target),
        } : null,
      };
    })(),
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
  const raw = [];
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
        // 'manual' is set by Epic when a previously-failed claim is later
        // detected as in-library — the user manually rescued it through
        // Epic's website. The game IS in their library, so it counts
        // toward Stats just like a script-claimed entry. (Same precedent
        // as Discoveries manually-claimed items being included since
        // 2.8.1.) Without this, every rescued Epic claim was silently
        // invisible to Stats — same shape as the pre-2.8.20 Prime bug.
        if (!status.startsWith('claimed') && status !== 'manual') continue;
        const at = parseLocalDateTime(entry.time);
        if (!at) continue;
        raw.push({ service, user, gameId, title: entry.title || gameId, url: entry.url || null, at, status });
      }
    }
  }
  // Manual claims from the Discoveries tab. Each entry's key is
  // `${collectorKey}::${matchKey(title)}` where collectorKey lines up
  // with our service ids for the storefronts we auto-claim (epic-games,
  // steam, gog, prime-gaming, ubisoft) and is a discovery-only label
  // for the rest (indiegala, itch-io, stove, mobile, console, vr, other).
  // Synthesizing claim records here means KPIs, Recent Claims, the daily
  // chart, and the per-service table all pick them up via the same
  // readAllClaims() path — no duplicate plumbing.
  try {
    const discDb = await jsonDb('discoveries-state.json', { items: {} });
    const items = discDb.data && discDb.data.items;
    if (items && typeof items === 'object') {
      for (const [key, entry] of Object.entries(items)) {
        if (!entry || entry.status !== 'manually-claimed') continue;
        // `at` is ISO; parseLocalDateTime expects "YYYY-MM-DD HH:MM:SS"
        // shape, so fall back to native Date parsing for ISO strings.
        let at = parseLocalDateTime(entry.at);
        if (!at) { const d = new Date(entry.at); if (!isNaN(d.getTime())) at = d; }
        if (!at) continue;
        const collectorKey = (String(key).split('::')[0] || 'other').trim() || 'other';
        // Strip GamerPower's "(Storefront) Giveaway" suffix so Recent
        // Claims displays "Carlos the Taco" instead of
        // "Carlos the Taco (IndieGala) Giveaway".
        const title = String(entry.title || key)
          .replace(/\s*\([^)]+\)\s*Giveaway\s*$/i, '')
          .trim() || String(entry.title || key);
        raw.push({
          service: collectorKey,
          user: 'manual',
          gameId: key,
          title,
          url: (typeof entry.url === 'string' && entry.url) ? entry.url : null,
          at,
          status: 'claimed-manual',
        });
      }
    }
  } catch { /* discoveries-state.json missing or unparsable — skip */ }
  // Dedupe platform variants. Epic surfaces some games under multiple
  // URL slugs (iOS / Android / locale-stamped variants), each persisted
  // as its own DB row — without deduping, both the recent-claims list
  // and the KPI counts (gamesThisWeek / gamesAllTime / per-service)
  // double-count the same game. Key on (service, normalized title) so
  // cross-service collisions (e.g. same title free on Epic AND Steam)
  // stay distinct. Keep the most-recent record per key — preserves the
  // latest claim time for recency-sort and matches the user's mental
  // model of "the last time I claimed this game." Reported on
  // 2026-05-17 — Arranger / Teacup appearing twice in Recent Claims.
  const byKey = new Map();
  for (const c of raw) {
    const key = c.service + '::' + normalizeTitle(c.title || c.gameId || '');
    const cur = byKey.get(key);
    if (!cur || c.at > cur.at) byKey.set(key, c);
  }
  return Array.from(byKey.values());
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
      serviceName: (SITES[latest.service] && SITES[latest.service].name) || DISCOVERY_DISPLAY_NAMES[latest.service] || latest.service,
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
    let row = rows[c.service];
    if (!row) {
      // Discovery-only storefront (indiegala, itch-io, stove, mobile,
      // console, vr, other) — no claim DB exists, so add a synthetic
      // row only when there's actually a manual claim to attribute.
      row = { id: c.service, unit: 'games', thisWeek: 0, thisMonth: 0, allTime: 0, lastClaimAt: null, discoveryOnly: true };
      rows[c.service] = row;
    }
    if (row.unit !== 'games') continue;
    row.allTime++;
    if (c.at.getTime() >= weekAgo) row.thisWeek++;
    if (c.at.getTime() >= monthAgo) row.thisMonth++;
    const ts = datetime(c.at);
    if (!row.lastClaimAt || ts > row.lastClaimAt) row.lastClaimAt = ts;
  }
  return Object.values(rows).map(r => ({
    ...r,
    name: (SITES[r.id] && SITES[r.id].name) || DISCOVERY_DISPLAY_NAMES[r.id] || r.id,
  }));
}

// Pretty names for the discovery-only storefronts that appear in the
// per-service table when a user manually-claims via the Discoveries tab.
// Kept here rather than src/sites.js because these aren't full sites — no
// login flow, no claim script — just buckets for stats attribution.
const DISCOVERY_DISPLAY_NAMES = {
  'indiegala': 'IndieGala (manual)',
  'itch-io':   'itch.io (manual)',
  'stove':     'STOVE (manual)',
  'mobile':    'Mobile (manual)',
  'console':   'Console (manual)',
  'vr':        'VR (manual)',
  'other':     'Other (manual)',
};

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
      serviceName: (SITES[c.service] && SITES[c.service].name) || DISCOVERY_DISPLAY_NAMES[c.service] || c.service,
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
    serviceName: (SITES[c.service] && SITES[c.service].name) || DISCOVERY_DISPLAY_NAMES[c.service] || c.service,
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
  .headless-banner { background: #2a2418; border: 1px solid #e8a857; color: #e8a857; padding: 10px 14px; border-radius: 6px; margin: 6px 0; display: flex; align-items: center; gap: 12px; }
  .headless-banner .hb-icon { font-size: 18px; flex-shrink: 0; }
  .headless-banner .hb-text { flex: 1; font-weight: 500; line-height: 1.35; }
  /* Diagnostics / error-report banner — surfaces an undecided crash
     with three actions (Share, Don't Share, Never Share). Visually
     distinct from the captcha-banner (red, urgent) and headless-banner
     (amber, persistent). Diagnostics is informational — slate-blue. */
  .diag-banner { background: #3a2a14; border: 1px solid #a07840; color: #f0d4a0; padding: 10px 14px; border-radius: 6px; margin: 6px 0; display: flex; align-items: center; gap: 12px; }
  .diag-banner .db-icon { font-size: 18px; flex-shrink: 0; opacity: 0.95; }
  .diag-banner .db-text { flex: 1; font-size: 13px; line-height: 1.4; }
  .diag-banner .db-text b { color: #ffe0b0; }
  .diag-banner .db-text small { color: #d4b878; font-size: 11px; display: block; margin-top: 2px; font-family: 'Menlo', 'Consolas', monospace; }
  .diag-banner .db-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .diag-banner button { padding: 5px 11px; font-size: 11px; font-weight: 600; border-radius: 4px; cursor: pointer; border: 1px solid; white-space: nowrap; font-family: inherit; }
  .diag-banner button.db-share   { background: #1f3d2f; color: #6fd49a; border-color: #2c5a45; }
  .diag-banner button.db-share:hover   { background: #2c5a45; color: #aeefcd; }
  .diag-banner button.db-skip    { background: #1c2c4a; color: #a0b4d4; border-color: #2c4068; }
  .diag-banner button.db-skip:hover    { background: #2c4068; color: #e0e0e0; }
  .diag-banner button.db-never   { background: #2a2540; color: #b3a0e0; border-color: #463a6a; }
  .diag-banner button.db-never:hover   { background: #463a6a; color: #d8c5ff; }
  body[data-tab="diagnostics"] .tab-panel[data-panel="diagnostics"] { display: block; overflow-y: auto; padding: 24px 32px; }
  .diag-head { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; flex-wrap: wrap; }
  .diag-head h3 { font-size: 18px; color: #e0e0e0; }
  .diag-head .diag-sub { font-size: 12px; color: #a0b4d4; max-width: 720px; line-height: 1.5; }
  .diag-status { padding: 4px 12px; border-radius: 12px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
  .diag-status.on  { background: #1f3d2f; color: #6fd49a; border: 1px solid #2c5a45; }
  .diag-status.off { background: #3a2540; color: #d8a0e0; border: 1px solid #5a3a6a; }
  .diag-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
  .diag-table th { text-align: left; padding: 8px 10px; background: #1a2540; color: #a0b4d4; font-weight: 600; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; border-bottom: 1px solid #2c4068; }
  .diag-table td { padding: 10px; border-bottom: 1px solid #1c2c4a; vertical-align: top; color: #c8d4eb; }
  .diag-table tr:hover td { background: #161f33; }
  .diag-table .col-script { font-family: 'Menlo', 'Consolas', monospace; font-size: 12px; color: #a0d4eb; white-space: nowrap; }
  .diag-table .col-class  { font-family: 'Menlo', 'Consolas', monospace; font-size: 12px; color: #eba0a0; white-space: nowrap; }
  .diag-table .col-msg    { font-family: 'Menlo', 'Consolas', monospace; font-size: 12px; max-width: 480px; word-break: break-word; }
  .diag-table .col-count  { text-align: center; color: #ddd; }
  .diag-table .col-when   { font-size: 11px; color: #8aa0c2; white-space: nowrap; }
  .diag-table .col-dec    { font-size: 11px; font-weight: 600; }
  .diag-table .col-dec.shared    { color: #6fd49a; }
  .diag-table .col-dec.dismissed { color: #a0b4d4; }
  .diag-table .col-dec.pending   { color: #ffb84d; }
  .diag-table .col-dec.resolved  { color: #79c4ff; }
  .diag-table .col-actions button.dt-resolve { background: #1c3a4a; color: #79c4ff; border-color: #2c5a6e; }
  .diag-table .col-actions { white-space: nowrap; }
  .diag-table .col-actions button { padding: 4px 8px; font-size: 11px; margin-right: 4px; border-radius: 3px; cursor: pointer; border: 1px solid; font-family: inherit; }
  .diag-table .col-actions button.dt-share  { background: #1f3d2f; color: #6fd49a; border-color: #2c5a45; }
  .diag-table .col-actions button.dt-skip   { background: #1c2c4a; color: #a0b4d4; border-color: #2c4068; }
  .diag-table .col-actions button.dt-del    { background: #3a1c1c; color: #eba0a0; border-color: #5a2c2c; }
  .diag-empty { padding: 32px; text-align: center; color: #8aa0c2; font-size: 13px; border: 1px dashed #2c4068; border-radius: 6px; margin-top: 16px; }
  .diag-stack { white-space: pre-wrap; font-family: 'Menlo', 'Consolas', monospace; font-size: 11px; color: #8aa0c2; background: #0e1626; padding: 8px 10px; border-radius: 4px; margin-top: 6px; max-height: 200px; overflow-y: auto; display: none; }
  .diag-stack.shown { display: block; }
  .diag-table .toggle-stack { background: none; border: none; color: #6fa0d4; cursor: pointer; font-size: 11px; padding: 0; margin-top: 4px; text-decoration: underline; }
  .diag-toolbar { margin-top: 12px; display: flex; gap: 8px; }
  .diag-toolbar button { padding: 6px 14px; font-size: 12px; border-radius: 4px; cursor: pointer; border: 1px solid; font-family: inherit; }
  .diag-toolbar button.dt-toggle.on  { background: #1f3d2f; color: #6fd49a; border-color: #2c5a45; }
  .diag-toolbar button.dt-toggle.off { background: #3a2540; color: #d8a0e0; border-color: #5a3a6a; }
  .diag-toolbar button.dt-clear { background: #3a1c1c; color: #eba0a0; border-color: #5a2c2c; }
  .headless-banner .hb-text small { display: block; font-weight: 400; opacity: 0.85; margin-top: 2px; }
  .header-top { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .header h1 { font-size: 18px; color: #e94560; white-space: nowrap; }
  .header-actions { display: flex; gap: 8px; margin-left: auto; flex-wrap: wrap; justify-content: flex-end; align-items: center; }
  /* Update-available pill (issue #39). Subtle teal chip in the header
     actions area when a newer release is published; clicking opens the
     GitHub release notes. Manual pull still required — we don't auto-
     update. Disabled entirely when UPDATE_CHECK=0 env is set. */
  .update-pill { background: #1f3d2f; color: #6fd49a; border: 1px solid #2c5a45; border-radius: 12px; padding: 4px 12px; font-size: 11px; font-weight: 600; text-decoration: none; white-space: nowrap; cursor: pointer; letter-spacing: 0.02em; }
  .update-pill:hover { background: #2c5a45; color: #aeefcd; border-color: #4ecca3; }

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
  body[data-tab="discoveries"] .tab-panel[data-panel="discoveries"] { display: block; overflow-y: auto; padding: 24px 32px; }
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
  /* Grid layout (2026-05-15 Settings UX overhaul, feedback item #1). Each
     setting row becomes a three-column grid: fixed-width label · stretch
     control · auto-width trailing tail (revert button). The label column
     is 220px so labels of varying length all start at the same x-offset
     across every Settings sub-page — the eye no longer has to re-anchor
     when switching from Scheduler to Notifications to Advanced. The
     trailing column hosts the Revert button so it stays glued to the
     right edge of the row regardless of control width. Help popover
     spans all three columns (grid-column: 1 / -1, defined earlier). */
  .setting { display: grid; grid-template-columns: 220px 1fr auto; column-gap: 18px; row-gap: 6px; align-items: center; padding: 10px 0; }
  .setting > .setting-label { min-width: 0; }
  .setting > .setting-input { min-width: 0; }
  /* Below 640px: labels wrap onto their own row, controls follow on a
     second row. Boolean variant keeps its checkbox-left inline layout. */
  @media (max-width: 640px) {
    .setting:not(.setting-bool) { grid-template-columns: 1fr; row-gap: 4px; }
    .setting:not(.setting-bool) > .setting-label { white-space: normal; }
  }
  /* Grouped fields: small-caps subheader. Bumped from 10px / 0.08em
     letter-spacing to 12px / 0.12em with a stronger divider rule
     (feedback item #3) so section boundaries stand out from the
     field labels they group. */
  .setting-group { margin-bottom: 28px; }
  .setting-group:last-child { margin-bottom: 0; }
  .setting-group-head { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: #8aa0c2; margin: 0 0 14px; padding-bottom: 10px; border-bottom: 1px solid #2a3a5a; }
  .setting-group .setting { padding: 8px 0; }
  /* Legend at the top of each Settings page explaining the green dot +
     Revert pattern (feedback item #8 — the dot wasn't discoverable). */
  .settings-pane-legend { font-size: 11px; color: #8aa0c2; margin: 0 0 18px; padding: 8px 10px; background: #0d1830; border: 1px solid #1c2c4a; border-radius: 4px; line-height: 1.5; }
  .settings-pane-legend .setting-dot { vertical-align: middle; }
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

  /* Sensitive-field masking (feedback item #10). Apprise URLs embed
     bearer tokens (pover://USER_KEY@APP_KEY, ntfy://...auth/, etc.).
     Plain-text rendering in the Settings panel leaks them on every
     screen-share or screenshot. Masked-by-default with a Reveal toggle
     matches the Environment tab's pattern. -webkit-text-security covers
     multiline textareas (Chromium/Safari/Edge); type="password" works
     for single-line text inputs. */
  .setting-input.sensitive input[type="text"][data-sensitive-state="hidden"],
  .setting-input.sensitive textarea[data-sensitive-state="hidden"] {
    -webkit-text-security: disc;
    text-security: disc;
    font-family: 'Menlo', 'Consolas', monospace;
  }
  .setting-reveal { background: transparent; border: 1px solid #233454; border-radius: 4px; padding: 5px 10px; color: #8aa0c2; cursor: pointer; font-size: 11px; white-space: nowrap; margin-left: 4px; }
  .setting-reveal:hover { background: #1a2a48; color: #e0e0e0; border-color: #2a3a5a; }

  /* Cross-tab dirty count (feedback item #11) — badge on each sidebar
     rail-btn shows how many fields are dirty inside that section, so a
     user navigating across sections can see at a glance which other
     tabs have pending changes. Visible regardless of which tab is
     currently active. */
  .settings-rail .rail-btn { position: relative; }
  .rail-dirty-badge { display: inline-block; min-width: 18px; padding: 1px 6px; margin-left: 8px; background: #f0c040; color: #1c2c4a; border-radius: 9px; font-size: 10px; font-weight: 700; line-height: 1.4; text-align: center; }

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

  /* Discoveries tab v2 — sub-tabs by storefront, global filters,
     per-row user actions. */
  .disc-filters { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 12px; background: #0d1830; border: 1px solid #1c2c4a; border-radius: 6px; margin-bottom: 12px; position: sticky; top: 0; z-index: 5; }
  .disc-search { flex: 1; min-width: 180px; max-width: 300px; padding: 6px 10px; background: #122142; color: #eaf1ff; border: 1px solid #2c4068; border-radius: 4px; font-size: 13px; }
  .disc-search:focus { outline: none; border-color: #4a6fa0; }
  .disc-filter-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #a0b4d4; cursor: pointer; }
  .disc-filter-label select { background: #122142; color: #eaf1ff; border: 1px solid #2c4068; border-radius: 4px; padding: 4px 6px; font-size: 12px; cursor: pointer; }
  .disc-filter-label input[type="checkbox"] { cursor: pointer; }
  .disc-filter-spacer { flex: 1; }
  .disc-filter-hint { color: #6a83a8; font-size: 11px; }
  .disc-subtabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 14px; border-bottom: 1px solid #1c2c4a; padding-bottom: 8px; }
  .disc-subtab { padding: 6px 12px; background: #0d1830; color: #a0b4d4; border: 1px solid #1c2c4a; border-radius: 4px 4px 0 0; cursor: pointer; font-size: 12px; font-weight: 500; transition: background 0.1s; }
  .disc-subtab:hover { background: #122142; color: #eaf1ff; }
  .disc-subtab.active { background: #1c2c4a; color: #eaf1ff; border-color: #4a6fa0; }
  .disc-subtab-count { color: #6a83a8; font-weight: 400; margin-left: 4px; }
  .disc-subtab.active .disc-subtab-count { color: #a0b4d4; }
  .disc-tab-empty { padding: 32px 16px; text-align: center; color: #6a83a8; font-size: 13px; }
  .disc-tab-empty-icon { font-size: 32px; display: block; margin-bottom: 8px; opacity: 0.5; }
  /* Per-row action buttons (Ignore, Mark, Undo). */
  .disc-actions { display: flex; gap: 4px; align-items: center; }
  .disc-action-btn { background: #122142; color: #a0b4d4; border: 1px solid #2c4068; border-radius: 4px; cursor: pointer; padding: 4px 8px; font-size: 13px; line-height: 1; transition: background 0.1s, color 0.1s; }
  .disc-action-btn:hover { background: #2c4068; color: #eaf1ff; }
  .disc-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .disc-action-btn.danger:hover { background: #3d1f24; color: #ff9a8c; border-color: #6b3338; }
  .disc-action-btn.ok:hover { background: #1f3d2f; color: #6fd49a; border-color: #2c5a45; }
  /* Items the user has marked appear dimmed when shown (i.e. when the
     "Hide ignored" or "Hide claimed" toggle is off). Makes the user-
     marked state obvious without being shouty. */
  .disc-item.user-marked { opacity: 0.55; }
  .disc-item.user-marked:hover { opacity: 0.85; }

  /* Discoveries tab — aggregator listings with coverage badges. */
  .disc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
  .disc-head h3 { margin: 0; }
  .disc-sub { color: #8aa0c2; font-size: 13px; margin-top: 4px; max-width: 720px; line-height: 1.5; }
  .disc-meta { color: #8aa0c2; font-size: 12px; margin-bottom: 18px; display: flex; align-items: center; gap: 12px; }
  .disc-section { margin-top: 20px; background: #0d1830; border-radius: 6px; padding: 14px 16px; border: 1px solid #1c2c4a; }
  .disc-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .disc-section-title { font-size: 14px; font-weight: 600; color: #eaf1ff; }
  .disc-section-count { font-size: 12px; color: #8aa0c2; }
  .disc-section-sub { font-size: 12px; color: #8aa0c2; margin-top: 2px; }
  .disc-error { background: #3b1f24; border: 1px solid #6b3338; color: #ffb4b4; padding: 8px 12px; border-radius: 4px; font-size: 12px; margin-top: 8px; }
  .disc-empty { color: #8aa0c2; font-size: 13px; font-style: italic; padding: 8px 0; }
  .disc-list { display: flex; flex-direction: column; gap: 6px; }
  .disc-item { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; padding: 8px 10px; background: #122142; border-radius: 4px; border: 1px solid #1c2c4a; }
  .disc-item a { color: #7ac1ff; text-decoration: none; font-weight: 500; }
  .disc-item a:hover { text-decoration: underline; }
  .disc-item-meta { color: #8aa0c2; font-size: 11px; }
  /* min-width + text-align:center: badge widths are uniform regardless
     of label length, so the title column starts at the same x-offset
     on every row. Longest label is CLAIMED (7 chars); 68px covers it
     with breathing room. */
  .disc-badge { font-size: 10px; padding: 3px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; white-space: nowrap; min-width: 68px; text-align: center; box-sizing: border-box; }
  .disc-badge.auto    { background: #1f3d2f; color: #6fd49a; border: 1px solid #2c5a45; }
  .disc-badge.claimed { background: #14283c; color: #7ac1ff; border: 1px solid #2c4068; }
  .disc-badge.notify  { background: #3d2f1f; color: #f0c060; border: 1px solid #5a4a2c; }
  .disc-badge.skip    { background: #3d1f24; color: #ff9a8c; border: 1px solid #6b3338; }
  .disc-badge.manual  { background: #2a2540; color: #b3a0e0; border: 1px solid #463a6a; }
  .disc-badge.ignored { background: #232838; color: #7a8aa0; border: 1px solid #3a4860; }
  .disc-item-meta-bad { color: #ff9a8c; font-weight: 600; }
  .disc-tag { font-size: 10px; padding: 3px 6px; border-radius: 3px; background: #1c2c4a; color: #a0b4d4; font-family: 'SF Mono', Menlo, monospace; }
  .disc-coverage-label { font-size: 11px; color: #8aa0c2; font-style: italic; }
  .disc-refresh-btn { padding: 6px 14px; background: #1c2c4a; color: #eaf1ff; border: 1px solid #2c4068; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .disc-refresh-btn:hover { background: #2c4068; }
  .disc-refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Project links footer — sits below the main area, always visible.
     Compact so it doesn't compete with tab content for vertical space.
     Discussions is where new aggregator suggestions go (per user ask). */
  .project-links { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 16px; font-size: 11px; color: #6a83a8; background: #08111f; border-top: 1px solid #1c2c4a; }
  .project-links a { color: #7ac1ff; text-decoration: none; }
  .project-links a:hover { text-decoration: underline; }
  .project-links-sep { color: #2c4068; }

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
  .stats-activity .act .title a:visited,
  .stats-activity .act .title a:active { color: inherit; text-decoration: none; }
  .stats-activity .act .title a:hover { color: #4ecca3; text-decoration: underline; }
  .stats-activity .act .title.no-link { color: #a0b4d4; font-style: italic; }
  .stats-activity .act .title.no-link::after { content: ' · no link'; color: #5e7193; font-size: 11px; font-style: normal; }
  .stats-empty { color: #8aa0c2; font-style: italic; padding: 20px; text-align: center; background: #16233c; border-radius: 6px; }

  .sched-row { display: flex; gap: 24px; margin-bottom: 22px; align-items: baseline; }
  .sched-label { font-size: 11px; color: #8aa0c2; text-transform: uppercase; letter-spacing: 0.06em; min-width: 110px; flex-shrink: 0; padding-top: 4px; }
  .sched-value { font-size: 15px; color: #e0e0e0; line-height: 1.5; }
  .sched-value.big { font-size: 26px; font-weight: 600; color: #fff; display: block; margin-bottom: 2px; }
  .sched-value.muted { color: #8aa0c2; font-style: italic; }
  .sched-count { font-size: 13px; color: #4ecca3; }
  .sched-tz { font-size: 13px; margin-left: 6px; }
  .sched-note { margin-top: 28px; padding-top: 16px; border-top: 1px solid #233454; color: #8aa0c2; font-size: 13px; line-height: 1.6; }
  .sched-services { list-style: none; margin: 0; padding: 0; font-size: 13px; color: #c8d0dc; line-height: 1.75; }
  .sched-services li { position: relative; padding-left: 16px; }
  .sched-services li::before { content: '•'; position: absolute; left: 0; color: #4ecca3; font-weight: 700; }
  .sched-services b { color: #ffffff; font-weight: 600; }
  .sched-services .muted { color: #8aa0c2; font-weight: 400; font-size: 12px; }

  .logs-header { padding: 10px 20px; border-bottom: 1px solid #0f3460; font-size: 13px; color: #8aa0c2; flex-shrink: 0; display: flex; align-items: center; gap: 12px; }
  .logs-header .logs-count { margin-left: auto; font-size: 12px; }
  /* Custom run-history dropdown — replaces native <select> because Firefox/Safari
     don't reliably honor white-space: nowrap on native <option> elements, so
     long entries wrap inside the popup. Custom popup lets us pin to nowrap. */
  .rhp { position: relative; }
  .rhp-trigger { background: #1a1a2e; color: #c0c8d8; border: 1px solid #1a2a48; border-radius: 4px; padding: 4px 28px 4px 10px; font-size: 12px; cursor: pointer; min-width: 260px; max-width: 480px; text-align: left; position: relative; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: inherit; }
  .rhp-trigger:hover { border-color: #2a3a58; }
  .rhp-trigger::after { content: '▾'; position: absolute; right: 10px; top: 50%; transform: translateY(-50%); color: #8aa0c2; pointer-events: none; }
  .rhp-popup { position: absolute; top: calc(100% + 4px); left: 0; background: #1a1a2e; border: 1px solid #1a2a48; border-radius: 4px; max-height: 360px; overflow-y: auto; z-index: 1000; min-width: 100%; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
  .rhp-option { padding: 6px 10px; font-size: 12px; color: #c0c8d8; cursor: pointer; white-space: nowrap; border-bottom: 1px solid #0f1a30; }
  .rhp-option:last-child { border-bottom: none; }
  .rhp-option:hover, .rhp-option.active { background: #243355; color: #fff; }
  .rhp-option.live { font-weight: 600; }
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
  /* Lenovo Gaming watcher card surfaces tracked drops inline. Compact rows
     with status pill, title, countdown, "Got it" + open-link buttons. */
  .lenovo-drops { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .lenovo-drop { display: flex; align-items: center; gap: 6px; padding: 4px 6px; background: #12213e; border-radius: 4px; font-size: 11px; }
  .lenovo-drop .lenovo-pill { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 999px; white-space: nowrap; }
  .lenovo-drop .lenovo-pill.live  { background: #1e7a4d; color: #b8f0d4; }
  .lenovo-drop .lenovo-pill.soon  { background: #2a3a6a; color: #a8c0e8; }
  .lenovo-drop .lenovo-pill.restock { background: #6a3a1e; color: #f0c890; }
  .lenovo-drop .lenovo-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d0d8e0; text-decoration: none; cursor: pointer; }
  .lenovo-drop .lenovo-title:hover { color: #4ecca3; }
  .lenovo-drop .lenovo-time { color: #8aa0c2; font-size: 10px; white-space: nowrap; }
  .lenovo-drop .lenovo-collected { font-size: 10px; padding: 2px 8px; background: transparent; border: 1px solid #2a3a5a; color: #a0b4d4; border-radius: 4px; cursor: pointer; }
  .lenovo-drop .lenovo-collected:hover:not(:disabled) { border-color: #4ecca3; color: #4ecca3; }
  .lenovo-drop .lenovo-collected:disabled { opacity: 0.4; cursor: not-allowed; }
  .lenovo-drop .lenovo-go { color: #6a7e9e; text-decoration: none; padding: 0 4px; font-size: 12px; }
  .lenovo-drop .lenovo-go:hover { color: #4ecca3; }
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
  /* Run-Now picker — appears when user clicks Run Now. Lists all active
     services grouped by category with checkbox per service. Defaults
     match CLAIM_CMD_MANUAL (everything checked except microsoft +
     microsoft-mobile, which add ~30-45 min to a run). */
  .run-picker-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 200; display: flex; align-items: center; justify-content: center; }
  .run-picker-card { background: #16213e; border: 1px solid #2a3a5a; border-radius: 8px; padding: 22px 24px; max-width: 520px; width: 92%; max-height: 80vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.5); display: flex; flex-direction: column; }
  .run-picker-title { font-size: 16px; font-weight: 600; color: #ffffff; margin-bottom: 8px; }
  .run-picker-sub { font-size: 12.5px; color: #8aa0c2; margin-bottom: 14px; line-height: 1.5; }
  .run-picker-body { flex: 1; min-height: 0; overflow-y: auto; margin-bottom: 14px; }
  .rp-group { margin-bottom: 12px; }
  .rp-group-title { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: #8aa0c2; font-weight: 600; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid #1f3050; }
  .rp-row { display: flex; align-items: center; gap: 8px; padding: 6px 4px; font-size: 13px; color: #e0e6f0; cursor: pointer; border-radius: 4px; }
  .rp-row:hover { background: #1f2c4a; }
  .rp-row input[type="checkbox"] { margin: 0; }
  .rp-row .rp-hint { font-size: 11.5px; color: #8aa0c2; margin-left: auto; }
  .rp-shortcuts { display: flex; gap: 6px; padding-top: 4px; border-top: 1px solid #1f3050; padding-top: 10px; }
  .rp-shortcuts button { background: #1a2840; color: #c0c8d8; border: 1px solid #2a3a58; border-radius: 4px; padding: 4px 10px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .rp-shortcuts button:hover { background: #243355; }
  .run-picker-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
  .run-picker-actions .btn { font-size: 13px; padding: 8px 14px; }
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
  .site-card-extlink { color: #6a7e9e; font-size: 14px; padding: 0 2px; line-height: 1; margin-left: 4px; text-decoration: none; cursor: pointer; }
  .site-card-extlink:hover { color: #4ecca3; }
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
      <button class="tab" data-tab="discoveries" onclick="switchTab('discoveries')" title="Free-game listings from gamerpower.com and r/FreeGameFindings — click any link to claim manually">Discoveries</button>
      <button class="tab" data-tab="logs" onclick="switchTab('logs')">Logs</button>
      <button class="tab" data-tab="diagnostics" onclick="switchTab('diagnostics')" title="Errors detected during runs. Decide per-error whether to share with the project.">Diagnostics</button>
      <button class="tab" data-tab="settings" onclick="switchTab('settings')">Settings</button>
      <button class="tab" data-tab="environment" onclick="switchTab('environment')">Environment</button>
    </nav>
    <div class="header-actions">
      <a class="update-pill" id="updatePill" style="display:none" target="_blank" rel="noopener" onclick="return openSiteUrl(this)" title="Click to see the release notes">Update available</a>
      <button class="btn btn-check-all sessions-only" onclick="checkAll()" id="btnCheckAll">Check All Sessions</button>
      <button class="btn btn-show-browser sessions-only" onclick="toggleBrowserView()" id="btnShowBrowser" title="Open the live browser view via noVNC — useful for diagnosing card-click failures or peeking at what a script is doing.">Show browser</button>
      <button class="btn btn-popout-browser sessions-only" onclick="popoutBrowser()" id="btnPopoutBrowser" title="Open the noVNC view in a new tab for full-screen viewing.">Pop out ↗</button>
      <button class="btn btn-run" onclick="runAll()" id="btnRunAll">Run Now</button>
    </div>
  </div>
  <div class="captcha-banner" id="captchaBanner" style="display:none" onclick="focusCaptcha()" title="Open the browser to solve the pending captcha"></div>
  <div class="headless-banner" id="headlessBanner" style="display:none"></div>
  <div class="diag-banner" id="diagBanner" style="display:none"></div>
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
      <div class="rhp" id="runHistoryPicker">
        <button class="rhp-trigger" id="rhpTrigger" type="button" onclick="toggleRunHistoryPicker(event)" title="Switch between live output and past runs">Live (current run)</button>
        <div class="rhp-popup" id="rhpPopup" style="display:none"></div>
      </div>
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
  <div class="tab-panel" data-panel="discoveries">
    <div class="disc-head">
      <div>
        <h3>Discoveries</h3>
        <div class="disc-sub">Free-game listings from <a href="https://www.gamerpower.com/" onclick="return openSiteUrl(this)" target="_blank" rel="noopener">gamerpower.com</a> and <a href="https://www.reddit.com/r/FreeGameFindings/" onclick="return openSiteUrl(this)" target="_blank" rel="noopener">r/FreeGameFindings</a>, grouped by storefront. <b>AUTO</b>/<b>SKIP</b>/<b>NOTIFY</b>/<b>MANUAL</b>/<b>CLAIMED</b> badges tell you what the next run will do. Hover a row's 🚫 or ✓ to dismiss or mark as manually-claimed; ↺ undoes.</div>
      </div>
      <button class="disc-refresh-btn" id="btnDiscRefresh" onclick="renderDiscoveriesTab(true)">Refresh</button>
    </div>
    <div class="disc-meta" id="discMeta"></div>
    <div class="disc-filters">
      <input type="text" class="disc-search" id="discSearch" placeholder="Search title..." oninput="onDiscFilterChange()">
      <label class="disc-filter-label">Min price
        <select id="discMinPrice" onchange="onDiscFilterChange()">
          <option value="0">$0 (show all)</option>
          <option value="5">$5</option>
          <option value="10">$10</option>
          <option value="15">$15</option>
          <option value="20">$20</option>
          <option value="25">$25</option>
        </select>
      </label>
      <label class="disc-filter-label"><input type="checkbox" id="discHideClaimed" checked onchange="onDiscFilterChange()"> Hide claimed</label>
      <label class="disc-filter-label" title="Hides both items you dismissed (🚫) and items the SKIP forecast says your settings will filter at run time."><input type="checkbox" id="discHideIgnored" checked onchange="onDiscFilterChange()"> Hide ignored / skipped</label>
      <label class="disc-filter-label" title="Hides in-game cosmetics and DLC (outfits, skins, packs, currency, GPU/points rewards) — these aren't standalone free games. Matches the title against a keyword list."><input type="checkbox" id="discHideRewards" checked onchange="onDiscFilterChange()"> Hide rewards / DLC</label>
      <span class="disc-filter-spacer"></span>
      <span class="disc-filter-hint" id="discHiddenHint"></span>
    </div>
    <div class="disc-subtabs" id="discSubtabs"></div>
    <div id="discBody">Loading…</div>
  </div>
  <div class="tab-panel" data-panel="environment">
    <div class="env-view-head">
      <div>
        <h3 class="env-view-title">Environment</h3>
        <div class="env-view-sub">Read-only view of env-only variables (panel infrastructure, credentials, debug flags) the app reads. Variables that are also editable at runtime — <code>LOOP</code>, <code>START_TIME</code>, <code>NOTIFY</code>, <code>RUN_ON_STARTUP</code>, the per-service flags, etc. — live on the <b>Settings</b> tab with their env-var name shown beside the field. <b>Reveal credentials</b> shows each secret as <code>••••••XXXX</code> — last 4 chars only — so don't tap it on a shared screen.</div>
      </div>
      <button class="btn btn-check-all" id="btnRevealCreds" onclick="toggleRevealEnv()">Reveal credentials</button>
    </div>
    <div class="env-view-body" id="envView">Loading…</div>
  </div>
  <div class="tab-panel" data-panel="diagnostics">
    <div class="diag-head">
      <div>
        <h3>Diagnostics</h3>
        <div class="diag-sub">Errors detected during runs (ReferenceError, TypeError, apprise/Playwright failures, …). Each error is fingerprinted so duplicates are counted, not re-stored. Nothing leaves your host without an explicit <b>Share</b> click — Share opens a pre-filled GitHub issue you can review and edit before submitting.</div>
      </div>
      <span class="diag-status" id="diagStatus">…</span>
    </div>
    <div class="diag-toolbar">
      <button id="btnDiagToggle" class="dt-toggle" onclick="toggleDiagnosticsEnabled()">…</button>
      <button class="dt-clear" onclick="clearDiagnosticsHistory()" title="Permanently remove all logged errors. Useful after a release that fixed known issues.">Clear history</button>
    </div>
    <div id="diagBody">Loading…</div>
  </div>
</div>
<div class="project-links">
  <a href="https://github.com/feldorn/free-games-claimer" onclick="return openSiteUrl(this)" target="_blank" rel="noopener" title="Browse the source on GitHub">Repo</a>
  <span class="project-links-sep">·</span>
  <a href="https://github.com/feldorn/free-games-claimer/blob/main/CHANGELOG.md" onclick="return openSiteUrl(this)" target="_blank" rel="noopener" title="Release notes — see what shipped in each version">What's new</a>
  <span class="project-links-sep">·</span>
  <a href="https://github.com/feldorn/free-games-claimer/issues" onclick="return openSiteUrl(this)" target="_blank" rel="noopener" title="Report a bug or request a feature">Issues</a>
  <span class="project-links-sep">·</span>
  <a href="https://github.com/feldorn/free-games-claimer/discussions" onclick="return openSiteUrl(this)" target="_blank" rel="noopener" title="Ask a question or share an idea on Discussions — including new aggregator sources to add">Discussions</a>
</div>
<div class="run-picker-modal" id="runPickerModal" role="dialog" aria-modal="true" aria-labelledby="runPickerTitle" style="display:none" onclick="rpBackdropClick(event)">
  <div class="run-picker-card" onclick="event.stopPropagation()">
    <div class="run-picker-title" id="runPickerTitle">Run Now — pick services</div>
    <div class="run-picker-sub">Defaults match the current Run-Now behavior (everything except Microsoft Rewards, which adds ~30-45 min). Check anything you want included in this run, uncheck anything to skip.</div>
    <div class="run-picker-body" id="runPickerBody"></div>
    <div class="run-picker-actions">
      <button class="btn btn-cancel" onclick="cancelRunPicker()">Cancel</button>
      <button class="btn btn-run" id="btnRunPickerConfirm" onclick="confirmRunPicker()">Run selected</button>
    </div>
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
const NOVNC_URL = '${NOVNC_URL}';
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
  // Persist active tab so it survives the iframe-bust → external page
  // → browser back cycle. Originally tried URL hash, but when the panel
  // runs inside an iframe (dashboard like Homepage / Organizr), the
  // hash sits on the *iframe's* URL and the iframe-bust navigates the
  // *top* window — browser back returns to the dashboard URL with no
  // hash to read. localStorage is per-origin and survives the
  // navigation cycle in both iframed and top-level setups. The panel's
  // own origin always sees its own localStorage on next load.
  try { localStorage.setItem('fgc:lastTab', tab); } catch {}
  if (tab === 'logs') startLogsTabPoll();
  else stopLogsTabPoll();
  if (tab === 'schedule') renderScheduleTab();
  if (tab === 'stats') renderStatsTab();
  if (tab === 'settings') renderSettingsTab();
  if (tab === 'environment') renderEnvironmentTab();
  if (tab === 'discoveries') renderDiscoveriesTab();
  if (tab === 'diagnostics') renderDiagnosticsTab();
}

// Restore the active tab from localStorage on initial load. Valid-tab
// whitelist guards against stale or junk values written by an older
// build. Falls through to body's default data-tab="sessions" when no
// stored value or unrecognized.
const VALID_TABS = ['sessions', 'stats', 'schedule', 'discoveries', 'logs', 'diagnostics', 'settings', 'environment'];
function _initTabFromStorage() {
  let tab;
  try { tab = localStorage.getItem('fgc:lastTab'); } catch { return; }
  if (!tab || !VALID_TABS.includes(tab)) return;
  if (document.body.dataset.tab === tab) return; // already on it
  switchTab(tab);
}

// Native browser dialog for tab close / reload while drafts exist.
// Browser shows a generic localized message; can't customise the text.
window.addEventListener('beforeunload', e => {
  if (Object.keys(settingsDirty).length > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// --- Discoveries tab ---
// Live fetch of FGF + GamerPower listings via the panel's /api/discoveries
// endpoint. Items are grouped by storefront into sub-tabs (Epic / Steam /
// GOG / Itch.io / IndieGala / STOVE / Mobile / etc.); the source
// (GamerPower vs FGF) is a small pill on each row. Refresh button does a
// force-refetch; otherwise the tab caches the last response in JS
// memory so re-entering the tab is instant.
//
// Filter state (search / min-price / hide-claimed / hide-ignored) persists
// in localStorage so it survives panel reloads. Per-row actions
// (🚫 Ignore / ✓ Mark claimed / ↺ Undo) POST to /api/discoveries/mark
// and /unmark, then re-render with the cached data + the optimistic
// state update.
let discCache = null;
let discFetching = false;
let discActiveTab = 'all';
const DISC_TAB_ORDER = [
  'epic-games', 'epic-games-mobile', 'steam', 'gog',
  'itch-io', 'indiegala', 'stove', 'mobile', 'console', 'vr',
  'prime-gaming', 'ubisoft', 'other',
];
const DISC_TAB_LABELS = {
  'epic-games': 'Epic',
  'epic-games-mobile': 'Epic Mobile',
  'steam': 'Steam',
  'gog': 'GOG',
  'itch-io': 'Itch.io',
  'indiegala': 'IndieGala',
  'stove': 'STOVE',
  'mobile': 'Mobile',
  'console': 'Console',
  'vr': 'VR',
  'prime-gaming': 'Prime',
  'ubisoft': 'Ubisoft',
  'other': 'Other',
};

function discLoadFilters() {
  try {
    const s = JSON.parse(localStorage.getItem('discFilters') || '{}');
    const search = document.getElementById('discSearch');
    const minPrice = document.getElementById('discMinPrice');
    const hideClaimed = document.getElementById('discHideClaimed');
    const hideIgnored = document.getElementById('discHideIgnored');
    const hideRewards = document.getElementById('discHideRewards');
    if (search && typeof s.search === 'string') search.value = s.search;
    if (minPrice && typeof s.minPrice === 'number') minPrice.value = String(s.minPrice);
    if (hideClaimed && typeof s.hideClaimed === 'boolean') hideClaimed.checked = s.hideClaimed;
    if (hideIgnored && typeof s.hideIgnored === 'boolean') hideIgnored.checked = s.hideIgnored;
    if (hideRewards && typeof s.hideRewards === 'boolean') hideRewards.checked = s.hideRewards;
    if (typeof s.activeTab === 'string') discActiveTab = s.activeTab;
  } catch {}
}
function discSaveFilters() {
  try {
    const s = {
      search: document.getElementById('discSearch')?.value || '',
      minPrice: Number(document.getElementById('discMinPrice')?.value || 0),
      hideClaimed: !!document.getElementById('discHideClaimed')?.checked,
      hideIgnored: !!document.getElementById('discHideIgnored')?.checked,
      hideRewards: !!document.getElementById('discHideRewards')?.checked,
      activeTab: discActiveTab,
    };
    localStorage.setItem('discFilters', JSON.stringify(s));
  } catch {}
}
function onDiscFilterChange() {
  discSaveFilters();
  if (discCache) discApplyAndRender();
}
function discSwitchSubtab(tab) {
  discActiveTab = tab;
  discSaveFilters();
  discApplyAndRender();
}
async function renderDiscoveriesTab(forceRefresh) {
  const body = document.getElementById('discBody');
  const meta = document.getElementById('discMeta');
  const btn = document.getElementById('btnDiscRefresh');
  if (!body) return;
  // Restore filter state before first render so the toggles reflect the
  // user's saved prefs immediately rather than flipping after data arrives.
  discLoadFilters();
  if (discCache && !forceRefresh) {
    discApplyAndRender();
    return;
  }
  if (discFetching) return;
  discFetching = true;
  if (btn) btn.disabled = true;
  body.innerHTML = '<div class="disc-empty">Loading aggregator data…</div>';
  meta.textContent = '';
  try {
    // Refresh button passes force=1 to bypass the 5-min server cache;
    // normal tab-restore loads use the cache for snappy renders.
    const url = BASE_PATH + '/api/discoveries' + (forceRefresh ? '?force=1' : '');
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    discCache = await r.json();
    discApplyAndRender();
  } catch (e) {
    body.innerHTML = '<div class="disc-error">Failed to load: ' + escapeHtml(String(e.message || e)) + '</div>';
  } finally {
    discFetching = false;
    if (btn) btn.disabled = false;
  }
}

// Parse "$4.99" / "$0.00" / "N/A" to numeric (NaN for unknown).
// Regex built via RegExp constructor so the backslashes survive the
// outer PANEL_HTML template-literal evaluation. A literal regex would
// have its \d / \s / \. eaten by the template evaluation and become
// /d+/ in the browser, throwing a SyntaxError that kills every tab
// (caught 2026-05-15). Avoid backticks in comments inside PANEL_HTML
// for the same template-literal reason.
const DISC_WORTH_RE = new RegExp('\\\\$?\\\\s*(\\\\d+(?:\\\\.\\\\d+)?)');
function discParseWorth(w) {
  const m = DISC_WORTH_RE.exec(String(w || ''));
  return m ? parseFloat(m[1]) : NaN;
}

// In-game cosmetic / DLC / reward detector for the "Hide rewards / DLC"
// filter. r/FreeGameFindings posts a lot of non-game freebies — outfit
// skins, currency packs, GPU/points-gated rewards — that land in the
// "Other" bucket with no price and clutter the games view (e.g. two
// "007 First Light - … Outfit" rows). Word-boundary match (optional
// trailing s) so we hit "Outfit"/"Outfits"/"Skin"/"Skins" without
// false-matching substrings inside real game titles. Deliberately
// conservative: "bundle"/"pack" are common enough in legit free-game
// titles that we keep them out to avoid hiding real giveaways.
const DISC_REWARD_RE = new RegExp('\\\\b(outfit|skin|cosmetic|emote|avatar|wrap|charm|currency|coins?|gems?|credits?|booster|loot|in-game item|dlc)s?\\\\b', 'i');
function discIsReward(it) {
  return DISC_REWARD_RE.test(String(it.title || ''));
}

// Decide whether an item passes the current global filters. Returns
// { pass, reason } so the empty-state hint can explain why a tab is
// empty ("3 items hidden by your filters").
function discPassesFilters(it, filters) {
  if (filters.search) {
    const needle = filters.search.toLowerCase();
    if (!(it.title || '').toLowerCase().includes(needle)) return { pass: false, reason: 'search' };
  }
  if (filters.minPrice > 0) {
    const w = discParseWorth(it.worth);
    // Items with a known worth below threshold get filtered. Unknown
    // worth (NaN) stays — we can't tell, and false-hiding is worse
    // than false-showing for unknown-price items.
    if (Number.isFinite(w) && w < filters.minPrice) return { pass: false, reason: 'price' };
  }
  if (filters.hideClaimed && it.coverage.state === 'claimed') return { pass: false, reason: 'claimed' };
  // SKIP rolls into the "hide ignored" bucket — both are "you've already
  // decided not to claim this" from the user's POV. SKIP is implicit
  // (set by your settings); IGNORED is explicit (you clicked 🚫). Same
  // outcome, same hiding rule.
  if (filters.hideIgnored && (it.coverage.state === 'ignored' || it.coverage.state === 'skip')) return { pass: false, reason: 'ignored' };
  // Never hide an item the user explicitly marked as manually-claimed —
  // that's an intentional keep, regardless of the reward keyword match.
  if (filters.hideRewards && discIsReward(it) && !(it.userState && it.userState.status === 'manually-claimed')) {
    return { pass: false, reason: 'reward' };
  }
  return { pass: true };
}

function discReadFilters() {
  return {
    search: (document.getElementById('discSearch')?.value || '').trim(),
    minPrice: Number(document.getElementById('discMinPrice')?.value || 0),
    hideClaimed: !!document.getElementById('discHideClaimed')?.checked,
    hideIgnored: !!document.getElementById('discHideIgnored')?.checked,
    hideRewards: !!document.getElementById('discHideRewards')?.checked,
  };
}

function discApplyAndRender() {
  const body = document.getElementById('discBody');
  const meta = document.getElementById('discMeta');
  const subtabs = document.getElementById('discSubtabs');
  const hint = document.getElementById('discHiddenHint');
  if (!body || !discCache) return;
  const filters = discReadFilters();
  // Flatten and tag every item with sourceKey for rendering.
  const all = [];
  for (const it of (discCache.sources.gamerpower.items || [])) all.push({ ...it, sourceKey: 'gp' });
  for (const it of (discCache.sources.freegamefindings.items || [])) all.push({ ...it, sourceKey: 'fgf' });
  // Apply filters. Track hidden counts for the hint line.
  const hiddenCounts = { search: 0, price: 0, claimed: 0, ignored: 0 };
  const visible = [];
  for (const it of all) {
    const r = discPassesFilters(it, filters);
    if (r.pass) visible.push(it);
    else hiddenCounts[r.reason] = (hiddenCounts[r.reason] || 0) + 1;
  }
  // Group by collectorKey (bucket nulls into 'other'). Build the tab
  // count map BEFORE picking which tabs to show (so empty tabs can be
  // hidden — only render a tab if at least one item lives there after
  // filters).
  const bucket = {};
  for (const it of visible) {
    const k = it.collectorKey || 'other';
    (bucket[k] = bucket[k] || []).push(it);
  }
  // Sub-tab list: "All" first, then any collector in DISC_TAB_ORDER
  // that has items, in that order. "Other" only shows when populated.
  const orderedTabs = ['all'];
  for (const k of DISC_TAB_ORDER) {
    if (bucket[k] && bucket[k].length > 0) orderedTabs.push(k);
  }
  // If discActiveTab no longer has items, fall back to 'all'.
  if (discActiveTab !== 'all' && !bucket[discActiveTab]?.length) discActiveTab = 'all';
  // Render sub-tab nav.
  if (subtabs) {
    subtabs.innerHTML = orderedTabs.map(k => {
      const label = k === 'all' ? 'All' : (DISC_TAB_LABELS[k] || k);
      const count = k === 'all' ? visible.length : bucket[k].length;
      const active = k === discActiveTab ? ' active' : '';
      return '<button class="disc-subtab' + active + '" data-disc-tab="' + escapeHtml(k) + '">' +
        escapeHtml(label) +
        '<span class="disc-subtab-count">' + count + '</span>' +
      '</button>';
    }).join('');
  }
  // Render meta + hidden hint.
  if (meta) {
    const when = new Date(discCache.fetchedAt);
    meta.innerHTML = 'Fetched ' + escapeHtml(when.toLocaleTimeString()) +
      ' · GamerPower: ' + discCache.sources.gamerpower.total +
      ' · FreeGameFindings: ' + discCache.sources.freegamefindings.total +
      ' · Showing ' + visible.length + ' of ' + all.length;
  }
  if (hint) {
    const hidden = all.length - visible.length;
    hint.textContent = hidden > 0 ? hidden + ' hidden by filters' : '';
  }
  // Render the active tab's content.
  const tabItems = discActiveTab === 'all' ? visible : (bucket[discActiveTab] || []);
  if (tabItems.length === 0) {
    body.innerHTML = '<div class="disc-tab-empty">' +
      '<span class="disc-tab-empty-icon">✓</span>' +
      'All clear in ' + escapeHtml(discActiveTab === 'all' ? 'every tab' : (DISC_TAB_LABELS[discActiveTab] || discActiveTab)) +
      ' — nothing needs your attention here.' +
    '</div>';
    return;
  }
  // Sort within tab: MANUAL → NOTIFY → SKIP → AUTO → CLAIMED → IGNORED,
  // then by collector key, then alpha.
  const stateOrder = { manual: 0, notify: 1, skip: 2, auto: 3, claimed: 4, ignored: 5 };
  const sorted = tabItems.slice().sort((a, b) => {
    const sa = stateOrder[a.coverage.state] ?? 9;
    const sb = stateOrder[b.coverage.state] ?? 9;
    if (sa !== sb) return sa - sb;
    const ca = a.collectorKey || 'zzz';
    const cb = b.collectorKey || 'zzz';
    if (ca !== cb) return ca.localeCompare(cb);
    return (a.title || '').localeCompare(b.title || '');
  });
  body.innerHTML = '<div class="disc-list">' +
    sorted.map(it => discRenderItem(it)).join('') +
    '</div>';
}

function discRenderItem(it) {
  const state = it.coverage.state || 'manual';
  const stateLabel = state.toUpperCase();
  const sourceKey = it.sourceKey;
  // skipFields list comes from the backend's forecastSkip() — currently
  // ['worth'] when Steam price is below the user's threshold. Each field
  // name in this list gets a red highlight in the meta line below so
  // the user can see *which* setting caused the skip.
  const flaggedFields = new Set(it.coverage.skipFields || []);
  // Source pill (GP / FGF). Storefront chip moved to row meta-line.
  const sourcePill = sourceKey === 'fgf' ? 'FGF' : 'GP';
  // Tag chip — FGF bracketed prefix or GamerPower platform list.
  const chip = sourceKey === 'fgf'
    ? (it.tag || 'unknown')
    : (it.platforms || '');
  const metaParts = [];
  if (sourceKey === 'fgf') {
    if (typeof it.score === 'number') metaParts.push(it.score + ' upvotes');
    if (it.flair) metaParts.push(escapeHtml(it.flair));
  } else {
    if (it.type) metaParts.push(escapeHtml(it.type));
    if (it.endDate && it.endDate !== 'N/A') metaParts.push('ends ' + escapeHtml(it.endDate));
  }
  if (it.worth && it.worth !== 'N/A' && it.worth !== '$0.00') {
    const worthStr = 'worth ' + escapeHtml(it.worth);
    metaParts.push(flaggedFields.has('worth')
      ? '<span class="disc-item-meta-bad" title="Below your Steam minimum price — caused this SKIP">' + worthStr + '</span>'
      : worthStr);
  }
  const metaLine = metaParts.length
    ? '<span class="disc-item-meta">' + metaParts.join(' · ') + '</span>'
    : '';
  // Per-row action buttons. Values go through data-* attributes (NOT
  // inline onclick arguments) because titles like "Devil's Island"
  // contain apostrophes — HTML-escaping outputs &#39; which the browser
  // decodes back to ' inside an attribute, breaking the JS string and
  // throwing a SyntaxError that kills the whole render. data-* uses
  // HTML escaping only, which is reversible and safe.
  const keyAttr = escapeHtml(it.dedupKey || '');
  const titleAttr = escapeHtml(it.title || '');
  let actions;
  if (it.userState) {
    actions =
      '<button class="disc-action-btn" title="Undo — restore this item to its automatic state" data-disc-act="unmark" data-key="' + keyAttr + '">↺</button>';
  } else {
    actions =
      '<button class="disc-action-btn ok" title="Mark as manually-claimed by you" data-disc-act="mark" data-key="' + keyAttr + '" data-status="manually-claimed" data-title="' + titleAttr + '" data-url="' + escapeHtml(it.url || '') + '">✓</button>' +
      '<button class="disc-action-btn danger" title="Ignore — dismiss this row" data-disc-act="mark" data-key="' + keyAttr + '" data-status="ignored" data-title="' + titleAttr + '">🚫</button>';
  }
  const dimmed = it.userState ? ' user-marked' : '';
  return '<div class="disc-item' + dimmed + '" title="' + escapeHtml(it.coverage.label || '') + '">' +
    '<span class="disc-badge ' + state + '">' + stateLabel + '</span>' +
    '<div>' +
      '<div><a href="' + escapeHtml(it.url) + '" onclick="return openSiteUrl(this)" target="_blank" rel="noopener">' + escapeHtml(it.title) + '</a> <span class="disc-tag" title="source">' + sourcePill + '</span></div>' +
      '<div class="disc-coverage-label">' + escapeHtml(it.coverage.label || '') + '</div>' +
    '</div>' +
    '<div style="display:flex; align-items:center; gap:8px; justify-content:flex-end;">' +
      (chip ? '<span class="disc-tag">' + escapeHtml(chip) + '</span>' : '') +
      metaLine +
      '<div class="disc-actions">' + actions + '</div>' +
    '</div>' +
  '</div>';
}

// Delegated click handler for per-row Discoveries action buttons.
// Buttons are rendered fresh on every discApplyAndRender call, so
// hooking via onclick property would need rebinding each render —
// delegation is one-shot and survives re-renders. Reads the action
// kind + key/status/title from data-* attributes (HTML-escaped only,
// safe for titles containing apostrophes etc).
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-disc-act]');
  if (btn) {
    const act = btn.dataset.discAct;
    if (act === 'mark') {
      discMarkItem(btn.dataset.key, btn.dataset.status, btn.dataset.title || '', btn.dataset.url || '');
    } else if (act === 'unmark') {
      discUnmarkItem(btn.dataset.key);
    }
    return;
  }
  const tab = ev.target.closest('[data-disc-tab]');
  if (tab) {
    discSwitchSubtab(tab.dataset.discTab);
    return;
  }
  // Diagnostics banner buttons (phase 2). data-diag-act ∈ {share, dismiss, never}
  // — three sticky-decision actions. Share also opens the prefilled GitHub
  // issues/new URL in a new tab; refreshState afterwards so the banner
  // either advances to the next undecided fingerprint or hides.
  const diagBtn = ev.target.closest('[data-diag-act]');
  if (diagBtn) {
    const act = diagBtn.dataset.diagAct;
    const fp = diagBtn.dataset.diagFp;
    if (act === 'share') diagBannerShare(fp);
    else if (act === 'dismiss') diagBannerDecide(fp, 'dismissed');
    else if (act === 'never') diagBannerNever();
    return;
  }
  // Diagnostics tab row actions (phase 3). data-diag-row-act ∈
  // {share, dismiss, delete, stack}. Re-decide is allowed — a previously
  // Dismissed error can be Shared later (and vice versa). Stack toggles
  // the collapsed stack trace under the message cell.
  const diagRowBtn = ev.target.closest('[data-diag-row-act]');
  if (diagRowBtn) {
    const act = diagRowBtn.dataset.diagRowAct;
    const fp = diagRowBtn.dataset.diagFp;
    if (act === 'share') shareDiagnosticsEntry(fp);
    else if (act === 'dismiss') _setDiagDecision(fp, 'dismissed');
    else if (act === 'resolve') _setDiagDecision(fp, 'resolved');
    else if (act === 'delete') deleteDiagnosticsEntry(fp);
    else if (act === 'stack') {
      const el = document.getElementById('diagStack_' + fp);
      if (el) el.classList.toggle('shown');
      diagRowBtn.textContent = el && el.classList.contains('shown') ? 'hide stack' : 'show stack';
    }
    return;
  }
});

// --- Diagnostics banner client handlers (phase 2) ----------------------
// Each decision is sticky: after Share or Don't Share, the fingerprint
// never re-prompts. After Never Share, the banner is suppressed entirely
// until the Settings toggle re-enables.
async function diagBannerDecide(fingerprint, decision) {
  if (!fingerprint) return;
  try {
    const r = await fetch(BASE_PATH + '/api/diagnostics/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint, decision }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // Hide banner immediately; next refreshState will surface the next
    // undecided one (if any) or keep it hidden.
    const b = document.getElementById('diagBanner');
    if (b) b.style.display = 'none';
    refreshState();
  } catch (e) {
    showToast('Failed to update error decision: ' + e.message, 'error');
  }
}
// Render the context object captured at error time into a readable
// markdown <details> block. Server attaches non-sensitive scheduler /
// service / runtime state to each diagnostic record; this turns it into
// what the issue triager actually wants to see at a glance. Returns ''
// if no context is available so old records (or future schema gaps)
// degrade gracefully — the rest of the body still goes through.
function renderDiagnosticContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const TICK = String.fromCharCode(96);
  const lines = ['<details><summary>Config &amp; run state at error time</summary>', ''];
  try {
    const s = ctx.scheduler || {};
    const schedBits = [s.mode || '?'];
    if (s.dailyStartTime) schedBits.push('daily ' + s.dailyStartTime);
    if (s.loopSeconds) schedBits.push('loop ' + s.loopSeconds + 's');
    if (s.runOnStartup) schedBits.push('runOnStartup=' + s.runOnStartup);
    lines.push('**Scheduler:** ' + schedBits.join(', '));
    if (s.msWindow) {
      const m = s.msWindow;
      const ms = m.off
        ? (m.runWithMainChain ? 'inline (MS_RUN_WITH_MAIN_CHAIN=1)' : 'off')
        : (m.runWithMainChain ? 'inline (MS_RUN_WITH_MAIN_CHAIN=1)' : (m.startHour + ':00 + ' + m.hours + 'h window'));
      lines.push('**MS:** ' + ms);
    }
    if (Array.isArray(ctx.activeServices) && ctx.activeServices.length) {
      lines.push('**Active services:** ' + ctx.activeServices.join(', '));
    }
    const f = ctx.flags || {};
    const flagBits = [];
    flagBits.push('pg_redeem=' + !!f.pg_redeem + (f.pg_redeem ? ' (max ' + (f.pg_redeem_max_attempts || '?') + ' attempts)' : ''));
    if (f.pg_baseUrl) flagBits.push('pg_base_url=' + f.pg_baseUrl);
    flagBits.push('steam_skip_unrated=' + !!f.steam_skip_unrated + ', min_price=' + (f.steam_min_price ?? '?') + ', min_rating=' + (f.steam_min_rating ?? '?'));
    flagBits.push('ms_search_delay_max=' + (f.ms_search_delay_max ?? '?') + ', ms_redeem_threshold=' + (f.ms_redeem_threshold ?? '?') + ', ms_run_with_main_chain=' + !!f.ms_run_with_main_chain);
    const credsSet = [];
    const credsMiss = [];
    const credKeys = [['prime-gaming', 'pg_credsSet'], ['epic-games', 'eg_credsSet'], ['steam', 'steam_credsSet'], ['gog', 'gog_credsSet'], ['microsoft', 'ms_credsSet'], ['aliexpress', 'ae_credsSet']];
    for (const [name, key] of credKeys) (f[key] ? credsSet : credsMiss).push(name);
    flagBits.push('credentials set: ' + (credsSet.join(', ') || '(none)') + (credsMiss.length ? ' — missing: ' + credsMiss.join(', ') : ''));
    flagBits.push('notify_level=' + (f.notify_level || '?') + ', base_path=' + (f.base_path_set ? 'set' : 'unset') + ', public_url=' + (f.public_url_set ? 'set' : 'unset') + ', novnc_url=' + (f.novnc_url_set ? 'set' : 'unset'));
    lines.push('**Flags:**');
    for (const b of flagBits) lines.push('- ' + b);
    if (Array.isArray(ctx.recentRuns) && ctx.recentRuns.length) {
      lines.push('**Recent runs:**');
      for (const r of ctx.recentRuns) {
        const stat = r.status || (r.exit === 0 ? 'success' : 'error');
        const claim = (typeof r.claimed === 'number') ? ' (' + r.claimed + ' claimed)' : '';
        lines.push('- ' + (r.at || '?') + ' — ' + stat + claim);
      }
    }
    const r = ctx.runtime || {};
    const rtBits = [];
    if (r.node) rtBits.push('Node ' + r.node);
    if (r.platform || r.arch) rtBits.push((r.platform || '?') + ' ' + (r.arch || '?'));
    if (r.lang) rtBits.push('LANG=' + r.lang);
    if (r.tz) rtBits.push('TZ=' + r.tz);
    if (rtBits.length) lines.push('**Runtime:** ' + rtBits.join(', '));
  } catch (e) {
    lines.push('_(context render error: ' + (e && e.message || e) + ')_');
  }
  lines.push('');
  lines.push('</details>');
  // TICK reference to keep linter from flagging unused. (We don't need
  // it in this block — kept here in case future fields need code spans.)
  void TICK;
  return lines.join('\\n');
}

async function diagBannerShare(fingerprint) {
  if (!state || !state.diagnostics || !state.diagnostics.pending) return;
  const p = state.diagnostics.pending;
  if (p.fingerprint !== fingerprint) return; // mid-flight render mismatch
  // Build pre-filled GitHub issue URL. The user reviews + edits the body
  // on GitHub before submitting — we never auto-submit. Title is short
  // and machine-readable; body has the full context plus a note asking
  // them to redact anything they don't want public.
  const title = '[diagnostics] ' + (p.errorClass || 'Error') + ' in ' + (p.script || 'unknown') + ': ' + (p.message || '').slice(0, 80);
  // Literal backticks would close the outer PANEL_HTML template literal at Node eval — use fromCharCode.
  const TICK = String.fromCharCode(96);
  const FENCE = TICK + TICK + TICK;
  const ctxBlock = renderDiagnosticContext(p.context);
  const bodyLines = [
    '<!-- Auto-generated from the panel\\'s error-report banner. Review and edit anything you don\\'t want public before submitting. -->',
    '',
    '**Script:** ' + TICK + (p.script || 'unknown') + TICK,
    '**Error:** ' + TICK + (p.errorClass || 'Error') + TICK,
    '**Message:** ' + TICK + (p.message || '') + TICK,
    '**Count:** ' + (p.count || 1) + ' (first seen ' + (p.firstSeen || '?') + ', last seen ' + (p.lastSeen || '?') + ')',
    '**App version:** ' + (state.appVersion || 'unknown'),
    '',
    '<details><summary>Stack / context</summary>',
    '',
    FENCE,
    (p.stack || '').slice(0, 6000),
    FENCE,
    '',
    '</details>',
  ];
  if (ctxBlock) {
    bodyLines.push('');
    bodyLines.push(ctxBlock);
  }
  bodyLines.push('');
  bodyLines.push('<!-- Add any additional context here, e.g. what you were doing when this happened, recent changes, etc. -->');
  const body = bodyLines.join('\\n');
  const url = 'https://github.com/feldorn/free-games-claimer/issues/new?title=' +
    encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
  window.open(url, '_blank', 'noopener');
  // Mark as shared regardless of whether the user actually submits on
  // GitHub — the per-fingerprint decision means we trust them not to
  // be re-nagged. They can re-share from the Diagnostics tab if they
  // realised they hadn't actually submitted.
  await diagBannerDecide(fingerprint, 'shared');
}
async function diagBannerNever() {
  if (!confirm('Turn off the error-report banner? You can re-enable from Settings → Notifications.')) return;
  try {
    const r = await fetch(BASE_PATH + '/api/diagnostics/disable', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = document.getElementById('diagBanner');
    if (b) b.style.display = 'none';
    refreshState();
  } catch (e) {
    showToast('Failed to disable banner: ' + e.message, 'error');
  }
}

// --- Diagnostics tab (phase 3) -----------------------------------------
// Full error history with per-row re-decide + delete actions. Reads
// /api/diagnostics/list and renders a table. The toolbar toggle drives
// the same enable/disable endpoints the Never Share banner button uses.
let diagListCache = null;
async function renderDiagnosticsTab() {
  const body = document.getElementById('diagBody');
  const status = document.getElementById('diagStatus');
  const toggleBtn = document.getElementById('btnDiagToggle');
  if (!body) return;
  try {
    const r = await fetch(BASE_PATH + '/api/diagnostics/list');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    diagListCache = j;
    if (status) {
      status.textContent = j.enabled ? 'Banner enabled' : 'Banner disabled';
      status.className = 'diag-status ' + (j.enabled ? 'on' : 'off');
    }
    if (toggleBtn) {
      toggleBtn.textContent = j.enabled ? 'Disable banner' : 'Enable banner';
      toggleBtn.className = 'dt-toggle ' + (j.enabled ? 'on' : 'off');
    }
    const rows = j.errors || [];
    if (!rows.length) {
      body.innerHTML = '<div class="diag-empty">No errors logged yet. When a run hits an error (uncaught exception, apprise failure, Playwright protocol error), it shows up here and the three-button banner appears at the top of the panel.</div>';
      return;
    }
    let html = '<table class="diag-table">' +
      '<thead><tr>' +
        '<th>Last seen</th>' +
        '<th>Script</th>' +
        '<th>Class</th>' +
        '<th>Message</th>' +
        '<th class="col-count">Count</th>' +
        '<th>Decision</th>' +
        '<th>Actions</th>' +
      '</tr></thead><tbody>';
    for (const e of rows) {
      const d = e.decided;
      const decClass = d === 'shared' ? 'shared' : d === 'dismissed' ? 'dismissed' : d === 'resolved' ? 'resolved' : 'pending';
      const decLabel = d === 'shared' ? 'Shared' : d === 'dismissed' ? 'Dismissed' : d === 'resolved' ? 'Resolved' : 'Pending';
      // Action buttons per state:
      //   pending   → Share, Dismiss, Delete
      //   shared    → Mark resolved, Delete  (track whether the GitHub issue got fixed)
      //   dismissed → Share, Delete         (allow changing mind without 'resolve' since nothing was filed)
      //   resolved  → Delete                (terminal)
      const fp = escapeHtml(e.fingerprint);
      let actBtns = '';
      if (d === null || d === undefined) {
        actBtns =
          '<button class="dt-share" data-diag-row-act="share"   data-diag-fp="' + fp + '">Share</button>' +
          '<button class="dt-skip"  data-diag-row-act="dismiss" data-diag-fp="' + fp + '">Dismiss</button>';
      } else if (d === 'shared') {
        actBtns =
          '<button class="dt-resolve" data-diag-row-act="resolve" data-diag-fp="' + fp + '" title="Mark this issue as fixed — useful after a release that resolved it.">Mark resolved</button>';
      } else if (d === 'dismissed') {
        actBtns =
          '<button class="dt-share" data-diag-row-act="share" data-diag-fp="' + fp + '">Share</button>';
      }
      const delBtn = '<button class="dt-del" data-diag-row-act="delete" data-diag-fp="' + fp + '" title="Permanently remove this error">Delete</button>';
      const hasStack = e.stack && e.stack.length > 0;
      html += '<tr>' +
        '<td class="col-when">' + escapeHtml(_diagFormatWhen(e.lastSeen)) + '<br><span style="opacity:0.6">first ' + escapeHtml(_diagFormatWhen(e.firstSeen)) + '</span></td>' +
        '<td class="col-script">' + escapeHtml(e.script) + '</td>' +
        '<td class="col-class">' + escapeHtml(e.errorClass) + '</td>' +
        '<td class="col-msg">' + escapeHtml(e.message) +
          (hasStack ? '<br><button class="toggle-stack" data-diag-row-act="stack" data-diag-fp="' + escapeHtml(e.fingerprint) + '">show stack</button><pre class="diag-stack" id="diagStack_' + escapeHtml(e.fingerprint) + '">' + escapeHtml(e.stack) + '</pre>' : '') +
        '</td>' +
        '<td class="col-count">' + (e.count || 1) + '</td>' +
        '<td class="col-dec ' + decClass + '">' + decLabel + '</td>' +
        '<td class="col-actions">' + actBtns + delBtn + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = '<div class="diag-empty">Failed to load diagnostics: ' + escapeHtml(e.message) + '</div>';
  }
}

function _diagFormatWhen(iso) {
  if (!iso) return '?';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString();
    return d.toLocaleString();
  } catch { return iso; }
}

async function toggleDiagnosticsEnabled() {
  if (!diagListCache) return;
  const path = diagListCache.enabled ? '/api/diagnostics/disable' : '/api/diagnostics/enable';
  try {
    const r = await fetch(BASE_PATH + path, { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    renderDiagnosticsTab();
    refreshState();
  } catch (e) {
    showToast('Failed to toggle banner: ' + e.message, 'error');
  }
}

async function clearDiagnosticsHistory() {
  if (!confirm('Permanently delete all logged errors? The enable/disable setting is kept.')) return;
  try {
    const r = await fetch(BASE_PATH + '/api/diagnostics/clear', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    renderDiagnosticsTab();
    refreshState();
  } catch (e) {
    showToast('Failed to clear: ' + e.message, 'error');
  }
}

async function _setDiagDecision(fingerprint, decision) {
  if (!fingerprint) return;
  try {
    const r = await fetch(BASE_PATH + '/api/diagnostics/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint, decision }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    renderDiagnosticsTab();
    refreshState();
  } catch (e) {
    showToast('Failed: ' + e.message, 'error');
  }
}

async function deleteDiagnosticsEntry(fingerprint) {
  if (!fingerprint) return;
  if (!confirm('Delete this error from the log?')) return;
  try {
    const r = await fetch(BASE_PATH + '/api/diagnostics/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    renderDiagnosticsTab();
    refreshState();
  } catch (e) {
    showToast('Failed to delete: ' + e.message, 'error');
  }
}

async function shareDiagnosticsEntry(fingerprint) {
  if (!diagListCache) return;
  const p = (diagListCache.errors || []).find(r => r.fingerprint === fingerprint);
  if (!p) return;
  // Re-use the same prefilled body shape the banner uses.
  const title = '[diagnostics] ' + (p.errorClass || 'Error') + ' in ' + (p.script || 'unknown') + ': ' + (p.message || '').slice(0, 80);
  const TICK = String.fromCharCode(96);
  const FENCE = TICK + TICK + TICK;
  const ctxBlock = renderDiagnosticContext(p.context);
  const bodyLines = [
    '<!-- Auto-generated from the Diagnostics tab. Review and edit anything you don\\'t want public before submitting. -->',
    '',
    '**Script:** ' + TICK + (p.script || 'unknown') + TICK,
    '**Error:** ' + TICK + (p.errorClass || 'Error') + TICK,
    '**Message:** ' + TICK + (p.message || '') + TICK,
    '**Count:** ' + (p.count || 1) + ' (first seen ' + (p.firstSeen || '?') + ', last seen ' + (p.lastSeen || '?') + ')',
    '**App version:** ' + (state && state.appVersion ? state.appVersion : 'unknown'),
    '',
    '<details><summary>Stack / context</summary>',
    '',
    FENCE,
    (p.stack || '').slice(0, 6000),
    FENCE,
    '',
    '</details>',
  ];
  if (ctxBlock) {
    bodyLines.push('');
    bodyLines.push(ctxBlock);
  }
  bodyLines.push('');
  bodyLines.push('<!-- Add any additional context here, e.g. what you were doing when this happened, recent changes, etc. -->');
  const body = bodyLines.join('\\n');
  const url = 'https://github.com/feldorn/free-games-claimer/issues/new?title=' +
    encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
  window.open(url, '_blank', 'noopener');
  await fetch(BASE_PATH + '/api/diagnostics/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fingerprint, decision: 'shared' }),
  }).catch(() => {});
  renderDiagnosticsTab();
  refreshState();
}

// POST /api/discoveries/mark — flips the item's userState. Optimistic
// update: mutate the local cache so the next render reflects the
// change without a refetch, then call the server. On error, revert.
async function discMarkItem(key, status, title, url) {
  if (!discCache || !key) return;
  // Apply local mutation to every cache entry sharing this key.
  const prev = discApplyUserStateLocally(key, status, title);
  discApplyAndRender();
  try {
    const r = await fetch(BASE_PATH + '/api/discoveries/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, status, title: title || '', url: url || '' }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'unknown');
  } catch (e) {
    // Revert: restore the previous coverage/userState on each mutated item.
    if (prev) discApplyUserStateLocally(key, null, title, prev);
    discApplyAndRender();
    showToast('Failed to mark item: ' + e.message, 'error');
  }
}

async function discUnmarkItem(key) {
  if (!discCache || !key) return;
  const prev = discApplyUserStateLocally(key, null);
  discApplyAndRender();
  try {
    const r = await fetch(BASE_PATH + '/api/discoveries/unmark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'unknown');
  } catch (e) {
    if (prev) discApplyUserStateLocally(key, null, null, prev);
    discApplyAndRender();
    showToast('Failed to undo: ' + e.message, 'error');
  }
}

// Mutate discCache so all items with the given dedupKey get the new
// userState + matching coverage. A single game often appears in BOTH
// GP and FGF, sharing one dedupKey — they MUST flip together so the
// optimistic local view matches what the server would return on a
// refresh. Returns an array of previous values (one per mutated item)
// for revert on POST failure. A status of null clears user-state (undo).
function discApplyUserStateLocally(key, status, title, restoreList) {
  const mutated = [];
  let restoreIdx = 0;
  for (const src of ['gamerpower', 'freegamefindings']) {
    const items = discCache?.sources?.[src]?.items;
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (it.dedupKey !== key) continue;
      // Capture prior state for revert.
      mutated.push({ src, coverage: it.coverage, userState: it.userState, title: it.title });
      // Restore path: apply the previously-captured state.
      if (Array.isArray(restoreList) && restoreList[restoreIdx]) {
        it.coverage = restoreList[restoreIdx].coverage;
        it.userState = restoreList[restoreIdx].userState;
        restoreIdx++;
        continue;
      }
      if (status === null) {
        // Undo. Best-effort revert of coverage. Original auto-derived
        // coverage isn't preserved locally; coerce to AUTO/MANUAL until
        // next /api/discoveries fetch reconciles server-side truth.
        it.userState = null;
        if (it.coverage && it.coverage.userMarked) {
          it.coverage = { state: 'auto', label: 'Restored — Refresh to resync coverage state' };
        } else if (it.coverage && it.coverage.state === 'ignored') {
          it.coverage = { state: 'manual', label: 'Restored — Refresh to resync coverage state' };
        }
        continue;
      }
      it.userState = { status, at: new Date().toISOString() };
      if (status === 'ignored') {
        it.coverage = { state: 'ignored', label: 'You ignored this. Use the undo button to restore.' };
      } else if (status === 'manually-claimed') {
        it.coverage = { state: 'claimed', label: 'Marked as manually-claimed by you. Use the undo button if this was accidental.', userMarked: true };
      }
    }
  }
  return mutated.length ? mutated : null;
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
// Per-field "show real value" toggle for sensitive fields (Apprise URL
// etc.). Default closed — value renders masked via -webkit-text-security
// or type="password" until the user clicks Reveal.
const revealedSensitive = new Set();

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

function toggleRevealSensitive(path) {
  if (revealedSensitive.has(path)) revealedSensitive.delete(path); else revealedSensitive.add(path);
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

// Inline "Error reporting" group inside Notifications. The toggle isn't a
// cfg field — it lives in diagnostics-state.json and is driven by the same
// /enable + /disable endpoints the Never Share banner button uses. Keeps
// settings.save() out of the picture (no draft state, immediate apply).
function renderDiagnosticsSettingsGroup() {
  const enabled = state && state.diagnostics && state.diagnostics.enabled !== false;
  return '<div class="setting-group">' +
    '<div class="setting-group-head">Error reporting</div>' +
    '<div class="setting-row" style="padding: 8px 12px; align-items: flex-start;">' +
      '<label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">' +
        '<input type="checkbox" ' + (enabled ? 'checked' : '') + ' onchange="toggleDiagnosticsFromSettings(this.checked)">' +
        '<span style="font-weight: 600;">Show the error-report banner</span>' +
      '</label>' +
      '<div class="setting-hint" style="margin-top: 6px; color: #8aa0c2; font-size: 12px; line-height: 1.5;">When a run hits an error, a banner appears with three buttons: <b>Share</b> (opens a pre-filled GitHub issue you review before submitting), <b>Don\\'t Share</b> (dismiss just this error), <b>Never Share</b> (turn off the banner — this checkbox flips back on). Nothing is ever sent without an explicit Share click. See the <a href="#" onclick="switchTab(\\'diagnostics\\'); return false;">Diagnostics tab</a> for the full error history.</div>' +
    '</div>' +
  '</div>';
}

async function toggleDiagnosticsFromSettings(enabled) {
  const path = enabled ? '/api/diagnostics/enable' : '/api/diagnostics/disable';
  try {
    const r = await fetch(BASE_PATH + path, { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    refreshState();
    showToast(enabled ? 'Error-report banner enabled' : 'Error-report banner disabled', 'success');
  } catch (e) {
    showToast('Failed: ' + e.message, 'error');
  }
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

  const sensitive = !!f.sensitive;
  const revealed = sensitive && revealedSensitive.has(path);
  const sensState = revealed ? 'shown' : 'hidden';
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
    const sensAttr = sensitive ? ' data-sensitive-state="' + sensState + '"' : '';
    inputHtml = '<textarea' + sensAttr + ' oninput="setSettingValue(\\'' + path + '\\', this.value)">' + escapeHtml(value || '') + '</textarea>';
  } else {
    const sensAttr = sensitive ? ' data-sensitive-state="' + sensState + '"' : '';
    inputHtml = '<input type="text"' + sensAttr + ' value="' + escapeHtml(value || '') + '" oninput="setSettingValue(\\'' + path + '\\', this.value)">';
  }
  // Sensitive fields get a Reveal/Hide toggle inside the input column so
  // the button stays grouped with the masked control rather than sliding
  // into the trailing Revert column. The masking is visual only — the
  // value is still in the DOM (it has to be, the user might edit it) —
  // protection is against shoulder-surfing / screenshots / screen-share.
  if (sensitive) {
    inputHtml += '<button type="button" class="setting-reveal" onclick="toggleRevealSensitive(\\'' + path + '\\')">' + (revealed ? 'Hide' : 'Reveal') + '</button>';
  }
  const inputClass = sensitive ? 'setting-input sensitive' : 'setting-input';

  return '<div class="setting" data-path="' + path + '">' +
    '<div class="setting-label">' + labelHtml + '</div>' +
    '<div class="' + inputClass + '">' + inputHtml + '</div>' +
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
    '</div>' +
    fieldRow('scheduler.runOnStartup', 'Run on startup',
      { hint: 'Fire a claim run once when the panel finishes its boot session-check. "One-shot" terminates the container after the run completes — useful with Sablier scale-to-zero or cron-driven docker start/stop.',
        options: [
          { value: 0, label: 'Off' },
          { value: 1, label: 'Run on startup' },
          { value: 2, label: 'One-shot (run + exit)' },
        ] });
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
      settingGroup('Verbosity',
        fieldRow('notifications.notifyLevel', 'Notification level',
          { options: [
              { value: 'all',     label: 'All — every claim, captcha, error, and watcher event' },
              { value: 'actions', label: 'Actions Required — login issues, captchas, errors, watcher new-items, redeem reminders (silences per-run summaries when nothing needed your attention)' },
              { value: 'off',     label: 'Off — silence all notifications' },
            ],
            hint: 'Default is All. Choose Actions Required to skip the per-run "X claimed, Y already owned" summary on uneventful runs while keeping anything that asks you to do something. Off silences everything globally — captchas + login errors included.' }) +
        fieldRow('notifications.captchaPriority', 'Captcha priority',
          { options: [
              { value: 'low',       label: 'Low' },
              { value: 'moderate',  label: 'Moderate' },
              { value: 'normal',    label: 'Normal' },
              { value: 'high',      label: 'High (default — punches through DnD)' },
              { value: 'emergency', label: 'Emergency (Pushover requires acknowledgment)' },
            ],
            hint: 'Priority sent with captcha alerts (apprise --priority). Captchas are time-sensitive — Epic / GOG / AliExpress iframes time out within minutes — so High is the default to break through Do-Not-Disturb on Pushover and similar notifiers. Lower it to Normal if these wake you up too often.' })
      ) +
      settingGroup('Panel link',
        fieldRow('panel.publicUrl', 'Public URL',
          { hint: 'External URL used in notifications so tap-targets land on the panel.' }) +
        fieldRow('panel.externalLinkMode', 'External link behavior',
          { options: [
              { value: 'auto',     label: 'Auto — new tab when panel is top-level, break out of iframe when embedded in a dashboard' },
              { value: 'same-tab', label: 'Same tab — always navigate the top window (replaces the current page)' },
              { value: 'new-tab',  label: 'New tab — always open in a new tab (may fail if your dashboard iframe sandboxes them)' },
            ],
            hint: 'Controls how Discoveries-tab links, GitHub footer links, and site shortcuts open. Default Auto detects iframe embedding and adapts. Override if Auto doesn\\'t fit your setup — e.g. you\\'re running the panel inside an iframe but want same-tab navigation anyway.' })
      ) +
      renderDiagnosticsSettingsGroup();
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
      ) +
      settingGroup('Logs',
        fieldRow('advanced.runHistoryMax', 'Past runs to retain', { unit: 'runs', hint: 'How many completed runs to keep in data/runs.json for the Logs tab Past-runs picker. Older entries are trimmed when this limit is exceeded. Higher = longer history but bigger file (~50 KB per run on average).' })
      );
  }

  // Slot the dot/revert legend underneath whichever pane-title the
  // section rendered (Scheduler / Notifications / Services / Advanced).
  // First closing div after settings-pane-title is the title's close
  // tag — inject right after it. Regex built via RegExp constructor so
  // the backslashes in [\s\S] survive the outer PANEL_HTML template-
  // literal evaluation (a literal /[\s\S]/ would have its escapes eaten
  // and match only [sS] chars in the browser).
  const legend = '<div class="settings-pane-legend">' +
    '<span class="setting-dot"></span> = field is overridden from default. Click <b>Revert</b> next to a field to restore.' +
    '</div>';
  const titleEndRe = new RegExp('(<div class="settings-pane-title"[\\\\s\\\\S]*?</div>)');
  html = html.replace(titleEndRe, '$1' + legend);

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
  } else {
    footer.style.display = 'flex';
    counter.textContent = n + ' unsaved change' + (n === 1 ? '' : 's');
  }
  // Per-section dirty counts surfaced as a badge on each sidebar rail
  // button (feedback item #11). Bucket dirty paths to sections via path
  // prefix; panel.X paths live on the Notifications page so they count there.
  const sectionCounts = { scheduler: 0, notifications: 0, services: 0, advanced: 0 };
  for (const path of Object.keys(settingsDirty)) {
    if (path.startsWith('scheduler.')) sectionCounts.scheduler++;
    else if (path.startsWith('notifications.') || path.startsWith('panel.')) sectionCounts.notifications++;
    else if (path.startsWith('services.')) sectionCounts.services++;
    else if (path.startsWith('advanced.')) sectionCounts.advanced++;
  }
  document.querySelectorAll('.settings-rail .rail-btn').forEach(b => {
    const section = b.dataset.section;
    const c = sectionCounts[section] || 0;
    const existing = b.querySelector('.rail-dirty-badge');
    if (c > 0) {
      if (existing) existing.textContent = String(c);
      else {
        const badge = document.createElement('span');
        badge.className = 'rail-dirty-badge';
        badge.textContent = String(c);
        b.appendChild(badge);
      }
    } else if (existing) {
      existing.remove();
    }
  });
}

function discardSettings() {
  settingsDirty = {};
  paintSettings();
}

async function saveSettings() {
  const btn = document.getElementById('btnSaveSettings');
  if (!btn) return;
  // One-shot gate: if this save would set scheduler.runOnStartup to 2,
  // the panel terminates after the next claim run completes — the user
  // would lose UI access until something restarts the container. The only
  // recovery paths are external (env override, edit data/config.json, or
  // change the dropdown back before the run finishes), so confirm
  // explicitly and surface the NOTIFY warning if no apprise URL is set.
  if (Number(settingsDirty['scheduler.runOnStartup']) === 2) {
    const notifyVal = (settingsDirty['notifications.notify'] !== undefined
      ? settingsDirty['notifications.notify']
      : (settingsData && (settingsData.effective.notifications || {}).notify)) || '';
    const notifyWarn = notifyVal.trim()
      ? ''
      : '\\n\\nNOTIFY is empty — no apprise URL is configured, so you will not be notified about claim results before the container exits. Set Notifications → Apprise URL(s) first if you want post-exit visibility.';
    const msg = 'Confirm: switch to One-shot (run + exit)?\\n\\n' +
      'After saving, the next container start will fire a claim run and then terminate the panel. The panel will be unreachable until something restarts the container (Sablier traffic, cron docker start, manual docker compose up, etc.).\\n\\n' +
      'To revert, you must either:\\n' +
      '  • Restart the container and change the setting via the panel before the claim run finishes (race), or\\n' +
      '  • Edit data/config.json on disk and remove the scheduler.runOnStartup key, or\\n' +
      '  • Set RUN_ON_STARTUP=0 in environment AND remove the data/config.json override (env alone is not enough — saved settings win).' +
      notifyWarn +
      '\\n\\nProceed?';
    if (!confirm(msg)) {
      // Abort save without resetting the dirty flag — user can revert
      // the dropdown via the Discard button or the Revert link.
      return;
    }
  }
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
        // Same iframe-context handling as the Sessions card "↗" icon —
        // openSiteUrl() detects panel-inside-Organizr and navigates the
        // top tab to escape the sandbox restriction that blocks
        // cross-origin-isolated destinations (Epic, MS Rewards, Steam,
        // etc.) from loading in popups created by the iframe.
        const titleHtml = a.url
          ? '<a href="' + encodeURI(a.url) + '" onclick="return openSiteUrl(this)" target="_blank">' + escapeHtml(a.title) + '</a>'
          : escapeHtml(a.title);
        const titleClass = a.url ? 'title' : 'title no-link';
        const titleAttr = a.url
          ? ''
          : ' title="No store link recorded for this claim. Manual claims marked before v2.8.2 don\\'t have URLs; future ones will."';
        return '<div class="act">' +
          '<span class="at" title="' + escapeHtml(a.at) + '">' + escapeHtml(formatTimestamp(a.at, 'relative')) + '</span>' +
          '<span class="svc">' + escapeHtml(a.serviceName) + '</span>' +
          '<span class="' + titleClass + '"' + titleAttr + '>' + titleHtml + '</span>' +
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
        '<div><span class="sched-value big" title="' + state.nextScheduledRun + '">' + formatScheduleWallTime(state.nextScheduledRunIso, state.nextScheduledRun) + '</span>' +
        tzAnnotation(state.nextScheduledRunIso) +
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
          '<div><span class="sched-value big" title="' + state.nextMainRun + '">' + formatScheduleWallTime(state.nextMainRunIso, state.nextMainRun) + '</span>' +
          tzAnnotation(state.nextMainRunIso) +
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
          '<div><span class="sched-value big" title="' + state.nextMsRun + '">' + formatScheduleWallTime(state.nextMsRunIso, state.nextMsRun) + '</span>' +
          tzAnnotation(state.nextMsRunIso) +
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
  // Watchers are in state.watchers (not state.sites). They run on each
  // main-chain fire as part of the bash command — listing them in the
  // Services breakdown so the Schedule tab reflects the actual daily run.
  // Lenovo Gaming gets its own row because it has additional per-drop
  // wakes outside the main chain (lenovoSchedulerLoop fires 1h/5min/at-time).
  const allWatchers = (state.watchers || []).slice();
  const standardWatchers = allWatchers.filter(w => w.id !== 'lenovo-gaming');
  const lenovoWatcher = allWatchers.find(w => w.id === 'lenovo-gaming');
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
  standardWatchers.sort(byName);
  const activeCount = activeGames.length + (hasAE ? 1 : 0) + (hasMS ? 1 : 0)
    + standardWatchers.length + (lenovoWatcher ? 1 : 0);

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
  if (standardWatchers.length) {
    svcLines.push('<b>' + standardWatchers.map(w => escapeHtml(w.name)).join(', ') + '</b> — watch and notify on new free items <span class="muted">(no auto-claim)</span>');
  }
  if (lenovoWatcher) {
    const lg = state.lenovoGaming || { drops: [], nextWake: null };
    const upcoming = (lg.drops || []).filter(d => !d.userCollected && d.scheduledAt && (d.status === 'coming-soon' || d.status === 'active'));
    const upcomingNote = upcoming.length
      ? ' <span class="muted">(' + upcoming.length + ' tracked)</span>'
      : '';
    svcLines.push('<b>' + escapeHtml(lenovoWatcher.name) + '</b> — watch + per-drop wakes <span class="muted">(1h before, 5min before, at drop time)</span>' + upcomingNote);
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
      '<div class="sched-value"><span title="' + state.lastRun.at + '">' + formatScheduleWallTime(state.lastRun.atIso, state.lastRun.at) + '</span>' +
        tzAnnotation(state.lastRun.atIso) +
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
  // Use the *Iso fields when available — these are UTC-anchored so the
  // countdown is correct regardless of whether browser TZ matches server TZ.
  // Naked-string fallback (the .replace path) misparses as browser-local
  // and is off by the TZ offset, which is exactly the bug a user in a
  // different TZ from their server would hit.
  const apply = (id, isoTs, fallback) => {
    const el = document.getElementById(id);
    if (!el) return;
    const src = isoTs || fallback;
    if (!src) return;
    const t = isoTs ? new Date(isoTs).getTime() : new Date(String(fallback).replace(' ', 'T')).getTime();
    if (Number.isFinite(t)) el.textContent = formatCountdown(t);
  };
  apply('schedCountdown', state.nextScheduledRunIso, state.nextScheduledRun);
  apply('mainCountdown',  state.nextMainRunIso,      state.nextMainRun);
  apply('msCountdown',    state.nextMsRunIso,        state.nextMsRun);
}

// Format an ISO timestamp into a server-local-tz wall clock for display.
// We render in the SERVER's TZ (matches what the user set in START_TIME,
// matches docker logs, matches the system clock the scheduler reads) and
// annotate with the browser's TZ separately when they differ — that way
// the user sees both "what the scheduler thinks the time is" and "when
// that lands in my local clock." Falls back to slicing the naked string
// when isoTs isn't available (older state responses, panel-side fields
// not yet wired through).
function formatScheduleWallTime(isoTs, fallbackStr) {
  const src = isoTs || fallbackStr;
  if (!src) return '';
  if (!isoTs) {
    // Legacy fallback — naked "YYYY-MM-DD HH:mm:ss" string from server-local.
    // No TZ conversion possible, just trim.
    return String(fallbackStr).replace('T', ' ').slice(0, 16);
  }
  const d = new Date(isoTs);
  if (!Number.isFinite(d.getTime())) return String(src);
  const tz = (state && state.serverTimezone) || undefined;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d).replace(',', '');
  } catch {
    // Bad TZ name fallback — render in browser-local
    return d.toISOString().replace('T', ' ').slice(0, 16);
  }
}

// Returns the inline TZ annotation HTML (or empty string) shown next to
// schedule wall times. Only present when browser TZ differs from server
// TZ — same TZ = no annotation needed. Annotation shows browser-local
// time for the same instant so user can convert without mental math.
function tzAnnotation(isoTs) {
  if (!isoTs || !state || !state.serverTimezone) return '';
  let browserTz = null;
  try { browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  if (!browserTz || browserTz === state.serverTimezone) return '';
  const d = new Date(isoTs);
  if (!Number.isFinite(d.getTime())) return '';
  try {
    const local = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
    }).format(d);
    return ' <span class="muted sched-tz">(' + escapeHtml(local) + ' your local)</span>';
  } catch { return ''; }
}
setInterval(updateScheduleCountdown, 30000);

let logsTabOffset = 0;
let logsTabPollTimer = null;
function startLogsTabPoll() {
  if (logsTabPollTimer) return;
  refreshRunHistoryList(); // populate the past-runs dropdown on tab open
  if (logsHistorySelectedAt) {
    // User had a past run selected before tabbing away. Re-render the
    // past log entry rather than resetting to "Loading…" — without this,
    // the body would stay empty because pollLogsTab early-returns in
    // history mode and never repopulates. Honors the selection in the
    // dropdown rather than silently dropping back to Live.
    selectRunHistoryOption(logsHistorySelectedAt);
    return;
  }
  logsTabOffset = 0;
  const body = document.getElementById('logsBody');
  if (body) body.innerHTML = '<div class="logs-empty">Loading…</div>';
  pollLogsTab();
}
function stopLogsTabPoll() {
  if (logsTabPollTimer) { clearTimeout(logsTabPollTimer); logsTabPollTimer = null; }
}
// History-mode state for the Logs tab. When non-empty, the dropdown is
// pinned to a past-run entry and the live poll is suspended. Empty
// string = "Live (current run)" → live polling resumes.
let logsHistorySelectedAt = '';
let logsLastRunStatus = null; // detect run-end transitions to refresh the dropdown
async function pollLogsTab() {
  if (document.body.dataset.tab !== 'logs') { stopLogsTabPoll(); return; }
  // Lazily populate the run-history dropdown the first time the tab opens
  // and after a run finishes (so a just-completed run shows up without
  // a manual refresh).
  let interval = 3000;
  if (logsHistorySelectedAt) {
    // History mode — single fetch, no polling.
    return;
  }
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
        // Hard space after the time span so even copy-pasted plaintext
        // (which strips CSS margin-right) keeps timestamps separated
        // from the section's "───" or content. Skip the span entirely
        // when there's no time — structural lines (=== / ───) render
        // flush-left for visual emphasis.
        const timeSpan = t ? '<span class="time">' + t + '</span> ' : '';
        div.innerHTML = timeSpan + escapeHtml(l.text);
        body.appendChild(div);
      });
      body.scrollTop = body.scrollHeight;
    } else if (body && logsTabOffset === 0 && (!r.lines || !r.lines.length)) {
      body.innerHTML = '<div class="logs-empty">No run activity yet. The log will populate during a manual Run Now or scheduled run.</div>';
    }
    if (typeof r.total === 'number') logsTabOffset = r.total;
    if (count) count.textContent = logsTabOffset + ' line' + (logsTabOffset === 1 ? '' : 's');
    // Detect a run-completion transition (was running, now isn't) to
    // refresh the history dropdown so the new entry appears.
    if (logsLastRunStatus === 'running' && r && r.status !== 'running') {
      refreshRunHistoryList();
    }
    logsLastRunStatus = r && r.status;
    if (r && r.status === 'running') interval = 1000;
  } catch {}
  logsTabPollTimer = setTimeout(pollLogsTab, interval);
}

// Format duration in a readable, compact form ("23s", "4m 12s", "1h 5m").
function fmtRunDuration(sec) {
  sec = Number(sec) || 0;
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}

// Refresh the history popup contents from /api/runs. Idempotent —
// preserves the selected entry across refreshes via logsHistorySelectedAt.
let runHistoryCache = []; // last-fetched runs list, used for label lookups
async function refreshRunHistoryList() {
  const popup = document.getElementById('rhpPopup');
  if (!popup) return;
  try {
    const r = await api('GET', '/runs');
    runHistoryCache = r.runs || [];
    let html = '<div class="rhp-option live' + (logsHistorySelectedAt === '' ? ' active' : '') +
      '" data-at="" onclick="selectRunHistoryOption(\\'\\')">Live (current run)</div>';
    runHistoryCache.forEach(run => {
      const label = formatRunHistoryLabel(run);
      const at = run.at || '';
      const isActive = at === logsHistorySelectedAt;
      html += '<div class="rhp-option' + (isActive ? ' active' : '') +
        '" data-at="' + escapeHtml(at) + '" onclick="selectRunHistoryOption(\\'' + escapeHtml(at).replace(/'/g, "\\'") + '\\')">' +
        escapeHtml(label) + '</div>';
    });
    popup.innerHTML = html;
    // Update the trigger label too in case the currently-selected run was
    // refreshed-in (e.g. user is sitting on Live mode and a new run finishes).
    syncRunHistoryTrigger();
  } catch { /* best-effort */ }
}

function formatRunHistoryLabel(run) {
  // Short timestamp: "2026-05-09 07:30" — drop seconds + milliseconds.
  const ts = (run.at || '').slice(0, 16);
  const sum = run.summary || {};
  const icon = run.status === 'success' ? '✓' : '✗';
  const dur = fmtRunDuration(run.durationSec);
  // One headline counter per row instead of all of them — pick the most
  // informative based on what was non-zero. Order: claimed, pts (MS),
  // coins (AE), owned (no-op runs).
  let counter = '';
  if (sum.claimed) counter = ' — ' + sum.claimed + ' claimed';
  else if (sum.pointsEarned) counter = ' — ' + sum.pointsEarned + ' pts';
  else if (sum.coins) counter = ' — ' + sum.coins + ' coins';
  else if (sum.alreadyOwned) counter = ' — ' + sum.alreadyOwned + ' owned';
  return icon + ' ' + ts + ' (' + dur + ')' + counter;
}

function syncRunHistoryTrigger() {
  const trig = document.getElementById('rhpTrigger');
  if (!trig) return;
  if (!logsHistorySelectedAt) {
    trig.textContent = 'Live (current run)';
    return;
  }
  const run = runHistoryCache.find(r => r.at === logsHistorySelectedAt);
  trig.textContent = run ? formatRunHistoryLabel(run) : logsHistorySelectedAt;
}

function toggleRunHistoryPicker(ev) {
  if (ev) ev.stopPropagation();
  const popup = document.getElementById('rhpPopup');
  if (!popup) return;
  if (popup.style.display === 'none' || !popup.style.display) {
    // Opening — refresh the list so we see any runs that finished while
    // the popup was closed.
    refreshRunHistoryList().then(() => { popup.style.display = 'block'; });
  } else {
    popup.style.display = 'none';
  }
}

function closeRunHistoryPicker() {
  const popup = document.getElementById('rhpPopup');
  if (popup) popup.style.display = 'none';
}

// One-time global click-outside handler installed at script init.
if (typeof window !== 'undefined' && !window.__rhpClickOutsideInstalled) {
  window.__rhpClickOutsideInstalled = true;
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('runHistoryPicker');
    if (picker && !picker.contains(e.target)) closeRunHistoryPicker();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeRunHistoryPicker(); cancelRunPicker(); }
  });
}

// Option-click handler. Empty at → resume live polling. Non-empty →
// fetch that historical entry's full log and render it read-only.
async function selectRunHistoryOption(at) {
  logsHistorySelectedAt = at;
  closeRunHistoryPicker();
  syncRunHistoryTrigger();
  const body = document.getElementById('logsBody');
  const count = document.getElementById('logsCount');
  if (!at) {
    // Back to Live — reset offset and resume polling from the current point.
    logsTabOffset = 0;
    if (body) body.innerHTML = '<div class="logs-empty">Resuming live view…</div>';
    stopLogsTabPoll();
    pollLogsTab();
    return;
  }
  // Historical fetch — single shot, no polling.
  stopLogsTabPoll();
  try {
    const r = await api('GET', '/runs/' + encodeURIComponent(at));
    if (body) body.innerHTML = '';
    const lines = (r && r.log) || [];
    lines.forEach(l => {
      const div = document.createElement('div');
      div.className = 'line ' + (l.type || '');
      const t = (l.time && String(l.time).slice(11, 19)) || '';
      const timeSpan = t ? '<span class="time">' + t + '</span> ' : '';
      div.innerHTML = timeSpan + escapeHtml(l.text || '');
      body.appendChild(div);
    });
    if (count) count.textContent = lines.length + ' line' + (lines.length === 1 ? '' : 's') + ' (history)';
    body.scrollTop = 0;
  } catch (err) {
    if (body) body.innerHTML = '<div class="logs-empty">Failed to load history entry: ' + escapeHtml(err && err.message || 'unknown') + '</div>';
  }
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
  if (state.runStatus === 'running' || state.runStatus === 'stopping') return 3;
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
  const isStopping = state.runStatus === 'stopping';
  const disabled = busy || !!state.activeBrowser || isRunning || isStopping;
  btnCheckAll.disabled = disabled;
  btnRunAll.disabled = disabled && !isRunning;

  if (isRunning) {
    btnRunAll.textContent = 'Stop Scripts';
    btnRunAll.className = 'btn btn-stop';
    btnRunAll.disabled = false;
    btnRunAll.onclick = stopRun;
  } else if (isStopping) {
    // Stop was clicked but the child subtree is still draining (Chromium
    // takes a few seconds to release /fgc/data/browser). Keep the button
    // visually in "stop" colors and disabled — clicking again wouldn't
    // do anything useful, and flipping to "Run Now" while runProcess is
    // still truthy would let the user trigger an immediately-rejected
    // request (server's browserBusy mutex catches it, but the UX is
    // confusing).
    btnRunAll.textContent = 'Stopping...';
    btnRunAll.className = 'btn btn-stop';
    btnRunAll.disabled = true;
    btnRunAll.onclick = null;
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
  // Prefer the ISO timestamps so cross-TZ relative-time math is accurate.
  // Naked server-local strings (the *Iso-less fallbacks) get parsed as
  // browser-local by JS Date, which is off by the TZ offset for users
  // whose browser TZ differs from server TZ.
  if (!isRunning && (state.nextScheduledRunIso || state.nextScheduledRun)) {
    secondaryParts.push('Next run ' + formatTimestamp(state.nextScheduledRunIso || state.nextScheduledRun, 'relative'));
  }
  if (state.lastRun) {
    const dur = state.lastRun.durationSec != null ? Math.round(state.lastRun.durationSec / 60) + 'm' : '';
    secondaryParts.push('Last run ' + formatTimestamp(state.lastRun.atIso || state.lastRun.at, 'relative') + ' (' + state.lastRun.status + (dur ? ', ' + dur : '') + ')');
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

  // Update-available pill in the header (issue #39). state.updateAvailable
  // is null when checks are disabled, GitHub returned no newer release,
  // or the poll hasn't completed yet — pill stays hidden in those cases.
  const updatePill = document.getElementById('updatePill');
  if (updatePill) {
    if (state.updateAvailable && state.updateAvailable.latest) {
      const ua = state.updateAvailable;
      updatePill.style.display = 'inline-flex';
      updatePill.textContent = 'v' + (ua.current || '?') + ' → ' + ua.latest + ' available';
      updatePill.href = ua.releaseUrl || 'https://github.com/feldorn/free-games-claimer/releases';
    } else {
      updatePill.style.display = 'none';
    }
  }

  // Headless one-shot banner — shows on every tab whenever RUN_ON_STARTUP=2
  // is the effective config. The container will exit after the boot run
  // completes, so the panel goes away — make sure the user sees this
  // before navigating into something that depends on the panel staying up.
  const headlessBanner = document.getElementById('headlessBanner');
  if (headlessBanner) {
    if (state.runOnStartup === 2) {
      headlessBanner.style.display = 'flex';
      const running = state.runStatus === 'running';
      const headline = running
        ? 'One-shot mode — claim run in progress, container will exit when it finishes'
        : 'One-shot mode active (RUN_ON_STARTUP=2) — container will exit after the next claim run';
      headlessBanner.innerHTML =
        '<span class="hb-icon">⚠</span>' +
        '<span class="hb-text">' + escapeHtml(headline) +
          '<small>To revert: edit data/config.json and remove scheduler.runOnStartup, or change Settings → Schedule before the run completes. The panel will be unreachable until something restarts the container.</small>' +
        '</span>';
    } else {
      headlessBanner.style.display = 'none';
    }
  }

  // Diagnostics banner — appears when there's an undecided error
  // fingerprint AND the user hasn't clicked Never Share. Three actions:
  // Share opens the prefilled GitHub URL + marks decided; Don't Share
  // marks dismissed (per-fingerprint, never re-prompts for this one);
  // Never Share flips the global enabled=false (silences ALL future
  // banners, Settings tab can re-enable).
  const diagBanner = document.getElementById('diagBanner');
  if (diagBanner) {
    const diag = state.diagnostics;
    if (diag && diag.enabled && diag.pending) {
      const p = diag.pending;
      diagBanner.style.display = 'flex';
      const summary = (p.errorClass || 'Error') + ': ' + (p.message || '').slice(0, 120);
      diagBanner.innerHTML =
        '<span class="db-icon">⚙</span>' +
        '<span class="db-text">Encountered an error in <b>' + escapeHtml(p.script || 'unknown') + '</b>. Share to help improve the project?' +
          '<small>' + escapeHtml(summary) + '</small>' +
        '</span>' +
        '<div class="db-actions">' +
          '<button class="db-share" data-diag-fp="' + escapeHtml(p.fingerprint) + '" data-diag-act="share" title="Open a pre-filled GitHub issue in a new tab — you can review and edit the body before submitting">Share</button>' +
          '<button class="db-skip"  data-diag-fp="' + escapeHtml(p.fingerprint) + '" data-diag-act="dismiss" title="Dismiss just this error — same error won\\'t re-prompt">Don\\'t Share</button>' +
          '<button class="db-never" data-diag-act="never" title="Turn off the error-report banner entirely. Settings → Notifications can re-enable.">Never Share</button>' +
        '</div>';
    } else {
      diagBanner.style.display = 'none';
    }
  }

  // Split sites into active (main grid) and inactive (drawer below).
  // Sort each group alphabetically by name so the visual order is stable
  // and predictable across all card groupings on the Sessions tab.
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
  const activeCards = state.sites.filter(s => s.active !== false).slice().sort(byName);
  const inactiveCards = state.sites.filter(s => s.active === false).slice().sort(byName);

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
    // Site-link target needs both target="_blank" (open in new tab when
    // the panel is at top-level) AND target="_top" (navigate the parent
    // tab when iframed inside Organizr / similar). The latter is the
    // only way to escape iframe-sandbox context for destinations that
    // send strict cross-origin-isolation headers — Epic, Microsoft
    // Rewards, Steam all set CORP/COEP/COOP same-origin, which combined
    // with iframe sandbox produces ERR_BLOCKED_BY_RESPONSE even with
    // allow-popups-to-escape-sandbox. Plain anchor with target="_top"
    // tagged uses an onclick handler that picks the right target at
    // click time based on whether we're framed.
    const extLinkIcon = s.siteUrl
      ? '<a class="site-card-extlink" href="' + escapeHtml(s.siteUrl) + '" onclick="return openSiteUrl(this)" target="_blank" title="Open ' + escapeHtml(s.name) + ' (replaces tab if inside Organizr; middle-click for new tab)" aria-label="Open ' + escapeHtml(s.name) + '">↗</a>'
      : '';
    return '<div class="site-card">' +
      '<div class="site-card-header">' +
        '<div class="dot ' + dotClass + '"></div>' +
        '<div class="name">' + s.name + '</div>' +
        versionLabel +
        extLinkIcon +
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
  // Sort watchers alphabetically by name to match the active/available
  // cards above (consistent ordering across all Sessions card groupings).
  const watchers = (state.watchers || []).slice().sort(byName);
  if (watcherEl) {
    if (watchers.length === 0 || sessionsCollapsed) {
      watcherEl.style.display = 'none';
      watcherEl.innerHTML = '';
    } else {
      watcherEl.style.display = 'block';
      const watcherCardsHtml = watchers.map(w => {
        const versionLabel = w.version ? '<div class="site-card-version">v' + escapeHtml(w.version) + '</div>' : '';
        const extLinkIcon = w.siteUrl
          ? '<a class="site-card-extlink" href="' + escapeHtml(w.siteUrl) + '" onclick="return openSiteUrl(this)" target="_blank" title="Open ' + escapeHtml(w.name) + ' (replaces tab if inside Organizr; middle-click for new tab)" aria-label="Open ' + escapeHtml(w.name) + '">↗</a>'
          : '';
        // Lenovo Gaming surfaces its tracked drops inline — status pill,
        // title, countdown, "Got it" toggle, ↗ link per drop. Other
        // watchers stay simple: just "Watch-only" + Run.
        let bodyHtml = '<div class="status">Watch-only</div>';
        if (w.id === 'lenovo-gaming') {
          const lg = state.lenovoGaming || { drops: [] };
          // Filter to user-actionable drops: not ended, not user-collected.
          // Sort: active first (no scheduledAt), then coming-soon ascending by schedule.
          const actionable = (lg.drops || [])
            .filter(d => d.status !== 'ended' && d.status !== 'expired' && d.status !== 'postponed' && !d.userCollected)
            .sort((a, b) => {
              if (a.status === 'active' && b.status !== 'active') return -1;
              if (b.status === 'active' && a.status !== 'active') return 1;
              const at = a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0;
              const bt = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0;
              return at - bt;
            });
          if (actionable.length) {
            const dropsHtml = actionable.map(d => {
              let pillClass = 'soon', pillText = 'Coming soon';
              if (d.status === 'active') { pillClass = d.isRestocked ? 'restock' : 'live'; pillText = d.isRestocked ? 'Restocked' : 'Live now'; }
              let timeText = '';
              if (d.scheduledAt) {
                const ts = new Date(d.scheduledAt).getTime();
                if (Number.isFinite(ts)) {
                  const local = new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                  timeText = local + formatCountdown(ts);
                }
              }
              const cleanTitle = d.title.replace(/^\((Coming Soon|Postponed|Ended|Expired|Restocked!?)\)\s*/i, '');
              // Title is a link to the drop page (clicking jumps to the
              // collection site, same as the ↗ icon). Two clickable surfaces
              // for the same target — bigger touch area + clearer affordance.
              return '<div class="lenovo-drop">' +
                '<span class="lenovo-pill ' + pillClass + '">' + escapeHtml(pillText) + '</span>' +
                '<a class="lenovo-title" href="' + escapeHtml(d.url) + '" onclick="return openSiteUrl(this)" target="_blank" title="' + escapeHtml(d.title) + '">' + escapeHtml(cleanTitle) + '</a>' +
                (timeText ? '<span class="lenovo-time">' + escapeHtml(timeText) + '</span>' : '') +
                '<a class="lenovo-go" href="' + escapeHtml(d.url) + '" onclick="return openSiteUrl(this)" target="_blank" title="Open drop page" aria-label="Open drop page">↗</a>' +
                '<button class="lenovo-collected" onclick="markLenovoCollected(\\'' + escapeHtml(d.id) + '\\')" title="Mark as collected (suppresses pre-claim notifications)">Got it</button>' +
              '</div>';
            }).join('');
            bodyHtml = '<div class="lenovo-drops">' + dropsHtml + '</div>';
          } else {
            bodyHtml = '<div class="status">No active or upcoming drops</div>';
          }
        }
        return '<div class="site-card watcher">' +
          '<div class="site-card-header">' +
            '<div class="name">' + escapeHtml(w.name) + '</div>' +
            versionLabel +
            extLinkIcon +
          '</div>' +
          bodyHtml +
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
  // NOVNC_URL env override (issue #20) for users whose reverse proxy
  // serves noVNC at a different host/path than the panel — e.g.
  // browser.example.com instead of fgc.example.com:6080. Should point
  // at the directory containing vnc.html (we append the file + query).
  if (NOVNC_URL) {
    return NOVNC_URL.replace(/\\/+$/, '') + '/vnc.html?autoconnect=true&resize=scale';
  }
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
        // See parallel comment in the Logs-tab render: hard space after
        // the time span keeps copy-pasted plaintext readable; null time
        // omits the span entirely for structural === / ─── lines.
        const timeSpan = l.time ? '<span class="time">' + String(l.time).slice(11, 19) + '</span> ' : '';
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
    // Pending-redeem counts are now folded into /api/state (issue #17).
    // Keep the standalone pendingGogCount / pendingSteamCount module
    // variables in sync so the existing render paths that read them
    // (Sessions tab batch-redeem badge, etc.) don't need to change.
    if (typeof state.pendingGogCount === 'number') pendingGogCount = state.pendingGogCount;
    if (typeof state.pendingSteamCount === 'number') pendingSteamCount = state.pendingSteamCount;
    render();
    if (typeof updateBatchPolling === 'function') updateBatchPolling();
    applyUrlFocus();
  } catch {}
}

// External-link click handler. Honors the panel.externalLinkMode
// setting from /api/state. Three modes:
//   - 'auto' (default): iframed → break out via window.top, top-level
//     → let target="_blank" do its thing (new tab).
//   - 'same-tab':       always navigate the top window. Replaces the
//     dashboard if iframed; replaces the panel if top-level. Lets the
//     user prefer same-tab regardless of context.
//   - 'new-tab':        always force target="_blank" semantics.
//
// Background on auto-mode: when the panel is iframed inside Organizr
// (or similar), Chromium's iframe-sandbox interactions with
// cross-origin-isolation headers (CORP/COEP/COOP same-origin) on
// destinations like Epic / MS Rewards / Steam cause new-tab navigation
// to fail with ERR_BLOCKED_BY_RESPONSE even with
// allow-popups-to-escape-sandbox set. Top-nav breaks free of the
// iframe entirely. Middle-click still uses the browser's native new-
// tab mechanism (independent of this handler) and works regardless.
function openSiteUrl(linkEl) {
  const mode = (state && state.externalLinkMode) || 'auto';
  if (mode === 'same-tab') {
    const url = linkEl.href;
    try { (window.top || window).location.href = url; return false; }
    catch { return true; }
  }
  if (mode === 'new-tab') {
    return true; // let target="_blank" do its thing in any context
  }
  // 'auto': iframed → top-nav, else default-blank.
  if (window.self === window.top) return true;
  const url = linkEl.href;
  try { window.top.location.href = url; }
  catch { return true; }
  return false;
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

// Lenovo Gaming: toggle a drop's userCollected flag. Suppresses the pre-claim
// 1h/5min/wentLive wakes for that drop so the user doesn't get notified about
// something they've already grabbed. Restock notifications continue regardless
// since restock = new key pool. The state is server-side; this just POSTs.
async function markLenovoCollected(dropId) {
  try {
    const r = await api('POST', '/lenovo/drops/' + encodeURIComponent(dropId) + '/collected');
    if (r && r.success === false) {
      showToast(r.error || 'Failed to mark collected', 'error', 4000);
      return;
    }
    showToast('Marked collected — pre-claim notifications suppressed.', 'success', 3000);
    await refreshState();
  } catch (e) { showToast('Error: ' + e.message, 'error'); }
}

// "Run Now" no longer fires immediately — it opens a picker so the user
// can include/exclude services per run (especially MS Rewards, which the
// historical CLAIM_CMD_MANUAL excluded by default because of its 30-45
// minute search-paced runtime). #32.
function runAll() { openRunPicker(); }

function openRunPicker() {
  const modal = document.getElementById('runPickerModal');
  const body = document.getElementById('runPickerBody');
  if (!modal || !body || !state || !Array.isArray(state.sites)) return;

  // state.sites only includes login-having services (checkLogin set).
  // Watchers come from state.watchers (already filtered to active).
  // Combine both into a single list for the picker; tag any state.watchers
  // entry as watch-only so the categorizer below routes it correctly.
  const sitesActive = state.sites.filter(s => s.active !== false);
  const watchers = (Array.isArray(state.watchers) ? state.watchers : [])
    .map(w => ({ ...w, scheduleKind: 'watch-only', active: true }));
  const active = sitesActive.concat(watchers);

  // Categorize using the same rule getServiceRows uses server-side:
  //   watch-only      → 'watch'
  //   microsoft* / ae → 'points'
  //   else            → 'game'
  // scheduleKind comes from state.sites (added 2.5.3-ish).
  const groups = { game: [], points: [], watch: [] };
  active.forEach(s => {
    const cat = s.scheduleKind === 'watch-only' ? 'watch'
      : (s.id === 'aliexpress' || (s.id || '').indexOf('microsoft') === 0) ? 'points'
      : 'game';
    groups[cat].push(s);
  });
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
  Object.values(groups).forEach(g => g.sort(byName));

  // Defaults: everything checked EXCEPT microsoft + microsoft-mobile.
  // That mirrors CLAIM_CMD_MANUAL's behavior so users who hit Run Now
  // without touching the picker get the same outcome as before. Users
  // who want MS in their manual run check the box.
  const isMs = id => id === 'microsoft' || id === 'microsoft-mobile';
  const hintFor = id => isMs(id) ? '~30-45 min' : '';

  const renderGroup = (title, items) => {
    if (!items.length) return '';
    let html = '<div class="rp-group"><div class="rp-group-title">' + escapeHtml(title) + '</div>';
    items.forEach(s => {
      const checked = !isMs(s.id);
      const hint = hintFor(s.id);
      html += '<label class="rp-row">' +
        '<input type="checkbox" data-site-id="' + escapeHtml(s.id) + '"' + (checked ? ' checked' : '') + '>' +
        '<span class="rp-name">' + escapeHtml(s.name || s.id) + '</span>' +
        (hint ? '<span class="rp-hint">' + escapeHtml(hint) + '</span>' : '') +
        '</label>';
    });
    html += '</div>';
    return html;
  };

  let html = '';
  html += renderGroup('Claimers', groups.game.filter(s => s.id !== 'aliexpress'));
  // AliExpress is daily-chain but conceptually a points collector; show it with MS.
  const pointsGroup = groups.points.concat(groups.game.filter(s => s.id === 'aliexpress'));
  pointsGroup.sort(byName);
  html += renderGroup('Point / coin collectors', pointsGroup);
  html += renderGroup('Watchers', groups.watch);
  if (!html) html = '<div class="logs-empty" style="padding:12px">No active services. Enable some in Settings → Services first.</div>';
  html += '<div class="rp-shortcuts">' +
    '<button type="button" onclick="rpSelectAll(true)">Select all</button>' +
    '<button type="button" onclick="rpSelectAll(false)">Select none</button>' +
    '</div>';

  body.innerHTML = html;
  modal.style.display = 'flex';
}

function cancelRunPicker() {
  const modal = document.getElementById('runPickerModal');
  if (modal) modal.style.display = 'none';
}

function rpBackdropClick(e) {
  if (e && e.target && e.target.id === 'runPickerModal') cancelRunPicker();
}

function rpSelectAll(checked) {
  const boxes = document.querySelectorAll('#runPickerBody input[type="checkbox"]');
  boxes.forEach(b => { b.checked = checked; });
}

async function confirmRunPicker() {
  const boxes = document.querySelectorAll('#runPickerBody input[type="checkbox"]:checked');
  const sites = Array.from(boxes).map(b => b.dataset.siteId).filter(Boolean);
  if (!sites.length) {
    showToast('Pick at least one service to run.', 'error');
    return;
  }
  cancelRunPicker();
  busy = true; render();
  try {
    const r = await api('POST', '/run-all', { sites });
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
  await refreshState();
  updateBatchPolling();
  await handleDeepLink();
}
initialLoad();

// Background poll that keeps Sessions cards / Schedule countdown / etc.
// in sync with server state. Pending-redeem counts are folded into
// /api/state since 2.3.14 (issue #17), so this is now a single request
// per tick. Pauses entirely when the tab is hidden — no point polling
// a panel the user isn't looking at — and resumes with an immediate
// refresh on visibility-change so re-focused tabs are never stale.
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await refreshState();
    updateBatchPolling();
  }, 10000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopPolling();
  } else {
    refreshState().then(() => updateBatchPolling()).catch(() => {});
    startPolling();
  }
});
// Restore active tab from localStorage before first paint — covers
// browser-back from an iframe-busted external link returning the user
// to the tab they came from, regardless of whether the panel is at
// top-level or embedded in a dashboard iframe.
_initTabFromStorage();
if (document.visibilityState !== 'hidden') startPolling();
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

    // Unauthenticated health probe for the Docker HEALTHCHECK and any
    // external monitoring (Uptime Kuma, NPM, etc.). Pointing the
    // healthcheck at /api/state breaks once PANEL_PASSWORD is set —
    // it returns 401 and the orchestrator marks the container
    // unhealthy even though the panel is fine. This endpoint stays
    // open: it returns 200 + a tiny JSON body if the HTTP server is
    // accepting requests, which is what a healthcheck actually needs.
    // No state is exposed beyond "the process is alive".
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true }));
      return;
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

    // Match the root path regardless of query string. Used to be
    // strict-equal req.url === '/', which 404'd on /?focus=captcha and
    // /?login=gog deep-links from notification pushes (and the browser
    // helpfully offered to download the empty 404 body since it had no
    // Content-Type — caught 2026-05-17). Strip the query string off
    // req.url for the path check.
    const reqPath = req.url ? req.url.split('?')[0] : '';
    if (!isAuthenticated(req)) {
      if (req.method === 'GET' && (reqPath === '/' || reqPath === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(LOGIN_HTML);
        return;
      }
      sendJson(res, { error: 'Unauthorized' }, 401);
      return;
    }

    if (req.method === 'GET' && (reqPath === '/' || reqPath === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(PANEL_HTML);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/state') {
      sendJson(res, await getState());
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
      // Optional { sites: [...] } body lets the Run-Now picker fire a
      // tailored subset. Backward-compatible: no body = current behavior
      // (CLAIM_CMD_MANUAL semantics, MS excluded by default).
      let body = null;
      try { body = await parseBody(req); } catch { /* tolerate missing body */ }
      const sites = body && Array.isArray(body.sites)
        ? body.sites.filter(s => typeof s === 'string' && s)
        : null;
      await expireStaleActiveBrowser();
      const result = runAllScripts({ source: 'panel', sites: sites && sites.length ? sites : null });
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
        await expireStaleActiveBrowser();
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

    // Run-history endpoints (issue #29). /api/runs returns a list of
    // summaries (no log payload — fast for the dropdown). /api/runs/:at
    // returns the full record including the log array; the :at param is
    // the URL-encoded `at` timestamp from the summary list.
    if (req.method === 'GET' && req.url === '/api/runs') {
      const runs = (runHistoryDb && runHistoryDb.data && runHistoryDb.data.runs || [])
        .slice().reverse() // newest first
        .map(({ log, ...summary }) => summary);
      sendJson(res, { runs });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/runs/')) {
      const at = decodeURIComponent(req.url.slice('/api/runs/'.length).split('?')[0]);
      const all = (runHistoryDb && runHistoryDb.data && runHistoryDb.data.runs) || [];
      const found = all.find(r => r.at === at);
      if (!found) { sendJson(res, { error: 'not found' }, 404); return; }
      sendJson(res, found);
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

    // Discoveries — surface what FGF + GamerPower currently list, with
    // coverage status per entry, so the user can manually click through
    // to items we don't auto-claim (iOS giveaways, Itch.io, GOG promos,
    // etc.). Live fetch on each request; both APIs are public + fast.
    // Errors per source degrade gracefully — one source down doesn't
    // hide the other.
    if (req.method === 'GET' && req.url.startsWith('/api/discoveries') && (req.url === '/api/discoveries' || req.url.startsWith('/api/discoveries?'))) {
      // Cache short-circuit. Aggregator fetches (~800ms) are the slow
      // path; on a fresh panel reload where localStorage restored the
      // user to the Discoveries tab, this fetch fires synchronously
      // before first paint. Cache for 5 min so the second visit costs
      // <5ms. The Refresh button passes ?force=1 to bypass.
      const u = new URL(req.url, `http://${req.headers.host}`);
      const force = u.searchParams.get('force') === '1';
      if (!force && discResponseCache && (Date.now() - discResponseCache.builtAt) < DISC_CACHE_TTL_MS) {
        sendJson(res, discResponseCache.body);
        return;
      }
      // Lazy-init the user-state DB. Schema: { items: { <key>: { status, title, at } } }
      if (!discoveriesStateDb) discoveriesStateDb = await jsonDb('discoveries-state.json', { items: {} });
      if (!discoveriesStateDb.data || typeof discoveriesStateDb.data !== 'object') discoveriesStateDb.data = { items: {} };
      if (!discoveriesStateDb.data.items) discoveriesStateDb.data.items = {};

      // Load per-collector DBs in parallel with the aggregator fetches.
      // Wrapped in .catch so a missing DB file (first-run, fresh deploy)
      // degrades to an empty owned-set rather than a 500 — the user
      // still sees discoveries, they just won't get CLAIMED badges
      // until the relevant DB has entries.
      const safeDb = name => jsonDb(name, {}).then(d => d.data || {}).catch(() => ({}));
      const [gpRes, fgfRes, epicDb, steamDb, gogDb] = await Promise.allSettled([
        fetchGamerPowerGiveaways(),
        fetchFGFPosts(),
        safeDb('epic-games.json'),
        safeDb('steam.json'),
        safeDb('gog.json'),
      ]);
      const gpAll = gpRes.status === 'fulfilled' ? gpRes.value : [];
      const fgfAll = fgfRes.status === 'fulfilled' ? fgfRes.value : [];
      const gpError = gpRes.status === 'rejected' ? String(gpRes.reason?.message || gpRes.reason) : null;
      const fgfError = fgfRes.status === 'rejected' ? String(fgfRes.reason?.message || fgfRes.reason) : null;

      // Strip common edition-suffix tails AFTER normalizeTitle, so e.g.
      // "Sunderfolk - Standard Edition" (DB) and "Sunderfolk" (GamerPower)
      // both reduce to "sunderfolk" and match. Edition labels are the
      // dominant source of cross-source title drift — aggregators tend
      // to use the short marketing name while store DBs hold the full
      // SKU. Word-boundary anchored to the end so "Hades II" doesn't
      // accidentally match "Hades". (User report 2026-05-14 on
      // Sunderfolk showing AUTO instead of CLAIMED.)
      const stripEditionSuffix = s => s
        .replace(/\s+(standard|deluxe|premium|complete|definitive|ultimate|gold|special|anniversary|enhanced|collectors|collector|directors cut|game of the year|goty)(\s+edition)?$/, '')
        .replace(/\s+edition$/, '')
        .trim();
      const matchKey = s => stripEditionSuffix(normalizeTitle(s || ''));

      // Flatten per-user DBs into a single owned-titles set per store.
      // Each store DB shape is { <user>: { <gameId>: { title, status, ... } } }.
      // Two indices for lookups:
      //   ownedIds[store]    : Set of gameIds with status in {claimed, existed}
      //   ownedTitles[store] : Set of edition-stripped match keys
      // ID lookup is exact and fast — used when we can extract a slug or
      // appId from the URL. Title lookup is a fallback for GamerPower
      // entries (which don't expose a direct store URL on their public
      // API). Storing match keys (not raw normalised titles) means the
      // edition-suffix reduction happens once at index build, not on
      // every lookup.
      const buildOwnedIndex = (db) => {
        const ids = new Set();
        const titles = new Set();
        for (const games of Object.values(db || {})) {
          if (!games || typeof games !== 'object') continue;
          for (const [id, entry] of Object.entries(games)) {
            if (!entry || typeof entry !== 'object') continue;
            const status = String(entry.status || '');
            if (!/claimed|existed/i.test(status)) continue;
            ids.add(id);
            if (entry.title) titles.add(matchKey(entry.title));
          }
        }
        return { ids, titles };
      };
      const epicOwned = buildOwnedIndex(epicDb.status === 'fulfilled' ? epicDb.value : {});
      const steamOwned = buildOwnedIndex(steamDb.status === 'fulfilled' ? steamDb.value : {});
      const gogOwned = buildOwnedIndex(gogDb.status === 'fulfilled' ? gogDb.value : {});

      // Per-collector coverage state. Evaluated at request time so the
      // EG_MOBILE toggle and other live config reads correctly.
      const coverageFor = (collectorKey) => {
        if (!collectorKey) return { state: 'manual', label: 'No collector matches this platform — claim manually via the link' };
        switch (collectorKey) {
          case 'epic-games':        return { state: 'auto',   label: 'Auto-claimed by Epic collector' };
          case 'epic-games-mobile': return cfg.eg_mobile
            ? { state: 'auto',   label: 'Auto-claimed (EG_MOBILE enabled in Settings)' }
            : { state: 'manual', label: 'Enable Epic mobile games in Settings to auto-claim — or claim manually' };
          case 'steam':             return { state: 'auto',   label: 'Auto-claimed by Steam collector' };
          case 'gog':               return { state: 'notify', label: 'Notify-only — claim manually via the link (GOG claim UIs vary)' };
          case 'itch-io':           return { state: 'manual', label: 'Itch.io — claim manually via the link' };
          case 'indiegala':         return { state: 'manual', label: 'IndieGala — claim manually via the link' };
          case 'stove':             return { state: 'manual', label: 'STOVE storefront — claim manually via the link' };
          case 'prime-gaming':      return { state: 'manual', label: 'Prime collector handles discovery directly — listed here for awareness' };
          case 'ubisoft':           return { state: 'manual', label: 'Ubisoft watcher handles discovery directly — listed here for awareness' };
          case 'mobile':            return { state: 'manual', label: 'Mobile platform — claim via the App Store / Play Store' };
          case 'console':           return { state: 'manual', label: 'Console giveaway — claim through the platform store on your console' };
          case 'vr':                return { state: 'manual', label: 'VR-platform giveaway — claim through the VR storefront' };
          default:                  return { state: 'manual', label: 'Click to claim manually' };
        }
      };

      // Promote `auto` → `claimed` when the item is already in the
      // relevant store's claim DB. Doesn't touch `notify` (GOG) or
      // `manual` items — claimed-ness for those is uncertain (we don't
      // run the claim path for them, so the DB may not be authoritative).
      const promoteIfOwned = (coverage, collectorKey, url, title) => {
        if (coverage.state !== 'auto') return coverage;
        const isOwned = (() => {
          const key = matchKey(title || '');
          if (collectorKey === 'epic-games' || collectorKey === 'epic-games-mobile') {
            // Epic URL → slug = last path segment. Both /p/<slug> and
            // /p/<slug>?lang=… formats land in the DB under that slug.
            try {
              const u = new URL(url);
              const slug = u.pathname.split('/').filter(Boolean).pop();
              const slugWithQuery = u.search ? slug + u.search : slug;
              if (epicOwned.ids.has(slug)) return true;
              if (epicOwned.ids.has(slugWithQuery)) return true;
            } catch {}
            return key && epicOwned.titles.has(key);
          }
          if (collectorKey === 'steam') {
            const m = /\/app\/(\d+)/.exec(url || '');
            if (m && steamOwned.ids.has(m[1])) return true;
            return key && steamOwned.titles.has(key);
          }
          return false;
        })();
        if (!isOwned) return coverage;
        return { state: 'claimed', label: 'Already in your library — surfaced here for awareness' };
      };

      // Steam configures two skip thresholds — min price and min rating.
      // The Steam claim path enforces both (steam.js:432, :438). We can
      // forecast the price skip here from GamerPower's `worth` field,
      // so the Discoveries badge tells the user "AUTO won't actually
      // fire — your settings will skip this" before the next run. We
      // can't forecast the rating skip without scraping the Steam page,
      // so leave rating-based skips invisible — they'll show as AUTO
      // and then skip at runtime.
      const steamMinPrice = Number(cfg.steam_min_price) || 0;
      const parseWorth = w => {
        const m = /\$?\s*(\d+(?:\.\d+)?)/.exec(String(w || ''));
        return m ? parseFloat(m[1]) : NaN;
      };
      // Returns updated coverage; passes through unchanged if not Steam
      // or no actionable skip applies. `details.skipFields` flags which
      // chip in the UI to highlight (the price chip turns red when
      // skipReason==='price').
      const forecastSkip = (coverage, collectorKey, worth) => {
        if (coverage.state !== 'auto' || collectorKey !== 'steam') return coverage;
        const w = parseWorth(worth);
        if (!Number.isFinite(w) || w >= steamMinPrice) return coverage;
        return {
          state: 'skip',
          label: `Your Steam minimum price is $${steamMinPrice} — this is $${w.toFixed(2)}, so the next run will skip it. Lower the threshold in Settings → Services → Steam, or claim manually via the link.`,
          skipReason: 'price',
          skipFields: ['worth'],
        };
      };

      // For GamerPower titles like "Devil's Island (Epic Games) Giveaway",
      // strip the trailing platform tag + "Giveaway" so title-match against
      // store DBs works. FGF cleaned titles already drop the bracket prefix.
      const stripGpTail = t => String(t || '').replace(/\s*\([^)]+\)\s*Giveaway\b.*$/i, '').trim();

      // Cross-source price index. GamerPower entries carry a `worth`
      // field but FGF posts don't — Reddit doesn't aggregate price
      // metadata. Without bridging the gap, the same skipped game
      // shows AUTO in the FGF section and SKIP in the GamerPower
      // section. Build a title→worth map from GP entries; FGF entries
      // matching by edition-stripped key inherit the price for both
      // display (meta line) and forecasting (forecastSkip). 2026-05-14:
      // user reported the inconsistency on Terrors to Unveil ($4.99
      // Steam, below their $10 threshold).
      const priceByKey = new Map();
      for (const e of gpAll) {
        if (!e || !e.worth || e.worth === 'N/A' || e.worth === '$0.00') continue;
        const k = matchKey(stripGpTail(e.title));
        if (k && !priceByKey.has(k)) priceByKey.set(k, e.worth);
      }

      // Dedup-key + user-state merge helpers. The key is `${collector}::${matchKey(title)}`
      // — stable across both aggregators so the same game gets the same key
      // regardless of whether it surfaced via GP or FGF. User-state mutations
      // POST this key back. promoteUserState transforms the coverage when
      // the user has marked the item: 'ignored' takes precedence over any
      // automatic state (it's an explicit dismiss); 'manually-claimed'
      // promotes to a CLAIMED variant.
      const userStates = discoveriesStateDb.data.items;
      const buildKey = (collectorKey, title) => `${collectorKey || 'other'}::${matchKey(title || '')}`;
      const promoteUserState = (coverage, key) => {
        const us = userStates[key];
        if (!us) return { coverage, userState: null };
        if (us.status === 'ignored') {
          return {
            coverage: { state: 'ignored', label: 'You ignored this. Use the undo button to restore.' },
            userState: { status: 'ignored', at: us.at },
          };
        }
        if (us.status === 'manually-claimed') {
          return {
            coverage: { state: 'claimed', label: 'Marked as manually-claimed by you. Use the undo button if this was accidental.', userMarked: true },
            userState: { status: 'manually-claimed', at: us.at },
          };
        }
        return { coverage, userState: null };
      };

      // FGF: title prefix is the canonical platform signal. Iterate the
      // pattern map in collector-key order; first match wins.
      const fgfItems = fgfAll.map(p => {
        let collectorKey = null;
        for (const [k, pat] of Object.entries(FGF_COLLECTOR_PATTERNS)) {
          if (pat.test(p.title)) { collectorKey = k; break; }
        }
        const tag = (/^\[([^\]]+)\]/.exec(p.title) || [])[1] || null;
        const title = fgfCleanTitle(p.title);
        // Inherit worth from GamerPower if the same title is listed
        // there (priceByKey is title-keyed). Lets the skip forecast
        // fire on FGF Steam entries too — without this, FGF showed
        // AUTO for the same game GamerPower correctly flagged as SKIP.
        const worth = priceByKey.get(matchKey(title)) || null;
        let coverage = coverageFor(collectorKey);
        coverage = promoteIfOwned(coverage, collectorKey, p.url, title);
        coverage = forecastSkip(coverage, collectorKey, worth);
        // "ReadComments" flair class = key is randomly distributed in the
        // Reddit comments thread, not on the external page. The post.url
        // points at the redeem endpoint (e.g. nvidia.com/redeem) which is
        // useless without first grabbing a key from the comments. Swap
        // the row's link target to the Reddit post and update the label.
        // (Caught 2026-05-15 on HITMAN Purple Streak NVIDIA giveaway.)
        let displayUrl = p.url;
        if (p.flairClass === 'ReadComments') {
          displayUrl = p.postUrl;
          coverage = { state: coverage.state, label: 'Key is randomly distributed in the Reddit comments — open the thread, grab a key, then redeem at ' + p.url };
        }
        const dedupKey = buildKey(collectorKey, title);
        const promoted = promoteUserState(coverage, dedupKey);
        return {
          title,
          rawTitle: p.title,
          tag,
          url: displayUrl,
          storeUrl: p.url,
          postUrl: p.postUrl,
          flair: p.flair,
          flairClass: p.flairClass,
          score: p.score,
          createdUtc: p.createdUtc,
          worth,
          collectorKey,
          dedupKey,
          userState: promoted.userState,
          coverage: promoted.coverage,
        };
      });

      // GamerPower: platforms is a comma-list. Primary match is platforms
      // string; title-parenthetical fallback handles cases where platforms
      // is just a generic "PC" (most IndieGala/Stove/Itch.io entries).
      const gpItems = gpAll.map(e => {
        let collectorKey = null;
        for (const [k, pat] of Object.entries(GP_COLLECTOR_PATTERNS)) {
          if (pat.test(e.platforms || '')) { collectorKey = k; break; }
        }
        if (!collectorKey) {
          // Extract "(Storefront)" from title and look up in hint map.
          const m = /\(([^)]+)\)\s*Giveaway\b/i.exec(e.title || '');
          if (m) {
            const norm = m[1].toLowerCase().replace(/[^a-z0-9]/g, '');
            if (GP_TITLE_HINTS[norm]) collectorKey = GP_TITLE_HINTS[norm];
          }
        }
        // Use `gamerpower_url` (public listing page) not `open_giveaway_url`
        // (CF-gated redirect). Direct fetch of the /open/ URL returns 403
        // — Cloudflare's bot mitigation rejects browsers that come in
        // cold without a session cookie established by clicking through
        // GamerPower's own UI first. The /…-giveaway listing page is
        // public, describes the offer, and has a working "Open Giveaway"
        // button that establishes the CF session correctly. (User report
        // 2026-05-14 — many Discoveries links erroring out.)
        const titleForMatch = stripGpTail(e.title);
        // Run promotions in order: owned check first (CLAIMED), then
        // skip forecast (SKIP). promoteIfOwned only fires when state is
        // 'auto'; if it lands at 'claimed', forecastSkip is a no-op.
        let coverage = coverageFor(collectorKey);
        coverage = promoteIfOwned(coverage, collectorKey, e.open_giveaway_url || '', titleForMatch);
        coverage = forecastSkip(coverage, collectorKey, e.worth);
        const dedupKey = buildKey(collectorKey, titleForMatch);
        const promoted = promoteUserState(coverage, dedupKey);
        return {
          title: e.title,
          url: e.gamerpower_url || e.open_giveaway_url,
          platforms: e.platforms,
          type: e.type,
          endDate: e.end_date,
          worth: e.worth,
          thumbnail: e.thumbnail,
          collectorKey,
          dedupKey,
          userState: promoted.userState,
          // GamerPower URL is the gamerpower listing, not the store URL,
          // so the URL-based lookup never hits — promoteIfOwned falls
          // back to the title index, which is why we strip the
          // "(Platform) Giveaway" tail before passing it in.
          coverage: promoted.coverage,
        };
      });

      // Auto-prune: drop user-state entries older than 14d that are no
      // longer present in either aggregator feed. Safety net so the
      // state file doesn't grow unbounded over years. Entries still in
      // the feed are kept regardless of age — those are the "I claimed
      // this and want it to stay hidden" markers, valuable on long-
      // running giveaways. Done synchronously per request because the
      // cost is tiny (object iteration + occasional file write).
      const liveKeys = new Set([...fgfItems, ...gpItems].map(it => it.dedupKey));
      const PRUNE_MS = 14 * 24 * 3600 * 1000;
      const nowMs = Date.now();
      let pruned = 0;
      for (const [k, v] of Object.entries(userStates)) {
        const ageMs = nowMs - new Date(v.at || 0).getTime();
        if (ageMs > PRUNE_MS && !liveKeys.has(k)) {
          delete userStates[k];
          pruned++;
        }
      }
      if (pruned > 0) {
        try { await discoveriesStateDb.write(); }
        catch (e) { console.warn(`[${datetime()}] discoveries-state prune write failed: ${e.message}`); }
      }

      const responseBody = {
        fetchedAt: new Date().toISOString(),
        sources: {
          gamerpower: { items: gpItems, error: gpError, total: gpItems.length },
          freegamefindings: { items: fgfItems, error: fgfError, total: fgfItems.length },
        },
      };
      // Stash for the cache short-circuit at the top of this handler.
      // Subsequent reads within DISC_CACHE_TTL_MS skip the aggregator
      // round-trip and the DB-fold and ship this body straight back.
      discResponseCache = { body: responseBody, builtAt: Date.now() };
      sendJson(res, responseBody);
      return;
    }

    // POST /api/discoveries/mark — set { status: 'ignored' | 'manually-claimed' }
    // for a given dedup key. Body: { key, status, title? }. Idempotent.
    if (req.method === 'POST' && req.url === '/api/discoveries/mark') {
      try {
        const body = await parseBody(req);
        const { key, status, title, url } = body || {};
        if (typeof key !== 'string' || !key) {
          sendJson(res, { success: false, error: 'missing key' }, 400);
          return;
        }
        if (status !== 'ignored' && status !== 'manually-claimed') {
          sendJson(res, { success: false, error: 'status must be "ignored" or "manually-claimed"' }, 400);
          return;
        }
        if (!discoveriesStateDb) discoveriesStateDb = await jsonDb('discoveries-state.json', { items: {} });
        if (!discoveriesStateDb.data) discoveriesStateDb.data = { items: {} };
        if (!discoveriesStateDb.data.items) discoveriesStateDb.data.items = {};
        discoveriesStateDb.data.items[key] = {
          status,
          title: typeof title === 'string' ? title : undefined,
          url: typeof url === 'string' && url ? url : undefined,
          at: new Date().toISOString(),
        };
        await discoveriesStateDb.write();
        // Invalidate the cached /api/discoveries response so the next
        // poll reflects the user-state change immediately. Without
        // this, the optimistic client-side update would be overwritten
        // by the stale cached body on next refresh.
        discResponseCache = null;
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
      return;
    }

    // POST /api/discoveries/unmark — remove the user-state entry for the
    // given dedup key. Body: { key }. Used by the Undo button on a
    // previously ignored / manually-claimed row. Idempotent (deleting
    // a missing key is a no-op success).
    if (req.method === 'POST' && req.url === '/api/discoveries/unmark') {
      try {
        const body = await parseBody(req);
        const { key } = body || {};
        if (typeof key !== 'string' || !key) {
          sendJson(res, { success: false, error: 'missing key' }, 400);
          return;
        }
        if (!discoveriesStateDb) discoveriesStateDb = await jsonDb('discoveries-state.json', { items: {} });
        if (!discoveriesStateDb.data) discoveriesStateDb.data = { items: {} };
        if (!discoveriesStateDb.data.items) discoveriesStateDb.data.items = {};
        if (discoveriesStateDb.data.items[key]) {
          delete discoveriesStateDb.data.items[key];
          await discoveriesStateDb.write();
          discResponseCache = null; // see mark endpoint for rationale
        }
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
      return;
    }

    // --- Diagnostics endpoints (phase 2) ----------------------------------
    // POST /api/diagnostics/decide — body { fingerprint, decision }
    // decision ∈ {'shared','dismissed'}. Per-fingerprint sticky choice;
    // future occurrences of the same fingerprint won't re-prompt the
    // banner. Idempotent — re-deciding with the same value is a no-op.
    if (req.method === 'POST' && req.url === '/api/diagnostics/decide') {
      try {
        await loadDiagnosticsDb();
        const body = await parseBody(req);
        const { fingerprint, decision } = body || {};
        if (typeof fingerprint !== 'string' || !fingerprint) {
          sendJson(res, { success: false, error: 'missing fingerprint' }, 400);
          return;
        }
        if (decision !== 'shared' && decision !== 'dismissed' && decision !== 'resolved') {
          sendJson(res, { success: false, error: 'decision must be "shared", "dismissed", or "resolved"' }, 400);
          return;
        }
        const entry = diagnosticsDb.data.errors[fingerprint];
        if (!entry) {
          sendJson(res, { success: false, error: 'unknown fingerprint' }, 404);
          return;
        }
        entry.decided = decision;
        entry.decidedAt = new Date().toISOString();
        await diagnosticsDb.write();
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
      return;
    }

    // POST /api/diagnostics/disable — flip the global enabled flag off
    // (the Never Share button). Banner never appears again until the
    // user re-enables via Settings → Notifications. Existing fingerprint
    // history is preserved — re-enable shows them in the Diagnostics tab.
    if (req.method === 'POST' && req.url === '/api/diagnostics/disable') {
      try {
        await loadDiagnosticsDb();
        diagnosticsDb.data.enabled = false;
        diagnosticsDb.data.disabledAt = new Date().toISOString();
        await diagnosticsDb.write();
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
      return;
    }

    // POST /api/diagnostics/enable — re-enable the banner. Used by the
    // Settings toggle in phase 3 to recover from an accidental Never Share.
    if (req.method === 'POST' && req.url === '/api/diagnostics/enable') {
      try {
        await loadDiagnosticsDb();
        diagnosticsDb.data.enabled = true;
        delete diagnosticsDb.data.disabledAt;
        await diagnosticsDb.write();
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
      return;
    }

    // GET /api/diagnostics/list — full error history for the Diagnostics tab.
    if (req.method === 'GET' && req.url === '/api/diagnostics/list') {
      try {
        await loadDiagnosticsDb();
        const errors = diagnosticsDb.data.errors || {};
        const rows = Object.entries(errors).map(([fingerprint, e]) => ({
          fingerprint,
          script: e.script || 'unknown',
          errorClass: e.errorClass || 'Error',
          message: e.message || '',
          stack: e.stack || '',
          context: e.context || null,
          count: e.count || 1,
          firstSeen: e.firstSeen || '',
          lastSeen: e.lastSeen || '',
          decided: e.decided || null,
          decidedAt: e.decidedAt || null,
        })).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
        sendJson(res, {
          enabled: diagnosticsDb.data.enabled !== false,
          disabledAt: diagnosticsDb.data.disabledAt || null,
          errors: rows,
        });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
      return;
    }

    // POST /api/diagnostics/delete — body { fingerprint }. Drops a single
    // error from history. Used by the row 🗑 button in the Diagnostics tab.
    if (req.method === 'POST' && req.url === '/api/diagnostics/delete') {
      try {
        await loadDiagnosticsDb();
        const { fingerprint } = await parseBody(req) || {};
        if (typeof fingerprint !== 'string' || !fingerprint) {
          sendJson(res, { success: false, error: 'missing fingerprint' }, 400);
          return;
        }
        delete diagnosticsDb.data.errors[fingerprint];
        await diagnosticsDb.write();
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
      return;
    }

    // POST /api/diagnostics/clear — wipes all error history (keeps the
    // enabled flag). Used after a release fixed known issues.
    if (req.method === 'POST' && req.url === '/api/diagnostics/clear') {
      try {
        await loadDiagnosticsDb();
        diagnosticsDb.data.errors = {};
        await diagnosticsDb.write();
        sendJson(res, { success: true });
      } catch (e) {
        sendJson(res, { success: false, error: e.message }, 500);
      }
      return;
    }
    // ---------------------------------------------------------------------

    if (req.method === 'POST' && req.url === '/api/stop-run') {
      if (runProcess) {
        // Signal the *process group* so SIGTERM reaches bash, the node
        // children, and any patchright Chromium descendants — not just
        // bash, which wouldn't forward mid-pipeline. Negative PID =
        // process group leader's PID; detached:true on spawn makes
        // child.pid the group leader.
        const targetPid = runProcess.pid;
        try { process.kill(-targetPid, 'SIGTERM'); }
        catch (e) { console.error(`[${datetime()}] stop-run: group SIGTERM failed (${e.code || e.message}); falling back to child SIGTERM`); runProcess.kill('SIGTERM'); }
        // Escalate to SIGKILL after a grace period. SIGTERM lets the
        // script unwind cleanly (the delay() in src/util.js now aborts
        // on signal, and Playwright operations bubble up when the
        // browser closes). 15 s is more than enough headroom for a
        // graceful exit; anything still running after that is hung.
        // The close handler clears runProcess, so by the time the
        // escalation timer fires the check below short-circuits if
        // the process already exited.
        setTimeout(() => {
          if (runProcess && runProcess.pid === targetPid) {
            console.warn(`[${datetime()}] stop-run: SIGTERM grace expired after 15s, escalating to SIGKILL (pid=${targetPid})`);
            try { process.kill(-targetPid, 'SIGKILL'); }
            catch (e) {
              try { runProcess.kill('SIGKILL'); } catch {}
            }
          }
        }, 15000).unref();
        runLog.push({ type: 'system', text: 'Scripts stopping — waiting for in-flight processes to exit cleanly...', time: datetime() });
        runStatus = 'stopping';
        // Deliberately do NOT clear runProcess here — the close handler
        // (see child.on('close', …) above) clears it once the bash
        // subtree has actually exited. Pre-clearing here was the root
        // cause of the 2026-05-14 chaos: it released the browserBusy
        // mutex while old Chromium instances were still holding the
        // userDataDir, letting a new run start and fight the old one
        // over /fgc/data/browser (`Target page, context or browser has
        // been closed` across every script that used patchright).
        captchaPending = null;
        sendJson(res, { success: true });
      } else {
        sendJson(res, { success: false, error: 'No scripts are running.' });
      }
      return;
    }

    // Lenovo Gaming: mark a drop as collected. Toggles userCollected,
    // suppresses pre-claim wakes (1h/5min/wentLive) so the user doesn't get
    // pinged about a drop they already grabbed. Restock notifications
    // continue regardless — restock = new key pool, fresh opportunity.
    {
      const m = req.url && req.method === 'POST' && req.url.match(/^\/api\/lenovo\/drops\/([^/]+)\/(collected|uncollected)$/);
      if (m) {
        const dropId = decodeURIComponent(m[1]);
        const action = m[2];
        const fresh = readLenovoState();
        const drop = fresh.drops?.[dropId];
        if (!drop) {
          sendJson(res, { success: false, error: 'Drop not found' }, 404);
          return;
        }
        drop.userCollected = action === 'collected';
        drop.userCollectedAt = drop.userCollected ? datetime() : null;
        fresh.drops[dropId] = drop;
        saveLenovoState(fresh);
        // saveLenovoState writes the file, which fs.watch picks up and fires
        // scheduler wakeups so the next-wake recomputes immediately.
        sendJson(res, { success: true, drop });
        return;
      }
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
  // Run-history DB load — issue #29. Failure here doesn't block boot;
  // the persistRunHistory helper checks for null and silently skips.
  try { runHistoryDb = await jsonDb('runs.json', { runs: [] }); }
  catch (e) { console.error(`[${datetime()}] failed to load runs.json: ${e.message}`); }

  // Hydrate in-memory `lastRun` from the persisted history so the
  // Schedule tab's "LAST RUN" tile doesn't read "None yet" after a
  // container restart. Picks the most recent record (history is
  // append-only, ordered oldest-first) and reconstitutes the same
  // shape the live run handlers produce. Without this, every boot
  // amnesically lost the last-run signal even though /api/runs
  // could happily list 50 prior runs. (User report 2026-05-17.)
  try {
    const runs = (runHistoryDb && runHistoryDb.data && runHistoryDb.data.runs) || [];
    const latest = runs.length ? runs[runs.length - 1] : null;
    if (latest) {
      lastRun = {
        at: latest.at,
        atIso: latest.atIso || null,
        source: latest.source || null,
        exitCode: latest.exitCode != null ? latest.exitCode : null,
        status: latest.status || (latest.exitCode === 0 ? 'success' : 'finished'),
        durationSec: latest.durationSec != null ? latest.durationSec : null,
        error: latest.error || undefined,
      };
    }
  } catch (e) { console.warn(`[${datetime()}] failed to hydrate lastRun from history: ${e.message}`); }

  // Scheduler state load — issue #32. Holds the last main-chain
  // completion timestamp so computeMainWakeMs can use it as an anchor
  // for bare-LOOP mode (no START_TIME). Without this persistence, every
  // panel restart resets the wake clock to "24h from now" and skips
  // days. Empty {} on first boot after upgrade is fine — the existing
  // sleep-from-now fallback in computeMainWakeMs handles that case.
  try { schedulerStateDb = await jsonDb('scheduler-state.json', {}); }
  catch (e) { console.error(`[${datetime()}] failed to load scheduler-state.json: ${e.message}`); }

  // Diagnostics / error-reporting DB load. Holds enabled flag (false
  // after user clicks Never Share) + per-fingerprint error records
  // with counts and decided state. Panel boot needs this loaded
  // BEFORE the first script can spawn, so scan handlers don't drop
  // hits during the auto-session-check warm-up.
  try { await loadDiagnosticsDb(); }
  catch (e) { console.error(`[${datetime()}] failed to load diagnostics-state.json: ${e.message}`); }

  console.log(`[${datetime()}] Free Games Claimer ${APP_VERSION ? 'v' + APP_VERSION + ' ' : ''}— panel + scheduler`);

  // Stale Chromium profile-lock sweep. Container restarts get a fresh
  // hostname assigned by Docker; any persistent profile dir written by
  // a previous container will have SingletonCookie referencing the old
  // hostname, which Chromium rejects on the next launch with "profile
  // is in use by another computer". Cleaning the lock files at panel
  // boot — before any script launches — guarantees a clean state. The
  // claim-script launch paths also call cleanProfileLocks defensively
  // for mid-session crashes. (Fix per feldorn#37 — Lifeng77X's
  // AliExpress profile-lock report.)
  try {
    const sweepDirs = [
      cfg.dir.browser,
      cfg.dir.browser + '-aliexpress',
      cfg.dir.browser + '-mobile',
      cfg.dir.browser + '-lenovo',
    ];
    let totalRemoved = 0;
    for (const d of sweepDirs) {
      const removed = cleanProfileLocks(d);
      if (removed.length) {
        console.log(`[${datetime()}] Cleared stale Chromium locks in ${d}: ${removed.join(', ')}`);
        totalRemoved += removed.length;
      }
    }
    if (!totalRemoved && cfg.debug) console.log(`[${datetime()}] Profile-lock sweep: no stale locks found.`);
  } catch (e) { console.warn(`[${datetime()}] Profile-lock sweep failed: ${e.message}`); }

  console.log(`[${datetime()}] Control panel: http://localhost:${PANEL_PORT}${BASE_PATH}`);
  if (cfg.public_url) console.log(`[${datetime()}] Public URL:    ${PUBLIC_URL}`);
  console.log(`[${datetime()}] noVNC viewer:  ${NOVNC_URL || `http://localhost:${NOVNC_PORT}${BASE_PATH ? ` (proxied at ${BASE_PATH}/novnc/)` : ''}`}`);
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
  // Headless one-shot / run-on-startup banner — printed before the
  // auto-check so anyone tailing logs sees the mode immediately, with
  // inline disable instructions (the UI is unreachable in mode 2 once
  // the run completes, so the log is the user's escape hatch).
  if (cfg.run_on_startup === 1 || cfg.run_on_startup === 2) {
    const exits = cfg.run_on_startup === 2;
    console.log(`[${datetime()}] ─── ${exits ? 'Headless one-shot mode (RUN_ON_STARTUP=2)' : 'Run-on-startup enabled (RUN_ON_STARTUP=1)'} ───`);
    console.log(`[${datetime()}]   ${exits ? 'The container will exit after the startup claim run completes.' : 'A claim run will fire once after the startup auto-check.'}`);
    console.log(`[${datetime()}]   To disable: set RUN_ON_STARTUP=0 in environment AND remove any`);
    console.log(`[${datetime()}]   scheduler.runOnStartup override from data/config.json (either source`);
    console.log(`[${datetime()}]   can independently force this mode — data/config.json wins when set).`);
    if (exits && !cfg.notify) {
      console.log(`[${datetime()}]   ⚠  NOTIFY is empty — no notifications will be sent before exit. You won't see what happened.`);
    }
    console.log(`[${datetime()}] ──────────────────────────────────────────────────`);
  }

  console.log(`[${datetime()}] Open the control panel URL in your browser.`);
  // Update-check loop (issue #39). Polls GitHub releases every 6h; sets
  // updateCheckCache so /api/state can surface a header pill when a
  // newer image is published. Disabled by env UPDATE_CHECK=0.
  if (UPDATE_CHECK_DISABLED) {
    console.log(`[${datetime()}] Update check: disabled (UPDATE_CHECK=0).`);
  } else {
    startUpdateCheckLoop();
  }

  console.log(`[${datetime()}] Auto-checking all sessions...`);
  const active = activeServices();
  // Walk active sites in alphabetical name order — matches the Sessions
  // grid card sort, so the boot-time progress indicator and the rendered
  // tile order line up. Falls back to id when name is missing.
  const siteIds = Object.keys(SITES)
    .filter(id => active.has(id))
    .sort((a, b) => (SITES[a].name || a).localeCompare(SITES[b].name || b, undefined, { sensitivity: 'base' }));
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
  lenovoSchedulerLoop().catch(err => {
    console.error(`[${datetime()}] Scheduler (Lenovo) crashed:`, err);
  });
  watchConfigForScheduler();
  watchLenovoStateForScheduler();

  // Run-on-startup trigger. Fires after the auto-check.
  //
  // Mode 1 (panel keeps running): runs the manual chain (CLAIM_CMD_MANUAL
  // — claimers + watchers, microsoft.js excluded). The MS scheduler stays
  // active and will fire microsoft.js at its proper window or via the
  // main-chain LOOP, so including MS in the startup run would just
  // cause a same-day double-run.
  //
  // Mode 2 (one-shot — container exits after run): runs the full chain
  // (CLAIM_CMD, source 'scheduler-startup' triggers manual=false) with
  // MS_SKIP_WINDOW=1 so microsoft.js doesn't sleep until its window —
  // this is MS's only chance to run before the container terminates.
  //
  // Both modes pass NOWAIT=1 so stale sessions fail fast (the boot path
  // can't handle interactive login prompts).
  //
  // When mode is 2, wait for the run to settle, log the exit banner with
  // disable hints (so anyone tailing logs sees the why), then exit.
  if (cfg.run_on_startup === 1 || cfg.run_on_startup === 2) {
    const opts = cfg.run_on_startup === 2
      ? { source: 'scheduler-startup', extraEnv: { MS_SKIP_WINDOW: '1' } }
      : { source: 'startup', extraEnv: { NOWAIT: '1' } };
    const r = runAllScripts(opts);
    if (!r || !r.success) {
      console.log(`[${datetime()}] Run-on-startup: skipped — ${r ? r.error : 'no run handle'}`);
      if (cfg.run_on_startup === 2) {
        console.log(`[${datetime()}] Headless one-shot: nothing to run, exiting.`);
        setTimeout(() => process.exit(0), 500);
      }
    } else if (cfg.run_on_startup === 2) {
      try { await runDone; } catch { /* errors already logged by runner */ }
      console.log(`[${datetime()}] ─── Headless one-shot complete — exiting ───`);
      console.log(`[${datetime()}]   To disable for the next start: set RUN_ON_STARTUP=0 in env`);
      console.log(`[${datetime()}]   AND remove any scheduler.runOnStartup override from`);
      console.log(`[${datetime()}]   data/config.json (data/config.json wins when set).`);
      console.log(`[${datetime()}] ──────────────────────────────────────────────`);
      // Small delay lets any in-flight notify() child processes flush
      // before we tear down the panel.
      setTimeout(() => process.exit(0), 1500);
    }
  }
});
