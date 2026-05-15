import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { chromium } from 'patchright';
import { datetime, notify, log, dataDir, handleSIGINT, cleanProfileLocks } from './src/util.js';
import { cfg } from './src/config.js';
import { siteVersion } from './src/sites.js';

// Watch-only Humble Bundle free-items tracker. No login, no auto-claim —
// loads humblebundle.com/store/search?priceMax=0 in a real browser
// (Humble's Cloudflare gating rejects bare HTTP clients on the search
// API, but lets a real browser through to fetch the same data after a
// JS challenge), captures the API response the page itself fires, then
// diffs against a saved baseline and pushes a notification on new
// items. Mirrors the Ubisoft watcher pattern but uses Playwright since
// Humble's data is loaded client-side.
//
// Why watch-only: Humble's actual claim flow varies across promo
// formats (community freebie vs Choice unlock vs Trove drop), often
// requires captcha, and the resulting Steam-key reveal is unstable
// across UI refreshes. Watching the public store search for items
// priced at 0 and pushing a notification on new ones is the
// cheaper-to-maintain default. Upgrade to claim+redeem (writing
// entries with code + store: 'steampowered.com' so the panel's Steam
// batch redeemer picks them up) once the flow has been observed
// stable across multiple promo events.

handleSIGINT();
log.section(`Humble Bundle (v${siteVersion('humble-bundle')})`);

let _summaryStats = { siteId: 'humble-bundle', claimed: 0, skipped: 0, display: 'onPage', onPage: 0, new: 0 };
process.on('exit', code => {
  if (!code) log.summary(_summaryStats);
});

// Humble's `?priceMax=0` URL parameter does NOT actually filter the
// search to free items (verified live: the response returned 20
// paid titles the first time we tried it). Humble's free items
// surface as curated promo banners rather than via an exposed
// "free only" filter. We hit the standard newest-first search and
// rely on client-side `current_price.amount === 0` filtering — that
// catches the rare genuinely-free entries when they appear in the
// search response. Iterating to a curated promo URL (e.g.
// /store/promo/<slug>) once one is identified would make this
// runner sharper.
const URL_PAGE = 'https://www.humblebundle.com/store/search?sort=newest';
const STATE_FILE = dataDir('humble-bundle-watch.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return { products: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { products: {} }; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { log.warn(`Failed to save Humble watch state: ${e.message.split('\n')[0]}`); }
}

let context, page;
let captured = []; // accumulates products from any matching API responses
try {
  cleanProfileLocks(cfg.dir.browser);
  context = await chromium.launchPersistentContext(cfg.dir.browser, {
    // Match the project pattern (other site scripts use headed chromium
    // because the container only ships the full chrome binary, not the
    // separate chrome-headless-shell). The page renders into VNC; we
    // close the context once the API response has been captured.
    headless: false,
    viewport: { width: cfg.width, height: cfg.height },
    locale: 'en-US',
    handleSIGINT: false,
    args: ['--hide-crash-restore-bubble'],
  });
  page = context.pages()[0] || await context.newPage();
  context.setDefaultTimeout(30000);

  // Listen for the JSON the page itself fetches to populate the grid.
  // The path historically lives under /store/api/search; if Humble moves
  // it the predicate stays loose enough to catch likely renames.
  page.on('response', async (resp) => {
    try {
      const u = resp.url();
      if (!/\/store\/api\/(search|products)/i.test(u)) return;
      if (!resp.ok()) return;
      const ct = resp.headers()['content-type'] || '';
      if (!/json/.test(ct)) return;
      const json = await resp.json();
      const items = Array.isArray(json?.results) ? json.results
        : Array.isArray(json?.products) ? json.products
        : Array.isArray(json) ? json
        : [];
      for (const r of items) captured.push(r);
    } catch { /* swallow per-response parse errors */ }
  });

  await page.goto(URL_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Give the SPA a moment to fire its product fetch and Cloudflare to
  // settle. We don't wait on a specific selector because Humble's
  // tile classnames are React-hashed and shift between deploys; the
  // response interceptor is the stable hook.
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
} catch (e) {
  log.warn(`Humble watch fetch failed: ${e.message.split('\n')[0]}`);
  try { if (context) await context.close(); } catch {}
  process.exit(0);
} finally {
  // Close even if we got here through a logical exit so the next
  // claim script can take the profile.
  try { if (context) await context.close(); } catch {}
}

log.status('API responses captured', captured.length);
if (captured.length === 0) {
  log.warn('Humble store rendered no API products — endpoint or page URL may need updating');
  process.exit(0);
}

// Filter to genuinely free items. Humble's `current_price.amount` is in
// dollars (not cents) for the search response — confirmed by setting
// priceMax=0 and seeing all results report amount=0. Safe-parse anyway.
function priceOf(r) {
  const p = r.current_price?.amount ?? r.price?.amount ?? r.full_price?.amount;
  if (p == null) return null;
  const n = Number(p);
  return Number.isFinite(n) ? n : null;
}

const products = new Map();
for (const r of captured) {
  if (!r || typeof r !== 'object') continue;
  const id = r.machine_name || r.human_url || r.id;
  const name = r.human_name || r.title || id;
  if (!id || !name) continue;
  const price = priceOf(r);
  if (price == null || price > 0) continue;
  const url = r.human_url
    ? (r.human_url.startsWith('http') ? r.human_url : 'https://www.humblebundle.com/store/' + r.human_url)
    : `https://www.humblebundle.com/store/${id}`;
  // Keep a small note hint for the notification body (storefront tag,
  // delivery method, or os list — whichever the response carries).
  const note = r.delivery_methods?.length ? r.delivery_methods.join(',')
    : (r.os?.length ? r.os.join(',') : 'free');
  if (!products.has(id)) products.set(id, { name, url, note });
}

log.status('Free products on page', products.size);

const prev = loadState();
const newEntries = [];
const current = {};

for (const [id, info] of products) {
  current[id] = { ...info, firstSeen: prev.products?.[id]?.firstSeen || datetime() };
  if (!prev.products?.[id]) newEntries.push({ id, ...info });
}

const isFirstRun = Object.keys(prev.products || {}).length === 0;
saveState({ products: current });

_summaryStats = {
  siteId: 'humble-bundle',
  claimed: 0,
  skipped: 0,
  display: 'onPage',
  onPage: products.size,
  new: newEntries.length,
};

if (newEntries.length === 0) {
  log.info('No new Humble Bundle free items since last check');
  process.exit(0);
}

if (isFirstRun) {
  log.info(`Baseline established with ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'} (no notification on first run)`);
  for (const e of newEntries) log.game(e.name, e.note);
  process.exit(0);
}

for (const e of newEntries) log.game(e.name, `new — ${e.note}`);

// Plain-text body. Pushover strips HTML but auto-linkifies bare URLs;
// keep one URL per line so they remain tappable on a phone.
const subject = `Humble Bundle has ${newEntries.length} new free item${newEntries.length === 1 ? '' : 's'} — claim manually`;
log.info(subject);
const lines = [subject];
for (const e of newEntries) lines.push(`- ${e.name}: ${e.url}`);
const body = lines.join('<br>');
await notify(body).catch(err => log.warn(`Notify failed: ${err.message.split('\n')[0]}`));
