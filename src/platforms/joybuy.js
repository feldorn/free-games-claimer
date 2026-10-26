// Opt-in service — the panel's runner only invokes this script when
// services.joybuy.active === true (Settings → Per-service → Joybuy).
// If you run it standalone on the CLI, it always executes; the activation
// gate lives in src/panel/panel.js.
import { datetime, prompt, jsonDb, awaitUserCaptchaSolve, getOrCreateFingerprint, log, notify } from '#src/util.js';
import { launchContext } from '#src/browser.js';
import { cfg } from '#src/config.js';
import { siteVersion } from '#src/sites.js';
import { FingerprintInjector } from 'fingerprint-injector';
import { FingerprintGenerator } from 'fingerprint-generator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Robust HTML / Next.js SSR hydration parser for Joybuy JoyPoints portal.
 * Extracts point balance, euro equivalence, check-in state, streak and tomorrow rewards.
 */
export function parseJoybuyHtml(html) {
  const res = {
    userPointsNum: null,
    totalEuro: null,
    checkInState: null,
    buttonText: null,
    streakDays: null,
    streak7: null,
    streak3: null,
    tomorrowPoints: null,
    isAlreadyDone: false,
    isClaimable: false,
  };

  if (!html || typeof html !== 'string') return res;

  // 1. Parse Next.js SSR hydration chunks (self.__next_f.push(...))
  const chunks = html.split('self.__next_f.push(');
  for (let i = 1; i < chunks.length; i++) {
    const raw = chunks[i];
    if (!raw.includes('currentPoints') && !raw.includes('checkInState') && !raw.includes('DailyCheckin') && !raw.includes('progress') && !raw.includes('jours')) continue;
    const unescaped = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

    // currentPoints (e.g. 315)
    const ptsMatch = unescaped.match(/"currentPoints":\s*(\d+)/);
    if (ptsMatch && res.userPointsNum == null) {
      res.userPointsNum = Number(ptsMatch[1]);
    }

    // shoppingValue (e.g. "3,15 €")
    const shopMatch = unescaped.match(/"shoppingValue":\s*"([^"]*€[^"]*)"/) ||
                      unescaped.match(/"shoppingValue":\s*"([0-9\s,.]+\s*€?)"/);
    if (shopMatch && (!res.totalEuro || !res.totalEuro.includes('€'))) {
      res.totalEuro = shopMatch[1].trim();
    }

    // buttonText (e.g. "Demain connexion +23 points")
    const btnMatch = unescaped.match(/"buttonText":\s*"([^"]+)"/);
    if (btnMatch && !res.buttonText) {
      res.buttonText = btnMatch[1].trim();
    }

    // checkInState: 1 = UNSIGNED (pending), 5 = SIGNED (already done)
    const stateMatch = unescaped.match(/"checkInState":\s*(\d+)/);
    if (stateMatch && res.checkInState == null) {
      res.checkInState = Number(stateMatch[1]);
      if (res.checkInState === 5) {
        res.isAlreadyDone = true;
      } else if (res.checkInState === 1) {
        res.isClaimable = true;
      }
    }

    // 7-day streak progress (e.g. "Série de 7 jours", pointsNum: 20, currentProgress: 7, totalProgress: 7)
    const streak7Match = unescaped.match(/"title":\s*(?:"S\\u00e9rie de 7 jours"|"Série de 7 jours")[^}]*"currentProgress":\s*(\d+)[^}]*"totalProgress":\s*(\d+)/);
    if (streak7Match) {
      res.streak7 = `${streak7Match[1]}/${streak7Match[2]}`;
      res.streakDays = Number(streak7Match[1]);
    }

    // 3-day series progress (e.g. "Total sur 3 jours", pointsNum: 10, currentProgress: 3, totalProgress: 3)
    const streak3Match = unescaped.match(/"title":\s*(?:"Total sur 3 jours")[^}]*"currentProgress":\s*(\d+)[^}]*"totalProgress":\s*(\d+)/);
    if (streak3Match) {
      res.streak3 = `${streak3Match[1]}/${streak3Match[2]}`;
    }

    // Tomorrow reward points
    const tmrwMatch = (res.buttonText || '').match(/Demain.*?\+\s*(\d+)/i) ||
                      unescaped.match(/"buttonText":\s*"Demain\s+connexion\s*\+\s*(\d+)/i);
    if (tmrwMatch && res.tomorrowPoints == null) {
      res.tomorrowPoints = Number(tmrwMatch[1]);
    }
  }

  // 2. DOM / Static HTML fallback regex in case SSR chunks are absent
  if (res.userPointsNum == null) {
    const ptsDomMatch = html.match(/class="[^"]*pointsValue[^"]*"[^>]*>\s*(\d+)/i) ||
                        html.match(/(\d+)\s*<span[^>]*class="[^"]*pointsUnit[^"]*"[^>]*>Pts/i);
    if (ptsDomMatch) res.userPointsNum = Number(ptsDomMatch[1]);
  }

  if (!res.totalEuro) {
    const euroDomMatch = html.match(/class="[^"]*value[^"]*"[^>]*>([0-9\s,.]+)\s*€/i) ||
                         html.match(/Équivalence[^<]*<\/span>\s*<span[^>]*>([0-9\s,.]+\s*€)/i);
    if (euroDomMatch) res.totalEuro = euroDomMatch[1].trim();
  }

  if (res.streakDays == null) {
    const streakDomMatch = html.match(/class="[^"]*progressText[^"]*"[^>]*>(\d+)\/(\d+)<\/span>/i);
    if (streakDomMatch) res.streakDays = Number(streakDomMatch[1]);
  }

  if ((!res.totalEuro || !res.totalEuro.includes('€')) && res.userPointsNum != null) {
    res.totalEuro = (res.userPointsNum / 100).toFixed(2).replace('.', ',') + ' €';
  }

  return res;
}

/**
 * Parse points or check-in data from targeted API JSON responses.
 */
export function extractFromApiJson(url = '', obj) {
  if (!obj || typeof obj !== 'object') return {};
  const res = {};

  // 1. Account info endpoint: color-api with functionId=user_account_get
  if (url.includes('user_account_get') || url.includes('user_account_info')) {
    const list = obj?.data?.accountList || obj?.accountList;
    if (Array.isArray(list)) {
      // type: 1 is JoyPoints balance
      const joyAccount = list.find(a => a && a.type === 1);
      if (joyAccount && typeof joyAccount.count === 'number') {
        res.userPointsNum = joyAccount.count;
      }
    }
  }

  // 2. Daily check-in submission endpoint: user_mission_daily_checkin
  if (url.includes('user_mission_daily_checkin')) {
    if ((obj?.code === '200' || obj?.code === 200) && (obj?.data?.result || obj?.result)) {
      res.collected = true;
    }
  }

  // 3. Missions overview endpoint
  if (url.includes('user_mission')) {
    if (obj?.data?.checkInState != null) {
      res.checkInState = Number(obj.data.checkInState);
    }
    if (obj?.data?.currentPoints != null) {
      res.userPointsNum = Number(obj.data.currentPoints);
    }
    if (obj?.data?.buttonText) {
      res.buttonText = String(obj.data.buttonText);
    }
  }

  // 4. Targeted fallback fields (avoiding generic "score: 0" from unrelated endpoints)
  const target = obj?.data || obj;
  if (target && typeof target === 'object') {
    if (target.currentPoints != null) res.userPointsNum = Number(target.currentPoints);
    else if (target.totalPoints != null) res.userPointsNum = Number(target.totalPoints);
    else if (target.pointBalance != null) res.userPointsNum = Number(target.pointBalance);
    else if (target.joyPoints != null) res.userPointsNum = Number(target.joyPoints);

    if (target.checkInState != null) res.checkInState = Number(target.checkInState);
    if (target.streakDays != null) res.streakDays = Number(target.streakDays);
    else if (target.continuousDays != null) res.streakDays = Number(target.continuousDays);
    if (target.tomorrowPoints != null) res.tomorrowPoints = Number(target.tomorrowPoints);
  }

  return res;
}

export function calcEuroEquivalent(points) {
  if (typeof points !== 'number' || Number.isNaN(points)) return null;
  return (points / 100).toFixed(2).replace('.', ',') + ' €';
}

export function calcEarnedPoints(currentBalance, previousBalance) {
  if (typeof currentBalance !== 'number' || typeof previousBalance !== 'number') return 0;
  return Math.max(0, currentBalance - previousBalance);
}

/**
 * Dismiss overlays, cookie consents, location switch modals and app download prompts.
 */
export const dismissModals = async (p) => {
  if (!p) return;
  // Cookie banner accept
  const cookieSelectors = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accepter")',
    'button:has-text("Tout accepter")',
    'button:has-text("Accept all")',
    'button:has-text("J\'accepte")',
    '[class*="cookie" i] button:has-text("Accepter")',
  ];
  for (const sel of cookieSelectors) {
    try {
      const btn = p.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ force: true });
        log.info('Accepted cookies banner');
        break;
      }
    } catch {}
  }

  // Location / region switcher or app prompts
  const overlaySelectors = [
    'button:has-text("Continuer sur le site")',
    'button:has-text("Rester")',
    'button:has-text("Non merci")',
    'button:has-text("Continuer")',
    '[aria-label="close" i]',
    '[aria-label="Fermer" i]',
    '[class*="close" i][role="button"]',
    'div[class*="dialog" i] [class*="close" i]',
    'div[class*="modal" i] [class*="close" i]',
  ];
  for (const sel of overlaySelectors) {
    try {
      const btn = p.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ force: true });
        log.info(`Dismissed modal overlay (${sel})`);
      }
    } catch {}
  }
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  log.section(`Joybuy (v${siteVersion('joybuy')})`);

  const db = await jsonDb('joybuy.json', { runs: [] });
  let userPointsNum = null;
  let balanceBefore = null;
  let earned = 0;
  let streakDays = null;
  let streak7 = null;
  let streak3 = null;
  let tomorrowPoints = null;
  let collected = false;
  let totalEuro = null;
  let checkInState = null;
  let buttonText = null;

  const profileDir = cfg.dir.browser + '-joybuy';
  const { fingerprint, headers, _persisted } = getOrCreateFingerprint(profileDir, () =>
    new FingerprintGenerator().getFingerprint({
      devices: ['mobile'],
      operatingSystems: ['android'],
    })
  );
  log.status('Fingerprint', _persisted ? 'loaded from cache' : 'fresh (saved for next run)');

  const { context, page } = await launchContext('joybuy', {
    profileDir,
    contextOptions: {
      userAgent: fingerprint.navigator.userAgent,
      viewport: {
        width: fingerprint.screen.width,
        height: fingerprint.screen.height,
      },
      extraHTTPHeaders: {
        'accept-language': headers['accept-language'] || 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    },
  });
  await new FingerprintInjector().attachFingerprintToPlaywright(context, { fingerprint, headers });

  context.setDefaultTimeout(cfg.debug ? 0 : cfg.timeout);

  // Intercept responses for points and check-in
  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('joybuy') && !url.includes('joy-sourcing') && !url.includes('jd.com')) return;
    try {
      const contentType = res.headers()['content-type'] || '';
      if (contentType.includes('application/json') || contentType.includes('text/plain') || url.includes('color-api')) {
        const json = await res.json().catch(() => null);
        if (json) {
          const parsedApi = extractFromApiJson(url, json);
          if (parsedApi.userPointsNum != null) userPointsNum = parsedApi.userPointsNum;
          if (parsedApi.collected) collected = true;
          if (parsedApi.checkInState != null) checkInState = parsedApi.checkInState;
          if (parsedApi.buttonText) buttonText = parsedApi.buttonText;
          if (parsedApi.streakDays != null) streakDays = parsedApi.streakDays;
          if (parsedApi.tomorrowPoints != null) tomorrowPoints = parsedApi.tomorrowPoints;
        }
      }
    } catch {}
  });

  const urls = {
    coins: cfg.joybuy_page_url || 'https://m.joybuy.fr/joypoints-h5?hideTitle=true&compatInput=true',
  };

  const auth = async url => {
    const QUICK_WAIT_MS = 8000;
    const MAX_RELOADS = 2;
    let alreadyLoggedIn = false;

    for (let attempt = 0; attempt <= MAX_RELOADS; attempt++) {
      if (attempt === 0) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
      } else {
        log.info(`Page stuck loading; reloading (attempt ${attempt}/${MAX_RELOADS})`);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }

      await dismissModals(page);

      if (page.url().includes('/login') || page.url().includes('/signin')) {
        alreadyLoggedIn = false;
        break;
      }

      const pageState = await page.evaluate(() => {
        const streamId = document.querySelector('meta[name="stream-page-id"]')?.getAttribute('content');
        const title = document.title || '';
        const hasPasswordInput = !!document.querySelector('input[type="password"]');
        const isLoginPage = /connectez-vous|sign[\s-]*in|log[\s-]*in/i.test(title) ||
                            streamId === 'NewLogin' ||
                            streamId === 'Login' ||
                            hasPasswordInput;

        const hasDailyBtn = !!document.querySelector('button[data-exp*="Daily_checkin_btn"], [class*="DailyCheckin_checkinBtn"], [class*="DailyCheckin"] button');
        const hasCheckedContent = !!document.querySelector('[class*="DailyCheckin_checkedContent"], [class*="checkedContent"]');
        const hasPointsValue = !!document.querySelector('[class*="pointsValue"], [class*="pointsUnit"]');

        let checkInState = null;
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          const text = s.textContent || '';
          if (text.includes('checkInState')) {
            const m = text.match(/"checkInState":\s*(\d+)/);
            if (m) { checkInState = Number(m[1]); break; }
          }
        }

        return { isLoginPage, hasDailyBtn, hasCheckedContent, hasPointsValue, checkInState };
      }).catch(() => null);

      if (pageState?.isLoginPage) {
        alreadyLoggedIn = false;
        break;
      }

      if (
        pageState?.checkInState === 1 ||
        pageState?.checkInState === 5 ||
        pageState?.hasDailyBtn ||
        pageState?.hasCheckedContent ||
        pageState?.hasPointsValue
      ) {
        alreadyLoggedIn = true;
        break;
      }

      const loginLocator = page.locator('input[type="password"], a[href*="/login"], a[href*="/signin"], button:has-text("Se connecter"), button:has-text("Connectez-vous")');
      const authLocator = page.locator('button[data-exp*="Daily_checkin_btn"], [class*="DailyCheckin_checkinBtn"], [class*="DailyCheckin_checkedContent"], [class*="pointsValue"], [class*="pointsUnit"]');

      const which = await Promise.any([
        loginLocator.first().waitFor({ state: 'visible', timeout: QUICK_WAIT_MS }).then(() => 'login'),
        authLocator.first().waitFor({ state: 'visible', timeout: QUICK_WAIT_MS }).then(() => 'auth'),
      ]).catch(() => null);

      if (which === 'auth') {
        alreadyLoggedIn = true;
        break;
      }
      if (which === 'login') {
        alreadyLoggedIn = false;
        break;
      }

      if (attempt === MAX_RELOADS) {
        alreadyLoggedIn = false;
        break;
      }
    }

    if (!alreadyLoggedIn) {
      log.warn('Not logged in to Joybuy! Will wait up to 120s for authentication in browser/terminal...');
      context.setDefaultTimeout(120 * 1000);

      const email = cfg.joybuy_email || cfg.email || await prompt({ message: 'Enter Joybuy email' });
      if (!email) {
        throw new Error(
          'Joybuy session expired and no JOYBUY_EMAIL configured. Either log in interactively via the Sessions card in the panel (or noVNC), or set JOYBUY_EMAIL + JOYBUY_PASSWORD in data/config.env.'
        );
      }

      const emailInput = page.locator('input[type="email"], input[name*="email" i], input[placeholder*="email" i], input[id*="email" i]').first();
      if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await emailInput.fill(email);
        await emailInput.blur();
      }

      const nextBtn = page.locator('button:has-text("Continuer"), button:has-text("Suivant"), button:has-text("Next"), button:has-text("Continue")').first();
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click({ force: true });
      }

      const password = cfg.joybuy_password || cfg.password || await prompt({ type: 'password', message: 'Enter Joybuy password' });
      if (password) {
        const pwdInput = page.locator('input[type="password"]').first();
        if (await pwdInput.isVisible({ timeout: 5000 }).catch(() => false)) {
          await pwdInput.fill(password);
          const submitBtn = page.locator('button:has-text("Se connecter"), button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]').first();
          if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await submitBtn.click({ force: true });
          }
        }
      }

      const captchaCheck = async () => {
        const hasFrame = page.frames().some(f => /captcha|security|verify|slider|punish/i.test(f.url() || ''));
        if (hasFrame) return true;
        return page.locator('text=/slide.*verify|drag.*slider|glisser.*vérifier/i').first().isVisible().catch(() => false);
      };

      if (await captchaCheck()) {
        const solved = await awaitUserCaptchaSolve(page, {
          service: 'joybuy',
          label: 'slider after login',
          captchaCheck,
        });
        if (!solved) {
          const e = new Error('Joybuy verification slider not completed within timeout');
          e.code = 'CAPTCHA_BLOCKED';
          throw e;
        }
      }

      if (!page.url().includes('joypoints')) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
      }

      context.setDefaultTimeout(cfg.debug ? 0 : cfg.timeout);
      log.ok('Logged in to Joybuy!');
    }
  };

  const coins = async () => {
    log.info('Collecting JoyPoints...');
    await dismissModals(page);

    // 1. Initial parse from SSR hydration / DOM
    let pageHtml = await page.content().catch(() => '');
    let parsed = parseJoybuyHtml(pageHtml);

    if (parsed.userPointsNum != null) {
      userPointsNum = parsed.userPointsNum;
      if (balanceBefore == null) balanceBefore = parsed.userPointsNum;
    }
    if (parsed.totalEuro) totalEuro = parsed.totalEuro;
    if (parsed.streakDays != null) streakDays = parsed.streakDays;
    if (parsed.streak7) streak7 = parsed.streak7;
    if (parsed.streak3) streak3 = parsed.streak3;
    if (parsed.tomorrowPoints != null) tomorrowPoints = parsed.tomorrowPoints;
    if (parsed.checkInState != null) checkInState = parsed.checkInState;
    if (parsed.buttonText) buttonText = parsed.buttonText;

    // 2. Locate the specific daily check-in button
    const checkInBtn = page.locator([
      'button[data-exp*="Daily_checkin_btn"]',
      'button[class*="DailyCheckin_checkinBtn"]',
      '[class*="DailyCheckin_checkinBtn"] button',
      'div[class*="DailyCheckin"] button',
      'button:has-text("connexion")',
      'button:has-text("Pointage")',
    ].join(', ')).first();

    let isBtnVisible = false;
    let currentBtnText = buttonText || '';

    try {
      isBtnVisible = await checkInBtn.isVisible({ timeout: 5000 }).catch(() => false);
      if (isBtnVisible) {
        const domText = (await checkInBtn.textContent().catch(() => '')) || '';
        if (domText.trim()) currentBtnText = domText.trim();
      }
    } catch {}

    // Check if the checkmark icon is rendered inside the button (rendered only when SIGNED)
    const hasCheckedContent = await page.locator('[class*="DailyCheckin_checkedContent"], [class*="checkedContent"]').first().isVisible({ timeout: 500 }).catch(() => false);
    const hasTomorrowText = /demain/i.test(currentBtnText) || /déjà|revenir/i.test(currentBtnText);
    const isSignedState = checkInState === 5 || parsed.isAlreadyDone;

    // A run is already signed if SSR state is SIGNED (5), button text says "Demain...", or checkmark icon is present
    const alreadySigned = isSignedState || hasTomorrowText || hasCheckedContent;

    if (alreadySigned) {
      collected = false;
      log.info(`Already checked in today! (${currentBtnText || 'Already checked in'})`);
    } else if (isBtnVisible || checkInState === 1 || parsed.isClaimable) {
      log.info(`Found claimable check-in button (${currentBtnText || 'Daily check-in'}), clicking...`);

      // Allow React hydration to complete if button is temporarily disabled on initial render
      try {
        await page.waitForFunction(() => {
          const btn = document.querySelector('button[data-exp*="Daily_checkin_btn"], [class*="DailyCheckin_checkinBtn"]');
          return btn && !btn.disabled && !btn.hasAttribute('disabled');
        }, { timeout: 4000 });
      } catch {}

      const checkinResponsePromise = page.waitForResponse(
        res => res.url().includes('user_mission_daily_checkin') && res.status() === 200,
        { timeout: 8000 }
      ).catch(() => null);

      try {
        await checkInBtn.click({ timeout: 5000 });
      } catch (clickErr) {
        log.warn(`Direct click warning: ${clickErr.message}, trying force click...`);
        await checkInBtn.click({ force: true }).catch(() => {});
      }

      const checkinRes = await checkinResponsePromise;
      if (checkinRes) {
        const checkinJson = await checkinRes.json().catch(() => null);
        if ((checkinJson?.code === '200' || checkinJson?.code === 200) && (checkinJson?.data?.result || checkinJson?.result)) {
          collected = true;
          log.ok('Daily check-in API returned success!');
        }
      }

      log.info('Refreshing page to update balance & streak counters...');
      // Small pause to allow backend database to commit the check-in transaction
      await page.waitForTimeout(2000);

      // Reload page to obtain fresh SSR state (updated points, streak counters, tomorrow reward)
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
        await dismissModals(page);
        await page.waitForTimeout(1000);
      } catch (reloadErr) {
        log.warn(`Page reload notice: ${reloadErr.message}; falling back to DOM/API extraction`);
      }

      // Re-read page content from the freshly loaded SSR payload
      pageHtml = await page.content().catch(() => '');
      parsed = parseJoybuyHtml(pageHtml);
      if (parsed.userPointsNum != null) userPointsNum = parsed.userPointsNum;
      if (parsed.totalEuro) totalEuro = parsed.totalEuro;
      if (parsed.streakDays != null) streakDays = parsed.streakDays;
      if (parsed.streak7) streak7 = parsed.streak7;
      if (parsed.streak3) streak3 = parsed.streak3;
      if (parsed.tomorrowPoints != null) tomorrowPoints = parsed.tomorrowPoints;
      if (parsed.checkInState === 5 || parsed.isAlreadyDone) {
        collected = true;
      }

      // Check-in success must be confirmed by API response or signed state after reload
      if (!collected && parsed.checkInState !== 5 && !parsed.isAlreadyDone) {
        throw new Error('Joybuy daily check-in was not confirmed after clicking check-in button (API did not return success and reloaded page is not in signed state)');
      }
      log.ok('Joybuy daily check-in confirmed!');
    } else {
      throw new Error('Joybuy check-in state could not be determined: neither claimable button nor signed state found');
    }

    // DOM fallbacks if values are still null
    if (userPointsNum == null) {
      try {
        const domPoints = await page.evaluate(() => {
          const el = document.querySelector('[class*="pointsValue"]');
          if (el) {
            const num = el.textContent.replace(/[^0-9]/g, '');
            if (num) return Number(num);
          }
          return null;
        });
        if (domPoints != null) userPointsNum = domPoints;
      } catch {}
    }

    // DOM fallbacks for streaks if missing
    if (streak7 == null || streak3 == null) {
      try {
        const domStreaks = await page.evaluate(() => {
          const blocks = Array.from(document.querySelectorAll('[class*="statBlock"], [class*="StatBlock"]'));
          const found = {};
          for (const b of blocks) {
            const title = b.querySelector('[class*="statTitle"], [class*="StatTitle"]')?.textContent || '';
            const progress = b.querySelector('[class*="progressText"], [class*="ProgressText"]')?.textContent || '';
            if (/7\s*jours/i.test(title) && progress) found.s7 = progress.trim();
            if (/3\s*jours/i.test(title) && progress) found.s3 = progress.trim();
          }
          return found;
        });
        if (domStreaks.s7 && !streak7) streak7 = domStreaks.s7;
        if (domStreaks.s3 && !streak3) streak3 = domStreaks.s3;
      } catch {}
    }

    if (streakDays == null && streak7) {
      const m = streak7.match(/(\d+)/);
      if (m) streakDays = Number(m[1]);
    } else if (streakDays == null && streak3) {
      const m = streak3.match(/(\d+)/);
      if (m) streakDays = Number(m[1]);
    }

    // DOM fallback for tomorrow reward if missing
    if (tomorrowPoints == null) {
      try {
        const domTmrw = await page.evaluate(() => {
          const btn = document.querySelector('button[data-exp*="Daily_checkin_btn"], [class*="DailyCheckin_checkinBtn"]');
          if (btn) {
            const m = btn.textContent.match(/Demain.*?\+\s*(\d+)/i);
            if (m) return Number(m[1]);
          }
          return null;
        });
        if (domTmrw != null) tomorrowPoints = domTmrw;
      } catch {}
    }

    if ((!totalEuro || !totalEuro.includes('€')) && userPointsNum != null) {
      totalEuro = calcEuroEquivalent(userPointsNum);
    }

    log.status('JoyPoints balance', userPointsNum != null ? userPointsNum : 'N/A');
    if (streakDays != null) {
      const streakDetails = [
        streak7 ? `7d: ${streak7}` : null,
        streak3 ? `3d: ${streak3}` : null,
      ].filter(Boolean).join(', ');
      log.status('Streak', `${streakDays} days${streakDetails ? ` (${streakDetails})` : ''}`);
    }
    if (tomorrowPoints != null) log.status('Tomorrow reward', `${tomorrowPoints} points`);
    if (totalEuro) log.status('Euro value', totalEuro);
  };

  async function recordRun() {
    if (userPointsNum == null && streakDays == null && !collected) return;
    const entry = {
      at: datetime(),
      balance: userPointsNum,
      streak: streakDays,
      streak7,
      streak3,
      tomorrow: tomorrowPoints,
      collected,
      totalEuro,
      earned,
    };

    db.data.runs.push(entry);
    if (db.data.runs.length > 500) db.data.runs = db.data.runs.slice(-500);

    try {
      await db.write();
    } catch (e) {
      log.warn(`joybuy: db.write failed: ${e.message}`);
    }
  }

  try {
    await auth(urls.coins);
    await coins();
    console.log();

    const prevRun = (db.data.runs || []).filter(r => typeof r.balance === 'number').slice(-1)[0];
    if (collected) {
      if (typeof balanceBefore === 'number' && typeof userPointsNum === 'number') {
        earned = calcEarnedPoints(userPointsNum, balanceBefore);
      } else if (prevRun && typeof userPointsNum === 'number' && typeof prevRun.balance === 'number') {
        earned = calcEarnedPoints(userPointsNum, prevRun.balance);
      } else {
        earned = 0;
      }
    } else {
      earned = 0;
    }

    log.summary({
      siteId: 'joybuy',
      claimed: 0,
      skipped: 0,
      display: 'pointsEarned',
      pointsEarned: earned,
      coins: userPointsNum || 0,
    });
  } catch (error) {
    process.exitCode ||= 1;
    log.exception(error);
    const msg = error && error.message ? error.message.split('\n')[0] : String(error);
    await notify(`Joybuy failed: ${msg}`, { kind: 'error' }).catch(() => {});
  }

  await recordRun();

  // End-of-run notification
  {
    const fmt = n => Number(n).toLocaleString('en-US');
    const parts = [];
    if (earned > 0) parts.push(`+${fmt(earned)} JoyPoints`);
    else if (collected) parts.push('daily JoyPoints collected');
    else if (typeof userPointsNum === 'number') parts.push('already collected today');

    if (typeof userPointsNum === 'number') parts.push(`balance: ${fmt(userPointsNum)} (${totalEuro || ''})`.trim());
    if (typeof streakDays === 'number') {
      const details = [streak7 ? `7d: ${streak7}` : null, streak3 ? `3d: ${streak3}` : null].filter(Boolean).join(' / ');
      parts.push(`streak: ${fmt(streakDays)} days${details ? ` [${details}]` : ''}`);
    }

    if (parts.length) {
      const tail = (typeof tomorrowPoints === 'number') ? ` (+${fmt(tomorrowPoints)} tomorrow)` : '';
      await notify(`Joybuy: ${parts.join(', ')}${tail}`, { kind: 'summary' })
        .catch(e => log.warn(`joybuy notify failed: ${e.message.split('\n')[0]}`));
    }
  }

  if (page.video()) log.info(`Recorded video: ${await page.video().path()}`);
  await context.close();
}
