import { chromium } from 'patchright';
import { writeFileSync } from 'node:fs';
import { resolve, jsonDb, datetime, filenamify, prompt, notify, html_game_list, handleSIGINT, log, dataDir, awaitUserCaptchaSolve } from './src/util.js';
import { cfg } from './src/config.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'steam', ...a);

const URL_STORE = 'https://store.steampowered.com';
const URL_STEAMDB_FREE = 'https://steamdb.info/upcoming/free/';
const URL_LOGIN = `${URL_STORE}/login/`;

const RATING_MAP = {
  'overwhelmingly positive': 9,
  'very positive': 8,
  'positive': 7,
  'mostly positive': 6,
  'mixed': 5,
  'mostly negative': 4,
  'negative': 3,
  'very negative': 2,
  'overwhelmingly negative': 1,
};

function parsePrice(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^0-9.,]/g, '').trim();
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = cleaned.replace(/,/g, '');
  }
  const val = parseFloat(normalized);
  return isNaN(val) ? null : val;
}

log.section('Steam');
log.status('Time', datetime());
log.status('Min rating', `${cfg.steam_min_rating}/9 (${Object.entries(RATING_MAP).find(([, v]) => v === cfg.steam_min_rating)?.[0] || '?'})`);
log.status('Min price', `$${cfg.steam_min_price}`);

const db = await jsonDb('steam.json', {});

const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US',
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined,
  recordHar: cfg.record ? { path: `data/record/steam-${filenamify(datetime())}.har` } : undefined,
  handleSIGINT: false,
  args: [
    '--hide-crash-restore-bubble',
  ],
});

handleSIGINT(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage();
await page.setViewportSize({ width: cfg.width, height: cfg.height });

const notify_games = [];
let user;

async function dismissAgeGate(p) {
  try {
    const ageGate = p.locator('#agegate_box, .agegate_text_container, .age_gate');
    if (await ageGate.count() > 0) {
      if (cfg.debug) console.log('  Handling age verification...');
      const yearSelect = p.locator('#ageYear');
      if (await yearSelect.count() > 0) {
        await yearSelect.selectOption('1990');
        await p.locator('#view_product_page_btn, .btnv6_blue_hoverfade').first().click();
      } else {
        await p.locator('a.btnv6_blue_hoverfade:has-text("View Page"), button:has-text("Continue")').first().click();
      }
      await p.waitForTimeout(2000);
    }
  } catch {}
}

async function getGameDetails(p, url) {
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);

  await dismissAgeGate(p);

  const details = { url, title: null, rating: null, ratingText: null, originalPrice: null, isFree: false, alreadyOwned: false, canClaim: false };

  try {
    details.title = await p.locator('#appHubAppName, .apphub_AppName').first().innerText();
  } catch {
    try {
      details.title = await p.locator('h2.pageheader').first().innerText();
    } catch {
      details.title = url.split('/').filter(Boolean).pop();
    }
  }

  try {
    const reviewEl = p.locator('[itemprop="description"], .game_review_summary').first();
    if (await reviewEl.count() > 0) {
      details.ratingText = (await reviewEl.getAttribute('data-tooltip-html') || await reviewEl.innerText()).trim().split('<br>')[0].split('\n')[0].trim();
      const normalized = details.ratingText.toLowerCase().replace(/[^a-z ]/g, '').trim();
      for (const [key, value] of Object.entries(RATING_MAP)) {
        if (normalized.includes(key)) {
          details.rating = value;
          break;
        }
      }
    }
  } catch {}

  try {
    const discountOriginal = p.locator('.discount_original_price').first();
    if (await discountOriginal.count() > 0) {
      details.originalPrice = parsePrice(await discountOriginal.innerText());
    }

    const discountFinal = p.locator('.discount_final_price').first();
    if (await discountFinal.count() > 0) {
      const finalText = (await discountFinal.innerText()).trim().toLowerCase();
      const finalPrice = parsePrice(finalText);
      details.isFree = finalText === 'free' || (finalPrice !== null && finalPrice === 0);
    }
  } catch {}

  if (await p.locator('.game_area_already_owned').count() > 0) {
    details.alreadyOwned = true;
  }

  if (!details.alreadyOwned && details.isFree) {
    const addToAccount = p.locator('a.btn_green_steamui:has-text("Add to Account"), .game_purchase_action .btn_addtocart a:has-text("Add to Account")');
    if (await addToAccount.count() > 0) {
      details.canClaim = true;
    }
  }

  return details;
}

async function discoverFreeGames(p) {
  log.status('Source', 'SteamDB (steamdb.info/upcoming/free)');

  const navResp = await p.goto(URL_STEAMDB_FREE, { waitUntil: 'domcontentloaded' });
  // 403 means Cloudflare hard-blocked the request server-side (no Private
  // Access Token attestation, IP rep, etc.) — there is no Turnstile to
  // solve, the user staring at a broken-widget page can't recover the
  // session, and polling for content forever is just punishment. Bail out
  // explicitly so the run logs a clear cause instead of the engagement
  // loop. Same idea for any other 4xx that shouldn't be on a public page.
  if (navResp && navResp.status() >= 400 && navResp.status() < 500) {
    log.warn(`SteamDB returned ${navResp.status()} — Cloudflare hard-block, no manual solve will help. Skipping Steam this run.`);
    log.warn('If this persists: try a different IP / VPN, or temporarily disable Steam in Settings.');
    await dumpDiscoveryDiagnostic(p, `cloudflare-${navResp.status()}`);
    return [];
  }
  await p.waitForTimeout(5000);

  // Cloudflare interstitial detector — flipped to a positive-content-first
  // check after observing the previous version loop on user-solved Turnstile
  // challenges: SteamDB keeps the challenge iframe / widget DOM mounted
  // after the user passes, so a "challenge-widget present" check kept
  // returning true forever. Better signal: do we see the actual SteamDB
  // upcoming-free content yet? If yes, we're past the challenge regardless
  // of any leftover widget plumbing. Only fall back to negative signals
  // (URL, title, body text) when content is absent.
  const isCloudflareChallenge = async () => {
    try {
      // Positive: real content present means we're past the challenge.
      const contentLinks = await p.locator('a[href*="store.steampowered.com/app/"]').count().catch(() => 0);
      if (contentLinks > 0) return false;
      // We're stuck somewhere — figure out if it's CF specifically.
      const url = p.url();
      if (/challenges\.cloudflare\.com|__cf_chl_/.test(url)) return true;
      const title = await p.title().catch(() => '');
      if (/just a moment|attention required|access denied/i.test(title)) return true;
      const bodyText = (await p.locator('body').innerText().catch(() => '')).toLowerCase();
      return /verifying you are human|checking if the site connection is secure|please complete the security check|just a moment/.test(bodyText);
    } catch { return false; }
  };

  if (await isCloudflareChallenge()) {
    const solved = await awaitUserCaptchaSolve(p, {
      service: 'steam',
      label: 'SteamDB Cloudflare challenge',
      captchaCheck: isCloudflareChallenge,
    });
    if (!solved) {
      log.warn('SteamDB still blocked by Cloudflare — skipping discovery this run');
      await dumpDiscoveryDiagnostic(p, 'cloudflare-timeout');
      return [];
    }
    // Cloudflare auto-redirects to the real page after the challenge passes;
    // give it a beat to render the app list before scraping.
    await p.waitForTimeout(2000);
  }

  if (cfg.debug) {
    const pageText = await p.locator('body').innerText();
    console.log('SteamDB page text (first 2000 chars):', pageText.substring(0, 2000));
  }

  const storeLinks = await p.locator('a[href*="store.steampowered.com/app/"]').all();
  const seen = new Set();
  const games = [];

  for (const link of storeLinks) {
    try {
      const href = await link.getAttribute('href');
      const appMatch = href.match(/\/app\/(\d+)/);
      if (!appMatch) continue;
      const appId = appMatch[1];
      if (seen.has(appId)) continue;

      let cardEl = link;
      let cardText = '';
      for (let depth = 0; depth < 12; depth++) {
        cardEl = cardEl.locator('..');
        try {
          cardText = await cardEl.innerText({ timeout: 2000 });
        } catch { break; }
        const cardLower = cardText.toLowerCase();
        if (cardLower.includes('free to keep') || cardLower.includes('play for free') || cardLower.includes('free weekend')) {
          break;
        }
      }

      const cardLower = cardText.toLowerCase();
      if (!cardLower.includes('free to keep')) continue;
      if (cardLower.includes('play for free') || cardLower.includes('free weekend')) continue;
      if (cardLower.includes('potentially upcoming')) continue;

      seen.add(appId);

      let name = null;
      const lines = cardText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const skipPatterns = /^(free to keep|play for free|free weekend|view store|install|started|expires|ends|in \d|today|tomorrow|\d{1,2}\s+\w+\s+\d{4})/i;
      for (const line of lines) {
        if (line.match(/^https?:\/\//)) continue;
        if (line.match(skipPatterns)) continue;
        if (line.length >= 2 && line.length <= 200) {
          name = line;
          break;
        }
      }
      if (!name) name = `App ${appId}`;

      let endDate = null;
      for (const line of lines) {
        const lineLower = line.toLowerCase();
        if (lineLower.includes('expires') || lineLower.includes('ends')) {
          const fullMatch = line.match(/(\d{1,2}\s+\w+\s+\d{4})\s*[\u2013\u2014\-\u2015–—]*\s*([\d:]+\s*UTC)/);
          if (fullMatch) { endDate = `${fullMatch[1]} ${fullMatch[2]}`; break; }
          const dateMatch = line.match(/(\d{1,2}\s+\w+\s+\d{4})/);
          if (dateMatch) { endDate = dateMatch[1]; break; }
          const relMatch = line.match(/(in\s+\d+\s+\w+|tomorrow|today)/i);
          if (relMatch) { endDate = relMatch[1]; break; }
        }
      }

      games.push({
        appId,
        name,
        url: `https://store.steampowered.com/app/${appId}/`,
        endDate,
      });
    } catch (e) {
      if (cfg.debug) console.error('Error parsing SteamDB entry:', e.message);
    }
  }

  if (cfg.debug) console.log(`  Found ${games.length} free-to-keep promotion(s) on SteamDB`);
  // Empty result + no detected challenge = something else broke. Dump the
  // page so we can see whether SteamDB returned an unexpected layout, an
  // error page, a different gating mechanism, etc. The dump lets us widen
  // the detector heuristics next iteration without requiring the user to
  // reproduce live in noVNC.
  if (games.length === 0) {
    await dumpDiscoveryDiagnostic(p, 'zero-promotions');
  }
  return games;
}

async function dumpDiscoveryDiagnostic(p, reason) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `steam-discover-${reason}-${ts}`;
    await p.screenshot({ path: dataDir(`${base}.png`), fullPage: true });
    writeFileSync(dataDir(`${base}.html`), await p.content());
    log.warn(`Saved Steam-discovery diagnostic: data/${base}.{png,html}`);
  } catch (e) {
    log.warn(`Failed to save Steam-discovery diagnostic: ${e.message.split('\n')[0]}`);
  }
}

try {
  await context.addCookies([
    { name: 'wants_mature_content', value: '1', domain: 'store.steampowered.com', path: '/' },
    { name: 'birthtime', value: '631152001', domain: 'store.steampowered.com', path: '/' },
    { name: 'lastagecheckage', value: '1-0-1990', domain: 'store.steampowered.com', path: '/' },
    { name: 'Steam_Language', value: 'english', domain: 'store.steampowered.com', path: '/' },
  ]);

  await page.goto(URL_STORE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const isLoggedIn = async () => {
    const pulldown = page.locator('#account_pulldown');
    return await pulldown.count() > 0 && (await pulldown.innerText()).trim().length > 0;
  };

  while (!await isLoggedIn()) {
    log.warn('Not signed in to Steam');
    if (cfg.nowait) process.exit(1);
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
    log.status('Login timeout', `${cfg.login_timeout / 1000}s`);
    if (cfg.steam_email && cfg.steam_password) log.info('Using credentials from environment');
    else log.info('Press ESC to login in browser (not possible in headless mode)');
    const email = cfg.steam_email || await prompt({ message: 'Enter Steam email/username' });
    const password = email && (cfg.steam_password || await prompt({ type: 'password', message: 'Enter Steam password' }));
    if (email && password) {
      await page.waitForTimeout(2000);
      const usernameInput = page.locator('input[type="text"]._2GBWeup5cttgbTw8FM3tfx, input[type="text"][class*="newlogindialog"], input[type="text"]').first();
      const passwordInput = page.locator('input[type="password"]').first();
      await usernameInput.fill(email);
      await passwordInput.fill(password);
      await page.locator('button[type="submit"], button:has-text("Sign in")').first().click();
      page.waitForSelector('[class*="newlogindialog_AwaitingMobileConfLabel"], [class*="segmentedinputs"]').then(async () => {
        log.info('Steam Guard — enter the code from your authenticator app or email');
        const code = await prompt({ type: 'text', message: 'Enter Steam Guard code', validate: n => n.toString().length == 5 || 'The code must be 5 characters!' });
        if (code) {
          const inputs = await page.locator('[class*="segmentedinputs"] input').all();
          if (inputs.length > 0) {
            for (let i = 0; i < code.length && i < inputs.length; i++) {
              await inputs[i].fill(code[i]);
            }
          } else {
            await page.locator('input[type="text"]').first().fill(code);
            await page.locator('button[type="submit"], button:has-text("Submit")').first().click();
          }
        }
      }).catch(_ => {});
      try {
        await page.waitForURL('https://store.steampowered.com/', { timeout: cfg.login_timeout });
      } catch {
        await page.goto(URL_STORE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
      }
    } else {
      log.info('Waiting for you to login in the browser');
      await notify('steam: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        log.info('Run `SHOW=1 node steam` to login in the opened browser');
        await context.close();
        process.exit(1);
      }
      await page.waitForSelector('#account_pulldown', { timeout: cfg.login_timeout });
    }
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
    await page.goto(URL_STORE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }

  user = (await page.locator('#account_pulldown').innerText()).trim();
  log.status('User', user);
  db.data[user] ||= {};

  const freeGames = await discoverFreeGames(page);

  log.status('Promotions found', freeGames.length);

  let claimed = 0;
  let skipped = 0;
  let existed = 0;

  for (const game of freeGames) {
    const appId = game.appId;

    if (db.data[user][appId]?.status === 'claimed' || db.data[user][appId]?.status === 'existed') {
      const knownTitle = db.data[user][appId]?.title || game.name;
      log.ok(`${knownTitle} — already in library`);
      existed++;
      continue;
    }

    const details = await getGameDetails(page, game.url);
    const title = details.title || game.name;
    const endStr = game.endDate ? ` (ends ${game.endDate})` : '';

    db.data[user][appId] ||= { title, time: datetime(), url: game.url };

    if (details.alreadyOwned) {
      log.ok(`${title} — already in library`);
      db.data[user][appId].status ||= 'existed';
      notify_games.push({ title, url: game.url, status: 'existed' });
      continue;
    }

    if (!details.isFree) {
      log.skip(title, 'not currently free on store page');
      skipped++;
      continue;
    }

    if (details.rating === null) {
      log.skip(title, 'no reviews (unrated)');
      skipped++;
      continue;
    }

    if (details.rating < cfg.steam_min_rating) {
      log.skip(title, `rating ${details.rating}/9 (${details.ratingText}) below min ${cfg.steam_min_rating}`);
      skipped++;
      continue;
    }

    if (details.originalPrice !== null && details.originalPrice < cfg.steam_min_price) {
      log.skip(title, `price $${details.originalPrice} below min $${cfg.steam_min_price}`);
      skipped++;
      continue;
    }

    log.game(title, `free-to-keep${endStr}`);

    if (cfg.dryrun) {
      log.warn(`dry run, skipping claim`);
      notify_games.push({ title, url: game.url, status: 'skipped' });
      continue;
    }

    if (!details.canClaim) {
      log.fail(`no "Add to Account" button found`);
      db.data[user][appId].status = 'failed: no claim button';
      notify_games.push({ title, url: game.url, status: 'failed: no claim button', details: `Game: ${game.url}` });
      continue;
    }

    try {
      const addBtn = page.locator('a.btn_green_steamui:has-text("Add to Account"), .game_purchase_action .btn_addtocart a:has-text("Add to Account")').first();
      await addBtn.click();
      await page.waitForTimeout(3000);

      const successIndicators = [
        page.locator('text=has been added to your account'),
        page.locator('.newmodal_content:has-text("added")'),
        page.locator('.game_area_already_owned'),
      ];

      let success = false;
      for (const indicator of successIndicators) {
        if (await indicator.count() > 0) {
          success = true;
          break;
        }
      }

      if (!success) {
        await page.goto(game.url, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        await dismissAgeGate(page);
        if (await page.locator('.game_area_already_owned').count() > 0) {
          success = true;
        }
      }

      if (success) {
        log.ok(`${title} — claimed!`);
        db.data[user][appId].status = 'claimed';
        db.data[user][appId].time = datetime();
        notify_games.push({ title, url: game.url, status: 'claimed' });
        claimed++;
      } else {
        log.fail(`${title} — could not verify claim`);
        db.data[user][appId].status = 'failed';
        notify_games.push({ title, url: game.url, status: 'failed', details: `Game: ${game.url}` });
      }

      await page.screenshot({ path: screenshot(`${filenamify(title)}.png`) });
    } catch (e) {
      log.fail(`${title} — ${e.message}`);
      db.data[user][appId].status = 'failed';
      notify_games.push({ title, url: game.url, status: 'failed', details: `Game: ${game.url}` });
      await page.screenshot({ path: screenshot('failed', `${filenamify(title)}_${filenamify(datetime())}.png`) });
    }
  }

  existed += notify_games.filter(g => g.status === 'existed').length;
  log.summary([`${claimed} claimed`, `${skipped} skipped`, `${existed} already owned`]);

} catch (error) {
  process.exitCode ||= 1;
  log.fail(`Exception: ${error.message || error}`);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode != 130) await notify(`steam failed: ${error.message.split('\n')[0]}`);
} finally {
  await db.write();
  log.sectionEnd();
  if (notify_games.filter(g => g.status === 'claimed' || g.status === 'failed').length) {
    await notify(`steam (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (page.video()) log.info(`Recorded video — ${await page.video().path()}`);
await context.close();
