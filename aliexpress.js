// import { firefox } from 'playwright-firefox';
import { chromium } from 'patchright';
import { datetime, filenamify, prompt, handleSIGINT } from './src/util.js';
import { cfg } from './src/config.js';

// can probably be removed and hard-code headers for mobile view
import { FingerprintInjector } from 'fingerprint-injector';
import { FingerprintGenerator } from 'fingerprint-generator';

const { fingerprint, headers } = new FingerprintGenerator().getFingerprint({
  devices: ['mobile'],
  operatingSystems: ['android'],
});

const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  // viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators -> done via /en in URL
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/aliexpress-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
  // e.g. for coins, mobile view is needed, otherwise it just says to install the app
  userAgent: fingerprint.navigator.userAgent,
  viewport: {
    width: fingerprint.screen.width,
    height: fingerprint.screen.height,
  },
  extraHTTPHeaders: {
    'accept-language': headers['accept-language'],
  },
  // https://peter.sh/experiments/chromium-command-line-switches/
  args: [
    '--hide-crash-restore-bubble',
  ],
});
handleSIGINT(context);
// await stealth(context);
await new FingerprintInjector().attachFingerprintToPlaywright(context, { fingerprint, headers });

context.setDefaultTimeout(cfg.debug ? 0 : cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist

const auth = async url => {
  console.log('auth', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // no longer redirects if not authed, but replaces content -> click button "Log in" which then redirects
  const loginBtn = page.locator('button:has-text("Log in")');
  const loggedIn = page.locator('h3:text-is("day streak")');
  await Promise.race([loginBtn.waitFor().then(async () => {
    // offer manual login
    console.error('Not logged in! Will wait for 120s for you to login in the browser or terminal...');
    context.setDefaultTimeout(120 * 1000);
    // and try automated
    await loginBtn.click();
    page.getByRole('button', { name: 'Accept cookies' }).click().then(_ => console.log('Accepted cookies')).catch(_ => { });
    page.locator('span:has-text("Switch account")').click().catch(_ => {}); // sometimes no longer logged in, but previous user/email is pre-selected -> in this case we want to go back to the classic login
    const login = page.locator('#root'); // not universal: .content, .nfm-login
    const email = cfg.ae_email || await prompt({ message: 'Enter email' });
    const emailInput = login.locator('input[label="Email or phone number"]');
    await emailInput.fill(email);
    await emailInput.blur(); // otherwise Continue button stays disabled
    const continueButton = login.locator('button:has-text("Continue")');
    await continueButton.click({ force: true }); // normal click waits for button to no longer be covered by their suggestion menu, so we have to force click somewhere for the menu to close and then click
    const password = email && (cfg.ae_password || await prompt({ type: 'password', message: 'Enter password' }));
    await login.locator('input[label="Password"]').fill(password);
    await login.locator('button:has-text("Sign in")').click();
    // TODO handle failed login
    const error = login.locator('.nfm-login-input-error-text');
    error.waitFor().then(async _ => console.error('Login error (please restart):', await error.innerText())).catch(_ => console.log('No login error.'));
    await page.waitForURL(u => u.toString().startsWith('https://www.aliexpress.com/'));
    context.setDefaultTimeout(cfg.debug ? 0 : cfg.timeout);
    console.log('Logged in!'); // this should still be printed, but isn't...
  }), loggedIn.waitFor()]); // some alternative element which is only there once logged in
};

// copied URLs from AliExpress app on tablet which has menu for the used webview
const urls = {
  // only work with mobile view:
  coins: 'https://m.aliexpress.com/p/coin-index/index.html',
  grow: 'https://m.aliexpress.com/p/ae_fruit/index.html', // firefox: stuck at 60% loading, chrome: loads, but canvas
  gogo: 'https://m.aliexpress.com/p/gogo-match-cc/index.html', // closes firefox?!
  // only show notification to install the app
  euro: 'https://m.aliexpress.com/p/european-cup/index.html', // doesn't load
  merge: 'https://m.aliexpress.com/p/merge-market/index.html',
};

// need to start to wait for responses from API already before auth()
const pre_auth = {
  coins: async _ => {
    console.log('Checking coins...');
    let userCoinsNum; // can make this global or pass as arg if needed; for now we just log the value
    let d; // response data (log in case of exception)
    // coins are only present as rotating digits in DOM -> no easy way to get value
    // number of coins are retrieved via POST to https://acs.aliexpress.com/h5/mtop.aliexpress.coin.execute/1.0/?jsv=2.6.1&appKey=...&t=1753253986320&sign=...&api=mtop.aliexpress.coin.execute&v=1.0&post=1&type=originaljson&dataType=jsonp -> .data.data.find(d => d.name == 'userCoinsNum').value
    // however, there are two requests with same method/URL (usually the first is what we need, but sometimes it comes second) which only differ in the opaque value of the sign URL param
    await page.waitForResponse(r => r.request().method() == 'POST' && r.url().startsWith('https://acs.aliexpress.com/h5/mtop.aliexpress.coin.execute/')).then(async r => {
      d = await r.json();
      d = d.data.data;
      if (Array.isArray(d)) userCoinsNum = d.find(e => e.name == 'userCoinsNum')?.value;
      console.log('Total (coins):', userCoinsNum);
    }).catch(e => console.error('Total (coins): error:', e, 'data:', d));
  },
};

const coins = async () => {
  console.log('Collecting coins...');
  page.locator('.hideDoubleButton').click().catch(_ => {});
  const collectBtn = page.locator('button:has-text("Collect")');
  const moreBtn = page.locator('button:has-text("Earn more coins")');
  await Promise.race([
    // need force because button is visable and enabled but not stable (changes size)
    collectBtn.click({ force: true }).then(_ => console.log('Collected coins for today!')),
    moreBtn.waitFor().then(_ => console.log('No more coins to collect today!')),
  ]);
  // print more info
  const streak = Number(await page.locator('h3:text-is("day streak")').locator('xpath=..').locator('div span').innerText());
  console.log('Streak (days):', streak);
  const tomorrow = Number((await page.locator(':text("coins tomorrow")').innerText()).replace(/Get (\d+) check-in coins tomorrow!/, '$1'));
  console.log('Tomorrow (coins):', tomorrow);
  // console.log(await page.locator('.marquee-content:has-text(" coins")').first().innerText());
  const euro = await page.locator(':text("€")').first().innerText(); // TODO get coins value from somewhere (composed of rotating digits in divs...)
  console.log('Total (€):', euro);
};

// const grow = async () => {
//   await page.pause();
// };
//
// const gogo = async () => {
//   await page.pause();
// };
//
// const euro = async () => {
//   await page.pause();
// };
//
// const merge = async () => {
//   await page.pause();
// };

try {
  // await coins();
  await [
    coins,
    // grow,
    // gogo,
    // euro,
    // merge,
  ].reduce((a, f) => a.then(async _ => {
    const prep = (pre_auth[f.name] ?? (_ => undefined))(); // start to wait for API responses (if needed for f) before anything else
    await auth(urls[f.name]); // authenticate
    await prep; // after auth (which goes to right url), need to await, otherwise f may finish before prep is done
    await f();
    console.log();
  }), Promise.resolve());

  // await page.pause();
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error); // .toString()?
}
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
