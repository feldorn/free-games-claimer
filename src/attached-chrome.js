// Google Chrome started as a plain process, with patchright attached over CDP
// afterwards (REAL_CHROME).
//
// Launched by patchright, even the branded Chrome with its extra switches
// removed failed GOG's Cloudflare Turnstile ("Verification failed"). The same
// Chrome started as a normal process, with patchright's own switch set but
// nothing attached, was not even challenged, and neither was it with
// patchright connected afterwards through connectOverCDP. That is also how the
// Remaster's nodriver works. The attached browser keeps the window's own size
// and gets no locale, timezone or viewport emulation; Chrome takes those from
// --lang and the container's TZ.

import { chromium } from 'patchright';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CHROME_PATH } from './android-chrome.js';

const PORT_FILE = 'DevToolsActivePort';
const START_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 15_000;

/**
 * Start Google Chrome on `profileDir` and attach patchright to it.
 * `context.close()` disconnects and then stops Chrome gracefully, so it can
 * write cookies and session state to the profile before it exits.
 *
 * @param {string} profileDir
 * @param {object} [opts]
 * @param {string[]} [opts.args]  extra Chrome switches.
 * @param {boolean} [opts.headless]
 * @param {string} [opts.startUrl]  the page Chrome opens on its own (default about:blank).
 * @returns {Promise<{ browser: import('patchright').Browser, context: import('patchright').BrowserContext }>}
 */
export async function launchAttachedChrome(profileDir, { args = [], headless = false, startUrl = 'about:blank' } = {}) {
  ignoreClosedTargetRejections();
  const portFile = path.join(profileDir, PORT_FILE);
  rmSync(portFile, { force: true });
  const chrome = spawn(CHROME_PATH, [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0', // Chrome picks a free port and writes it to DevToolsActivePort
    '--no-first-run',
    '--no-default-browser-check',
    // Same as patchright's launches, so the cookies it encrypted stay readable.
    '--password-store=basic',
    '--use-mock-keychain',
    // Also as patchright launched it: Chrome's sandbox can't start in the
    // container. No --disable-dev-shm-usage, which the runs that passed GOG's
    // Turnstile did not have; a deploy with Docker's 64 MB /dev/shm may want
    // shm_size in its compose file.
    '--no-sandbox',
    ...headless ? ['--headless=new'] : [],
    ...args,
    startUrl,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  chrome.stderr.on('data', d => {
    stderr = (stderr + d).slice(-4000);
  });
  const exited = new Promise(resolve => chrome.once('exit', resolve));

  const stop = async () => {
    if (chrome.exitCode !== null || chrome.signalCode !== null) return;
    chrome.kill('SIGTERM');
    const timer = new Promise(resolve => setTimeout(resolve, EXIT_TIMEOUT_MS, 'timeout'));
    if (await Promise.race([exited, timer]) === 'timeout') {
      chrome.kill('SIGKILL');
      await exited;
    }
  };

  let browser;
  try {
    const port = await waitForPort(portFile, chrome);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (e) {
    await stop();
    const tail = stderr.trim().split('\n').slice(-5).join('\n');
    throw new Error(`Google Chrome did not start: ${e.message}${tail ? `\n${tail}` : ''}`);
  }

  const context = browser.contexts()[0];
  context.close = async () => {
    try {
      await browser.close(); // for a connected browser this only disconnects
    } catch {
      // already disconnected
    }
    await stop();
  };
  return { browser, context };
}

// Attached to a browser that is already running, patchright sets request
// interception on every target it finds, service workers included. When one
// closes in the middle (a site's service worker starting and stopping), the
// send rejects with "Protocol error (Network.setCacheDisabled): ... session
// closed" inside patchright, nothing awaits it, and Node ends the process: the
// panel restarted three times in a row on 2026-11-22 once gog.com had
// registered a service worker. A launchPersistentContext launch never hits
// this, because it attaches before any target exists. Only that error is
// ignored; anything else is reported and exits with code 1, as Node does.
let closedTargetGuard = false;
function ignoreClosedTargetRejections() {
  if (closedTargetGuard) return;
  closedTargetGuard = true;
  process.on('unhandledRejection', reason => {
    // patchright's ProtocolError sets no `name`; it carries the CDP method and type.
    if (reason?.type === 'closed' && typeof reason?.method === 'string') {
      console.warn(`Ignored ${reason.method || 'a CDP call'} on a browser target that had already closed.`);
      return;
    }
    console.error(reason);
    process.exit(1);
  });
}

async function waitForPort(portFile, chrome) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited with code ${chrome.exitCode}`);
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      if (port > 0) return port;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`no ${PORT_FILE} after ${START_TIMEOUT_MS / 1000}s`);
}
