// PlayStation Plus discovery helpers.
//
// Monthly Essentials live on the marketing whats-new page as anchors to
// playstation.com/en-us/games/<slug>/. The PS-Plus-included catalog
// page links to store.playstation.com/{locale}/concept/<id> — that's
// where Add-to-Library lives. We scrape both, then matchMonthlyToCatalog
// joins them via fuzzy title match so all claims route through concept URLs.

const URL_WHATS_NEW = 'https://www.playstation.com/en-us/ps-plus/whats-new/';
const URL_CATALOG = 'https://www.playstation.com/en-us/ps-plus/games/';
const CONCEPT_RE = /^https:\/\/store\.playstation\.com\/[a-z]{2}-[a-z]{2}\/concept\/(\d+)\b/;
const SLUG_RE = /^\/[a-z]{2}-[a-z]{2}\/games\/([a-z0-9-]+)\/?$/;

// --- Pure helpers ----------------------------------------------------------

// Return the numeric concept ID from a store.playstation.com concept URL,
// or null for any other input (non-string, empty, non-matching).
function parseConceptId(href) {
  if (!href || typeof href !== 'string') return null;
  // Strip query string before matching so ?smcid=... doesn't break the regex.
  const bare = href.split('?')[0];
  const m = CONCEPT_RE.exec(bare);
  return m ? m[1] : null;
}

// Normalise a game title for fuzzy matching between the monthly-games page
// and the catalog page. Strips trademark symbols, parentheticals, platform
// suffixes, edition labels, and punctuation; converts hyphens to spaces so a
// slug-shaped fallback title (e.g. "marvels-spider-man-2") matches a
// catalog-shaped title (e.g. "Marvel's Spider-Man 2").
function normalizeTitle(title) {
  if (!title || typeof title !== 'string') return '';
  return title
    // 1. Lowercase
    .toLowerCase()
    // 2. Remove trademark chars
    .replace(/[™®©]/g, '')
    // 3. Remove parenthetical groups
    .replace(/\(.*?\)/g, '')
    // 4a. PS4/PS5 combos: "PS4 & PS5", "PS 4 & PS 5", "PS5", "PS4"
    .replace(/\bps ?[45]\b( ?& ?ps ?[45])?\b/gi, '')
    // 4b. PS VR2 / PSVR2
    .replace(/\bps ?vr ?2\b/gi, '')
    // 4c. Edition suffixes
    .replace(/\b(?:standard|deluxe|premium|collector'?s|gold|complete|definitive) edition\b/gi, '')
    // 5. Strip apostrophes/quotes ("Marvel's" → "Marvels")
    .replace(/['"]/g, '')
    // 6. Replace hyphens with spaces ("Spider-Man" → "Spider Man",
    //    matches slug-shape "spider-man" → "spider man")
    .replace(/-+/g, ' ')
    // 7. Strip remaining non-alphanumeric except spaces (colons, commas, etc.)
    .replace(/[^a-z0-9 ]+/g, '')
    // 8. Collapse whitespace, trim
    .replace(/\s+/g, ' ')
    .trim();
}

// Join monthly slugs to catalog concept entries via normalised title match.
// Returns { matched: [...], unmatched: [...] }.
// Each matched entry carries conceptId + conceptUrl from the catalog, plus
// the monthly's title/slug/slugUrl and source:'monthly'.
function matchMonthlyToCatalog(monthlyRaw, catalogEntries) {
  const matched = [];
  const unmatched = [];

  // Build lookup map: normalizedTitle → catalogEntry
  const byTitle = new Map();
  for (const entry of catalogEntries) {
    byTitle.set(normalizeTitle(entry.title), entry);
  }

  for (const monthly of monthlyRaw) {
    const key = normalizeTitle(monthly.title);
    const catalogEntry = byTitle.get(key);
    if (catalogEntry) {
      matched.push({
        conceptId: catalogEntry.conceptId,
        conceptUrl: catalogEntry.conceptUrl,
        title: monthly.title,
        slug: monthly.slug,
        slugUrl: monthly.slugUrl,
        source: 'monthly',
      });
    } else {
      unmatched.push(monthly);
    }
  }

  return { matched, unmatched };
}

// --- Async page scrapers ---------------------------------------------------

// Scrape the PS Plus whats-new marketing page for Monthly Essentials.
// Returns [{ slug, slugUrl, title }].
// Anchors with text "Find out more" only — "Try this game" anchors are
// PS Plus Premium trials (a separate category) and must be excluded.
async function discoverMonthlyRaw(page) {
  await page.goto(URL_WHATS_NEW, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Scroll to trigger lazy-load (4× viewport height, 500 ms pauses).
  for (let i = 0; i < 4; i++) {
    await page.evaluate(step => window.scrollBy(0, window.innerHeight * step), i + 1);
    await page.waitForTimeout(500);
  }

  const slugReSrc = SLUG_RE.source;
  const raw = await page.evaluate(slugReSrc => {
    const slugRe = new RegExp(slugReSrc);
    const results = [];
    const seen = new Set();

    // Page-wide scan for "Find out more" anchors matching the slug pattern.
    // We originally tried walking siblings of #monthly-games, but Sony's
    // whats-new page doesn't put per-game CTAs in immediate siblings of that
    // section — they live anywhere in the document. The combination of
    // text === "Find out more" + the slug regex has been a tight enough
    // filter on real pages (Task 0 wide-probe returned ~4 anchors total,
    // all real games). "Try this game" anchors (PS Plus Premium trials)
    // are correctly excluded by the exact text match.
    //
    // A spotlight/highlight game that isn't actually a monthly Essential
    // will still be picked up here, but matchMonthlyToCatalog joins each
    // entry to the catalog scrape — if it's in the catalog, it gets
    // priority-claimed (harmless: would be drain-claimed anyway), if not,
    // it falls into `unmatched` and the operator gets an action notify.
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').trim();
      if (text !== 'Find out more') continue;
      const m = slugRe.exec(href);
      if (!m) continue;
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);

      // Title: aria-label first (most authoritative), then nearest h3 in
      // the enclosing section/article/div, then slug.
      // The page-wide scan can't reliably find the h3 (the closest section
      // is usually the marketing-block-too-wide one whose first h3 belongs
      // to a different card). We fall through to slug rather often; that's
      // fine because normalizeTitle treats slug-form and catalog-title-form
      // as equivalent (hyphens → spaces, strip punctuation).
      const container = a.closest('section, article, div');
      const h3 = container?.querySelector('h3');
      const title = a.getAttribute('aria-label')
        || h3?.textContent?.trim()
        || slug;

      results.push({ slug, slugUrl: href, title });
    }

    return results;
  }, slugReSrc);

  return raw;
}

// Scrape the PS Plus games catalog page for concept URLs.
// Returns [{ conceptId, conceptUrl, title }], deduped, ?smcid stripped.
async function discoverCatalog(page) {
  await page.goto(URL_CATALOG, { waitUntil: 'domcontentloaded' });
  // 20s networkidle vs 15s for whats-new: the catalog page renders ~242 game
  // cards with lazy-loaded images and is meaningfully heavier than the
  // marketing whats-new page. Both are best-effort (caught + ignored) — the
  // goto + settle + scroll combo is the real signal.
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // Scroll to trigger lazy-load (5× viewport height, 700 ms pauses).
  for (let i = 0; i < 5; i++) {
    await page.evaluate(step => window.scrollBy(0, window.innerHeight * step), i + 1);
    await page.waitForTimeout(700);
  }

  const conceptReSrc = CONCEPT_RE.source;
  const raw = await page.evaluate(conceptReSrc => {
    const conceptRe = new RegExp(conceptReSrc);
    const seen = new Map(); // conceptId → entry
    const anchors = Array.from(document.querySelectorAll('a[href]'));

    // Section-ID-based allow/deny. The catalog page has two distinct
    // sections that list PS-Plus-related games:
    //   <section id="plus-container">  — keeper catalog (Extra/Premium tier)
    //   <section id="trials">          — Premium-tier 2-3 hour timed demos
    // The trials section's CTA flow accepts the "Add to Library" click but
    // adds the *trial* (DOWNLOAD_PS_PLUS_TRIAL ctaType), not a keeper claim.
    // Yesterday's run claimed 6 trials before this filter existed.
    //
    // We use an explicit allowlist (must be inside #plus-container) with a
    // defensive denylist (must NOT be inside #trials) — covers the case
    // where Sony restructures #trials to be a child of #plus-container.
    const plusContainer = document.querySelector('section#plus-container');
    const trialsContainer = document.querySelector('section#trials');

    for (const a of anchors) {
      const href = (a.getAttribute('href') || '').split('?')[0]; // strip ?smcid=...
      const m = conceptRe.exec(href);
      if (!m) continue;
      const conceptId = m[1];
      if (seen.has(conceptId)) continue;

      // Allowlist: must be inside #plus-container. Anchors elsewhere are
      // page-nav, marketing tooltips, or trials section.
      if (plusContainer && !plusContainer.contains(a)) continue;
      // Denylist: defensive — skip anything inside #trials.
      if (trialsContainer && trialsContainer.contains(a)) continue;

      // v1: locale is hardcoded to en-us. Spec risk R5 documents this — non-US
      // regions are out of scope for now. A future PSP_LOCALE config field would
      // parameterize this; for now we always emit en-us URLs because the rest of
      // the runner (login flow, catalog page, claim selectors) targets en-us too.
      const conceptUrl = `https://store.playstation.com/en-us/concept/${conceptId}`;
      const title = (a.textContent || '').trim()
        || a.getAttribute('aria-label')
        || `Concept ${conceptId}`;

      seen.set(conceptId, { conceptId, conceptUrl, title });
    }

    return Array.from(seen.values());
  }, conceptReSrc);

  return raw;
}

// --- Exports ---------------------------------------------------------------

export { URL_WHATS_NEW, URL_CATALOG };
export { parseConceptId, normalizeTitle, matchMonthlyToCatalog, discoverMonthlyRaw, discoverCatalog };
