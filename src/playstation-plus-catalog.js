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
// suffixes, and edition labels, then collapses whitespace.
function normalizeTitle(title) {
  if (!title || typeof title !== 'string') return '';
  return title
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
    // 5. Collapse whitespace, trim
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

    // Walk siblings of #monthly-games until a boundary section.
    const anchor = document.getElementById('monthly-games');
    if (!anchor) return results;

    let el = anchor.nextElementSibling;
    const boundaryRe = /(extra|premium|classics|catalog|trials|next-month|coming|hours)/i;

    while (el) {
      const elId = el.id || '';
      if (boundaryRe.test(elId)) break;

      // Collect all anchors within this sibling.
      const anchors = Array.from(el.querySelectorAll('a[href]'));
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const text = (a.textContent || '').trim();
        if (text !== 'Find out more') continue;
        const m = slugRe.exec(href);
        if (!m) continue;
        const slug = m[1];
        if (seen.has(slug)) continue;
        seen.add(slug);

        // Title: nearest h3 in the enclosing section/article/div,
        // fallback to aria-label, fallback to slug.
        const container = a.closest('section, article, div');
        const h3 = container?.querySelector('h3');
        const title = h3?.textContent?.trim()
          || a.getAttribute('aria-label')
          || slug;

        results.push({ slug, slugUrl: href, title });
      }

      el = el.nextElementSibling;
    }

    return results;
  }, slugReSrc);

  return raw;
}

// Scrape the PS Plus games catalog page for concept URLs.
// Returns [{ conceptId, conceptUrl, title }], deduped, ?smcid stripped.
async function discoverCatalog(page) {
  await page.goto(URL_CATALOG, { waitUntil: 'domcontentloaded' });
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

    for (const a of anchors) {
      const href = (a.getAttribute('href') || '').split('?')[0]; // strip ?smcid=...
      const m = conceptRe.exec(href);
      if (!m) continue;
      const conceptId = m[1];
      if (seen.has(conceptId)) continue;

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
