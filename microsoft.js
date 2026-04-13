import { chromium, devices } from 'patchright';
import { authenticator } from 'otplib';
import { delay, datetime, prompt, notify, log } from './src/util.js';
import { cfg } from './src/config.js';

const BING_REWARDS_URL = 'https://rewards.bing.com';
const BING_URL = 'https://www.bing.com';
const BING_REWARDS_ACTIVITY_CARD_SELECTOR = 'mee-card:has(.mee-icon-AddMedium)';

log.section('Microsoft Rewards');
log.status('Time', datetime());

const BING_SEARCH_TERMS = [
  // Language
  [
    ['translate', 'how to pronounce', 'common phrases in', 'language tips for', 'how do you say', 'learn', 'language learning resources for'],
    ['french', 'german', 'spanish', 'japanese', 'mandarin', 'italian', 'korean'],
  ],
  // Cooking
  [
    ['best recipe for', 'how to cook', 'nutritional facts about', 'substitute for', 'top rated', 'make at home', 'how long to bake'],
    ['lasagna', 'banana bread', 'sushi rice', 'tofu stir fry', 'cauliflower pizza', 'homemade hummus'],
  ],
  // Health
  [
    ['symptoms of', 'natural cure for', 'best treatment for', 'how to prevent', 'is it healthy to', 'how often should I', 'side effects of'],
    ['insomnia', 'acid reflux', 'depression', 'iron deficiency', 'high blood pressure', 'intermittent fasting', 'yoga'],
  ],
  // Productivity
  [
    ['increase productivity with', 'benefits of', 'how to start', 'top tips for', 'common mistakes in', 'how to build a habit for'],
    ['journaling', 'minimalism', 'Pomodoro technique', 'goal setting', 'daily planning', 'habit tracking'],
  ],
  // Shopping
  [
    ['affordable', 'best rated', 'latest deals on', 'compare prices of', 'should I buy', 'value for money', 'review of'],
    ['wireless earbuds', 'gaming laptops', 'air purifiers', 'LED lamps', 'blenders', 'ergonomic chairs'],
  ],
  // Travel
  [
    ['best time to travel to', 'things to do in', 'underrated places in', 'weekend trip to', 'travel safety tips for', 'visa requirement for'],
    ['canada', 'bali', 'portugal', 'copenhagen', 'thailand', 'dubai', 'iceland'],
  ],
  // Finance
  [
    ['current value of', 'investment tips for', 'what affects', 'how to save on', 'economic forecast for', 'trading strategy for'],
    ['bitcoin', 'retirement fund', 'mortgage rates', 'real estate', 'tesla stock', 'gold price'],
  ],
  // Sports
  [
    ['who won', 'match highlights', 'how to watch', 'scoreboard', 'player of the year', 'injury update for'],
    ['nba finals', 'wimbledon', 'mlb', 'nfl draft', 'olympics', 'world cup', 'tour de france'],
  ],
  // Weather
  [
    ['weather this weekend in', 'extended forecast for', 'UV index in', 'pollen count in', 'air quality in', 'sunset time in'],
    ['seattle', 'barcelona', 'new delhi', 'tokyo', 'moscow', 'rio de janeiro', 'cape town'],
  ],
  // Technology
  [
    ['latest update on', 'troubleshooting', 'how to install', 'introduction to', 'best tools for', 'future of'],
    ['artificial intelligence', 'linux', 'blockchain', 'augmented reality', 'typescript', 'cloud computing', 'flutter'],
  ],
  // History and Culture
  [
    ['historical events in', 'famous landmarks of', 'cultural traditions in', 'museum exhibits about', 'origin of', 'impact of'],
    ['ancient rome', 'renaissance period', 'world war 2', 'maya civilization', 'victorian era', 'industrial revolution', 'ottoman empire'],
  ],
  // Nature
  [
    ['endangered species in', 'climate change effects on', 'wildlife facts about', 'how to protect', 'rainforest importance', 'renewable energy in'],
    ['amazon rainforest', 'antarctica', 'australia', 'sahara desert', 'pacific ocean', 'arctic circle', 'mount everest'],
  ],
  // Hobbies
  [
    ['how to get started with', 'tips for beginners in', 'benefits of learning', 'advanced techniques in', 'popular equipment for', 'communities for'],
    ['photography', 'woodworking', 'birdwatching', 'model trains', 'fishing', 'gardening', '3d printing'],
  ],
  // Careers
  [
    ['skills required for', 'day in the life of', 'best certifications for', 'remote jobs in', 'freelancing tips for', 'interview questions for'],
    ['cybersecurity analyst', 'product manager', 'graphic designer', 'software engineer', 'data scientist', 'UX researcher'],
  ],
  // Music
  [
    ['lyrics of', 'meaning behind', 'release date of', 'music video for', 'who wrote', 'chords for', 'top songs by'],
    ['bohemian rhapsody', 'shape of you', 'blinding lights', 'bad guy', 'drivers license', 'hotel california', 'take me to church'],
  ],
  // Movies
  [
    ['plot summary of', 'cast of', 'release year of', 'awards won by', 'director of', 'soundtrack of', 'where to stream'],
    ['inception', 'the godfather', 'parasite', 'pulp fiction', 'avengers endgame', 'la la land', 'everything everywhere all at once'],
  ],
  // Games
  [
    ['walkthrough for', 'review of', 'release date of', 'multiplayer mode in', 'system requirements for', 'how to mod', 'top tips for'],
    ['zelda breath of the wild', 'elden ring', 'minecraft', 'cyberpunk 2077', 'the witcher 3', 'fortnite', 'starfield'],
  ],
  // Books
  [
    ['summary of', 'author of', 'genre of', 'awards won by', 'sequel to', 'publication year of', 'characters in'],
    ['to kill a mockingbird', '1984', 'the great gatsby', "harry potter and the sorcerer's stone", 'the catcher in the rye', 'pride and prejudice', 'the hobbit'],
  ],
  // Vocabulary
  [
    ['meaning of', 'definition of', 'how to use', 'examples of', 'what does it mean', 'synonyms of', 'antonyms of'],
    ['ephemeral', 'ubiquitous', 'serendipity', 'catharsis', 'dichotomy', 'paradox', 'juxtaposition'],
  ],
  // Time Zones
  [
    ['current time in', 'what time is it in', 'time difference with', 'date and time in', 'timezone of', 'is it day or night in'],
    ['tokyo', 'new york', 'london', 'sydney', 'dubai', 'moscow', 'cape town', 'beijing'],
  ],
].map(category => category[0].flatMap(a1 => category[1].map(a2 => `${a1} ${a2}`)));

function generateRandomSearchTermsList(length) {
  return BING_SEARCH_TERMS.flatMap(category =>
    category.slice().sort(() => Math.random() - 0.5).slice(0, Math.ceil(length / BING_SEARCH_TERMS.length))
  ).sort(() => Math.random() - 0.5).slice(0, length);
}

async function sleepRandomized(maxSeconds) {
  const ms = Math.floor(Math.random() * (maxSeconds * 1000 - 1000 + 1)) + 1000;
  log.status('Sleep', `${(ms / 1000).toFixed(1)}s`);
  await delay(ms);
}

async function createContext(isMobile) {
  const browserDir = cfg.dir.browser + (isMobile ? '-mobile' : '');
  const deviceSettings = isMobile ? devices['Pixel 7'] : {};

  const context = await chromium.launchPersistentContext(browserDir, {
    headless: false,
    viewport: { width: cfg.width, height: cfg.height },
    locale: 'en-US',
    handleSIGINT: false,
    args: [
      '--hide-crash-restore-bubble',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
    ],
    ...deviceSettings, // for mobile: overrides viewport, sets userAgent/isMobile/hasTouch
  });

  if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

  // Suppress passkey dialog on all contexts
  await context.addInitScript(() => {
    if ('credentials' in navigator) {
      navigator.credentials.get = () => Promise.resolve(null);
      navigator.credentials.create = () => Promise.resolve(null);
    }
  });

  // Fake mobile navigator APIs to avoid bot detection on mobile context
  if (isMobile) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l' });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 4 });
      delete Object.getPrototypeOf(navigator).webdriver;
      window.ontouchstart = () => true;
      window.ontouchend = () => true;

      // Realistic PluginArray / MimeTypeArray spoof
      (() => {
        const OriginalPluginArray = Object.getPrototypeOf(navigator.plugins).constructor;
        const OriginalMimeTypeArray = Object.getPrototypeOf(navigator.mimeTypes).constructor;

        function FakePlugin(name, description, filename, mimeTypes) {
          this.name = name; this.description = description; this.filename = filename;
          mimeTypes.forEach((mt, idx) => (this[idx] = mt));
          this.length = mimeTypes.length;
        }
        function FakeMimeType(type, suffixes, description) {
          this.type = type; this.suffixes = suffixes; this.description = description; this.enabledPlugin = null;
        }

        const pdfMime = new FakeMimeType('application/pdf', 'pdf', '');
        const naclMime = new FakeMimeType('application/x-nacl', '', '');
        const chromePdfPlugin = new FakePlugin('Chrome PDF Plugin', 'Portable Document Format', 'internal-pdf-viewer', [pdfMime]);
        const chromePdfViewer = new FakePlugin('Chrome PDF Viewer', '', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', [pdfMime]);
        const nativeClient = new FakePlugin('Native Client', '', 'internal-nacl-plugin', [naclMime]);

        [pdfMime].forEach(mt => (mt.enabledPlugin = chromePdfPlugin));
        [naclMime].forEach(mt => (mt.enabledPlugin = nativeClient));

        const pluginArray = new OriginalPluginArray();
        [chromePdfPlugin, chromePdfViewer, nativeClient].forEach((plg, idx) => (pluginArray[idx] = plg));
        pluginArray.length = 3;
        pluginArray.item = function (idx) { return this[idx]; };
        pluginArray.namedItem = function (name) { for (let i = 0; i < this.length; i++) { if (this[i].name === name) return this[i]; } return null; };

        const mimeArray = new OriginalMimeTypeArray();
        [pdfMime, naclMime].forEach((mt, idx) => (mimeArray[idx] = mt));
        mimeArray.length = 2;
        mimeArray.item = function (idx) { return this[idx]; };
        mimeArray.namedItem = function (type) { for (let i = 0; i < this.length; i++) { if (this[i].type === type) return this[i]; } return null; };

        Object.setPrototypeOf(pluginArray, OriginalPluginArray.prototype);
        Object.setPrototypeOf(mimeArray, OriginalMimeTypeArray.prototype);
        Object.defineProperty(navigator, 'plugins', { get: () => pluginArray });
        Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeArray });
        const NavigatorProto = Object.getPrototypeOf(navigator);
        Object.defineProperty(NavigatorProto, 'plugins', { get: () => pluginArray });
        Object.defineProperty(NavigatorProto, 'mimeTypes', { get: () => mimeArray });
      })();

      Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({ brands: [{ brand: 'Chromium', version: '136' }], mobile: true, platform: 'Android' }),
      });
    });
  }

  // Close any popups automatically
  context.on('page', async popup => { await popup.close(); });

  const page = context.pages().length ? context.pages()[0] : await context.newPage();
  return { context, page };
}

async function isLoggedIn(page) {
  try {
    await page.goto(BING_REWARDS_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000); // allow JS-based redirects to settle
    const url = page.url();
    return !url.includes('login.live.com')
      && !url.includes('login.microsoftonline.com')
      && !url.includes('account.microsoft.com')
      && !url.includes('/welcome');
  } catch {
    return false;
  }
}

async function login(page) {
  log.warn('Not signed in');
  if (cfg.nowait) process.exit(1);
  if (cfg.novnc_port) log.info(`Open http://localhost:${cfg.novnc_port} to login inside the docker container`);
  if (!cfg.debug) page.context().setDefaultTimeout(cfg.login_timeout);
  log.status('Login timeout', `${cfg.login_timeout / 1000}s`);

  const email = cfg.ms_email || await prompt({ message: 'Enter Microsoft email' });
  if (!email) {
    await notify('microsoft-rewards: not signed in and no credentials set.');
    if (cfg.headless) {
      log.info('Run `SHOW=1 node microsoft` to login in the opened browser');
      await page.context().close();
      process.exit(1);
    }
    log.info('Waiting for you to login in the browser');
    return; // caller will re-check isLoggedIn after this returns
  }

  if (cfg.ms_email && cfg.ms_password) log.info('Using credentials from environment');

  // rewards.bing.com may JS-redirect to a /welcome landing page rather than
  // the Microsoft login form. Wait for that client-side redirect to settle
  // before checking the URL, then find and follow the sign-in link.
  await page.goto(BING_REWARDS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000); // allow JS-based redirects to complete
  log.status('Login page URL', page.url());
  if (page.url().includes('/welcome')) {
    log.info('On welcome page — locating sign-in link');
    await page.waitForTimeout(2000); // allow JS to render
    const loginHref = await page.evaluate(() => {
      for (const el of document.querySelectorAll('a')) {
        const href = el.href || '';
        const text = (el.textContent || '').toLowerCase();
        if (href.includes('login') || href.includes('signin') || text.includes('sign in')) return href;
      }
      return null;
    }).catch(() => null);
    if (loginHref) {
      log.status('Navigating to', loginHref);
      await page.goto(loginHref, { waitUntil: 'load' });
    } else {
      log.warn('Could not find sign-in link on welcome page — proceeding anyway');
    }
  }

  // Email step — wait for the field, click to focus, then fill
  const emailInput = await page.waitForSelector('input[type="email"], input[name="loginfmt"], #i0116');
  await emailInput.click();
  await emailInput.fill(email);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  // Some accounts show "sign in another way" before the password field
  for (const text of ['Sign in another way', 'Other ways to sign in']) {
    const el = page.locator(`text="${text}"`).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      await page.waitForTimeout(2000);
      break;
    }
  }
  const usePassword = page.locator('text="Use your password"').first();
  if (await usePassword.isVisible().catch(() => false)) {
    await usePassword.click();
    await page.waitForTimeout(2000);
  }

  // Password step
  const password = cfg.ms_password || await prompt({ type: 'password', message: 'Enter Microsoft password' });
  if (!password) {
    await notify('microsoft-rewards: no password provided.');
    process.exit(1);
  }
  const pwInput = await page.waitForSelector('input[type="password"], input[name="passwd"], #i0118');
  await pwInput.fill(password);
  await page.getByTestId('primaryButton').click();
  await page.waitForTimeout(3000);

  // 2FA
  const needs2fa = await page.locator('text=Enter the code generated by your authenticator app').isVisible().catch(() => false)
    || /proofs|mfa|verification/.test(page.url());
  if (needs2fa) {
    log.info('2FA required');
    const otp = (cfg.ms_otpkey && authenticator.generate(cfg.ms_otpkey))
      || await prompt({ type: 'text', message: 'Enter 2FA code', validate: n => n.toString().length == 6 || 'Must be 6 digits' });
    if (otp) {
      const otpInput = page.locator('input[name="otc"], #idTxtBx_SAOTCC_OTC, input[inputmode="numeric"], input[autocomplete="one-time-code"]').first();
      await otpInput.click();
      await otpInput.pressSequentially(otp.toString());
      await page.getByTestId('primaryButton').click().catch(() => {});
      await page.waitForTimeout(3000);
    }
  }

  // "Stay signed in" prompt
  const stayBtn = page.getByTestId('primaryButton');
  if (await stayBtn.isVisible().catch(() => false)) {
    await stayBtn.click();
  }

  if (!cfg.debug) page.context().setDefaultTimeout(cfg.timeout);
}

async function clickEveryPendingActivityCard(page) {
  log.info('Clicking pending activity cards');
  await page.goto(BING_REWARDS_URL, { waitUntil: 'load' });
  const cards = await page.locator(BING_REWARDS_ACTIVITY_CARD_SELECTOR).elementHandles();
  log.status('Activity cards found', cards.length);
  for (const card of cards) {
    log.status('Clicking card', '...');
    await card.click();
    await sleepRandomized(60);
  }
}

async function executeBingSearch(page, searchTerm) {
  log.status('Search', `"${searchTerm}"`);
  await page.goto(BING_URL, { waitUntil: 'load' });
  for (const char of searchTerm) {
    await page.keyboard.type(char, { delay: 100 + Math.floor(Math.random() * 100) });
  }
  await sleepRandomized(10);
  await page.keyboard.press('Enter');
  await page.locator('#b_results').waitFor({ timeout: 60000 });
}

async function executeBingSearches(page, searchTerms) {
  log.info(`Executing ${searchTerms.length} Bing searches`);
  for (const term of searchTerms) {
    await sleepRandomized(1200);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await executeBingSearch(page, term);
        break;
      } catch (e) {
        log.warn(`Search failed (attempt ${attempt}/3): ${e.message}`);
        if (attempt === 3) log.fail(`Skipping search: "${term}"`);
      }
    }
  }
}

// Handle SIGINT for whichever context is currently active
let activeContext = null;
process.on('SIGINT', async () => {
  console.error('\nInterrupted by SIGINT. Exit!');
  process.exitCode = 130;
  if (activeContext) await activeContext.close();
});

const searchTerms = generateRandomSearchTermsList(60);

// Desktop session (35 searches)
log.section('Desktop');
{
  const { context, page } = await createContext(false);
  activeContext = context;
  try {
    if (!await isLoggedIn(page)) await login(page);
    if (await isLoggedIn(page)) {
      log.status('Signed in', 'yes');
      await clickEveryPendingActivityCard(page);
      await executeBingSearches(page, searchTerms.slice(0, 35));
    } else {
      log.fail('Login failed or timed out — skipping desktop session');
    }
  } finally {
    await context.close();
    activeContext = null;
  }
}

// Mobile session (25 searches, separate browser profile)
log.section('Mobile');
{
  const { context, page } = await createContext(true);
  activeContext = context;
  try {
    if (!await isLoggedIn(page)) await login(page);
    if (await isLoggedIn(page)) {
      log.status('Signed in', 'yes');
      await clickEveryPendingActivityCard(page);
      await executeBingSearches(page, searchTerms.slice(-25));
    } else {
      log.fail('Login failed or timed out — skipping mobile session');
    }
  } finally {
    await context.close();
    activeContext = null;
  }
}

await notify('microsoft-rewards: completed desktop and mobile reward sessions.');
log.section('Done');
log.status('Time', datetime());
