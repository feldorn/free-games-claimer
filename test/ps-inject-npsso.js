// PS Plus NPSSO INJECTION test (2026-06-03) — proves the "silent re-auth" half.
// Fresh patchright profile, inject ONLY the captured npsso cookie, then trigger
// the OAuth sign-in flow and see whether it lands logged-in WITHOUT ever showing
// the email/password form. If it shows the form → npsso-alone is insufficient.
//
//   node test/ps-inject-npsso.js
// Reuses data/ps-captured-npsso.txt + data/ps-captured-state.json (no new login).

import { chromium } from 'patchright';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { cleanProfileLocks } from '../src/util.js';

const WEBGL_HARDENING_ARGS = ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'];
const PROFILE_DIR = path.resolve('data/browser-playstation-inject');
const SHOT_DIR = path.resolve('data/screenshots/ps-inject');
mkdirSync(SHOT_DIR, { recursive: true });

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

// Pull the EXACT captured npsso cookie object (preserves domain/flags/expiry).
const state = JSON.parse(readFileSync(path.resolve('data/ps-captured-state.json'), 'utf8'));
const npssoCookie = (state.cookies || []).find(c => c.name === 'npsso');
if (!npssoCookie) { console.error('No npsso cookie in captured state — run ps-capture-session.js first.'); process.exit(2); }

// Truly fresh profile so nothing but the injected npsso is present.
rmSync(PROFILE_DIR, { recursive: true, force: true });
mkdirSync(PROFILE_DIR, { recursive: true });
cleanProfileLocks(PROFILE_DIR);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1920, height: 1080 },
  locale: 'en-US',
  handleSIGINT: false,
  args: ['--hide-crash-restore-bubble', ...WEBGL_HARDENING_ARGS],
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(30000);

const signedIn = async () => (await context.cookies().catch(() => []))
  .some(c => c.name === 'isSignedIn' && (c.domain || '').includes('playstation.com'));
const shot = (n) => page.screenshot({ path: path.join(SHOT_DIR, n + '.png') }).catch(() => {});

try {
  log(`Injecting ONLY the npsso cookie (domain=${npssoCookie.domain}, len=${(npssoCookie.value || '').length})`);
  await context.addCookies([npssoCookie]);
  log('cookies in context after inject:', (await context.cookies()).length);

  log('goto playstation.com (fresh — should NOT be signed in yet)…');
  await page.goto('https://www.playstation.com/en-us/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  log('isSignedIn before triggering authorize:', await signedIn());
  await shot('0-landing');

  if (!(await signedIn())) {
    log('Clicking Sign In to start the OAuth authorize flow (npsso should satisfy it silently)…');
    await page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first().click().catch(e => log('signin click warn:', e.message));
    await page.waitForTimeout(3000);
  }

  let outcome = 'unknown';
  for (let i = 0; i < 15; i++) {
    const url = page.url();
    const isIn = await signedIn();
    const s = await page.evaluate(() => ({
      hasEmailField: !!document.querySelector('#signin-entrance-input-signinId'),
      hasPwField: !!document.querySelector('#signin-password-input-password'),
      has2fa: !!document.querySelector('input[aria-label*="Verification code" i]'),
      block: /Can't connect to the server/i.test(document.body ? document.body.innerText : ''),
      title: document.title,
    })).catch(() => ({}));
    log(`poll ${i}: signedIn=${isIn} email=${s.hasEmailField} pw=${s.hasPwField} 2fa=${s.has2fa} block=${s.block} title="${s.title}" url=${url.slice(0, 70)}`);
    await shot(`poll-${i}`);

    if (isIn && /playstation\.com\/en-us/.test(url)) { outcome = 'SILENT-LOGIN-SUCCESS'; break; }
    if (s.hasPwField || s.hasEmailField) { outcome = 'NPSSO-INSUFFICIENT (form shown)'; break; }
    if (s.has2fa) { outcome = '2FA-PROMPTED'; break; }
    if (s.block) { outcome = 'AKAMAI-BLOCK'; break; }
    await page.waitForTimeout(3000);
  }

  log('================ OUTCOME: ' + outcome + ' ================');
  log('final isSignedIn:', await signedIn(), '| final url:', page.url());
  await shot('final');
} catch (e) {
  log('EXCEPTION:', e.message.split('\n')[0]);
  await shot('EXCEPTION');
} finally {
  await page.waitForTimeout(6000).catch(() => {});
  await context.close().catch(() => {});
}
