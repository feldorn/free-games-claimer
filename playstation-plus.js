import { chromium } from 'patchright';
import { authenticator } from 'otplib';
import path from 'node:path';
import {
  jsonDb, datetime, filenamify, prompt, notify, html_game_list, escapeHtml,
  handleSIGINT, closeContextSafely, log, cleanProfileLocks, awaitUserCaptchaSolve,
} from './src/util.js';
import { cfg } from './src/config.js';
import { siteVersion, WEBGL_HARDENING_ARGS } from './src/sites.js';
import {
  discoverMonthlyRaw, discoverCatalog, matchMonthlyToCatalog, URL_WHATS_NEW,
} from './src/playstation-plus-catalog.js';

const screenshot = (...a) => path.resolve(cfg.dir.screenshots, 'playstation-plus', ...a);

log.section(`PlayStation Plus (v${siteVersion('playstation-plus')})`);
log.status('Time', datetime());
log.status('Max backlog/run', cfg.psp_max_claims_per_run);
log.status('Pause range', `${cfg.psp_claim_pause_min_sec}-${cfg.psp_claim_pause_max_sec}s`);

const db = await jsonDb('playstation-plus.json', {});
const notify_games = [];
let user;

const PROFILE_DIR = cfg.dir.browser + '-playstation';
cleanProfileLocks(PROFILE_DIR);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US',
  handleSIGINT: false,
  args: ['--hide-crash-restore-bubble', ...WEBGL_HARDENING_ARGS],
});
handleSIGINT(context);
if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
const page = context.pages().length ? context.pages()[0] : await context.newPage();

async function ensureLoggedIn(page) {
  await page.goto(URL_WHATS_NEW, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // TEMP diagnostic (session-persistence investigation, 2026-05-28): show what
  // the runner loaded from the on-disk profile. Remove once resolved.
  try {
    const cookies = await page.context().cookies();
    const psn = cookies.filter(c => /sony|playstation/i.test(c.domain || ''));
    const signedIn = psn.find(c => c.name === 'isSignedIn');
    log.status('PSN cookies at startup', `total=${cookies.length} psn=${psn.length} isSignedIn=${signedIn ? `present(exp=${signedIn.expires})` : 'MISSING'}`);
  } catch { /* diagnostic only */ }

  const userEl = page.locator('.psw-c-secondary').first();
  const signIn = page.locator('span:has-text("Sign in"), a:has-text("Sign in")').first();
  // .psw-c-secondary lives inside the (hidden-until-opened) profile dropdown.
  // It IS attached to the DOM even when not rendered, so we wait for
  // `attached` not `visible` — otherwise we'd misidentify a logged-in session
  // as signed-out and try to re-login pointlessly. Reading the text downstream
  // uses textContent (not innerText) for the same reason.
  const detected = await Promise.race([
    userEl.waitFor({ state: 'attached', timeout: 8000 }).then(() => 'logged-in'),
    signIn.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'signed-out'),
  ]).catch(() => 'unknown');

  if (detected === 'logged-in') return;

  if (cfg.nowait) {
    log.warn('Not signed in and NOWAIT set — exiting.');
    if (cfg.novnc_port) log.info(`Open http://localhost:${cfg.novnc_port} to sign in via the panel.`);
    process.exit(1);
  }

  log.warn('Not signed in');
  if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
  log.status('Login timeout', `${cfg.login_timeout / 1000}s`);

  await signIn.click().catch(() => {});
  await page.waitForURL(/my\.account\.sony\.com|signin\.account\.sony\.com/, { timeout: cfg.login_timeout }).catch(() => {});

  if (cfg.psp_email && cfg.psp_password) {
    log.info('Using credentials from environment');
    await page.locator('#signin-entrance-input-signinId').fill(cfg.psp_email);
    await page.locator('#signin-entrance-button').click();
    await page.waitForSelector('#signin-password-input-password', { timeout: cfg.login_timeout });
    await page.locator('#signin-password-input-password').fill(cfg.psp_password);
    await page.locator('#signin-password-button').click();

    // FunCaptcha handoff — Sony's Arkose challenge. The captcha-marker
    // feature on the registry entry tells the panel to watch for the
    // [CAPTCHA-START]/[CAPTCHA-END] markers awaitUserCaptchaSolve emits.
    page.locator('#FunCaptcha').waitFor({ timeout: cfg.login_timeout }).then(async () => {
      log.warn('Got FunCaptcha challenge during PSN login');
      await awaitUserCaptchaSolve(page, {
        service: 'playstation-plus',
        label: 'FunCaptcha (PSN login)',
        captchaCheck: async () => await page.locator('#FunCaptcha').count() === 0,
      });
    }).catch(() => {});

    // 2FA / TOTP. PSP_OTPKEY → automatic; otherwise prompt or notify.
    page.locator('input[title="Enter Code"]').waitFor({ timeout: cfg.login_timeout }).then(async () => {
      log.info('Two-Step Verification — entering code');
      const otp = cfg.psp_otpkey
        ? authenticator.generate(cfg.psp_otpkey)
        : await prompt({ type: 'text', message: 'Enter PSN two-factor code', validate: n => n.toString().length === 6 || 'Must be 6 digits' });
      await page.locator('input[title="Enter Code"]').pressSequentially(otp.toString());
      // "Trust this Browser" — opt-in, ignore if absent.
      await page.locator('.checkbox-container input[type="checkbox"]').first().check().catch(() => {});
      await page.locator('button.primary-button, button[type="submit"]').first().click();
    }).catch(() => {});
  } else {
    log.info('No PSP_EMAIL/PSP_PASSWORD — waiting for manual sign-in via the browser');
    await notify('playstation-plus: not signed in and no credentials configured. Sign in via the panel.');
    if (cfg.headless) {
      log.info('Run `SHOW=1 node playstation-plus` to login in an opened browser.');
      await context.close();
      process.exit(1);
    }
  }

  await page.waitForURL(/^https:\/\/www\.playstation\.com\//, { timeout: cfg.login_timeout });
  await page.locator('.psw-c-secondary').waitFor({ state: 'attached', timeout: 15000 });
  if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
}

async function attemptClaimWithBlockRecovery(page, entry) {
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await page.goto(entry.conceptUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const title = await page.title().catch(() => '');
    if (!(/^Access Denied/i).test(title)) {
      // Wait for the CTA to attach so the caller can read its meta.
      // Sony renders <button> for ADD_TO_LIBRARY and <a> for DOWNLOAD/owned,
      // so use a tag-agnostic selector here.
      await page.locator('[data-qa="mfeCtaMain#cta#action"]').waitFor({ state: 'attached', timeout: cfg.timeout }).catch(() => {});
      return 'ok';
    }
    log.warn(`Access Denied on ${entry.title} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    if (attempt < MAX_ATTEMPTS) {
      // Bounce off the PS Plus catalog page to refresh the referer/session
      // signal, then wait 15-30s random before retrying the concept URL.
      await page.goto('https://www.playstation.com/en-us/ps-plus/games/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      const pause = 15000 + Math.floor(Math.random() * 15000);
      await page.waitForTimeout(pause);
    }
  }
  return 'access-denied';
}

async function readCtaMeta(page) {
  // Sony renders a <button> for ADD_TO_LIBRARY and an <a> for DOWNLOAD (owned),
  // so use a tag-agnostic selector to catch both states.
  const handle = page.locator('[data-qa="mfeCtaMain#cta#action"]').first();
  if (await handle.count() === 0) return null;
  const raw = await handle.getAttribute('data-telemetry-meta').catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function claimOne(page, entry, opts = { priority: false }) {
  const now = datetime();
  db.data[user][entry.conceptId] ||= { title: entry.title, url: entry.conceptUrl, source: entry.source, conceptId: entry.conceptId, time: now };
  const row = db.data[user][entry.conceptId];
  row.lastAttemptedAt = now;
  row.source = entry.source;

  const notify_game = { title: entry.title, url: entry.conceptUrl, status: 'failed' };
  notify_games.push(notify_game);

  const blockOutcome = await attemptClaimWithBlockRecovery(page, entry);
  if (blockOutcome === 'access-denied') {
    log.fail(`${entry.title} — Access Denied (retry next run)`);
    row.status = notify_game.status = 'failed:access-denied';
    const p = screenshot(`${entry.conceptId}_${filenamify(now)}.png`);
    await page.screenshot({ path: p, fullPage: false }).catch(() => {});
    return 'access-denied';
  }

  const meta = await readCtaMeta(page);
  if (!meta) {
    log.fail(`${entry.title} — CTA not found (unexpected page state)`);
    row.status = notify_game.status = 'failed';
    const p = screenshot(`${entry.conceptId}_${filenamify(now)}.png`);
    await page.screenshot({ path: p, fullPage: false }).catch(() => {});
    return 'failed';
  }
  row.ctaType = meta.ctaType || 'unknown';
  if (meta.productId) row.productId = meta.productId;

  const cta = String(meta.ctaType || '').toUpperCase();

  // Trial filter. Sony has _PS_PLUS_TRIAL variants across the ctaType enum,
  // but only the ADD variant (ADD_TO_LIBRARY_PS_PLUS_TRIAL) is a "don't claim"
  // case — clicking it adds a 2-3h Premium timed demo, not a keeper. The
  // DOWNLOAD/OWNED variants (e.g. DOWNLOAD_PS_PLUS_TRIAL, button text
  // "Download from Library") mean the title is ALREADY in the library, so
  // they're an owned/existed case handled below — NOT a trial to skip and
  // retry every run. Observed 2026-05-28: a *purchased* game (Clair Obscur,
  // offer "In library" selected) reported DOWNLOAD_PS_PLUS_TRIAL and was
  // wrongly skipped as a trial on every run.
  //
  // Catalog scrape filters trials out at the source (the "Game trials"
  // section heading); this is defense-in-depth for anything that slips
  // through — e.g. monthly orphans claimed via slug URL where we don't have
  // the section-heading signal.
  if (cta.startsWith('ADD_TO_LIBRARY') && /_TRIAL/.test(cta)) {
    log.skip(entry.title, `trial — not a keeper (ctaType=${cta})`);
    row.status = notify_game.status = 'skipped:trial';
    return 'skipped';
  }

  if (cta === 'ADD_TO_LIBRARY') {
    if (cfg.dryrun) {
      log.warn(`${entry.title} — dry run, would have clicked Add to Library`);
      row.status = notify_game.status = 'skipped';
      return 'skipped';
    }
    log.game(entry.title, `claiming (${opts.priority ? 'monthly priority' : 'catalog drain'})`);
    await page.locator('button[data-qa="mfeCtaMain#cta#action"]').first().click({ delay: 11 });
    // Race three success signals:
    //   btn-flip: Sony replaces the <button> with an <a data-qa="mfeCtaMain#cta#action">
    //             whose text is "Download from Library" (ctaType flips to DOWNLOAD).
    //   toast: inline-toast confirmation message appears.
    //   meta-flip: ctaType re-read becomes OWNED, IN_LIBRARY, or DOWNLOAD.
    // First to fire wins.
    const success = await Promise.race([
      page.locator('a[data-qa="mfeCtaMain#cta#action"]').first().waitFor({ state: 'attached', timeout: cfg.timeout }).then(() => 'btn-flip'),
      page.locator('[data-qa^="inline-toast"]:has-text("Added to library"), [data-qa^="inline-toast"]:has-text("in library")').first().waitFor({ state: 'visible', timeout: cfg.timeout }).then(() => 'toast'),
      (async () => {
        const start = Date.now();
        while (Date.now() - start < cfg.timeout) {
          const m = await readCtaMeta(page);
          if (m && (/OWNED|IN_LIBRARY|DOWNLOAD/i).test(String(m.ctaType || ''))) return 'meta-flip';
          await page.waitForTimeout(500);
        }
        throw new Error('no meta-flip');
      })(),
    ]).catch(() => null);
    if (success) {
      log.ok(`${entry.title} — claimed (${success})`);
      row.status = notify_game.status = 'claimed';
      row.time = datetime();
      return 'claimed';
    }
    log.fail(`${entry.title} — claim click did not confirm`);
    row.status = notify_game.status = 'failed';
    const p = screenshot(`${entry.conceptId}_${filenamify(now)}.png`);
    await page.screenshot({ path: p, fullPage: false }).catch(() => {});
    return 'failed';
  }

  // Already in the library. Anchored at start so the _PS_PLUS_TRIAL download
  // variant (owned game whose download CTA Sony tags with the trial suffix)
  // is correctly treated as owned, not as a claimable trial.
  if (/^(OWNED|IN_LIBRARY|DOWNLOAD)/.test(cta)) {
    log.owned(entry.title);
    row.status = notify_game.status = 'existed';
    return 'existed';
  }

  // Anything else — BUY, PRE_ORDER, COMING_SOON, REGION_LOCKED, etc.
  // TEMP diagnostic (2026-05-28): surface the PS_PLUS offer's applicability so
  // we can tell "session not entitled" (UPSELL) from a genuine non-catalog
  // game. Remove once the entitlement/session issue is resolved.
  let offerInfo = '';
  try {
    const offers = (meta.productDetail && meta.productDetail[0] && meta.productDetail[0].productPriceDetail) || [];
    const plus = offers.find(o => o.offerBranding === 'PS_PLUS');
    offerInfo = plus ? ` psPlusOffer=${plus.discountPriceFormatted}/${plus.offerApplicability}` : ' psPlusOffer=NONE';
  } catch { /* diagnostic only */ }
  log.skip(entry.title, `not included (ctaType=${cta || 'unknown'}${offerInfo})`);
  row.status = notify_game.status = 'skipped:not-included';
  return 'skipped';
}

try {
  await ensureLoggedIn(page);
  // textContent (not innerText) — the element is in a hidden-until-opened
  // profile dropdown, innerText returns '' for non-rendered elements while
  // textContent reads the underlying DOM string regardless of visibility.
  user = (await page.locator('.psw-c-secondary').first().textContent().catch(() => '') || '').trim() || 'unknown';
  log.status('User', user);
  db.data[user] ||= {};

  let monthlyRaw = [];
  try {
    monthlyRaw = await discoverMonthlyRaw(page);
    log.status('Monthly Essentials (raw)', monthlyRaw.length);
    if (monthlyRaw.length === 0) {
      log.warn('Zero monthly Essentials discovered — Sony may have refactored whats-new.');
      notify_games.push({
        title: '⚠ Monthly Essentials detection failed — check manually this month',
        url: 'https://www.playstation.com/en-us/ps-plus/whats-new/',
        status: 'action',
        details: 'Sony may have refactored /ps-plus/whats-new/. Run test/ps-monthly-probe.js and update discoverMonthlyRaw().',
      });
    }
  } catch (e) {
    log.warn(`Monthly discovery failed — ${e.message.split('\n')[0]}`);
  }

  let catalogEntries = [];
  try {
    catalogEntries = await discoverCatalog(page);
    log.status('Catalog entries found', `${catalogEntries.length} keeper(s) (trials section filtered)`);
    // Sony's PS Plus catalog landing page surfaces ~18 keeper titles
    // (section#plus-container) alongside ~218 timed-demo "trials"
    // (section#trials, excluded at scrape time). A sub-10 result almost
    // certainly means the page didn't load — skip drain in that case
    // rather than misreport empty as "all candidates skipped."
    if (catalogEntries.length < 10) {
      log.warn(`Catalog scrape returned only ${catalogEntries.length} keeper(s) (< 10) — skipping drain pass this run. Sony may have refactored the catalog page; investigate before next run.`);
      catalogEntries = [];
    }
  } catch (e) {
    log.warn(`Catalog discovery failed — ${e.message.split('\n')[0]}`);
  }

  // Join monthlies → catalog so we can prefer canonical concept URLs.
  // Probe finding 2026-05-26: Sony serves the SAME mfeCtaMain CTA component
  // (data-qa="mfeCtaMain#cta#action" + offer / ps-plus-icon / discount-
  // descriptor data-qa attributes) on both store.playstation.com/concept/
  // AND playstation.com/games/<slug>/ — so claimOne works on either URL
  // shape. Monthlies that don't appear in the catalog scrape (the common
  // case — Essential monthlies aren't usually in the rotating Extra/
  // Premium catalog) just claim via their slug URL directly.
  const { matched: monthlyMatched, unmatched: monthlyOrphans } = matchMonthlyToCatalog(monthlyRaw, catalogEntries);
  const monthlyFromOrphans = monthlyOrphans.map(o => ({
    conceptId: o.slug, // DB key — slugs and numeric conceptIds don't collide
    conceptUrl: 'https://www.playstation.com' + o.slugUrl, // absolute URL claimOne can goto
    title: o.title,
    slug: o.slug,
    slugUrl: o.slugUrl,
    source: 'monthly-slug',
  }));
  const monthlyEntries = [...monthlyMatched, ...monthlyFromOrphans];
  log.status('Monthly: catalog-joined / slug-direct', `${monthlyMatched.length}/${monthlyFromOrphans.length}`);

  const monthlyIds = new Set(monthlyMatched.map(e => e.conceptId));

  const isTerminal = id => {
    const s = db.data[user][id]?.status;
    return s === 'claimed' || s === 'existed';
  };
  const jitterPause = async () => {
    const min = Math.max(0, cfg.psp_claim_pause_min_sec * 1000);
    const max = Math.max(min, cfg.psp_claim_pause_max_sec * 1000);
    const pause = min + Math.floor(Math.random() * (max - min + 1));
    if (pause > 0) {
      log.info(`Pausing ${Math.floor(pause / 1000)}s before next claim…`);
      await page.waitForTimeout(pause);
    }
  };

  const monthlyWork = monthlyEntries.filter(e => !isTerminal(e.conceptId));
  const drainCandidates = catalogEntries
    .filter(e => !monthlyIds.has(e.conceptId))
    .filter(e => !isTerminal(e.conceptId))
    .sort((a, b) => {
      const aLast = db.data[user][a.conceptId]?.lastAttemptedAt || '';
      const bLast = db.data[user][b.conceptId]?.lastAttemptedAt || '';
      return aLast.localeCompare(bLast) || a.conceptId.localeCompare(b.conceptId);
    })
    .slice(0, cfg.psp_max_claims_per_run);

  const ACCESS_DENIED_RUN_BUDGET = 3;
  let consecutiveBlocks = 0;
  let circuitBroken = false;
  const runOne = async (entry, opts) => {
    if (circuitBroken) return;
    const outcome = await claimOne(page, entry, opts);
    if (outcome === 'access-denied') {
      consecutiveBlocks++;
      if (consecutiveBlocks >= ACCESS_DENIED_RUN_BUDGET) {
        log.fail(`Access-Denied circuit breaker tripped after ${consecutiveBlocks} consecutive blocks — aborting run`);
        notify_games.push({
          title: '⚠ PS Plus run aborted — Sony bot block',
          url: 'https://store.playstation.com/',
          status: 'action',
          details: 'Akamai bot manager scored this session too high. Run aborted. Will retry next run.',
        });
        // Mark the run as failed at the process level so the panel's
        // Stats / Sessions tabs don't render a green "Success" indicator
        // for a run that was aborted mid-flight. Matches how Epic / GOG
        // surface partial failures via non-zero exitCode.
        process.exitCode = 1;
        circuitBroken = true;
      }
    } else {
      consecutiveBlocks = 0;
    }
  };

  log.status('Priority pass', `${monthlyWork.length} monthly title(s) pending`);
  for (let i = 0; i < monthlyWork.length; i++) {
    if (circuitBroken) break;
    await runOne(monthlyWork[i], { priority: true });
    const hasMoreWork = i < monthlyWork.length - 1 || drainCandidates.length > 0;
    if (hasMoreWork && !circuitBroken) await jitterPause();
  }

  log.status('Drain pass', `${drainCandidates.length} backlog entry(ies) this run (cap ${cfg.psp_max_claims_per_run})`);
  const drainStartIdx = notify_games.length;
  for (let i = 0; i < drainCandidates.length; i++) {
    if (circuitBroken) break;
    await runOne(drainCandidates[i], { priority: false });
    if (i < drainCandidates.length - 1 && !circuitBroken) await jitterPause();
  }

  // Subscription-lapse signal: if every drain attempt this run came back
  // as skipped:not-included (ctaType=BUY/etc), the user's PS Plus
  // subscription has likely lapsed — every catalog game shows as paid.
  // Warn once so the operator sees the lapse instead of N empty drain
  // runs in a row.
  if (drainCandidates.length > 0 && !circuitBroken) {
    const drainResults = notify_games.slice(drainStartIdx);
    const allSkippedNotIncluded = drainResults.length > 0 && drainResults.every(g => g.status === 'skipped:not-included');
    if (allSkippedNotIncluded) {
      log.warn('All drain candidates skipped (ctaType not ADD_TO_LIBRARY). Subscription may have lapsed, or Sony renamed the CTA enum — check manually.');
      notify_games.push({
        title: '⚠ All PS Plus drain candidates returned non-claimable CTAs',
        url: 'https://www.playstation.com/en-us/ps-plus/',
        status: 'action',
        details: 'Every game in the drain pass returned a ctaType other than ADD_TO_LIBRARY. Most likely cause: PS Plus subscription has lapsed. Less likely: Sony renamed the ctaType enum (check data-telemetry-meta values in browser DevTools).',
      });
    }
  }

  const counts = { claimed: 0, existed: 0, skipped: 0, failed: 0 };
  for (const g of notify_games) {
    if (g.status === 'claimed') counts.claimed++;
    else if (g.status === 'existed') counts.existed++;
    else if ((/^skipped/).test(g.status)) counts.skipped++;
    else if ((/^failed/).test(g.status)) counts.failed++;
  }
  log.summary({
    siteId: 'playstation-plus',
    claimed: counts.claimed,
    skipped: counts.skipped,
    display: 'alreadyOwned',
    alreadyOwned: counts.existed,
    failed: counts.failed,
  });
} catch (error) {
  process.exitCode ||= 1;
  log.exception(error);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode != 130) {
    await notify(`playstation-plus failed: ${error.message.split('\n')[0]}`, { attachLatestScreenshot: true });
  }
} finally {
  await db.write();
  if (notify_games.length) {
    const hasActionable = notify_games.some(g => g.status === 'failed' || g.status === 'action' || (/^failed:/).test(g.status));
    await notify(`playstation-plus (${escapeHtml(user || 'unknown')}):<br>${html_game_list(notify_games)}`, { kind: hasActionable ? 'action' : 'summary' });
  }
  await closeContextSafely(context);
}
