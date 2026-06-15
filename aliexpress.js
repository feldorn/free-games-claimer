// Opt-in service — the panel's runner only invokes this script when
// services.aliexpress.active === true (Settings → Per-service → AliExpress).
// If you run it standalone on the CLI, it always executes; the activation
// gate lives in interactive-login.js.
import { chromium } from 'patchright';
import { datetime, filenamify, prompt, handleSIGINT, jsonDb, awaitUserCaptchaSolve, getOrCreateFingerprint, log, notify, cleanProfileLocks, localeArgs } from './src/util.js';
import { cfg } from './src/config.js';
import { siteVersion } from './src/sites.js';
import { FingerprintInjector } from 'fingerprint-injector';
import { FingerprintGenerator } from 'fingerprint-generator';

log.section(`AliExpress (v${siteVersion('aliexpress')})`);

// Module-level state populated during the run; persisted to
// data/aliexpress.json so the Stats tab can compute deltas run-over-run.
const db = await jsonDb('aliexpress.json', { runs: [] });
let userCoinsNum = null;
let streakDays = null;
let tomorrowCoins = null;
let collected = false;
let totalEuro = null;

// Persist the generated fingerprint across runs. AliExpress's bot scoring
// flags device-instability between launches; reusing the same UA + headers +
// viewport keeps that signal stable. First run generates and saves; subsequent
// runs reload from <profileDir>/.fgc-fingerprint.json.
const profileDir = cfg.dir.browser + '-aliexpress';
const { fingerprint, headers, _persisted } = getOrCreateFingerprint(profileDir, () =>
  new FingerprintGenerator().getFingerprint({
    devices: ['mobile'],
    operatingSystems: ['android'],
  })
);
log.status('Fingerprint', _persisted ? 'loaded from cache' : 'fresh (saved for next run)');

cleanProfileLocks(profileDir);
const context = await chromium.launchPersistentContext(profileDir, {
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
  args: ['--hide-crash-restore-bubble', ...localeArgs()],
});
handleSIGINT(context);
await new FingerprintInjector().attachFingerprintToPlaywright(context, { fingerprint, headers });

context.setDefaultTimeout(cfg.debug ? 0 : cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage();

const auth = async url => {
  console.log('auth', url);
  // Structural selectors (locale-blind) FIRST, English-text fallbacks
  // SECOND. AliExpress emits a stable id ("signButton") + class-prefix
  // ("aecoin-checkInButton-*" / "aecoin-taskButton-*") regardless of the
  // page language; we then OR in the English text variants so this also
  // works if AliExpress restructures the daily-check-in widget in the
  // future. Reported in #72 (Polish locale broke the English-only
  // matchers entirely — `Zdobądź więcej monet` / `Odbierz`) and #74
  // (Collect button timeout, same root cause on a non-English account).
  const STRUCT_LOGGED_IN_CLAIMABLE = '#signButton[class*="aecoin-checkInButton"], [id="signButton"][class*="checkInButton"]';
  const STRUCT_LOGGED_IN_DONE      = '#signButton[class*="aecoin-taskButton"], [id="signButton"][class*="taskButton"]';
  const STRUCT_LOGIN_LINK          = 'a[href*="/login"], a[href*="/signin" i], button[data-spm*="login" i]';
  const loginBtn = page.locator(STRUCT_LOGIN_LINK + ', button:has-text("Log in")');
  const loggedIn = page.locator(STRUCT_LOGGED_IN_CLAIMABLE + ', h3:text-is("day streak")');
  // Post-collect state: when the user has already collected today's coins
  // (manually on another device or earlier in the day), the "day streak"
  // h3 disappears and the page shows "Earn more coins" instead. Counts as
  // logged-in for the purpose of this race so we don't false-positive into
  // the login flow against an already-authenticated session.
  const collectedToday = page.locator(STRUCT_LOGGED_IN_DONE + ', button:has-text("Earn more coins")');
  // AliExpress mobile sometimes hangs on initial load — a manual F5 recovers it.
  // Auto-reload up to 3 times if neither the login button nor either logged-in
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
      collectedToday.waitFor({ timeout: QUICK_WAIT_MS }).then(_ => 'collectedToday'),
    ]).catch(_ => null);
    if (which) {
      alreadyLoggedIn = which === 'loggedIn' || which === 'collectedToday';
      break;
    }
    // Last-chance attached-but-not-visible check before retrying — the
    // visible-race above defaults to state:'visible', which misses
    // elements present in the DOM but transiently hidden (display:none,
    // opacity:0, offscreen during a layout transition). jaimitus's #86
    // diagnostic dump showed both `"day streak"` h3 and `"Collect"`
    // button in the DOM after the visible-race failed all four
    // attempts — but the dump grabs textContent, not visibility, so
    // the markers were there just not paint-visible at the moment the
    // race timed out. Use locator.count() (visibility-agnostic) to
    // catch this case before throwing.
    if (await loggedIn.count() > 0 || await collectedToday.count() > 0) {
      console.log('Logged-in marker found in DOM but was not visible during the wait — counting as logged in');
      alreadyLoggedIn = true;
      break;
    }
    if (await loginBtn.count() > 0) {
      console.log('Login button found in DOM but was not visible during the wait — counting as logged out');
      alreadyLoggedIn = false;
      break;
    }
    if (attempt === MAX_RELOADS) {
      // Diagnostic dump on failure — none of the three sentinel selectors
      // resolved within the 15s window across all retries. AliExpress's
      // coin page surface drifts (#45 — user reports the page renders
      // logged-in but our markers never fire). Snapshot the top headings
      // and buttons so future triage doesn't need a live noVNC session.
      try {
        const snapshot = await page.evaluate(() => {
          const grab = (sel, max = 8) => Array.from(document.querySelectorAll(sel)).slice(0, max).map(el => (el.textContent || '').trim().slice(0, 80)).filter(Boolean);
          return {
            url: location.href,
            title: document.title,
            h1: grab('h1'),
            h2: grab('h2'),
            h3: grab('h3'),
            buttons: grab('button'),
            anchorsWithLog: grab('a[href*="login" i], a[href*="signin" i]'),
          };
        });
        console.error('AliExpress page diagnostic dump (none of {Log in button, "day streak" h3, "Earn more coins" button} matched):');
        console.error(JSON.stringify(snapshot, null, 2));
      } catch (e) { console.error(`(diagnostic dump failed: ${e.message})`); }
      throw new Error('AliExpress page never finished loading (login button / logged-in marker never appeared) — see diagnostic dump above');
    }
  }
  if (!alreadyLoggedIn) {
    console.error('Not logged in! Will wait for 120s for you to login in the browser or terminal...');
    context.setDefaultTimeout(120 * 1000);
    await loginBtn.click();
    page.getByRole('button', { name: 'Accept cookies' }).click().then(_ => console.log('Accepted cookies')).catch(_ => { });
    page.locator('span:has-text("Switch account")').click().catch(_ => {});
    const login = page.locator('#root');
    // In headless container the prompt() call resolves to undefined when the
    // terminal isn't attached. Without this guard the later .fill(email)
    // throws an opaque "value: expected string, got undefined" — the actual
    // user-actionable problem is missing creds, surface that directly. #73.
    const email = cfg.ae_email || await prompt({ message: 'Enter email' });
    if (!email) {
      throw new Error('AliExpress login marker not detected and no AE_EMAIL configured. If you logged in via the panel (cookie import), the script should not have reached the credential flow — most likely the login-detector locators didn\'t match your locale. Either set AE_EMAIL+AE_PASSWORD in data/config.env for credential login, or re-import the cookies from a logged-in browser session and try again. (See aliexpress.js auth() for the detector logic.)');
    }
    const emailInput = login.locator('input[label="Email or phone number"]');
    await emailInput.fill(email);
    await emailInput.blur();
    const continueButton = login.locator('button:has-text("Continue")');
    await continueButton.click({ force: true });
    const password = cfg.ae_password || await prompt({ type: 'password', message: 'Enter password' });
    if (!password) {
      throw new Error('AliExpress login: email entered but no AE_PASSWORD configured. Set AE_PASSWORD in data/config.env or run with an attached terminal that can prompt.');
    }
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
    // AliExpress's coin API has two observed response shapes for d.data.data:
    //
    //   Shape A (older, name/value array):
    //     [{ name: 'userCoinsNum', value: '1234' }, { name: '...', value: '...' }, ...]
    //
    //   Shape B (newer / region-specific, direct object):
    //     { userCoinsNum: 1234, ... }
    //
    // The original parser only handled A and silently fell to null on B
    // (issue #22). Try A first (preserves behavior for users who still
    // see it), fall through to B, fall through to null with a debug
    // dump of the actual shape so we can adapt if AliExpress shifts
    // again. Number.isFinite-gated extraction so a real-zero balance
    // doesn't get coerced to null by `Number(...) || null`.
    const toCoinNum = v => {
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    await page.waitForResponse(r => r.request().method() === 'POST' && r.url().startsWith('https://acs.aliexpress.com/h5/mtop.aliexpress.coin.execute/'))
      .then(async r => {
        d = await r.json();
        const inner = d?.data?.data;
        if (Array.isArray(inner)) {
          const entry = inner.find(e => e?.name === 'userCoinsNum');
          userCoinsNum = entry ? toCoinNum(entry.value) : null;
        } else if (inner && typeof inner === 'object') {
          userCoinsNum = toCoinNum(inner.userCoinsNum);
        }
        if (userCoinsNum == null) {
          // Surface the actual shape so the next run's log tells us how
          // to extend the parser. Truncated to 300 chars to avoid
          // dumping the entire response.
          const dump = (() => { try { return JSON.stringify(inner)?.slice(0, 300); } catch { return String(inner); } })();
          console.log('Total (coins): null — response shape:', dump);
        } else {
          console.log('Total (coins):', userCoinsNum);
        }
      })
      .catch(e => console.error('Total (coins): error:', e, 'data:', d));
  },
};

const coins = async () => {
  console.log('Collecting coins...');
  page.locator('.hideDoubleButton').click().catch(_ => {});
  // Same locale-blind-with-fallback pattern as auth() above — match the
  // structural #signButton id + state class first, English text second.
  // #74 (Buddinski88) timed out on the English-text selector on a non-
  // English account; this resolves the same root cause as #72.
  const collectBtn = page.locator('#signButton[class*="aecoin-checkInButton"], button:has-text("Collect")');
  const moreBtn = page.locator('#signButton[class*="aecoin-taskButton"], button:has-text("Earn more coins")');
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
  // claimed=1 when today's daily reward was just collected, 0 if it was
  // already collected before this run (semantically: "did we do today's
  // job?"). coins shows the current balance as the third field.
  log.summary({
    siteId: 'aliexpress',
    claimed: collected ? 1 : 0,
    skipped: 0,
    display: 'coins',
    coins: userCoinsNum || 0,
  });
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error);
}

await recordRun();

// End-of-run notification — same shape as the Microsoft Rewards summary
// (`+earned, balance, optional context`). Skip when the run produced no
// data (login failure, page never loaded), since a notification with no
// numbers in it is just noise.
{
  const fmt = n => Number(n).toLocaleString('en-US');
  const prev = (db.data.runs || []).filter(r => typeof r.balance === 'number').slice(-2, -1)[0];
  const earned = (typeof userCoinsNum === 'number' && prev && typeof prev.balance === 'number')
    ? Math.max(0, userCoinsNum - prev.balance)
    : null;
  const parts = [];
  if (earned != null && earned > 0) parts.push(`+${fmt(earned)} coins`);
  else if (collected) parts.push(`collected today's coins`);
  else if (typeof userCoinsNum === 'number') parts.push(`already collected today`);
  if (typeof userCoinsNum === 'number') parts.push(`balance ${fmt(userCoinsNum)}`);
  if (typeof streakDays === 'number') parts.push(`${fmt(streakDays)}-day streak`);
  if (parts.length) {
    const tail = (typeof tomorrowCoins === 'number') ? ` (+${fmt(tomorrowCoins)} tomorrow)` : '';
    await notify(`AliExpress: ${parts.join(', ')}${tail}`, { kind: 'summary' })
      .catch(e => log.warn(`aliexpress notify failed: ${e.message.split('\n')[0]}`));
  }
}

if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
