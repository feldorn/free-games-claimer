import { chromium } from 'patchright';
import chalk from 'chalk';
import { resolve, jsonDb, datetime, filenamify, prompt, notify, html_game_list, handleSIGINT } from './src/util.js';
import { cfg } from './src/config.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'steam', ...a);

const URL_STORE = 'https://store.steampowered.com';
const URL_SEARCH_FREE = `${URL_STORE}/search/?maxprice=free&specials=1`;
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

console.log(datetime(), 'started checking steam');
console.log(`Filters: min rating = ${cfg.steam_min_rating} (${Object.entries(RATING_MAP).find(([, v]) => v === cfg.steam_min_rating)?.[0] || '?'}), min original price = $${cfg.steam_min_price}`);

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
      console.log('  Handling age verification...');
      const yearSelect = p.locator('#ageYear');
      if (await yearSelect.count() > 0) {
        await yearSelect.selectOption('1990');
        await p.locator('#view_product_page_btn, .btnv6_blue_hoverfade').first().click();
      } else {
        await p.locator('a.btnv6_blue_hoverfade:has-text("View Page"), button:has-text("Continue")').first().click();
      }
      await p.waitForTimeout(2000);
    }
  } catch (_) {}
}

async function getGameDetails(p, url) {
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);

  await dismissAgeGate(p);

  const details = { url, title: null, rating: null, ratingText: null, originalPrice: null, isFree: false, isFreeToPlay: false, isFreeWeekend: false, isTemporaryPromo: false, alreadyOwned: false, canClaim: false };

  try {
    details.title = await p.locator('#appHubAppName, .apphub_AppName').first().innerText();
  } catch (_) {
    try {
      details.title = await p.locator('h2.pageheader').first().innerText();
    } catch (__) {
      details.title = url.split('/').filter(Boolean).pop();
    }
  }

  const pageText = await p.locator('body').innerText().catch(() => '');
  const pageTextLower = pageText.toLowerCase();

  if (await p.locator('.game_area_free_to_play, .btn_addtocart_content:has-text("Play Game"), .game_purchase_action:has-text("Free to Play")').count() > 0
      || pageTextLower.includes('free to play')) {
    details.isFreeToPlay = true;
  }

  if (pageTextLower.includes('free weekend') || pageTextLower.includes('play for free!') && pageTextLower.includes('weekend')) {
    details.isFreeWeekend = true;
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
  } catch (_) {}

  try {
    const discountOriginal = p.locator('.discount_original_price').first();
    if (await discountOriginal.count() > 0) {
      const priceText = await discountOriginal.innerText();
      details.originalPrice = parsePrice(priceText);
    }

    const discountFinal = p.locator('.discount_final_price').first();
    if (await discountFinal.count() > 0) {
      const finalText = (await discountFinal.innerText()).trim().toLowerCase();
      const finalPrice = parsePrice(finalText);
      details.isFree = finalText === 'free' || (finalPrice !== null && finalPrice === 0);
    }
  } catch (_) {}

  try {
    const discountEndEl = p.locator('.game_purchase_discount_countdown, .discount_countdown, [data-countdown-date]');
    if (await discountEndEl.count() > 0) {
      details.isTemporaryPromo = true;
    }
    const discountBlock = p.locator('.game_purchase_discount, .discount_block');
    if (await discountBlock.count() > 0) {
      const pctEl = discountBlock.locator('.discount_pct').first();
      if (await pctEl.count() > 0) {
        const pct = (await pctEl.innerText()).trim();
        if (pct === '-100%' && details.originalPrice && details.originalPrice > 0) {
          details.isTemporaryPromo = true;
        }
      }
    }
  } catch (_) {}

  if (await p.locator('.game_area_already_owned').count() > 0) {
    details.alreadyOwned = true;
  }

  if (!details.alreadyOwned && details.isFree && !details.isFreeToPlay && !details.isFreeWeekend) {
    const addToAccount = p.locator('a.btn_green_steamui:has-text("Add to Account"), .game_purchase_action .btn_addtocart a:has-text("Add to Account")');
    if (await addToAccount.count() > 0) {
      details.canClaim = true;
    }
  }

  return details;
}

async function parseSearchPage(p) {
  const games = [];
  const rows = await p.locator('#search_resultsRows a.search_result_row').all();

  for (const row of rows) {
    try {
      const href = await row.getAttribute('href');
      const appUrl = href.split('?')[0];
      const name = await row.locator('.title').innerText();

      let originalPrice = null;
      let isFreeToKeep = false;

      const discountPct = row.locator('.discount_pct');
      if (await discountPct.count() > 0) {
        const pctText = await discountPct.innerText();
        if (pctText.trim() === '-100%') {
          isFreeToKeep = true;
        }
      }

      if (!isFreeToKeep) continue;

      const origPriceEl = row.locator('.discount_original_price');
      if (await origPriceEl.count() > 0) {
        originalPrice = parsePrice(await origPriceEl.innerText());
      }

      if (originalPrice === null || originalPrice === 0) {
        if (cfg.debug) console.log(`  Skipping "${name}": no original price or F2P`);
        continue;
      }

      let ratingText = null;
      let rating = null;
      const reviewSpan = row.locator('.search_review_summary');
      if (await reviewSpan.count() > 0) {
        ratingText = await reviewSpan.getAttribute('data-tooltip-html');
        if (ratingText) {
          ratingText = ratingText.split('<br>')[0].trim();
          const normalized = ratingText.toLowerCase().replace(/[^a-z ]/g, '').trim();
          for (const [key, value] of Object.entries(RATING_MAP)) {
            if (normalized.includes(key)) {
              rating = value;
              break;
            }
          }
        }
      }

      games.push({ url: appUrl, name, originalPrice, rating, ratingText });
    } catch (e) {
      if (cfg.debug) console.error('Error parsing search row:', e.message);
    }
  }
  return games;
}

async function discoverFreeGames(p) {
  console.log('Searching for free-to-keep promotions on Steam...');

  const allGames = [];
  let pageNum = 1;
  const MAX_PAGES = 5;

  while (pageNum <= MAX_PAGES) {
    const start = (pageNum - 1) * 25;
    const url = `${URL_SEARCH_FREE}&start=${start}&count=25`;
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3000);

    const pageGames = await parseSearchPage(p);
    if (pageGames.length === 0) break;
    allGames.push(...pageGames);

    const nextBtn = p.locator('.search_pagination_right a:last-child');
    const hasNext = await nextBtn.count() > 0;
    if (!hasNext) break;

    const nextHref = await nextBtn.getAttribute('href');
    if (!nextHref || nextHref.includes(`start=${start}`)) break;

    pageNum++;
  }

  console.log(`Found ${allGames.length} free-to-keep promotion(s) across ${pageNum} page(s)`);
  return allGames;
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
    console.error('Not signed in to Steam.');
    if (cfg.nowait) process.exit(1);
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
    console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
    if (cfg.steam_email && cfg.steam_password) console.info('Using email and password from environment.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
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
        console.log('Steam Guard - enter the code from your authenticator app or email.');
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
      } catch (_) {
        await page.goto(URL_STORE, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
      }
    } else {
      console.log('Waiting for you to login in the browser.');
      await notify('steam: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node steam` to login in the opened browser.');
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
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};

  const freeGames = await discoverFreeGames(page);

  if (freeGames.length === 0) {
    console.log('No free-to-keep promotions found on Steam right now.');
  } else {
    console.log(`\nFound ${freeGames.length} free-to-keep promotion(s):`);
    for (const g of freeGames) {
      const ratingStr = g.ratingText ? `${g.ratingText} (${g.rating || '?'}/9)` : 'no reviews';
      const priceStr = g.originalPrice ? `$${g.originalPrice}` : 'unknown';
      console.log(`  ${chalk.blue(g.name)} - rating: ${ratingStr}, original price: ${priceStr}`);
    }
  }

  let claimed = 0;
  let skipped = 0;

  for (const game of freeGames) {
    const appId = game.url.match(/\/app\/(\d+)/)?.[1] || game.url.split('/').filter(Boolean).pop();
    console.log(`\nProcessing: ${chalk.blue(game.name)}`);

    if (db.data[user][appId]?.status === 'claimed' || db.data[user][appId]?.status === 'existed') {
      console.log(`  Already processed (${db.data[user][appId].status}). Skipping.`);
      continue;
    }

    if (game.rating === null) {
      console.log('  Skipped: no reviews (unrated games are always skipped)');
      skipped++;
      continue;
    }

    if (game.rating < cfg.steam_min_rating) {
      console.log(`  Skipped: rating ${game.ratingText} (${game.rating}/9) below minimum ${cfg.steam_min_rating}/9`);
      skipped++;
      continue;
    }

    if (game.originalPrice !== null && game.originalPrice < cfg.steam_min_price) {
      console.log(`  Skipped: original price $${game.originalPrice} below minimum $${cfg.steam_min_price}`);
      skipped++;
      continue;
    }

    const details = await getGameDetails(page, game.url);
    const title = details.title || game.name;

    db.data[user][appId] ||= { title, time: datetime(), url: game.url };

    if (details.alreadyOwned) {
      console.log('  Already in library! Nothing to claim.');
      db.data[user][appId].status ||= 'existed';
      notify_games.push({ title, url: game.url, status: 'existed' });
      continue;
    }

    if (details.isFreeToPlay) {
      console.log('  Skipped: permanently Free to Play game (not a temporary promotion).');
      skipped++;
      continue;
    }

    if (details.isFreeWeekend) {
      console.log('  Skipped: Free Weekend (temporary access, not free to keep).');
      skipped++;
      continue;
    }

    if (!details.isFree) {
      console.log('  Game is not currently free on store page. Skipping.');
      skipped++;
      continue;
    }

    if (!details.isTemporaryPromo) {
      console.log('  Skipped: could not confirm this is a temporary promotion (may be permanently free).');
      skipped++;
      continue;
    }

    if (details.rating === null) {
      console.log('  Skipped: no reviews on store page (unrated games are always skipped)');
      skipped++;
      continue;
    }

    if (details.rating < cfg.steam_min_rating) {
      console.log(`  Skipped: store page rating ${details.ratingText} (${details.rating}/9) below minimum ${cfg.steam_min_rating}/9`);
      skipped++;
      continue;
    }

    if (details.originalPrice !== null && details.originalPrice < cfg.steam_min_price) {
      console.log(`  Skipped: store page original price $${details.originalPrice} below minimum $${cfg.steam_min_price}`);
      skipped++;
      continue;
    }

    if (cfg.dryrun) {
      console.log('  DRYRUN=1 -> Skip claiming!');
      notify_games.push({ title, url: game.url, status: 'skipped' });
      continue;
    }

    if (!details.canClaim) {
      console.log('  No "Add to Account" button found. May require purchase or is unavailable.');
      db.data[user][appId].status = 'failed: no claim button';
      notify_games.push({ title, url: game.url, status: 'failed: no claim button' });
      continue;
    }

    console.log('  Claiming...');
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
        console.log('  Claimed successfully!');
        db.data[user][appId].status = 'claimed';
        db.data[user][appId].time = datetime();
        notify_games.push({ title, url: game.url, status: 'claimed' });
        claimed++;
      } else {
        console.error('  Claim may have failed - could not verify ownership.');
        db.data[user][appId].status = 'failed';
        notify_games.push({ title, url: game.url, status: 'failed' });
      }

      await page.screenshot({ path: screenshot(`${filenamify(title)}.png`) });
    } catch (e) {
      console.error('  Error claiming:', e.message);
      db.data[user][appId].status = 'failed';
      notify_games.push({ title, url: game.url, status: 'failed' });
      await page.screenshot({ path: screenshot('failed', `${filenamify(title)}_${filenamify(datetime())}.png`) });
    }
  }

  console.log(`\nSteam summary: ${claimed} claimed, ${skipped} skipped (filters), ${notify_games.filter(g => g.status === 'existed').length} already owned`);

} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error);
  if (error.message && process.exitCode != 130) await notify(`steam failed: ${error.message.split('\n')[0]}`);
} finally {
  await db.write();
  if (notify_games.filter(g => g.status === 'claimed' || g.status === 'failed').length) {
    await notify(`steam (${user}):<br>${html_game_list(notify_games)}`);
  }
}
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
