// PS Plus LOGIN-flow probe (2026-06-02) — reproduce & diagnose the auto-login
// hang that ends in `page.waitForURL` timeout at playstation-plus.js:132.
//
// Runs the SAME hardened patchright launch as the runner (WEBGL_HARDENING_ARGS,
// persistent context) so Sony's risk engine (ThreatMetrix / skw.eve) sees the
// same fingerprint the container does — vanilla Chromium gets bot-blocked at
// password submit, so MCP can't reach the post-password step.
//
// Walks: homepage → Sign In → email → Next → password → Sign In, then POLLS the
// post-password state every 2s, dumping URL/hash, alerts, captcha + every
// 2FA-input candidate selector, with a screenshot each tick. If a code field
// appears it generates a TOTP from PSP_OTPKEY and submits, then watches for the
// redirect back to www.playstation.com.
//
// Run LOCALLY (never via docker-exec-root — that corrupts profile ownership):
//   $env:PSP_EMAIL='...'; $env:PSP_PASSWORD='...'; $env:PSP_OTPKEY='...'; node test/ps-login-probe.js
// Uses a throwaway profile dir so it never touches data/browser-playstation.

import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Inlined from src/sites.js:62 to avoid the config/util/sites circular-init
// TDZ when sites.js is the first of those modules imported. Keep in sync.
const WEBGL_HARDENING_ARGS = ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'];

const EMAIL = process.env.PSP_EMAIL;
const PASSWORD = process.env.PSP_PASSWORD;
const OTPKEY = process.env.PSP_OTPKEY;
if (!EMAIL || !PASSWORD) { console.error('Set PSP_EMAIL and PSP_PASSWORD'); process.exit(2); }

const PROFILE_DIR = path.resolve('data/browser-playstation-logintest');
const SHOT_DIR = path.resolve('data/screenshots/ps-login-probe');
const FINDINGS_FILE = path.resolve('data/ps-login-probe.json');
const findings = [];
mkdirSync(PROFILE_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

const ts = () => new Date().toISOString().slice(11, 19);
const shot = async (page, name) => {
  const p = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
};

// Dump everything we care about for identifying the current step.
// MUST be a real function passed to page.evaluate — passing it as a STRING makes
// patchright evaluate it as an expression (yields the function object, not its
// result → undefined). That was the original probe bug.
const probeFn = () => {
  const vis = el => el && el.offsetParent !== null;
  const q = sel => { try { return !!document.querySelector(sel); } catch { return false; } };
  return {
    url: location.href,
    hash: location.hash,
    title: document.title,
    headings: [...document.querySelectorAll('h1,h2,h3')].map(h => (h.textContent || '').trim()).filter(Boolean).slice(0, 6),
    bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400),
    alerts: [...document.querySelectorAll('[role="alert"],[class*="error" i],[class*="alert" i]')].map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 6),
    funCaptcha: q('#FunCaptcha') || q('iframe[src*="arkose"]') || q('iframe[src*="funcaptcha"]'),
    is2svRoute: location.hash.includes('/2sv/'),
    twofa: {
      byTitle: q('input[title="Enter Code"]'),
      oneTimeCode: q('input[autocomplete="one-time-code"]'),
      inputmodeNumeric: q('input[inputmode="numeric"]'),
      dataQaCode: q('[data-qa*="code" i]'),
      ariaLabelCode: q('input[aria-label*="code" i]'),
    },
    visibleInputs: [...document.querySelectorAll('input')].filter(vis).map(i => ({
      id: i.id, type: i.type, inputMode: i.inputMode, maxLength: i.maxLength,
      autocomplete: i.autocomplete, ariaLabel: i.getAttribute('aria-label'),
      title: i.title, name: i.name, dataQa: i.getAttribute('data-qa'),
    })),
    visibleButtons: [...document.querySelectorAll('button')].filter(vis).map(b => ({
      id: b.id, text: (b.textContent || '').trim().slice(0, 40), dataQa: b.getAttribute('data-qa'),
    })),
    checkboxes: [...document.querySelectorAll('input[type=checkbox]')].filter(vis).map(c => ({
      id: c.id, ariaLabel: c.getAttribute('aria-label'), dataQa: c.getAttribute('data-qa'), checked: c.checked,
    })),
    trust: (() => {
      const cb = document.querySelector('input[type=checkbox]');
      if (!cb) return null;
      const label = cb.closest('label') || (cb.id && document.querySelector('label[for="' + cb.id + '"]'));
      const r = cb.getBoundingClientRect();
      return {
        checked: cb.checked,
        cbVisible: r.width > 0 && r.height > 0,
        cbOuter: cb.outerHTML.slice(0, 200),
        parentTag: cb.parentElement && cb.parentElement.tagName,
        parentDataQa: cb.parentElement && cb.parentElement.getAttribute('data-qa'),
        grandparentDataQa: cb.parentElement && cb.parentElement.parentElement && cb.parentElement.parentElement.getAttribute('data-qa'),
        parentOuter: cb.parentElement && cb.parentElement.outerHTML.slice(0, 320),
        labelText: label ? (label.textContent || '').trim().slice(0, 40) : null,
      };
    })(),
  };
};

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  locale: 'en-US',
  handleSIGINT: false,
  args: ['--hide-crash-restore-bubble', ...WEBGL_HARDENING_ARGS],
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(30000);

const log = (...a) => console.log(`[${ts()}]`, ...a);

try {
  log('goto playstation.com');
  await page.goto('https://www.playstation.com/en-us/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  log('click Sign In');
  await page.locator('button:has-text("Sign In"), a:has-text("Sign In")').first().click();
  await page.waitForURL(/my\.account\.sony\.com|signin\.account\.sony\.com/, { timeout: 30000 });
  await page.waitForSelector('#signin-entrance-input-signinId', { timeout: 30000 });
  await shot(page, '1-entrance');

  log('fill email + Next');
  await page.locator('#signin-entrance-input-signinId').fill(EMAIL);
  await page.locator('#signin-entrance-button').click();

  log('wait for password field');
  await page.waitForSelector('#signin-password-input-password', { timeout: 30000 });
  await shot(page, '2-password');

  log('fill password + Sign In');
  await page.locator('#signin-password-input-password').fill(PASSWORD);
  await page.locator('#signin-password-button').click();

  log('=== POST-PASSWORD POLL (where the runner hangs) ===');
  let otpEntered = false;
  for (let i = 0; i < 45; i++) {        // ~90s of observation
    await page.waitForTimeout(2000);
    if (/^https:\/\/www\.playstation\.com\//.test(page.url())) {
      log(`SUCCESS — redirected to ${page.url()}`);
      await shot(page, `poll-${i}-SUCCESS`);
      break;
    }
    await shot(page, `poll-${i}`);
    // evaluate can return undefined / reject mid-navigation; retry once, guard.
    let info = await page.evaluate(probeFn).catch(() => null);
    if (!info) { await page.waitForTimeout(800); info = await page.evaluate(probeFn).catch(e => ({ evalError: e.message })); }
    if (!info) { log(`poll ${i}: <no eval — navigating> url=${page.url()}`); continue; }
    findings.push({ poll: i, at: ts(), ...info });
    writeFileSync(FINDINGS_FILE, JSON.stringify(findings, null, 2));
    log(`poll ${i}:`, JSON.stringify(info));

    // If a code field shows up and we have a key, enter it once.
    const t = info.twofa || {};
    const codeReady = info.is2svRoute || t.byTitle || t.oneTimeCode || t.inputmodeNumeric || t.dataQaCode || t.ariaLabelCode;
    if (codeReady && OTPKEY && !otpEntered) {
      otpEntered = true;
      const code = authenticator.generate(OTPKEY);
      log(`>>> 2FA detected — entering TOTP ${code}`);
      const codeSel = t.ariaLabelCode ? 'input[aria-label*="code" i]'
        : t.oneTimeCode ? 'input[autocomplete="one-time-code"]'
        : t.inputmodeNumeric ? 'input[inputmode="numeric"]'
        : t.dataQaCode ? '[data-qa*="code" i]'
        : t.byTitle ? 'input[title="Enter Code"]'
        : 'input:not([type=checkbox]):not([type=hidden]):not([type=password])'; // last-resort: the lone code field on the 2sv route
      log(`    using selector: ${codeSel}`);
      log(`    trust struct:`, JSON.stringify(info.trust));
      await page.locator(codeSel).first().pressSequentially(code, { delay: 80 }).catch(e => log('    fill failed:', e.message));
      // Trust this Browser — custom psw checkbox (hidden real input → .check()
      // no-ops). Try several robust clicks and report which (if any) toggled it.
      const trustBefore = await page.evaluate(() => document.querySelector('input[type=checkbox]')?.checked).catch(() => null);
      for (const [label, loc] of [
        ['getByText', page.getByText('Trust this Browser', { exact: false })],
        ['label:has-text', page.locator('label:has-text("Trust this Browser")')],
        ['checkbox role', page.getByRole('checkbox')],
      ]) {
        const after = await page.evaluate(() => document.querySelector('input[type=checkbox]')?.checked).catch(() => null);
        if (after) { log(`    trust already checked (before "${label}")`); break; }
        await loc.first().click({ timeout: 3000 }).then(() => log(`    clicked via ${label}`)).catch(e => log(`    ${label} click failed: ${e.message.split('\n')[0]}`));
      }
      const trustAfter = await page.evaluate(() => document.querySelector('input[type=checkbox]')?.checked).catch(() => null);
      log(`    >>> TRUST checked: before=${trustBefore} after=${trustAfter}`);
      await shot(page, `poll-${i}-after-trust`);
      await page.locator('button[data-qa="button-primary"], button:has-text("Verify")').first().click().catch(e => log('    submit failed:', e.message));
      await shot(page, `poll-${i}-after-otp`);
    }
  }
  log('done polling. final url:', page.url());
} catch (e) {
  log('EXCEPTION:', e.message.split('\n')[0]);
  await shot(page, 'EXCEPTION');
} finally {
  console.log('\nScreenshots in', SHOT_DIR);
  console.log('Browser stays open 20s for inspection…');
  await page.waitForTimeout(20000).catch(() => {});
  await context.close().catch(() => {});
}
