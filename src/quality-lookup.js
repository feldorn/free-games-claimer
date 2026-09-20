// Quality lookup — Steam as single source for score + price signals across
// all claim scripts. Shipped in v2.12.0 (#148 @DoSpamu design).
//
// Design (per #148 thread):
//   - Steam is the single lookup source. >95% of anything worth filtering
//     also has a Steam SKU. Metacritic/OpenCritic/IGDB as primary sources
//     have the wrong failure mode — the exact shovelware you want to
//     filter is the stuff nobody reviewed, so those come back empty
//     precisely when you need them.
//   - Two independent gates, both opt-in via Settings:
//       score gate  — normalise Steam review-% + Metacritic /100 to 0-10,
//                     take the LOWER of the two if both present. Skip if
//                     lowest < minScore.
//       price gate  — read base price (in cfg's local currency via Steam's
//                     price_overview). Skip if base ≤ minBasePrice OR game
//                     is permanently free-to-play (isFree flag).
//   - Third opt-in: skipUnmatched. Default off — no-Steam-page items pass
//     through today (safer default). Users who want DoSpamu-strict flip
//     it on.
//   - Per-service opt-in via appliesTo — the multi-select is empty by
//     default so no existing deploy silently changes when they pull
//     v2.12. User picks which claim scripts should consult the gate.
//   - Results cached in data/quality-lookup-cache.json (30-day TTL) keyed
//     by normalised title. One HTTP triplet (search + details + reviews)
//     per uncached title; subsequent runs are DB-fastpath.
//
// RAWG fallback deferred per DoSpamu discussion — Steam-only v1; add
// second lookup if the "no Steam page" gap actually bites users.

import { jsonDb, matchKey, log, datetime, dataDir } from '#src/util.js';
import { describeConfig } from '#src/app-config.js';

// TTL for cache entries — 30 days per plan. Titles that Steam re-scores
// mid-cycle would take up to 30 days to reflect, which is fine because
// (a) score drift is slow, (b) users can nuke the cache file to force a
// refresh if they suspect stale data.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Steam API endpoints — anonymous, no auth required. `cc=US` + `l=english`
// pins currency + language for consistent parsing (Metacritic scores are
// English-only anyway; price_overview.initial is in the requested currency's
// smallest unit — cents for USD).
const S_SEARCH   = 'https://store.steampowered.com/api/storesearch/?term=';
const S_DETAILS  = 'https://store.steampowered.com/api/appdetails?cc=US&l=english&appids=';
const S_REVIEWS  = 'https://store.steampowered.com/appreviews/'; // /{appId}?json=1&...
const UA         = 'free-games-claimer quality-lookup';

// Cache DB — lazy-loaded on first lookup, module-scoped so the panel
// process reads the same in-memory copy claim scripts write (they don't
// share memory today — each claim script is a subprocess — but the file
// on disk is shared, so a subprocess miss falls through to the on-disk
// value even if the panel wrote it. jsonDb() handles the concurrent-write
// case gracefully; last-write-wins is fine at this cadence.)
let cacheDb = null;
async function getCache() {
  if (cacheDb) return cacheDb;
  cacheDb = await jsonDb('quality-lookup-cache.json', { entries: {} });
  return cacheDb;
}

// Normalise title → cache key. Reuse matchKey from util.js so the cache
// dedups across "Cyberpunk 2077™" and "Cyberpunk 2077" and "cyberpunk
// 2077 " etc. — the exact same normalisation the discovery pipeline uses
// for its own dedup.
function cacheKeyForTitle(title) { return matchKey(String(title || '')); }

// ─── Steam HTTP layer ─────────────────────────────────────────────────

async function steamSearchAppId(title) {
  const url = S_SEARCH + encodeURIComponent(String(title || '').trim()) + '&l=en&cc=US';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const j = await r.json();
    const items = Array.isArray(j.items) ? j.items : [];
    if (!items.length) return null;
    const needle = matchKey(title);
    for (const it of items) {
      if (it.type === 'app' && matchKey(it.name || '') === needle) return String(it.id);
    }
    // Fall back to the first `type: app` result even without exact match —
    // Steam's search is fuzzy on trailing "™", "TM", "®", "Edition"
    // suffixes that matchKey normalises out but Steam sometimes doesn't.
    // Accepting first-app is safe for the quality gate use case (a rough
    // score signal is better than no signal) but not for the ownership-
    // check use case in steam.js (which stays exact-match).
    const firstApp = items.find(it => it.type === 'app');
    return firstApp ? String(firstApp.id) : null;
  } catch { return null; }
}

async function steamAppDetails(appId) {
  try {
    const r = await fetch(S_DETAILS + appId, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const j = await r.json();
    // Response shape: {"{appId}": {"success": true, "data": {...}}}
    const wrapper = j?.[appId];
    if (!wrapper?.success) return null;
    return wrapper.data || null;
  } catch { return null; }
}

async function steamAppReviews(appId) {
  try {
    const url = S_REVIEWS + appId + '?json=1&language=all&purchase_type=all&num_per_page=0';
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.success || !j.query_summary) return null;
    const qs = j.query_summary;
    const total = Number(qs.total_reviews) || 0;
    if (total < 10) return null; // < 10 reviews is noise, treat as unrated
    const positive = Number(qs.total_positive) || 0;
    return positive / total; // 0..1
  } catch { return null; }
}

// ─── Public API ───────────────────────────────────────────────────────

// Look up quality signals for a title. Cached for 30 days. Returns:
//   {
//     matched:      boolean,          // true iff we found a Steam appId
//     appId:        string | null,
//     appName:      string | null,    // canonical name Steam returned
//     reviewScore:  number | null,    // 0..10 (from review positive %)
//     metacritic:   number | null,    // 0..10 (Steam's data.metacritic.score/10)
//     basePrice:    number | null,    // in whole USD (from price_overview.initial/100)
//     isPermFree:   boolean,          // data.is_free — permanently free-to-play
//     checkedAt:    ISO string,
//   }
// Never throws — network failures degrade to matched:false.
export async function lookupQuality(title) {
  const t = String(title || '').trim();
  if (!t) return { matched: false, appId: null, appName: null, reviewScore: null, metacritic: null, basePrice: null, isPermFree: false, checkedAt: datetime() };

  const key = cacheKeyForTitle(t);
  const db = await getCache();
  const cached = db.data.entries[key];
  const now = Date.now();
  if (cached && (now - new Date(cached.checkedAt).getTime()) < CACHE_TTL_MS) {
    return cached;
  }

  const appId = await steamSearchAppId(t);
  const result = { matched: !!appId, appId, appName: null, reviewScore: null, metacritic: null, basePrice: null, isPermFree: false, checkedAt: datetime() };

  if (appId) {
    // Fetch details + reviews in parallel to shave a round-trip.
    const [details, reviewPct] = await Promise.all([
      steamAppDetails(appId),
      steamAppReviews(appId),
    ]);
    if (details) {
      result.appName = String(details.name || '') || null;
      result.isPermFree = !!details.is_free;
      if (details.metacritic && Number.isFinite(details.metacritic.score)) {
        result.metacritic = details.metacritic.score / 10; // /100 → /10
      }
      if (details.price_overview && Number.isFinite(details.price_overview.initial)) {
        result.basePrice = details.price_overview.initial / 100; // cents → USD
      }
    }
    if (reviewPct !== null) {
      result.reviewScore = reviewPct * 10; // 0..1 → 0..10
    }
  }

  db.data.entries[key] = result;
  try { await db.write(); } catch (e) { log.warn(`quality-lookup cache write failed: ${e.message}`); }
  return result;
}

// Evaluate the quality gate for a service + title. Returns:
//   { pass: bool, reason: string, badge: string|null, info: {...lookupQuality result plus title} }
// The badge string is used by Discoveries and the DB row for compact
// classification. Always returns pass:true when gate isn't enabled or the
// service isn't in appliesTo — caller can treat pass:true as "proceed
// normally" without needing to check the reason.
export async function checkQualityGate(service, title) {
  const q = describeConfig().effective?.quality || {};
  const info = { title, matched: false, appId: null, appName: null, reviewScore: null, metacritic: null, basePrice: null, isPermFree: false };
  if (!q.enabled) return { pass: true, reason: 'quality gate disabled', badge: null, info };
  const applies = Array.isArray(q.appliesTo) ? q.appliesTo : [];
  if (!applies.includes(service)) return { pass: true, reason: `service ${service} not in appliesTo`, badge: null, info };

  const lookup = await lookupQuality(title);
  Object.assign(info, lookup);

  if (!lookup.matched) {
    if (q.skipUnmatched) return { pass: false, reason: 'no Steam page found', badge: 'quality:no-steam-page', info };
    return { pass: true, reason: 'no Steam page (skipUnmatched=off)', badge: null, info };
  }

  const minPrice = Number.isFinite(q.minBasePrice) ? q.minBasePrice : 2;
  if (lookup.isPermFree) {
    return { pass: false, reason: 'game is permanently free-to-play (isPermFree)', badge: 'quality:free-to-play', info };
  }
  if (lookup.basePrice !== null && lookup.basePrice <= minPrice) {
    return { pass: false, reason: `base price $${lookup.basePrice.toFixed(2)} ≤ min $${minPrice.toFixed(2)}`, badge: 'quality:price', info };
  }

  const minScore = Number.isFinite(q.minScore) ? q.minScore : 5;
  const scores = [lookup.reviewScore, lookup.metacritic].filter(s => s !== null);
  if (scores.length > 0) {
    const lowest = Math.min(...scores);
    if (lowest < minScore) {
      const parts = [];
      if (lookup.reviewScore !== null) parts.push(`review ${lookup.reviewScore.toFixed(1)}`);
      if (lookup.metacritic !== null) parts.push(`metacritic ${lookup.metacritic.toFixed(1)}`);
      return { pass: false, reason: `${parts.join(', ')}; lowest ${lowest.toFixed(1)} < min ${minScore}`, badge: 'quality:score', info };
    }
  }

  return { pass: true, reason: 'passed quality gates', badge: null, info };
}

// Per-run tally helper. Claim scripts create one { checked:0, skipped:0,
// passed:0, byBadge:{} } object and pass it to each gate call via
// recordQualityResult so a single aggregate log line can summarise the
// pass at end-of-run (per feedback_aggregate_log_verbosity).
export function newQualityTally() {
  return { checked: 0, skipped: 0, passed: 0, byBadge: {} };
}
export function recordQualityResult(tally, result) {
  if (!tally || !result) return;
  tally.checked++;
  if (result.pass) {
    tally.passed++;
  } else {
    tally.skipped++;
    const b = result.badge || 'other';
    tally.byBadge[b] = (tally.byBadge[b] || 0) + 1;
  }
}
export function formatQualityTally(tally) {
  if (!tally || tally.checked === 0) return null;
  const parts = [`checked=${tally.checked}`, `passed=${tally.passed}`, `skipped=${tally.skipped}`];
  const detail = Object.entries(tally.byBadge)
    .map(([b, n]) => `${b}=${n}`)
    .join(', ');
  if (detail) parts.push(`(${detail})`);
  return `Quality filter: ${parts.join(' ')}`;
}
