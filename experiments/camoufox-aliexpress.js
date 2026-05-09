// experiments/camoufox-aliexpress.js
//
// Camoufox PoC runner — Tier 1 scripted test for AliExpress AWSC behavior,
// instrumented for one-shot diagnostic capture.
//
// NOT production code. Lives on experiment/camoufox-poc only.
//
// The jo-inc/camofox-browser image wraps Camoufox in a REST API
// (NOT a Playwright-compatible CDP/BiDi endpoint), so this runner drives
// the browser via HTTP rather than via firefox.connect/launch.
//
// Each run captures everything we'd want to see if we were sitting next
// to the user, since the user is unlikely to be willing to re-run with
// "more logging" two days later. Per-run artifact directory:
//
//   data/camoufox-poc/<scenario>/run-<N>-<timestamp>/
//     manifest.json         outcome classification + all artifact paths
//     pre-fingerprint.json  what Camoufox claims to be BEFORE nav
//                           (UA, WebGL, audio, screen, hwConcurrency, …)
//     navigate.json         API response from the navigate call
//     post-state.json       cookies, localStorage size, iframes, etc.
//                           AFTER the page has settled
//     screenshot-1.png      taken 5s after navigate (initial render)
//     screenshot-2.png      taken 10s after navigate (post-AWSC settle)
//     snapshot.json         accessibility tree (text content of the page)
//     trace-*.zip           Playwright trace exported by jo-inc if any
//     camoufox-logs.txt     sidecar container stdout during this run
//
// The manifest stitches it all together for review.

import { mkdirSync, existsSync, appendFileSync, writeFileSync, createWriteStream, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const RESULTS_PATH = resolve(REPO_ROOT, 'docs/camoufox-poc-results.md');
const POC_DATA_ROOT = resolve(REPO_ROOT, 'data/camoufox-poc');

const CAMOFOX_URL = process.env.CAMOFOX_URL || 'http://camoufox:9377';
const CAMOFOX_CONTAINER = process.env.CAMOFOX_CONTAINER || 'fgc-camoufox-poc';
const CAMOFOX_API_KEY = process.env.CAMOFOX_API_KEY || ''; // for trace endpoints when not loopback
const COIN_URL = process.env.COIN_URL || 'https://m.aliexpress.com/p/coin-index/index.html';
const TARGET_RUNS = Number(process.env.RUNS) || 1;
const SCENARIO = process.env.SCENARIO || 'C-cold-no-cookies';
const ENABLE_TRACE = process.env.NO_TRACE !== '1'; // default on; set NO_TRACE=1 to skip
const SETTLE_MS_1 = Number(process.env.SETTLE_MS_1) || 5000;
const SETTLE_MS_2 = Number(process.env.SETTLE_MS_2) || 10000;

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function tsHuman() {
  return new Date().toISOString();
}

async function api(method, path, body) {
  const url = `${CAMOFOX_URL}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (CAMOFOX_API_KEY) headers.Authorization = `Bearer ${CAMOFOX_API_KEY}`;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function downloadBinary(url, outPath) {
  const headers = {};
  if (CAMOFOX_API_KEY) headers.Authorization = `Bearer ${CAMOFOX_API_KEY}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(outPath));
}

// JS-evaluated fingerprint snapshot. Returned as a single object so we
// only pay one /evaluate round-trip. Wrapped in a try inside each
// sub-block so a single failing attribute doesn't kill the whole probe.
const FINGERPRINT_PROBE = `(() => {
  const safe = (fn, fallback) => { try { return fn(); } catch (e) { return { error: String(e.message || e) }; } };
  const out = {
    capturedAt: new Date().toISOString(),
    href: location.href,
    referrer: document.referrer,
    title: document.title,
    cookie: document.cookie || '',
    cookieCount: (document.cookie || '').split(';').filter(s => s.trim()).length,
    localStorageItems: safe(() => localStorage.length, null),
    sessionStorageItems: safe(() => sessionStorage.length, null),
    navigator: safe(() => ({
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      platform: navigator.platform,
      vendor: navigator.vendor,
      language: navigator.language,
      languages: Array.from(navigator.languages || []),
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      cookieEnabled: navigator.cookieEnabled,
      webdriver: navigator.webdriver,
      doNotTrack: navigator.doNotTrack,
      onLine: navigator.onLine,
    })),
    userAgentData: safe(() => navigator.userAgentData ? {
      brands: navigator.userAgentData.brands,
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform,
    } : null),
    screen: safe(() => ({
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
      orientation: screen.orientation && screen.orientation.type,
    })),
    devicePixelRatio: safe(() => window.devicePixelRatio),
    timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    intlLocale: safe(() => Intl.DateTimeFormat().resolvedOptions().locale),
    webgl: safe(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return { available: false };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        available: true,
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        version: gl.getParameter(gl.VERSION),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        antialias: gl.getContextAttributes() ? gl.getContextAttributes().antialias : null,
        extensions: gl.getSupportedExtensions(),
      };
    }),
    audioContext: safe(() => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return { available: false };
      const ac = new AC();
      const r = {
        available: true,
        sampleRate: ac.sampleRate,
        baseLatency: ac.baseLatency,
        outputLatency: ac.outputLatency,
        state: ac.state,
        destinationChannelCount: ac.destination ? ac.destination.channelCount : null,
        destinationMaxChannelCount: ac.destination ? ac.destination.maxChannelCount : null,
      };
      try { ac.close(); } catch {}
      return r;
    }),
    plugins: safe(() => Array.from(navigator.plugins || []).map(p => ({ name: p.name, filename: p.filename }))),
    mimeTypes: safe(() => Array.from(navigator.mimeTypes || []).map(m => ({ type: m.type, description: m.description }))),
    iframes: safe(() => Array.from(document.querySelectorAll('iframe')).map(f => ({
      src: f.src, name: f.name, id: f.id, width: f.width, height: f.height,
      visible: f.offsetWidth > 0 && f.offsetHeight > 0,
    }))),
    bodyText: safe(() => (document.body && document.body.innerText || '').slice(0, 4000)),
    documentReadyState: document.readyState,
    performanceNavigation: safe(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      if (!nav) return null;
      return {
        type: nav.type,
        redirectCount: nav.redirectCount,
        startTime: nav.startTime,
        domInteractive: nav.domInteractive,
        domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
        loadEventEnd: nav.loadEventEnd,
        responseStart: nav.responseStart,
        responseEnd: nav.responseEnd,
        transferSize: nav.transferSize,
        encodedBodySize: nav.encodedBodySize,
        decodedBodySize: nav.decodedBodySize,
      };
    }),
  };
  return out;
})()`;

function classifyOutcome({ navResult, postState, snapshot }) {
  const finalUrl = String(navResult.url || '').toLowerCase();
  const text = ((postState && postState.bodyText) || '').toLowerCase();
  const snapText = String(snapshot ? JSON.stringify(snapshot) : '').toLowerCase();
  const combined = text + ' ' + snapText;
  const iframeSrcs = (postState && postState.iframes || []).map(f => String(f.src || '').toLowerCase()).join(' ');

  if (combined.includes('network and device') || combined.includes('verify your device')) {
    return 'harder-challenge';
  }
  if (iframeSrcs.match(/awsc|punish|nocaptcha|baxia|captcha-prod/)) {
    return 'soft-slider';
  }
  if (combined.includes('slide to verify') || combined.includes('drag the slider') ||
      combined.includes('please complete the security check')) {
    return 'soft-slider';
  }
  if (combined.includes('too many attempts') || combined.includes('account locked') ||
      combined.includes('try again later')) {
    return 'login-refused';
  }
  if (finalUrl.includes('/login') || finalUrl.includes('/sign-in') ||
      finalUrl.includes('ug-login-page')) {
    return 'login-redirect';
  }
  if (combined.includes('day streak') || combined.includes('check-in') ||
      finalUrl.includes('/coin-index') || finalUrl.includes('/coin-pc-index')) {
    return 'no-gate';
  }
  return 'unknown';
}

async function runOnce(scenario, runIndex) {
  const stamp = ts();
  const userId = `poc-${scenario}-${runIndex}`;
  const sessionKey = `poc-${scenario}-${runIndex}`;
  const runDir = resolve(POC_DATA_ROOT, scenario, `run-${runIndex}-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const startWallClock = tsHuman();
  const startEpoch = Date.now();
  console.log(`[${ts()}] === scenario=${scenario} run=${runIndex}/${TARGET_RUNS} dir=${runDir}`);

  const manifest = {
    scenario, runIndex, userId, sessionKey,
    coinUrl: COIN_URL,
    camofoxUrl: CAMOFOX_URL,
    startedAt: startWallClock,
    finishedAt: null,
    elapsedSec: null,
    outcome: null,
    artifacts: {
      preFingerprint: 'pre-fingerprint.json',
      navigate: 'navigate.json',
      postState: 'post-state.json',
      snapshot: 'snapshot.json',
      screenshot1: 'screenshot-1.png',
      screenshot2: 'screenshot-2.png',
      camoufoxLogs: 'camoufox-logs.txt',
      tracesIndex: 'traces.json',
      tracesDir: 'traces/',
    },
  };

  // Capture sidecar logs from this point so we can extract the run window.
  const logCaptureCmd = ['logs', '--since', '1s', CAMOFOX_CONTAINER];

  // 1. Create tab (with trace if enabled)
  const tabReq = { userId, sessionKey, trace: ENABLE_TRACE };
  let tab;
  try {
    tab = await api('POST', '/tabs', tabReq);
  } catch (err) {
    manifest.outcome = `error:tab-create:${err.message.slice(0, 200)}`;
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  }
  manifest.tabId = tab.tabId;
  console.log(`[${ts()}] tab=${tab.tabId} (trace=${ENABLE_TRACE})`);

  // 2. Pre-navigation fingerprint snapshot. Camoufox starts at about:blank;
  //    grabbing the fingerprint here tells us what Camoufox claims to be
  //    before any site sees it. Compare across runs to verify rotation,
  //    compare to patchright to see what differs at the JS layer.
  try {
    const preFp = await api('POST', `/tabs/${tab.tabId}/evaluate`, {
      userId, expression: FINGERPRINT_PROBE,
    });
    writeFileSync(join(runDir, 'pre-fingerprint.json'), JSON.stringify(preFp, null, 2));
    console.log(`[${ts()}] pre-fingerprint captured: UA="${(preFp.result && preFp.result.navigator && preFp.result.navigator.userAgent || '').slice(0, 80)}"`);
  } catch (err) {
    console.log(`[${ts()}] pre-fingerprint failed: ${err.message}`);
    writeFileSync(join(runDir, 'pre-fingerprint.json'), JSON.stringify({ error: err.message }, null, 2));
  }

  // 3. Navigate
  let navResult = {};
  try {
    navResult = await api('POST', `/tabs/${tab.tabId}/navigate`, {
      userId, url: COIN_URL, waitUntil: 'domcontentloaded', timeoutMs: 60000,
    });
    console.log(`[${ts()}] navigate ok → ${navResult.url}`);
  } catch (err) {
    console.log(`[${ts()}] navigate failed: ${err.message}`);
    navResult = { error: err.message };
  }
  writeFileSync(join(runDir, 'navigate.json'), JSON.stringify(navResult, null, 2));

  // 4. First settle window — capture screenshot + snapshot
  await new Promise(r => setTimeout(r, SETTLE_MS_1));
  try {
    await downloadBinary(`${CAMOFOX_URL}/tabs/${tab.tabId}/screenshot?userId=${userId}&fullPage=true`, join(runDir, 'screenshot-1.png'));
  } catch (err) {
    console.log(`[${ts()}] screenshot-1 failed: ${err.message}`);
  }
  let snapshot = null;
  try {
    const snapRes = await fetch(`${CAMOFOX_URL}/tabs/${tab.tabId}/snapshot?userId=${userId}&format=tree`);
    if (snapRes.ok) {
      snapshot = await snapRes.json();
      writeFileSync(join(runDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    }
  } catch (err) {
    console.log(`[${ts()}] snapshot failed: ${err.message}`);
  }

  // 5. Second settle window + post-state
  await new Promise(r => setTimeout(r, SETTLE_MS_2 - SETTLE_MS_1));
  try {
    await downloadBinary(`${CAMOFOX_URL}/tabs/${tab.tabId}/screenshot?userId=${userId}&fullPage=true`, join(runDir, 'screenshot-2.png'));
  } catch (err) {
    console.log(`[${ts()}] screenshot-2 failed: ${err.message}`);
  }
  let postState = null;
  try {
    const r = await api('POST', `/tabs/${tab.tabId}/evaluate`, {
      userId, expression: FINGERPRINT_PROBE,
    });
    postState = r.result || r;
    writeFileSync(join(runDir, 'post-state.json'), JSON.stringify(postState, null, 2));
    console.log(`[${ts()}] post-state captured: cookies=${postState.cookieCount} iframes=${(postState.iframes || []).length} title="${postState.title || ''}"`);
    if (postState.iframes && postState.iframes.length) {
      for (const f of postState.iframes) console.log(`[${ts()}]   iframe: ${f.src || '(empty)'} ${f.visible ? '(visible)' : '(hidden)'}`);
    }
  } catch (err) {
    console.log(`[${ts()}] post-state failed: ${err.message}`);
    writeFileSync(join(runDir, 'post-state.json'), JSON.stringify({ error: err.message }, null, 2));
  }

  // 6. Classify outcome
  manifest.outcome = classifyOutcome({ navResult, postState, snapshot });
  manifest.finalUrl = navResult.url || '';
  console.log(`[${ts()}] outcome=${manifest.outcome}`);

  // 7. Close tab — should flush any trace to disk
  try {
    await api('DELETE', `/tabs/${tab.tabId}?userId=${userId}`);
  } catch (err) {
    console.log(`[${ts()}] tab close failed: ${err.message}`);
  }

  // 8. Download trace files for this session (if any were produced)
  try {
    const traces = await api('GET', `/sessions/${userId}/traces`);
    writeFileSync(join(runDir, 'traces.json'), JSON.stringify(traces, null, 2));
    const list = traces.files || traces.traces || (Array.isArray(traces) ? traces : []);
    if (list.length) {
      mkdirSync(join(runDir, 'traces'), { recursive: true });
      for (const t of list) {
        const filename = typeof t === 'string' ? t : (t.filename || t.name);
        if (!filename) continue;
        try {
          await downloadBinary(
            `${CAMOFOX_URL}/sessions/${userId}/traces/${encodeURIComponent(filename)}`,
            join(runDir, 'traces', filename)
          );
          console.log(`[${ts()}] trace downloaded: ${filename}`);
        } catch (err) {
          console.log(`[${ts()}] trace ${filename} download failed: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.log(`[${ts()}] traces list failed: ${err.message}`);
  }

  // 9. Capture sidecar container logs since run started. Best-effort —
  //    only works when docker CLI is reachable (e.g. running the runner
  //    from the host or with /var/run/docker.sock mounted). If unreachable,
  //    write a clear instruction so the user can capture them manually.
  try {
    const sinceTs = new Date(startEpoch - 2000).toISOString();
    const logCmd = spawnSync('docker', ['logs', '--since', sinceTs, CAMOFOX_CONTAINER], { encoding: 'utf8' });
    if (logCmd.error || logCmd.status !== 0) {
      writeFileSync(join(runDir, 'camoufox-logs.txt'),
        '# Sidecar log capture unavailable — docker CLI not reachable from where the runner ran.\n' +
        '# (Likely cause: runner running inside the FGC container, which does not ship docker CLI.)\n' +
        '#\n' +
        '# To capture manually from the host *while debugging this run*, run:\n' +
        `#   docker logs --since ${sinceTs} ${CAMOFOX_CONTAINER} > ${runDir}/camoufox-logs.txt\n` +
        '#\n' +
        `# spawnSync error: ${logCmd.error ? logCmd.error.message : 'exit ' + logCmd.status}\n`
      );
    } else {
      const logs = (logCmd.stdout || '') + '\n--- stderr ---\n' + (logCmd.stderr || '');
      writeFileSync(join(runDir, 'camoufox-logs.txt'), logs);
    }
  } catch (err) {
    writeFileSync(join(runDir, 'camoufox-logs.txt'), `# error capturing logs: ${err.message}\n# Run \`docker logs ${CAMOFOX_CONTAINER}\` from the host to capture manually.\n`);
  }

  // 10. Finalize manifest
  manifest.finishedAt = tsHuman();
  manifest.elapsedSec = Math.round((Date.now() - startEpoch) / 1000);
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return manifest;
}

function appendResultRow(manifest) {
  if (!existsSync(RESULTS_PATH)) {
    console.warn(`[${ts()}] Results file not found at ${RESULTS_PATH} — skipping append`);
    return;
  }
  const dir = manifest.artifacts ? `\`data/camoufox-poc/${manifest.scenario}/run-${manifest.runIndex}-*/\`` : '';
  const finalUrl = manifest.finalUrl || 'n/a';
  const row = `| ${manifest.startedAt} | ${manifest.scenario} | run ${manifest.runIndex} | ${manifest.outcome} | ${manifest.elapsedSec || 0}s | \`${finalUrl}\` | ${dir} |\n`;
  appendFileSync(RESULTS_PATH, row);
}

async function main() {
  console.log(`[${ts()}] Camoufox PoC runner — scenario=${SCENARIO} runs=${TARGET_RUNS} target=${CAMOFOX_URL} trace=${ENABLE_TRACE}`);

  // Sanity check the API is reachable before launching N runs.
  try {
    const health = await api('GET', '/health');
    console.log(`[${ts()}] health: engine=${health.engine} browserConnected=${health.browserConnected} memoryRssMb=${health.memory && health.memory.rssMb}`);
  } catch (err) {
    console.error(`[${ts()}] cannot reach camoufox at ${CAMOFOX_URL}: ${err.message}`);
    console.error('  Bring up the sidecar: docker compose -f docker-compose.yml -f docker-compose.experiments.yml up -d camoufox');
    process.exit(1);
  }

  // Make sure the artifact root exists.
  mkdirSync(POC_DATA_ROOT, { recursive: true });

  for (let i = 1; i <= TARGET_RUNS; i++) {
    try {
      const manifest = await runOnce(SCENARIO, i);
      appendResultRow(manifest);
      console.log(`[${ts()}] run ${i} complete — see data/camoufox-poc/${SCENARIO}/run-${i}-*/manifest.json`);
    } catch (err) {
      console.error(`[${ts()}] Run ${i} fatal: ${err.message}`);
      appendResultRow({
        runIndex: i, scenario: SCENARIO,
        startedAt: tsHuman(),
        outcome: `error: ${err.message.split('\n')[0]}`,
        elapsedSec: 0, finalUrl: '',
      });
    }
  }
  console.log(`[${ts()}] Done. Per-run artifacts under data/camoufox-poc/${SCENARIO}/`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
