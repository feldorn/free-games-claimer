import { chromium } from 'patchright';
import { writeFileSync } from 'node:fs';
import { resolve, jsonDb, datetime, filenamify, prompt, notify, html_game_list, handleSIGINT, log, dataDir } from './src/util.js';
import { cfg } from './src/config.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'steam', ...a);

const URL_STORE = 'https://store.steampowered.com';
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
  log.status('Source', 'Steam search (specials, max price free)');
  return await discoverViaSteamSearch(p);
}

// Steam's own search infinite-scroll endpoint. Returns JSON with a
// results_html fragment we parse for the free-to-keep promotions.
//
// Why not SteamDB anymore: SteamDB sits behind Cloudflare with Private
// Access Token enforcement, which the patchright Chromium can't satisfy
// (PAT requires real Apple/Google attestation signing). We were getting
// 403 Forbidden with no recoverable challenge.
//
// Why "specials=1&maxprice=free": specials=1 only includes discounted
// games (so pure free-to-play games with $0 baseline are excluded for
// free), and maxprice=free narrows to discounts-to-zero. The result is
// exactly the "Free to Keep" set the script wants — no separate filter
// pass needed on the listing.
async function discoverViaSteamSearch(p) {
  const SEARCH_URL = 'https://store.steampowered.com/search/results/?query&specials=1&maxprice=free&infinite=1&count=200';
  let respText, status;
  try {
    const resp = await p.request.get(SEARCH_URL, { timeout: 30000 });
    status = resp.status();
    respText = await resp.text();
  } catch (e) {
    log.warn(`Steam search request failed: ${e.message.split('\n')[0]}`);
    return [];
  }
  if (status >= 400) {
    log.warn(`Steam search returned HTTP ${status} — skipping discovery`);
    saveSearchResponse(respText, `http-${status}`);
    return [];
  }

  let data;
  try { data = JSON.parse(respText); }
  catch {
    log.warn('Steam search returned non-JSON response — skipping discovery');
    saveSearchResponse(respText, 'invalid-json');
    return [];
  }

  if (data.success !== 1 || typeof data.results_html !== 'string') {
    log.warn(`Steam search response missing results_html (success=${data.success})`);
    saveSearchResponse(respText, 'unexpected-shape');
    return [];
  }

  // Parse each <a> result. Defense in depth: also confirm data-discount="100"
  // on each row so anything that snuck through with a different shape is
  // rejected — we want -100% off (the "Free to Keep" promotion pattern),
  // not a 99%-off-but-rounds-to-zero curiosity.
  const rowRegex = /<a\b[^>]*?data-ds-appid="(\d+)"[\s\S]*?<span class="title">([^<]+)<\/span>[\s\S]*?data-discount="(\d+)"[\s\S]*?<\/a>/g;
  const games = [];
  const seen = new Set();
  let m;
  while ((m = rowRegex.exec(data.results_html))) {
    const appId = m[1];
    if (seen.has(appId)) continue;
    if (parseInt(m[3], 10) !== 100) continue;
    seen.add(appId);
    games.push({
      appId,
      name: m[2].trim(),
      url: `https://store.steampowered.com/app/${appId}/`,
      // endDate is not on the search results page — the previous SteamDB-
      // scraped value was purely informational for log output, not a
      // claim-pipeline input, so dropping it is fine.
      endDate: null,
    });
  }

  if (cfg.debug) console.log(`  Parsed ${games.length} free-to-keep promotion(s) from Steam search (total_count=${data.total_count})`);
  if (games.length === 0 && data.total_count === 0) {
    log.info('No free-to-keep promotions on Steam right now');
  } else if (games.length === 0) {
    // Steam reported hits but our regex extracted none — selectors may have
    // shifted. Save the raw response so the next code change has source to
    // pattern-match against.
    log.warn(`Steam search reported ${data.total_count} hits but parser extracted 0 — selectors may have changed`);
    saveSearchResponse(respText, 'parser-mismatch');
  }
  return games;
}

// Persist a copy of an unexpected Steam search response to data/ so we can
// inspect it after the fact without needing to reproduce live. Cap the size
// because results_html can be megabytes when total_count is large.
function saveSearchResponse(text, reason) {
  if (typeof text !== 'string' || !text.length) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = `steam-discover-${reason}-${ts}.json`;
    writeFileSync(dataDir(base), text.slice(0, 200000));
    log.warn(`Saved Steam search response: data/${base}`);
  } catch (e) {
    log.warn(`Failed to save Steam search response: ${e.message.split('\n')[0]}`);
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
