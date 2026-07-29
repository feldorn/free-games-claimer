import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import { existsSync } from 'fs';
import { resolve, jsonDb, datetime, filenamify, prompt, confirm, notify, html_game_list, closeContextSafely, log } from './src/util.js';
import { launchContext } from './src/browser.js';
import { cfg } from './src/config.js';
import { siteVersion } from './src/sites.js';

// FAB (fab.com) is Epic's unified 3D-content marketplace. Each month it
// gives away a set of "Limited-Time Free" assets that can be permanently
// added to your library. FAB authenticates through Epic's OAuth, so this
// script reuses the same persistent browser profile and Epic credentials
// as epic-games.js — when Epic runs earlier in the claim chain the SSO
// session is already warm and no second login is needed.
//
// Scaffolded (v0.1): fab.com is a React SPA whose DOM/labels drift; the
// selectors below are written defensively with text-match fallbacks and a
// per-asset try/catch so one bad listing can't sink the whole run. Expect
// to iterate on selectors as Epic updates the store — same lifecycle as
// the other 0.1 entries in this repo.

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'fab', ...a);

const URL_HOME = 'https://www.fab.com/';
const URL_FREE = cfg.fab_page_url || 'https://www.fab.com/limited-time-free'; // FAB_PAGE_URL override
const URL_ME = 'https://www.fab.com/i/users/me';

log.section(`FAB (v${siteVersion('fab')})`);

const db = await jsonDb('fab.json', {});

if (cfg.time) console.time('startup');

const { context, page } = await launchContext('fab', {
  // headless:false — like Epic, headless triggers captcha on the shared Epic login
  contextOptions: { headless: false },
  extraArgs: ['--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
});

if (cfg.debug) console.log(chromium.executablePath());

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const notify_assets = [];
let user;

// Resolve the signed-in FAB user. The whole site (page + /i/ API) sits
// behind Cloudflare, so a non-OK response from the session endpoint can be
// a bot-challenge rather than a real auth signal — we therefore treat the
// API as a POSITIVE-ONLY source (it can confirm a name, never deny login)
// and let the rendered DOM make the logged-out decision. Caller must be on
// a fab.com page already so the DOM check is meaningful. Returns the
// display name (or a generic label) when signed in, null when signed out.
const readUser = async () => {
  // Positive ID via FAB's own session endpoint — page.request inherits the
  // context cookies + Cloudflare clearance the live browser already earned.
  try {
    const res = await page.request.get(URL_ME, { timeout: 10000 });
    if (res.ok()) {
      const data = await res.json().catch(() => null);
      const name = data && (data.username || data.sellerName || data.name || data.email);
      if (name) return String(name).trim();
    }
  } catch { /* fall through to DOM */ }
  // DOM decision: an authenticated FAB header has no *visible* Sign In
  // control. FAB's sign-in is an icon-only avatar button exposing
  // aria-label="Sign in" (no text), so match the aria-label, not just text.
  // Count visible matches only — FAB keeps hidden auth nodes in the DOM that
  // would otherwise trip a plain .count() into a false "logged out".
  try {
    const sel = '[aria-label="Sign in" i], a[href*="/login" i], button:has-text("Sign In"), a:has-text("Sign In")';
    const n = await page.locator(sel).count();
    let visible = 0;
    for (let i = 0; i < n; i++) if (await page.locator(sel).nth(i).isVisible().catch(() => false)) visible++;
    if (visible === 0) return 'Epic account'; // logged in, name unavailable
  } catch { /* treat as signed out */ }
  return null;
};

// Best-effort cookie-consent dismissal — FAB occasionally shows an overlay
// that would otherwise intercept clicks. Fire-and-forget.
const dismissCookieBanner = () => {
  page.locator('button:has-text("Accept All"), button:has-text("Accept all"), button:has-text("Accept All Cookies"), #onetrust-accept-btn-handler')
    .first().click({ timeout: 3000 }).catch(() => {});
};

const notifyBrowserLogin = async () => {
  log.info('Waiting for you to login in the browser');
  await notify('fab: no longer signed in and not enough options set for automatic login.');
  if (cfg.headless) {
    log.info('Run `SHOW=1 node fab` to login in the opened browser');
    await context.close();
    process.exit(1);
  }
};

// Drive Epic's OAuth login form. FAB → "Sign In" redirects (full page) to
// epicgames.com/id/login, so the selectors here mirror epic-games.js.
const loginEpic = async () => {
  await page.waitForURL(/epicgames\.com\/id\//i, { timeout: cfg.login_timeout }).catch(() => {});
  if (cfg.eg_email && cfg.eg_password) log.info('Using Epic credentials from environment');
  else log.info('Press ESC to login in browser (not possible in headless mode)');

  const email = cfg.eg_email || await prompt({ message: 'Enter Epic email' });
  if (!email) {
    await notifyBrowserLogin();
    return;
  }

  page.waitForSelector('.h_captcha_challenge iframe').then(async () => {
    log.warn('Got captcha during login — solve in browser, get a new IP or try again later');
    const panelLink = cfg.public_url ? `${cfg.public_url}/?focus=captcha` : '';
    await notify(`fab: got captcha during login. Please check.${panelLink ? '<br>' + panelLink : ''}`, { priority: cfg.captcha_notify_priority || 'high', kind: 'action' });
  }).catch(() => {});

  await page.fill('#email', email);
  await page.click('button#continue');
  const password = cfg.eg_password || await prompt({ type: 'password', message: 'Enter Epic password' });
  if (!password) {
    await notifyBrowserLogin();
    return;
  }
  await page.fill('#password', password);
  await page.click('button#sign-in');

  // "Is this the right account?" on new device/IP/fingerprint — fire-and-forget.
  page.waitForSelector('button#yes, button[aria-label="Yes, continue"]', { timeout: 30000 })
    .then(btn => btn.click({ delay: 111 })).catch(() => {});

  // MFA — don't await.
  page.waitForURL('**/id/login/mfa**').then(async () => {
    log.info('Enter the security code — new device/browser/location detected');
    const otp = cfg.eg_otpkey && authenticator.generate(cfg.eg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' });
    await page.locator('input[name="code-input-0"]').pressSequentially(otp.toString());
    await page.click('button[type="submit"]');
  }).catch(() => {});
};

try {
  await page.goto(URL_FREE, { waitUntil: 'domcontentloaded' });
  dismissCookieBanner();

  if (cfg.time) console.timeEnd('startup');
  if (cfg.time) console.time('login');

  user = await readUser();
  while (!user) {
    log.warn('Not signed in');
    if (cfg.nowait) process.exit(1);
    if (cfg.novnc_port) log.info(`Open http://localhost:${cfg.novnc_port} to login inside the docker container`);
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
    log.status('Login timeout', `${cfg.login_timeout / 1000}s`);

    await page.goto(URL_HOME, { waitUntil: 'domcontentloaded' });
    dismissCookieBanner();
    // FAB's sign-in is an icon-only avatar button (aria-label="Sign in").
    const signIn = page.locator('[aria-label="Sign in" i], a[href*="/login" i], a:has-text("Sign In"), button:has-text("Sign In")').first();
    await signIn.click({ delay: 11 }).catch(() => {});
    await loginEpic();

    // Wait to land back on fab.com after the OAuth round-trip.
    await page.waitForURL(/(^|\.)fab\.com/i, { timeout: cfg.login_timeout }).catch(() => {});
    await page.waitForTimeout(3000);
    user = await readUser();
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  log.status('User', user);
  db.data[user] ||= {};
  if (cfg.time) console.timeEnd('login');
  if (cfg.time) console.time('claim all assets');

  // Discover free assets — scrape listing links off the Limited-Time Free
  // page (mirrors Epic's "Free Now" scrape). A FAB API path could replace
  // this later if a stable public endpoint is identified.
  await page.goto(URL_FREE, { waitUntil: 'domcontentloaded' });
  dismissCookieBanner();
  const listingLoc = page.locator('a[href*="/listings/"]');
  await listingLoc.first().waitFor().catch(() => {
    log.warn('No free assets found on the Limited-Time Free page');
  });
  const hrefs = await listingLoc.evaluateAll(els => els.map(e => e.getAttribute('href')));
  const urls = [...new Set(
    hrefs.filter(Boolean)
      .map(h => (h.startsWith('http') ? h : 'https://www.fab.com' + h).split('?')[0].split('#')[0])
      .filter(h => (/\/listings\/[^/]+$/).test(h)),
  )];
  log.status('Free assets found', urls.length);
  if (cfg.debug) console.log('  URLs:', urls);

  // Owned-state probe — once an asset is in your library the action panel
  // shows "Saved in My Library" plus "View in My Library" / "View in
  // Launcher" (and a "Download" for some), and the "Buy now" CTA disappears.
  // Verified against the live logged-in DOM.
  const ownedLoc = () => page.locator('text=/saved in my library|in your library|already in your library|in my library|view in my library|view in launcher/i').first();
  const isOwned = async () => {
    const l = ownedLoc();
    return await l.count() > 0 && await l.isVisible().catch(() => false);
  };

  for (const url of urls) {
    if (cfg.time) console.time('claim asset');
    const id = url.split('/').pop();
    if (db.data[user][id]?.status === 'claimed') {
      const t = db.data[user][id]?.title || id;
      log.owned(t);
      notify_assets.push({ title: t, url, status: 'existed' });
      if (cfg.time) console.timeEnd('claim asset');
      continue;
    }

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      const title = (await page.locator('h1').first().innerText().catch(() => id)).trim() || id;
      db.data[user][id] ||= { title, time: datetime(), url };

      if (await isOwned()) {
        log.owned(title);
        db.data[user][id].status ||= 'existed';
        notify_assets.push({ title, url, status: 'existed' });
        if (cfg.time) console.timeEnd('claim asset');
        continue;
      }

      // Determine the claim CTA. FAB exposes two free flows:
      //  - permanent free assets: a direct "Add to My Library" button.
      //  - Limited-Time Free assets (this script's target): a "Buy now"
      //    purchase discounted -100% to €0. Verified on the live DOM —
      //    owned items instead show "View in Launcher"/"Saved in My Library"
      //    and have no "Buy now".
      // NOTE: an "Add to cart" button is present for free items too, so it
      // must NOT be used to infer "paid" (that was the original bug).
      const addLib = page.locator('button:has-text("Add to My Library"), button:has-text("Add To My Library"), button:has-text("Acquire")').first();
      const buyNow = page.locator('button:has-text("Buy now"), button:has-text("Buy Now")').first();
      const hasAddLib = await addLib.count() > 0 && await addLib.isVisible().catch(() => false);
      const hasBuyNow = await buyNow.count() > 0 && await buyNow.isVisible().catch(() => false);
      // Free verification for the Buy-now path: the license/price box shows
      // "Free*" and/or "-100%". Guards against ever buying a non-free listing.
      const looksFree = await page.locator('text=/-100\\s*%|free\\*/i').first().isVisible().catch(() => false);

      if (!hasAddLib && !(hasBuyNow && looksFree)) {
        if (hasBuyNow) {
          log.skip(title, 'not free (no -100%/Free* badge) — skipping');
        } else {
          log.skip(title, 'no claim CTA ("Add to My Library"/"Buy now") found');
          db.data[user][id].status = 'failed';
          notify_assets.push({ title, url, status: 'failed: no acquire button', details: `<a href="${url}">View asset</a>` });
          const p = screenshot('failed', `${filenamify(id)}_${filenamify(datetime())}.png`);
          if (p) await page.screenshot({ path: p, fullPage: true }).catch(() => {});
        }
        if (cfg.time) console.timeEnd('claim asset');
        continue;
      }
      const acquire = hasAddLib ? addLib : buyNow;
      const viaCheckout = !hasAddLib; // Buy-now path goes through €0 checkout

      const notify_asset = { title, url, status: 'failed' };
      notify_assets.push(notify_asset);

      if (cfg.dryrun) {
        log.warn('dry run — skipping claim');
        notify_asset.status = 'skipped';
        if (cfg.time) console.timeEnd('claim asset');
        continue;
      }
      if (cfg.interactive && !await confirm()) {
        notify_asset.status = 'skipped';
        if (cfg.time) console.timeEnd('claim asset');
        continue;
      }

      log.game(title, viaCheckout ? 'claiming (Buy now → €0 checkout)' : 'claiming');
      await acquire.scrollIntoViewIfNeeded().catch(() => {});
      await acquire.click({ delay: 11 });

      if (viaCheckout) {
        // "Buy now" opens FAB's checkout for the €0 order. Walk it
        // defensively: accept any license/EULA checkbox, then click the
        // final place-order CTA. v2.9.1 broadened the selector coverage
        // and dropped the [role=dialog] scope after ypurpl's #127 showed
        // all Buy-now attempts uniformly failing on live free assets —
        // FAB may render checkout as a full-page nav rather than a modal.
        await page.waitForTimeout(4000);
        const terms = page.locator('[role="dialog"] input[type="checkbox"], input[type="checkbox"][name*="eula" i], input[type="checkbox"][name*="terms" i], input[type="checkbox"][name*="agree" i], form input[type="checkbox"]:not(:checked)').first();
        const termsPresent = await terms.count().catch(() => 0);
        const termsChecked = termsPresent ? await terms.isChecked().catch(() => true) : true;
        if (termsPresent && !termsChecked) {
          await terms.check({ timeout: 4000 }).catch(() => {});
        }
        // Try each candidate label in order; first visible one wins. Logging the
        // match on debug tells us exactly which label FAB is using in production,
        // so the next iteration can prune the list to the real one.
        const candidates = [
          { name: 'Place Order (role)',  loc: page.getByRole('button', { name: /place\s*order/i }).first() },
          { name: 'Complete Order (role)', loc: page.getByRole('button', { name: /complete\s*(order|purchase|checkout)/i }).first() },
          { name: 'Confirm Order (role)', loc: page.getByRole('button', { name: /confirm\s*(order|purchase)?/i }).first() },
          { name: 'Get It Now (role)',   loc: page.getByRole('button', { name: /get\s*it\s*now/i }).first() },
          { name: 'Checkout (role)',      loc: page.getByRole('button', { name: /^checkout$|proceed\s*to\s*checkout/i }).first() },
          { name: 'Place Order (text)',  loc: page.locator('button:has-text("Place Order"), button:has-text("Place order")').first() },
          { name: 'Complete Order (text)', loc: page.locator('button:has-text("Complete Order"), button:has-text("Complete order"), button:has-text("Complete Purchase")').first() },
          { name: 'Confirm (text)',       loc: page.locator('button:has-text("Confirm")').first() },
          { name: 'Get It Now (text)',   loc: page.locator('button:has-text("Get it now"), button:has-text("Get It Now"), button:has-text("Get for free")').first() },
          { name: 'Dialog Buy Now',       loc: page.locator('[role="dialog"] button:has-text("Buy now"), [role="dialog"] button:has-text("Buy Now")').first() },
        ];
        // Wait up to 15s for ANY candidate to be visible, then click it.
        const raceStart = Date.now();
        let picked = null;
        while (Date.now() - raceStart < 15000) {
          for (const c of candidates) {
            const n = await c.loc.count().catch(() => 0);
            if (n > 0 && await c.loc.isVisible().catch(() => false)) {
              picked = c;
              break;
            }
          }
          if (picked) break;
          await page.waitForTimeout(400);
        }
        if (picked) {
          if (cfg.debug) console.log(`  place-order CTA matched: ${picked.name}`);
          await picked.loc.click({ delay: 11 }).catch(() => {});
        } else if (cfg.debug) {
          console.log('  no place-order CTA matched any known label — capturing full URL:', page.url());
        }
      }

      // Success: the listing flips to an owned state ("Saved in My Library" /
      // "View in Launcher"). Re-check inline first, then re-navigate to the
      // listing as a fallback before deciding.
      let claimed = false;
      try {
        await page.locator('text=/saved in my library|added to (my )?library|in your library|view in launcher|view in my library/i').first().waitFor({ state: 'visible', timeout: cfg.timeout });
        claimed = true;
      } catch {
        // v2.9.1: capture the actual failed-checkout state BEFORE the fallback
        // re-nav overwrites it — otherwise every failure screenshot shows the
        // clean product page (see ypurpl's #127). This is our only window into
        // what FAB's checkout flow actually rendered.
        const pFail = screenshot('failed', `${filenamify(id)}_checkout_${filenamify(datetime())}.png`);
        if (pFail) await page.screenshot({ path: pFail, fullPage: true }).catch(() => {});
        if (cfg.debug) console.log(`  claim wait timed out — URL at failure: ${page.url()}`);
        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        claimed = await isOwned();
      }

      if (claimed) {
        db.data[user][id].status = 'claimed';
        db.data[user][id].time = datetime();
        notify_asset.status = 'claimed';
        log.ok(`${title} — claimed!`);
        const p = screenshot(`${filenamify(id)}.png`);
        if (p && !existsSync(p)) await page.screenshot({ path: p }).catch(() => {});
      } else {
        throw new Error('claim confirmation not detected');
      }
    } catch (e) {
      if (cfg.debug) console.error(e);
      const last = notify_assets[notify_assets.length - 1];
      if (last && last.url === url && last.status !== 'existed') {
        last.status = 'failed';
        last.details = `<a href="${url}">View asset</a>`;
      }
      if (db.data[user][id]) db.data[user][id].status = 'failed';
      log.fail(`${db.data[user][id]?.title || id} — failed to claim`);
      const p = screenshot('failed', `${filenamify(id)}_${filenamify(datetime())}.png`);
      if (p) await page.screenshot({ path: p, fullPage: true }).catch(() => {});
    }
    if (cfg.time) console.timeEnd('claim asset');
  }

  log.summary({
    siteId: 'fab',
    claimed: notify_assets.filter(g => g.status === 'claimed').length,
    skipped: notify_assets.filter(g => g.status === 'skipped').length,
    display: 'alreadyOwned',
    alreadyOwned: notify_assets.filter(g => g.status === 'existed').length,
    failed: notify_assets.filter(g => g.status.startsWith('failed')).length,
  });
} catch (error) {
  process.exitCode ||= 1;
  log.exception(error);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode != 130) await notify(`fab failed: ${error.message.split('\n')[0]}`, { attachLatestScreenshot: true });
} finally {
  if (cfg.time) console.timeEnd('claim all assets');
  await db.write();
  if (notify_assets.filter(g => g.status === 'claimed' || g.status.startsWith('failed') || g.status === 'action').length) {
    const hasActionable = notify_assets.some(g => g.status.startsWith('failed') || g.status === 'action');
    await notify(`fab (${user}):<br>${html_game_list(notify_assets)}`, { kind: hasActionable ? 'action' : 'summary' });
  }
}
if (page.video()) log.info(`Recorded video — ${await page.video().path()}`);
await closeContextSafely(context);
