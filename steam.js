import { chromium } from 'patchright';
import { writeFileSync } from 'node:fs';
import { resolve, jsonDb, datetime, filenamify, prompt, notify, html_game_list, handleSIGINT, log, dataDir, cleanProfileLocks, matchKey, stripGpTail, getDiscoveryUserMarkedKeys, localeArgs } from './src/util.js';
import { cfg } from './src/config.js';
import { siteVersion } from './src/sites.js';
import { fetchGamerPowerGiveaways, filterFor as filterGpFor, resolveGamerPowerHref } from './src/gamerpower.js';
import { fetchFGFPosts, filterFor as filterFgfFor, cleanTitle as fgfClean } from './src/freegamefindings.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'steam', ...a);

const URL_STORE = 'https://store.steampowered.com';
const URL_LOGIN = `${URL_STORE}/login/`;

// All our store-page selectors and success indicators key off English text
// ("Add to Account", "has been added to your account", etc.). The
// Steam_Language=english cookie set at context-init time is supposed to keep
// pages in English, but Steam doesn't always honor it — non-English Accept-
// Language headers (e.g. de-DE) and prior language preferences sticking to
// the account both override it (#68: German user got "Hinzufügen" /
// "Zur Bibliothek hinzufügen" buttons, locator never matched). The ?l=english
// URL query param is authoritative — Steam respects it per-request regardless
// of cookies or headers — so we append it to every store-page navigation.
const withEnglish = (u) => u + (u.includes('?') ? '&' : '?') + 'l=english';

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

log.section(`Steam (v${siteVersion('steam')})`);
log.status('Min rating', `${cfg.steam_min_rating}/9 (${Object.entries(RATING_MAP).find(([, v]) => v === cfg.steam_min_rating)?.[0] || '?'})`);
log.status('Min price', `$${cfg.steam_min_price}`);

const db = await jsonDb('steam.json', {});

// One-time backfill for historical orphan rows. The Steam filter loop
// only runs against appIds currently in Steam's free-games-list, so a
// game that was tracked here but later rolled off the list never re-
// enters the loop and never gets a status stamped. Pre-hygiene-fix
// (commit eda3c49) the skip paths didn't write a status at all, so
// these rows persist as unexplained no-status entries indefinitely.
// Stamp 'skipped:legacy' so the data is self-describing. Idempotent.
for (const userRecords of Object.values(db.data || {})) {
  if (!userRecords || typeof userRecords !== 'object') continue;
  for (const entry of Object.values(userRecords)) {
    if (entry && typeof entry === 'object' && !entry.status) {
      entry.status = 'skipped:legacy';
    }
  }
}

cleanProfileLocks(cfg.dir.browser);
const context = await chromium.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: 'en-US',
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined,
  recordHar: cfg.record ? { path: `data/record/steam-${filenamify(datetime())}.har` } : undefined,
  handleSIGINT: false,
  args: [
    '--hide-crash-restore-bubble',
    ...localeArgs(),
  ],
});

handleSIGINT(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage();
await page.setViewportSize({ width: cfg.width, height: cfg.height });

const notify_games = [];
let user;

// Steam's public storesearch JSON API — anonymous, returns matches for
// a query string with appId + type + name. Used by the GamerPower "Key
// Giveaway" ownership-check path (xh43k's #119 follow-up, 2026-07-22):
// GamerPower URLs for third-party key promos don't resolve to a Steam
// /app/<id>/ so we can't check ownership without first locating the
// game's Steam appId. matchKey normalization avoids false negatives on
// punctuation/case differences between GamerPower and Steam titles.
// Returns the matched appId as a string, or null if no exact match /
// search failed. Best-effort — network transients degrade to null.
async function steamSearchByTitle(title) {
  try {
    const url = 'https://store.steampowered.com/api/storesearch/?term=' +
      encodeURIComponent(String(title || '').trim()) +
      '&l=en&cc=US';
    const r = await fetch(url, { headers: { 'User-Agent': 'free-games-claimer' } });
    if (!r.ok) return null;
    const j = await r.json();
    const items = Array.isArray(j.items) ? j.items : [];
    if (!items.length) return null;
    const needle = matchKey(title);
    for (const it of items) {
      if (it.type === 'app' && matchKey(it.name || '') === needle) {
        return String(it.id);
      }
    }
    return null;
  } catch { return null; }
}

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
  await p.goto(withEnglish(url), { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);

  await dismissAgeGate(p);

  const details = { url, title: null, rating: null, ratingText: null, originalPrice: null, isFree: false, alreadyOwned: false, canClaim: false, isDlc: false, baseAppId: null };

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

  // DLC detection (xh43k's #119, 2026-07-21): Steam DLC pages carry a
  // `.game_area_dlc_bubble` marker linking to the base game. If the user
  // doesn't own the base game, Steam will refuse the "Add to Account"
  // click — which we currently mark as generic `failed` and retry every
  // run, spamming per-item notifications. Detect it upfront so the
  // claim loop can skip persistently.
  try {
    const dlcBubble = p.locator('.game_area_dlc_bubble').first();
    if (await dlcBubble.count() > 0) {
      details.isDlc = true;
      const baseLink = dlcBubble.locator('a[href*="/app/"]').first();
      if (await baseLink.count() > 0) {
        const href = await baseLink.getAttribute('href');
        const m = /\/app\/(\d+)/.exec(href || '');
        details.baseAppId = m ? m[1] : null;
      }
    }
  } catch {}

  if (!details.alreadyOwned && details.isFree) {
    const addToAccount = p.locator('a.btn_green_steamui:has-text("Add to Account"), .game_purchase_action .btn_addtocart a:has-text("Add to Account")');
    if (await addToAccount.count() > 0) {
      details.canClaim = true;
    }
  }

  return details;
}

async function discoverFreeGames(p) {
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

  // Supplementary discovery via gamerpower.com — see feldorn#33. The
  // Steam search endpoint is reliable for `specials=1&maxprice=free` but
  // misses some launch-week free-to-keep promos that go directly to
  // store pages without being flagged as discounted-to-zero. GamerPower
  // catches those. Resolve each /open/ redirect to a store.steampowered.com
  // /app/N URL, extract the appId, and merge into freeGames so the existing
  // claim loop processes it. Non-/app/ resolutions (sub/, community, etc.)
  // are surfaced as manual actions.
  try {
    const gpAll = await fetchGamerPowerGiveaways();
    const gpSteam = filterGpFor(gpAll, 'steam');
    if (gpSteam.length) {
      // Infra breadcrumb only — user isn't going to act on "GamerPower
      // returned N entries", the actionable signal is what happens with
      // each entry. Silenced from the normal log; DEBUG=1 restores.
      if (cfg.debug) console.debug(`GamerPower (Steam): ${gpSteam.length} entry/entries`);
      const knownIds = new Set(freeGames.map(g => g.appId));
      // Pre-resolve title index (2026-07-19): the resolveGamerPowerHref
      // call below hits GamerPower's /open/ page + follows a redirect to
      // Steam — ~1-2s HTTP round trip per entry. If the entry's title
      // already matches a Steam-search-discovered game in freeGames, we
      // KNOW the appId is in knownIds; the resolve just confirms what we
      // already know. Skip it. Only saves ~5s per run in practice
      // (overlap is usually 2-3 games) but eliminates a class of wasted
      // work.
      const titleToAppId = new Map();
      for (const g of freeGames) {
        const k = matchKey(g.name || '');
        if (k) titleToAppId.set(k, g.appId);
      }
      const userMarked = getDiscoveryUserMarkedKeys();
      for (const entry of gpSteam) {
        const stripped = stripGpTail(entry.title);
        const titleKey = matchKey(stripped);
        const dedupKey = `steam::${titleKey}`;
        if (userMarked.has(dedupKey)) {
          log.info(`GamerPower → ${entry.title}: already triaged via Discoveries tab, skipping`);
          continue;
        }
        if (titleKey && titleToAppId.has(titleKey)) {
          // Title matches a Steam-search entry already in the queue —
          // no need to resolve the URL just to dedupe. Silent skip.
          if (cfg.debug) console.debug(`GamerPower → ${entry.title}: title matches queued Steam-search entry, skipping resolve`);
          continue;
        }
        const resolved = await resolveGamerPowerHref(context, entry.open_giveaway_url, 'steam');
        const appMatch = resolved && /store\.steampowered\.com\/app\/(\d+)/.exec(resolved);
        if (appMatch) {
          const appId = appMatch[1];
          if (knownIds.has(appId)) {
            // Silent dedupe — Steam's own /search endpoint already added
            // this appId. The old log.info line surfaced dev-facing dedup
            // plumbing to users and, when interleaved with unrelated
            // per-game lines (Dwarven "manual action", FGF 403, etc.),
            // made it look like the deduped game had issues too. The
            // authoritative "already owned" / "claimed" line at claim-
            // time is the sole user-facing message for these games.
            // Report 2026-07-19.
            if (cfg.debug) console.debug(`GamerPower → ${entry.title}: appId ${appId} already in queue (deduped)`);
            continue;
          }
          knownIds.add(appId);
          log.info(`GamerPower → ${entry.title}: appId ${appId}`);
          freeGames.push({ appId, name: entry.title, url: `https://store.steampowered.com/app/${appId}/`, endDate: entry.end_date || null });
        } else {
          // Price gate — match the Discoveries-tab forecast (interactive-
          // login.js forecastSkip). If GamerPower's advertised `worth`
          // parses to a value below cfg.steam_min_price, the Discoveries
          // tab already badges the entry SKIP with the same "under your
          // min-price" reasoning. Surfacing a "manual action needed"
          // notify for the same item is a self-contradiction — the user
          // gets a push telling them to act on something the UI tells
          // them to skip. Silently drop the manual-action notify in that
          // case; the log.info line below stays for run-log traceability.
          // Non-parseable worth (missing / "N/A") falls through to the
          // action path — user should still evaluate. Found 2026-07-19
          // via Dwarven Realms ($9.99) contradicting a $10 min-price
          // config.
          const worthVal = parsePrice(entry.worth);
          if (worthVal !== null && worthVal < cfg.steam_min_price) {
            log.info(`GamerPower → ${entry.title}: worth $${worthVal.toFixed(2)} < min $${cfg.steam_min_price} — skipping manual-action notify (Discoveries tab shows it with SKIP badge)`);
            continue;
          }

          // Tier A ownership gate (xh43k's #119 follow-up, 2026-07-22):
          // title-match against the Steam claim DB. If ANY row in this
          // user's Steam DB has status claimed/existed AND a matching
          // normalized title, we already own the game — suppress the
          // manual-action notify. Covers games claimed via us plus any
          // Tier B lookups from prior runs (which persist matched
          // appIds as `status: 'existed'`).
          const strippedTitle = stripGpTail(entry.title);
          const titleKey = matchKey(strippedTitle);
          const ownedByTitle = titleKey && Object.values(db.data[user] || {}).some(row =>
            row && (row.status === 'claimed' || row.status === 'existed')
              && matchKey(row.title || '') === titleKey);
          if (ownedByTitle) {
            log.info(`GamerPower → ${entry.title}: already claimed per Steam DB (title match) — skipping manual-action notify`);
            continue;
          }

          // Tier B ownership check (Steam-search-by-title): for
          // "Key Giveaway" titles the GamerPower URL doesn't resolve
          // to a Steam store /app/<id>/, so we can't check ownership
          // without first locating the appId. Query Steam's public
          // storesearch API by title; if exact match, visit the store
          // page and read `.game_area_already_owned`. Owned → persist
          // as `status: 'existed'` (Tier A will now catch on subsequent
          // runs, no repeated search) + suppress notify.
          //
          // Best-effort: search/goto failures fall through to the
          // existing notify path so we never silently drop items on
          // Steam-search hiccups. ~1-2 HTTP roundtrips per Key
          // Giveaway per run; rare enough not to bother batching.
          if (/\bKey Giveaway\b/i.test(entry.title)) {
            try {
              const matchedAppId = await steamSearchByTitle(strippedTitle);
              if (matchedAppId) {
                const storeUrl = `https://store.steampowered.com/app/${matchedAppId}/`;
                const details = await getGameDetails(page, storeUrl);
                if (details.alreadyOwned) {
                  db.data[user][matchedAppId] ||= { title: details.title || strippedTitle, time: datetime(), url: storeUrl };
                  db.data[user][matchedAppId].status = 'existed';
                  log.info(`GamerPower → ${entry.title}: appId ${matchedAppId} already in your Steam library (via title search) — skipping manual-action notify`);
                  continue;
                }
              }
            } catch (e) {
              if (cfg.debug) console.debug(`GamerPower → ${entry.title}: Tier-B ownership check failed (${String(e.message || e).split('\n')[0]}) — falling through to manual-action notify`);
            }
          }

          // Discoveries tab already surfaces "Key Giveaway" entries with
          // a MANUAL coverage badge + label (per v2.8.74's forecast). The
          // per-item Pushover notify still fires via notify_games below
          // when worth ≥ min_price. Log line is redundant and repeats
          // every run for the same items — silenced from the normal log.
          // DEBUG=1 restores per-item visibility.
          if (cfg.debug) console.debug(`GamerPower → ${entry.title}: not a /app/ URL — listing as manual action (${resolved || entry.open_giveaway_url})`);
          notify_games.push({ title: `${entry.title} (via GamerPower)`, url: resolved || entry.open_giveaway_url, status: 'action', details: `<a href="${resolved || entry.open_giveaway_url}">Claim manually</a>` });
        }
      }
    }
  } catch (e) {
    log.warn(`GamerPower discovery skipped — ${e.message.split('\n')[0]}`);
  }

  // Supplementary discovery via r/FreeGameFindings — direct store URLs
  // mean no browser-tab redirect dance (unlike GamerPower's CF-gated
  // /open/ page). Extract appId from store.steampowered.com/app/N and
  // merge into freeGames so the existing claim loop processes it. The
  // knownIds set dedupes against Steam-search-discovered entries and
  // anything GamerPower already added.
  try {
    const fgfAll = await fetchFGFPosts();
    const fgfSteam = filterFgfFor(fgfAll, 'steam');
    if (fgfSteam.length) {
      log.status('FreeGameFindings (Steam)', `${fgfSteam.length} post(s)`);
      const knownIds = new Set(freeGames.map(g => g.appId));
      const userMarked = getDiscoveryUserMarkedKeys();
      for (const post of fgfSteam) {
        const cleanedTitle = fgfClean(post.title);
        const dedupKey = `steam::${matchKey(cleanedTitle)}`;
        if (userMarked.has(dedupKey)) {
          log.info(`FGF → ${cleanedTitle}: already triaged via Discoveries tab, skipping`);
          continue;
        }
        const appMatch = /store\.steampowered\.com\/app\/(\d+)/.exec(post.url);
        if (!appMatch) {
          // Same rationale as the GamerPower non-/app/ path above —
          // Discoveries + notify_games are the actionable surfaces;
          // silenced from the normal log, DEBUG=1 restores.
          if (cfg.debug) console.debug(`FGF → ${cleanedTitle}: not a /app/ URL — listing as manual action (${post.url})`);
          notify_games.push({ title: `${cleanedTitle} (via FGF)`, url: post.url, status: 'action', details: `<a href="${post.url}">Claim manually</a>` });
          continue;
        }
        const appId = appMatch[1];
        if (knownIds.has(appId)) {
          // Silent dedupe — same rationale as the GamerPower path above
          // (see comment there). Keep dev-visible via DEBUG=1 only.
          if (cfg.debug) console.debug(`FGF → ${cleanedTitle}: appId ${appId} already in queue (deduped)`);
          continue;
        }
        knownIds.add(appId);
        log.info(`FGF → ${cleanedTitle}: appId ${appId}`);
        freeGames.push({ appId, name: cleanedTitle, url: post.url, endDate: null });
      }
    }
  } catch (e) {
    // Reddit's public JSON endpoint hard-blocks datacenter/container IPs;
    // nothing the user can act on. Silenced from the normal log — DEBUG=1
    // restores. GamerPower coverage still applies for FGF-equivalent
    // discoveries.
    if (cfg.debug) console.debug(`FreeGameFindings discovery skipped — ${e.message.split('\n')[0]}`);
  }

  log.status('Promotions found', freeGames.length);

  // Pre-pass DB-fastpath: split freeGames into already-claimed (skip
  // silently, count them) and to-be-processed. Aggregated single-line
  // count replaces N per-game "already owned" lines that added up on
  // libraries with many previously-claimed games — pure noise once the
  // fastpath is doing its job. DEBUG=1 restores per-title visibility.
  // (Reported 2026-07-19: log verbosity ask on a mature library.)
  const ownedFromDb = [];
  const dlcSkippedFromDb = [];
  const gamesToProcess = [];
  for (const game of freeGames) {
    const appId = game.appId;
    const st = db.data[user][appId]?.status;
    if (st === 'claimed' || st === 'existed') {
      const knownTitle = db.data[user][appId]?.title || game.name;
      if (cfg.debug) console.debug(`  • ${knownTitle} — already owned (from DB)`);
      ownedFromDb.push(knownTitle);
    } else if (st === 'skipped:requires-base-game') {
      // Terminal skip — DLC whose base game we've previously detected
      // as not-owned. Steam would refuse the claim anyway. Never retry.
      const knownTitle = db.data[user][appId]?.title || game.name;
      if (cfg.debug) console.debug(`  • ${knownTitle} — DLC skipped (base game not owned)`);
      dlcSkippedFromDb.push(knownTitle);
    } else {
      gamesToProcess.push(game);
    }
  }
  if (ownedFromDb.length) {
    // Direct console.log matches the shape of per-game log.owned lines
    // ("    • Game X — already owned") rather than adding a redundant
    // log.info ✓ prefix. Keeps the aggregate line visually aligned with
    // the individual lines it replaces.
    console.log(`    • ${ownedFromDb.length} game${ownedFromDb.length === 1 ? '' : 's'} already owned — skipped via claim DB (set DEBUG=1 to list)`);
  }
  if (dlcSkippedFromDb.length) {
    console.log(`    • ${dlcSkippedFromDb.length} DLC${dlcSkippedFromDb.length === 1 ? '' : 's'} skipped — base game not in library (set DEBUG=1 to list)`);
  }

  let claimed = 0;
  let skipped = dlcSkippedFromDb.length; // seed with DLC-DB-fastpath skips
  let existed = ownedFromDb.length;      // seed with owned-DB-fastpath count

  for (const game of gamesToProcess) {
    const appId = game.appId;

    const details = await getGameDetails(page, game.url);
    const title = details.title || game.name;
    const endStr = game.endDate ? ` (ends ${game.endDate})` : '';

    db.data[user][appId] ||= { title, time: datetime(), url: game.url };

    if (details.alreadyOwned) {
      log.owned(title);
      db.data[user][appId].status ||= 'existed';
      // Suppress the "(existed)" notification line when the user has
      // already triaged this title via the Discoveries tab — they know
      // they own it; one notification per first-discovery is plenty.
      const dedupKey = `steam::${matchKey(title)}`;
      if (!getDiscoveryUserMarkedKeys().has(dedupKey)) {
        notify_games.push({ title, url: game.url, status: 'existed' });
      }
      continue;
    }

    // DLC-without-base-game guard (xh43k's #119, 2026-07-21). Steam DLC
    // whose base game isn't in the user's library will get an "Add to
    // Account" refusal — historically we logged 'failed' and retried
    // every run, spamming per-item notifications. Mark terminal on
    // first detection: the DB fastpath above (`skipped:requires-base-
    // game`) then short-circuits subsequent runs. If baseAppId isn't
    // resolvable (rare — Steam's DLC-bubble markup change), fall
    // through to the normal claim path so we don't silently drop
    // items on false-positive detections. Ownership check honours the
    // same `claimed | existed` semantic the fastpath uses; anything
    // else (including no DB row) treats as not-owned.
    if (details.isDlc && details.baseAppId) {
      const baseStatus = db.data[user][details.baseAppId]?.status;
      const baseOwned = baseStatus === 'claimed' || baseStatus === 'existed';
      if (!baseOwned) {
        log.skip(title, `DLC — base game ${details.baseAppId} not in your library, Steam refuses claim (persistent skip; if you later acquire the base game, clear its steam.json entry to re-eval)`);
        db.data[user][appId].status = 'skipped:requires-base-game';
        db.data[user][appId].baseAppId = details.baseAppId;
        skipped++;
        continue;
      }
    }

    // The five skip paths below previously left the DB row's `status`
    // field unset, which made cold reads of steam.json ambiguous: a
    // row without a status looks structurally identical to a write-bug
    // gap (cf. the prime-gaming internal-claim bug). Setting an
    // explicit `skipped:<reason>` makes the data self-describing.
    // Re-evaluation on next run is preserved because line 414's early-
    // exit only short-circuits on `claimed` / `existed`.
    if (!details.isFree) {
      log.skip(title, 'not currently free on store page');
      db.data[user][appId].status = 'skipped:not-free';
      skipped++;
      continue;
    }

    if (details.rating === null) {
      if (cfg.steam_skip_unrated) {
        log.skip(title, 'no reviews (unrated) — set STEAM_SKIP_UNRATED=0 to claim anyway');
        db.data[user][appId].status = 'skipped:unrated';
        skipped++;
        continue;
      }
      // Letting it through — the user explicitly opted into unrated games.
      // Fall through to the price filter; the claim path still applies.
      log.info(`${title} — unrated but STEAM_SKIP_UNRATED=0, evaluating against price filter`);
    } else if (details.rating < cfg.steam_min_rating) {
      log.skip(title, `rating ${details.rating}/9 (${details.ratingText}) below min ${cfg.steam_min_rating}`);
      db.data[user][appId].status = 'skipped:rating';
      skipped++;
      continue;
    }

    if (details.originalPrice !== null && details.originalPrice < cfg.steam_min_price) {
      log.skip(title, `price $${details.originalPrice} below min $${cfg.steam_min_price}`);
      db.data[user][appId].status = 'skipped:price';
      skipped++;
      continue;
    }

    log.game(title, `free-to-keep${endStr}`);

    if (cfg.dryrun) {
      log.warn(`dry run, skipping claim`);
      db.data[user][appId].status = 'skipped:dryrun';
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
        await page.goto(withEnglish(game.url), { waitUntil: 'domcontentloaded' });
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
  log.summary({
    siteId: 'steam',
    claimed,
    skipped,
    display: 'alreadyOwned',
    alreadyOwned: existed,
  });
} catch (error) {
  process.exitCode ||= 1;
  log.exception(error);
  if (cfg.debug) console.error(error);
  if (error.message && process.exitCode != 130) await notify(`steam failed: ${error.message.split('\n')[0]}`, { attachLatestScreenshot: true });
} finally {
  await db.write();
  if (notify_games.filter(g => g.status === 'claimed' || g.status === 'failed' || g.status === 'action').length) {
    // Tag as 'summary' only when nothing in the list needs user action —
    // failures promote it back to 'action' so xh43k's "actions only"
    // mode still surfaces them. (#31)
    const hasActionable = notify_games.some(g => g.status === 'failed' || g.status === 'action');
    await notify(`steam (${user}):<br>${html_game_list(notify_games)}`, { kind: hasActionable ? 'action' : 'summary' });
  }
}
if (page.video()) log.info(`Recorded video — ${await page.video().path()}`);
await context.close();
