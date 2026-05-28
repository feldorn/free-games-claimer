// Lenovo Gaming Key Drops watcher.
//
// Scrapes https://gaming.lenovo.com/game-key-drops, extracts each drop's
// metadata, and for new/recently-changed drops descends into the embedded
// TickCounter widget on the detail page to capture the drop's absolute
// scheduled datetime. Diffs against data/lenovo-gaming-watch.json and
// fires immediate push notifications on:
//   - new drop discovered
//   - status transition (e.g. coming-soon → active = drop went live)
//   - restock detected (title contains "(Restocked!)")
//
// Pre-drop "1 hour before" / "5 minutes before" notifications come from
// the engine-side lenovoSchedulerLoop in interactive-login.js, which reads
// this same JSON file and wakes at the dynamic per-drop times. The watcher
// just keeps the file fresh.
//
// Why two-level fetch (listing + detail page): the listing card displays
// scheduled times in the user's *browser* TZ, which is unreliable from
// inside a docker container with possibly different TZ. The detail page
// embeds a TickCounter widget (https://www.tickcounter.com/) that exposes
// the absolute datetime in Eastern Time inside its iframe HTML — we
// descend into the frame, extract that ISO, convert to UTC, and store
// canonically. Listing-fetch is one HTTP round trip; detail fetches only
// run for drops that are new or whose schedule we don't have cached.

import { chromium } from 'patchright';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { datetime, notify, log, dataDir, handleSIGINT, cleanProfileLocks } from './src/util.js';
import { cfg } from './src/config.js';
import { siteVersion } from './src/sites.js';

handleSIGINT();
log.section(`Lenovo Gaming (v${siteVersion('lenovo-gaming')})`);

let _summaryStats = { siteId: 'lenovo-gaming', claimed: 0, skipped: 0, display: 'onPage', onPage: 0, new: 0 };
process.on('exit', code => {
  if (!code) log.summary(_summaryStats);
});

const URL_LISTING = 'https://gaming.lenovo.com/game-key-drops';
const STATE_FILE = dataDir('lenovo-gaming-watch.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return { drops: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { drops: {} }; }
}

function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { log.warn(`Failed to save Lenovo watch state: ${e.message.split('\n')[0]}`); }
}

// Convert a "wall-clock" ISO string like "2026-05-13T12:00:00" interpreted
// in America/New_York to a true UTC ISO string. Handles DST automatically
// via Intl.DateTimeFormat round-tripping.
function etToUtcIso(isoLocal) {
  if (!isoLocal) return null;
  const m = isoLocal.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss = '0'] = m;
  const utcGuess = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
  // Render utcGuess as wall-clock in America/New_York
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(utcGuess).map(p => [p.type, p.value]));
  // ET wall-clock components for utcGuess
  const etAsUtc = new Date(Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour === 24 ? 0 : +parts.hour,
    +parts.minute, +parts.second,
  ));
  // Offset between "treating input as UTC" and "what time would that be in ET"
  const offsetMs = utcGuess.getTime() - etAsUtc.getTime();
  // Real UTC moment = utcGuess + offset
  return new Date(utcGuess.getTime() + offsetMs).toISOString();
}

// Title prefix → status. Active drops have no prefix (or just "(Restocked!)"
// without a status word).
function statusFromTitle(title) {
  const t = title || '';
  if (/^\(Coming Soon\)/i.test(t)) return 'coming-soon';
  if (/^\(Postponed\)/i.test(t)) return 'postponed';
  if (/^\(Ended\)/i.test(t) || /^\(Expired\)/i.test(t)) return 'ended';
  return 'active';
}

let context, page;
try {
  cleanProfileLocks(cfg.dir.browser + '-lenovo');
  context = await chromium.launchPersistentContext(cfg.dir.browser + '-lenovo', {
    headless: false,
    viewport: { width: cfg.width, height: cfg.height },
    locale: 'en-US',
    args: ['--hide-crash-restore-bubble', '--no-sandbox', '--disable-gpu'],
  });
  page = context.pages()[0] || await context.newPage();
  context.setDefaultTimeout(cfg.debug ? 0 : cfg.timeout);

  log.status('Fetching', URL_LISTING);
  await page.goto(URL_LISTING, { waitUntil: 'domcontentloaded' });
  // Bettermode is JS-driven; the drop cards mount after first paint.
  await page.waitForTimeout(8000);

  // Collect raw drop records from listing. Match anchors that point at
  // /game-key-drops/post/<slug>-<id>; dedupe by id (some IDs have multiple
  // anchors on the page — hero banner + listing card with the same target).
  const rawDrops = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/game-key-drops/post/"]')) {
      const href = a.getAttribute('href') || '';
      const id = href.split('/').pop();
      if (!id || seen.has(id)) continue;
      // Walk up to the listing card to get the surrounding region/etc text.
      // The hero banner has shorter "Learn more" text — prefer the listing
      // card variant which has the full title + region. Heuristic: if the
      // anchor's own text is short (<10 chars) we'll skip it; the same drop
      // ID also has a long-text anchor in the listing.
      const aText = (a.textContent || '').trim();
      let card = a;
      for (let i = 0; i < 8 && card; i++) {
        if (card.classList && [...card.classList].some(c => c.includes('border-card'))) break;
        card = card.parentElement;
      }
      const cardText = card ? (card.textContent || '').trim().replace(/\s+/g, ' ') : '';
      const region = (cardText.match(/(Global(?:\s*\([^)]+\))?|US Only|EU Only|JP Only)/i) || [])[1] || null;
      out.push({ id, href, title: aText, cardText, region });
    }
    // Dedupe: prefer entries with longer titles
    const byId = new Map();
    for (const d of out) {
      const existing = byId.get(d.id);
      if (!existing || d.title.length > existing.title.length) byId.set(d.id, d);
    }
    return [...byId.values()];
  });

  log.status('Drops on listing', rawDrops.length);
  const state = loadState();
  state.drops = state.drops || {};

  let newDrops = 0;
  let statusTransitions = 0;
  let restocked = 0;
  const wentLive = [];
  const newlyDiscovered = [];

  for (const raw of rawDrops) {
    const status = statusFromTitle(raw.title);
    const isRestocked = /\(Restocked!?\)/i.test(raw.title);
    const url = raw.href.startsWith('http') ? raw.href : `https://gaming.lenovo.com${raw.href}`;

    const existing = state.drops[raw.id];
    const isNew = !existing;

    // Initialize a fresh record or reuse the existing one
    const drop = existing || {
      id: raw.id,
      title: raw.title,
      url,
      status,
      scheduledAt: null,
      scheduledAtRaw: null,
      widgetId: null,
      region: raw.region,
      isRestocked,
      discoveredAt: datetime(),
      lastSeenAt: datetime(),
      lastStatusChange: datetime(),
      userCollected: false,
      userCollectedAt: null,
      notifications: { discovered: null, '1h-before': null, '5min-before': null, wentLive: null, restocked: [] },
    };

    drop.lastSeenAt = datetime();
    drop.title = raw.title; // Lenovo edits titles when restocking; keep current
    drop.url = url;
    drop.region = raw.region || drop.region;

    // Detect transitions
    if (!isNew && drop.status !== status) {
      drop.lastStatusChange = datetime();
      statusTransitions++;
      if (drop.status !== 'active' && status === 'active') {
        wentLive.push(drop);
      }
    }
    drop.status = status;

    // Detect restock — title gained "(Restocked!)" between cycles
    if (!isNew && !drop.isRestocked && isRestocked) {
      drop.notifications.restocked.push(datetime());
      restocked++;
    }
    drop.isRestocked = isRestocked;

    if (isNew) {
      newDrops++;
      newlyDiscovered.push(drop);
    }

    // Skip detail-page fetch for ended/expired drops — the schedule is
    // historical, not actionable. Otherwise refetch only when:
    //   - we don't have a scheduledAt yet, OR
    //   - the drop is newly discovered / restocked, OR
    //   - this is a `coming-soon` drop whose stored scheduledAt is in
    //     the past — Lenovo bumped the drop date (postponement) and
    //     we'd otherwise display the stale "due now" countdown
    //     forever (issue: user reported a "coming soon" drop showing
    //     `Apr 15 · due now` when Lenovo had rescheduled to ~3 days out).
    //     For `active` drops a past scheduledAt is correct (drop went
    //     live and is still available) so we don't refetch those.
    const scheduledAtStale = drop.scheduledAt
      && status === 'coming-soon'
      && new Date(drop.scheduledAt).getTime() < Date.now();
    const needsDetail = status !== 'ended' && (!drop.scheduledAt || isNew || (isRestocked && !drop.notifications.restocked.length) || scheduledAtStale);
    if (needsDetail) {
      try {
        const detailPage = await context.newPage();
        try {
          await detailPage.goto(url, { waitUntil: 'domcontentloaded' });
          await detailPage.waitForTimeout(8000);
          const tcFrame = detailPage.frames().find(f => /tickcounter\.com\/widget\/countdown/.test(f.url()));
          if (tcFrame) {
            const widgetIdMatch = tcFrame.url().match(/\/countdown\/(\d+)/);
            const widgetId = widgetIdMatch ? widgetIdMatch[1] : null;
            const isoLocal = await tcFrame.evaluate(() => {
              const html = document.documentElement.outerHTML;
              const m = html.match(/(?:202\d-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
              return m ? m[0] : null;
            }).catch(() => null);
            if (isoLocal) {
              const newScheduledAt = etToUtcIso(isoLocal);
              const dateChanged = newScheduledAt && newScheduledAt !== drop.scheduledAt;
              drop.widgetId = widgetId;
              drop.scheduledAtRaw = isoLocal; // ET wall-clock
              drop.scheduledAt = newScheduledAt;
              // When Lenovo reschedules a drop (the date moves), reset the
              // per-drop wake flags so the 1h / 5min / at-drop pushes fire
              // against the NEW date. Without this, a drop whose wakes were
              // marked sent against an earlier date inherits those "done"
              // flags when the date is corrected, and the real drop-time
              // notification never goes out. 2.8.6 fixed the stale-date
              // refetch but not the flags: Heavy Rain pt.2 moved
              // Apr 15 -> May 27, its wakes were marked sent May 14 (as
              // ">5min late" against the stale date), and the corrected
              // May 27 drop then fired silently. Resetting on change makes
              // the next reschedule re-notify correctly.
              if (dateChanged && drop.notifications) {
                drop.notifications['1h-before'] = null;
                drop.notifications['5min-before'] = null;
                drop.notifications.wentLive = null;
                log.info(`${drop.title}: rescheduled to ${isoLocal} ET — reset wake notifications so they re-fire against the new date`);
              }
            }
          }
        } finally {
          await detailPage.close();
        }
      } catch (e) {
        log.warn(`${drop.title}: detail-page fetch failed — ${e.message.split('\n')[0]}`);
      }
    }

    state.drops[raw.id] = drop;
  }

  saveState(state);
  _summaryStats = {
    siteId: 'lenovo-gaming',
    claimed: 0,
    skipped: 0,
    display: 'onPage',
    onPage: rawDrops.length,
    new: newDrops,
  };

  // First-run baseline: don't spam notifications for every existing drop on
  // initial enable. Match the convention from ubisoft/humble/fanatical.
  const isFirstRun = Object.keys(state.drops).length === rawDrops.length && newDrops === rawDrops.length;
  if (isFirstRun) {
    log.info(`Baseline established with ${rawDrops.length} drop(s) (no notifications on first run)`);
    for (const d of newlyDiscovered) {
      log.game(d.title, `${d.status}${d.scheduledAt ? ` — ${d.scheduledAt}` : ''}`);
      d.notifications.discovered = datetime();
      if (d.status === 'active') d.notifications.wentLive = datetime();
    }
    saveState(state);
    process.exit(0);
  }

  // Fire push notifications for actionable changes. Plain-text bodies with
  // bare URLs — Pushover strips HTML; bare URLs auto-linkify on tap.
  const lines = [];

  if (newlyDiscovered.length) {
    log.info(`${newlyDiscovered.length} new drop(s) discovered`);
    for (const d of newlyDiscovered) {
      log.game(d.title, `${d.status}${d.scheduledAt ? ` — going live ${d.scheduledAt}` : ''}`);
      d.notifications.discovered = datetime();
      lines.push(`Lenovo Gaming: new drop — ${d.title}`);
      if (d.scheduledAt) lines.push(`Going live: ${d.scheduledAt}`);
      lines.push(d.url);
      lines.push('');
    }
  }

  if (wentLive.length) {
    log.info(`${wentLive.length} drop(s) just went live`);
    for (const d of wentLive) {
      log.game(d.title, 'LIVE NOW');
      d.notifications.wentLive = datetime();
      lines.push(`Lenovo Gaming: drop is LIVE NOW — ${d.title}`);
      lines.push(`Claim before keys run out`);
      lines.push(d.url);
      lines.push('');
    }
  }

  if (restocked) {
    log.info(`${restocked} drop(s) restocked`);
    for (const d of Object.values(state.drops)) {
      if (!d.isRestocked || !d.notifications.restocked.length) continue;
      const last = d.notifications.restocked[d.notifications.restocked.length - 1];
      // Only notify for restocks that fired in this run (last timestamp == now)
      if (last !== datetime()) {
        // Compare by date string approx — within this run's datetime() second
        const now = datetime();
        if (last.slice(0, 19) !== now.slice(0, 19)) continue;
      }
      log.game(d.title, 'RESTOCKED');
      lines.push(`Lenovo Gaming: drop restocked — ${d.title}`);
      lines.push(`More keys available`);
      lines.push(d.url);
      lines.push('');
    }
  }

  saveState(state);

  if (lines.length) {
    const body = lines.join('<br>');
    await notify(body, { kind: 'action', priority: cfg.lenovo_notify_priority })
      .catch(err => log.warn(`Notify failed: ${err.message.split('\n')[0]}`));
  } else {
    log.info('No changes since last cycle');
  }
} catch (error) {
  process.exitCode ||= 1;
  log.exception(error);
  if (cfg.debug) console.error(error);
} finally {
  if (page && page.video()) log.info(`Recorded video — ${await page.video().path()}`);
  if (context) await context.close();
}
