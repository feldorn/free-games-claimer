import { chromium } from 'patchright';
import { resolve, jsonDb, datetime, filenamify, prompt, confirm, notify, html_game_list, handleSIGINT, log } from './src/util.js';
import { cfg } from './src/config.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'gog', ...a);

const URL_CLAIM = 'https://www.gog.com/en';

log.section('GOG');
log.status('Time', datetime());

const db = await jsonDb('gog.json', {});

if (cfg.width < 1280) { // otherwise 'Sign in' and #menuUsername are hidden (but attached to DOM), see https://github.com/vogler/free-games-claimer/issues/335
  log.warn(`Window width ${cfg.width} is below 1280 minimum for GOG`);
  process.exit(1);
}

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators -> done via /en in URL
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/gog-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
  // https://peter.sh/experiments/chromium-command-line-switches/
  args: [
    '--hide-crash-restore-bubble',
  ],
});

handleSIGINT(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
await page.setViewportSize({ width: cfg.width, height: cfg.height }); // TODO workaround for https://github.com/vogler/free-games-claimer/issues/277 until Playwright fixes it
// console.debug('userAgent:', await page.evaluate(() => navigator.userAgent));

const notify_games = [];
let user;

try {
  await context.addCookies([{ name: 'CookieConsent', value: '{stamp:%274oR8MJL+bxVlG6g+kl2we5+suMJ+Tv7I4C5d4k+YY4vrnhCD+P23RQ==%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1672331618201%2Cregion:%27de%27}', domain: 'www.gog.com', path: '/' }]); // to not waste screen space when non-headless

  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // default 'load' takes forever

  // page.click('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll').catch(_ => { }); // does not work reliably, solved by setting CookieConsent above
  const signIn = page.locator('a:has-text("Sign in"), [hook-test="menuAnonymousButton"]').first();
  const username = page.locator('#menuUsername, [hook-test="menuUsername"], .menu-username').first();
  await page.waitForTimeout(3000);
  const isLoggedIn = async () => {
    if (await username.count() > 0) return true;
    const accountEl = page.locator('a[href*="/account"], .menu-username-text');
    return await accountEl.count() > 0;
  };
  while (!await isLoggedIn()) {
    log.warn('Not signed in');
    if (cfg.nowait) process.exit(1);
    if (await signIn.count() === 0) {
      throw new Error('Could not find sign-in button. GOG page layout may have changed.');
    }
    await signIn.click({ force: true });
    // it then creates an iframe for the login
    await page.waitForSelector('#GalaxyAccountsFrameContainer iframe'); // TODO needed?
    const iframe = page.frameLocator('#GalaxyAccountsFrameContainer iframe');
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    log.status('Login timeout', `${cfg.login_timeout / 1000}s`);
    if (cfg.gog_email && cfg.gog_password) log.info('Using credentials from environment');
    else log.info('Press ESC to login in browser (not possible in headless mode)');
    const email = cfg.gog_email || await prompt({ message: 'Enter email' });
    const password = email && (cfg.gog_password || await prompt({ type: 'password', message: 'Enter password' }));
    if (email && password) {
      // iframe.locator('a[href="/logout"]').click().catch(_ => { }); // Click 'Change account' (email from previous login is set in some cookie)
      // TODO above didn't work with patchright
      if (!await iframe.locator('#login_username').isDisabled()) {
        await iframe.locator('#login_username').fill(email);
      }
      await iframe.locator('#login_password').fill(password);
      await iframe.locator('#login_login').click();
      await page.waitForTimeout(2000); // TODO patchright waits forever for MFA locator otherwise
      // handle MFA, but don't await it
      iframe.locator('form[name=second_step_authentication]').waitFor().then(async () => {
        log.info('Two-Step Verification — enter security code');
        log.info(await iframe.locator('.form__description').innerText());
        const otp = await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 4 || 'The code must be 4 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await iframe.locator('#second_step_authentication_token_letter_1').pressSequentially(otp.toString(), { delay: 10 });
        await iframe.locator('#second_step_authentication_send').click();
        await page.waitForTimeout(1000); // TODO still needed with wait for username below?
      }).catch(_ => { });
      // iframe.locator('iframe[title=reCAPTCHA]').waitFor().then(() => {
      // iframe.locator('.g-recaptcha').waitFor().then(() => {
      iframe.locator('text=Invalid captcha').waitFor().then(() => {
        log.warn('Got captcha during login — solve in browser, get a new IP or try again later');
        notify('gog: got captcha during login. Please check.');
        // TODO solve reCAPTCHA?
      }).catch(_ => { });
      await page.waitForSelector('#menuUsername, [hook-test="menuUsername"]');
    } else {
      log.info('Waiting for you to login in the browser');
      await notify('gog: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        log.info('Run `SHOW=1 node gog` to login in the opened browser');
        await context.close();
        process.exit(1);
      }
    }
    await page.waitForSelector('#menuUsername, [hook-test="menuUsername"]');
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  const userEl = page.locator('#menuUsername, [hook-test="menuUsername"], .menu-username').first();
  try {
    user = (await userEl.textContent({ timeout: 10000 })).trim();
  } catch {
    try {
      user = await page.locator('#menuUsername, [hook-test="menuUsername"], .menu-username').first().getAttribute('title', { timeout: 5000 }) || 'unknown';
    } catch {
      user = 'unknown';
    }
  }
  log.status('User', user);
  db.data[user] ||= {};

  const banner = page.locator('#giveaway');
  await page.waitForTimeout(2000); // TODO patchright sometimes missed banner otherwise
  if (!await banner.count()) {
    log.info('No free giveaway right now');
  } else {
    const text = await page.locator('.giveaway__content-header').innerText();
    const match_all = text.match(/Claim (.*) and don't miss the|Success! (.*) was added to/);
    const title = match_all[1] ? match_all[1] : match_all[2];
    const url = await banner.locator('a').first().getAttribute('href');
    log.game(title, url);
    db.data[user][title] ||= { title, time: datetime(), url };
    if (cfg.dryrun) process.exit(1);
    if (cfg.interactive && !await confirm()) process.exit(0);
    // await page.locator('#giveaway:not(.is-loading)').waitFor(); // otherwise screenshot is sometimes with loading indicator instead of game title; #TODO fix, skipped due to timeout, see #240
    await banner.screenshot({ path: screenshot(`${filenamify(title)}.png`) }); // overwrites every time - only keep first?

    // await banner.getByRole('button', { name: 'Add to library' }).click();
    // instead of clicking the button, we visit the auto-claim URL which gives as a JSON response which is easier than checking the state of a button
    await page.goto('https://www.gog.com/giveaway/claim');
    const response = await page.innerText('body');
    // console.log(response);
    // {} // when successfully claimed
    // {"message":"Already claimed"}
    // {"message":"Unauthorized"}
    // {"message":"Giveaway has ended"}
    let status;
    if (response == '{}') {
      status = 'claimed';
      log.ok(`${title} — claimed!`);
    } else {
      const message = JSON.parse(response).message;
      if (message == 'Already claimed') {
        status = 'existed';
        log.ok(`${title} — already in library`);
      } else {
        log.warn(`${title} — ${message}`);
        status = message;
      }
    }
    db.data[user][title].status ||= status;
    const notify_entry = { title, url, status };
    if (status !== 'claimed' && status !== 'existed') {
      notify_entry.details = `Game: ${url}`;
    }
    notify_games.push(notify_entry);

    if (status == 'claimed' && !cfg.gog_newsletter) {
      log.info('Unsubscribing from newsletters');
      await page.goto('https://www.gog.com/en/account/settings/subscriptions');
      await page.locator('li:has-text("Marketing communications through Trusted Partners") label').uncheck();
      await page.locator('li:has-text("Promotions and hot deals") label').uncheck();
    }
  }
} catch (error) {
  process.exitCode ||= 1;
  log.fail(`Exception: ${error.message || error}`);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode != 130) await notify(`gog failed: ${error.message.split('\n')[0]}`);
} finally {
  await db.write();
  log.sectionEnd();
  if (notify_games.filter(g => g.status != 'existed').length) {
    await notify(`gog (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (page.video()) log.info(`Recorded video — ${await page.video().path()}`);
await context.close();
