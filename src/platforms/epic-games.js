import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import path from 'path';
import { existsSync, writeFileSync } from 'fs';
import { resolve, jsonDb, datetime, filenamify, prompt, confirm, notify, html_game_list, closeContextSafely, log } from '#src/util.js';
import { launchContext, gotoWithRetry } from '#src/browser.js';
import { cfg } from '#src/config.js';
import { siteVersion } from '#src/sites.js';
import { getMobileGames } from '#src/epic-games-mobile.js';
import { fetchGamerPowerGiveaways, filterFor as filterGpFor, resolveGamerPowerHref, unhandledPlatforms as gpUnhandled } from '#src/gamerpower.js';
import { fetchFGFPosts, filterFor as filterFgfFor, unhandledPlatforms as fgfUnhandled, cleanTitle as fgfClean } from '#src/freegamefindings.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'epic-games', ...a);

const URL_CLAIM = cfg.eg_page_url || 'https://store.epicgames.com/en-US/free-games'; // EG_PAGE_URL override
const URL_LOGIN = 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=' + URL_CLAIM;
const URL_PROMOTIONS = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US';

// Locale-portable text matchers for Epic's checkout flow. English is
// the baseline; other locales added as they surface in user reports.
// Extend a regex here (comma-separated in the pattern group) to add a
// new locale — both the main claim path and the retry pass consume
// these constants, so one edit covers both. Steggl's #141 added the
// German variants (2026-08-06). `i` flag makes each case-insensitive.
const RX_CONTINUE = /^(Continue|Weiter|Continuer|Continuar|Continua)$/i;
const RX_YES_BUY_NOW = /Yes,\s*buy\s*now|Ja,\s*jetzt\s*kaufen/i;
const RX_ACCEPT = /^(Accept|I\s*Accept|Akzeptieren|Ich\s*stimme\s*zu)$/i;
const RX_EULA = /end\s*user\s*license\s*agreement|Endbenutzer-Lizenzvereinbarung|Endbenutzerlizenzvertrag/i;
const RX_ADD_LIBRARY = /Add\s*to\s*library|Place\s*Order|Zur\s*Bibliothek\s*hinzufügen|Bestellung\s*abschließen|Jetzt\s*kaufen/i;
const RX_ORDER_SUCCESS = /Thanks for your order|It.?s all yours|Vielen Dank für.*Bestellung|Bestellung erfolgreich|Alles gehört (dir|Ihnen)/i;
const RX_CONTINUE_BROWSING = /Continue\s*browsing|Weiter\s*surfen|Weiter\s*shoppen/i;
const RX_DOWNLOAD_LAUNCHER = /Download\s*Launcher|Launcher\s*herunterladen/i;
// Locale-portable "already owned" strings. Same table Steggl's OTXO
// fix uses at the initial CTA check; kept module-scope so both paths
// can share it.
const OWNED_TEXTS_GLOBAL = [
  'in library', 'in der bibliothek', 'en biblioteca', 'en la biblioteca',
  'dans la bibliothèque', 'in libreria', 'in biblioteca', 'na biblioteca',
  'w bibliotece', 'kütüphanede', 'ライブラリ内', '라이브러리에 있음',
  '在库中', '在資料庫中',
];
// Shared predicate. Hoisted v2.11.7 so the initial check, the recheck,
// the success race, and the recovery probe all agree on what "owned" is.
// The `loading` filter was previously present in the recovery-probe copy
// only — code-review flagged the drift. Now all callers get it uniformly.
const isOwnedText = (t) => t && t !== 'loading' && OWNED_TEXTS_GLOBAL.some(w => t === w || t.startsWith(w));

// v2.11.15 (2026-08-28 feldorn11906 run): Epic's post-successful-claim
// modal "FINAL STEP — Is Epic Games Launcher installed?" (labels "No, get
// launcher" / "Yes, it's installed") stays open when the next iteration's
// page.goto fires, and its embedded assets keep the page's `load` event
// from firing. Result: page.goto times out at 60s and the whole Epic
// pass errors out — Rival Stars Horse Racing claimed fine, then Together
// After Dark's page.goto to https://store.epicgames.com/p/breathedge
// hung on `waiting until "load"` because Rival Stars' modal was still up.
// Fix: probe for the modal after every successful claim and dismiss it.
// Best-effort — race a few known labels + a fallback aria-label close.
// Zero cost when the modal isn't there (all locators short-circuit at
// count() === 0). No error path — dismiss failure is silent by design;
// the next goto's domcontentloaded wait will still succeed.
const RX_LAUNCHER_MODAL_HEADING = /final\s*step|is\s*epic\s*games\s*launcher\s*installed|Letzter\s*Schritt|Ist\s*der\s*Epic\s*Games\s*Launcher/i;
async function dismissLauncherModal(page) {
  if (page.isClosed()) return;
  try {
    // Heading probe first — cheap check, avoids spurious close-button
    // clicks on any modal that happens to have an X in the top-right.
    const heading = page.getByText(RX_LAUNCHER_MODAL_HEADING).first();
    if (!(await heading.count().catch(() => 0))) return;
    if (!(await heading.isVisible().catch(() => false))) return;
    // Try in order of specificity — "Yes, it's installed" is the correct
    // click semantically (dismisses without offering the launcher install
    // flow), falls back to the close X, then to Escape.
    const candidates = [
      page.getByRole('button', { name: /^yes,?\s*it/i }),
      page.getByRole('button', { name: /it.?s\s*installed/i }),
      page.getByRole('button', { name: /^close$|schließen/i }),
      page.locator('button[aria-label*="Close" i], button[aria-label*="Schließen" i]').first(),
    ];
    for (const c of candidates) {
      const n = await c.count().catch(() => 0);
      if (!n) continue;
      if (!(await c.isVisible().catch(() => false))) continue;
      await c.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      // If the heading is gone, we won.
      if (!(await heading.isVisible().catch(() => false))) return;
    }
    // Last-resort Escape — some Epic modal variants close on Escape too.
    await page.keyboard.press('Escape').catch(() => {});
  } catch {
    // best-effort: never fail the run because of the launcher upsell
  }
}

log.section(`Epic Games (v${siteVersion('epic-games')})`);

const offerIdMap = {};
try {
  const res = await fetch(URL_PROMOTIONS);
  const data = await res.json();
  for (const el of data?.data?.Catalog?.searchStore?.elements || []) {
    const promos = el.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
    const isFree = promos.some(o => o.discountSetting?.discountPercentage === 0);
    if (!isFree) continue;
    const slug = el.catalogNs?.mappings?.[0]?.pageSlug || el.urlSlug;
    if (slug) offerIdMap[decodeURIComponent(slug).toLowerCase()] = el.id;
  }
  if (Object.keys(offerIdMap).length) {
    log.status('Offer IDs fetched', Object.keys(offerIdMap).length);
  }
} catch (e) {
  log.warn('Could not fetch offer IDs from promotions API');
  if (cfg.debug) console.error(e);
}

const db = await jsonDb('epic-games.json', {});

if (cfg.time) console.time('startup');

// https://playwright.dev/docs/auth#multi-factor-authentication
const { context, page } = await launchContext('epic-games', {
  recordPrefix: 'eg',
  // headless:false — SHOW=0 (headless) leads to captcha on the Epic login.
  contextOptions: { headless: false },
  // --ignore-gpu-blocklist: OpenGL/WebGL software-only -> hardware accelerated.
  // --enable-unsafe-webgpu: WebGPU disabled -> hardware accelerated.
  extraArgs: ['--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
});

// console.log(context.browser().browserType()); // browser is null...
if (cfg.debug) console.log(chromium.executablePath());

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
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
// Epic returns each free game twice — once for PC, once for Mobile (or
// both PC variants for a single title). We process each entry to capture
// per-variant state in the DB, but the human-readable "already in library"
// log line is the same string regardless of variant — collapse repeats so
// the run log isn't visually noisy.
const ownedLogged = new Set();
let user;

// Chromium can tear down the tab, context, or renderer mid-operation —
// either from a container OOM, upstream Epic response that killed the
// tab, forced sign-out, network transport blip, renderer segfault, etc.
// The exception shapes covered here:
//   - `Target (page|context|browser) has been closed` — tab/context gone
//     (JLMael's #104, fl-99's #105 during page.goto)
//   - `Target crashed` — renderer process itself crashed, common on arm64
//     where Chromium has fewer optimized GPU/canvas paths (marlonqpa's
//     #107 during page.screenshot after a claim failure)
//   - `interrupted by another navigation` — competing goto race
//   - `ERR_*` transport family — network layer went away
// Modeled after microsoft.js/isRecoverableMsNavError from #67/#80/#100.
const isRecoverableEpicPageError = (err) => {
  const msg = String(err?.message || err);
  // The literal string Playwright emits is the comma-list form. The
  // single-type alternates are defensive future-proofing in case a
  // Playwright upgrade narrows the message.
  return /Target (page, context or browser|page|context|browser) has been closed/i.test(msg)
      || /Target crashed/i.test(msg)
      || /interrupted by another navigation/i.test(msg)
      || /ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_TIMED_OUT/i.test(msg);
};

// Critical-path gotos only (URL_CLAIM at run start, URL_LOGIN in the sign-in
// flow): one 30s-delayed retry on the transient family above, everything else
// throws at once so real bugs aren't masked. Per-game gotos in the claim loop
// stay retry-free — one bad game shouldn't cost 30s of the batch. (#104, #105)
const EPIC_NAV = { attempts: 2, backoffMs: 30000, isRecoverable: isRecoverableEpicPageError, siteId: 'epic-games' };

try {
  await context.addCookies([
    { name: 'OptanonAlertBoxClosed', value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), domain: '.epicgames.com', path: '/' }, // Accept cookies to get rid of banner to save space on screen. Set accept time to 5 days ago.
    { name: 'HasAcceptedAgeGates', value: 'USK:9007199254740991,general:18,EPIC SUGGESTED RATING:18', domain: 'store.epicgames.com', path: '/' }, // gets rid of 'To continue, please provide your date of birth', https://github.com/vogler/free-games-claimer/issues/275, USK number doesn't seem to matter, cookie from 'Fallout 3: Game of the Year Edition'
  ]);

  // 'domcontentloaded' faster than default 'load' https://playwright.dev/docs/api/class-page#page-goto
  await gotoWithRetry(page, URL_CLAIM, EPIC_NAV);

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
    await gotoWithRetry(page, URL_LOGIN, EPIC_NAV);
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
        const panelLink = cfg.public_url ? `${cfg.public_url}/?focus=captcha` : '';
        const body = `epic-games: got captcha during login. Please check.${panelLink ? '<br>' + panelLink : ''}`;
        await notify(body, { priority: cfg.captcha_notify_priority || 'high', kind: 'action' });
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
      // Handle the "Is this the right account?" confirmation that Epic
      // shows on new-device / new-IP / new-fingerprint logins. Without
      // this auto-click the flow stalls waiting for URL_CLAIM that never
      // arrives, because the prompt is blocking the redirect. Ported from
      // P-Adamiec/free-games-claimer (commit e421633). Fire-and-forget so
      // a never-shown prompt doesn't hold up the rest of the login race.
      page.waitForSelector('button#yes, button[aria-label="Yes, continue"]', { timeout: 30000 }).then(async (btn) => {
        log.info('Got "Is this the right account?" prompt — clicking Yes, continue');
        await btn.click({ delay: 111 });
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

  // Supplementary discovery via gamerpower.com — see feldorn#33. Epic's
  // freeGamesPromotions API + "Free Now" scrape miss third-party indie
  // launch promos (e.g. Devils Island, Lost in the Hole on 2026-05-14).
  // GamerPower aggregates those. We follow each /open/ redirect to capture
  // the canonical store URL; unresolved entries get surfaced as manual
  // actions on the run summary so nothing silently drops.
  //
  // This collector also logs the "unhandled platforms" summary (counts of
  // platforms in the GamerPower response that no current collector handles)
  // — done here because epic-games typically runs first/most-frequently and
  // we only want the report once per run, not once per collector.
  try {
    const gpAll = await fetchGamerPowerGiveaways();
    const gpEpic = filterGpFor(gpAll, 'epic-games');
    if (gpEpic.length) {
      // Infra breadcrumb — silenced from normal log, DEBUG=1 restores.
      if (cfg.debug) console.debug(`GamerPower (Epic): ${gpEpic.length} entry/entries`);
      for (const entry of gpEpic) {
        const resolved = await resolveGamerPowerHref(context, entry.open_giveaway_url, 'epic-games');
        if (resolved) {
          // Some resolved hrefs land on a region-locale subpath
          // (e.g. /en-US/p/) — Epic redirects between locales freely, so
          // we don't normalise.
          if (!urls.includes(resolved)) {
            log.info(`GamerPower → ${entry.title}: ${resolved}`);
            urls.push(resolved);
          }
        } else {
          log.warn(`GamerPower → ${entry.title}: could not resolve store URL — listing as manual action`);
          notify_games.push({ title: `${entry.title} (via GamerPower)`, url: entry.open_giveaway_url, status: 'action', details: `<a href="${entry.open_giveaway_url}">Claim manually</a>` });
        }
      }
    }
    const missed = gpUnhandled(gpAll);
    if (missed.size) {
      const lines = Array.from(missed.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${name} (${n})`)
        .join(', ');
      log.info(`GamerPower — platforms without a collector/watcher: ${lines}`);
    }
  } catch (e) {
    log.warn(`GamerPower discovery skipped — ${e.message.split('\n')[0]}`);
  }

  // Supplementary discovery via r/FreeGameFindings — same coverage goal
  // as GamerPower, different aggregator with often-broader catch (the
  // subreddit indexes a wider set of community-spotted launches). Reddit
  // returns post.url already as the direct store URL (no Cloudflare
  // redirect step), so this is cheaper than GamerPower per entry —
  // single HTTPS request, no browser tab needed. The collectors' own
  // dedupe (urls.includes / knownIds) handles overlap with GamerPower.
  try {
    const fgfAll = await fetchFGFPosts();
    // Desktop slice always runs. The mobile slice only runs when the user
    // has opted into mobile (cfg.eg_mobile / EG_MOBILE=1) — same gate as
    // Epic's own mobile-games API path. Posts in both slices live on
    // store.epicgames.com so they go into the same `urls` queue and
    // get processed by the same claim loop; the existing mobile flow
    // happily handles the iOS/Android URL variants.
    const fgfEpic = filterFgfFor(fgfAll, 'epic-games');
    const fgfEpicMobile = cfg.eg_mobile ? filterFgfFor(fgfAll, 'epic-games-mobile') : [];
    const fgfEpicAll = [...fgfEpic, ...fgfEpicMobile];
    if (fgfEpicAll.length) {
      const mobileNote = fgfEpicMobile.length ? `, ${fgfEpicMobile.length} mobile` : '';
      log.status('FreeGameFindings (Epic)', `${fgfEpicAll.length} post(s) (${fgfEpic.length} desktop${mobileNote})`);
      for (const post of fgfEpicAll) {
        if (urls.includes(post.url)) {
          log.info(`FGF → ${fgfClean(post.title)}: already in queue`);
          continue;
        }
        log.info(`FGF → ${fgfClean(post.title)}: ${post.url}`);
        urls.push(post.url);
      }
    }
    // Pass the user's eg_mobile preference into the unhandled-platforms
    // bucket: when mobile is off, we want `Epic Games Mobile` to show
    // up there as a coverage gap; when it's on, we cover it and it
    // shouldn't appear. The helper checks pattern membership against
    // COLLECTOR_TITLE_PATTERNS, which now includes `epic-games-mobile`.
    // When the user has *not* opted in, filter the helper's output to
    // re-surface that tag as a gap.
    const missed = fgfUnhandled(fgfAll);
    if (!cfg.eg_mobile) {
      // Count Epic Mobile posts ourselves and add them back to `missed`.
      const mobileCount = fgfAll.filter(p => /^\[Epic Games Mobile\]/i.test(p.title)).length;
      if (mobileCount) missed.set('Epic Games Mobile', mobileCount);
    }
    if (missed.size) {
      const lines = Array.from(missed.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${name} (${n})`)
        .join(', ');
      log.info(`FreeGameFindings — platform tags without a collector/watcher: ${lines}`);
    }
  } catch (e) {
    // Reddit blocks datacenter IPs — silenced from normal log, DEBUG=1 restores.
    if (cfg.debug) console.debug(`FreeGameFindings discovery skipped — ${e.message.split('\n')[0]}`);
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
  // Track platform-variant URLs that resolved to a title we already
  // logged this run. Counted across both the DB-fast-path skip below
  // and the page-probe `log.owned` branch in claim_offer, so the body
  // adds up against the upfront `Free games found: N` line (regression
  // 2026-05-14: 6 URLs in, 5 logged, 1 silently deduped — looked like
  // a missing game).
  let dedupedVariants = 0;

  for (const url of urls) {
    if (cfg.time) console.time('claim game');
    const skipId = url.split('/').pop();
    if (db.data[user][skipId]?.status == 'claimed') {
      const knownTitle = db.data[user][skipId]?.title || skipId;
      if (!loggedTitles.has(knownTitle) && !ownedLogged.has(knownTitle)) {
        const platforms = titleCounts[knownTitle] || 1;
        const platformNote = platforms > 1 ? ` (${platforms} platforms)` : '';
        log.ok(`${knownTitle} — already claimed${platformNote}`);
        loggedTitles.add(knownTitle);
        // Push into notify_games so the run summary counts these
        // already-claimed-in-DB titles as 'existed' (i.e. already
        // owned from the user's POV — this run didn't claim them).
        // Without this push, the summary's uniqueByTitle('existed')
        // count missed everything that bailed out via the DB-based
        // fast-path, leaving "1 already owned" when the body listed
        // three titles all-already-in-library (issue: log/summary
        // mismatch reported 2026-05-07).
        notify_games.push({ title: knownTitle, url, status: 'existed' });
      } else {
        dedupedVariants++;
      }
      if (cfg.time) console.timeEnd('claim game');
      continue;
    }
    // Defensive: if the tab/context died since the last iteration, no
    // point trying subsequent gotos in this loop — bail out cleanly so
    // the run summary reflects what got processed instead of crashing
    // the whole Epic pass. (#104 JLMael on 2.8.55.)
    if (page.isClosed()) {
      log.warn('Page closed mid-run — ending Epic claim loop early (remaining games will be picked up on the next scheduled run)');
      break;
    }
    try {
      // v2.11.15: restore `domcontentloaded` (was commented out). Epic
      // sometimes leaves modal iframes/scripts loading long past the DOM
      // being ready — most obviously the post-claim "FINAL STEP" launcher
      // upsell, which pinned `load` on the *previous* page and hung the
      // *next* goto for 60s until timeout. `domcontentloaded` fires as
      // soon as DOM parse is complete, well before those trailing
      // resources, and is more than enough for what we do next (find the
      // purchase CTA — a top-level element rendered synchronously).
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      // Recoverable navigation-transport failure: log with the URL that
      // was in flight (so the next diagnostics submission tells us
      // which game triggered the tear-down) and skip this game. If it's
      // a genuine exception unrelated to browser tear-down, rethrow so
      // the outer error handler still surfaces it as a diagnostic.
      if (isRecoverableEpicPageError(e)) {
        log.fail(`page.goto ${url} — ${String(e.message || e).split('\n')[0]} — skipping this game`);
        notify_games.push({ title: skipId, url, status: 'failed: browser closed / network transient during navigation' });
        if (cfg.time) console.timeEnd('claim game');
        // If the whole page is gone, no subsequent goto in this loop
        // will succeed either — break instead of continue.
        if (page.isClosed()) break;
        continue;
      }
      throw e;
    }
    // when loading, the button text is empty -> need to wait for some text {'get', 'in library', 'requires base game'} -> just wait for e or i to not be too specific; :text-matches("\w+") somehow didn't work - https://github.com/vogler/free-games-claimer/issues/375
    // was using locator('...').first().waitFor(), but that at some point led to exception locator.waitFor: Error: Can't query n-th element
    //
    // Wrapped in try/catch so a single stuck page (Epic occasionally
    // serves a broken / variant layout for some titles — bundles,
    // region-restricted offers, anti-bot slow-walks) doesn't crash the
    // entire Epic claim run before later games in the loop get a
    // chance. Reported by Abateman121's #90 (v2.8.45) — CTA-wait
    // timeout on game #4 of 4 broke the whole Epic pass. URL is
    // logged on failure so the next diagnostics submission identifies
    // which page caused it without needing a debug rerun.
    try {
      await page.waitForFunction(
        () => {
          const btn = document.querySelector('button[data-testid="purchase-cta-button"]');
          return btn && /[ei]/i.test(btn.textContent) && btn.textContent != 'Loading';
        }
      );
    } catch (e) {
      log.fail(`CTA button never loaded for ${url} (${e.message?.split('\n')[0] || e}) — skipping this game`);
      notify_games.push({ title: skipId, url, status: 'failed: CTA never loaded' });
      if (cfg.time) console.timeEnd('claim game');
      continue;
    }
    // Epic momentarily shows "Get" as the placeholder while the ownership
    // lookup resolves; the button flips to "In Library" 1-2s later if you
    // already own the game. Without a settle wait we'd misread "Get",
    // click it, and then time out 60s waiting for a purchase iframe that
    // never appears (because Epic shows the already-owned modal instead).
    // networkidle is best-effort capped at 5s — strictness loses races,
    // we'd rather under-wait than block a healthy page.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
    const purchaseBtn = page.locator('button[data-testid="purchase-cta-button"]').first();
    const btnText = (await purchaseBtn.innerText()).toLowerCase(); // barrier to block until page is loaded
    // v2.11.2: locale-portable already-owned detection. Steggl's #141 —
    // German UI renders "In der Bibliothek" instead of "In library", so
    // the string comparison below missed it; the else-branch then clicked
    // the disabled button and waited 180s for it to enable. Epic disables
    // the purchase CTA the moment ownership resolves, regardless of
    // locale, so the disabled attribute is the reliable structural signal.
    // Text-based detection stays as the primary path (fast, doesn't need
    // an extra roundtrip) and locale variants are matched below; disabled
    // state is the fallback catch-all.
    const btnDisabled = await purchaseBtn.isDisabled().catch(() => false);
    // v2.11.7: use the shared isOwnedText predicate. Pre-click check still
    // adds the disabled-attribute as a positive signal (that's a valid
    // already-owned indicator BEFORE any click — post-click loading spinner
    // trap was fixed in v2.11.4).
    const btnTextIndicatesOwned = isOwnedText(btnText);
    const isOwnedByButton = btnTextIndicatesOwned || btnDisabled;

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

    if (isOwnedByButton) {
      // Log the exact text on disabled-only paths so we can extend
      // OWNED_TEXTS if a locale slips through. Suppressed on English
      // matches to avoid log noise on the common path.
      if (!btnTextIndicatesOwned && btnDisabled) {
        log.info(`Detected already-owned via disabled button (text was "${btnText}") — extend OWNED_TEXTS in epic-games.js to match this locale`);
      }
      if (!ownedLogged.has(title) && !loggedTitles.has(title)) {
        log.owned(title);
        ownedLogged.add(title);
      } else {
        dedupedVariants++;
      }
      notify_game.status = 'existed';
      db.data[user][game_id].status ||= 'existed'; // does not overwrite claimed or failed
      if (db.data[user][game_id].status.startsWith('failed')) db.data[user][game_id].status = 'manual'; // was failed but now it's claimed
    } else if (btnText == 'requires base game') {
      log.skip(title, 'requires base game');
      notify_game.status = 'requires base game';
      notify_game.details = `<a href="${url}">View game</a>`;
      db.data[user][game_id].status ||= 'failed:requires-base-game';
      // TODO claim base game if it is free
      const baseUrl = 'https://store.epicgames.com' + await page.locator('a:has-text("Overview")').getAttribute('href');
      log.info(`Base game — ${baseUrl}`);
      // await page.click('a:has-text("Overview")');
      // TODO handle this via function call for base game above since this will never terminate if DRYRUN=1
      urls.push(baseUrl); // add base game to the list of games to claim
      urls.push(url); // add add-on itself again
    } else { // GET
      // Last-second re-check before we commit to clicking — covers the
      // case where networkidle returned but Epic's ownership state was
      // still loading; the button can flip from "Get" to "In Library"
      // any time before user interaction. Uses the same locale-portable
      // detection as the primary path above (disabled attribute + text
      // variants).
      const recheckText = (await purchaseBtn.innerText().catch(() => btnText)).toLowerCase();
      const recheckDisabled = await purchaseBtn.isDisabled().catch(() => false);
      const recheckOwned = isOwnedText(recheckText) || recheckDisabled;
      if (recheckOwned) {
        log.ok(`${title} — already in library (lagged ownership state)`);
        notify_game.status = 'existed';
        db.data[user][game_id].status ||= 'existed';
        if (db.data[user][game_id].status.startsWith('failed')) db.data[user][game_id].status = 'manual';
        if (cfg.time) console.timeEnd('claim game');
        continue;
      }
      log.game(title, `claiming (${btnText})`);
      let captchaDetected = false;
      await purchaseBtn.click({ delay: 11 }); // got stuck here without delay (or mouse move), see #75, 1ms was also enough

      // click Continue if 'Device not supported. This product is not compatible with your current device.' - avoided by Windows userAgent?
      page.locator('button').filter({ hasText: RX_CONTINUE }).first().click().catch(_ => { });

      // click 'Yes, buy now' if 'This edition contains something you already have. Still interested?'
      page.locator('button').filter({ hasText: RX_YES_BUY_NOW }).first().click().catch(_ => { });

      // Accept End User License Agreement (only needed once). EULA phrasing
      // varies per locale, so match on the regex above rather than a
      // literal English string.
      page.getByText(RX_EULA).first().waitFor().then(async () => {
        log.info('Accepting End User License Agreement');
        if (cfg.debug) console.log(page.innerHTML);
        if (cfg.debug) console.log('Please report the HTML above here: https://github.com/vogler/free-games-claimer/issues/371');
        await page.locator('input#agree').check(); // TODO Bundle: got stuck here; likely unrelated to bundle and locator just changed: https://github.com/vogler/free-games-claimer/issues/371
        await page.locator('button').filter({ hasText: RX_ACCEPT }).first().click();
      }).catch(_ => { });

      // The whole flow from "wait for purchase iframe" through "Thanks for
      // your order!" lives in one try — Epic occasionally shows a different
      // UI than the purchase iframe (e.g. an "already owned" modal for a
      // listing the storefront mislabeled as Get), and a 60s timeout on
      // waitForSelector below used to bubble up and kill the whole run.
      // iframe is declared in the outer scope so the catch can still poll
      // captcha state without re-entering the iframe locator.
      let iframe;
      try {
        // it then creates an iframe for the purchase
        await page.waitForSelector('#webPurchaseContainer iframe'); // TODO needed?
        iframe = page.frameLocator('#webPurchaseContainer iframe');
        // skip game if unavailable in region, https://github.com/vogler/free-games-claimer/issues/46 TODO check games for account's region
        if (await iframe.locator(':has-text("unavailable in your region")').count() > 0) {
          log.skip(title, 'unavailable in your region');
          db.data[user][game_id].status = notify_game.status = 'unavailable-in-region';
          notify_game.details = `<a href="${url}">View game</a>`;
          if (cfg.time) console.timeEnd('claim game');
          continue;
        }

        iframe.locator('.payment-pin-code').waitFor().then(async () => {
          if (!cfg.eg_parentalpin) {
            log.warn('EG_PARENTALPIN not set — enter Parental Control PIN manually');
            notify('epic-games: EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
          }
          await iframe.locator('input.payment-pin-code__input').first().pressSequentially(cfg.eg_parentalpin);
          await iframe.locator('button').filter({ hasText: RX_CONTINUE }).first().click({ delay: 11 });
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
        // Epic relabeled the confirm button from "Place Order" → "Add to
        // library" around 2026-05-28 (reported by @amphoterism on #59) —
        // every claim silently timed out because the old selector no
        // longer matched. Accept either text so we stay resilient if Epic
        // flips back or surfaces "Place Order" in some regions/flows.
        // Locale variants added for Steggl's #141 followup — German
        // (Zur Bibliothek hinzufügen / Bestellung abschließen / Jetzt kaufen).
        // Extend RX_ADD_LIBRARY at the top of this block for other locales.
        await iframe.locator('button').filter({ hasText: RX_ADD_LIBRARY }).filter({ hasNot: iframe.locator('.payment-loading--loading') }).first().click({ delay: 11 });

        // I Agree button is only shown for EU accounts! https://github.com/vogler/free-games-claimer/pull/7#issuecomment-1038964872
        const btnAgree = iframe.locator('button').filter({ hasText: RX_ACCEPT });
        btnAgree.waitFor().then(() => btnAgree.first().click()).catch(_ => { }); // EU: wait for and click 'I Agree'
        // context.setDefaultTimeout(100 * 1000); // give time to solve captcha, iframe goes blank after 60s?
        const captcha = iframe.locator('#h_captcha_challenge_checkout_free_prod iframe');
        captcha.waitFor().then(async () => { // don't await, since element may not be shown
          captchaDetected = true;
          log.warn('Got hCaptcha challenge — solve in browser or get a new IP address');
          // Include the panel deep-link (?focus=captcha auto-opens the
          // browser view on the active service) so tapping the push
          // takes the user straight to where they need to be. Game link
          // kept as a secondary line for context. Priority is configurable
          // via Settings → Notifications → Captcha priority (default
          // high so it punches through DnD — captchas have minutes
          // before the iframe times out).
          const panelLink = cfg.public_url ? `${cfg.public_url}/?focus=captcha` : '';
          const body = `epic-games: got captcha challenge for ${title} — solve now${panelLink ? '<br>' + panelLink : ''}<br>Game: ${url}`;
          await notify(body, { priority: cfg.captcha_notify_priority || 'high', kind: 'action' });
        }).catch(_ => { }); // may time out if not shown
        iframe.locator('.payment__errors:has-text("Failed to challenge captcha, please try again later.")').waitFor().then(async () => {
          log.fail('Failed captcha challenge — try again later');
          const panelLink = cfg.public_url ? `${cfg.public_url}/?focus=captcha` : '';
          const body = `epic-games: failed captcha challenge for ${title}${panelLink ? '<br>' + panelLink : ''}<br>Game: ${url}`;
          await notify(body, { priority: cfg.captcha_notify_priority || 'high', kind: 'action', attachLatestScreenshot: true });
        }).catch(_ => { });
        // Race three success signals — whichever fires first wins. Epic's
        // post-purchase modal copy drifts (was "Thanks for your order!",
        // refreshed to "It's all yours" in 2026, may change again), and
        // when the modal text-match misses, the script wastes the full
        // cfg.timeout (60s default) waiting on a selector that never
        // resolves. Two more-reliable signals run in parallel: the CTA
        // flipping to "In Library" is the ground-truth success state
        // independent of modal copy, and the modal's "Continue browsing"
        // button is a stable per-popup identifier even if the heading
        // text changes. Refs #21, #23.
        // v2.11.3: locale-portable success signals — regex-based text
        // matchers + disabled-attribute CTA state. Steggl's #141 followup
        // needed this: the primary claim ran to the Add-to-Library click
        // in German but the success-race then timed out because the modal
        // text and the CTA-flip check were still English-only.
        // v2.11.4: dropped the `if (btn.disabled) return true` short-circuit
        // that v2.11.3 added — that state also fires during Epic's post-click
        // loading spinner, causing the race to resolve as "success" while the
        // claim is still processing (Steggl's #141 followup: log says
        // "claimed!" 20-30s in but games weren't actually in library).
        // Success signal is now text-only via the locale-portable regexes:
        // modal-copy match OR CTA text transitioning to a known "owned"
        // string. Both are only true AFTER Epic confirms the purchase.
        await Promise.race([
          page.getByText(RX_ORDER_SUCCESS).first().waitFor({ state: 'attached' }),
          page.locator('button').filter({ hasText: new RegExp(RX_CONTINUE_BROWSING.source + '|' + RX_DOWNLOAD_LAUNCHER.source, 'i') }).first().waitFor({ state: 'visible' }),
          // Same owned-text semantics as the shared isOwnedText predicate,
          // inlined here because waitForFunction runs in the browser context
          // where the helper isn't reachable. Kept in sync via OWNED_TEXTS_GLOBAL.
          page.waitForFunction((ownedList) => {
            const btn = document.querySelector('button[data-testid="purchase-cta-button"]');
            if (!btn) return false;
            const txt = (btn.innerText || '').trim().toLowerCase();
            if (!txt || txt === 'loading') return false;
            return ownedList.some(t => txt === t || txt.startsWith(t));
          }, { timeout: cfg.timeout }, OWNED_TEXTS_GLOBAL),
        ]);
        db.data[user][game_id].status = 'claimed';
        db.data[user][game_id].time = datetime(); // claimed time overwrites failed/dryrun time
        log.ok(`${title} — claimed!`);
        // v2.11.15: dismiss the post-claim "FINAL STEP — Is Epic Games
        // Launcher installed?" upsell modal, if it appears. Left up, it
        // pins the *previous* page's `load` event and hangs the next
        // iteration's goto for 60s. Best-effort; see helper for details.
        await dismissLauncherModal(page);
        // context.setDefaultTimeout(cfg.timeout);
      } catch (e) {
        if (cfg.debug) console.error(e);
        // Race timed out — but the click may have succeeded anyway. Probe
        // the listing's CTA first: if it now reads "In Library" we claimed
        // successfully and Epic's success-modal copy just drifted out from
        // under us (the modal text/iframe race didn't match, but the
        // ownership state did flip). Only log/screenshot as a failure when
        // the CTA *also* doesn't confirm — otherwise we noise up the log
        // with a `✗ failed to claim` line that's immediately followed by a
        // `✓ claim succeeded` line for the same game (regression report
        // 2026-05-14 on Arranger).
        let recoveredViaCta = false;
        try {
          const ctaLoc = page.locator('button[data-testid="purchase-cta-button"]').first();
          // v2.11.5: stability check for the recovery-probe. v2.11.4 could
          // false-positive on a transient owned-flash during Epic's failed-
          // transaction rollback (German UI shows "In der Bibliothek" briefly).
          // Reading twice with a 3s gap forces the CTA to stabilize.
          // v2.11.7: explicit 3s timeout on the second read — without it,
          // if the CTA detaches during the 3s gap (page nav, DOM removal)
          // the read blocks for the whole default `context.setDefaultTimeout`
          // (60s) before .catch fires. Explicit short timeout matches the
          // stability-window we're already committed to.
          const cta1 = (await ctaLoc.innerText({ timeout: 3000 }).catch(() => '')).toLowerCase();
          if (isOwnedText(cta1)) {
            await page.waitForTimeout(3000);
            const cta2 = (await ctaLoc.innerText({ timeout: 3000 }).catch(() => '')).toLowerCase();
            if (isOwnedText(cta2)) recoveredViaCta = true;
            else log.info(`${title} — CTA flashed owned state but didn't stabilize (was "${cta1}", now "${cta2}") — treating as failed`);
          }
        } catch { /* CTA probe is best-effort */ }
        if (recoveredViaCta) {
          log.ok(`${title} — claim succeeded (confirmed via post-click CTA)`);
          db.data[user][game_id].status = 'claimed';
          db.data[user][game_id].time = datetime();
          // v2.11.15: same dismiss as the main success path — the launcher
          // upsell fires here too when the race timed out but the CTA
          // flipped owned, so the modal is on-screen even though we took
          // the recovery branch.
          await dismissLauncherModal(page);
        } else {
          log.fail(`${title} — failed to claim`);
          const p = screenshot('failed', `${game_id}_${filenamify(datetime())}.png`);
          // Diagnostic screenshot is best-effort — a crashed renderer
          // (common on arm64, per marlonqpa's #107) shouldn't cascade a
          // claim failure into a whole-run failure. Recoverable-family
          // errors log a warn and move on; other errors still rethrow.
          try {
            await page.screenshot({ path: p, fullPage: true });
          } catch (e) {
            if (!isRecoverableEpicPageError(e)) throw e;
            log.warn(`page.screenshot failed for ${title} (${String(e.message || e).split('\n')[0]}) — skipping capture`);
          }
          db.data[user][game_id].status = 'failed';
          if (iframe && (captchaDetected || await iframe.locator('#h_captcha_challenge_checkout_free_prod iframe').count().catch(() => 0) > 0)) {
            captchaDetected = true;
            notify_game.captcha = true;
          }
        }
      }
      notify_game.status = db.data[user][game_id].status; // claimed or failed
      if (notify_game.status === 'failed') {
        if (captchaDetected) {
          notify_game.details = `Captcha blocked claim — will retry. <a href="${url}">View game</a>`;
        } else {
          notify_game.details = `<a href="${url}">View game</a>`;
        }
      }

      const p = screenshot(`${game_id}.png`);
      if (!existsSync(p)) {
        // Same defensive shape as the failure-screenshot above — a
        // recoverable renderer crash here shouldn't fail the run.
        try {
          await page.screenshot({ path: p, fullPage: false }); // fullPage is quite long...
        } catch (e) {
          if (!isRecoverableEpicPageError(e)) throw e;
          log.warn(`page.screenshot failed for ${game_id} (${String(e.message || e).split('\n')[0]}) — skipping capture`);
        }
      }
    }
    if (cfg.time) console.timeEnd('claim game');
  }
  if (dedupedVariants > 0) {
    log.info(`(${dedupedVariants} platform variant${dedupedVariants > 1 ? 's' : ''} of titles above — same game on a different OS/locale URL)`);
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
        log.game(retry.title, 'claiming (retry)');
        await purchaseBtn.click({ delay: 11 });
        page.click('button:has-text("Continue")').catch(_ => { });
        page.click('button:has-text("Yes, buy now")').catch(_ => { });
        await page.waitForSelector('#webPurchaseContainer iframe');
        const iframe = page.frameLocator('#webPurchaseContainer iframe');
        const btnAgree = iframe.locator('button:has-text("I Accept")');
        btnAgree.waitFor().then(() => btnAgree.click()).catch(_ => { });
        // Epic relabeled the confirm button from "Place Order" → "Add to
        // library" around 2026-05-28 (reported by @amphoterism on #59) —
        // every claim silently timed out because the old selector no
        // longer matched. Accept either text so we stay resilient if Epic
        // flips back or surfaces "Place Order" in some regions/flows.
        await iframe.locator('button:has-text("Add to library"):not(:has(.payment-loading--loading)), button:has-text("Place Order"):not(:has(.payment-loading--loading))').first().click({ delay: 11 });
        // Same three-signal race as the main claim path above — see the
        // fuller comment there. Modal-text + popup-buttons + CTA-flip,
        // whichever fires first wins.
        // v2.11.3: locale-portable success signals — regex-based text
        // matchers + disabled-attribute CTA state. Steggl's #141 followup
        // needed this: the primary claim ran to the Add-to-Library click
        // in German but the success-race then timed out because the modal
        // text and the CTA-flip check were still English-only.
        // v2.11.4: dropped the `if (btn.disabled) return true` short-circuit
        // that v2.11.3 added — that state also fires during Epic's post-click
        // loading spinner, causing the race to resolve as "success" while the
        // claim is still processing (Steggl's #141 followup: log says
        // "claimed!" 20-30s in but games weren't actually in library).
        // Success signal is now text-only via the locale-portable regexes:
        // modal-copy match OR CTA text transitioning to a known "owned"
        // string. Both are only true AFTER Epic confirms the purchase.
        await Promise.race([
          page.getByText(RX_ORDER_SUCCESS).first().waitFor({ state: 'attached' }),
          page.locator('button').filter({ hasText: new RegExp(RX_CONTINUE_BROWSING.source + '|' + RX_DOWNLOAD_LAUNCHER.source, 'i') }).first().waitFor({ state: 'visible' }),
          // Same owned-text semantics as the shared isOwnedText predicate,
          // inlined here because waitForFunction runs in the browser context
          // where the helper isn't reachable. Kept in sync via OWNED_TEXTS_GLOBAL.
          page.waitForFunction((ownedList) => {
            const btn = document.querySelector('button[data-testid="purchase-cta-button"]');
            if (!btn) return false;
            const txt = (btn.innerText || '').trim().toLowerCase();
            if (!txt || txt === 'loading') return false;
            return ownedList.some(t => txt === t || txt.startsWith(t));
          }, { timeout: cfg.timeout }, OWNED_TEXTS_GLOBAL),
        ]);
        const game_id = page.url().split('/').pop();
        db.data[user][game_id].status = 'claimed';
        db.data[user][game_id].time = datetime();
        log.ok(`${retry.title} — claimed on retry!`);
        retry.status = 'claimed';
        retry.details = '';
        retry.captcha = false;
        // v2.11.15: same launcher-modal dismiss as the main success path.
        await dismissLauncherModal(page);
      } catch (e) {
        log.fail(`${retry.title} — retry failed`);
        if (cfg.debug) console.error(e);
        retry.details = `Retry also failed. Game: ${retry.url}`;
      }
    }
  }

  const failedGames = notify_games.filter(g => g.status === 'failed');
  if (failedGames.length && Object.keys(offerIdMap).length) {
    const slugFromUrl = url => {
      try { return decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '').split('/').pop()).toLowerCase(); } catch { return url.split('/').pop().toLowerCase(); }
    };
    const failedOfferIds = [...new Set(failedGames.map(g => offerIdMap[slugFromUrl(g.url)]).filter(Boolean))];
    if (cfg.debug) {
      const unmatched = failedGames.filter(g => !offerIdMap[slugFromUrl(g.url)]);
      if (unmatched.length) console.debug('  Cart fallback — unmatched slugs:', unmatched.map(g => slugFromUrl(g.url)));
    }
    if (failedOfferIds.length) {
      log.info(`Cart fallback — ${failedOfferIds.length}/${failedGames.length} failed game(s) matched to offer IDs`);
      const cartUrl = `https://store.epicgames.com/en-US/cart?${failedOfferIds.map(id => `offerId=${id}`).join('&')}`;
      log.info(`Cart link — ${cartUrl}`);
      for (const g of failedGames) {
        const offerId = offerIdMap[slugFromUrl(g.url)];
        if (offerId) {
          const singleCartUrl = `https://store.epicgames.com/en-US/cart?offerId=${offerId}`;
          g.details = (g.details ? g.details + ' · ' : '') + `<a href="${singleCartUrl}">Claim in cart</a>`;
        }
      }
      notify_games.push({ title: `🛒 Claim ${failedOfferIds.length} game(s) in one click`, url: cartUrl, status: 'action' });
    } else {
      log.warn(`Cart fallback — 0/${failedGames.length} failed game(s) matched to offer IDs`);
    }
  }
  // Epic returns each free game twice (PC + Mobile platform variants) and
  // notify_games has one entry per variant. Dedupe by title so the summary
  // counts match the per-title body lines (which are also already deduped
  // via `ownedLogged` for the "already in library" message).
  const uniqueByTitle = status =>
    new Set(notify_games.filter(g => g.status === status).map(g => g.title)).size;
  log.summary({
    siteId: 'epic-games',
    claimed: uniqueByTitle('claimed'),
    skipped: uniqueByTitle('skipped'),
    display: 'alreadyOwned',
    alreadyOwned: uniqueByTitle('existed'),
    failed: uniqueByTitle('failed'),
  });
} catch (error) {
  process.exitCode ||= 1;
  log.exception(error);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode != 130) await notify(`epic-games failed: ${error.message.split('\n')[0]}`, { attachLatestScreenshot: true });
} finally {
  if (cfg.time) console.timeEnd('claim all games');
  await db.write();
  if (notify_games.filter(g => g.status == 'claimed' || g.status == 'failed' || g.status == 'action').length) {
    // Tag as 'summary' only when nothing in the list needs user action —
    // failures and capture-required entries promote it back to 'action'
    // so xh43k's "actions only" mode still surfaces them. (#31)
    const hasActionable = notify_games.some(g => g.status === 'failed' || g.status === 'action');
    await notify(`epic-games (${user}):<br>${html_game_list(notify_games)}`, { kind: hasActionable ? 'action' : 'summary' });
  }
}
if (cfg.debug) writeFileSync(path.resolve(cfg.dir.browser, 'cookies.json'), JSON.stringify(await context.cookies()));
if (page.video()) log.info(`Recorded video — ${await page.video().path()}`);
await closeContextSafely(context);
