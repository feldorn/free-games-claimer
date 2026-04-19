import * as dotenv from 'dotenv';
import { dataDir } from './util.js';
import { describeConfig } from './app-config.js';

dotenv.config({ path: 'data/config.env', quiet: true }); // loads env vars from file - will not set vars that are already set, i.e., can overwrite values from file by prefixing, e.g., VAR=VAL node ...

// App config merged over env vars. Any setting listed in CONFIG_SCHEMA can be
// overridden at runtime via data/config.json (written by the Settings tab).
// Everything else (credentials, debug flags, infra paths) reads env directly
// as before.
const { effective } = describeConfig();
const sched = effective.scheduler || {};
const notif = effective.notifications || {};
const pnl   = effective.panel || {};
const adv   = effective.advanced || {};
const svc   = effective.services || {};
const pg    = svc['prime-gaming'] || {};
const eg    = svc['epic-games']   || {};
const gog   = svc['gog']          || {};
const steam = svc['steam']        || {};
const ae    = svc['aliexpress']   || {};

// Options - also see table in README.md
export const cfg = {
  debug: process.env.DEBUG == '1' || process.env.PWDEBUG == '1', // runs non-headless and opens https://playwright.dev/docs/inspector
  debug_network: process.env.DEBUG_NETWORK == '1', // log network requests and responses
  record: adv.record ?? false, // `recordHar` (network) + `recordVideo`
  time: process.env.TIME == '1', // log duration of each step
  interactive: process.env.INTERACTIVE == '1', // confirm to claim, enter to skip
  dryrun: adv.dryrun ?? false, // don't claim anything
  nowait: process.env.NOWAIT == '1', // fail fast instead of waiting for user input
  show: process.env.SHOW == '1', // run non-headless
  get headless() {
    return !this.debug && !this.show;
  },
  width: adv.width || 1920, // width of the opened browser
  height: adv.height || 1080, // height of the opened browser
  timeout: (adv.timeoutSec || 60) * 1000, // default timeout for playwright is 30s
  login_timeout: (adv.loginTimeoutSec || 180) * 1000, // higher timeout for login, will wait twice: prompt + wait for manual login
  login_mode: process.env.LOGIN_MODE == '1', // launch interactive VNC login panel instead of automated claiming
  novnc_port: process.env.NOVNC_PORT, // running in docker if set
  // Panel URL config — Radarr-style URLBase. Set BASE_PATH when serving the panel under
  // a reverse-proxy subfolder (e.g. BASE_PATH=/free-games for https://example.com/free-games/).
  // PUBLIC_URL is the full external URL used in notifications so the user can tap straight in.
  base_path: (process.env.BASE_PATH || '').replace(/^(?!$)(?!\/)/, '/').replace(/\/+$/, ''), // empty or "/leading-no-trailing"
  public_url: (pnl.publicUrl || '').replace(/\/+$/, ''),
  notify: notif.notify || undefined, // apprise notification services
  notify_title: notif.notifyTitle || undefined, // apprise notification title
  // scheduler (moved out of interactive-login.js so Settings can override)
  loop: sched.loopSeconds ?? 0,
  ms_schedule_hours: sched.msScheduleHours ?? 0,
  ms_schedule_start: sched.msScheduleStart ?? 8,
  get dir() { // avoids ReferenceError: Cannot access 'dataDir' before initialization
    return {
      browser: process.env.BROWSER_DIR || dataDir('browser'), // for multiple accounts or testing
      screenshots: process.env.SCREENSHOTS_DIR || dataDir('screenshots'), // set to 0 to disable screenshots
    };
  },
  // auth epic-games (credentials stay env-only)
  eg_email: process.env.EG_EMAIL || process.env.EMAIL,
  eg_password: process.env.EG_PASSWORD || process.env.PASSWORD,
  eg_otpkey: process.env.EG_OTPKEY,
  eg_parentalpin: process.env.EG_PARENTALPIN,
  eg_mobile: eg.claimMobile ?? true, // claim mobile games
  // auth prime-gaming
  pg_email: process.env.PG_EMAIL || process.env.EMAIL,
  pg_password: process.env.PG_PASSWORD || process.env.PASSWORD,
  pg_otpkey: process.env.PG_OTPKEY,
  // auth gog
  gog_email: process.env.GOG_EMAIL || process.env.EMAIL,
  gog_password: process.env.GOG_PASSWORD || process.env.PASSWORD,
  gog_newsletter: gog.keepNewsletter ?? false, // do not unsubscribe from newsletter after claiming a game
  // auth steam
  steam_email: process.env.STEAM_EMAIL || process.env.EMAIL,
  steam_password: process.env.STEAM_PASSWORD || process.env.PASSWORD,
  steam_min_rating: steam.minRating ?? 6, // minimum review rating on 1-9 scale (6 = Mostly Positive)
  steam_min_price: steam.minPrice ?? 10, // minimum original price in USD to filter out cheap/shovelware games
  // auth microsoft rewards
  ms_email: process.env.MS_EMAIL || process.env.EMAIL,
  ms_password: process.env.MS_PASSWORD || process.env.PASSWORD,
  ms_otpkey: process.env.MS_OTPKEY,
  // aliexpress — opt-in. Disabled by default; toggle in Settings → Per-service
  // → AliExpress (stores services.aliexpress.enabled in data/config.json).
  aliexpress_enabled: ae.enabled ?? false,
  ae_email:    process.env.AE_EMAIL    || process.env.EMAIL,
  ae_password: process.env.AE_PASSWORD || process.env.PASSWORD,
  // experimental
  pg_redeem: pg.redeem ?? false, // prime-gaming: redeem keys on external stores
  lg_email: process.env.LG_EMAIL || process.env.PG_EMAIL || process.env.EMAIL, // prime-gaming: external: legacy-games: email to use for redeeming
  pg_claimdlc: pg.claimDlc ?? false, // prime-gaming: claim in-game content
  // Preserve old NaN semantics when unset (comparisons always false → skip
  // filter disabled); a set null override also yields NaN.
  pg_timeLeft: pg.timeLeftDays != null ? Number(pg.timeLeftDays) : NaN,
};
