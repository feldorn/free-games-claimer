// Probe a PS Plus monthly Essential slug page to learn which claim path
// is viable for monthlies. Two things to find out:
//
//   1. Does playstation.com/en-us/games/<slug>/ contain a direct "Add to
//      Library" CTA (the OJ7 prototype's path, 2024-era selectors)?
//   2. OR does it link to store.playstation.com/concept/<id>/ via a
//      "Get on PS Store" / "View on PlayStation Store" button so we can
//      reuse the existing concept-URL claim flow?
//
// Targets one of May 2026's actual monthly Essentials (nine-sols), which
// the previous test runs confirmed is NOT in the Extra/Premium catalog
// scrape but IS reachable via the whats-new "Find out more" anchor.

import { chromium } from 'patchright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PROFILE_DIR = path.resolve('data/browser-playstation');
const TARGET_URL = 'https://www.playstation.com/en-us/games/nine-sols/';
mkdirSync(PROFILE_DIR, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  locale: 'en-US',
  args: ['--hide-crash-restore-bubble'],
});
const page = context.pages()[0] || await context.newPage();

await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(3000);

console.log('--- LANDED ---');
console.log('URL:', page.url());
console.log('Title:', await page.title());

// Scroll down to trigger any lazy-loaded CTAs.
for (let i = 0; i < 5; i++) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
  await page.waitForTimeout(600);
}

// 1. Look for any anchor pointing to store.playstation.com/concept/.
const conceptLinks = await page.evaluate(() => {
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!/store\.playstation\.com\/[a-z]{2}-[a-z]{2}\/concept\//.test(href)) continue;
    out.push({
      href,
      text: (a.textContent || '').trim().slice(0, 120),
      ariaLabel: a.getAttribute('aria-label')?.slice(0, 120) || null,
      cls: a.className.toString().slice(0, 200),
    });
  }
  return out;
});
console.log('\n--- CONCEPT LINKS ON SLUG PAGE ---');
console.log(`Count: ${conceptLinks.length}`);
for (const l of conceptLinks.slice(0, 15)) console.log(JSON.stringify(l));

// 2. Look for any "Add to Library" / "Add" / "Get" CTA on the slug page.
const claimCtas = await page.evaluate(() => {
  const out = [];
  const re = /add to library|in library|get|download|play|buy/i;
  for (const el of document.querySelectorAll('button, a, [role="button"]')) {
    const text = (el.textContent || '').trim();
    if (!text || text.length > 80) continue;
    if (!re.test(text)) continue;
    out.push({
      tag: el.tagName,
      text: text.slice(0, 80),
      cls: el.className.toString().slice(0, 200),
      dataQa: el.getAttribute('data-qa')?.slice(0, 100) || null,
      href: el.getAttribute('href') || null,
    });
  }
  return out;
});
console.log('\n--- CLAIM-LIKE CTAs ON SLUG PAGE ---');
console.log(`Count: ${claimCtas.length}`);
for (const c of claimCtas.slice(0, 25)) console.log(JSON.stringify(c));

// 3. Look for any element with data-qa containing "cta" or "library" or "concept".
const dataQas = await page.evaluate(() => {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('[data-qa]')) {
    const dq = el.getAttribute('data-qa');
    if (!dq) continue;
    if (!/cta|library|concept|store|buy|own/i.test(dq)) continue;
    if (seen.has(dq)) continue;
    seen.add(dq);
    out.push({
      tag: el.tagName,
      dataQa: dq,
      text: (el.textContent || '').trim().slice(0, 80),
    });
    if (out.length >= 30) break;
  }
  return out;
});
console.log('\n--- INTERESTING data-qa ATTRS ON SLUG PAGE ---');
console.log(`Count: ${dataQas.length}`);
for (const d of dataQas) console.log(JSON.stringify(d));

// Dump the full page HTML for offline reference.
const htmlPath = path.resolve('data/ps-slug-nine-sols.html');
writeFileSync(htmlPath, await page.content());
console.log(`\nFull page HTML → ${htmlPath}`);

await context.close();
process.exit(0);
