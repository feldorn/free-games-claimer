// Tier-1 config-schema tests for the PlayStation Plus collector.
//
// Imports src/app-config.js directly (no panel boot, no HTTP). Asserts that
// the registry entry in src/sites.js correctly surfaces PS Plus in the
// effective config + fields[] output of describeConfig(), and that
// patchConfig round-trips through data/config.json.
//
// Snapshots data/config.json before mutating it and restores from the
// snapshot on exit — pass OR fail. Safe to run alongside a live panel
// process, but you'll see the test's patches briefly land in the file.

// Import util.js FIRST to make it the entry of the circular dep cycle.
// The runner scripts (playstation-plus.js, epic-games.js, etc.) all import
// util.js before config.js, which means util.js sits at the cycle entry and
// its body runs only AFTER config.js has finished defining `cfg`. If we
// import app-config.js (or any of its transitive deps) first, util.js ends
// up as a leaf of the cycle and tries to read `cfg` before it's initialized.
import '../src/util.js';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { describeConfig, patchConfig, CONFIG_FILE_PATH } from '../src/app-config.js';

const CONFIG_FILE = path.resolve(CONFIG_FILE_PATH);
const snapshotPath = CONFIG_FILE + '.test-snapshot';

// Snapshot data/config.json (or note that it doesn't exist yet).
let hadFile = false;
if (existsSync(CONFIG_FILE)) {
  hadFile = true;
  writeFileSync(snapshotPath, readFileSync(CONFIG_FILE));
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; }
  else { fail++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

// --- Schema presence (4 PS Plus settings) -------------------------------
const { effective, fields } = describeConfig();
const pspPaths = [
  'services.playstation-plus.active',
  'services.playstation-plus.maxClaimsPerRun',
  'services.playstation-plus.claimPauseMinSec',
  'services.playstation-plus.claimPauseMaxSec',
];
for (const p of pspPaths) {
  check(`schema-presence ${p}`, !!fields.find(f => f.path === p));
}

// --- Defaults ------------------------------------------------------------
const defaults = {
  'services.playstation-plus.active': false,
  'services.playstation-plus.maxClaimsPerRun': 5,
  'services.playstation-plus.claimPauseMinSec': 25,
  'services.playstation-plus.claimPauseMaxSec': 35,
};
for (const [p, expected] of Object.entries(defaults)) {
  const f = fields.find(f => f.path === p);
  check(`default ${p} === ${JSON.stringify(expected)}`, f?.default === expected, `actual ${JSON.stringify(f?.default)}`);
}

// --- Env-var names match the spec --------------------------------------
const envVars = {
  'services.playstation-plus.active': 'PSP_ACTIVE',
  'services.playstation-plus.maxClaimsPerRun': 'PSP_MAX_CLAIMS_PER_RUN',
  'services.playstation-plus.claimPauseMinSec': 'PSP_CLAIM_PAUSE_MIN_SEC',
  'services.playstation-plus.claimPauseMaxSec': 'PSP_CLAIM_PAUSE_MAX_SEC',
};
for (const [p, expectedEnv] of Object.entries(envVars)) {
  const f = fields.find(f => f.path === p);
  check(`envVar ${p} === ${expectedEnv}`, f?.envVar === expectedEnv, `actual ${f?.envVar}`);
}

// --- Effective config shape (registry-derived) -------------------------
check('effective.services["playstation-plus"] is present',
  !!effective.services?.['playstation-plus']);
check('effective.services["playstation-plus"].maxClaimsPerRun === 5',
  effective.services?.['playstation-plus']?.maxClaimsPerRun === 5);

// --- Round-trip a numeric setting through patchConfig ------------------
const patch1 = patchConfig({ 'services.playstation-plus.maxClaimsPerRun': 13 });
check('patchConfig numeric: no errors', patch1.errors.length === 0, JSON.stringify(patch1.errors));
const after1 = describeConfig();
check('patchConfig numeric: effective is 13',
  after1.effective.services?.['playstation-plus']?.maxClaimsPerRun === 13,
  `actual ${after1.effective.services?.['playstation-plus']?.maxClaimsPerRun}`);
check('patchConfig numeric: source is "app"',
  after1.fields.find(f => f.path === 'services.playstation-plus.maxClaimsPerRun')?.source === 'app');

// Revert
const patch2 = patchConfig({ 'services.playstation-plus.maxClaimsPerRun': null });
check('patchConfig null: no errors', patch2.errors.length === 0);
const after2 = describeConfig();
check('patchConfig null: effective back to default 5',
  after2.effective.services?.['playstation-plus']?.maxClaimsPerRun === 5);

// --- Round-trip the active toggle (boolean) -----------------------------
const patch3 = patchConfig({ 'services.playstation-plus.active': true });
check('patchConfig boolean: no errors', patch3.errors.length === 0);
const after3 = describeConfig();
check('patchConfig boolean: active is true',
  after3.effective.services?.['playstation-plus']?.active === true);
patchConfig({ 'services.playstation-plus.active': null });

// --- Type validation: numeric field rejects string -----------------------
const patchBadType = patchConfig({ 'services.playstation-plus.maxClaimsPerRun': '13' });
check('patchConfig type-mismatch: error reported',
  patchBadType.errors.length === 1
  && patchBadType.errors[0].path === 'services.playstation-plus.maxClaimsPerRun'
  && /expected number/.test(patchBadType.errors[0].error),
  JSON.stringify(patchBadType.errors));

// --- Restore the snapshot ------------------------------------------------
if (hadFile) {
  writeFileSync(CONFIG_FILE, readFileSync(snapshotPath));
  unlinkSync(snapshotPath);
} else if (existsSync(CONFIG_FILE)) {
  // The test created config.json from nothing; remove to leave clean state.
  unlinkSync(CONFIG_FILE);
}

console.log(`\nps-config-schema tests: ${pass}/${pass + fail} OK`);
process.exit(fail === 0 ? 0 : 1);
