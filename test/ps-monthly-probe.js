// Wider probe — dumps ALL anchors on the whats-new page with text + nearest
// heading, NOT filtered to concept URLs. We want to know whether the page
// has any per-game anchors at all (to playstation.com/games/<slug>/ or
// elsewhere), or whether it's pure marketing with no actionable links.

import { chromium } from 'patchright';
import path from 'node:path';

const PROFILE_DIR = path.resolve('data/browser-playstation');
const URL_WHATS_NEW = 'https://www.playstation.com/en-us/ps-plus/whats-new/';

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  locale: 'en-US',
  args: ['--hide-crash-restore-bubble'],
});
const page = context.pages()[0] || await context.newPage();

await page.goto(URL_WHATS_NEW, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(3000);
for (let i = 0; i < 4; i++) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
  await page.waitForTimeout(500);
}

const results = await page.evaluate(() => {
  const known = ['Grounded', 'Nickelodeon', 'Warhammer', 'Darktide', 'EA Sports', 'Nine Sols', 'Wuchang'];
  const seen = new Map();
  const out = [];

  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!href) continue;
    if (href.startsWith('#')) continue;            // skip in-page anchors
    if (href.startsWith('javascript:')) continue;  // skip handlers
    if (href.startsWith('mailto:')) continue;

    // Categorize the link
    const isGames = /\/games\//i.test(href);
    const isConcept = /\/concept\//i.test(href);
    const isProduct = /\/product\//i.test(href);
    const isStore = /store\.playstation\.com/i.test(href);
    const isPlaystation = /^https:\/\/www\.playstation\.com|^\/[a-z]{2}-[a-z]{2}\//i.test(href);

    // Anchor text
    const text = (a.textContent || '').trim().slice(0, 120);
    const ariaLabel = (a.getAttribute('aria-label') || '').slice(0, 120);

    // Does anchor text mention a known monthly game?
    const matchesKnown = known.find(k => new RegExp(k, 'i').test(text) || new RegExp(k, 'i').test(ariaLabel));

    // Nearest heading above this anchor
    const heading = a.closest('section, article, div')?.querySelector('h1, h2, h3')?.textContent?.trim().slice(0, 100) || null;

    // Filter: skip navigation/header/footer links (typically text-only with no games/concept paths)
    if (!isGames && !isConcept && !isProduct && !isStore && !matchesKnown) continue;

    const key = href;
    if (seen.has(key)) continue;
    seen.set(key, true);

    out.push({
      href,
      text,
      ariaLabel: ariaLabel || null,
      heading,
      tags: [
        isGames && 'games',
        isConcept && 'concept',
        isProduct && 'product',
        isStore && 'store',
        isPlaystation && 'playstation',
        matchesKnown && `matches:${matchesKnown}`,
      ].filter(Boolean),
    });
  }

  return out;
});

console.log(`--- ALL PER-GAME-LIKE ANCHORS (${results.length}) ---`);
for (const r of results) console.log(JSON.stringify(r));
console.log(`---`);
console.log(`COUNT: ${results.length}`);

// Also dump the body text near any known monthly title mention.
const bodyTextHits = await page.evaluate(() => {
  const known = ['Grounded', 'Nickelodeon', 'Warhammer', 'Darktide', 'Nine Sols', 'Wuchang'];
  const matches = [];
  for (const el of document.querySelectorAll('h1, h2, h3, h4, h5, p, span, div, button')) {
    const text = (el.textContent || '').trim();
    if (text.length > 200) continue;
    for (const k of known) {
      if (new RegExp(`\\b${k}\\b`, 'i').test(text)) {
        matches.push({ tag: el.tagName, text: text.slice(0, 160), classes: el.className.toString().slice(0, 100) });
        break;
      }
    }
    if (matches.length >= 20) break;
  }
  return matches;
});
console.log(`\n--- KNOWN-TITLE BODY-TEXT HITS (${bodyTextHits.length}) ---`);
for (const r of bodyTextHits) console.log(JSON.stringify(r));

await context.close();
process.exit(0);
