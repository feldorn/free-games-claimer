// Tier-2 integration test for the PlayStation Plus collector.
//
// Spawns `node interactive-login.js` as a child process on a NON-DEFAULT
// port (7099) so it doesn't collide with a panel the user may be running
// locally. Polls /api/health until 200, then exercises:
//   - GET /api/config         — PS Plus fields present + correct defaults
//   - GET /api/state          — PS Plus appears in `sites`
//   - PUT /api/config         — toggle PSP_ACTIVE on/off
//   - PUT /api/config         — adjust maxClaimsPerRun, confirm via GET
//
// All mutations are reverted before exit. The data/config.json file is
// snapshotted and restored on pass OR fail (the panel's PUT writes here).
// Panel is SIGTERM'd at the end.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PSP_TEST_PORT) || 7099;
const BASE = `http://127.0.0.1:${PORT}`;
const CONFIG_FILE = path.resolve('data/config.json');
const SNAPSHOT = CONFIG_FILE + '.test-snapshot';

let panelProc = null;
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; }
  else { fail++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Snapshot data/config.json so we can restore on exit.
let hadConfigFile = false;
if (existsSync(CONFIG_FILE)) {
  hadConfigFile = true;
  writeFileSync(SNAPSHOT, readFileSync(CONFIG_FILE));
}

const cleanup = () => {
  if (panelProc && !panelProc.killed) {
    try { panelProc.kill('SIGTERM'); } catch { /* ignore */ }
  }
  if (hadConfigFile && existsSync(SNAPSHOT)) {
    writeFileSync(CONFIG_FILE, readFileSync(SNAPSHOT));
    unlinkSync(SNAPSHOT);
  } else if (!hadConfigFile && existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE);
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

// --- Boot the panel ----------------------------------------------------
console.log(`Spawning panel on port ${PORT}…`);
panelProc = spawn(process.execPath, ['interactive-login.js'], {
  env: {
    ...process.env,
    PANEL_PORT: String(PORT),
    UPDATE_CHECK: '0',          // disable GitHub poll for the duration
    PANEL_PASSWORD: '',         // unauthenticated for the test
    LOOP: '0',                  // do not schedule any claim runs
    RUN_ON_STARTUP: '0',        // explicit, in case env carried over
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

// Buffer panel stderr so we can surface failures.
let panelStderr = '';
panelProc.stderr.on('data', d => { panelStderr += d.toString(); });
panelProc.stdout.on('data', () => { /* discard — too chatty */ });

panelProc.on('exit', (code, signal) => {
  if (code !== null && code !== 0 && code !== 143 && !panelProc._intentional) {
    console.error(`Panel exited unexpectedly: code=${code} signal=${signal}`);
    if (panelStderr) console.error('Panel stderr:', panelStderr.slice(0, 2000));
  }
});

// --- Wait for /api/health ----------------------------------------------
const healthDeadline = Date.now() + 30000;
let healthy = false;
while (Date.now() < healthDeadline) {
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) {
      const j = await r.json();
      if (j.ok) { healthy = true; break; }
    }
  } catch { /* not ready yet */ }
  await new Promise(r => setTimeout(r, 500));
}
check('panel /api/health 200 within 30s', healthy, panelStderr ? panelStderr.slice(0, 400) : 'timed out');

if (!healthy) {
  console.error(`\nps-panel-api tests: ${pass}/${pass + fail} OK (aborted — panel never became healthy)`);
  panelProc._intentional = true;
  panelProc.kill('SIGTERM');
  process.exit(1);
}

// --- GET /api/config — PS Plus fields present + correct defaults -------
const configRes = await fetch(`${BASE}/api/config`);
check('/api/config returns 200', configRes.ok, `status ${configRes.status}`);
const config = await configRes.json();
check('/api/config has effective object', !!config.effective);
check('/api/config has fields array', Array.isArray(config.fields));

const expectedPaths = [
  'services.playstation-plus.active',
  'services.playstation-plus.maxClaimsPerRun',
  'services.playstation-plus.claimPauseMinSec',
  'services.playstation-plus.claimPauseMaxSec',
];
for (const p of expectedPaths) {
  check(`/api/config fields contains ${p}`, !!config.fields?.find(f => f.path === p));
}

const expectedDefaults = {
  'services.playstation-plus.active': false,
  'services.playstation-plus.maxClaimsPerRun': 5,
  'services.playstation-plus.claimPauseMinSec': 25,
  'services.playstation-plus.claimPauseMaxSec': 35,
};
for (const [p, expected] of Object.entries(expectedDefaults)) {
  const f = config.fields?.find(f => f.path === p);
  check(`/api/config default ${p} === ${JSON.stringify(expected)}`,
    f?.default === expected, `actual ${JSON.stringify(f?.default)}`);
}

// --- GET /api/state — PS Plus appears in sites -------------------------
const stateRes = await fetch(`${BASE}/api/state`);
check('/api/state returns 200', stateRes.ok, `status ${stateRes.status}`);
const state = await stateRes.json();
check('/api/state has sites array',
  Array.isArray(state.sites));
const pspSite = (state.sites || []).find(s => s?.id === 'playstation-plus');
check('/api/state sites array includes id="playstation-plus"',
  !!pspSite,
  `ids found: ${(state.sites || []).map(s => s?.id).join(',')}`);

// --- PUT /api/config — toggle PSP_ACTIVE on then off -------------------
const putOn = await fetch(`${BASE}/api/config`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 'services.playstation-plus.active': true }),
});
check('PUT /api/config (active: true) returns 2xx', putOn.ok, `status ${putOn.status}`);

// Confirm via re-GET.
const reGet1 = await fetch(`${BASE}/api/config`).then(r => r.json());
check('After PUT active=true, effective.services["playstation-plus"].active === true',
  reGet1.effective?.services?.['playstation-plus']?.active === true,
  `actual ${reGet1.effective?.services?.['playstation-plus']?.active}`);

// Revert.
const putOff = await fetch(`${BASE}/api/config`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 'services.playstation-plus.active': null }),
});
check('PUT /api/config (active: null) returns 2xx', putOff.ok, `status ${putOff.status}`);

const reGet2 = await fetch(`${BASE}/api/config`).then(r => r.json());
check('After PUT active=null, effective is back to default false',
  reGet2.effective?.services?.['playstation-plus']?.active === false,
  `actual ${reGet2.effective?.services?.['playstation-plus']?.active}`);

// --- PUT /api/config — adjust maxClaimsPerRun, then revert -------------
const putNum = await fetch(`${BASE}/api/config`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 'services.playstation-plus.maxClaimsPerRun': 7 }),
});
check('PUT maxClaimsPerRun=7 returns 2xx', putNum.ok);

const reGet3 = await fetch(`${BASE}/api/config`).then(r => r.json());
check('After PUT, maxClaimsPerRun is 7',
  reGet3.effective?.services?.['playstation-plus']?.maxClaimsPerRun === 7);

const f3 = reGet3.fields?.find(f => f.path === 'services.playstation-plus.maxClaimsPerRun');
check('source after override === "app"', f3?.source === 'app');

await fetch(`${BASE}/api/config`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 'services.playstation-plus.maxClaimsPerRun': null }),
});

// --- Tear down ---------------------------------------------------------
panelProc._intentional = true;
panelProc.kill('SIGTERM');
await new Promise(resolve => panelProc.on('exit', resolve));

console.log(`\nps-panel-api tests: ${pass}/${pass + fail} OK`);
process.exit(fail === 0 ? 0 : 1);
