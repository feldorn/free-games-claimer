import { chromium } from 'patchright';
// Import util.js before config.js: the two form a cycle (config.js needs
// dataDir from util.js; util.js reads cfg from config.js at module top-level).
// Since claim scripts now import this module first, util-first is the order
// that lets cfg finish initializing before util's top-level code runs it.
import { cleanProfileLocks, localeArgs, siteLocale, handleSIGINT, datetime, filenamify, log } from './util.js';
import { cfg } from './config.js';
import { SITES_BY_ID } from './sites.js'; // after config.js — sites.js reads cfg

// Shared browser-context factory. Every claim script used to repeat the same
// preamble verbatim — cleanProfileLocks + launchPersistentContext with the same
// headless/viewport/locale/timezone/SIGINT wiring and the same base Chromium
// args. That copy-paste is extracted here so the defaults live in one place.
//
// Behaviour-preserving by design: per-site differences (extra GPU args, custom
// profile dir, fingerprint/device overrides, recording) are passed in via
// options rather than baked in, so migrating a script does not change what it
// launches.

/**
 * Launch a persistent Chromium context with the shared scraper defaults.
 *
 * @param {string} siteId  site id — drives the per-site locale policy (siteLocale) and the default HAR filename.
 * @param {object} [opts]
 * @param {string} [opts.profileDir]  persistent profile directory (default: cfg.dir.browser).
 * @param {string} [opts.recordPrefix]  HAR filename prefix under data/record/ (default: siteId).
 * @param {boolean} [opts.record]  force recording on/off (default: cfg.record).
 * @param {string[]} [opts.extraArgs]  extra Chromium args appended after the base set.
 * @param {object} [opts.contextOptions]  extra launchPersistentContext options, merged last (e.g. userAgent, extraHTTPHeaders, device settings). Do not pass `args` here — use extraArgs.
 * @param {boolean} [opts.sigint]  register handleSIGINT(context) so Ctrl-C closes cleanly (default: true).
 * @returns {Promise<{ context: import('patchright').BrowserContext, page: import('patchright').Page }>}
 */
export async function launchContext(siteId, {
  profileDir = cfg.dir.browser,
  recordPrefix = siteId,
  record = cfg.record,
  extraArgs = [],
  contextOptions = {},
  sigint = true,
} = {}) {
  cleanProfileLocks(profileDir);
  const locale = siteLocale(siteId);
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: cfg.headless,
    viewport: { width: cfg.width, height: cfg.height },
    locale, // see siteLocale() for the per-site locale policy
    timezoneId: cfg.timezone_id,
    recordVideo: record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated
    recordHar: record ? { path: `data/record/${recordPrefix}-${filenamify(datetime())}.har` } : undefined, // network requests/responses, importable in Chrome devtools
    handleSIGINT: false, // handled ourselves via handleSIGINT(context) so recordings flush on Ctrl-C
    args: ['--hide-crash-restore-bubble', ...localeArgs(locale), ...extraArgs],
    ...contextOptions,
  });
  if (sigint) handleSIGINT(context);
  const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
  return { context, page };
}

/**
 * page.goto with retry. Loop/log/throw live here; the policy is injected per
 * call site, since "recoverable" and "worth waiting for" differ by site.
 * Use it for top-level navigations only — per-item gotos inside claim loops
 * shouldn't cost the rest of the batch a retry delay.
 *
 * @param {import('patchright').Page} page
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.attempts]  total attempts including the first (default 2).
 * @param {number|((attempt: number) => number)} [opts.backoffMs]  wait before each retry; 0 retries immediately (default 0).
 * @param {(err: Error) => boolean} [opts.isRecoverable]  false rethrows at once instead of spending an attempt (default: retry anything).
 * @param {object} [opts.gotoOpts]  passed to page.goto — a per-attempt `timeout` belongs here (default: { waitUntil: 'domcontentloaded' }).
 * @param {string} [opts.siteId]  registry id, supplies the default log label (SITES_BY_ID[siteId].name).
 * @param {string} [opts.label]  log label; wins over siteId. The URL is logged either way, so this is only for a name the registry doesn't carry.
 */
export async function gotoWithRetry(page, url, {
  attempts = 2,
  backoffMs = 0,
  isRecoverable = () => true,
  gotoOpts = { waitUntil: 'domcontentloaded' },
  siteId,
  label,
} = {}) {
  const name = label || (siteId && SITES_BY_ID[siteId]?.name) || url;
  // URL always in the log: a site's several top-level gotos share one policy
  // object, so the URL is what tells them apart when one fails.
  const target = name === url ? url : `${name} (${url})`;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await page.goto(url, gotoOpts);
      if (attempt > 1) log.info(`goto ${target} — ok on attempt ${attempt}/${attempts}`);
      return res;
    } catch (e) {
      // Rethrow the original error so the caller's catch keeps the real stack.
      if (attempt === attempts || !isRecoverable(e) || page.isClosed()) throw e;
      const wait = typeof backoffMs === 'function' ? backoffMs(attempt) : backoffMs;
      log.warn(`goto ${target} ${attempt}/${attempts}: ${String(e.message || e).split('\n')[0]}${wait ? ` — retry in ${wait / 1000}s` : ' — retrying'}`);
      if (wait) await page.waitForTimeout(wait);
    }
  }
}
