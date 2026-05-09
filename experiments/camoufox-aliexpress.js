// experiments/camoufox-aliexpress.js
//
// Camoufox PoC runner — Tier 1 scripted test for AliExpress AWSC behavior.
// NOT production code. Lives on experiment/camoufox-poc only. Reads no
// shared registry, doesn't touch the panel or scheduler, doesn't write
// to data/aliexpress.json. Its only job: connect to a Camoufox sidecar,
// walk through the AliExpress mobile coin flow, capture screenshots and
// outcome state, append a row to docs/camoufox-poc-results.md.
//
// Connection: by default expects a Camoufox sidecar published per
// docker-compose.experiments.yml exposing Firefox's remote debugging
// (BiDi or CDP) on the URL given by CAMOUFOX_WS_URL env. If that
// scheme doesn't match what jo-inc/camofox-browser actually publishes
// (a REST API rather than a Playwright-compatible endpoint), this runner
// will fail to connect — see experiments/README.md "tier 0" for the
// no-code manual fallback. Discovering the right wiring is part of
// the PoC.

import { firefox } from 'patchright';
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const RESULTS_PATH = resolve(REPO_ROOT, 'docs/camoufox-poc-results.md');
const SCREENSHOT_DIR = resolve(REPO_ROOT, 'data/camoufox-poc-screenshots');

// Connection candidates in priority order — first that works wins.
//   CAMOUFOX_WS_URL      — explicit BiDi/CDP WebSocket endpoint
//   CAMOUFOX_CDP_URL     — explicit CDP HTTP endpoint (firefox.connectOverCDP)
//   CAMOUFOX_BIN         — local executable path (firefox.launch)
const CAMOUFOX_WS_URL  = process.env.CAMOUFOX_WS_URL  || '';
const CAMOUFOX_CDP_URL = process.env.CAMOUFOX_CDP_URL || '';
const CAMOUFOX_BIN     = process.env.CAMOUFOX_BIN     || '';

const COIN_URL = 'https://m.aliexpress.com/p/coin-index/index.html';
const TARGET_RUNS = Number(process.env.RUNS) || 1;
const SCENARIO = process.env.SCENARIO || 'C-cold-no-cookies';

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function getBrowser() {
  if (CAMOUFOX_WS_URL) {
    console.log(`[${ts()}] Connecting via wsEndpoint: ${CAMOUFOX_WS_URL}`);
    return await firefox.connect(CAMOUFOX_WS_URL);
  }
  if (CAMOUFOX_CDP_URL) {
    console.log(`[${ts()}] Connecting via CDP: ${CAMOUFOX_CDP_URL}`);
    // Note: firefox.connectOverCDP may not exist in all Playwright versions
    // for Firefox. If this fails, fall back to wsEndpoint or local binary.
    return await firefox.connectOverCDP(CAMOUFOX_CDP_URL);
  }
  if (CAMOUFOX_BIN) {
    console.log(`[${ts()}] Launching local Camoufox binary: ${CAMOUFOX_BIN}`);
    return await firefox.launch({
      executablePath: CAMOUFOX_BIN,
      headless: false,
      // Camoufox manages its own fingerprint; don't pass viewport/UA here.
    });
  }
  throw new Error(
    'No Camoufox connection method set. Provide one of:\n' +
    '  CAMOUFOX_WS_URL   (e.g. ws://camoufox:9222)\n' +
    '  CAMOUFOX_CDP_URL  (e.g. http://camoufox:9222)\n' +
    '  CAMOUFOX_BIN      (e.g. /opt/camoufox/camoufox)\n' +
    'See experiments/README.md for sidecar setup.'
  );
}

// Outcome classifier based on what's visible on the page.
async function classifyOutcome(page) {
  // Check for the various AWSC challenge presentations.
  const sliderVisible = await page.locator('iframe[src*="awsc"], iframe[src*="punish"], iframe[src*="captcha"], iframe[src*="nocaptcha"]').first().isVisible().catch(() => false);
  if (sliderVisible) return 'soft-slider';

  // The "Network and device" harder challenge — text-based detection.
  const harderChallenge = await page.locator(':text-matches("Network and device|verify your device|trust", "i")').first().isVisible().catch(() => false);
  if (harderChallenge) return 'harder-challenge';

  // Login refusal / error toast.
  const refused = await page.locator(':text-matches("login failed|too many attempts|account locked|try again later", "i")').first().isVisible().catch(() => false);
  if (refused) return 'login-refused';

  // Successful read of streak text means we got through.
  const streak = await page.locator('h3:text-is("day streak")').isVisible().catch(() => false);
  if (streak) return 'no-gate';

  return 'unknown';
}

async function runOnce(scenario, runIndex) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, // Pixel 7-ish mobile viewport
    userAgent: undefined, // let Camoufox decide
  });
  const page = await context.newPage();

  if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const stamp = `${scenario}__run${runIndex}__${ts()}`;
  const screenshotPre = resolve(SCREENSHOT_DIR, `${stamp}__pre-load.png`);
  const screenshotPost = resolve(SCREENSHOT_DIR, `${stamp}__post-load.png`);

  console.log(`[${ts()}] Navigating to coin page (run ${runIndex}/${TARGET_RUNS}, scenario=${scenario})`);
  const t0 = Date.now();
  try {
    await page.goto(COIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.screenshot({ path: screenshotPre, fullPage: true }).catch(() => {});
    // Let any AWSC challenge render
    await page.waitForTimeout(5000);
    await page.screenshot({ path: screenshotPost, fullPage: true }).catch(() => {});
  } catch (err) {
    console.log(`[${ts()}] Navigation error: ${err.message}`);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);

  const outcome = await classifyOutcome(page);
  console.log(`[${ts()}] Run ${runIndex} outcome: ${outcome} (${elapsed}s)`);

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  return { runIndex, scenario, outcome, elapsed, screenshotPre, screenshotPost, at: new Date().toISOString() };
}

function appendResultRow(result) {
  if (!existsSync(RESULTS_PATH)) {
    console.warn(`[${ts()}] Results file not found at ${RESULTS_PATH} — skipping append`);
    return;
  }
  const row = `| ${result.at} | ${result.scenario} | run ${result.runIndex} | ${result.outcome} | ${result.elapsed}s | \`${result.screenshotPost.replace(REPO_ROOT + '/', '')}\` |\n`;
  appendFileSync(RESULTS_PATH, row);
}

async function main() {
  console.log(`[${ts()}] Camoufox PoC runner — scenario=${SCENARIO} runs=${TARGET_RUNS}`);
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
        screenshotPre: '',
        screenshotPost: '',
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
