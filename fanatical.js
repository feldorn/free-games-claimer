import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { chromium } from 'patchright';
import { datetime, notify, log, dataDir, handleSIGINT } from './src/util.js';
import { cfg } from './src/config.js';

// Watch-only Fanatical free-Steam-keys tracker. No login, no auto-claim
// — loads fanatical.com/en/free-games-keys in a real browser (their
// /api/products/* endpoints reject bare HTTP clients with 403, but a
// Playwright browser carries the JS-injected headers/keys the API
// requires), captures the API responses the page itself fires, and
// diffs against a saved baseline. Pushes a notification on new free
// items.
//
// Pattern matches humble-bundle.js: Cloudflare/anti-bot gating means
// bare fetch isn't an option, but a real browser navigation works.
// Fanatical's free-games page is a curated list (no need to filter
// down a noisy general search like Humble), so once the API endpoint
// is captured, every visible item should already be free; we still
// price-filter as a defensive guard against API surface changes.
//
// Why watch-only: Fanatical's claim flow requires login + filling a
// form per giveaway. The Steam key reveal lands in different DOM
// positions across promo formats. Watching the public free-games
// list and pushing a notification is the cheaper-to-maintain default;
// upgrade to claim+redeem (writing entries with code + store:
// 'steampowered.com' so the panel's Steam batch redeemer picks them
// up) once the flow has been observed stable across multiple events.

handleSIGINT();
log.section('Fanatical (watch-only)');
log.status('Time', datetime());

const URL_PAGE = 'https://www.fanatical.com/en/free-games-keys';
const STATE_FILE = dataDir('fanatical-watch.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return { products: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { products: {} }; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { log.warn(`Failed to save Fanatical watch state: ${e.message.split('\n')[0]}`); }
}

let context, page;
let captured = [];
try {
  context = await chromium.launchPersistentContext(cfg.dir.browser, {
    // Headed chromium — the container only ships full chrome, not the
    // separate chrome-headless-shell. Page renders into the unused VNC
    // surface; we close the context as soon as the API response has
    // been captured.
    headless: false,
    viewport: { width: cfg.width, height: cfg.height },
    locale: 'en-US',
    handleSIGINT: false,
    args: ['--hide-crash-restore-bubble'],
  });
  page = context.pages()[0] || await context.newPage();
  context.setDefaultTimeout(30000);

  // Intercept any /api/ JSON response. Fanatical's exact freebie
  // endpoint isn't public knowledge (the obvious /api/free-games-keys
  // returns 404; /api/products/free returns "Request blocked"), so
  // we cast a wide net and let the response interceptor catch
  // whatever the SPA actually requests.
  // The free-games data comes from /api/all-promotions/en (verified
  // live: top-level `freeProducts` array, each entry a "promo tier"
  // with min_spend per currency and a nested products[*].freegames[*]
  // list of the items available at that tier). Tier with min_spend=0
  // = no-purchase-required giveaway; higher tiers = free-with-spend.
  // We track the no-purchase tier only — the others would require
  // user interpretation that doesn't fit "we have new freebies".
  page.on('response', async (resp) => {
    try {
      if (!/\/api\/all-promotions\//i.test(resp.url())) return;
      if (!resp.ok()) return;
      const json = await resp.json();
      const free = Array.isArray(json?.freeProducts) ? json.freeProducts : [];
      for (const promo of free) {
        const minUsd = Number(promo?.min_spend?.USD);
        if (!Number.isFinite(minUsd) || minUsd > 0) continue;
        const promoProducts = Array.isArray(promo?.products) ? promo.products : [];
        for (const p of promoProducts) {
          const freegames = Array.isArray(p?.freegames) ? p.freegames : [];
          for (const fg of freegames) captured.push(fg);
        }
      }
    } catch { /* swallow per-response parse errors */ }
  });

  await page.goto(URL_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
} catch (e) {
  log.warn(`Fanatical watch fetch failed: ${e.message.split('\n')[0]}`);
  try { if (context) await context.close(); } catch {}
  process.exit(0);
} finally {
  try { if (context) await context.close(); } catch {}
}

log.status('Fanatical API responses captured', captured.length);
if (captured.length === 0) {
  log.warn('Fanatical free-games page rendered no API products — endpoint may need updating');
  process.exit(0);
}

// Build a {slug → product} map. Each captured item is already a
// freegame from the no-spend tier. Filter to type === 'game' since
// this collector exists to surface free Steam-key giveaways — comics
// and books are also free here but firing a notification per comic
// would be spam (Fanatical rotates comic freebies frequently).
//
// Fanatical's product page URL uses /en/game/<slug> for games. If
// you want comics/books too, drop the type filter below.
const products = new Map();
for (const r of captured) {
  if (!r || typeof r !== 'object') continue;
  if (r.type && r.type !== 'game') continue;
  const id = r.slug || r.sku || r._id || r.id;
  const name = r.name || r.title || id;
  if (!id || !name) continue;
  const url = r.slug ? `https://www.fanatical.com/en/game/${r.slug}` : 'https://www.fanatical.com/en/free-games-keys';
  // Note hint: drm tag (Steam, GOG, etc) so the user knows the platform.
  const drm = Array.isArray(r.drm) ? r.drm.join(',') : (r.drm?.steam ? 'steam' : 'free');
  if (!products.has(id)) products.set(id, { name, url, note: drm });
}

log.status('Free Fanatical products on page', products.size);

const prev = loadState();
const newEntries = [];
const current = {};

for (const [id, info] of products) {
  current[id] = { ...info, firstSeen: prev.products?.[id]?.firstSeen || datetime() };
  if (!prev.products?.[id]) newEntries.push({ id, ...info });
}

const isFirstRun = Object.keys(prev.products || {}).length === 0;
saveState({ products: current });

if (newEntries.length === 0) {
  log.info('No new Fanatical free items since last check');
  process.exit(0);
}

if (isFirstRun) {
  log.info(`Baseline established with ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'} (no notification on first run)`);
  for (const e of newEntries) log.game(e.name, String(e.note));
  process.exit(0);
}

for (const e of newEntries) log.game(e.name, `new — ${e.note}`);

// Plain-text body. Pushover strips HTML but auto-linkifies bare URLs;
// keep one URL per line so they remain tappable on a phone.
const subject = `Fanatical has ${newEntries.length} new free Steam key${newEntries.length === 1 ? '' : 's'} — claim manually`;
log.info(subject);
const lines = [subject];
for (const e of newEntries) lines.push(`- ${e.name}: ${e.url}`);
const body = lines.join('<br>');
await notify(body).catch(err => log.warn(`Notify failed: ${err.message.split('\n')[0]}`));
