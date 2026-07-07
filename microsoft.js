import { chromium, devices } from 'patchright';
import { authenticator } from 'otplib';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { delay, datetime, prompt, notify, log, dataDir, jsonDb, cleanProfileLocks, localeArgs } from './src/util.js';
import { cfg } from './src/config.js';
import { siteVersion } from './src/sites.js';

const BING_REWARDS_URL = 'https://rewards.bing.com';
const BING_URL = 'https://www.bing.com';
// Two selectors comma-unioned so we match both dashboard variants MS
// currently ships:
//   - Legacy Angular dashboard: <mee-card> with an "AddMedium" plus-icon
//     inside marks an unfinished activity — click the card to claim.
//   - Post-2026 Premium dashboard: no more <mee-card>; the pending-activity
//     tile is standard HTML with a <p> point-value badge like "+10" whose
//     class chain is the Tailwind utility set below. Contributed by
//     kevindevm in #102 after they noticed the legacy selector matched
//     zero cards on their account (third clever find in a row from the
//     same contributor — see #71 RSC balance, #99 Ready-to-claim card).
// Comma union means Playwright's `.locator()` matches either variant, so
// existing users on the legacy dashboard see no regression and users on
// the new dashboard finally get their cards clicked.
const BING_REWARDS_ACTIVITY_CARD_SELECTOR = 'mee-card:has(.mee-icon-AddMedium), p.text-metadata.leading-none.text-statusInformativeTintFg';

// Force stdout to flush immediately — Node.js buffers writes to non-TTY pipes
// (e.g. Docker), which causes log lines to appear in bursts instead of live.
if (process.stdout._handle?.setBlocking) process.stdout._handle.setBlocking(true);

log.section(`Microsoft Rewards (v${siteVersion('microsoft')})`);
log.status('MS email', cfg.ms_email || '(none — will use EMAIL or prompt)');

// MS_SKIP_WINDOW=1 bypasses the internal wait-until-window sleep regardless
// of the merged cfg value. The panel's per-card "Run" button sets this so a
// manual test click doesn't have to wait 18 hours for the next MS window.
const skipWindow = process.env.MS_SKIP_WINDOW === '1';
if (cfg.ms_schedule_hours > 0 && skipWindow) {
  log.status('Schedule window', 'skipped (MS_SKIP_WINDOW=1) — running now');
}

if (cfg.ms_schedule_hours > 0 && !skipWindow) {
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

  cleanProfileLocks(browserDir);
  const context = await chromium.launchPersistentContext(browserDir, {
    headless: false,
    viewport,
    locale: 'en-US',
    handleSIGINT: false,
    args: [
      '--hide-crash-restore-bubble',
      // GPU / WebGL fingerprint hardening. In a container without GPU
      // passthrough, Chromium without these flags can end up with WebGL
      // either disabled or in a weird "broken-WebGL" state — both are
      // stronger bot tells than the consistent "software-rendered WebGL"
      // fingerprint you get with SwiftShader (vendor "Google Inc.",
      // renderer "Google SwiftShader"). Suggested by @mzernetsch on #56
      // as part of the set of changes that historically cleared MS's
      // "Unusual search activity" banner. --enable-webgl is default-on
      // in modern Chromium but kept explicit so the intent is readable.
      '--use-gl=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
      ...localeArgs(),
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

// Scrape the current Rewards points balance from rewards.bing.com. The
// counter lives in the top-right of the dashboard; MS has used several
// different IDs over the years, so try a few and take the first one that
// yields a plausible integer. Returns null if none match (we just skip
// recording the run instead of failing it).
async function readPointsBalance(page) {
  // Two attempts to cover MS throttling the dashboard load after a
  // heavy search session (v2.8.36); domcontentloaded over load to
  // avoid blocking on long-tail analytics pings.
  //
  // Selector strategy (v2.8.39): MS rebuilt the Rewards dashboard
  // between when we wrote the original selectors and 2026-06. None
  // of the original four match the new layout (kevindevm in #71, on
  // a Spanish-locale account showing 3228 balance, all four selectors
  // returned 0 count). Expanded the candidate list with the patterns
  // MS uses on the new Premium dashboard and added a structural-text
  // fallback (the balance is rendered as a visible 4-5-digit number
  // in a top-bar element). On miss, emit a self-service diagnostic
  // dump (top-of-DOM h1/h2/numeric-spans) so the next diagnostics
  // submission tells us what the page actually renders.
  const selectors = [
    // Legacy selectors (pre-2026 dashboard).
    '#id_rc',
    '[data-bi-id="userCounter"]',
    '#getPointsCounter',
    '.pointsValue',
    // Premium-dashboard candidates — multiple aria patterns MS has
    // used in regional rollouts. The aria-labels often carry the
    // localized "points" word so we match anywhere in the label.
    '[aria-label*="points" i]',
    '[aria-label*="puntos" i]',
    '[aria-label*="punkte" i]',
    '[aria-label*="punkty" i]',
    '[aria-label*="balance" i]',
    // Card-text patterns MS uses for the top-bar counter
    'mee-rewards-counter-animation',
    '.points-summary-balance',
    '[data-testid="points-counter"]',
    '[data-bi-name*="points" i]',
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(BING_REWARDS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await delay(3000);
      // Redesigned-dashboard rollout (Dr4w's #110, 2026-07): MS sometimes
      // lands rewards.bing.com/ on /about (public info page) even when
      // the session cookie is present, before eventually hydrating the
      // authenticated dashboard. Force-navigate to /dashboard explicitly
      // and re-wait if we detect the /about landing. Portable — old UI
      // stays at rewards.bing.com/, new UI lives at /dashboard.
      if (/\/about(\/|$|\?)/i.test(page.url())) {
        log.info('readPointsBalance: landed on /about — navigating to /dashboard explicitly');
        try {
          await page.goto(BING_REWARDS_URL + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
          await delay(3000);
        } catch (e) {
          log.info(`readPointsBalance: /dashboard navigation ${String(e.message || e).split('\n')[0]}`);
        }
      }
      // RSC primary path (v2.8.40, from kevindevm's #71 finding): MS's
      // dashboard is a React Server Components route, and re-fetching
      // the same URL with header `rsc: 1` returns the RSC stream — a
      // text blob that carries a literal `"balance":<N>,"level":<N>`
      // pair. This sidesteps DOM scraping entirely: it's locale-blind
      // (no localized label text), survives dashboard-layout redesigns
      // (the field is in the data layer, not the rendered HTML), and
      // costs one extra HTTP request that the browser context's
      // cookies authenticate transparently. DOM selectors stay as a
      // fallback in case MS changes the RSC contract.
      // 2026-07 hardening (#110): try both the legacy root URL and the
      // new /dashboard route since MS split the redesign across paths.
      // First hit that yields a balance wins; the old UI has RSC on /,
      // the redesign moves it to /dashboard.
      const rscCandidates = [BING_REWARDS_URL, BING_REWARDS_URL + '/dashboard'];
      for (const rscUrl of rscCandidates) {
        try {
          const rscText = await page.evaluate(async (url) => {
            const r = await fetch(url, { headers: { rsc: '1' }, credentials: 'include' });
            return await r.text();
          }, rscUrl);
          const m = String(rscText || '').match(/"balance"\s*:\s*(\d+)/);
          if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n > 0) return n;
          }
        } catch { /* try next candidate / fall through to DOM selectors */ }
      }
      for (const sel of selectors) {
        const loc = page.locator(sel).first();
        if (await loc.count() === 0) continue;
        const text = await loc.innerText({ timeout: 5000 }).catch(() => '');
        const n = parseInt(String(text).replace(/[^\d]/g, ''), 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
      // Text-driven fallback (#110): the redesigned dashboard has an
      // "Available points" label above a number card, same label text as
      // the legacy UI. Locate the label element and walk up until we find
      // a container that also holds a number; extract that number. Works
      // on both old and new UIs because the label text is stable across
      // the redesign (Dr4w's screenshot confirms the exact "Available
      // points" wording). Locale-limited to English for now — matching
      // the existing selectors' locale coverage; localized variants can
      // be added as needed once we see them in diagnostics.
      const textDriven = await page.evaluate(() => {
        const labels = ['Available points', 'Available Points'];
        for (const label of labels) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if ((node.textContent || '').trim() !== label) continue;
            // Walk up ancestors looking for a container that has a
            // numeric-only text descendant nearby (not counting the
            // label itself).
            let el = node.parentElement;
            for (let depth = 0; depth < 6 && el; depth++, el = el.parentElement) {
              const numMatches = Array.from(el.querySelectorAll('*'))
                .map(n => (n.textContent || '').trim())
                .filter(t => /^\d{1,3}(,\d{3})*$|^\d+$/.test(t))
                .map(t => parseInt(t.replace(/,/g, ''), 10))
                .filter(n => Number.isFinite(n) && n > 0);
              if (numMatches.length) return numMatches[0];
            }
          }
        }
        return null;
      }).catch(() => null);
      if (textDriven && textDriven > 0) {
        log.info(`readPointsBalance: matched via "Available points" text-driven fallback (${textDriven})`);
        return textDriven;
      }
      if (attempt === 1) {
        log.info('readPointsBalance: counter not found on first load; retrying after 5s');
        await delay(5000);
      } else {
        // Final-attempt diagnostic dump on miss — modeled on the
        // AliExpress detector pattern (#72 → #75). Captures top-of-
        // DOM structure so future triage doesn't need a live noVNC
        // session to see what MS rendered. Bounded to 1500 chars
        // total to fit comfortably inside the 6000-char stack cap
        // in _recordDiagnosticError.
        try {
          const snapshot = await page.evaluate(() => {
            const grab = (sel, max = 6) => Array.from(document.querySelectorAll(sel))
              .slice(0, max).map(el => (el.textContent || '').trim().slice(0, 80)).filter(Boolean);
            const grabAttr = (sel, attr, max = 6) => Array.from(document.querySelectorAll(sel))
              .slice(0, max).map(el => (el.getAttribute(attr) || '').trim().slice(0, 80)).filter(Boolean);
            return {
              url: location.href,
              title: document.title.slice(0, 120),
              h1: grab('h1'),
              h2: grab('h2'),
              ariaLabels: grabAttr('[aria-label]', 'aria-label', 12),
              digitTexts: Array.from(document.querySelectorAll('span, div, h1, h2, h3'))
                .map(el => (el.textContent || '').trim())
                .filter(t => /^\d{1,6}$/.test(t))
                .slice(0, 8),
            };
          });
          console.error('MS Rewards readPointsBalance diagnostic dump (none of the counter selectors matched):');
          console.error(JSON.stringify(snapshot, null, 2).slice(0, 1500));
        } catch (e) { console.error(`(diagnostic dump failed: ${e.message})`); }
      }
    } catch (e) {
      const first = String(e?.message || e).split('\n')[0];
      if (attempt === 1) {
        log.info(`readPointsBalance: ${first} — retrying once`);
        await delay(5000);
      } else {
        log.warn(`readPointsBalance: ${first}`);
      }
    }
  }
  return null;
}

// Microsoft's dashboard sometimes shows a blocking modal (#popUpModal) that
// intercepts pointer events and makes card clicks time out. Angular renders
// several #popUpModal templates (streak-protection promo, discontinue banner,
// autoredeem warning, etc.) — only one is visible at a time and the rest
// carry .ng-hide. Selecting :not(.ng-hide) targets the active one; .first()
// alone would have picked a hidden template and silently no-op'd, which is
// exactly what was happening when every card click timed out.
async function dismissDashboardPopup(page) {
  const modal = page.locator('#popUpModal:not(.ng-hide)').first();
  if (!(await modal.isVisible().catch(() => false))) return false;
  const close = modal.locator(
    '.dashboardPopUpModalCloseCross, ' +
    'button[aria-label*="lose" i], button[aria-label*="ismiss" i], ' +
    '[role="button"][aria-label*="lose" i], ' +
    '.closeIcon, [class*="lose" i][role="button"]'
  ).first();
  if (await close.count()) {
    await close.click({ timeout: 2000 }).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await modal.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  return true;
}

// MS Rewards shows a separate "Claim your N bonus points before they start
// expiring on <date>" banner at the top of the dashboard, distinct from the
// daily activity cards. It uses a custom element <mee-rewards-pointclaim-
// banner> with its own Claim button — the activity-card scraper above
// (`mee-card:has(.mee-icon-AddMedium)`) doesn't match it, so before this
// fix those points sat unclaimed until they actually expired.
// Patterns that should NOT crash an MS run — they're either transient
// network blips (chrome-error redirect interception, ERR_*-class DNS /
// connectivity failures, navigation aborted mid-flight) or the browser
// tearing down between steps. Each MS sub-pass (activity cards, bonus
// banner, ready-to-claim card) handles its own goto failures via this
// helper so one step's transient doesn't kill the search loop or the
// mobile session that follow. Reports that drove this list: #67 OFABLE,
// #80 Rick45 (page closed), #100 TheDevRo (chrome-error interruption).
function isRecoverableMsNavError(err) {
  const msg = String(err?.message || err);
  return /Target page, context or browser has been closed/i.test(msg)
      || /interrupted by another navigation/i.test(msg)
      || /ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_TIMED_OUT/i.test(msg);
}

async function claimPendingBonusPoints(page) {
  // Defensive guard: between the preceding clickEveryPendingActivityCard()
  // and this navigation, the browser context or tab can die — either
  // because an activity-card click triggered a tab close, MS issued a
  // forced sign-out, the container ran out of memory, or anything else
  // that tears down Chromium mid-run. Bonus points are a side feature,
  // not the main reward flow; degrade gracefully so the search loop and
  // mobile session still run. (#67 OFABLE, #80 Rick45.)
  if (page.isClosed()) {
    log.info('claimPendingBonusPoints: page already closed, skipping bonus-points pass');
    return;
  }
  try {
    await page.goto(BING_REWARDS_URL, { waitUntil: 'load' });
  } catch (e) {
    if (isRecoverableMsNavError(e)) {
      log.info(`claimPendingBonusPoints: ${String(e.message || e).split('\n')[0]} — skipping bonus-points pass`);
      return;
    }
    throw e;
  }
  await dismissDashboardPopup(page);
  const banner = page.locator('mee-rewards-pointclaim-banner').first();
  try {
    await banner.waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    log.info('No pending point-claim banner.');
    return;
  }
  let title = '';
  try { title = (await banner.locator('.title').first().innerText()).trim(); } catch {}
  if (title) log.info(`Point-claim banner: "${title}"`);
  const claimBtn = banner.locator('button[aria-label="Claim"]').first();
  try {
    await claimBtn.click({ timeout: 5000 });
    log.info('Clicked Claim — bonus points credited to balance.');
    // Brief settle so the banner can disappear before subsequent navigation.
    await page.waitForTimeout(2000);
  } catch (e) {
    log.warn(`Claim button click failed: ${e.message.split('\n')[0]}`);
  }
}

// The post-2026 dashboard surfaces pending bonus points as a "Ready to
// claim" card in the top-bar (next to the "Available points" card) rather
// than the legacy mee-rewards-pointclaim-banner that claimPendingBonusPoints
// above handles. The card has a small SVG arrow with text "Claim" — clicking
// it opens a modal whose CTA is "Claim points". Found by kevindevm in
// https://github.com/feldorn/free-games-claimer/issues/99 — the same user
// who found the RSC-stream balance trick (v2.8.40, #71).
//
// Defensive: wrapped in try/catch so a layout drift or missing card returns
// quietly. The legacy banner path stays in place; this just adds coverage
// for the new surface. No-op if no "Ready to claim" SVG appears.
async function claimReadyToClaimCard(page) {
  if (page.isClosed()) {
    log.info('claimReadyToClaimCard: page already closed, skipping');
    return;
  }
  try {
    // Structure-based trigger + zero-guard (JLMael's #110 follow-up,
    // 2026-07-07): the "Ready to claim" CTA carries a `.bg-statusDangerBg`
    // red status dot ONLY when there are actually claimable points.
    // Absent → nothing to claim, return cleanly (avoids the previous
    // 10s spurious-modal-open + waitForSelector timeout on empty-claim
    // runs). Also locale-portable: the previous SVG+text walk keyed
    // off the string "Claim" and silently no-op'd on French sessions
    // where the label reads "Réclamer" — MS renders the dashboard in
    // EN or FR per session ignoring --accept-lang, so text filters
    // break on FR accounts even with our locale flags.
    const claimTrigger = page.locator('button:has(.bg-statusDangerBg)').first();
    if (await claimTrigger.count() === 0) {
      return; // nothing pending — no red dot, no CTA
    }
    await claimTrigger.click({ timeout: 5000 });
    // Modal CTA — EN + FR variants observed. If MS surfaces additional
    // locales the reporter didn't see, they'll show up as a "skipping"
    // log line and we can extend.
    const claimBtn = page.locator(
      'button:has-text("Claim points"), ' +
      'button:has-text("Réclamer les points"), ' +
      'button:has-text("Réclamer")'
    ).first();
    await claimBtn.waitFor({ state: 'visible', timeout: 10000 });
    await claimBtn.click({ timeout: 5000 });
    log.info('Clicked "Ready to claim" card — bonus points credited.');
    await page.waitForTimeout(2000);
  } catch (e) {
    log.info(`claimReadyToClaimCard: ${e.message?.split('\n')[0] || e} — skipping`);
  }
}

// Detect the redesigned MS Rewards dashboard UI (Dr4w's #110). The
// redesign moves activity cards out of AngularJS `mee-card` elements
// into two Tailwind-styled containers on separate pages: `#dailyset`
// on /dashboard and `#exploreonbing` on /earn. Presence of either
// container ID is a reliable signal that we're on the new UI.
async function isNewMsUi(page) {
  try {
    return (await page.locator('#dailyset, #exploreonbing').count()) > 0;
  } catch { return false; }
}

// Attempt to expand a collapsed section on the new UI. Per mzernetsch's
// #110 follow-up (2026-07-06): (a) the previous `[aria-expanded="false"]`
// approach picked the section's *info* button instead of the collapse
// toggle, which opened a modal that then intercepted every subsequent
// click — total regression. (b) The section toggle's own aria-expanded
// state is buggy on MS's side (always false), so we can't key off it
// even on the right element. (c) The correct signal is the SVG chevron
// class `.rotate-180` — present when the section is open (chevron up),
// absent when closed (chevron down). Target the toggle by its
// section-name aria-label and check that its subtree lacks `.rotate-180`.
// mzernetsch also observed that card clicks fire through to Bing even
// when the section is collapsed, so this expansion is a best-effort
// UX-nicety + defensive step, not a functional prerequisite.
async function expandNewMsUiSection(page, ariaLabel) {
  try {
    const sel = `[aria-label="${ariaLabel}"]:not(:has(.rotate-180))`;
    const loc = page.locator(sel).first();
    if (await loc.count() === 0) return; // already open, or toggle not present
    await loc.click({ timeout: 3000 });
    await page.waitForTimeout(600); // let the transition settle
  } catch { /* section may already be open or use a different toggle shape */ }
}

// Click every pending activity card on the redesigned MS Rewards UI
// (Dr4w's #110). Cards live in two containers across two pages:
// `#dailyset` on /dashboard and `#exploreonbing` on /earn. Each card
// is an `<a>` element that opens a Bing search in a new tab. Filter:
// cards whose visible text includes "Completed" are already done —
// skip. Grayscale-styled cards inside `#exploreonbing` are locked
// (mzernetsch's observation) — skip them via the :not(:has(.grayscale))
// selector suffix. The "Keep earning" bonus section that sometimes
// appears on /earn is caught via the same #exploreonbing container
// per mzernetsch's follow-up.
async function clickNewUiActivityCards(page) {
  // Completed-card filter is structural, not text-based: the redesigned
  // dashboard renders the green "10 points earned" chip on completed
  // cards via the class `.bg-statusSuccessRewardsBg` regardless of
  // locale. The previous text filter (`/\bCompleted\b/i`) failed on
  // French accounts where the badge reads "Terminé" — completed cards
  // then got re-clicked, which is exactly the kind of behaviour that
  // trips MS's "unusual activity" gate. Class-based lookup is
  // locale-portable. (JLMael's #110 follow-up, 2026-07-07.)
  const pages = [
    { url: BING_REWARDS_URL + '/dashboard', label: 'dailyset',      ariaLabel: 'Daily set',       selector: '#dailyset a:not([href$="/earn"]):not(:has(.bg-statusSuccessRewardsBg))' },
    { url: BING_REWARDS_URL + '/earn',      label: 'exploreonbing', ariaLabel: 'Explore on Bing', selector: '#exploreonbing a:not(:has(.grayscale)):not(:has(.bg-statusSuccessRewardsBg))' },
  ];
  let attempted = 0, clicked = 0, errors = 0;
  for (const { url, label, ariaLabel, selector } of pages) {
    if (page.isClosed()) break;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      if (isRecoverableMsNavError(e)) {
        log.info(`New-UI activity cards: goto ${url} — ${String(e.message || e).split('\n')[0]} — skipping this page`);
        continue;
      }
      throw e;
    }
    await delay(2000);
    await dismissDashboardPopup(page);
    await expandNewMsUiSection(page, ariaLabel);
    const cards = await page.locator(selector).elementHandles();
    log.info(`New-UI activity cards on ${label}: ${cards.length} pending candidate(s)`);
    for (let i = 0; i < cards.length; i++) {
      if (page.isClosed()) break;
      attempted++;
      try {
        await cards[i].click({ timeout: 15000 });
        clicked++;
        const ms = randomMs(15);
        log.info(`Card #${i + 1} clicked on ${label}. Sleeping ${(ms / 1000).toFixed(1)}s before next.`);
        await delay(ms);
      } catch (e) {
        // Popup interception is the common cause — dismiss and try once more.
        const dismissed = await dismissDashboardPopup(page);
        try {
          await cards[i].click({ timeout: 10000 });
          clicked++;
          if (dismissed) log.info(`Card #${i + 1} on ${label}: popup dismissed, retry succeeded.`);
          else log.info(`Card #${i + 1} on ${label}: retry succeeded.`);
          await delay(randomMs(15));
        } catch (e2) {
          errors++;
          log.warn(`Card #${i + 1} on ${label} click failed: ${e2.message.split('\n')[0]}`);
        }
      }
    }
  }
  log.info(`New-UI activity cards summary: attempted=${attempted} clicked=${clicked} errors=${errors}`);
}

async function clickEveryPendingActivityCard(page) {
  // Same defensive shape as claimPendingBonusPoints — a transient at the
  // initial dashboard goto (chrome-error redirect, DNS blip, browser
  // teardown) used to crash the desktop session, which propagated out
  // and skipped the search loop AND the mobile session that follow.
  // The activity-card pass is a small extra; the search loop is the
  // main reward path, so it must not die for a transient here.
  // (#100 TheDevRo: chrome-error://chromewebdata/ navigation interrupt.)
  if (page.isClosed()) {
    log.info('clickEveryPendingActivityCard: page already closed, skipping activity-card pass');
    return;
  }
  try {
    await page.goto(BING_REWARDS_URL, { waitUntil: 'load' });
  } catch (e) {
    if (isRecoverableMsNavError(e)) {
      log.info(`clickEveryPendingActivityCard: ${String(e.message || e).split('\n')[0]} — skipping activity-card pass`);
      return;
    }
    throw e;
  }
  await dismissDashboardPopup(page);
  // New-UI dispatch (Dr4w's #110): if the redesigned dashboard is
  // detected, use the redesigned selectors + dual-page walk. Old-UI
  // flow below stays intact for accounts still on the legacy layout
  // (my own account, probed 2026-07-03, still on the legacy UI).
  if (await isNewMsUi(page)) {
    log.info('clickEveryPendingActivityCard: detected redesigned dashboard UI (#dailyset/#exploreonbing) — using new-UI selectors');
    await clickNewUiActivityCards(page);
    return;
  }
  const cards = await page.locator(BING_REWARDS_ACTIVITY_CARD_SELECTOR).elementHandles();
  log.info(`Clicking pending activity cards (${cards.length} found)`);
  let savedDiag = false;
  for (let i = 0; i < cards.length; i++) {
    let clicked = false;
    try {
      await cards[i].click({ timeout: 15000 });
      clicked = true;
    } catch (e) {
      // Popup may have appeared between cards — dismiss and retry once.
      const dismissed = await dismissDashboardPopup(page);
      try {
        await cards[i].click({ timeout: 15000 });
        clicked = true;
        if (dismissed) log.info(`Card #${i + 1}: popup dismissed, retry succeeded.`);
        else log.info(`Card #${i + 1}: retry succeeded.`);
      } catch (e2) {
        log.warn(`Card #${i + 1} click failed: ${e2.message.split('\n')[0]}`);
        if (!savedDiag) {
          savedDiag = true;
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const base = `ms-card-fail-${ts}`;
          // Diagnostic artefacts go in their own subfolder so they don't
          // clutter the data root alongside the per-service JSON DBs
          // (issue #15). mkdirSync is recursive and idempotent.
          const diagDir = dataDir('diagnostics/microsoft');
          try {
            mkdirSync(diagDir, { recursive: true });
            await page.screenshot({ path: `${diagDir}/${base}.png`, fullPage: true });
            writeFileSync(`${diagDir}/${base}.html`, await page.content());
            log.warn(`Saved diagnostic: data/diagnostics/microsoft/${base}.{png,html}`);
          } catch (diagErr) {
            log.warn(`Failed to save diagnostic: ${diagErr.message.split('\n')[0]}`);
          }
        }
        continue;
      }
    }
    if (!clicked) continue;
    const isLast = i === cards.length - 1;
    if (isLast) {
      log.info(`Card #${i + 1} done.`);
    } else {
      // Sleep is announced before it happens — refers to the upcoming pause
      // between this card and the next click, not a sleep already completed.
      const ms = randomMs(15);
      log.info(`Card #${i + 1} done. Clicking card #${i + 2}. Will sleep ${(ms / 1000).toFixed(1)}s.`);
      await delay(ms);
    }
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
  // ~30% of the time, click an organic result and dwell on it. Humans
  // who search almost always click *something*; a session that only
  // ever searches-and-leaves is one of the strongest behavioral signals
  // behind MS Rewards' "Unusual search activity may limit your ability
  // to earn points" banner — it fires even on clean residential IPs
  // with human-like timing. The click registers engagement via Bing's
  // own click tracking; the destination navigation is incidental (the
  // next search re-navigates to bing.com regardless). Best-effort: a
  // missing/odd result must never break the search loop, so the whole
  // block is wrapped and swallowed.
  if (Math.random() < 0.3) {
    try {
      const results = page.locator('#b_results .b_algo h2 a');
      const n = await results.count();
      if (n > 0) {
        // Bias toward the top results, where humans actually click.
        const pick = Math.floor(Math.random() * Math.min(n, 5));
        await results.nth(pick).click({ timeout: 5000 });
        // Dwell like a human reading the page (2.5–6.5s), occasionally scroll.
        await delay(2500 + Math.floor(Math.random() * 4000));
        if (Math.random() < 0.5) {
          await page.mouse.wheel(0, 200 + Math.floor(Math.random() * 600));
          await delay(800 + Math.floor(Math.random() * 1500));
        }
      }
    } catch { /* result-click is best-effort engagement — never fatal */ }
  }
}

// A "browser closed" / "context closed" Playwright error means the
// underlying Chromium process is gone (user closed the window in VNC,
// container OOM-killed it, etc.). No amount of retry will recover —
// throw to the caller so the session block can log a clean failure
// and the run summary still emits, instead of spamming 30+ identical
// retry lines for every remaining search. #32.
function isFatalBrowserError(e) {
  const msg = String((e && e.message) || e || '');
  return /target page, context or browser has been closed|browser has been closed|target closed/i.test(msg);
}

async function executeBingSearches(page, searchTerms) {
  const maxDelay = cfg.ms_search_delay_max;
  const initMs = randomMs(maxDelay);
  log.info(`Executing ${searchTerms.length} Bing searches. Sleeping ${(initMs / 1000).toFixed(1)}s before first search.`);
  await delay(initMs);
  for (let i = 0; i < searchTerms.length; i++) {
    const term = searchTerms[i];
    const preEnterMs = randomMs(10);
    const isLast = i === searchTerms.length - 1;
    const interMs = isLast ? 0 : randomMs(maxDelay);
    let ok = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await executeBingSearch(page, term, preEnterMs);
        ok = true;
        break;
      } catch (e) {
        const msg = e.message.split('\n')[0];
        if (isFatalBrowserError(e)) {
          log.fail(`Browser closed mid-run — aborting remaining searches. ${msg}`);
          throw e;
        }
        if (attempt < 3) {
          log.warn(`Search #${i + 1} attempt ${attempt} failed; retrying. ${msg}`);
        } else {
          log.warn(`Search #${i + 1} failed after 3 attempts: ${msg}`);
        }
      }
    }
    if (!ok) continue;
    if (isLast) {
      log.info(`Search #${i + 1} done: "${term}".`);
    } else {
      // "Will sleep" announces the upcoming inter-search pause before the
      // next query, not a delay already completed.
      log.info(`Search #${i + 1} done: "${term}". Will sleep ${(interMs / 1000).toFixed(1)}s.`);
      await delay(interMs);
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

// Vary search counts slightly each run to avoid a fixed daily pattern
// Per-session search counts are configurable via cfg.ms_desktop_search_count
// and cfg.ms_mobile_search_count (defaults 35 / 25 — the previously-hardcoded
// midpoints). A ±2 random jitter is applied around the configured center to
// keep the actual count human-varying: consistent counts day-after-day are a
// bot tell. driftin8ez's #83.
const _jitter = () => Math.floor(Math.random() * 5) - 2; // -2..+2
const desktopSearchCount = Math.max(1, (cfg.ms_desktop_search_count || 35) + _jitter());
const mobileSearchCount  = Math.max(1, (cfg.ms_mobile_search_count  || 25) + _jitter());
const searchTerms = await buildSearchList(desktopSearchCount + mobileSearchCount);

// Per-run point balance history used by the web panel's Stats tab.
const msDb = await jsonDb('microsoft-rewards.json', { runs: [] });
async function recordMsRun(session, startedAt, before, after) {
  if (before == null && after == null) return;
  msDb.data.runs.push({
    at: startedAt,
    session,
    before,
    after,
    earned: (before != null && after != null) ? (after - before) : null,
  });
  // Cap retention at 500 runs so the file can't grow unbounded.
  if (msDb.data.runs.length > 500) msDb.data.runs = msDb.data.runs.slice(-500);
  try { await msDb.write(); }
  catch (e) { log.warn(`ms stats write failed: ${e.message}`); }
}

// Per-session before/after captured at outer scope so the end-of-run
// notify can stitch a rich summary (`+X desktop, +Y mobile, balance Z`).
// nulls survive cleanly: a session that failed login leaves both before
// and after as null and gets dropped from the message.
let desktopBefore = null, desktopAfter = null;
let mobileBefore = null, mobileAfter = null;

// Desktop session
log.section('Desktop');
{
  const { context, page } = await createContext(false);
  activeContext = context;
  const startedAt = datetime();
  let before = null, after = null;
  try {
    let loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      await login(page);
      loggedIn = await isLoggedIn(page);
    }
    if (loggedIn) {
      log.status('Signed in', 'yes');
      before = await readPointsBalance(page);
      if (before != null) log.status('Points before', before);
      await clickEveryPendingActivityCard(page);
      await claimPendingBonusPoints(page);
      await claimReadyToClaimCard(page);
      await executeBingSearches(page, searchTerms.slice(0, desktopSearchCount));
      after = await readPointsBalance(page);
      if (after != null) log.status('Points after', after + (before != null ? ` (+${after - before})` : ''));
      log.summary({
        siteId: 'microsoft',
        claimed: 0,
        skipped: 0,
        display: 'pointsEarned',
        pointsEarned: (before != null && after != null) ? Math.max(0, after - before) : 0,
      });
    } else {
      log.fail('Login failed or timed out — skipping desktop session');
    }
  } finally {
    await context.close();
    activeContext = null;
  }
  desktopBefore = before;
  desktopAfter = after;
  await recordMsRun('desktop', startedAt, before, after);
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
  const startedAt = datetime();
  let before = null, after = null;
  try {
    let loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      await login(page);
      loggedIn = await isLoggedIn(page);
    }
    if (loggedIn) {
      log.status('Signed in', 'yes');
      before = await readPointsBalance(page);
      if (before != null) log.status('Points before', before);
      await clickEveryPendingActivityCard(page);
      await claimPendingBonusPoints(page);
      await claimReadyToClaimCard(page);
      await executeBingSearches(page, searchTerms.slice(-mobileSearchCount));
      after = await readPointsBalance(page);
      if (after != null) log.status('Points after', after + (before != null ? ` (+${after - before})` : ''));
      log.summary({
        siteId: 'microsoft-mobile',
        claimed: 0,
        skipped: 0,
        display: 'pointsEarned',
        pointsEarned: (before != null && after != null) ? Math.max(0, after - before) : 0,
      });
    } else {
      log.fail('Login failed or timed out — skipping mobile session');
    }
  } finally {
    await context.close();
    activeContext = null;
  }
  mobileBefore = before;
  mobileAfter = after;
  await recordMsRun('mobile', startedAt, before, after);
}

// Build a rich end-of-run summary from the captured before/after pairs.
// Falls back to the legacy generic line when neither session produced
// any balance reads (login failures, page never loaded, etc.) so we still
// confirm the run finished — just without earnings data.
{
  const fmt = n => Number(n).toLocaleString('en-US');
  const desktopEarned = (desktopBefore != null && desktopAfter != null) ? Math.max(0, desktopAfter - desktopBefore) : null;
  const mobileEarned  = (mobileBefore  != null && mobileAfter  != null) ? Math.max(0, mobileAfter  - mobileBefore ) : null;
  const balance = mobileAfter != null ? mobileAfter
    : desktopAfter != null ? desktopAfter
    : null;
  const parts = [];
  if (desktopEarned != null) parts.push(`+${fmt(desktopEarned)} desktop`);
  if (mobileEarned  != null) parts.push(`+${fmt(mobileEarned)} mobile`);
  let summary;
  if (parts.length && balance != null) {
    summary = `Microsoft Rewards: ${parts.join(', ')}, balance ${fmt(balance)} pts`;
  } else if (parts.length) {
    summary = `Microsoft Rewards: ${parts.join(', ')}`;
  } else {
    summary = 'microsoft-rewards: completed desktop and mobile sessions (no points data captured).';
  }
  await notify(summary, { kind: 'summary' });
}

// Redeem reminder: re-fires every run while balance is over threshold so
// the user catches the morning restock window (limited daily stock for
// Amazon and similar third-party cards). Threshold + URL + label are all
// configurable so switching targets is a Settings change, not a code
// change. Pulls the latest balance from msDb.runs since both session
// blocks scope their `after` locally. Bare URL because Pushover strips
// HTML.
const redeemThreshold = cfg.ms_redeem_threshold;
if (redeemThreshold > 0) {
  const lastWithBalance = [...msDb.data.runs].reverse().find(r => r.after != null);
  const balance = lastWithBalance ? lastWithBalance.after : null;
  const fmt = n => Number(n).toLocaleString('en-US');
  if (balance != null && balance >= redeemThreshold) {
    log.info(`Balance ${fmt(balance)} >= threshold ${fmt(redeemThreshold)} — sending redeem reminder`);
    await notify(`Microsoft Rewards: ${fmt(balance)} pts available — redeem ${cfg.ms_redeem_label}: ${cfg.ms_redeem_url}`)
      .catch(e => log.warn(`Redeem reminder notify failed: ${e.message.split('\n')[0]}`));
  } else if (balance != null) {
    log.info(`Balance ${fmt(balance)} pts (under threshold ${fmt(redeemThreshold)})`);
  }
}

log.section('Done');
log.status('Time', datetime());
