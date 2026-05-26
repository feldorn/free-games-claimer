import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import path from 'node:path';
import {
  jsonDb, datetime, prompt, notify, html_game_list,
  handleSIGINT, closeContextSafely, log, cleanProfileLocks, awaitUserCaptchaSolve,
} from './src/util.js';
import { cfg } from './src/config.js';
import { siteVersion } from './src/sites.js';
import { URL_WHATS_NEW } from './src/playstation-plus-catalog.js';

const screenshot = (...a) => path.resolve(cfg.dir.screenshots, 'playstation-plus', ...a); // eslint-disable-line no-unused-vars

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

    // FunCaptcha handoff — Sony's Arkose challenge. The captcha-marker
    // feature on the registry entry tells the panel to watch for the
    // [CAPTCHA-START]/[CAPTCHA-END] markers awaitUserCaptchaSolve emits.
    page.locator('#FunCaptcha').waitFor({ timeout: cfg.login_timeout }).then(async () => {
      log.warn('Got FunCaptcha challenge during PSN login');
      await awaitUserCaptchaSolve(page, {
        service: 'playstation-plus',
        label: 'FunCaptcha (PSN login)',
        captchaCheck: async () => await page.locator('#FunCaptcha').count() === 0,
      });
    }).catch(() => {});

    // 2FA / TOTP. PSP_OTPKEY → automatic; otherwise prompt or notify.
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

try {
  await ensureLoggedIn(page);
  user = (await page.locator('.psw-c-secondary').first().innerText().catch(() => '')).trim() || 'unknown';
  log.status('User', user);
  db.data[user] ||= {};

  // Claim logic lands in next task. For now, just emit the summary and exit.
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
    const hasActionable = notify_games.some(g => g.status === 'failed' || g.status === 'action' || (/^failed:/).test(g.status));
    await notify(`playstation-plus (${user || 'unknown'}):<br>${html_game_list(notify_games)}`, { kind: hasActionable ? 'action' : 'summary' });
  }
  await closeContextSafely(context);
}
