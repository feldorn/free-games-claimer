import { authenticator } from 'otplib';
import chalk from 'chalk';
import path from 'path';
import { existsSync, writeFileSync, appendFileSync } from 'fs';
import { resolve, jsonDb, datetime, filenamify, prompt, notify, html_game_list } from './src/util.js';
import { cfg } from './src/config.js';
import { launchBrowser } from './src/browser.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'epic-games', ...a);

const URL_CLAIM = 'https://store.epicgames.com/en-US/free-games';
const URL_LOGIN = 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=' + URL_CLAIM;

console.log(datetime(), 'started checking epic-games');

const db = await jsonDb('epic-games.json', {});

if (cfg.time) console.time('startup');

const egBrowserDir = cfg.dir.browser_eg || cfg.dir.browser;
const browserPrefs = path.join(egBrowserDir, 'prefs.js');
if (existsSync(browserPrefs)) {
  console.log('Adding webgl.disabled to', browserPrefs);
  appendFileSync(browserPrefs, 'user_pref("webgl.disabled", true);');
} else {
  console.log(browserPrefs, 'does not exist yet, will patch it on next run.');
}

const { context, page } = await launchBrowser(egBrowserDir, {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  recordPrefix: 'eg',
});

if (cfg.debug) console.debug(await page.evaluate(() => [(({ width, height, availWidth, availHeight }) => ({ width, height, availWidth, availHeight }))(window.screen), navigator.userAgent, navigator.platform, navigator.vendor]));
if (cfg.debug_network) {
  const filter = r => r.url().includes('store.epicgames.com');
  page.on('request', request => filter(request) && console.log('>>', request.method(), request.url()));
  page.on('response', response => filter(response) && console.log('<<', response.status(), response.url()));
}

const notify_games = [];
let user;

try {
  await context.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), domain: '.epicgames.com', path: '/' },
    { name: 'HasAcceptedAgeGates', value: 'USK:9007199254740991,general:18,EPIC SUGGESTED RATING:18', domain: 'store.epicgames.com', path: '/' },
  ]);
  if (process.env.HCAPTCHA_ACCESSIBILITY) {
    await context.addCookies([
      { name: 'hc_accessibility', value: process.env.HCAPTCHA_ACCESSIBILITY, domain: '.hcaptcha.com', path: '/' },
    ]);
  }

  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' });

  if (cfg.time) console.timeEnd('startup');
  if (cfg.time) console.time('login');

  while (await page.locator('egs-navigation').getAttribute('isloggedin') != 'true') {
    console.error('Not signed in anymore. Please login in the browser or here in the terminal.');
    if (cfg.novnc_port) console.info(`Open http://localhost:${cfg.novnc_port} to login inside the docker container.`);
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
    if (cfg.eg_email && cfg.eg_password) console.info('Using email and password from environment.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const notifyBrowserLogin = async () => {
      console.log('Waiting for you to login in the browser.');
      await notify('epic-games: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node epic-games` to login in the opened browser.');
        await context.close();
        process.exit(1);
      }
    };
    const email = cfg.eg_email || await prompt({ message: 'Enter email' });
    if (!email) await notifyBrowserLogin();
    else {
      page.waitForSelector('.h_captcha_challenge iframe').then(async () => {
        console.error('Got a captcha during login (likely due to too many attempts)! You may solve it in the browser, get a new IP or try again in a few hours.');
        await notify('epic-games: got captcha during login. Please check.');
      }).catch(_ => { });
      page.waitForSelector('p:has-text("Incorrect response.")').then(async () => {
        console.error('Incorrect response for captcha!');
      }).catch(_ => { });
      await page.fill('#email', email);
      const password = email && (cfg.eg_password || await prompt({ type: 'password', message: 'Enter password' }));
      if (!password) await notifyBrowserLogin();
      else {
        if (await page.locator('#password').count() > 0) {
          await page.fill('#password', password);
          await page.click('button[type="submit"]');
        } else {
          await page.click('button[type="submit"]');
          await page.waitForTimeout(3000);
          const pwField = page.locator('#password, input[type="password"]').first();
          await pwField.waitFor({ state: 'visible', timeout: 15000 });
          await pwField.fill(password);
          await page.waitForTimeout(1000);
          console.log('  Submitting password...');
          await pwField.press('Enter');
          await page.waitForTimeout(2000);
          const signInBtn = page.locator('button:has-text("Sign in")').first();
          if (await signInBtn.isVisible()) {
            await signInBtn.click({ delay: 100 });
          }
          await page.waitForTimeout(5000);
          const stillOnLogin = page.url().includes('/id/login');
          if (stillOnLogin) {
            console.error('  Login form did not submit - likely blocked by invisible hCaptcha.');
            console.error('  Epic Games requires solving an invisible captcha on first login from new devices.');
            await notify('epic-games: login blocked by invisible captcha. First login requires a regular browser session.');
            await page.screenshot({ path: screenshot(`login-blocked-${filenamify(datetime())}.png`), fullPage: true });
          }
        }
        await page.waitForTimeout(3000);
        console.log('  Post-login URL:', page.url());
        await page.screenshot({ path: screenshot(`login-attempt-${filenamify(datetime())}.png`), fullPage: true });
      }
      const error = page.locator('#form-error-message');
      error.waitFor().then(async () => {
        console.error('Login error:', await error.innerText());
        console.log('Please login in the browser!');
      }).catch(_ => { });
      page.waitForURL('**/id/login/mfa**').then(async () => {
        console.log('Enter the security code to continue - This appears to be a new device, browser or location.');
        const otp = cfg.eg_otpkey && authenticator.generate(cfg.eg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' });
        await page.locator('input[name="code-input-0"]').pressSequentially(otp.toString());
        await page.click('button[type="submit"]');
      }).catch(_ => { });
    }
    try {
      await page.waitForURL(URL_CLAIM, { timeout: cfg.login_timeout });
    } catch (_) {
      console.error('  Could not reach free games page after login attempt. Skipping Epic Games.');
      await notify('epic-games: login failed, skipping. Session may need to be established manually.');
      await db.write();
      await context.close();
      process.exit(0);
    }
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  user = await page.locator('egs-navigation').getAttribute('displayname');
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};
  if (cfg.time) console.timeEnd('login');
  if (cfg.time) console.time('claim all games');

  const game_loc = page.locator('a:has(span:text-is("Free Now"))');
  await game_loc.last().waitFor().catch(_ => {
    console.error('Seems like currently there are no free games available in your region...');
  });
  const urlSlugs = await Promise.all((await game_loc.elementHandles()).map(a => a.getAttribute('href')));
  const urls = urlSlugs.map(s => 'https://store.epicgames.com' + s);
  console.log('Free games:', urls);

  for (const url of urls) {
    if (cfg.time) console.time('claim game');
    await page.goto(url);
    const purchaseBtn = page.locator('button[data-testid="purchase-cta-button"] >> :has-text("e"), :has-text("i")').first();
    await purchaseBtn.waitFor();
    const btnText = (await purchaseBtn.innerText()).toLowerCase();

    if (await page.locator('button:has-text("Continue")').count() > 0) {
      console.log('  This game contains mature content recommended only for ages 18+');
      if (await page.locator('[data-testid="AgeSelect"]').count()) {
        console.error('  Got age gate prompt despite cookie being set.');
        await page.locator('#month_toggle').click();
        await page.locator('#month_menu li:has-text("01")').click();
        await page.locator('#day_toggle').click();
        await page.locator('#day_menu li:has-text("01")').click();
        await page.locator('#year_toggle').click();
        await page.locator('#year_menu li:has-text("1987")').click();
      }
      await page.click('button:has-text("Continue")', { delay: 111 });
      await page.waitForTimeout(2000);
    }

    let title;
    let bundle_includes;
    if (await page.locator('span:text-is("About Bundle")').count()) {
      title = (await page.locator('span:has-text("Buy"):left-of([data-testid="purchase-cta-button"])').first().innerText()).replace('Buy ', '');
      try {
        bundle_includes = await Promise.all((await page.locator('.product-card-top-row h5').all()).map(b => b.innerText()));
      } catch (e) {
        console.error('Failed to get "Bundle Includes":', e);
      }
    } else {
      title = await page.locator('h1').first().innerText();
    }
    const game_id = page.url().split('/').pop();
    const existedInDb = db.data[user][game_id];
    db.data[user][game_id] ||= { title, time: datetime(), url: page.url() };
    console.log('Current free game:', chalk.blue(title));
    if (bundle_includes) console.log('  This bundle includes:', bundle_includes);
    const notify_game = { title, url, status: 'failed' };
    notify_games.push(notify_game);

    if (btnText == 'in library') {
      console.log('  Already in library! Nothing to claim.');
      if (!existedInDb) await notify(`Game already in library: ${url}`);
      notify_game.status = 'existed';
      db.data[user][game_id].status ||= 'existed';
      if (db.data[user][game_id].status.startsWith('failed')) db.data[user][game_id].status = 'manual';
    } else if (btnText == 'requires base game') {
      console.log('  Requires base game! Nothing to claim.');
      notify_game.status = 'requires base game';
      db.data[user][game_id].status ||= 'failed:requires-base-game';
      const baseUrl = 'https://store.epicgames.com' + await page.locator('a:has-text("Overview")').getAttribute('href');
      console.log('  Base game:', baseUrl);
      urls.push(baseUrl);
      urls.push(url);
    } else {
      console.log('  Not in library yet! Click', btnText);
      await purchaseBtn.click({ delay: 11 });

      page.click('button:has-text("Continue")').catch(_ => { });
      page.click('button:has-text("Yes, buy now")').catch(_ => { });

      page.locator(':has-text("end user license agreement")').waitFor().then(async () => {
        console.log('  Accept End User License Agreement (only needed once)');
        await page.locator('input#agree').check();
        await page.locator('button:has-text("Accept")').click();
      }).catch(_ => { });

      await page.waitForSelector('#webPurchaseContainer iframe');
      const iframe = page.frameLocator('#webPurchaseContainer iframe');
      if (await iframe.locator(':has-text("unavailable in your region")').count() > 0) {
        console.error('  This product is unavailable in your region!');
        db.data[user][game_id].status = notify_game.status = 'unavailable-in-region';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      iframe.locator('.payment-pin-code').waitFor().then(async () => {
        if (!cfg.eg_parentalpin) {
          console.error('  EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
          await notify('epic-games: EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
        }
        await iframe.locator('input.payment-pin-code__input').first().pressSequentially(cfg.eg_parentalpin);
        await iframe.locator('button:has-text("Continue")').click({ delay: 11 });
      }).catch(_ => { });

      if (cfg.debug) await page.pause();
      if (cfg.dryrun) {
        console.log('  DRYRUN=1 -> Skip order!');
        notify_game.status = 'skipped';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      await iframe.locator('button:has-text("Place Order"):not(:has(.payment-loading--loading))').click({ delay: 11 });

      const btnAgree = iframe.locator('button:has-text("I Accept")');
      btnAgree.waitFor().then(() => btnAgree.click()).catch(_ => { });
      try {
        const captcha = iframe.locator('#h_captcha_challenge_checkout_free_prod iframe');
        captcha.waitFor().then(async () => {
          console.error('  Got hcaptcha challenge! You can solve the captcha in the browser or get a new IP address.');
          await notify(`epic-games: got captcha challenge for.\nGame link: ${url}`);
        }).catch(_ => { });
        iframe.locator('.payment__errors:has-text("Failed to challenge captcha, please try again later.")').waitFor().then(async () => {
          console.error('  Failed to challenge captcha, please try again later.');
          await notify('epic-games: failed to challenge captcha. Please check.');
        }).catch(_ => { });
        await page.locator('text=Thanks for your order!').waitFor({ state: 'attached' });
        db.data[user][game_id].status = 'claimed';
        db.data[user][game_id].time = datetime();
        console.log('  Claimed successfully!');
      } catch (e) {
        console.log(e);
        console.error('  Failed to claim! To avoid captchas try to get a new IP address.');
        const p = screenshot('failed', `${game_id}_${filenamify(datetime())}.png`);
        await page.screenshot({ path: p, fullPage: true });
        db.data[user][game_id].status = 'failed';
      }
      notify_game.status = db.data[user][game_id].status;

      const p = screenshot(`${game_id}.png`);
      if (!existsSync(p)) await page.screenshot({ path: p, fullPage: false });
    }
    if (cfg.time) console.timeEnd('claim game');
  }
  if (cfg.time) console.timeEnd('claim all games');
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error);
  if (error.message && process.exitCode != 130) await notify(`epic-games failed: ${error.message.split('\n')[0]}`);
} finally {
  await db.write();
  if (notify_games.filter(g => g.status == 'claimed' || g.status == 'failed').length) {
    await notify(`epic-games (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (cfg.debug) writeFileSync(path.resolve(egBrowserDir, 'cookies.json'), JSON.stringify(await context.cookies()));
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
