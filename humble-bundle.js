import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { datetime, notify, log, dataDir, handleSIGINT } from './src/util.js';

// Watch-only Humble Bundle free-items tracker. No login, no auto-claim —
// fetches Humble's public store search, filters to items priced at 0,
// diffs against a saved baseline, and pushes a notification when a new
// title shows up. Mirrors the Ubisoft watcher pattern.
//
// Why watch-only: Humble Bundle's claim flow is a moving target — varies
// by promotion type (community freebie vs Choice subscription unlock vs
// Trove drop), often requires logged-in session + sometimes a captcha,
// and the resulting Steam-key reveal lands in different DOM positions
// across promo formats. Building a robust auto-claim that survives a
// year of UI churn is a significant ongoing investment. Watch-only is
// the cheaper-to-maintain default; upgrade to claim+redeem (writing
// entries with code + store: 'steampowered.com' so the panel's Steam
// batch redeemer picks them up) only after we've seen the flow stable
// across multiple events.
//
// Selectors are scaffolded from public knowledge of Humble's store
// search response shape and may need iteration the first time the bot
// runs against the live site. On any unexpected response, the script
// logs a warning and exits 0 so the run chain doesn't fail.

handleSIGINT();
log.section('Humble Bundle (watch-only)');
log.status('Time', datetime());

// Public store search filtered to free items. Sort by newest so the
// first hits are the freshest promotions. The endpoint historically
// returns JSON with a `results` array of product summaries.
const URL_API = 'https://www.humblebundle.com/store/api/search?sort=newest&filter=priceLimit&priceMin=0&priceMax=0';
const URL_VIEW = 'https://www.humblebundle.com/store/search?priceMax=0';
const STATE_FILE = dataDir('humble-bundle-watch.json');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function loadState() {
  if (!existsSync(STATE_FILE)) return { products: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { products: {} }; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { log.warn(`Failed to save Humble watch state: ${e.message.split('\n')[0]}`); }
}

let json;
try {
  const resp = await fetch(URL_API, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    log.warn(`Humble store API returned HTTP ${resp.status} — skipping watch this run`);
    process.exit(0);
  }
  // Some Humble responses arrive as text/html when the API path 404s and
  // a generic page is served. Parse JSON defensively.
  const text = await resp.text();
  try { json = JSON.parse(text); }
  catch {
    log.warn(`Humble store API returned non-JSON (${text.length} bytes) — selectors likely need updating`);
    process.exit(0);
  }
} catch (e) {
  log.warn(`Humble watch fetch failed: ${e.message.split('\n')[0]}`);
  process.exit(0);
}

// Defensively unwrap whatever shape Humble returns. Observed historical
// shapes: { results: [...] }, { products: [...] }, or a top-level array.
const results = Array.isArray(json?.results) ? json.results
  : Array.isArray(json?.products) ? json.products
  : Array.isArray(json) ? json
  : [];

if (!Array.isArray(results) || results.length === 0) {
  log.warn('Humble store API returned no results — selectors likely need updating');
  process.exit(0);
}

// Filter to genuinely free items. Humble's `current_price.amount` is in
// cents; some responses use `price.amount` or a top-level `cost`. Treat
// any of those at 0 as free, anything else as paid (and skip).
function priceCentsOf(r) {
  const p = r.current_price?.amount ?? r.price?.amount ?? r.full_price?.amount ?? r.cost?.amount;
  if (p == null) return null;
  const n = Number(p);
  return Number.isFinite(n) ? n : null;
}

const products = new Map();
for (const r of results) {
  if (!r || typeof r !== 'object') continue;
  const id = r.machine_name || r.human_url || r.id;
  const name = r.human_name || r.title || id;
  if (!id || !name) continue;
  const price = priceCentsOf(r);
  if (price == null || price > 0) continue; // only items confirmed free

  // Compose a viewable URL. machine_name is Humble's slug; their store
  // pages live at /store/<slug>.
  const url = r.url
    ? (r.url.startsWith('http') ? r.url : 'https://www.humblebundle.com' + r.url)
    : `https://www.humblebundle.com/store/${id}`;

  // Edition-style hint: most Humble freebies are time-limited promos,
  // but we tag with whatever metadata is on the response so the user
  // can quickly judge urgency.
  const note = r.delivery_methods?.length
    ? r.delivery_methods.join(',')
    : (r.os?.length ? r.os.join(',') : 'free');

  products.set(id, { name, url, note });
}

log.status('Free Humble products on page', products.size);

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
  log.info('No new Humble Bundle free items since last check');
  process.exit(0);
}

if (isFirstRun) {
  // Don't spam on first enable — we don't know which of these are
  // actually new vs. just newly-tracked. Log them, save the baseline,
  // no push.
  log.info(`Baseline established with ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'} (no notification on first run)`);
  for (const e of newEntries) log.game(e.name, e.note);
  process.exit(0);
}

for (const e of newEntries) log.game(e.name, `new — ${e.note}`);

// Plain-text body. Pushover strips HTML but auto-linkifies bare URLs;
// keep one URL per line so they remain tappable.
const subject = `Humble Bundle has ${newEntries.length} new free item${newEntries.length === 1 ? '' : 's'} — claim manually`;
log.info(subject);
const lines = [subject];
for (const e of newEntries) lines.push(`- ${e.name}: ${e.url}`);
const body = lines.join('<br>');
await notify(body).catch(err => log.warn(`Notify failed: ${err.message.split('\n')[0]}`));
