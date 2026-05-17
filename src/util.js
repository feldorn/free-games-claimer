// https://stackoverflow.com/questions/46745014/alternative-for-dirname-in-node-js-when-using-es6-modules
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, lstatSync } from 'node:fs';
// not the same since these will give the absolute paths for this file instead of for the file using them
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// explicit object instead of Object.fromEntries since the built-in type would loose the keys, better type: https://dev.to/svehla/typescript-object-fromentries-389c
export const dataDir = s => path.resolve(__dirname, '..', 'data', s);

// modified path.resolve to return null if first argument is '0', used to disable screenshots
export const resolve = (...a) => a.length && a[0] == '0' ? null : path.resolve(...a);

// json database
import { JSONFilePreset } from 'lowdb/node';
export const jsonDb = (file, defaultData) => JSONFilePreset(dataDir(file), defaultData);

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// date and time as UTC (no timezone offset) in nicely readable and sortable format, e.g., 2022-10-06 12:05:27.313
export const datetimeUTC = (d = new Date()) => d.toISOString().replace('T', ' ').replace('Z', '');
// same as datetimeUTC() but for local timezone, e.g., UTC + 2h for the above in DE
export const datetime = (d = new Date()) => datetimeUTC(new Date(d.getTime() - d.getTimezoneOffset() * 60000));
export const filenamify = s => s.replaceAll(':', '.').replace(/[^a-z0-9 _\-.]/gi, '_'); // alternative: https://www.npmjs.com/package/filenamify - On Unix-like systems, / is reserved. On Windows, <>:"/\|?* along with trailing periods are reserved.

// Load a previously-saved fingerprint from <profileDir>/.fgc-fingerprint.json
// or call the supplied generator function once and persist its output.
// Used to keep the same browser fingerprint across runs so sites don't see
// device-instability signals between launches (a fresh fingerprint each
// run is itself a flag in some sites' bot scoring). Returns the same
// shape as fingerprint-generator's getFingerprint() — { fingerprint,
// headers } — plus a `_persisted` boolean indicating whether the value
// came from cache or was freshly generated this invocation. Generation
// failures are non-fatal: the caller still gets a usable fingerprint,
// just one that didn't get saved (logged warning in that case).
export const getOrCreateFingerprint = (profileDir, generate) => {
  const fpFile = path.join(profileDir, '.fgc-fingerprint.json');
  if (existsSync(fpFile)) {
    try {
      const cached = JSON.parse(readFileSync(fpFile, 'utf8'));
      if (cached?.fingerprint?.navigator?.userAgent && cached?.headers) {
        return { fingerprint: cached.fingerprint, headers: cached.headers, _persisted: true };
      }
    } catch { /* corrupt or partial — fall through to regenerate */ }
  }
  const fresh = generate();
  try {
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(fpFile, JSON.stringify({ fingerprint: fresh.fingerprint, headers: fresh.headers }, null, 2));
  } catch (e) {
    console.warn(`[fingerprint] could not persist to ${fpFile}: ${e.message.split('\n')[0]}`);
  }
  return { fingerprint: fresh.fingerprint, headers: fresh.headers, _persisted: false };
};

// Clean stale Chromium profile-lock files from a persistent user-data
// dir before launchPersistentContext. Chromium writes SingletonLock,
// SingletonCookie, and SingletonSocket files when it starts; on a clean
// shutdown it removes them. But ungraceful exits (OOM, force-kill, host
// reboot) leave them behind, and the next launch fails with:
//   The profile appears to be in use by another Chromium process (PID)
//   on another computer (HOSTNAME). Chromium has locked the profile
//   so that it doesn't get corrupted.
//
// The "another computer" part is the kicker in Docker — every container
// recreation gets a new auto-assigned hostname, so the stored hostname
// in SingletonCookie is from the previous container and trips the
// foreign-host check. Once present, the lock never clears on its own.
//
// We can safely remove these files because the app's runtime mutex
// (browserBusy in interactive-login.js) prevents two Chromium processes
// from racing on the same profile dir. Called from launchPersistentContext
// sites before launch, and from the panel's startup as a clean-room
// sweep across all known profile dirs. (Fix per feldorn#37, 2026-05-15
// — Lifeng77X's AliExpress profile-lock report.)
export const cleanProfileLocks = (profileDir) => {
  if (!profileDir || !existsSync(profileDir)) return [];
  const lockNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  const removed = [];
  for (const name of lockNames) {
    const p = path.join(profileDir, name);
    try {
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      unlinkSync(p);
      removed.push(name);
    } catch { /* best effort — if it's gone or unremovable, next launch will surface a clearer error */ }
  }
  return removed;
};

// Race context.close() with a timeout. Some sites (e.g. Epic Store) keep service workers and
// long-poll websockets alive, which withholds the renderer's close-ack and hangs context.close()
// indefinitely. Page-level finalization (video, HAR) has already flushed by the time we get here,
// so on timeout we warn and let the process exit.
export const closeContextSafely = async (context, timeoutMs = 15000) => {
  const closed = await Promise.race([
    context.close().then(() => true, () => true),
    new Promise(r => setTimeout(() => r(false), timeoutMs)),
  ]);
  if (!closed) console.warn(`context.close() timed out after ${timeoutMs}ms — forcing exit (likely a stuck service worker)`);
  return closed;
};

export const handleSIGINT = (context = null) => process.on('SIGINT', async () => { // e.g. when killed by Ctrl-C
  console.error('\nInterrupted by SIGINT. Exit!'); // Exception shows where the script was:\n'); // killed before catch in docker...
  process.exitCode = 130; // 128+SIGINT to indicate to parent that process was killed
  if (context) await closeContextSafely(context); // in order to save recordings also on SIGINT, we need to disable Playwright's handleSIGINT and close the context ourselves
  process.exit(process.exitCode);
});

// used prompts before, but couldn't cancel prompt
// alternative inquirer is big (node_modules 29MB, enquirer 9.7MB, prompts 9.8MB, none 9.4MB) and slower
// open issue: prevents handleSIGINT() to work if prompt is cancelled with Ctrl-C instead of Escape: https://github.com/enquirer/enquirer/issues/372
import Enquirer from 'enquirer'; const enquirer = new Enquirer();
const timeoutPlugin = timeout => enquirer => { // cancel prompt after timeout ms
  enquirer.on('prompt', prompt => {
    const t = setTimeout(() => {
      prompt.hint = () => 'timeout';
      prompt.cancel();
    }, timeout);
    prompt.on('submit', _ => clearTimeout(t));
    prompt.on('cancel', _ => clearTimeout(t));
  });
};
enquirer.use(timeoutPlugin(cfg.login_timeout)); // TODO may not want to have this timeout for all prompts; better extend Prompt and add a timeout prompt option
// single prompt that just returns the non-empty value instead of an object
// @ts-ignore
export const prompt = o => enquirer.prompt({ name: 'name', type: 'input', message: 'Enter value', ...o }).then(r => r.name).catch(_ => {});
export const confirm = o => prompt({ type: 'confirm', message: 'Continue?', ...o });

// notifications via apprise CLI
import { execFile } from 'child_process';
import { promises as fsp } from 'node:fs';
import chalk from 'chalk';
import { cfg } from './config.js';

// Walk cfg.dir.screenshots recursively for the newest PNG with mtime ≥ this
// process's start time. Used by notify() when callers pass
// { attachLatestScreenshot: true } so error notifications carry the visual
// state of the failure without each call site needing to track a path.
const findLatestScreenshot = async () => {
  const root = cfg.dir?.screenshots;
  if (!root || root === '0') return null;
  const cutoff = Date.now() - process.uptime() * 1000;
  const walk = async dir => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return []; }
    const found = await Promise.all(entries.map(async e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.png')) return [];
      const s = await fsp.stat(full).catch(() => null);
      return s && s.mtimeMs >= cutoff ? [{ path: full, mtime: s.mtimeMs }] : [];
    }));
    return found.flat();
  };
  const files = await walk(root);
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0].path;
};

export const notify = (html, opts = {}) => {
  if (!cfg.notify) {
    if (cfg.debug) console.debug('notify: NOTIFY is not set!');
    return Promise.resolve();
  }
  // Notification verbosity gate (#31). opts.kind tags the call site as
  // either a per-run summary ('summary') or an action-required event
  // ('action', the default for untagged calls). Level 'off' silences all
  // notifications; 'actions' silences only the summaries; 'all' (default)
  // fires everything as before. Defaulting untagged calls to 'action'
  // keeps legacy behavior under any non-off level.
  const kind = opts.kind === 'summary' ? 'summary' : 'action';
  const level = cfg.notify_level || 'all';
  if (level === 'off') return Promise.resolve();
  if (level === 'actions' && kind === 'summary') return Promise.resolve();
  // Resolve attachment path (if any) before invoking apprise. Explicit
  // opts.screenshot always wins; attachLatestScreenshot is the autopilot
  // path and is gated by cfg.notify_attach_screenshots so users can opt
  // out of attachments globally (privacy / bandwidth / target limits).
  const wantLatest = opts.attachLatestScreenshot && cfg.notify_attach_screenshots !== false;
  const attachPromise = opts.screenshot
    ? Promise.resolve(opts.screenshot)
    : wantLatest
      ? findLatestScreenshot().catch(() => null)
      : Promise.resolve(null);
  return attachPromise.then(attachPath => new Promise((resolve, reject) => {
    // const cmd = `apprise '${cfg.notify}' ${title} -i html -b '${html}'`; // this had problems if e.g. ' was used in arg; could have `npm i shell-escape`, but instead using safer execFile which takes args as array instead of exec which spawned a shell to execute the command
    //
    // Split NOTIFY on whitespace (covers spaces, tabs, newlines) so each
    // configured URL becomes its own positional argv. Without this,
    // multi-line NOTIFY values from compose
    //   NOTIFY: |
    //     discord://…
    //     tgram://…
    // collapse into a single argv with embedded newlines. Older apprise
    // tolerated this; apprise ≥ 1.10 parses the concatenated string as
    // one URL and rejects the second protocol (Telegram URLs are
    // colon-heavy so they fail visibly first). Fix per feldorn#35
    // (KairuByte, 2026-05-14). Apprise URLs don't contain whitespace,
    // so the split is safe.
    let notifyUrls = String(cfg.notify || '').split(/\s+/).filter(Boolean);
    // Per-call priority. Apprise expresses priority as a per-notifier
    // URL query parameter (`?priority=high`), NOT a CLI flag — apprise
    // v1.10.0 has no `--priority` option at all (caught 2026-05-16 in
    // feldorn#42 when JxPv2's ntfys captcha alert printed
    // "Error: No such option: --priority"). Apprise translates the
    // generic-named level to whatever the configured notifier expects
    // (Pushover honors high/emergency literally, ntfy maps to 1-5,
    // Telegram silent flag, Discord ignores). Existing-deploy behavior
    // is preserved when opts.priority is unset or 'normal' — no query
    // param appended, no URL mutation.
    if (opts.priority && opts.priority !== 'normal') {
      const p = encodeURIComponent(String(opts.priority));
      notifyUrls = notifyUrls.map(u => u + (u.includes('?') ? '&' : '?') + 'priority=' + p);
    }
    const args = [...notifyUrls, '-i', 'html', '-b', html];
    if (cfg.notify_title) args.push('-t', cfg.notify_title);
    if (attachPath) args.push('-a', attachPath);
    if (cfg.debug) console.debug(`apprise ${args.map(a => `'${a}'`).join(' ')}`); // this also doesn't escape, but it's just for info
    execFile('apprise', args, (error, stdout, stderr) => {
      if (error) {
        console.log(`error: ${error.message}`);
        if (error.message.includes('command not found')) {
          console.info('Run `pip install apprise`. See https://github.com/vogler/free-games-claimer#notifications');
        }
        return reject(error);
      }
      if (stderr) console.error(`stderr: ${stderr}`);
      if (stdout) console.log(`stdout: ${stdout}`);
      resolve();
    });
  }));
};

export const escapeHtml = unsafe => unsafe.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\'', '&#039;');

// Captcha pause helper. Per-service state machine in process memory drives
// whether the helper actively engages the user (notify + wait + poll) or
// short-circuits with a deferred-form push notification so the user can
// process the captcha manually later.
//
// State per service:
//   fresh    (initial)             — engage
//   engaged  (last solve succeeded) — engage again; user is responsive
//   abandoned (last engagement timed out) — short-circuit; user is away
//
// UX rationale: present user solves the first captcha, automation almost
// always sails through the rest of the run. Absent user gets a deep-link
// notification per missed captcha so nothing falls silent — they can come
// back later and process manually. Each new run resets the Map (each run
// is a fresh node child process) so an absent user gets a fresh shot at
// engagement next cycle.
//
// Markers (panel-only signal):
//   [CAPTCHA-START] service=<id> label=<text>     — emitted only on engage
//   [CAPTCHA-END]   service=<id> reason=...       — solved | timeout
// Abandoned-path encounters emit no markers (no banner flicker, no log
// noise) — just the deferred notification and a return false.
//
// Caller-supplied captchaCheck is intentionally site-specific — selectors
// for AliExpress's slider, GOG's hCaptcha iframe, MS's overlays etc. all
// differ. A central registry would just ossify; per-site checks stay close
// to the code that knows the page's DOM.
const _captchaServiceState = new Map(); // service -> 'engaged' | 'abandoned'
const _captchaDeepLink = () => cfg.public_url ? `${cfg.public_url}/?focus=captcha` : null;
const _captchaNotifyBody = (service, label, kind) => {
  const url = _captchaDeepLink();
  const intro = kind === 'urgent'
    ? `${escapeHtml(service)} captcha: ${escapeHtml(label)} — solve now`
    : `${escapeHtml(service)} captcha: ${escapeHtml(label)} — solve later when you can`;
  return url ? `${intro}<br>${url}` : `${intro}. Open the panel to solve.`;
};
// Urgent captchas get high priority by default (CAPTCHA_NOTIFY_PRIORITY).
// Deferred follow-ups stay at normal — the user already missed the window,
// blasting DnD again is annoying. Read via cfg so a Settings save takes
// effect without restart.
const _captchaPriority = (kind) => kind === 'urgent' ? (cfg.captcha_notify_priority || 'high') : 'normal';
export const awaitUserCaptchaSolve = async (page, {
  service,
  label = 'verification',
  captchaCheck,
  timeoutMs = 10 * 60 * 1000,
  pollMs = 1000,
}) => {
  if (!service) throw new Error('awaitUserCaptchaSolve: service is required');
  if (typeof captchaCheck !== 'function') throw new Error('awaitUserCaptchaSolve: captchaCheck function is required');

  // Skip the whole dance if the captcha isn't actually visible.
  if (!(await captchaCheck())) return true;

  const safeLabel = String(label).replace(/\s+/g, ' ').slice(0, 200);
  const state = _captchaServiceState.get(service); // undefined = fresh

  // Abandoned path — user gave up earlier. Single deferred notification so
  // they have a record + link, then return false without blocking.
  if (state === 'abandoned') {
    notify(_captchaNotifyBody(service, safeLabel, 'deferred'), { priority: _captchaPriority('deferred'), kind: 'action' })
      .catch(e => console.error(`captcha notify (deferred) failed: ${e.message}`));
    return false;
  }

  // Engagement path — fresh or previously engaged. Banner + urgent notify + poll.
  console.log(`[CAPTCHA-START] service=${service} label=${safeLabel}`);
  notify(_captchaNotifyBody(service, safeLabel, 'urgent'), { priority: _captchaPriority('urgent'), kind: 'action' })
    .catch(e => console.error(`captcha notify (urgent) failed: ${e.message}`));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(pollMs);
    let visible;
    try { visible = await captchaCheck(); }
    catch { visible = true; } // err on the side of waiting through transient errors
    if (!visible) {
      _captchaServiceState.set(service, 'engaged');
      console.log(`[CAPTCHA-END] service=${service} reason=solved`);
      return true;
    }
  }

  // Timed out — flip to abandoned, fire a deferred follow-up so this missed
  // captcha doesn't disappear from the user's awareness, return false.
  _captchaServiceState.set(service, 'abandoned');
  console.log(`[CAPTCHA-END] service=${service} reason=timeout`);
  notify(_captchaNotifyBody(service, safeLabel, 'deferred'), { priority: _captchaPriority('deferred'), kind: 'action' })
    .catch(e => console.error(`captcha notify (deferred) failed: ${e.message}`));
  return false;
};

// Normalize a game title for fuzzy cross-store matching: lowercase, collapse
// separators/punctuation/whitespace. Used to reconcile Prime Gaming entries
// against the authenticated GOG library where exact punctuation / edition
// suffixes may differ between stores.
export const normalizeTitle = s => (s || '')
  .toLowerCase()
  .replace(/[:;\-–—_/\\]/g, ' ')
  .replace(/['".,!?()[\]®™©]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

export const html_game_list = games => games.map(g => {
  if (g.status === 'action') return `<b><a href="${g.url}">${escapeHtml(g.title)}</a></b>`;
  let line = `- <a href="${g.url}">${escapeHtml(g.title)}</a> (${g.status})`;
  if (g.details) line += `<br>  ${g.details}`;
  return line;
}).join('<br>');

const SECTION_WIDTH = 50;
export const log = {
  section: (title) => {
    const pad = SECTION_WIDTH - title.length - 5;
    console.log(`\n${'─'.repeat(3)} ${title} ${'─'.repeat(Math.max(3, pad))}`);
  },
  // sectionEnd removed — service blocks are now delimited by the leading
  // blank line in log.section. Closing rulers were inconsistent across
  // claim vs watch scripts and added visual noise without information.
  status: (label, value) => {
    console.log(`  ${label}: ${value}`);
  },
  info: (msg) => {
    console.log(`  ${chalk.green('✓')} ${msg}`);
  },
  game: (name, status) => {
    console.log(`    ${chalk.blue(name)} ${chalk.dim('→')} ${status}`);
  },
  skip: (name, reason) => {
    console.log(`    ${chalk.red('✗')} ${chalk.dim(name)} — ${chalk.yellow(reason)}`);
  },
  ok: (msg) => {
    console.log(`    ${chalk.green('✓')} ${msg}`);
  },
  warn: (msg) => {
    console.log(`    ${chalk.yellow('!')} ${msg}`);
  },
  fail: (msg) => {
    console.log(`  ${chalk.red('✗')} ${msg}`);
  },
  // Per-service end-of-run summary + combined success+metrics marker.
  // Strict 3-field human line: "claimed, skipped, <n> <context-label>",
  // identical shape across all services so the run log scans vertically.
  // Caller selects which field surfaces in the third column via `display`.
  // Marker shape: "[run] service=<id> ok claimed=N skipped=N <key>=<v>…"
  // — the `ok` token is the success signal (subsumes the prior separate
  // [RUN-SUCCESS] marker); failure paths simply don't reach this call.
  summary: (opts) => {
    const fieldLabels = {
      alreadyOwned: 'already owned',
      onPage:       'on page',
      tracked:      'tracked',
      pointsEarned: 'points earned',
      coins:        'coins',
      new:          'new',
      failed:       'failed',
      needsAction:  'needs manual redeem',
    };
    const o = opts || {};
    const claimed = o.claimed ?? 0;
    const skipped = o.skipped ?? 0;
    if (o.display && o[o.display] != null && fieldLabels[o.display]) {
      console.log(`  Summary: ${claimed} claimed, ${skipped} skipped, ${o[o.display]} ${fieldLabels[o.display]}`);
    } else {
      console.log(`  Summary: ${claimed} claimed, ${skipped} skipped`);
    }
    if (o.siteId) {
      const parts = [`claimed=${claimed}`, `skipped=${skipped}`];
      for (const k of Object.keys(fieldLabels)) {
        if (o[k] != null) parts.push(`${k}=${o[k]}`);
      }
      console.log(`  [run] service=${o.siteId} ok ${parts.join(' ')}`);
    }
  },
  // Already-owned game line. Distinguishes "no work needed" (`•`) from
  // "new action this run" (`✓` via log.ok). Same indent as log.ok and
  // log.skip so the per-service block reads as a uniform table.
  owned: (name) => {
    console.log(`    ${chalk.dim('•')} ${chalk.dim(name + ' — already owned')}`);
  },
  // Progressive line helpers — write pieces without newline, then end the line.
  // Use these when you want log output to appear incrementally (e.g. during sleeps).
  progressStart: (msg) => process.stdout.write(`  ${msg}`),
  progressAppend: (msg) => process.stdout.write(msg),
  progressEnd: (msg = '') => process.stdout.write(`${msg}\n`),
  progressInfo: (msg) => process.stdout.write(`  ${chalk.green('✓')} ${msg}`),
};
