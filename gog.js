import chalk from 'chalk';
import { resolve, jsonDb, datetime, filenamify, prompt, notify, html_game_list } from './src/util.js';
import { cfg } from './src/config.js';
import { launchBrowser } from './src/browser.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'gog', ...a);

const URL_CLAIM = 'https://www.gog.com/en';

console.log(datetime(), 'started checking gog');

const db = await jsonDb('gog.json', {});

if (cfg.width < 1280) {
  console.error(`Window width is set to ${cfg.width} but needs to be at least 1280 for GOG!`);
  process.exit(1);
}

const usernameSelector = '#menuUsername, [hook-test="menuUsername"], .menu-username';

const { context, page } = await launchBrowser(cfg.dir.browser, { recordPrefix: 'gog', applyStealth: false });

const waitForUsername = async () => {
  try {
    await page.locator(usernameSelector).first().waitFor({ state: 'attached', timeout: 15000 });
  } catch (_) {
    await page.waitForSelector('[href*="/account"]', { state: 'attached', timeout: cfg.login_timeout });
  }
};
const getUserName = async () => {
  const menuUser = page.locator(usernameSelector);
  if (await menuUser.count() > 0) {
    return (await menuUser.first().textContent()).trim();
  }
  const accountText = await page.evaluate(() => {
    const el = document.querySelector('[hook-test="menuUsername"]') || document.querySelector('.menu-username');
    if (el) return el.textContent?.trim();
    const accountLink = document.querySelector('.menu-header-button__label, [hook-test="menuAccountButton"]');
    if (accountLink) return accountLink.textContent?.trim();
    return null;
  });
  return accountText || 'unknown';
};

const notify_games = [];
let user;

try {
  await context.addCookies([{ name: 'CookieConsent', value: '{stamp:%274oR8MJL+bxVlG6g+kl2we5+suMJ+Tv7I4C5d4k+YY4vrnhCD+P23RQ==%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1672331618201%2Cregion:%27de%27}', domain: 'www.gog.com', path: '/' }]);

  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' });

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);
  const signIn = page.locator('a:has-text("Sign in")').first();
  await Promise.any([
    signIn.waitFor({ state: 'attached', timeout: cfg.timeout }),
    page.locator(usernameSelector).first().waitFor({ state: 'attached', timeout: cfg.timeout }),
    page.locator('[hook-test="menuUsername"], .menu-username').first().waitFor({ state: 'attached', timeout: cfg.timeout }),
    page.waitForSelector('[href*="/account"]', { state: 'attached', timeout: cfg.timeout }),
  ]);
  const checkSignedIn = async () => await page.locator('[hook-test="menuUsername"], .menu-username, [href="/en/account"]').count() > 0;
  while (!(await checkSignedIn()) && await signIn.isVisible()) {
    console.error('Not signed in anymore.');
    await signIn.click();
    await page.waitForSelector('#GalaxyAccountsFrameContainer iframe');
    const iframe = page.frameLocator('#GalaxyAccountsFrameContainer iframe');
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    if (cfg.gog_email && cfg.gog_password) console.info('Using email and password from environment.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const email = cfg.gog_email || await prompt({ message: 'Enter email' });
    const password = email && (cfg.gog_password || await prompt({ type: 'password', message: 'Enter password' }));
    if (email && password) {
      iframe.locator('a[href="/logout"]').click().catch(_ => { });
      await iframe.locator('#login_username').fill(email);
      await iframe.locator('#login_password').fill(password);
      await iframe.locator('#login_login').click();
      iframe.locator('form[name=second_step_authentication]').waitFor().then(async () => {
        console.log('Two-Step Verification - Enter security code');
        console.log(await iframe.locator('.form__description').innerText());
        const otp = await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 4 || 'The code must be 4 digits!' });
        await iframe.locator('#second_step_authentication_token_letter_1').pressSequentially(otp.toString(), { delay: 10 });
        await iframe.locator('#second_step_authentication_send').click();
        await page.waitForTimeout(1000);
      }).catch(_ => { });
      iframe.locator('text=Invalid captcha').waitFor().then(() => {
        console.error('Got a captcha during login (likely due to too many attempts)! You may solve it in the browser, get a new IP or try again in a few hours.');
        notify('gog: got captcha during login. Please check.');
      }).catch(_ => { });
      await waitForUsername();
    } else {
      console.log('Waiting for you to login in the browser.');
      await notify('gog: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node gog` to login in the opened browser.');
        await context.close();
        process.exit(1);
      }
    }
    await waitForUsername();
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  user = await getUserName();
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};

  const banner = page.locator('#giveaway');
  if (!await banner.count()) {
    console.log('Currently no free giveaway!');
  } else {
    const text = await page.locator('.giveaway__content-header').innerText();
    const match_all = text.match(/Claim (.*) and don't miss the|Success! (.*) was added to/);
    const title = match_all[1] ? match_all[1] : match_all[2];
    const url = await banner.locator('a').first().getAttribute('href');
    console.log(`Current free game: ${chalk.blue(title)} - ${url}`);
    db.data[user][title] ||= { title, time: datetime(), url };
    if (cfg.dryrun) process.exit(1);
    await banner.screenshot({ path: screenshot(`${filenamify(title)}.png`) });

    await page.goto('https://www.gog.com/giveaway/claim');
    const response = await page.innerText('body');
    let status;
    if (response == '{}') {
      status = 'claimed';
      console.log('  Claimed successfully!');
    } else {
      const message = JSON.parse(response).message;
      if (message == 'Already claimed') {
        status = 'existed';
        console.log('  Already in library! Nothing to claim.');
      } else {
        console.log(response);
        status = message;
      }
    }
    db.data[user][title].status ||= status;
    notify_games.push({ title, url, status });

    if (status == 'claimed' && !cfg.gog_newsletter) {
      console.log('Unsubscribe from \'Promotions and hot deals\' newsletter');
      await page.goto('https://www.gog.com/en/account/settings/subscriptions');
      await page.locator('li:has-text("Marketing communications through Trusted Partners") label').uncheck();
      await page.locator('li:has-text("Promotions and hot deals") label').uncheck();
    }
  }
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error);
  if (error.message && process.exitCode != 130) await notify(`gog failed: ${error.message.split('\n')[0]}`);
} finally {
  await db.write();
  if (notify_games.filter(g => g.status != 'existed').length) {
    await notify(`gog (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
