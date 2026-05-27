// Test if ?category=GAME_CATALOG returns the full keeper catalog (or if it
// requires a click). plus-container without the param showed only 18 keepers.

import { chromium } from 'patchright';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const PROFILE_DIR = path.resolve('data/browser-playstation');
const URL = 'https://www.playstation.com/en-us/ps-plus/games/?category=GAME_CATALOG';

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  locale: 'en-US',
  args: ['--hide-crash-restore-bubble'],
});
const page = context.pages()[0] || await context.newPage();

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(4000);
for (let i = 0; i < 8; i++) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
  await page.waitForTimeout(600);
}

const counts = await page.evaluate(() => {
  const plusContainer = document.querySelector('section#plus-container');
  const trials = document.querySelector('section#trials');
  const conceptRe = /\/concept\/(\d+)/;
  const insidePlus = new Set();
  const insideTrials = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    const m = conceptRe.exec(href);
    if (!m) continue;
    if (plusContainer && plusContainer.contains(a)) insidePlus.add(m[1]);
    if (trials && trials.contains(a)) insideTrials.add(m[1]);
  }
  return {
    plus: insidePlus.size,
    trials: insideTrials.size,
    plusSample: [...insidePlus].slice(0, 10),
  };
});

console.log('URL:', URL);
console.log('plus-container concepts:', counts.plus);
console.log('trials section concepts:', counts.trials);
console.log('plus-container sample:', counts.plusSample);

writeFileSync(path.resolve('data/ps-catalog-game-catalog.html'), await page.content());
await context.close();
process.exit(0);
