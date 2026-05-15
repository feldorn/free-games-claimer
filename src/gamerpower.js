// src/gamerpower.js — supplementary discovery via gamerpower.com.
//
// Surfaces giveaways that aren't in our stores' first-party feeds:
// indie launch promos, mega-sale-style limited drops, mobile launches,
// etc. (See feldorn#33 for the trigger — Devils Island and Lost in
// the Hole were free on Epic 2026-05-14 but absent from Epic's own
// freeGamesPromotions API and the /free-games page "Free Now" section.)
//
// API: https://www.gamerpower.com/api/giveaways — free, JSON, no auth.
// Returns active giveaways across many platforms. We map their platform
// strings to our collector IDs and let each collector pull its slice.
//
// Phase 1 surfaces entries to the run log of each matching collector.
// Per-collector auto-claim resolution (following the gamerpower.com
// /open/ redirect through patchright to capture the actual store URL)
// is done inside each script using its existing browser context — see
// resolveGamerPowerHref().

const API_URL = 'https://www.gamerpower.com/api/giveaways?type=game';

// Map our collector IDs (the canonical identifier each claim script
// uses) to regex patterns that match GamerPower's `platforms` field.
// GamerPower's `platforms` is a comma-separated string like
// "PC, Epic Games Store" or "PC, Steam, DRM-Free". Each pattern below
// matches the platform substring exactly enough to avoid false hits
// (e.g. \bsteam\b avoids matching "iSteam" or similar).
export const COLLECTOR_PATTERNS = {
  'epic-games':   /epic games store|\bepic store\b/i,
  'steam':        /\bsteam\b/i,
  'gog':          /\bgog\b|good old games/i,
  'itch-io':      /itch\.?\s*io/i,
  'indiegala':    /indie\s*gala/i,
  'stove':        /\bstove\b/i,
  'prime-gaming': /amazon prime|\bprime gaming\b/i,
  'ubisoft':      /ubisoft connect|\buplay\b/i,
  'mobile':       /\bandroid\b|\bios\b/i,
  'console':      /\bps[2-5]\b|\bxbox\b|\bswitch\b|\bnintendo\b/i,
  'vr':           /\b(vr|oculus|rift|steamvr|quest)\b/i,
};

// GamerPower titles include a parenthetical storefront hint:
//   "Carlos the Taco (IndieGala) Giveaway"   platforms="PC"  ← platforms field is useless
// The (Storefront) hint is the real signal for cases where the platforms
// field is a generic catch-all like "PC". Used as a *fallback* — primary
// match against platforms first; this kicks in only when no platform
// pattern hit. Keys map normalized hint (lowercase, non-alphanumerics
// stripped) to the collector key. Extend here when a new storefront
// shows up in GamerPower listings.
export const GP_TITLE_HINTS = {
  'epicgames':       'epic-games',
  'steam':           'steam',
  'gog':             'gog',
  'itchio':          'itch-io',
  'indiegala':       'indiegala',
  'stove':           'stove',
  'amazon':          'prime-gaming',
  'amazonprime':     'prime-gaming',
  'amazonprimegaming':'prime-gaming',
  'ubisoft':         'ubisoft',
  'ubisoftconnect':  'ubisoft',
  'mobile':          'mobile',
  'android':         'mobile',
  'ios':             'mobile',
  'rift':            'vr',
  'vr':              'vr',
  'oculus':          'vr',
  'steamvr':         'vr',
  'quest':           'vr',
  'ps4':             'console',
  'ps5':             'console',
  'xbox':            'console',
  'switch':          'console',
  'nintendo':        'console',
};

// Domain patterns each collector recognises as a "real" claim URL.
// Used by resolveGamerPowerHref() — when navigating a gamerpower.com
// /open/ page, the collector looks for an anchor pointing at one of
// these domains and uses that href as the claim URL.
export const COLLECTOR_DOMAINS = {
  'epic-games':        ['store.epicgames.com'],
  'epic-games-mobile': ['store.epicgames.com'],
  'steam':             ['store.steampowered.com', 'steamcommunity.com'],
  'gog':               ['gog.com'],
  'itch-io':           ['itch.io'],
  'indiegala':         ['indiegala.com', 'freebies.indiegala.com'],
  'stove':             ['onstove.com'],
  'prime-gaming':      ['gaming.amazon.com', 'amazon.com'],
  'ubisoft':           ['store.ubisoft.com', 'ubisoftconnect.com'],
};

export async function fetchGamerPowerGiveaways() {
  const res = await fetch(API_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`gamerpower API: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Return only entries whose `platforms` field matches the collector's
// pattern. Caller drives this from inside the collector script after
// it's done its own first-party discovery.
export function filterFor(entries, collector) {
  const pat = COLLECTOR_PATTERNS[collector];
  if (!pat) return [];
  return entries.filter(e => pat.test(e.platforms || ''));
}

// Summarise platforms in the response that don't correspond to any of
// our collectors (or watchers). Returns a `Map<platformName, count>`.
// Run-log signal for "what coverage we're missing" — if a platform
// shows up here consistently with several entries per week, that's
// a candidate for a new collector or watcher.
export function unhandledPlatforms(entries) {
  const knownPatterns = Object.values(COLLECTOR_PATTERNS);
  const counts = new Map();
  for (const e of entries) {
    const parts = (e.platforms || '').split(',').map(s => s.trim()).filter(Boolean);
    // Each entry typically lists multiple platforms (e.g. "PC, Epic Games Store").
    // We only want the *non-aggregate* ones that no pattern matches.
    const aggregateLabels = /^(pc|drm-free|other)$/i;
    for (const p of parts) {
      if (aggregateLabels.test(p)) continue;
      if (knownPatterns.some(pat => pat.test(p))) continue;
      counts.set(p, (counts.get(p) || 0) + 1);
    }
  }
  return counts;
}

// Resolve a gamerpower.com /open/ page to a canonical claim URL on
// the collector's store domain. Called from inside the collector
// script using its existing browser context. Returns null if the
// page didn't yield a recognised store-domain anchor (the GamerPower
// page sometimes shows a Cloudflare challenge or hosts the giveaway
// behind a click-through gated on JS the script can't drive).
//
// The collector is expected to fall back gracefully on null — log the
// GamerPower entry with its title + open_giveaway_url so the user can
// claim manually.
export async function resolveGamerPowerHref(context, openUrl, collector, { timeoutMs = 30000 } = {}) {
  const domains = COLLECTOR_DOMAINS[collector];
  if (!domains || !domains.length) return null;
  let tab = null;
  try {
    tab = await context.newPage();
    // domcontentloaded covers the Cloudflare challenge page too — we then
    // poll for either a real store-domain anchor (CF passed, page rendered)
    // or for the tab itself to have navigated to a store domain. Curl can't
    // pass CF; patchright usually can since it executes the challenge JS.
    await tab.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // (a) we navigated to a store domain directly
      const curUrl = tab.url();
      if (domains.some(d => curUrl.includes(d))) return curUrl;
      // (b) anchor on the rendered page points at the store domain
      const href = await tab.evaluate((domainList) => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        for (const a of anchors) {
          const h = a.getAttribute('href') || '';
          if (domainList.some(d => h.includes(d))) return h;
        }
        return null;
      }, domains).catch(() => null);
      if (href) return href;
      await tab.waitForTimeout(1000);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (tab) await tab.close().catch(() => {});
  }
}
