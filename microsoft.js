import { chromium, devices } from 'patchright';
import { authenticator } from 'otplib';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { delay, datetime, prompt, notify, log, dataDir } from './src/util.js';
import { cfg } from './src/config.js';

const BING_REWARDS_URL = 'https://rewards.bing.com';
const BING_URL = 'https://www.bing.com';
const BING_REWARDS_ACTIVITY_CARD_SELECTOR = 'mee-card:has(.mee-icon-AddMedium)';

// Force stdout to flush immediately — Node.js buffers writes to non-TTY pipes
// (e.g. Docker), which causes log lines to appear in bursts instead of live.
if (process.stdout._handle?.setBlocking) process.stdout._handle.setBlocking(true);

log.section('Microsoft Rewards');
log.status('Time', datetime());
log.status('MS email', cfg.ms_email || '(none — will use EMAIL or prompt)');

if (cfg.ms_schedule_hours > 0) {
  // Intentionally delay BEFORE fetching search terms — we want current trending
  // queries at actual run time, not stale ones from when the loop fired hours earlier.
  //
  // Uses a target clock time (MS_SCHEDULE_START + random offset) rather than a random
  // duration from "now". This prevents drift: if LOOP fires at 7:30am every day and
  // the window is 8am–12pm, runs always land within that window regardless of how long
  // previous runs took.
  const now = new Date();
  const startHour = cfg.ms_schedule_start; // e.g. 8 for 8am
  const offsetMinutes = Math.floor(Math.random() * cfg.ms_schedule_hours * 60);
  const target = new Date(now);
  target.setHours(startHour, offsetMinutes, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1); // already past? push to tomorrow
  const delayMs = target - now;
  log.status('Scheduled start', `${target.toLocaleTimeString()} (+${(delayMs / 3600000).toFixed(1)}h)`);
  await delay(delayMs);
  log.status('Starting now', datetime());
}

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

// ── Search term sourcing ─────────────────────────────────────────────────────

const USED_TERMS_FILE = dataDir('ms-used-terms.json');
const USED_TERMS_WINDOW_DAYS = 30;

// Load the raw {term, ts} entries from disk, pruned to the rolling window.
// Returns the raw array so it can be passed straight to saveUsedTerms —
// avoiding a second file read inside that function.
function loadRawUsedTerms() {
  try {
    if (existsSync(USED_TERMS_FILE)) {
      const data = JSON.parse(readFileSync(USED_TERMS_FILE, 'utf8'));
      const cutoff = Date.now() - USED_TERMS_WINDOW_DAYS * 86400000;
      return data.filter(e => e.ts > cutoff);
    }
  } catch {}
  return [];
}

function saveUsedTerms(newTerms, existingRaw) {
  const now = Date.now();
  const updated = [...existingRaw];
  for (const term of newTerms) {
    if (!updated.some(e => e.term.toLowerCase() === term.toLowerCase()))
      updated.push({ term, ts: now });
  }
  writeFileSync(USED_TERMS_FILE, JSON.stringify(updated));
}

// Normalize a headline string to clean ASCII: handles smart quotes, em-dashes,
// accented characters, etc. rather than silently mangling or stripping them.
function normalizeHeadline(raw) {
  return raw.trim()
    .normalize('NFKD')                      // decompose accented chars (é → e + combining)
    .replace(/[\u0300-\u036f]/g, '')        // strip combining diacritics
    .replace(/[\u2018\u2019\u0060\u00B4]/g, "'") // smart/curly single quotes → '
    .replace(/[\u201C\u201D]/g, '"')        // smart double quotes → "
    .replace(/[\u2013\u2014]/g, '-')        // en/em dash → -
    .replace(/[\u2026]/g, '...')            // ellipsis → ...
    .replace(/[^\x20-\x7E]/g, '')          // drop any remaining non-ASCII
    .replace(/\s+/g, ' ').trim();
}

async function fetchGoogleTrending() {
  try {
    const res = await fetch('https://trends.google.com/trending/rss?geo=US', { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const text = await res.text();
    // Trends returns topic names like "Travis Scott" — not full queries.
    // Occasionally append a natural suffix to make them read more like searches.
    const suffixes = ['', '', '', ' news', ' update'];
    const terms = [];
    for (const m of text.matchAll(/<title>([^<]+)<\/title>/g)) {
      const t = normalizeHeadline(m[1]);
      if (t && t !== 'Daily Search Trends')
        terms.push(t + suffixes[Math.floor(Math.random() * suffixes.length)]);
    }
    return terms;
  } catch { return []; }
}

// Pick a random contiguous 3–5 word window from a headline.
// Simulates how a real user skims a headline and types the phrase that caught their eye,
// rather than searching the full title verbatim.
function randomHeadlineSlice(headline) {
  const words = headline.split(/\s+/).filter(w => w.length > 3);
  if (words.length <= 4) return headline; // already short enough
  const len = 3 + Math.floor(Math.random() * 3); // 3–5 words
  const start = Math.floor(Math.random() * Math.max(1, words.length - len));
  return words.slice(start, start + len).join(' ');
}

async function fetchRSSHeadlines(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const text = await res.text();
    const terms = [];
    for (const m of text.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)) {
      const t = normalizeHeadline(m[1]);
      if (t.length > 10 && t.length < 75 && !/www\.|:\/\//.test(t))
        terms.push(randomHeadlineSlice(t));
    }
    return terms.slice(1); // skip feed title (first <title> is the channel name)
  } catch { return []; }
}

function fallbackTerms(count, usedSet) {
  return BING_SEARCH_TERMS.flatMap(category =>
    category.slice()
      .filter(t => !usedSet.has(t.toLowerCase()))
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.ceil(count / BING_SEARCH_TERMS.length))
  ).sort(() => Math.random() - 0.5);
}

async function buildSearchList(count) {
  const rawEntries = loadRawUsedTerms();
  const usedSet = new Set(rawEntries.map(e => e.term.toLowerCase()));

  const [trending, bbc, espn] = await Promise.all([
    fetchGoogleTrending(),
    fetchRSSHeadlines('https://feeds.bbci.co.uk/news/rss.xml'),
    fetchRSSHeadlines('https://www.espn.com/espn/rss/news/rss.xml'),
  ]);
  log.status('Live terms', `${trending.length} trending, ${bbc.length} BBC, ${espn.length} ESPN`);

  const live = [...trending, ...bbc, ...espn].filter(t => !usedSet.has(t.toLowerCase()));
  const fallback = fallbackTerms(count, usedSet);
  const selected = [...live.sort(() => Math.random() - 0.5), ...fallback].slice(0, count);

  saveUsedTerms(selected, rawEntries); // pass already-loaded entries to avoid double read
  return selected;
}

function randomMs(maxSeconds) {
  return Math.floor(Math.random() * (maxSeconds * 1000 - 1000 + 1)) + 1000;
}

async function createContext(isMobile) {
  const browserDir = cfg.dir.browser + (isMobile ? '-mobile' : '');
  const deviceSettings = isMobile ? devices['Pixel 7'] : {};

  // Slightly vary desktop viewport each run so it's not identical every time
  const viewport = isMobile ? { width: cfg.width, height: cfg.height } : {
    width: cfg.width + Math.floor(Math.random() * 41) - 20,   // ±20px
    height: cfg.height + Math.floor(Math.random() * 41) - 20, // ±20px
  };

  const context = await chromium.launchPersistentContext(browserDir, {
    headless: false,
    viewport,
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

  // Desktop: remove automation fingerprints and spoof hardware properties
  if (!isMobile) {
    await context.addInitScript(() => {
      delete Object.getPrototypeOf(navigator).webdriver;
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    });
  }

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
    log.status('Login check URL', url);
    const loggedIn = !url.includes('login.live.com')
      && !url.includes('login.microsoftonline.com')
      && !url.includes('account.microsoft.com')
      && !url.includes('/welcome');
    log.status('Logged in', loggedIn ? 'yes' : 'no');
    return loggedIn;
  } catch (e) {
    log.warn(`isLoggedIn check failed: ${e.message}`);
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
  const loginStartUrl = page.url();
  log.status('Login start URL', loginStartUrl);
  if (loginStartUrl.includes('/welcome')) {
    log.info('On welcome page — clicking Sign In');
    await page.waitForTimeout(2000); // allow JS to render

    // getByRole is the most reliable way to find interactive sign-in elements
    const signInEl = page.getByRole('link', { name: /sign.{0,5}in/i })
      .or(page.getByRole('button', { name: /sign.{0,5}in/i }))
      .first();

    if (await signInEl.isVisible().catch(() => false)) {
      log.info('Found Sign In element — clicking');
      await signInEl.click();
      await page.waitForTimeout(3000);
      log.status('URL after Sign In click', page.url());
    } else {
      // Dump links/buttons for debugging
      const pageElements = await page.evaluate(() =>
        [...document.querySelectorAll('a, button')].map(el =>
          `<${el.tagName.toLowerCase()} href="${el.href || ''}">${el.textContent.trim().substring(0, 80)}</${el.tagName.toLowerCase()}>`
        ).join('\n')
      ).catch(() => 'could not dump');
      log.warn('Could not find Sign In element on welcome page');
      log.info(`Links/buttons on page:\n${pageElements}`);
      // Fallback: go directly to Microsoft login with Rewards as return URL
      log.info('Navigating directly to Microsoft login');
      await page.goto('https://login.live.com/login.srf?wa=wsignin1.0&wreply=https%3A%2F%2Frewards.bing.com%2F&lc=1033');
      await page.waitForTimeout(2000);
      log.status('URL after fallback nav', page.url());
    }
  } else if (loginStartUrl.includes('login.live.com') || loginStartUrl.includes('login.microsoftonline.com')) {
    log.info('Redirected directly to MS login page — proceeding');
  } else {
    log.warn(`Unexpected URL at login start: ${loginStartUrl}`);
  }

  log.status('URL before email input', page.url());
  // Email step — wait for the field, click to focus, then fill
  const emailInput = await page.waitForSelector('input[type="email"], input[name="loginfmt"], #i0116');
  log.info(`Filling email: ${email}`);
  await emailInput.click();
  await emailInput.fill(email);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
  log.status('URL after email submit', page.url());

  // Some accounts show "sign in another way" before the password field
  for (const text of ['Sign in another way', 'Other ways to sign in']) {
    const el = page.locator(`text="${text}"`).first();
    if (await el.isVisible().catch(() => false)) {
      log.info(`Clicking "${text}"`);
      await el.click();
      await page.waitForTimeout(2000);
      break;
    }
  }
  const usePassword = page.locator('text="Use your password"').first();
  if (await usePassword.isVisible().catch(() => false)) {
    log.info('Clicking "Use your password"');
    await usePassword.click();
    await page.waitForTimeout(2000);
  }

  log.status('URL before password', page.url());
  // Password step
  const password = cfg.ms_password || await prompt({ type: 'password', message: 'Enter Microsoft password' });
  if (!password) {
    await notify('microsoft-rewards: no password provided.');
    process.exit(1);
  }
  const pwInput = await page.waitForSelector('input[type="password"], input[name="passwd"], #i0118');
  log.info('Filling password');
  await pwInput.fill(password);
  await page.getByTestId('primaryButton').click();
  await page.waitForTimeout(3000);
  log.status('URL after password submit', page.url());

  // 2FA
  const needs2fa = await page.locator('text=Enter the code generated by your authenticator app').isVisible().catch(() => false)
    || /proofs|mfa|verification/.test(page.url());
  if (needs2fa) {
    log.info('2FA required');
    log.status('URL at 2FA', page.url());
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
    log.info('Clicking "Stay signed in"');
    await stayBtn.click();
  }
  // Wait for the full OAuth redirect chain back to rewards.bing.com.
  // ppsecure/post.srf does a form POST that triggers a multi-step redirect;
  // a fixed timeout is not enough — wait for the URL to actually land.
  log.info('Waiting for redirect back to rewards.bing.com...');
  await page.waitForURL(/rewards\.bing\.com/, { timeout: 30000 }).catch(e => {
    log.warn(`Redirect wait timed out or failed: ${e.message}`);
  });
  log.status('URL after login complete', page.url());

  if (!cfg.debug) page.context().setDefaultTimeout(cfg.timeout);
}

async function clickEveryPendingActivityCard(page) {
  log.info('Clicking pending activity cards');
  await page.goto(BING_REWARDS_URL, { waitUntil: 'load' });
  const cards = await page.locator(BING_REWARDS_ACTIVITY_CARD_SELECTOR).elementHandles();
  log.status('Activity cards found', cards.length);
  for (let i = 0; i < cards.length; i++) {
    log.progressStart(`Clicking card #${i + 1}: ...`);
    await cards[i].click();
    const ms = randomMs(15);
    log.progressAppend(` Sleep: ${(ms / 1000).toFixed(1)}s ...`);
    await delay(ms);
    log.progressEnd(' done');
  }
}

async function executeBingSearch(page, searchTerm, preEnterMs) {
  await page.goto(BING_URL, { waitUntil: 'load' });
  for (const char of searchTerm) {
    await page.keyboard.type(char, { delay: 100 + Math.floor(Math.random() * 100) });
  }
  await delay(preEnterMs);
  await page.keyboard.press('Enter');
  await page.locator('#b_results').waitFor({ timeout: 60000 });
  // ~40% of the time, scroll down to simulate reading results
  if (Math.random() < 0.4) {
    await page.mouse.wheel(0, 300 + Math.floor(Math.random() * 400));
    await delay(500 + Math.floor(Math.random() * 1000));
  }
}

async function executeBingSearches(page, searchTerms) {
  const initMs = randomMs(180);
  log.progressInfo(`Executing ${searchTerms.length} Bing searches ... Sleep: ${(initMs / 1000).toFixed(1)}s ...`);
  await delay(initMs);
  log.progressEnd(' ready');
  for (let i = 0; i < searchTerms.length; i++) {
    const term = searchTerms[i];
    const preEnterMs = randomMs(10);
    const interMs = i < searchTerms.length - 1 ? randomMs(180) : 0;
    log.progressStart(`Search #${i + 1}: "${term}" ...`);
    let ok = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await executeBingSearch(page, term, preEnterMs);
        ok = true;
        break;
      } catch (e) {
        if (attempt < 3) {
          log.progressAppend(` retry ${attempt + 1}...`);
        } else {
          log.progressEnd(' SKIP');
          log.warn(`Search failed after 3 attempts: ${e.message}`);
        }
      }
    }
    if (!ok) continue;
    log.progressAppend(` Sleep: ${(preEnterMs / 1000).toFixed(1)}s`);
    if (interMs > 0) {
      log.progressAppend(` ... Sleep: ${(interMs / 1000).toFixed(1)}s`);
      await delay(interMs);
    }
    log.progressEnd(' ... done');
  }
}

// Handle SIGINT for whichever context is currently active
let activeContext = null;
process.on('SIGINT', async () => {
  console.error('\nInterrupted by SIGINT. Exit!');
  process.exitCode = 130;
  if (activeContext) await activeContext.close();
});

// Vary search counts slightly each run to avoid a fixed daily pattern
const desktopSearchCount = 33 + Math.floor(Math.random() * 5); // 33–37
const mobileSearchCount = 23 + Math.floor(Math.random() * 5);  // 23–27
const searchTerms = await buildSearchList(desktopSearchCount + mobileSearchCount);

// Desktop session
log.section('Desktop');
{
  const { context, page } = await createContext(false);
  activeContext = context;
  try {
    let loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      await login(page);
      loggedIn = await isLoggedIn(page);
    }
    if (loggedIn) {
      log.status('Signed in', 'yes');
      await clickEveryPendingActivityCard(page);
      await executeBingSearches(page, searchTerms.slice(0, desktopSearchCount));
    } else {
      log.fail('Login failed or timed out — skipping desktop session');
    }
  } finally {
    await context.close();
    activeContext = null;
  }
}

// Random gap between sessions — a human wouldn't switch devices instantly
const interSessionMinutes = 5 + Math.floor(Math.random() * 16); // 5–20 min
log.status('Inter-session gap', `${interSessionMinutes}m`);
await delay(interSessionMinutes * 60 * 1000);

// Mobile session (separate browser profile)
log.section('Mobile');
{
  const { context, page } = await createContext(true);
  activeContext = context;
  try {
    let loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      await login(page);
      loggedIn = await isLoggedIn(page);
    }
    if (loggedIn) {
      log.status('Signed in', 'yes');
      await clickEveryPendingActivityCard(page);
      await executeBingSearches(page, searchTerms.slice(-mobileSearchCount));
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
