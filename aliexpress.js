// Opt-in service — the panel's runner only invokes this script when
// services.aliexpress.active === true (Settings → Per-service → AliExpress).
// If you run it standalone on the CLI, it always executes; the activation
// gate lives in interactive-login.js.
import { chromium } from 'patchright';
import { datetime, filenamify, prompt, handleSIGINT, jsonDb, awaitUserCaptchaSolve } from './src/util.js';
import { cfg } from './src/config.js';
import { FingerprintInjector } from 'fingerprint-injector';
import { FingerprintGenerator } from 'fingerprint-generator';

// Module-level state populated during the run; persisted to
// data/aliexpress.json so the Stats tab can compute deltas run-over-run.
const db = await jsonDb('aliexpress.json', { runs: [] });
let userCoinsNum = null;
let streakDays = null;
let tomorrowCoins = null;
let collected = false;
let totalEuro = null;

const { fingerprint, headers } = new FingerprintGenerator().getFingerprint({
  devices: ['mobile'],
  operatingSystems: ['android'],
});

const context = await chromium.launchPersistentContext(cfg.dir.browser + '-aliexpress', {
  headless: cfg.headless,
  locale: 'en-US',
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined,
  recordHar: cfg.record ? { path: `data/record/aliexpress-${filenamify(datetime())}.har` } : undefined,
  handleSIGINT: false,
  // mobile view is required — desktop URLs just show "install the app"
  userAgent: fingerprint.navigator.userAgent,
  viewport: {
    width: fingerprint.screen.width,
    height: fingerprint.screen.height,
  },
  extraHTTPHeaders: {
    'accept-language': headers['accept-language'],
  },
  args: ['--hide-crash-restore-bubble'],
});
handleSIGINT(context);
await new FingerprintInjector().attachFingerprintToPlaywright(context, { fingerprint, headers });

context.setDefaultTimeout(cfg.debug ? 0 : cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage();

const auth = async url => {
  console.log('auth', url);
  const loginBtn = page.locator('button:has-text("Log in")');
  const loggedIn = page.locator('h3:text-is("day streak")');
  // AliExpress mobile sometimes hangs on initial load — a manual F5 recovers it.
  // Auto-reload up to 3 times if neither the login button nor the logged-in
  // marker shows up within a short window. Track which marker resolved so we
  // can dispatch directly: re-racing afterwards with `loggedIn.waitFor()`
  // under the default timeout would prematurely abort the login branch when
  // the user takes >60s (e.g. solving the post-login slider).
  const QUICK_WAIT_MS = 15000;
  const MAX_RELOADS = 3;
  let alreadyLoggedIn = false;
  for (let attempt = 0; attempt <= MAX_RELOADS; attempt++) {
    if (attempt === 0) await page.goto(url, { waitUntil: 'domcontentloaded' });
    else {
      console.log(`Page stuck loading; reloading (attempt ${attempt}/${MAX_RELOADS})`);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(_ => {});
    }
    const which = await Promise.any([
      loginBtn.waitFor({ timeout: QUICK_WAIT_MS }).then(_ => 'loginBtn'),
      loggedIn.waitFor({ timeout: QUICK_WAIT_MS }).then(_ => 'loggedIn'),
    ]).catch(_ => null);
    if (which) {
      alreadyLoggedIn = which === 'loggedIn';
      break;
    }
    if (attempt === MAX_RELOADS) throw new Error('AliExpress page never finished loading (login button / logged-in marker never appeared)');
  }
  if (!alreadyLoggedIn) {
    console.error('Not logged in! Will wait for 120s for you to login in the browser or terminal...');
    context.setDefaultTimeout(120 * 1000);
    await loginBtn.click();
    page.getByRole('button', { name: 'Accept cookies' }).click().then(_ => console.log('Accepted cookies')).catch(_ => { });
    page.locator('span:has-text("Switch account")').click().catch(_ => {});
    const login = page.locator('#root');
    const email = cfg.ae_email || await prompt({ message: 'Enter email' });
    const emailInput = login.locator('input[label="Email or phone number"]');
    await emailInput.fill(email);
    await emailInput.blur();
    const continueButton = login.locator('button:has-text("Continue")');
    await continueButton.click({ force: true });
    const password = email && (cfg.ae_password || await prompt({ type: 'password', message: 'Enter password' }));
    await login.locator('input[label="Password"]').fill(password);
    await login.locator('button:has-text("Sign in")').click();
    const error = login.locator('.nfm-login-input-error-text');
    error.waitFor().then(async _ => console.error('Login error (please restart):', await error.innerText())).catch(_ => console.log('No login error.'));
    // AWSC slider can appear after Sign in. Race success-URL vs slider-trigger.
    // If the slider wins, wrap the wait in awaitUserCaptchaSolve so the panel
    // surfaces a banner + notification. If unsolved within the helper's 10min
    // window, throw CAPTCHA_BLOCKED rather than falling through and stacking
    // a second timeout in pre_auth.coins' waitForResponse.
    const successUrl = u => u.toString().startsWith('https://www.aliexpress.com/');
    const sliderTrigger = page.locator(
      'iframe[src*="captcha"], iframe[src*="punish"], iframe[src*="nocaptcha"], iframe[src*="awsc"], iframe[src*="baxia"]'
    ).or(page.locator('text=/slide.*verify|drag.*slider/i')).first();
    let captchaDetectLogged = false;
    const captchaCheck = async () => {
      const matched = page.frames().find(f => /captcha|nocaptcha|punish_box|baxia|awsc/i.test(f.url() || ''));
      if (matched) {
        if (!captchaDetectLogged) {
          captchaDetectLogged = true;
          console.log(`[CAPTCHA-DETECT] service=aliexpress branch=frame frameUrl=${matched.url()} pageUrl=${page.url()}`);
        }
        return true;
      }
      const textVisible = await page.locator('text=/slide.*verify|drag.*slider|向右滑动/i').first().isVisible().catch(() => false);
      if (textVisible && !captchaDetectLogged) {
        captchaDetectLogged = true;
        console.log(`[CAPTCHA-DETECT] service=aliexpress branch=text pageUrl=${page.url()}`);
      }
      return textVisible;
    };
    await Promise.race([
      page.waitForURL(successUrl),
      sliderTrigger.waitFor({ state: 'visible' }).then(async () => {
        const solved = await awaitUserCaptchaSolve(page, {
          service: 'aliexpress',
          label: 'slider after login',
          captchaCheck,
        });
        if (!solved) {
          const e = new Error('AliExpress slider verification not completed within timeout');
          e.code = 'CAPTCHA_BLOCKED';
          throw e;
        }
        await page.waitForURL(successUrl);
      }),
    ]);
    context.setDefaultTimeout(cfg.debug ? 0 : cfg.timeout);
    console.log('Logged in!');
  }
};

const urls = {
  coins: 'https://m.aliexpress.com/p/coin-index/index.html',
};

const pre_auth = {
  coins: async _ => {
    console.log('Checking coins...');
    let d;
    await page.waitForResponse(r => r.request().method() === 'POST' && r.url().startsWith('https://acs.aliexpress.com/h5/mtop.aliexpress.coin.execute/'))
      .then(async r => {
        d = await r.json();
        d = d.data.data;
        if (Array.isArray(d)) userCoinsNum = Number(d.find(e => e.name === 'userCoinsNum')?.value) || null;
        console.log('Total (coins):', userCoinsNum);
      })
      .catch(e => console.error('Total (coins): error:', e, 'data:', d));
  },
};

const coins = async () => {
  console.log('Collecting coins...');
  page.locator('.hideDoubleButton').click().catch(_ => {});
  const collectBtn = page.locator('button:has-text("Collect")');
  const moreBtn = page.locator('button:has-text("Earn more coins")');
  await Promise.race([
    collectBtn.click({ force: true }).then(_ => { collected = true; console.log('Collected coins for today!'); }),
    moreBtn.waitFor().then(_ => console.log('No more coins to collect today!')),
  ]);
  try {
    streakDays = Number(await page.locator('h3:text-is("day streak")').locator('xpath=..').locator('div span').innerText());
    console.log('Streak (days):', streakDays);
  } catch {}
  try {
    tomorrowCoins = Number((await page.locator(':text("coins tomorrow")').innerText()).replace(/Get (\d+) check-in coins tomorrow!/, '$1'));
    console.log('Tomorrow (coins):', tomorrowCoins);
  } catch {}
  try {
    totalEuro = await page.locator(':text("€")').first().innerText();
    console.log('Total (€):', totalEuro);
  } catch {}
};

async function recordRun() {
  if (userCoinsNum == null && streakDays == null) return; // nothing to record
  const entry = { at: datetime(), balance: userCoinsNum, streak: streakDays, tomorrow: tomorrowCoins, collected, totalEuro };
  // Compute earned-vs-previous-run for Stats tab convenience.
  const prev = (db.data.runs || []).filter(r => typeof r.balance === 'number').slice(-1)[0];
  if (prev && typeof entry.balance === 'number') entry.earned = Math.max(0, entry.balance - prev.balance);
  db.data.runs.push(entry);
  if (db.data.runs.length > 500) db.data.runs = db.data.runs.slice(-500);
  try { await db.write(); }
  catch (e) { console.error('aliexpress: db.write failed:', e.message); }
}

try {
  await [coins].reduce((a, f) => a.then(async _ => {
    const prep = (pre_auth[f.name] ?? (_ => undefined))();
    await auth(urls[f.name]);
    await prep;
    await f();
    console.log();
  }), Promise.resolve());
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error);
}

await recordRun();

if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
