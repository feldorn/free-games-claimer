import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import chalk from 'chalk';
import { resolve, jsonDb, datetime, filenamify, prompt, confirm, notify, html_game_list, handleSIGINT, log } from './src/util.js';
import { cfg } from './src/config.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'prime-gaming', ...a);

// const URL_LOGIN = 'https://www.amazon.de/ap/signin'; // wrong. needs some session args to be valid?
const BASE_URL = 'https://luna.amazon.com';
const URL_CLAIM = `${BASE_URL}/claims/home`;

log.section('Prime Gaming');
log.status('Time', datetime());

const db = await jsonDb('prime-gaming.json', {});

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/pg-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
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
  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // default 'load' takes forever
  // need to wait for some elements to exist before checking if signed in or accepting cookies:
  await Promise.any(['button:has-text("Sign in")', '[data-a-target="user-dropdown-first-name-text"]'].map(s => page.waitForSelector(s)));
  page.click('[aria-label="Cookies usage disclaimer banner"] button:has-text("Accept Cookies")').catch(_ => { }); // to not waste screen space when non-headless, TODO does not work reliably, need to wait for something else first?
  while (await page.locator('button:has-text("Sign in")').count() > 0) {
    log.warn('Not signed in');
    if (cfg.nowait) process.exit(1);
    await page.click('button:has-text("Sign in")');
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    log.status('Login timeout', `${cfg.login_timeout / 1000}s`);
    if (cfg.pg_email && cfg.pg_password) log.info('Using email and password from environment');
    else log.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode)');
    const email = cfg.pg_email || await prompt({ message: 'Enter email' });
    const password = email && (cfg.pg_password || await prompt({ type: 'password', message: 'Enter password' }));
    if (email && password) {
      await page.fill('[name=email]', email);
      await page.click('input[type="submit"]');
      await page.fill('[name=password]', password);
      // await page.check('[name=rememberMe]'); // no longer exists
      await page.click('input[type="submit"]');
      page.waitForURL('**/ap/signin**').then(async () => { // check for wrong credentials
        const error = await page.locator('.a-alert-content').first().innerText();
        if (!error.trim().length) return;
        log.fail(`Login error — ${error}`);
        await notify(`prime-gaming: login: ${error}`);
        await context.close(); // finishes potential recording
        process.exit(1);
      });
      // handle MFA, but don't await it
      page.waitForURL('**/ap/mfa**').then(async () => {
        log.info('Two-Step Verification — enter the OTP from your Authenticator App');
        await page.check('[name=rememberDevice]');
        const otp = cfg.pg_otpkey && authenticator.generate(cfg.pg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await page.locator('input[name=otpCode]').pressSequentially(otp.toString());
        await page.click('input[type="submit"]');
      }).catch(_ => { });
    } else {
      log.info('Waiting for you to login in the browser');
      await notify('prime-gaming: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        log.info('Run `SHOW=1 node prime-gaming` to login in the opened browser');
        await context.close(); // finishes potential recording
        process.exit(1);
      }
    }
    await page.waitForURL(`${BASE_URL}/claims/home?signedIn=true`);
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  user = await page.locator('[data-a-target="user-dropdown-first-name-text"]').first().innerText();
  log.status('User', user);
  // await page.click('button[aria-label="User dropdown and more options"]');
  // const twitch = await page.locator('[data-a-target="TwitchDisplayName"]').first().innerText();
  // console.log(`Twitch user name is ${twitch}`);
  db.data[user] ||= {};

  if (await page.getByRole('button', { name: 'Try Prime' }).count()) {
    log.fail('Not an Amazon Prime member — no games to claim');
    await context.close();
    process.exit(1);
  }

  const waitUntilStable = async (f, act) => {
    let v;
    while (true) {
      const v2 = await f();
      if (cfg.debug) console.log('waitUntilStable', v2);
      if (v == v2) break;
      v = v2;
      await act();
    }
  };
  const scrollUntilStable = async f => await waitUntilStable(f, async () => {
    // await page.keyboard.press('End'); // scroll to bottom to show all games
  // loading all games became flaky; see https://github.com/vogler/free-games-claimer/issues/357
    await page.keyboard.press('PageDown'); // scrolling to straight to the bottom started to skip loading some games
    await page.waitForLoadState('networkidle'); // wait for all games to be loaded
    await page.waitForTimeout(3000); // TODO networkidle wasn't enough to load all already collected games
    // do it again since once wasn't enough...
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(3000);
  });

  await page.click('button[data-type="Game"]');
  const games = page.locator('div[data-a-target="offer-list-FGWP_FULL"]');
  await games.waitFor();
  // await scrollUntilStable(() => games.locator('.item-card__action').count()); // number of games
  await scrollUntilStable(() => page.evaluate(() => document.querySelector('.tw-full-width').scrollHeight)); // height may change during loading while number of games is still the same?
  const alreadyClaimed = await games.locator('p:has-text("Collected")').count();
  log.status('Already claimed (total)', alreadyClaimed);
  // can't use .all() since the list of elements via locator will change after click while we iterate over it
  const internal = await games.locator('.item-card__action:has(button[data-a-target="FGWPOffer"])').all();
  const external = await games.locator('.item-card__action:has(a[data-a-target="FGWPOffer"])').all();
  // bottom to top: oldest to newest games
  internal.reverse();
  external.reverse();
  const sameOrNewPage = async url => {
    const isNew = page.url() != url;
    let p = page;
    if (isNew) {
      p = await context.newPage();
      await p.goto(url, { waitUntil: 'domcontentloaded' });
    }
    return { p, isNew };
  };
  const skipBasedOnTime = async url => {
    // console.log('  Checking time left for game:', url);
    const { p, isNew } = await sameOrNewPage(url);
    const dueDateOrg = await p.locator('.availability-date .tw-bold').innerText();
    const dueDate = new Date(Date.parse(dueDateOrg + ' 17:00'));
    const daysLeft = (dueDate.getTime() - Date.now()) / 1000 / 60 / 60 / 24;
    if (cfg.debug) console.log(' ', await p.locator('.availability-date').innerText(), '->', daysLeft.toFixed(2));
    if (isNew) await p.close();
    return daysLeft > cfg.pg_timeLeft;
  };
  log.status('Unclaimed (Prime Gaming)', internal.length);
  // claim games in internal store
  for (const card of internal) {
    await card.scrollIntoViewIfNeeded();
    const title = await (await card.locator('.item-card-details__body__primary')).innerText();
    const slug = await (await card.locator('a')).getAttribute('href');
    const url = BASE_URL + slug.split('?')[0];
    log.game(title, url);
    if (cfg.pg_timeLeft && await skipBasedOnTime(url)) continue;
    if (cfg.dryrun) continue;
    if (cfg.interactive && !await confirm()) continue;
    await card.locator('.tw-button:has-text("Claim")').click();
    db.data[user][title] ||= { title, time: datetime(), url, store: 'internal' };
    log.ok(`${title} — claimed`);
    notify_games.push({ title, status: 'claimed', url });
    // const img = await card.locator('img.tw-image').getAttribute('src');
    // console.log('Image:', img);
    await card.screenshot({ path: screenshot('internal', `${filenamify(title)}.png`) });
  }
  log.status('Unclaimed (external stores)', external.length);
  // claim games in external/linked stores. Linked: origin.com, epicgames.com; Redeem-key: gog.com, legacygames.com, microsoft
  const external_info = [];
  for (const card of external) { // need to get data incl. URLs in this loop and then navigate in another, otherwise .all() would update after coming back and .elementHandles() like above would lead to error due to page navigation: elementHandle.$: Protocol error (Page.adoptNode)
    const title = await card.locator('.item-card-details__body__primary').innerText();
    const slug = await card.locator('a:has-text("Claim")').first().getAttribute('href');
    const url = BASE_URL + slug.split('?')[0];
    // await (await card.$('text=Claim')).click(); // goes to URL of game, no need to wait
    external_info.push({ title, url });
  }
  // external_info = [ { title: 'Fallout 76 (XBOX)', url: 'https://gaming.amazon.com/fallout-76-xbox-fgwp/dp/amzn1.pg.item.9fe17d7b-b6c2-4f58-b494-cc4e79528d0b?ingress=amzn&ref_=SM_Fallout76XBOX_S01_FGWP_CRWN' } ];
  for (const { title, url } of external_info) {
    log.game(title, url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (cfg.debug) await page.pause();
    const item_text = await page.innerText('[data-a-target="DescriptionItemDetails"]');
    const store = item_text.toLowerCase().replace(/.* on /, '').slice(0, -1);
    log.status('    Store', store);
    if (cfg.pg_timeLeft && await skipBasedOnTime(url)) continue;
    if (cfg.dryrun) continue;
    if (cfg.interactive && !await confirm()) continue;
    await Promise.any([page.click('[data-a-target="buy-box"] .tw-button:has-text("Get game")'), page.click('[data-a-target="buy-box"] .tw-button:has-text("Claim")'), page.click('.tw-button:has-text("Complete Claim")'), page.waitForSelector('[data-a-target="LinkAccountModal"]'), page.waitForSelector('.thank-you-title:has-text("Success")')]); // waits for navigation
    await page.waitForTimeout(2000);
    db.data[user][title] ||= { title, time: datetime(), url, store };
    const notify_game = { title, url };
    notify_games.push(notify_game); // status is updated below
    const isSuccess = await page.locator('text=/You collected this|Success/').count() > 0;
    if (!isSuccess && (await page.locator('[data-a-target="LinkAccountModal"]').count() > 0
       || await page.locator('[data-a-target="LinkAccountButton"]').count() > 0)) {
      log.warn(`Account linking required for ${store}`);
      notify_game.status = `failed: need account linking for ${store}`;
      notify_game.details = `<a href="https://gaming.amazon.com/settings/connections">Link your ${store} account</a>`;
      await notify(`prime-gaming: ${title} requires account linking for ${store}.\nLink your account: https://gaming.amazon.com/settings/connections`);
      db.data[user][title].status = 'failed: need account linking';
      // await page.pause();
      // await page.click('[data-a-target="LinkAccountModal"] [data-a-target="LinkAccountButton"]');
      // TODO login for epic games also needed if already logged in
      // wait for https://www.epicgames.com/id/authorize?redirect_uri=https%3A%2F%2Fservice.link.amazon.gg...
      // await page.click('button[aria-label="Allow"]');
    } else {
      db.data[user][title].status = 'claimed';
      // print code if there is one
      const redeem = {
        // 'origin': 'https://www.origin.com/redeem', // TODO still needed or now only via account linking?
        'gog.com': 'https://www.gog.com/redeem',
        'microsoft store': 'https://account.microsoft.com/billing/redeem',
        xbox: 'https://account.microsoft.com/billing/redeem',
        'legacy games': 'https://www.legacygames.com/primedeal',
      };
      if (store in redeem) { // did not work for linked origin: && !await page.locator('div:has-text("Successfully Claimed")').count()
        const code = await Promise.any([page.inputValue('input[type="text"]'), page.textContent('[data-a-target="ClaimStateClaimCodeContent"]').then(s => s.replace('Your code: ', ''))]); // input: Legacy Games; text: gog.com
        log.ok(`Redeem code — ${chalk.blue(code)}`);
        if (store == 'legacy games') { // may be different URL like https://legacygames.com/primeday/puzzleoftheyear/
          redeem[store] = await page.locator('li:has-text("Click here") a').getAttribute('href'); // full text: Click here to enter your redemption code.
        }
        let redeem_url = redeem[store];
        if (store == 'gog.com') redeem_url += '/' + code; // to log and notify, but can't use for goto below (captcha)
        log.ok(`Redeem URL — ${redeem_url}`);
        db.data[user][title].code = code;
        let redeem_action = 'redeem';
        if (cfg.pg_redeem) { // try to redeem keys on external stores
          log.info(`Trying to redeem ${code} on ${store}`);
          const page2 = await context.newPage();
          await page2.goto(redeem[store], { waitUntil: 'domcontentloaded' });
          if (store == 'gog.com') {
            // await page.goto(`https://redeem.gog.com/v1/bonusCodes/${code}`); // {"reason":"Invalid or no captcha"}
            await page2.fill('#codeInput', code);
            // wait for responses before clicking on Continue and then Redeem
            // first there are requests with OPTIONS and GET to https://redeem.gog.com/v1/bonusCodes/XYZ?language=de-DE
            const r1 = page2.waitForResponse(r => r.request().method() == 'GET' && r.url().startsWith('https://redeem.gog.com/'));
            await page2.click('[type="submit"]'); // click Continue
            // console.log(await page2.locator('.warning-message').innerText()); // does not exist if there is no warning
            const r1t = await (await r1).text();
            const r1j = JSON.parse(r1t);
            const reason = r1j.reason;
            // {"reason":"Invalid or no captcha"}
            // {"reason":"code_used"}
            // {"reason":"code_not_found"}
            if (reason?.includes('captcha')) {
              redeem_action = 'redeem (got captcha)';
              log.warn('Got captcha — could not redeem');
            } else if (reason == 'code_used') {
              redeem_action = 'already redeemed';
              log.info('Code already used');
            } else if (reason == 'code_not_found') {
              redeem_action = 'redeem (not found)';
              log.warn('Code not found');
            } else { // TODO not logged in? need valid unused code to test.
              log.info(`Redeeming ${r1j.products[0].title}`);
              redeem_action = 'redeemed?';
              // then after the click on Redeem there is a POST request which returns json
              // POST https://redeem.gog.com/v1/bonusCodes/XYZ {productIds: ["1408290682"]}
              const r2 = page2.waitForResponse(r => r.request().method() == 'POST' && r.url().startsWith('https://redeem.gog.com/'));
              await page2.click('[type="submit"]'); // click Redeem
              const r2t = await (await r2).text();
              const r2j = JSON.parse(r2t);
              // {"type":"async_processing","checkoutUrl":null}
              if (r2j?.type == 'async_processing') {
                await page2.locator('h1:has-text("Code redeemed successfully!")').waitFor();
                redeem_action = 'redeemed';
                log.ok(`${title} — redeemed on ${store}`);
                db.data[user][title].status = 'claimed and redeemed';
              } else if (r2j?.reason2?.includes('captcha')) {
                redeem_action = 'redeem (got captcha)';
                log.warn('Got captcha — could not redeem');
              } else {
                console.debug(`  Response 1: ${r1t}`);
                console.debug(`  Response 2: ${r2t}`);
                log.warn('Unknown response — please report in https://github.com/vogler/free-games-claimer/issues/5');
              }
            }
          } else if (store == 'microsoft store' || store == 'xbox') {
            log.warn(`Redeem on ${store} is experimental`);
            // await page2.pause();
            if (page2.url().startsWith('https://login.')) {
              log.warn('Not logged in — please redeem the code manually. Waiting 60s for login');
              await page2.waitForTimeout(60 * 1000);
              redeem_action = 'redeem (login)';
            } else {
              const iframe = page2.frameLocator('#redeem-iframe');
              const input = iframe.locator('[name=tokenString]');
              await input.waitFor();
              await input.fill(code);
              const r = page2.waitForResponse(r => r.url().startsWith('https://cart.production.store-web.dynamics.com/v1.0/Redeem/PrepareRedeem'));
              // console.log(await page2.locator('.redeem_code_error').innerText());
              const rt = await (await r).text();
              // {"code":"NotFound","data":[],"details":[],"innererror":{"code":"TokenNotFound",...
              const j = JSON.parse(rt);
              const reason = j?.events?.cart.length && j.events.cart[0]?.data?.reason;
              if (reason == 'TokenNotFound') {
                redeem_action = 'redeem (not found)';
                log.warn('Code not found');
              } else if (j?.productInfos?.length && j.productInfos[0]?.redeemable) {
                await iframe.locator('button:has-text("Next")').click();
                await iframe.locator('button:has-text("Confirm")').click();
                const r = page2.waitForResponse(r => r.url().startsWith('https://cart.production.store-web.dynamics.com/v1.0/Redeem/RedeemToken'));
                const j = JSON.parse(await (await r).text());
                if (j?.events?.cart.length && j.events.cart[0]?.data?.reason == 'UserAlreadyOwnsContent') {
                  redeem_action = 'already redeemed';
                  log.info('Already owned (UserAlreadyOwnsContent)');
                } else { // TODO what's returned on success?
                  redeem_action = 'redeemed';
                  db.data[user][title].status = 'claimed and redeemed?';
                  log.ok(`${title} — redeemed (unconfirmed)`);
                }
              } else { // TODO find out other responses
                redeem_action = 'unknown';
                if (cfg.debug) console.debug(`  Response: ${rt}`);
                log.warn('Unknown response — please report in https://github.com/vogler/free-games-claimer/issues/5');
              }
            }
          } else if (store == 'legacy games') {
            // await page2.pause();
            await page2.fill('[name=coupon_code]', code);
            await page2.fill('[name=email]', cfg.lg_email);
            await page2.fill('[name=email_validate]', cfg.lg_email);
            await page2.uncheck('[name=newsletter_sub]');
            await page2.click('[type="submit"]');
            try {
              // await page2.waitForResponse(r => r.url().startsWith('https://promo.legacygames.com/promotion-processing/order-management.php')); // status code 302
              await page2.waitForSelector('h2:has-text("Thanks for redeeming")');
              redeem_action = 'redeemed';
              db.data[user][title].status = 'claimed and redeemed';
              log.ok(`${title} — redeemed on ${store}`);
            } catch (error) {
              log.fail(`Redeem error — ${error.message || error}`);
              if (cfg.debug) console.error(error);
              redeem_action = 'redeemed?';
              db.data[user][title].status = 'claimed and redeemed?';
            }
          } else {
            log.warn(`Redeem on ${store} not yet implemented`);
          }
          if (cfg.debug) await page2.pause();
          await page2.close();
        }
        notify_game.status = `<a href="${redeem_url}">${redeem_action} on ${store}</a>`;
        if (['redeem', 'redeem (got captcha)', 'redeem (not found)', 'redeem (login)'].includes(redeem_action)) {
          notify_game.details = `Code: ${code}`;
        }
      } else {
        notify_game.status = `claimed on ${store}`;
        db.data[user][title].status = 'claimed';
      }
      // save screenshot of potential code just in case
      await page.screenshot({ path: screenshot('external', `${filenamify(title)}.png`), fullPage: true });
      // console.info('  Saved a screenshot of page to', p);
    }
    // await page.pause();
  }
  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' });
  await page.click('button[data-type="Game"]');

  if (notify_games.length) { // make screenshot of all games if something was claimed
    const p = screenshot(`${filenamify(datetime())}.png`);
    // await page.screenshot({ path: p, fullPage: true }); // fullPage does not make a difference since scroll not on body but on some element
    await scrollUntilStable(() => games.locator('.item-card__action').count());
    const viewportSize = page.viewportSize(); // current viewport size
    await page.setViewportSize({ ...viewportSize, height: 3000 }); // increase height, otherwise element screenshot is cut off at the top and bottom
    await games.screenshot({ path: p }); // screenshot of all claimed games
  }

  // https://github.com/vogler/free-games-claimer/issues/55
  if (cfg.pg_claimdlc) {
    log.info('Checking in-game content (DLC)');
    await page.click('button[data-type="InGameLoot"]');
    const loot = page.locator('div[data-a-target="offer-list-IN_GAME_LOOT"]');
    await loot.waitFor();

    log.status('DLC', 'loading all on page...');
    await scrollUntilStable(() => loot.locator('[data-a-target="item-card"]').count());

    log.status('DLC already claimed', await loot.locator('p:has-text("Collected")').count());

    const cards = await loot.locator('[data-a-target="item-card"]:has(p:text-is("Claim"))').all();
    log.status('DLC unclaimed', cards.length);
    const dlcs = await Promise.all(cards.map(async card => ({
      game: await card.locator('.item-card-details__body p').innerText(),
      title: await card.locator('.item-card-details__body__primary').innerText(),
      url: BASE_URL + await card.locator('a').first().getAttribute('href'),
    })));
    // console.log(dlcs);

    const dlc_unlinked = {};
    for (const dlc of dlcs) {
      const title = `${dlc.game} - ${dlc.title}`;
      const url = dlc.url;
      log.game(title, url);
      if (cfg.debug) await page.pause();
      if (cfg.dryrun) continue;
      if (cfg.interactive && !await confirm()) continue;
      db.data[user][title] ||= { title, time: datetime(), store: 'DLC', status: 'failed: need account linking' };
      const notify_game = { title, url };
      notify_games.push(notify_game); // status is updated below
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        // most games have a button 'Get in-game content'
        // epic-games: Fall Guys: Claim -> Continue -> Go to Epic Games (despite account linked and logged into epic-games) -> not tied to account but via some cookie?
        await Promise.any([page.click('.tw-button:has-text("Get in-game content")'), page.click('.tw-button:has-text("Claim your gift")'), page.click('.tw-button:has-text("Claim")').then(() => page.click('button:has-text("Continue")'))]);
        page.click('button:has-text("Continue")').catch(_ => { });
        const linkAccountButton = page.locator('[data-a-target="LinkAccountButton"]');
        let unlinked_store;
        if (await linkAccountButton.count()) {
          unlinked_store = await linkAccountButton.first().getAttribute('aria-label');
          console.debug('  LinkAccountButton label:', unlinked_store);
          const match = unlinked_store.match(/Link (.*) account/);
          if (match && match.length == 2) unlinked_store = match[1];
        } else if (await page.locator('text=Link game account').count()) { // epic-games only?
          if (cfg.debug) console.error('  Missing account linking (epic-games specific button?):', await page.locator('button[data-a-target="gms-cta"]').innerText()); // TODO needed?
          unlinked_store = 'epic-games';
        }
        if (unlinked_store) {
          log.warn(`Missing account linking — ${unlinked_store}`);
          dlc_unlinked[unlinked_store] ??= [];
          dlc_unlinked[unlinked_store].push(title);
        } else {
          const code = await page.inputValue('input[type="text"]').catch(_ => undefined);
          log.ok(`Redeem code — ${chalk.blue(code)}`);
          db.data[user][title].code = code;
          db.data[user][title].status = 'claimed';
          // notify_game.status = `<a href="${redeem[store]}">${redeem_action}</a> ${code} on ${store}`;
        }
        // await page.pause();
      } catch (error) {
        log.fail(`DLC error — ${error.message || error}`);
        if (cfg.debug) console.error(error);
      } finally {
        await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' });
        await page.click('button[data-type="InGameLoot"]');
      }
    }
    if (Object.keys(dlc_unlinked).length) {
      log.warn(`DLC — unlinked accounts: ${Object.entries(dlc_unlinked).map(([k, v]) => `${k} (${v.length})`).join(', ')}`);
    }
  }
} catch (error) {
  process.exitCode ||= 1;
  log.fail(`Exception: ${error.message || error}`);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode != 130) await notify(`prime-gaming failed: ${error.message.split('\n')[0]}`);
} finally {
  await db.write();
  log.sectionEnd();
  if (notify_games.length) {
    await notify(`prime-gaming (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (page.video()) log.info(`Recorded video — ${await page.video().path()}`);
await context.close();
