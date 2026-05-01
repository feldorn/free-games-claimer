// https://stackoverflow.com/questions/46745014/alternative-for-dirname-in-node-js-when-using-es6-modules
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

export const handleSIGINT = (context = null) => process.on('SIGINT', async () => { // e.g. when killed by Ctrl-C
  console.error('\nInterrupted by SIGINT. Exit!'); // Exception shows where the script was:\n'); // killed before catch in docker...
  process.exitCode = 130; // 128+SIGINT to indicate to parent that process was killed
  if (context) await context.close(); // in order to save recordings also on SIGINT, we need to disable Playwright's handleSIGINT and close the context ourselves
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
    const args = [cfg.notify, '-i', 'html', '-b', html];
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
    notify(_captchaNotifyBody(service, safeLabel, 'deferred'))
      .catch(e => console.error(`captcha notify (deferred) failed: ${e.message}`));
    return false;
  }

  // Engagement path — fresh or previously engaged. Banner + urgent notify + poll.
  console.log(`[CAPTCHA-START] service=${service} label=${safeLabel}`);
  notify(_captchaNotifyBody(service, safeLabel, 'urgent'))
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
  notify(_captchaNotifyBody(service, safeLabel, 'deferred'))
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
  sectionEnd: () => {
    console.log('─'.repeat(SECTION_WIDTH));
  },
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
  summary: (parts) => {
    console.log(`  ${chalk.dim('Summary:')} ${parts.join(', ')}`);
  },
  // Progressive line helpers — write pieces without newline, then end the line.
  // Use these when you want log output to appear incrementally (e.g. during sleeps).
  progressStart: (msg) => process.stdout.write(`  ${msg}`),
  progressAppend: (msg) => process.stdout.write(msg),
  progressEnd: (msg = '') => process.stdout.write(`${msg}\n`),
  progressInfo: (msg) => process.stdout.write(`  ${chalk.green('✓')} ${msg}`),
};
