// Probe: click through PS Plus catalog pagination to confirm we can scrape
// all 36 pages. Counts concepts per page, watches for rate-limit / failure.

import { chromium } from 'patchright';
import path from 'node:path';

const PROFILE_DIR = path.resolve('data/browser-playstation');
const URL = 'https://www.playstation.com/en-us/ps-plus/games/?category=GAME_CATALOG#plus-container';

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  locale: 'en-US',
  args: ['--hide-crash-restore-bubble'],
});
const page = context.pages()[0] || await context.newPage();

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(3000);

const allConcepts = new Set();
const collectConcepts = async () => {
  const ids = await page.evaluate(() => {
    const out = new Set();
    const re = /\/concept\/(\d+)/;
    const plus = document.querySelector('section#plus-container');
    if (!plus) return [];
    for (const a of plus.querySelectorAll('a[href]')) {
      const m = re.exec(a.getAttribute('href') || '');
      if (m) out.add(m[1]);
    }
    return [...out];
  });
  for (const id of ids) allConcepts.add(id);
  return ids;
};

const page1 = await collectConcepts();
console.log(`page 1: ${page1.length} concepts (total ${allConcepts.size})`);

// Loop: find Next page button, click, wait for content to update.
// Limit to MAX_PAGES so a bad page doesn't loop forever.
const MAX_PAGES = 40;
for (let i = 2; i <= MAX_PAGES; i++) {
  // Scroll the pagination into view first
  await page.evaluate(() => {
    const next = document.querySelector('a[aria-label="Next page"]');
    next?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(400);

  // Check if Next page is disabled (last page)
  const disabled = await page.evaluate(() => {
    const next = document.querySelector('a[aria-label="Next page"]');
    return !next || next.getAttribute('aria-disabled') === 'true' || next.parentElement?.classList?.contains('pagination_disabled__J3G9O');
  });
  if (disabled) {
    console.log(`Next page disabled at iteration ${i} — assumed last page`);
    break;
  }

  // Click and wait for the page to update. Sony's React renders new cards
  // asynchronously, so wait for either a known "page N selected" marker or
  // a timer.
  const before = allConcepts.size;
  await page.locator('a[aria-label="Next page"]').first().click({ timeout: 5000 }).catch(e => {
    console.log(`  click failed: ${e.message.split('\\n')[0]}`);
  });
  // Wait up to 8s for new concepts to render.
  let waited = 0;
  while (waited < 8000) {
    await page.waitForTimeout(500);
    waited += 500;
    const got = await collectConcepts();
    if (allConcepts.size > before) break;
  }
  console.log(`page ${i}: total now ${allConcepts.size}`);

  if (i > 4 && allConcepts.size === before) {
    console.log('No new concepts on click — pagination may have hit a rate limit or broken state');
    break;
  }
}

console.log(`\nFINAL: ${allConcepts.size} unique keeper conceptIds across all pages walked`);

await context.close();
process.exit(0);
