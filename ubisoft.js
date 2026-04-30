import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { datetime, notify, log, dataDir, handleSIGINT } from './src/util.js';

// Watch-only Ubisoft Connect free-games tracker. No login, no claim — just
// diffs the current /free-games page against a saved baseline and pushes a
// notification when a new title shows up. Free Week / Free for Limited Time
// promotions on Ubisoft are infrequent (every few months), so a daily check
// + manual claim by the user is a much better squeeze-vs-juice tradeoff
// than building a full ubisoft.js claimer with login persistence + captcha
// handling for a quarterly event.

handleSIGINT();
log.section('Ubisoft (watch-only)');
log.status('Time', datetime());

const URL_FREE = 'https://store.ubisoft.com/us/free-games';
const STATE_FILE = dataDir('ubisoft-watch.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return { products: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { products: {} }; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { log.warn(`Failed to save Ubisoft watch state: ${e.message.split('\n')[0]}`); }
}

let html;
try {
  // Bare fetch — no Playwright needed for a server-rendered page; cheaper
  // than spinning a browser context just to read static markup.
  const resp = await fetch(URL_FREE, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    log.warn(`Ubisoft store returned HTTP ${resp.status} — skipping watch this run`);
    process.exit(0);
  }
  html = await resp.text();
} catch (e) {
  log.warn(`Ubisoft watch fetch failed: ${e.message.split('\n')[0]}`);
  process.exit(0);
}

// Each product tile carries a data-tc100 attribute with a JSON blob:
//   { "pid": "...", "edition": "Free to play", "productName": "Roller Champions", ... }
// Tiles repeat (carousel + grid + add-to-wishlist hover), so dedupe by pid.
// Edition lets us distinguish permanent F2P (skip-noisy) from time-limited
// promo events (the actual signal). We track everything but tag accordingly
// in the notification so the user knows whether it's worth their time.
const tc100Regex = /data-tc100="([^"]*)"/g;
const products = new Map(); // pid -> { name, edition }
let m;
while ((m = tc100Regex.exec(html))) {
  // The attribute value is HTML-encoded; decode back to JSON.
  const decoded = m[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&#039;', "'");
  let data;
  try { data = JSON.parse(decoded); }
  catch { continue; }
  if (!data.pid || !data.productName) continue;
  if (data.action !== 'add to wishlist') continue; // dedupe to one tile shape
  if (products.has(data.pid)) continue;
  products.set(data.pid, { name: data.productName, edition: data.edition || 'unknown' });
}

log.status('Products on page', products.size);

const prev = loadState();
const newEntries = [];
const current = {};

for (const [pid, info] of products) {
  current[pid] = { ...info, firstSeen: prev.products[pid]?.firstSeen || datetime() };
  if (!prev.products[pid]) {
    newEntries.push({ pid, ...info });
  }
}

const isFirstRun = Object.keys(prev.products).length === 0;
saveState({ products: current });

if (newEntries.length === 0) {
  log.info('No new Ubisoft free games since last check');
  process.exit(0);
}

if (isFirstRun) {
  // Don't spam on first enable — we don't know if any of these are actually
  // new vs. just newly-tracked. Log them, save the baseline, no push.
  log.info(`Baseline established with ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'} (no notification on first run)`);
  for (const e of newEntries) log.game(e.name, e.edition);
  process.exit(0);
}

// Only notify for time-limited promotions, not new permanent F2P additions —
// the latter are essentially never the "go grab this before it ends" signal
// the user wants and they'd be noise. If Ubisoft introduces a new edition
// label for promo events we should add it here; "Free to play" / "Free To
// Play" is the only non-promo label observed so far.
const promoEntries = newEntries.filter(e => !/^free\s*to\s*play$/i.test(e.edition));

for (const e of newEntries) log.game(e.name, `new — ${e.edition}`);

if (promoEntries.length === 0) {
  log.info('All new entries are permanent free-to-play — no notification fired');
  process.exit(0);
}

const lines = promoEntries.map(e => `<a href="${URL_FREE}">${e.name}</a> (${e.edition})`).join('<br>');
const subject = `Ubisoft has ${promoEntries.length} new free game${promoEntries.length === 1 ? '' : 's'} — claim manually`;
log.info(subject);
await notify(`${subject}<br>${lines}`).catch(err => log.warn(`Notify failed: ${err.message.split('\n')[0]}`));
