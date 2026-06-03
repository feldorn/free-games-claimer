// src/freegamefindings.js — supplementary discovery via r/FreeGameFindings.
//
// DoSpamu pointed at three aggregator sources on feldorn#33; this is the
// second after gamerpower.com. Different shape, different tradeoffs:
//
//   gamerpower.com:  structured API, but /open/ pages are Cloudflare-gated
//                    and we have to follow them in patchright to capture
//                    the canonical store URL.
//   r/FreeGameFindings: Reddit's public JSON feed; post.url is *already*
//                    the direct store URL (no redirect step). Title prefix
//                    is the canonical platform tag — `[Epic Games]`,
//                    `[Steam]`, `[GOG]`, etc. — and link_flair_css_class
//                    cleanly signals state (Expired / PreviouslyGiven / PSA).
//
// Reddit's UA policy requires a non-default User-Agent on every request.
// We send `free-games-claimer/X.Y.Z (https://github.com/...)` so they can
// identify us in their logs and reach out if anything's wrong.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const PKG_VERSION = (() => {
  try {
    const pkgPath = path.join(path.dirname(__filename), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();
const USER_AGENT = `free-games-claimer/${PKG_VERSION} (https://github.com/feldorn/free-games-claimer)`;

const API_URL = 'https://www.reddit.com/r/FreeGameFindings/new.json?limit=100';

// Title-prefix patterns per collector. Anchored at `^\[…\]` (start of
// title, square-bracketed tag). The subreddit's posting rules enforce
// this format consistently. Case-insensitive because we've observed
// both `[Steam]` and `[STEAM]` in the feed.
//
// `[Epic Games]` and `[Epic Games Mobile]` are two distinct tags in the
// sub. Both go through epic-games.js — desktop unconditionally, mobile
// only when cfg.eg_mobile is enabled (env EG_MOBILE=1). Keeping them as
// separate keys lets the caller pull each slice independently AND lets
// unhandledPlatforms() correctly recognise `[Epic Games Mobile]` as
// covered when mobile is on (otherwise it'd show as an unhandled tag
// every run even though the user opted in — caught 2026-05-14).
//
// Anchored at `^\[…\]` only — *no* trailing whitespace requirement.
// Posters in the sub format titles two ways: `[Steam] (Game) X` (with
// a space after the bracket) and `[Steam](Game) X` (no space). The
// initial implementation required `\s` after the `]` which silently
// dropped the no-space variant into the "unhandled" bucket — Steam
// showed up there even though we cover it.
//
// `[Epic Games]` uses a negative lookahead to refuse `[Epic Games Mobile]`,
// since the literal `]` boundary alone would match `[Epic Games Mobile]`'s
// `[Epic Games` prefix — wait, it wouldn't, because `\]` requires the
// closing bracket. Kept the lookahead anyway for explicit intent.
export const COLLECTOR_TITLE_PATTERNS = {
  'epic-games':        /^\[Epic Games\](?! Mobile)/i,
  'epic-games-mobile': /^\[Epic Games Mobile\]/i,
  'steam':             /^\[Steam\]/i,
  'gog':               /^\[GOG\]/i,
  'itch-io':           /^\[Itch\.?\s*io\]/i,
  'indiegala':         /^\[Indie\s*Gala\]/i,
  'stove':             /^\[Stove\]/i,
  'prime-gaming':      /^\[Amazon( Prime)?( Gaming)?\]/i,
  'ubisoft':           /^\[Ubisoft( Connect)?\]/i,
  'mobile':            /^\[(Android|iOS|Mobile)\]/i,
  'console':           /^\[(PS[2-5]|PSN|Xbox|XBL|Switch|Nintendo)\]/i,
  'vr':                /^\[(VR|Oculus|Rift|SteamVR|Quest)\]/i,
};

// Reusing the same collector→domain map keeps the URL-validation rule
// consistent between this and the gamerpower helper.
import { COLLECTOR_DOMAINS } from './gamerpower.js';

// Other-script domains we exclude from FGF results because the post is
// already cross-posting a giveaway one of our watchers handles directly.
// Without this, FGF would surface Lenovo Key Drops as `action` items
// every run, duplicating what `lenovo-gaming.js` already alerts on.
const COVERED_BY_OTHER_SCRIPTS = [
  'gaming.lenovo.com',
];

// link_flair_css_class values we always drop. PSA megaposts (`PSA` class)
// link back to the comments thread and aggregate multiple giveaways in
// selftext — parsing those is Phase 2; for now they show up via individual
// platform-tagged posts anyway.
const DROPPED_FLAIR_CLASSES = new Set([
  'Expired',
  'PreviouslyGiven',
  'PSA',
]);

export async function fetchFGFPosts({ maxAgeHours = 72 } = {}) {
  const res = await fetch(API_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });
  // 403 in particular is Reddit's unauthenticated rate-limit response —
  // commonly hit on container egress IPs. We log this as a warn in the
  // caller and continue with GamerPower-only discovery (which covers
  // most of the same freebies), so it's non-fatal. The error string is
  // user-facing in the warn log; make it self-explanatory so users don't
  // wonder if the run failed.
  if (!res.ok) {
    const detail = res.status === 403
      ? 'Reddit API rate-limited (HTTP 403) — supplementary discovery skipped; GamerPower coverage still applies'
      : `Reddit API HTTP ${res.status} — supplementary discovery skipped; GamerPower coverage still applies`;
    throw new Error(detail);
  }
  const body = await res.json();
  const children = body?.data?.children;
  if (!Array.isArray(children)) return [];
  const cutoffMs = Date.now() - maxAgeHours * 3600 * 1000;
  return children
    .map(c => c?.data)
    .filter(p => {
      if (!p || typeof p !== 'object') return false;
      if (!p.title || !p.url) return false;
      if (typeof p.created_utc === 'number' && p.created_utc * 1000 < cutoffMs) return false;
      const flairClass = p.link_flair_css_class || '';
      if (DROPPED_FLAIR_CLASSES.has(flairClass)) return false;
      // Some entries are self-posts (no external URL — `.url` points back at
      // the comments thread on reddit.com). Skip those — without an external
      // URL there's nothing to claim.
      if (/^https?:\/\/(www\.)?reddit\.com\//i.test(p.url)) return false;
      // Skip cross-posts of watchers we already cover natively.
      if (COVERED_BY_OTHER_SCRIPTS.some(d => p.url.includes(d))) return false;
      return true;
    })
    .map(p => ({
      title: p.title,
      url: p.url,
      flair: p.link_flair_text || null,
      flairClass: p.link_flair_css_class || null,
      postUrl: `https://www.reddit.com${p.permalink}`,
      createdUtc: p.created_utc,
      score: p.score,
      selftext: p.selftext || '',
    }));
}

// Return posts whose title prefix matches the collector's pattern AND
// whose URL points at the collector's domain (defense in depth — the
// title tag is canonical but cross-platform-mention posts do exist).
export function filterFor(posts, collector) {
  const titlePat = COLLECTOR_TITLE_PATTERNS[collector];
  const domains = COLLECTOR_DOMAINS[collector];
  if (!titlePat || !domains) return [];
  return posts.filter(p => titlePat.test(p.title) && domains.some(d => p.url.includes(d)));
}

// Strip the `[Platform] (Kind) ` prefix from a title for cleaner log/
// notification display. e.g. `[Epic Games] (Game) Devil's Island` →
// `Devil's Island`. Leaves the title alone if the prefix doesn't match
// any known shape.
export function cleanTitle(title) {
  return String(title || '')
    .replace(/^\[[^\]]+\]\s*(\([^)]+\)\s*)?/, '')
    .trim();
}

// Bucket title-prefix tags we don't currently cover, so the run log can
// show "platforms without a collector" as a signal for what to build.
// Same role as gamerpower.unhandledPlatforms() but operating on title
// prefixes rather than the comma-list platforms field.
export function unhandledPlatforms(posts) {
  const known = Object.values(COLLECTOR_TITLE_PATTERNS);
  const counts = new Map();
  for (const p of posts) {
    const m = /^\[([^\]]+)\]/.exec(p.title);
    if (!m) continue;
    const tag = m[1];
    // Skip if any collector pattern matches.
    if (known.some(pat => pat.test(p.title))) continue;
    counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return counts;
}
