import { chromium } from 'patchright';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolve, jsonDb, datetime, filenamify, prompt, confirm, notify, html_game_list, handleSIGINT, log, normalizeTitle, awaitUserCaptchaSolve, cleanProfileLocks, matchKey, stripGpTail, getDiscoveryUserMarkedKeys, delay, localeArgs, dataDir } from './src/util.js';
import { cfg } from './src/config.js';
import { siteVersion } from './src/sites.js';
import { fetchGamerPowerGiveaways, filterFor as filterGpFor, resolveGamerPowerHref } from './src/gamerpower.js';
import { fetchFGFPosts, filterFor as filterFgfFor, cleanTitle as fgfClean } from './src/freegamefindings.js';

// GOG 2FA backup-code consumption. Codes are configured comma-separated
// via GOG_OTP_BACKUP_CODES; used codes are appended to
// data/gog-used-otp-codes.txt and skipped on subsequent runs so a single
// list survives many daily runs without manual bookkeeping. Falls back
// to the existing interactive prompt when the list is empty or exhausted.
const GOG_USED_OTP_FILE = dataDir('gog-used-otp-codes.txt');
function _normalizeOtpCode(s) {
  return String(s || '').replace(/[\s-]+/g, '').toUpperCase();
}
function _loadUsedOtpCodes() {
  try {
    if (!existsSync(GOG_USED_OTP_FILE)) return new Set();
    return new Set(readFileSync(GOG_USED_OTP_FILE, 'utf8')
      .split('\n').map(_normalizeOtpCode).filter(Boolean));
  } catch { return new Set(); }
}
function pickNextOtpBackupCode() {
  const raw = cfg.gog_otp_backup_codes || '';
  if (!raw.trim()) return null;
  const all = raw.split(',').map(_normalizeOtpCode).filter(Boolean);
  const used = _loadUsedOtpCodes();
  return all.find(c => !used.has(c)) || null;
}
function markOtpBackupCodeUsed(code) {
  try {
    mkdirSync(path.dirname(GOG_USED_OTP_FILE), { recursive: true });
    appendFileSync(GOG_USED_OTP_FILE, _normalizeOtpCode(code) + '\n');
  } catch (e) {
    log.warn(`GOG OTP: failed to persist used code (${e.message}) — next run may retry it`);
  }
}

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'gog', ...a);

const URL_CLAIM = 'https://www.gog.com/en';

log.section(`GOG (v${siteVersion('gog')})`);

const db = await jsonDb('gog.json', {});

if (cfg.width < 1280) { // otherwise 'Sign in' and #menuUsername are hidden (but attached to DOM), see https://github.com/vogler/free-games-claimer/issues/335
  log.warn(`Window width ${cfg.width} is below 1280 minimum for GOG`);
  process.exit(1);
}

// https://playwright.dev/docs/auth#multi-factor-authentication
cleanProfileLocks(cfg.dir.browser);
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
    ...localeArgs(),
  ],
});

handleSIGINT(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
await page.setViewportSize({ width: cfg.width, height: cfg.height }); // TODO workaround for https://github.com/vogler/free-games-claimer/issues/277 until Playwright fixes it
// console.debug('userAgent:', await page.evaluate(() => navigator.userAgent));

const notify_games = [];
let user;
// Catalog watch counters surfaced in the run summary. Populated inside the
// catalog watch try block; default null so a watch-skip leaves them out
// of the summary line entirely rather than reporting "0 tracked, 0 new".
let catalogTracked = null;
let catalogNew = null;

try {
  await context.addCookies([{ name: 'CookieConsent', value: '{stamp:%274oR8MJL+bxVlG6g+kl2we5+suMJ+Tv7I4C5d4k+YY4vrnhCD+P23RQ==%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1672331618201%2Cregion:%27de%27}', domain: 'www.gog.com', path: '/' }]); // to not waste screen space when non-headless

  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // default 'load' takes forever

  // page.click('#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll').catch(_ => { }); // does not work reliably, solved by setting CookieConsent above
  const signIn = page.locator('a:has-text("Sign in"), [hook-test="menuAnonymousButton"]').first();
  const loggedInSel = '#menuUsername, [hook-test="menuUsername"], .menu-username, .menu-username-text, a[href*="/account"]';
  const username = page.locator(loggedInSel).first();
  await page.waitForTimeout(3000);
  const isLoggedIn = async () => await username.count() > 0;
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
        log.info('Two-Step Verification detected');
        try { log.info(await iframe.locator('.form__description').innerText()); } catch {}
        // Backup-code branch: if the user configured GOG_OTP_BACKUP_CODES,
        // pick the first unused code, navigate to GOG's backup-code entry
        // page, fill it, and mark it consumed. Falls through to the
        // interactive prompt below if no codes are available / exhausted.
        const backupCode = pickNextOtpBackupCode();
        if (backupCode) {
          log.info(`Using GOG backup code ${backupCode.slice(0, 3)}***** (${backupCode.length} chars)`);
          try {
            await page.goto('https://login.gog.com/login/two_factor/backup', { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(2000);
            // GOG splits backup codes across one input per character. Fill
            // whatever inputs are present in order — matches both the
            // 8-char backup format and any future shape change with the
            // same per-character UX.
            const filled = await page.evaluate((code) => {
              const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'))
                .filter(el => el.offsetParent !== null);
              if (!inputs.length) return 0;
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              for (let i = 0; i < Math.min(inputs.length, code.length); i++) {
                setter.call(inputs[i], code[i]);
                inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
              }
              return Math.min(inputs.length, code.length);
            }, backupCode);
            log.info(`Filled ${filled} backup-code character(s); submitting`);
            await page.locator('button[type="submit"], input[type="submit"]').first().click({ timeout: 5000 }).catch(_ => {});
            await page.waitForTimeout(2000);
            // Verify we left the login page (success heuristic — GOG
            // redirects to www.gog.com on a valid code).
            if (!String(page.url() || '').includes('login.gog')) {
              markOtpBackupCodeUsed(backupCode);
              log.info('GOG backup code accepted — marked as used in data/gog-used-otp-codes.txt');
              return;
            }
            log.warn('GOG backup code did not advance past the login page — falling back to interactive prompt');
          } catch (e) {
            log.warn(`GOG backup-code flow failed (${e.message}) — falling back to interactive prompt`);
          }
        }
        // Existing TOTP / SMS prompt path. Untouched when backup codes
        // are unset or the backup branch above bailed out.
        const otp = await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 4 || 'The code must be 4 digits!' }); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await iframe.locator('#second_step_authentication_token_letter_1').pressSequentially(otp.toString(), { delay: 10 });
        await iframe.locator('#second_step_authentication_send').click();
        await page.waitForTimeout(1000); // TODO still needed with wait for username below?
      }).catch(_ => { });
      // iframe.locator('iframe[title=reCAPTCHA]').waitFor().then(() => {
      // iframe.locator('.g-recaptcha').waitFor().then(() => {
      iframe.locator('text=Invalid captcha').waitFor().then(async () => {
        log.warn('Got captcha during login — solve in browser, get a new IP or try again later');
        await awaitUserCaptchaSolve(page, {
          service: 'gog',
          label: 'Login captcha',
          captchaCheck: () => iframe.locator('text=Invalid captcha').isVisible().catch(() => false),
        });
      }).catch(_ => { });
      await page.waitForSelector(loggedInSel);
    } else {
      log.info('Waiting for you to login in the browser');
      await notify('gog: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        log.info('Run `SHOW=1 node gog` to login in the opened browser');
        await context.close();
        process.exit(1);
      }
    }
    await page.waitForSelector(loggedInSel);
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  // Reported nav-label leaks (in the wild): Games, Orders, Wishlist, Friends,
  // Library, Account, Settings, Reviews, Cart, News, Search, Sign in.
  const navLabelRx = /^(Games|Orders|Wishlist|Friends|Library|Account|Settings|Reviews|Cart|News|Search|Sign\s*in)(\s+\d+)?$/i;
  const cleanCandidate = v => {
    if (!v) return null;
    const t = String(v).replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (navLabelRx.test(t)) {
      log.warn(`Detected username looked like a nav label ("${t}") — discarding`);
      return null;
    }
    return t;
  };
  // userTrustworthy: tracks whether the canonical username came from an
  // authoritative source (API or guarded DOM/cookie) vs. the email-prefix
  // last-resort. Migration below only runs when trustworthy — otherwise
  // we'd consolidate stale keys into another fallback bucket and make
  // things worse. Today's regression report (#9 follow-up): when GOG's
  // chrome rendered "Reviews" instead of the username, the previous fix
  // discarded it and fell to email-prefix → fragmented DB further.
  let userTrustworthy = false;
  // 1. Primary: GOG's own account APIs. page.request inherits browser
  // cookies so a valid session authenticates automatically. Same source the
  // panel's checkLogin uses, which has been reliable across GOG's header
  // redesigns. The DOM path stays as fallback for environments where the
  // APIs ever return non-2xx.
  const apis = [
    'https://menu.gog.com/v1/account/basic',
    'https://www.gog.com/userData.json',
    'https://embed.gog.com/userData.json',
  ];
  for (const endpoint of apis) {
    try {
      const res = await page.request.get(endpoint, { timeout: 10000 });
      if (!res.ok()) continue;
      const data = await res.json();
      const name = data && (data.username || data.userName || data.name);
      const cleaned = cleanCandidate(name);
      if (cleaned) { user = cleaned; userTrustworthy = true; break; }
    } catch { /* try next endpoint */ }
  }
  // 2. DOM #menuUsername direct text — fallback when APIs are all unreachable.
  if (!user) {
    const userSelectors = '#menuUsername, [hook-test="menuUsername"], .menu-username, .menu-username-text';
    const userEl = page.locator(userSelectors).first();
    try {
      await userEl.waitFor({ timeout: 10000 });
      const direct = await userEl.evaluate(el => {
        const t = Array.from(el.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent)
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        if (t) return t;
        return (el.textContent || '').replace(/\s+/g, ' ').trim();
      });
      const cleaned = cleanCandidate(direct);
      if (cleaned) { user = cleaned; userTrustworthy = true; }
    } catch {}
    if (!user) {
      try {
        const title = await page.locator(userSelectors).first().getAttribute('title', { timeout: 5000 });
        const cleaned = cleanCandidate(title);
        if (cleaned) { user = cleaned; userTrustworthy = true; }
      } catch {}
    }
    // Cookie / profile-link — only useful when DOM returns nav-label noise.
    if (!user) {
      try {
        const candidate = await page.evaluate(() => {
          const cookies = document.cookie.split(';');
          for (const c of cookies) {
            const [k, v] = c.trim().split('=');
            if (k === 'gog_username' || k === 'gog-username') return decodeURIComponent(v);
          }
          const profile = document.querySelector('a[href^="/u/"]');
          if (profile) {
            const text = (profile.textContent || '').replace(/\s+/g, ' ').trim();
            if (text) return text;
          }
          return null;
        });
        const cleaned = cleanCandidate(candidate);
        if (cleaned) { user = cleaned; userTrustworthy = true; }
      } catch {}
    }
  }
  // 3. Email-prefix — last resort. Not trustworthy enough for migration.
  if (!user) {
    user = cfg.gog_email?.split('@')[0] || 'unknown';
    log.warn(`Could not detect GOG username — using "${user}"`);
  }
  user = user.replace(/\s+/g, ' ').trim();
  log.status('User', user);

  // One-time DB cleanup: prior detection bugs fragmented one user's claim
  // history across multiple buckets. Migrate unambiguously-bad legacy keys
  // into the canonical bucket. Gate on userTrustworthy — never migrate into
  // an email-prefix fallback bucket. Idempotent: once merged, source keys
  // are deleted so subsequent runs find nothing to migrate.
  if (userTrustworthy) {
    const stale = Object.keys(db.data).filter(k => {
      if (k === user) return false;
      if (k === 'unknown') return true;
      if (navLabelRx.test(k)) return true;
      // Older form before the whitespace safety-net trimmed badge linebreaks.
      if (/^Games\s+\d+$/.test(k.replace(/\s+/g, ' '))) return true;
      return false;
    });
    if (stale.length) {
      log.status('GOG DB cleanup', `merging ${stale.length} legacy username key(s) into "${user}"`);
      db.data[user] ||= {};
      for (const k of stale) {
        const games = db.data[k];
        if (games && typeof games === 'object') {
          for (const [title, entry] of Object.entries(games)) {
            // Canonical user wins on conflict — its entries are likely newer/correct.
            if (!db.data[user][title]) db.data[user][title] = entry;
          }
        }
        delete db.data[k];
      }
      try { await db.write(); }
      catch (e) { log.warn(`GOG DB cleanup write failed: ${e.message}`); }
    }
  }
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
        log.owned(title);
      } else {
        log.warn(`${title} — ${message}`);
        status = message;
      }
    }
    db.data[user][title].status ||= status;
    // Suppress the "(existed)" notification line when the user has
    // already triaged this title via the Discoveries tab.
    const isUserTriagedExisted = status === 'existed' && getDiscoveryUserMarkedKeys().has(`gog::${matchKey(title)}`);
    if (!isUserTriagedExisted) {
      const notify_entry = { title, url, status };
      if (status !== 'claimed' && status !== 'existed') {
        notify_entry.details = `Game: ${url}`;
      }
      notify_games.push(notify_entry);
    }

    if (status == 'claimed' && !cfg.gog_newsletter) {
      log.info('Unsubscribing from newsletters');
      await page.goto('https://www.gog.com/en/account/settings/subscriptions');
      await page.locator('li:has-text("Marketing communications through Trusted Partners") label').uncheck();
      await page.locator('li:has-text("Promotions and hot deals") label').uncheck();
    }
  }

  // Catalog watch — discover GOG games that are free outside the homepage
  // spotlight giveaway flow. Two sources:
  //   1. tags=freegame — GOG's curated "this is a free game offering" tag.
  //      Catches Heartlight-style additions where a paid game becomes
  //      permanently or long-term free without a "discount" flag.
  //   2. price=0 + discounted=true — Steam-style temp 100%-off promos on
  //      otherwise paid games. Currently rare on GOG but worth tracking.
  //
  // Baseline-diff pattern (same as the Ubisoft Connect watcher): first run
  // records the existing free-games list silently and writes the baseline
  // marker; subsequent runs notify only on new additions. Avoids the
  // first-run spam of ~60 notifications for the entire freegame catalog.
  //
  // Notify-only — no auto-claim. The claim UI for catalog items varies
  // ("Add to library" / "Buy with 0.00" / multi-step cart) and we don't
  // have a live promo to test the auto path against. Same juice/squeeze
  // framing as Ubisoft.
  //
  // Failures here are logged and skipped — never block the rest of the run.
  try {
    const watchDb = await jsonDb('gog-catalog-watch.json', { _baseline: false });
    const fetchCatalog = async qs => page.evaluate(async u => {
      const r = await fetch(u, { credentials: 'omit' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return j?.products || [];
    }, `https://catalog.gog.com/v1/catalog?${qs}`);
    const [tagged, discounted] = await Promise.all([
      fetchCatalog('tags=freegame&price=between:0,0&limit=100'),
      fetchCatalog('price=between:0,0&discounted=true&order=desc:discount&limit=50'),
    ]);
    // Dedupe by slug across both sources. Filter to entries with a real
    // slug + title; reject anything we can't construct a usable URL for.
    const bySlug = new Map();
    for (const p of [...tagged, ...discounted]) {
      if (p?.slug && typeof p.slug === 'string' && p?.title) {
        bySlug.set(p.slug, p);
      }
    }
    const free = Array.from(bySlug.values());
    const now = Date.now();
    // Re-notify if a slug hasn't been seen in this long (covers a game
    // going free → ending → going free again months later). 30d is longer
    // than any single GOG promo and shorter than typical repeat-gaps.
    const RENOTIFY_AFTER_MS = 30 * 86400 * 1000;

    if (!watchDb.data._baseline) {
      // First run — record everything currently free as the baseline so
      // we don't fire ~60 notifications on the next run.
      for (const p of free) {
        watchDb.data[p.slug] = {
          title: p.title,
          url: `https://www.gog.com/en/game/${p.slug}`,
          firstSeen: datetime(),
          lastSeenAt: now,
        };
      }
      watchDb.data._baseline = true;
      await watchDb.write();
      catalogTracked = free.length;
      catalogNew = 0;
      log.info(`Catalog watch — baseline established (${free.length} free game(s) recorded silently). Subsequent runs notify on new additions only.`);
    } else {
      const newPromos = [];
      for (const p of free) {
        const existing = watchDb.data[p.slug];
        if (existing?.lastSeenAt && (now - existing.lastSeenAt) < RENOTIFY_AFTER_MS) {
          existing.lastSeenAt = now;
          continue;
        }
        const promoUrl = `https://www.gog.com/en/game/${p.slug}`;
        watchDb.data[p.slug] = {
          title: p.title,
          url: promoUrl,
          firstSeen: datetime(),
          lastSeenAt: now,
        };
        newPromos.push({ title: p.title, url: promoUrl });
      }
      await watchDb.write();
      catalogTracked = free.length;
      catalogNew = newPromos.length;
      if (newPromos.length) {
        log.info(`Catalog watch — ${newPromos.length} new free game(s): ${newPromos.map(g => g.title).join(', ')}`);
        // Bare URLs (no <a href>) so Pushover's HTML-stripping doesn't drop
        // the link entirely. <br> separators render across apprise targets.
        const lines = newPromos.map(g => `${g.title} — ${g.url}`).join('<br>');
        await notify(`GOG: ${newPromos.length} free game${newPromos.length > 1 ? 's' : ''} available<br>${lines}`);
      } else {
        log.info(`Catalog watch — ${free.length} free item(s) tracked, no new additions`);
      }
    }
  } catch (e) {
    log.warn(`Catalog watch skipped — ${e.message}`);
    if (cfg.debug) console.error(e);
  }

  // Supplementary discovery via gamerpower.com — see feldorn#33. Notify-only
  // (same juice/squeeze framing as the catalog watch): GOG claim UIs are too
  // varied to auto-claim safely without a live promo to test against. We
  // resolve each /open/ redirect to capture the canonical gog.com URL when
  // possible, falling back to the GamerPower link.
  try {
    const gpAll = await fetchGamerPowerGiveaways();
    const gpGog = filterGpFor(gpAll, 'gog');
    if (gpGog.length) {
      // Infra breadcrumb — silenced from normal log, DEBUG=1 restores.
      if (cfg.debug) console.debug(`GamerPower (GOG): ${gpGog.length} entry/entries`);
      const userMarked = getDiscoveryUserMarkedKeys();
      // GamerPower/FGF are supplementary discovery — they suggest games
      // to claim manually. If the GOG library scan above already surfaced
      // a game (claimed or already-owned), the manual-claim suggestion is
      // duplicate noise. Dedup by normalized title against notify_games
      // (issue #48, xeropresence: same Warhammer entry was listed twice,
      // once as existed and once as via-FGF).
      const surfacedTitles = () => new Set(
        notify_games.map(g => matchKey(String(g.title || '').replace(/\s*\(via [^)]+\)\s*$/, '')))
      );
      for (const entry of gpGog) {
        const cleanedTitle = stripGpTail(entry.title);
        const dedupKey = `gog::${matchKey(cleanedTitle)}`;
        if (userMarked.has(dedupKey)) {
          log.info(`GamerPower → ${entry.title}: already triaged via Discoveries tab, skipping`);
          continue;
        }
        if (surfacedTitles().has(matchKey(cleanedTitle))) {
          log.info(`GamerPower → ${entry.title}: already in this run's library scan, skipping`);
          continue;
        }
        const resolved = await resolveGamerPowerHref(context, entry.open_giveaway_url, 'gog');
        const url = resolved || entry.open_giveaway_url;
        log.info(`GamerPower → ${entry.title}: ${url}`);
        notify_games.push({ title: `${entry.title} (via GamerPower)`, url, status: 'action', details: `<a href="${url}">Claim manually</a>` });
      }
    }
  } catch (e) {
    log.warn(`GamerPower discovery skipped — ${e.message.split('\n')[0]}`);
  }

  // Supplementary discovery via r/FreeGameFindings — notify-only, same
  // framing as the catalog watch above and the GamerPower block. Reddit
  // gives us direct store URLs so there's no redirect step.
  try {
    const fgfAll = await fetchFGFPosts();
    const fgfGog = filterFgfFor(fgfAll, 'gog');
    if (fgfGog.length) {
      log.status('FreeGameFindings (GOG)', `${fgfGog.length} post(s)`);
      const userMarked = getDiscoveryUserMarkedKeys();
      // See the GamerPower block above — same #48 dedup against
      // notify_games entries from the library scan and the GP loop.
      const surfacedTitles = () => new Set(
        notify_games.map(g => matchKey(String(g.title || '').replace(/\s*\(via [^)]+\)\s*$/, '')))
      );
      for (const post of fgfGog) {
        const cleanedTitle = fgfClean(post.title);
        const dedupKey = `gog::${matchKey(cleanedTitle)}`;
        if (userMarked.has(dedupKey)) {
          log.info(`FGF → ${cleanedTitle}: already triaged via Discoveries tab, skipping`);
          continue;
        }
        if (surfacedTitles().has(matchKey(cleanedTitle))) {
          log.info(`FGF → ${cleanedTitle}: already in this run's library scan, skipping`);
          continue;
        }
        log.info(`FGF → ${cleanedTitle}: ${post.url}`);
        notify_games.push({ title: `${cleanedTitle} (via FGF)`, url: post.url, status: 'action', details: `<a href="${post.url}">Claim manually</a>` });
      }
    }
  } catch (e) {
    // Reddit blocks datacenter IPs — silenced from normal log, DEBUG=1 restores.
    if (cfg.debug) console.debug(`FreeGameFindings discovery skipped — ${e.message.split('\n')[0]}`);
  }

  // Reconcile Prime Gaming's pending GOG codes against the authenticated user's library.
  // Prime only knows whether a code was *delivered*, not whether it was *redeemed* —
  // many codes end up already-used (redeemed manually or by an earlier script version).
  // We fetch the owned-games list here and mark anything we own as redeemed so it drops
  // out of the Prime Gaming pending notification on the next run.
  try {
    const pgDb = await jsonDb('prime-gaming.json', {});
    const candidates = [];
    for (const games of Object.values(pgDb.data)) {
      if (!games || typeof games !== 'object') continue;
      for (const [title, entry] of Object.entries(games)) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.store !== 'gog.com') continue;
        if (!entry.code) continue;
        if (/redeemed|expired|invalid/i.test(String(entry.status || ''))) continue;
        candidates.push({ title, entry });
      }
    }
    if (candidates.length) {
      log.status('Reconciling Prime Gaming codes', `${candidates.length} pending GOG entries`);
      const libraryTitles = new Set();
      let pageNum = 1;
      let totalPages = 1;
      do {
        const body = await page.evaluate(async p => {
          const r = await fetch(`https://www.gog.com/account/getFilteredProducts?mediaType=1&page=${p}&sortBy=title`, { credentials: 'include' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        }, pageNum);
        const j = JSON.parse(body);
        totalPages = j.totalPages || 1;
        for (const product of j.products || []) {
          if (product?.title) libraryTitles.add(normalizeTitle(product.title));
        }
        pageNum++;
      } while (pageNum <= totalPages && pageNum <= 30);
      log.status('GOG library', `${libraryTitles.size} title(s) loaded`);

      let reconciled = 0;
      for (const { title, entry } of candidates) {
        if (libraryTitles.has(normalizeTitle(title))) {
          entry.status = 'claimed and redeemed (verified via GOG library)';
          reconciled++;
          log.ok(`${title} — found in GOG library, marked redeemed`);
        }
      }
      if (reconciled) {
        await pgDb.write();
        log.info(`Reconciled ${reconciled}/${candidates.length} pending Prime Gaming code(s) against GOG library`);
      } else {
        log.info(`No pending Prime Gaming codes matched against library — checking remaining codes against GOG redeem endpoint`);
      }

      // Second pass: for codes still pending after the library reconcile,
      // drive the /redeem page to learn each code's actual state AND
      // attempt the redeem for valid codes. GOG's GET response on the
      // Continue click differentiates code_not_found / code_used / valid /
      // captcha-gated. On `valid`, we now click again to fire the POST and
      // actually redeem (previously this branch just logged "leaving
      // pending"). On `captcha` — GOG's rate-limit signal, not a human-
      // solvable challenge — we wait 90 s and retry the same code ONCE,
      // since the user's own Batch Redeem button typically succeeds after
      // a similar cooldown. If still rate-limited, bump the per-code
      // redeemAttempts counter and skip; the next daily GOG run will
      // retry. After cfg.pg_redeem_max_attempts cross-run retries the
      // code is locked to a terminal "manual intervention" status so it
      // surfaces in the Prime Gaming pending-redeem notification.
      const MAX_REDEEM_ATTEMPTS = Math.max(1, cfg.pg_redeem_max_attempts || 3);
      const RETRY_WAIT_MS = 90 * 1000;
      const stillPending = candidates.filter(({ entry }) => !/redeemed|expired|invalid/i.test(String(entry.status || '')));
      if (stillPending.length) {
        // Skip codes that have already exhausted their retry budget.
        const overBudget = stillPending.filter(({ entry }) => (entry.redeemAttempts || 0) >= MAX_REDEEM_ATTEMPTS);
        for (const { title, entry } of overBudget) {
          if (entry.status !== 'claimed, redeem retries exhausted') {
            entry.status = 'claimed, redeem retries exhausted';
            log.warn(`${title} — exhausted ${MAX_REDEEM_ATTEMPTS} retry attempts; flagged for manual Batch Redeem`);
          }
        }
        const inBudget = stillPending.filter(({ entry }) => (entry.redeemAttempts || 0) < MAX_REDEEM_ATTEMPTS);

        if (inBudget.length) {
          log.status('Probing remaining codes via redeem endpoint', `${inBudget.length}`);
          let probed = 0, notFound = 0, used = 0, redeemed = 0, captcha = 0, queued = 0;
          const probePage = await context.newPage();

          // Single probe+redeem attempt against gog.com/redeem for one code.
          // Returns { outcome, productTitle? } — never throws (caller logs).
          const attemptOne = async (code) => {
            await probePage.goto('https://www.gog.com/redeem', { waitUntil: 'domcontentloaded', timeout: 20000 });
            await probePage.fill('#codeInput', code);
            const r1Promise = probePage.waitForResponse(
              r => r.request().method() === 'GET' && r.url().startsWith('https://redeem.gog.com/v1/bonusCodes/'),
              { timeout: 15000 },
            );
            await probePage.click('[type="submit"]');
            const r1 = await r1Promise;
            const r1t = await r1.text();
            let r1j = {}; try { r1j = JSON.parse(r1t); } catch {}
            const reason1 = String(r1j.reason || '').toLowerCase();
            if (reason1 === 'code_not_found') return { outcome: 'not-found' };
            if (reason1 === 'code_used')      return { outcome: 'used' };
            if (reason1.includes('captcha'))  return { outcome: 'captcha', phase: 'probe' };
            if (r1j?.products?.length) {
              // Valid — click Redeem; GOG fires POST /v1/bonusCodes/<code>.
              const r2Promise = probePage.waitForResponse(
                r => r.request().method() === 'POST' && r.url().startsWith('https://redeem.gog.com/'),
                { timeout: 15000 },
              );
              await probePage.click('[type="submit"]');
              const r2 = await r2Promise;
              const r2t = await r2.text();
              let r2j = {}; try { r2j = JSON.parse(r2t); } catch {}
              if (r2j?.type === 'async_processing') {
                await probePage.locator('h1:has-text("Code redeemed successfully!")').waitFor({ timeout: 15000 }).catch(() => {});
                return { outcome: 'redeemed', productTitle: r1j.products?.[0]?.title || null };
              }
              const reason2 = String(r2j.reason2 || r2j.reason || '').toLowerCase();
              if (reason2.includes('captcha')) return { outcome: 'captcha', phase: 'redeem', productTitle: r1j.products?.[0]?.title || null };
              return { outcome: 'unknown', raw: r2t };
            }
            return { outcome: 'unknown', raw: r1t };
          };

          try {
            for (const { title, entry } of inBudget) {
              try {
                let res = await attemptOne(entry.code);
                // Rate-limit retry: wait 90s + retry ONCE if still in budget.
                if (res.outcome === 'captcha') {
                  log.warn(`${title} — GOG rate-limited (their "captcha" reason at ${res.phase}); waiting ${RETRY_WAIT_MS / 1000}s for cooldown`);
                  await delay(RETRY_WAIT_MS);
                  res = await attemptOne(entry.code);
                }
                probed++;
                if (res.outcome === 'redeemed') {
                  entry.status = 'claimed and redeemed';
                  delete entry.redeemAttempts;
                  redeemed++;
                  log.ok(`${title} — claimed and redeemed on GOG${res.productTitle ? ` (${res.productTitle})` : ''}`);
                } else if (res.outcome === 'used') {
                  if (libraryTitles.has(normalizeTitle(title))) {
                    entry.status = 'claimed and redeemed (verified via GOG)';
                    delete entry.redeemAttempts;
                    used++;
                    log.ok(`${title} — already redeemed on GOG (in library), marked redeemed`);
                  } else {
                    entry.status = 'claimed, code consumed but not in library (likely expired)';
                    delete entry.redeemAttempts;
                    notFound++;
                    log.warn(`${title} — GOG says code_used but title not in library, marked expired`);
                  }
                } else if (res.outcome === 'not-found') {
                  entry.status = 'claimed, code expired or invalid';
                  delete entry.redeemAttempts;
                  notFound++;
                  log.warn(`${title} — code not found on GOG, marked invalid`);
                } else if (res.outcome === 'captcha') {
                  entry.redeemAttempts = (entry.redeemAttempts || 0) + 1;
                  captcha++;
                  if (entry.redeemAttempts >= MAX_REDEEM_ATTEMPTS) {
                    entry.status = 'claimed, redeem retries exhausted';
                    log.warn(`${title} — still rate-limited after ${RETRY_WAIT_MS / 1000}s retry, hit ${MAX_REDEEM_ATTEMPTS}-attempt cap; flagged for manual Batch Redeem`);
                    break; // GOG's clearly still throttling — stop hammering further codes this run
                  } else {
                    queued++;
                    log.warn(`${title} — still rate-limited (attempt ${entry.redeemAttempts}/${MAX_REDEEM_ATTEMPTS}); queued for next daily run`);
                    break; // same rationale — back off for the rest of this run
                  }
                } else {
                  if (cfg.debug) console.debug(`  Probe response for ${title}:`, res.raw);
                  log.info(`${title} — unknown response, leaving pending`);
                }
              } catch (err) {
                log.warn(`${title} — redeem error: ${err.message.split('\n')[0]}`);
              }
            }
          } finally {
            await probePage.close();
          }
          if (notFound || used || redeemed || captcha) {
            await pgDb.write();
            const parts = [];
            if (redeemed) parts.push(`${redeemed} redeemed`);
            if (used)     parts.push(`${used} already redeemed`);
            if (notFound) parts.push(`${notFound} invalid/expired`);
            if (queued)   parts.push(`${queued} queued for retry`);
            if (captcha && !queued) parts.push(`${captcha} captcha-gated`);
            log.info(`Probed ${probed}: ${parts.join(', ')}`);
          }
        }
        if (overBudget.length) {
          await pgDb.write();
        }
      }
    }
  } catch (e) {
    log.warn(`Library reconcile skipped — ${e.message}`);
    if (cfg.debug) console.error(e);
  }

  log.summary({
    siteId: 'gog',
    claimed: notify_games.filter(g => g.status === 'claimed').length,
    skipped: 0,
    display: 'tracked',
    tracked: catalogTracked || 0,
    alreadyOwned: notify_games.filter(g => g.status === 'existed').length,
    new: catalogNew || 0,
  });
} catch (error) {
  process.exitCode ||= 1;
  log.exception(error);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode != 130) await notify(`gog failed: ${error.message.split('\n')[0]}`, { attachLatestScreenshot: true });
} finally {
  await db.write();
  if (notify_games.filter(g => g.status != 'existed').length) {
    // Tag as 'summary' only when nothing in the list needs user action —
    // failures promote it back to 'action' so xh43k's "actions only"
    // mode still surfaces them. (#31)
    const hasActionable = notify_games.some(g => g.status === 'failed' || g.status === 'action');
    await notify(`gog (${user}):<br>${html_game_list(notify_games)}`, { kind: hasActionable ? 'action' : 'summary' });
  }
}
if (page.video()) log.info(`Recorded video — ${await page.video().path()}`);
await context.close();
