// experiments/camoufox-aliexpress.js
//
// Camoufox PoC runner — Tier 1 scripted test for AliExpress AWSC behavior.
// NOT production code. Lives on experiment/camoufox-poc only.
//
// The jo-inc/camofox-browser image is a REST API wrapper around Camoufox
// (NOT a Playwright-compatible CDP/BiDi endpoint), so this runner drives
// the browser via HTTP rather than via firefox.connect/launch. That's a
// PoC choice — if engine integration eventually ships, it would more
// likely use the standalone Camoufox binary with Playwright's
// firefox.launch(executablePath: ...) directly. The REST-API path here
// is the cheapest way to get evidence one way or the other.
//
// Workflow per run:
//   1. POST /tabs                    → create tab
//   2. POST /tabs/:id/navigate       → navigate to AliExpress coin page
//   3. GET  /tabs/:id/snapshot       → accessibility snapshot (text)
//   4. GET  /tabs/:id/screenshot     → screenshot (PNG saved to disk)
//   5. classify outcome (no-gate / soft-slider / harder-challenge / login-redirect / unknown)
//   6. DELETE /tabs/:id              → clean up
//   7. append row to docs/camoufox-poc-results.md

import { writeFileSync, mkdirSync, existsSync, appendFileSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const RESULTS_PATH = resolve(REPO_ROOT, 'docs/camoufox-poc-results.md');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'data/camoufox-poc-screenshots');

const CAMOFOX_URL = process.env.CAMOFOX_URL || 'http://camoufox:9377';
const COIN_URL = 'https://m.aliexpress.com/p/coin-index/index.html';
const TARGET_RUNS = Number(process.env.RUNS) || 1;
const SCENARIO = process.env.SCENARIO || 'C-cold-no-cookies';
const USER_ID = process.env.POC_USER_ID || `poc-${SCENARIO}`;
const SESSION_KEY = process.env.POC_SESSION_KEY || 'poc-test';
const VIEWPORT = { width: 412, height: 915 }; // Pixel 7-ish mobile

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function api(method, path, body) {
  const url = `${CAMOFOX_URL}${path}`;
  const init = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json();
}

async function downloadScreenshot(tabId, outPath) {
  const url = `${CAMOFOX_URL}/tabs/${tabId}/screenshot?userId=${USER_ID}&fullPage=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`screenshot → ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(outPath));
}

// Outcome classifier based on the URL after navigate plus the
// accessibility snapshot text content. The snapshot is text-only so
// pattern-matching is straightforward; the screenshot is the ground
// truth for any close call.
function classifyOutcome(navResult, snapshotText) {
  const finalUrl = String(navResult.url || '').toLowerCase();
  const snap = String(snapshotText || '').toLowerCase();

  // Bot-challenge text patterns observed historically on AWSC.
  if (snap.includes('network and device') || snap.includes('verify your device')) {
    return 'harder-challenge';
  }
  // AWSC slider
  if (snap.includes('slide to verify') || snap.includes('drag the slider') ||
      snap.includes('captcha') || snap.includes('security check') ||
      snap.includes('please complete the security check')) {
    return 'soft-slider';
  }
  // Login-page redirect = unauthenticated nav, no challenge
  if (finalUrl.includes('/login') || finalUrl.includes('/sign-in') ||
      finalUrl.includes('ug-login-page')) {
    return 'login-redirect';
  }
  // Successful coin-page render (logged in)
  if (snap.includes('day streak') || snap.includes('check-in') ||
      finalUrl.includes('/coin-index') || finalUrl.includes('/coin-pc-index')) {
    return 'no-gate';
  }
  // Login refusal
  if (snap.includes('too many attempts') || snap.includes('account locked') ||
      snap.includes('try again later')) {
    return 'login-refused';
  }
  return 'unknown';
}

async function runOnce(scenario, runIndex) {
  // Tab create
  const tab = await api('POST', '/tabs', { userId: USER_ID, sessionKey: SESSION_KEY });
  const tabId = tab.tabId;
  console.log(`[${ts()}] tab=${tabId} (run ${runIndex}/${TARGET_RUNS}, scenario=${scenario})`);

  if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const stamp = `${scenario}__run${runIndex}__${ts()}`;
  const screenshotPath = resolve(SCREENSHOT_DIR, `${stamp}.png`);

  let navResult = {};
  let snapshotText = '';
  const t0 = Date.now();
  try {
    navResult = await api('POST', `/tabs/${tabId}/navigate`, {
      userId: USER_ID,
      url: COIN_URL,
      waitUntil: 'domcontentloaded',
      timeoutMs: 60000,
    });
    // Let any AWSC challenge or post-load JS render before snapshot
    await new Promise(r => setTimeout(r, 5000));
    try {
      const snap = await fetch(`${CAMOFOX_URL}/tabs/${tabId}/snapshot?userId=${USER_ID}`);
      if (snap.ok) {
        const j = await snap.json();
        snapshotText = JSON.stringify(j).toLowerCase();
      }
    } catch { /* snapshot is best-effort */ }
    await downloadScreenshot(tabId, screenshotPath).catch(() => {});
  } catch (err) {
    console.log(`[${ts()}] error: ${err.message}`);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);

  const outcome = classifyOutcome(navResult, snapshotText);
  console.log(`[${ts()}] outcome=${outcome} elapsed=${elapsed}s url=${navResult.url || 'n/a'}`);

  await api('DELETE', `/tabs/${tabId}?userId=${USER_ID}`).catch(() => {});

  return {
    runIndex, scenario, outcome, elapsed,
    finalUrl: navResult.url || '',
    screenshotPath,
    at: new Date().toISOString(),
  };
}

function appendResultRow(result) {
  if (!existsSync(RESULTS_PATH)) {
    console.warn(`[${ts()}] Results file not found at ${RESULTS_PATH} — skipping append`);
    return;
  }
  const relPath = result.screenshotPath ? result.screenshotPath.replace(REPO_ROOT + '/', '') : '';
  const row = `| ${result.at} | ${result.scenario} | run ${result.runIndex} | ${result.outcome} | ${result.elapsed}s | \`${result.finalUrl || 'n/a'}\` | \`${relPath}\` |\n`;
  appendFileSync(RESULTS_PATH, row);
}

async function main() {
  console.log(`[${ts()}] Camoufox PoC runner — scenario=${SCENARIO} runs=${TARGET_RUNS} target=${CAMOFOX_URL}`);

  // Sanity check the API is reachable before launching N runs.
  try {
    const health = await api('GET', '/health');
    console.log(`[${ts()}] camoufox health: engine=${health.engine} browserConnected=${health.browserConnected}`);
  } catch (err) {
    console.error(`[${ts()}] cannot reach camoufox at ${CAMOFOX_URL}: ${err.message}`);
    console.error('  Make sure the sidecar is up: docker compose -f docker-compose.yml -f docker-compose.experiments.yml up -d camoufox');
    process.exit(1);
  }

  for (let i = 1; i <= TARGET_RUNS; i++) {
    try {
      const result = await runOnce(SCENARIO, i);
      appendResultRow(result);
    } catch (err) {
      console.error(`[${ts()}] Run ${i} failed: ${err.message}`);
      appendResultRow({
        runIndex: i,
        scenario: SCENARIO,
        outcome: `error: ${err.message.split('\n')[0]}`,
        elapsed: 0,
        finalUrl: '',
        screenshotPath: '',
        at: new Date().toISOString(),
      });
    }
  }
  console.log(`[${ts()}] Done.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
