import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import path from 'path';
import { existsSync, writeFileSync } from 'fs';
import { resolve, jsonDb, datetime, filenamify, prompt, confirm, notify, html_game_list, handleSIGINT, log } from './src/util.js';
import { cfg } from './src/config.js';
import { getMobileGames } from './src/epic-games-mobile.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'epic-games', ...a);

const URL_CLAIM = 'https://store.epicgames.com/en-US/free-games';
const URL_LOGIN = 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=' + URL_CLAIM;

log.section('Epic Games');
log.status('Time', datetime());

const db = await jsonDb('epic-games.json', {});

if (cfg.time) console.time('startup');

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  // channel: 'chrome', // recommended, but `npx patchright install chrome` clashes with system Chrome - https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs#best-practice----use-chrome-without-fingerprint-injection
  headless: false, // don't use cfg.headless headless here since SHOW=0 will lead to captcha
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/eg-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
  // https://peter.sh/experiments/chromium-command-line-switches/
  args: [
    '--hide-crash-restore-bubble',
    '--ignore-gpu-blocklist', // required for OpenGL: Disabled -> Enabled & WebGL: Software only -> Hardware accelerated
    '--enable-unsafe-webgpu', // required for WebGPU: Disabled -> Hardware accelerated
  ],
  // The following makes the browser crash in docker with 'Chromium sandboxing failed!':
  // chromiumSandbox: true, // https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/issues/52
});

// console.log(context.browser().browserType()); // browser is null...
if (cfg.debug) console.log(chromium.executablePath());

handleSIGINT(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
// await page.setViewportSize({ width: cfg.width, height: cfg.height }); // TODO workaround for https://github.com/vogler/free-games-claimer/issues/277 until Playwright fixes it

// some debug info about the page (screen dimensions, user agent, platform)
if (cfg.debug) console.debug(await page.evaluate(() => [(({ width, height, availWidth, availHeight }) => ({ width, height, availWidth, availHeight }))(window.screen), navigator.userAgent, navigator.platform, navigator.vendor])); // deconstruct screen needed since `window.screen` prints {}, `window.screen.toString()` '[object Screen]', and can't use some pick function without defining it on `page`
if (cfg.debug_network) {
  // const filter = _ => true;
  const filter = r => r.url().includes('store.epicgames.com');
  page.on('request', request => filter(request) && console.log('>>', request.method(), request.url()));
  page.on('response', response => filter(response) && console.log('<<', response.status(), response.url()));
}

const notify_games = [];
let user;

try {
  await context.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), domain: '.epicgames.com', path: '/' }, // Accept cookies to get rid of banner to save space on screen. Set accept time to 5 days ago.
    { name: 'HasAcceptedAgeGates', value: 'USK:9007199254740991,general:18,EPIC SUGGESTED RATING:18', domain: 'store.epicgames.com', path: '/' }, // gets rid of 'To continue, please provide your date of birth', https://github.com/vogler/free-games-claimer/issues/275, USK number doesn't seem to matter, cookie from 'Fallout 3: Game of the Year Edition'
  ]);

  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // 'domcontentloaded' faster than default 'load' https://playwright.dev/docs/api/class-page#page-goto

  if (cfg.time) console.timeEnd('startup');
  if (cfg.time) console.time('login');

  // page.click('button:has-text("Accept All Cookies")').catch(_ => { }); // Not needed anymore since we set the cookie above. Clicking this did not always work since the message was animated in too slowly.
  page.locator('button:has-text("Continue")').click().catch(_ => { }); // already logged in, but need to accept updated "Epic Games Privacy Policy"

  while (await page.locator('egs-navigation').getAttribute('isloggedin') != 'true') {
    log.warn('Not signed in');
    if (cfg.nowait) process.exit(1);
    if (cfg.novnc_port) log.info(`Open http://localhost:${cfg.novnc_port} to login inside the docker container`);
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    log.status('Login timeout', `${cfg.login_timeout / 1000}s`);
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
    if (cfg.eg_email && cfg.eg_password) log.info('Using credentials from environment');
    else log.info('Press ESC to login in browser (not possible in headless mode)');
    const notifyBrowserLogin = async () => {
      log.info('Waiting for you to login in the browser');
      await notify('epic-games: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        log.info('Run `SHOW=1 node epic-games` to login in the opened browser');
        await context.close(); // finishes potential recording
        process.exit(1);
      }
    };
    const email = cfg.eg_email || await prompt({ message: 'Enter email' });
    if (!email) await notifyBrowserLogin();
    else {
      // await page.click('text=Sign in with Epic Games');
      page.waitForSelector('.h_captcha_challenge iframe').then(async () => {
        log.warn('Got captcha during login — solve in browser, get a new IP or try again later');
        await notify('epic-games: got captcha during login. Please check.');
      }).catch(_ => { });
      page.waitForSelector('p:has-text("Incorrect response.")').then(async () => {
        log.warn('Incorrect captcha response');
      }).catch(_ => { });
      await page.fill('#email', email);
      await page.click('button#continue'); // login was split in two steps for some time, then email and password on the same form, now two steps again...
      const password = email && (cfg.eg_password || await prompt({ type: 'password', message: 'Enter password' }));
      if (!password) await notifyBrowserLogin();
      else {
        await page.fill('#password', password);
        await page.click('button#sign-in');
      }
      const error = page.locator('#form-error-message');
      error.waitFor().then(async () => {
        log.fail(`Login error — ${await error.innerText()}`);
        log.info('Please login in the browser');
      }).catch(_ => { });
      // handle MFA, but don't await it
      page.waitForURL('**/id/login/mfa**').then(async () => {
        log.info('Enter the security code — new device/browser/location detected');
        // TODO locator for text (email or app?)
        const otp = cfg.eg_otpkey && authenticator.generate(cfg.eg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await page.locator('input[name="code-input-0"]').pressSequentially(otp.toString());
        await page.click('button[type="submit"]');
      }).catch(_ => { });
    }
    await page.waitForURL(URL_CLAIM);
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  user = await page.locator('egs-navigation').getAttribute('displayname'); // 'null' if !isloggedin
  log.status('User', user);
  db.data[user] ||= {};
  if (cfg.time) console.timeEnd('login');
  if (cfg.time) console.time('claim all games');

  // Detect free games
  const game_loc = page.locator('a:has(span:text-is("Free Now"))');
  await game_loc.last().waitFor().catch(_ => {
    // rarely there are no free games available -> catch Timeout
    // TODO would be better to wait for alternative like 'coming soon' instead of waiting for timeout
    // see https://github.com/vogler/free-games-claimer/issues/210#issuecomment-1727420943
    log.warn('No free games available in your region');
    // urls below should then be an empty list
  });
  // clicking on `game_sel` sometimes led to a 404, see https://github.com/vogler/free-games-claimer/issues/25
  // debug showed that in those cases the href was still correct, so we `goto` the urls instead of clicking.
  // Alternative: parse the json loaded to build the page https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions
  // i.e. filter data.Catalog.searchStore.elements for .promotions.promotionalOffers being set and build URL with .catalogNs.mappings[0].pageSlug or .urlSlug if not set to some wrong id like it was the case for spirit-of-the-north-f58a66 - this is also what's done here: https://github.com/claabs/epicgames-freegames-node/blob/938a9653ffd08b8284ea32cf01ac8727d25c5d4c/src/puppet/free-games.ts#L138-L213
  const urlSlugs = await Promise.all((await game_loc.all()).map(a => a.getAttribute('href')));
  const urls = urlSlugs.map(s => 'https://store.epicgames.com' + s);

  // Free mobile games - https://github.com/vogler/free-games-claimer/issues/474
  // https://egs-platform-service.store.epicgames.com/api/v2/public/discover/home?count=10&country=DE&locale=en&platform=android&start=0&store=EGS
  if (cfg.eg_mobile) {
    log.status('Mobile games', 'included');
    const mobileGames = await getMobileGames(context);
    urls.push(...mobileGames.map(x => x.url));
  }

  const titleCounts = {};
  for (const url of urls) {
    const id = url.split('/').pop();
    const t = db.data[user][id]?.title || id;
    titleCounts[t] = (titleCounts[t] || 0) + 1;
  }
  const uniqueCount = Object.keys(titleCounts).length;
  if (uniqueCount < urls.length) {
    log.status('Free games found', `${uniqueCount} (${urls.length} incl. platform variants)`);
  } else {
    log.status('Free games found', urls.length);
  }
  if (cfg.debug) console.log('  URLs:', urls);
  const loggedTitles = new Set();

  for (const url of urls) {
    if (cfg.time) console.time('claim game');
    const skipId = url.split('/').pop();
    if (db.data[user][skipId]?.status == 'claimed') {
      const knownTitle = db.data[user][skipId]?.title || skipId;
      if (!loggedTitles.has(knownTitle)) {
        const platforms = titleCounts[knownTitle] || 1;
        const platformNote = platforms > 1 ? ` (${platforms} platforms)` : '';
        log.ok(`${knownTitle} — already claimed${platformNote}`);
        loggedTitles.add(knownTitle);
      }
      if (cfg.time) console.timeEnd('claim game');
      continue;
    }
    await page.goto(url); // , { waitUntil: 'domcontentloaded' });
    // when loading, the button text is empty -> need to wait for some text {'get', 'in library', 'requires base game'} -> just wait for e or i to not be too specific; :text-matches("\w+") somehow didn't work - https://github.com/vogler/free-games-claimer/issues/375
    // was using locator('...').first().waitFor(), but that at some point led to exception locator.waitFor: Error: Can't query n-th element
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('button[data-testid="purchase-cta-button"]');
        return btn && /[ei]/i.test(btn.textContent) && btn.textContent != 'Loading';
      }
    );
    const purchaseBtn = page.locator('button[data-testid="purchase-cta-button"]').first();
    const btnText = (await purchaseBtn.innerText()).toLowerCase(); // barrier to block until page is loaded

    // click Continue if 'This game contains mature content recommended only for ages 18+'
    if (await page.locator('button:has-text("Continue")').count() > 0) {
      if (cfg.debug) console.log('  This game contains mature content recommended only for ages 18+');
      if (await page.locator('[data-testid="AgeSelect"]').count()) {
        log.warn('Got unexpected age gate — please report to https://github.com/vogler/free-games-claimer/issues/275');
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
      // h1 first didn't exist for bundles but now it does... However h1 would e.g. be 'Fallout® Classic Collection' instead of 'Fallout Classic Collection'
      try {
        bundle_includes = await Promise.all((await page.locator('.product-card-top-row h5').all()).map(b => b.innerText()));
      } catch (e) {
        if (cfg.debug) console.error('Failed to get "Bundle Includes":', e);
      }
    } else {
      title = await page.locator('h1').first().innerText();
    }
    const game_id = page.url().split('/').pop();
    const existedInDb = db.data[user][game_id];
    db.data[user][game_id] ||= { title, time: datetime(), url: page.url() }; // this will be set on the initial run only!
    if (bundle_includes) log.info(`${title} includes: ${bundle_includes.join(', ')}`);
    const notify_game = { title, url, status: 'failed' };
    notify_games.push(notify_game); // status is updated below

    if (btnText == 'in library') {
      log.ok(`${title} — already in library`);
      notify_game.status = 'existed';
      db.data[user][game_id].status ||= 'existed'; // does not overwrite claimed or failed
      if (db.data[user][game_id].status.startsWith('failed')) db.data[user][game_id].status = 'manual'; // was failed but now it's claimed
    } else if (btnText == 'requires base game') {
      log.skip(title, 'requires base game');
      notify_game.status = 'requires base game';
      notify_game.details = `Game: ${url}`;
      db.data[user][game_id].status ||= 'failed:requires-base-game';
      // TODO claim base game if it is free
      const baseUrl = 'https://store.epicgames.com' + await page.locator('a:has-text("Overview")').getAttribute('href');
      log.info(`Base game — ${baseUrl}`);
      // await page.click('a:has-text("Overview")');
      // TODO handle this via function call for base game above since this will never terminate if DRYRUN=1
      urls.push(baseUrl); // add base game to the list of games to claim
      urls.push(url); // add add-on itself again
    } else { // GET
      log.info(`${title} — claiming (${btnText})`);
      let captchaDetected = false;
      await purchaseBtn.click({ delay: 11 }); // got stuck here without delay (or mouse move), see #75, 1ms was also enough

      // click Continue if 'Device not supported. This product is not compatible with your current device.' - avoided by Windows userAgent?
      page.click('button:has-text("Continue")').catch(_ => { }); // needed since change from Chromium to Firefox?

      // click 'Yes, buy now' if 'This edition contains something you already have. Still interested?'
      page.click('button:has-text("Yes, buy now")').catch(_ => { });

      // Accept End User License Agreement (only needed once)
      page.locator(':has-text("end user license agreement")').waitFor().then(async () => {
        log.info('Accepting End User License Agreement');
        if (cfg.debug) console.log(page.innerHTML);
        if (cfg.debug) console.log('Please report the HTML above here: https://github.com/vogler/free-games-claimer/issues/371');
        await page.locator('input#agree').check(); // TODO Bundle: got stuck here; likely unrelated to bundle and locator just changed: https://github.com/vogler/free-games-claimer/issues/371
        await page.locator('button:has-text("Accept")').click();
      }).catch(_ => { });

      // it then creates an iframe for the purchase
      await page.waitForSelector('#webPurchaseContainer iframe'); // TODO needed?
      const iframe = page.frameLocator('#webPurchaseContainer iframe');
      // skip game if unavailable in region, https://github.com/vogler/free-games-claimer/issues/46 TODO check games for account's region
      if (await iframe.locator(':has-text("unavailable in your region")').count() > 0) {
        log.skip(title, 'unavailable in your region');
        db.data[user][game_id].status = notify_game.status = 'unavailable-in-region';
        notify_game.details = `Game: ${url}`;
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      iframe.locator('.payment-pin-code').waitFor().then(async () => {
        if (!cfg.eg_parentalpin) {
          log.warn('EG_PARENTALPIN not set — enter Parental Control PIN manually');
          notify('epic-games: EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
        }
        await iframe.locator('input.payment-pin-code__input').first().pressSequentially(cfg.eg_parentalpin);
        await iframe.locator('button:has-text("Continue")').click({ delay: 11 });
      }).catch(_ => { });

      if (cfg.debug) await page.pause();
      if (cfg.dryrun) {
        log.warn('dry run — skipping claim');
        notify_game.status = 'skipped';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }
      if (cfg.interactive && !await confirm()) {
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }

      // Playwright clicked before button was ready to handle event, https://github.com/vogler/free-games-claimer/issues/84#issuecomment-1474346591
      await iframe.locator('button:has-text("Place Order"):not(:has(.payment-loading--loading))').click({ delay: 11 });

      // I Agree button is only shown for EU accounts! https://github.com/vogler/free-games-claimer/pull/7#issuecomment-1038964872
      const btnAgree = iframe.locator('button:has-text("I Accept")');
      btnAgree.waitFor().then(() => btnAgree.click()).catch(_ => { }); // EU: wait for and click 'I Agree'
      try {
        // context.setDefaultTimeout(100 * 1000); // give time to solve captcha, iframe goes blank after 60s?
        const captcha = iframe.locator('#h_captcha_challenge_checkout_free_prod iframe');
        captcha.waitFor().then(async () => { // don't await, since element may not be shown
          captchaDetected = true;
          log.warn('Got hCaptcha challenge — solve in browser or get a new IP address');
          await notify(`epic-games: got captcha challenge for ${title}.\nGame link: ${url}`);
        }).catch(_ => { }); // may time out if not shown
        iframe.locator('.payment__errors:has-text("Failed to challenge captcha, please try again later.")').waitFor().then(async () => {
          log.fail('Failed captcha challenge — try again later');
          await notify(`epic-games: failed captcha challenge for ${title}.\nGame link: ${url}`);
        }).catch(_ => { });
        await page.locator('text=Thanks for your order!').waitFor({ state: 'attached' }); // TODO Bundle: got stuck here, but normal game now as well
        db.data[user][game_id].status = 'claimed';
        db.data[user][game_id].time = datetime(); // claimed time overwrites failed/dryrun time
        log.ok(`${title} — claimed!`);
        // context.setDefaultTimeout(cfg.timeout);
      } catch (e) {
        log.fail(`${title} — failed to claim`);
        if (cfg.debug) console.error(e);
        const p = screenshot('failed', `${game_id}_${filenamify(datetime())}.png`);
        await page.screenshot({ path: p, fullPage: true });
        db.data[user][game_id].status = 'failed';
        if (captchaDetected || await iframe.locator('#h_captcha_challenge_checkout_free_prod iframe').count().catch(() => 0) > 0) {
          captchaDetected = true;
          notify_game.captcha = true;
        }
      }
      notify_game.status = db.data[user][game_id].status; // claimed or failed
      if (notify_game.status === 'failed') {
        if (captchaDetected) {
          notify_game.details = `Captcha blocked claim — will retry. Game: ${url}`;
        } else {
          notify_game.details = `Game: ${url}`;
        }
      }

      const p = screenshot(`${game_id}.png`);
      if (!existsSync(p)) await page.screenshot({ path: p, fullPage: false }); // fullPage is quite long...
    }
    if (cfg.time) console.timeEnd('claim game');
  }

  const captchaRetries = notify_games.filter(g => g.captcha && g.status === 'failed');
  if (captchaRetries.length) {
    log.info(`Retrying ${captchaRetries.length} captcha-failed game(s) in 60s...`);
    await page.waitForTimeout(60000);
    for (const retry of captchaRetries) {
      log.info(`Retrying ${retry.title}...`);
      try {
        await page.goto(retry.url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () => {
            const btn = document.querySelector('button[data-testid="purchase-cta-button"]');
            return btn && /[ei]/i.test(btn.textContent) && btn.textContent != 'Loading';
          }
        );
        const purchaseBtn = page.locator('button[data-testid="purchase-cta-button"]').first();
        const btnText = (await purchaseBtn.innerText()).toLowerCase();
        if (btnText === 'in library') {
          log.ok(`${retry.title} — claimed (already in library after retry)`);
          retry.status = 'claimed';
          retry.details = '';
          retry.captcha = false;
          const game_id = page.url().split('/').pop();
          db.data[user][game_id].status = 'claimed';
          continue;
        }
        if (btnText !== 'get') {
          log.fail(`${retry.title} — unexpected button: ${btnText}`);
          retry.status = 'failed';
          retry.details = `Retry also failed. Game: ${retry.url}`;
          continue;
        }
        log.info(`${retry.title} — claiming (retry)`);
        await purchaseBtn.click({ delay: 11 });
        page.click('button:has-text("Continue")').catch(_ => { });
        page.click('button:has-text("Yes, buy now")').catch(_ => { });
        await page.waitForSelector('#webPurchaseContainer iframe');
        const iframe = page.frameLocator('#webPurchaseContainer iframe');
        const btnAgree = iframe.locator('button:has-text("I Accept")');
        btnAgree.waitFor().then(() => btnAgree.click()).catch(_ => { });
        await iframe.locator('button:has-text("Place Order"):not(:has(.payment-loading--loading))').click({ delay: 11 });
        await page.locator('text=Thanks for your order!').waitFor({ state: 'attached' });
        const game_id = page.url().split('/').pop();
        db.data[user][game_id].status = 'claimed';
        db.data[user][game_id].time = datetime();
        log.ok(`${retry.title} — claimed on retry!`);
        retry.status = 'claimed';
        retry.details = '';
        retry.captcha = false;
      } catch (e) {
        log.fail(`${retry.title} — retry failed`);
        if (cfg.debug) console.error(e);
        retry.details = `Retry also failed. Game: ${retry.url}`;
      }
    }
  }
} catch (error) {
  process.exitCode ||= 1;
  log.fail(`Exception: ${error.message || error}`);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode != 130) await notify(`epic-games failed: ${error.message.split('\n')[0]}`);
} finally {
  if (cfg.time) console.timeEnd('claim all games');
  await db.write();
  log.sectionEnd();
  if (notify_games.filter(g => g.status == 'claimed' || g.status == 'failed').length) {
    await notify(`epic-games (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (cfg.debug) writeFileSync(path.resolve(cfg.dir.browser, 'cookies.json'), JSON.stringify(await context.cookies()));
if (page.video()) log.info(`Recorded video — ${await page.video().path()}`);
await context.close();
