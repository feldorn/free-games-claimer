// PS Plus SESSION CAPTURE probe (2026-06-03) — proves the "Route A" idea:
// a HUMAN logs in by hand (real telemetry, solves any captcha/2FA), then we
// harvest the npsso token + full session cookies for later silent re-auth.
//
// Uses the SAME hardened patchright launch as the runner (WEBGL_HARDENING_ARGS,
// persistent context) so this matches production. The script does NOT type or
// click the login form — the user drives it entirely. We only poll for the
// signed-in cookie, then capture.
//
//   node test/ps-capture-session.js
// Browser window opens; log in by hand. Capture is written to data/.
// Uses a dedicated throwaway profile so it never touches the live one.

import { chromium } from 'patchright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// Import util FIRST (like the runner does) so the config/util chain initializes
// cfg before sites.js would — avoids the TDZ. cleanProfileLocks matches prod.
import { cleanProfileLocks } from '../src/util.js';

// Identical to src/sites.js:62 — the runner's full PS bot-detection stack is
// patchright (stealth fork) + these WebGL/GPU args + the persistent profile.
const WEBGL_HARDENING_ARGS = ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'];
const PROFILE_DIR = path.resolve('data/browser-playstation-capture');
const STATE_FILE  = path.resolve('data/ps-captured-state.json');
const NPSSO_FILE  = path.resolve('data/ps-captured-npsso.txt');
mkdirSync(PROFILE_DIR, { recursive: true });
cleanProfileLocks(PROFILE_DIR);

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const mask = s => (s && s.length > 12) ? `${s.slice(0, 6)}…${s.slice(-4)} (len=${s.length})` : `(len=${s ? s.length : 0})`;

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1920, height: 1080 }, // matches cfg defaults (production)
  locale: 'en-US',
  handleSIGINT: false,
  args: ['--hide-crash-restore-bubble', ...WEBGL_HARDENING_ARGS],
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(0); // no timeouts — the human takes as long as they need

log('Opening playstation.com. >>> PLEASE LOG IN BY HAND in the browser window. <<<');
log('Click Sign In, enter email/password, solve any 2FA/captcha. I am waiting…');
await page.goto('https://www.playstation.com/en-us/', { waitUntil: 'domcontentloaded' }).catch(e => log('nav warn:', e.message));

// Poll for the signed-in signal. Sony clears `isSignedIn` on logout, so its
// presence on a playstation.com domain means a real session exists.
const isSignedIn = async () => {
  const cookies = await context.cookies().catch(() => []);
  return cookies.some(c => c.name === 'isSignedIn' && (c.domain || '').includes('playstation.com'));
};

const MAX_TICKS = 160; // ~8 min at 3s
let signedIn = false;
for (let i = 0; i < MAX_TICKS; i++) {
  await page.waitForTimeout(3000);
  if (await isSignedIn()) { signedIn = true; break; }
  // Surface the Akamai IP-block if it appears, so we learn the IP layer blocked even a human.
  const blocked = await page.evaluate(() => /Can't connect to the server/i.test(document.body?.innerText || '')).catch(() => false);
  if (i % 5 === 0) log(`…still waiting for login (${i * 3}s)${blocked ? '  ⚠ page shows "Can\'t connect to the server" (Akamai IP block?)' : ''}`);
}

if (!signedIn) {
  log('Gave up waiting — no isSignedIn cookie seen. (Either not logged in, or an IP/Akamai block prevented it.)');
  await context.close().catch(() => {});
  process.exit(1);
}

log('✓ Detected signed-in session. Harvesting npsso + cookies…');

// 1) npsso — the long-lived (~2 month) SSO token. context.request inherits the
//    browser's cookies, so this authenticated GET returns { npsso: <64 chars> }.
let npsso = null;
try {
  const res = await context.request.get('https://ca.account.sony.com/api/v1/ssocookie');
  const body = await res.json();
  npsso = body && body.npsso;
} catch (e) {
  log('npsso fetch failed:', e.message, '(psn-api docs note this can need a different browser — cookies still captured below)');
}

// 2) Full session (cookies + origins) for inspection / future injection.
const state = await context.storageState();
const cookies = state.cookies || [];
const psnCookies = cookies.filter(c => /sony|playstation/i.test(c.domain || ''));
const signedInCookie = cookies.find(c => c.name === 'isSignedIn');
const npssoCookie = cookies.find(c => c.name === 'npsso');

writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
if (npsso) writeFileSync(NPSSO_FILE, npsso + '\n');

log('—— CAPTURE RESULT ——');
log(`npsso (from ssocookie API): ${npsso ? mask(npsso) : 'NOT CAPTURED'}`);
log(`npsso cookie in jar:        ${npssoCookie ? `present, domain=${npssoCookie.domain}, expires=${npssoCookie.expires}` : 'absent'}`);
log(`isSignedIn cookie:          ${signedInCookie ? `present, expires=${signedInCookie.expires}` : 'absent'}`);
log(`total cookies / psn cookies: ${cookies.length} / ${psnCookies.length}`);
log(`storageState written to:    ${STATE_FILE}`);
if (npsso) log(`npsso written to:           ${NPSSO_FILE}`);
log('PSN cookie names: ' + psnCookies.map(c => c.name).join(', '));
log('✓ Done. Closing in 8s.');
await page.waitForTimeout(8000).catch(() => {});
await context.close().catch(() => {});
