// Deep-scroll the catalog page to see if more keeper cards appear past
// the initial 18. Scroll until height stabilizes (no more lazy-loaded
// content) OR we hit a max iteration cap.

import { chromium } from 'patchright';
import path from 'node:path';

const PROFILE_DIR = path.resolve('data/browser-playstation');
const URL = 'https://www.playstation.com/en-us/ps-plus/games/';

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

const countConcepts = async () => page.evaluate(() => {
  const plus = document.querySelector('section#plus-container');
  if (!plus) return -1;
  const re = /\/concept\/(\d+)/;
  const set = new Set();
  for (const a of plus.querySelectorAll('a[href]')) {
    const m = re.exec(a.getAttribute('href') || '');
    if (m) set.add(m[1]);
  }
  return set.size;
});

let prev = -1;
let stableRounds = 0;
for (let i = 0; i < 50; i++) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.8));
  await page.waitForTimeout(800);
  const n = await countConcepts();
  if (n === prev) {
    stableRounds++;
    if (stableRounds >= 4) {
      console.log(`Stable at ${n} concepts after ${i+1} scrolls (${stableRounds} stable rounds)`);
      break;
    }
  } else {
    stableRounds = 0;
  }
  if (i % 5 === 4 || n !== prev) console.log(`scroll ${i+1}: plus-container concepts = ${n}`);
  prev = n;
}

// Final count after a bottom-of-page scroll
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(2000);
console.log('Final plus-container concepts:', await countConcepts());

await context.close();
process.exit(0);
