// Probe the PS Plus catalog page (and a couple of concept pages) to find a
// pre-claim signal that distinguishes "real PS-Plus-keeper" from "trial /
// F2P." Yesterday's runs claimed 5 entries that turned out to be trials,
// because the catalog scrape doesn't capture any per-card category info.
//
// Targets:
//   - 5 known trials (from the user's failed run): Exit the Gungeon (10000263),
//     Hunting Simulator 2 (10000348), Moss: Book II (10000768), Borderlands 4
//     (10000819), UNRAILED! (10000914), Clair Obscur (10008503)
//   - 1 known keeper for contrast: Another Crab's Treasure (10009923)
//
// What to look for on the catalog landing page:
//   - per-card class names (e.g. "trial", "free", "included")
//   - per-card text content (e.g. "Game Trial", "Free to Play", "Included")
//   - per-card data attributes
//
// On concept pages we already know what a keeper looks like; this probe
// dumps the same data-qa attributes for a trial-marked concept to find
// the diff.

import { chromium } from 'patchright';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PROFILE_DIR = path.resolve('data/browser-playstation');
const URL_CATALOG = 'https://www.playstation.com/en-us/ps-plus/games/';
mkdirSync(PROFILE_DIR, { recursive: true });

const TRIAL_IDS = ['10000263', '10000348', '10000768', '10000819', '10000914', '10008503'];
const KEEPER_IDS = ['10009923']; // Another Crab's Treasure — known PS-Plus-Extra keeper

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  locale: 'en-US',
  args: ['--hide-crash-restore-bubble'],
});
const page = context.pages()[0] || await context.newPage();

console.log('=== Loading catalog page ===');
await page.goto(URL_CATALOG, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(4000);

// Scroll fully to trigger any lazy-load.
for (let i = 0; i < 8; i++) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
  await page.waitForTimeout(700);
}

// For each concept ID we care about, find the anchor + dump structure up to
// 3 ancestor levels (the card itself, the card's parent, the section grouping).
const lookFor = [...TRIAL_IDS.map(id => ({ id, label: 'TRIAL' })), ...KEEPER_IDS.map(id => ({ id, label: 'KEEPER' }))];

const findings = await page.evaluate((targets) => {
  const out = [];
  for (const { id, label } of targets) {
    const anchor = document.querySelector(`a[href*="/concept/${id}"]`);
    if (!anchor) {
      out.push({ id, label, found: false });
      continue;
    }
    const card = anchor.closest('[class*="card"]') || anchor.closest('article') || anchor.parentElement;
    const section = card?.closest('section') || null;
    const sectionHeading = section?.querySelector('h1, h2, h3')?.textContent?.trim().slice(0, 80) || null;

    // Anchor + card text content (badges often live as <span> siblings).
    const anchorText = (anchor.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const cardText = card ? (card.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 400) : null;

    // All [data-qa] attributes within the card.
    const dataQas = [];
    if (card) {
      for (const el of card.querySelectorAll('[data-qa]')) {
        const v = el.getAttribute('data-qa');
        if (v) dataQas.push(v);
      }
    }
    // All classes used in the card subtree (deduped).
    const classes = new Set();
    if (card) {
      for (const el of card.querySelectorAll('*')) {
        for (const c of (el.className?.toString() || '').split(/\s+/)) {
          if (c) classes.add(c);
        }
      }
    }
    // Surrounding badges — look for text matching common badge words anywhere
    // up to 5 ancestors above the anchor.
    let badge = null;
    let cursor = anchor.parentElement;
    for (let i = 0; i < 6 && cursor && !badge; i++) {
      const txt = cursor.textContent || '';
      const m = txt.match(/\b(Free Trial|Game Trial|Free to Play|F2P|Included(?: with PlayStation Plus)?|Trial|Beta|Demo)\b/i);
      if (m) badge = m[0];
      cursor = cursor.parentElement;
    }

    out.push({
      id, label, found: true,
      anchorText,
      cardText,
      sectionHeading,
      cardClasses: card?.className?.toString().slice(0, 200) || null,
      dataQas: dataQas.slice(0, 20),
      uniqueClasses: [...classes].filter(c => /badge|tag|label|trial|free|included|sub|psplus|status/i.test(c)).slice(0, 30),
      surroundingBadge: badge,
    });
  }
  return out;
}, lookFor);

console.log('\n=== CATALOG-PAGE FINDINGS ===');
for (const f of findings) {
  console.log(`\n--- ${f.label} ${f.id} ${f.found ? '' : '(NOT FOUND ON CATALOG PAGE)'} ---`);
  if (f.found) {
    console.log(`  anchorText: ${JSON.stringify(f.anchorText)}`);
    console.log(`  sectionHeading: ${JSON.stringify(f.sectionHeading)}`);
    console.log(`  cardClasses: ${JSON.stringify(f.cardClasses)}`);
    console.log(`  surroundingBadge: ${JSON.stringify(f.surroundingBadge)}`);
    console.log(`  uniqueClasses(filtered): ${JSON.stringify(f.uniqueClasses)}`);
    console.log(`  dataQas: ${JSON.stringify(f.dataQas)}`);
    console.log(`  cardText: ${JSON.stringify(f.cardText)}`);
  }
}

// Dump the whole catalog HTML so we have it for offline reference.
const htmlPath = path.resolve('data/ps-catalog-full.html');
writeFileSync(htmlPath, await page.content());
console.log(`\nFull catalog HTML → ${htmlPath}`);

// Now visit each trial concept + the keeper concept and dump the offer block.
console.log('\n=== Visiting concept pages ===');
const conceptFindings = [];
for (const { id, label } of lookFor) {
  const url = `https://store.playstation.com/en-us/concept/${id}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const titleText = await page.title().catch(() => '');
  if (/^Access Denied/i.test(titleText)) {
    conceptFindings.push({ id, label, blocked: true });
    continue;
  }
  const info = await page.evaluate(() => {
    const out = { offers: [], cta: null };
    const ctaEl = document.querySelector('[data-qa="mfeCtaMain#cta#action"]');
    if (ctaEl) {
      out.cta = {
        tag: ctaEl.tagName,
        text: (ctaEl.textContent || '').trim().slice(0, 80),
        meta: ctaEl.getAttribute('data-telemetry-meta') ? JSON.parse(ctaEl.getAttribute('data-telemetry-meta')) : null,
      };
    }
    for (let i = 0; i < 4; i++) {
      const offerLabel = document.querySelector(`[data-qa="mfeCtaMain#offer${i}"]`);
      if (!offerLabel) break;
      const offer = { index: i };
      offer.fullText = (offerLabel.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 240);
      const dataQas = [];
      for (const el of offerLabel.querySelectorAll('[data-qa]')) {
        const v = el.getAttribute('data-qa');
        const text = (el.textContent || '').trim().slice(0, 60);
        dataQas.push({ q: v, text });
      }
      offer.dataQas = dataQas;
      out.offers.push(offer);
    }
    return out;
  });
  conceptFindings.push({ id, label, blocked: false, ...info });
}

console.log('\n=== CONCEPT-PAGE FINDINGS ===');
for (const f of conceptFindings) {
  console.log(`\n--- ${f.label} ${f.id} ---`);
  if (f.blocked) { console.log('  ACCESS DENIED (Sony bot block)'); continue; }
  console.log(`  CTA: ${JSON.stringify(f.cta?.text)} ctaType=${f.cta?.meta?.ctaType}`);
  for (const o of f.offers) {
    console.log(`  offer${o.index}: "${o.fullText}"`);
    const interesting = o.dataQas.filter(d => /serviceIcon|finalPrice|originalPrice|discount|trial|free/i.test(d.q));
    for (const d of interesting) console.log(`    ${d.q} = ${JSON.stringify(d.text)}`);
  }
}

await context.close();
process.exit(0);
