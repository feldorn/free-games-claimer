// App-level config layer. Reads data/config.json (if present) and merges it
// over environment variables so the Settings tab can override docker env
// defaults without a container restart. Precedence per field:
//
//   app config (data/config.json)
//     ↓ falls through when undefined
//   process.env
//     ↓ falls through when missing or empty
//   hardcoded default (from CONFIG_SCHEMA)
//
// Fields not listed in CONFIG_SCHEMA stay env-only — credentials, infra
// paths, and flags that only affect already-running processes live there.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Compute the data-dir path directly instead of importing dataDir from util.js.
// util.js itself imports cfg from config.js (for top-level enquirer setup),
// and config.js is now our caller — importing from util.js here recreates the
// cycle and dataDir ends up in TDZ when we need it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(__dirname, '..', 'data', 'config.json');

const toBool = v => v === '1' || v === 'true' || v === true;
// EG_MOBILE is inverted in the original: absent or truthy → true, only '0'/'false' → false.
const toBoolDefaultTrue = v => v !== '0' && v !== 'false' && v !== false && v !== 0;

export const CONFIG_SCHEMA = [
  // scheduler
  { path: 'scheduler.loopSeconds',     env: 'LOOP',              type: 'number',  default: 0, coerce: v => Number(v) || 0 },
  { path: 'scheduler.msScheduleHours', env: 'MS_SCHEDULE_HOURS', type: 'number',  default: 0, coerce: v => Number(v) || 0 },
  { path: 'scheduler.msScheduleStart', env: 'MS_SCHEDULE_START', type: 'number',  default: 8, coerce: v => Number(v) || 0 },
  // notifications + panel URL
  { path: 'notifications.notify',      env: 'NOTIFY',       type: 'string', default: '' },
  { path: 'notifications.notifyTitle', env: 'NOTIFY_TITLE', type: 'string', default: '' },
  { path: 'panel.publicUrl',           env: 'PUBLIC_URL',   type: 'string', default: '' },
  // advanced / debug
  { path: 'advanced.dryrun',          env: 'DRYRUN',        type: 'boolean', default: false, coerce: toBool },
  { path: 'advanced.record',          env: 'RECORD',        type: 'boolean', default: false, coerce: toBool },
  { path: 'advanced.timeoutSec',      env: 'TIMEOUT',       type: 'number',  default: 60,   coerce: v => Number(v) || 60 },
  { path: 'advanced.loginTimeoutSec', env: 'LOGIN_TIMEOUT', type: 'number',  default: 180,  coerce: v => Number(v) || 180 },
  { path: 'advanced.width',           env: 'WIDTH',         type: 'number',  default: 1920, coerce: v => Number(v) || 1920 },
  { path: 'advanced.height',          env: 'HEIGHT',        type: 'number',  default: 1080, coerce: v => Number(v) || 1080 },
  // per-service
  { path: 'services.prime-gaming.redeem',       env: 'PG_REDEEM',        type: 'boolean', default: false, coerce: toBool },
  { path: 'services.prime-gaming.claimDlc',     env: 'PG_CLAIMDLC',      type: 'boolean', default: false, coerce: toBool },
  { path: 'services.prime-gaming.timeLeftDays', env: 'PG_TIMELEFT',      type: 'number',  default: null, nullable: true, coerce: v => (v === '' || v == null) ? null : Number(v) },
  { path: 'services.epic-games.claimMobile',    env: 'EG_MOBILE',        type: 'boolean', default: true,  coerce: toBoolDefaultTrue },
  { path: 'services.gog.keepNewsletter',        env: 'GOG_NEWSLETTER',   type: 'boolean', default: false, coerce: toBool },
  { path: 'services.steam.minRating',           env: 'STEAM_MIN_RATING', type: 'number',  default: 6,  coerce: v => Number(v) || 6 },
  { path: 'services.steam.minPrice',            env: 'STEAM_MIN_PRICE',  type: 'number',  default: 10, coerce: v => Number(v) || 10 },
  { path: 'services.microsoft.searchDelayMaxSec', env: 'MS_SEARCH_DELAY_MAX_SEC', type: 'number', default: 180, coerce: v => Math.max(1, Number(v) || 180) },
  // Per-service "active" flag — controls whether the Sessions card shows,
  // whether auto-check/Check All probe it, and whether the claim runner
  // invokes the script. Six traditional services default to active; any new
  // opt-in service (AliExpress today, others later) defaults to inactive.
  { path: 'services.prime-gaming.active',       env: 'PG_ACTIVE',        type: 'boolean', default: true,  coerce: toBool },
  { path: 'services.epic-games.active',         env: 'EG_ACTIVE',        type: 'boolean', default: true,  coerce: toBool },
  { path: 'services.gog.active',                env: 'GOG_ACTIVE',       type: 'boolean', default: true,  coerce: toBool },
  { path: 'services.steam.active',              env: 'STEAM_ACTIVE',     type: 'boolean', default: true,  coerce: toBool },
  { path: 'services.microsoft.active',          env: 'MS_ACTIVE',        type: 'boolean', default: true,  coerce: toBool },
  { path: 'services.microsoft-mobile.active',   env: 'MS_MOBILE_ACTIVE', type: 'boolean', default: true,  coerce: toBool },
  { path: 'services.aliexpress.active',         env: 'AE_ACTIVE',        type: 'boolean', default: false, coerce: toBool },
  { path: 'services.ubisoft.active',            env: 'UBISOFT_ACTIVE',   type: 'boolean', default: false, coerce: toBool },
];

const schemaByPath = new Map(CONFIG_SCHEMA.map(f => [f.path, f]));

export function readConfigFile() {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    const raw = readFileSync(CONFIG_FILE, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw) || {};
  } catch (e) {
    console.error(`[config] failed to read ${CONFIG_FILE}: ${e.message} — treating as empty`);
    return {};
  }
}

// Silent migration: aliexpress.enabled was the earlier name for
// aliexpress.active. Translate on disk whenever we see the legacy key. Runs
// on every describeConfig call because the config file can be replaced at
// runtime (user restores from backup, swaps it out, etc.) — the cost is one
// extra read when there's nothing to do.
function migrateLegacyKeys() {
  const app = readConfigFile();
  const ae = app.services && app.services.aliexpress;
  if (!ae || ae.enabled === undefined) return;
  if (ae.active === undefined) {
    ae.active = !!ae.enabled;
    delete ae.enabled;
    try {
      writeConfigFile(app);
      console.log('[config] migrated services.aliexpress.enabled → services.aliexpress.active');
    } catch (e) {
      console.error('[config] migration write failed:', e.message);
    }
  } else {
    // Both were set — the new key wins; drop the legacy one.
    delete ae.enabled;
    try { writeConfigFile(app); } catch {}
  }
}

// Atomic write: serialize to a tempfile in the same dir, then rename. A crash
// mid-write leaves the old file intact rather than half-truncated.
export function writeConfigFile(obj) {
  const dir = path.dirname(CONFIG_FILE);
  try { mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
  const tmp = CONFIG_FILE + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, CONFIG_FILE);
}

export function getByPath(obj, p) {
  const parts = p.split('.');
  let node = obj;
  for (const k of parts) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[k];
  }
  return node;
}

export function setByPath(obj, p, value) {
  const parts = p.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!node[k] || typeof node[k] !== 'object') node[k] = {};
    node = node[k];
  }
  node[parts[parts.length - 1]] = value;
}

// Delete a path and prune empty parent objects so the file stays clean.
export function deleteByPath(obj, p) {
  const parts = p.split('.');
  const stack = [];
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') return;
    stack.push(node);
    node = node[parts[i]];
  }
  delete node[parts[parts.length - 1]];
  for (let i = stack.length - 1; i >= 0; i--) {
    const parent = stack[i];
    const key = parts[i];
    if (parent[key] && typeof parent[key] === 'object' && Object.keys(parent[key]).length === 0) {
      delete parent[key];
    }
  }
}

function resolveField(field, appConfig) {
  const appVal = getByPath(appConfig, field.path);
  const envRaw = process.env[field.env];
  const hasApp = appVal !== undefined;
  const hasEnv = envRaw !== undefined && envRaw !== '';
  let effective, source;
  if (hasApp)      { effective = appVal;  source = 'app'; }
  else if (hasEnv) { effective = field.coerce ? field.coerce(envRaw) : envRaw; source = 'env'; }
  else             { effective = field.default; source = 'default'; }
  return { appValue: hasApp ? appVal : null, envValue: hasEnv ? envRaw : null, effective, source };
}

// Produce everything the API and cfg loader both need in one pass.
export function describeConfig() {
  migrateLegacyKeys();
  const appConfig = readConfigFile();
  const effective = {};
  const fields = CONFIG_SCHEMA.map(f => {
    const r = resolveField(f, appConfig);
    setByPath(effective, f.path, r.effective);
    return {
      path: f.path,
      envVar: f.env,
      type: f.type,
      default: f.default,
      nullable: !!f.nullable,
      appValue: r.appValue,
      envValue: r.envValue,
      effective: r.effective,
      source: r.source,
      overridden: r.source === 'app',
    };
  });
  return { app: appConfig, effective, fields };
}

// Apply { path: value } patches. value === null deletes the override.
// Every env var the app reads that isn't already exposed as a writable
// setting in CONFIG_SCHEMA. Shown read-only in the Environment section of
// the Settings tab so the user can see what docker is handing the app
// without logging into the container. Anything whose name matches
// SENSITIVE_PATTERN gets credential-masked treatment (hidden by default,
// last-4 chars only when explicitly revealed).
export const ENV_DISPLAY = [
  // panel infrastructure (env-only — changing any of these needs a restart)
  { env: 'PANEL_PORT',     category: 'panel',  label: 'Panel port' },
  { env: 'NOVNC_PORT',     category: 'panel',  label: 'noVNC port' },
  { env: 'BASE_PATH',      category: 'panel',  label: 'Base path (reverse-proxy subfolder)' },
  { env: 'PANEL_PASSWORD', category: 'panel',  label: 'Panel password' },
  { env: 'VNC_PASSWORD',   category: 'panel',  label: 'VNC password' },
  // data paths
  { env: 'BROWSER_DIR',     category: 'paths', label: 'Browser profile dir' },
  { env: 'SCREENSHOTS_DIR', category: 'paths', label: 'Screenshots dir' },
  // credentials — env-only by design, grouped by service for readability
  { env: 'EMAIL',          category: 'credentials', group: 'Shared fallbacks', label: 'Default email' },
  { env: 'PASSWORD',       category: 'credentials', group: 'Shared fallbacks', label: 'Default password' },
  { env: 'EG_EMAIL',       category: 'credentials', group: 'Epic Games',       label: 'Email' },
  { env: 'EG_PASSWORD',    category: 'credentials', group: 'Epic Games',       label: 'Password' },
  { env: 'EG_OTPKEY',      category: 'credentials', group: 'Epic Games',       label: 'OTP key' },
  { env: 'EG_PARENTALPIN', category: 'credentials', group: 'Epic Games',       label: 'Parental PIN' },
  { env: 'PG_EMAIL',       category: 'credentials', group: 'Prime Gaming',     label: 'Email' },
  { env: 'PG_PASSWORD',    category: 'credentials', group: 'Prime Gaming',     label: 'Password' },
  { env: 'PG_OTPKEY',      category: 'credentials', group: 'Prime Gaming',     label: 'OTP key' },
  { env: 'GOG_EMAIL',      category: 'credentials', group: 'GOG',              label: 'Email' },
  { env: 'GOG_PASSWORD',   category: 'credentials', group: 'GOG',              label: 'Password' },
  { env: 'STEAM_EMAIL',    category: 'credentials', group: 'Steam',            label: 'Email' },
  { env: 'STEAM_PASSWORD', category: 'credentials', group: 'Steam',            label: 'Password' },
  { env: 'MS_EMAIL',       category: 'credentials', group: 'Microsoft Rewards',label: 'Email' },
  { env: 'MS_PASSWORD',    category: 'credentials', group: 'Microsoft Rewards',label: 'Password' },
  { env: 'MS_OTPKEY',      category: 'credentials', group: 'Microsoft Rewards',label: 'OTP key' },
  { env: 'LG_EMAIL',       category: 'credentials', group: 'Legacy Games',     label: 'Email',
    note: 'Only used when PG_REDEEM is enabled and a Prime Gaming code lands on the Legacy Games store. Falls back to PG_EMAIL then EMAIL.' },
  { env: 'AE_EMAIL',       category: 'credentials', group: 'AliExpress',       label: 'Email',
    note: 'Only used when AliExpress is enabled. Only needed for automated re-login — you can also log in manually via the Sessions card and cookies persist.' },
  { env: 'AE_PASSWORD',    category: 'credentials', group: 'AliExpress',       label: 'Password' },
  // runtime/debug flags
  { env: 'DEBUG',         category: 'debug', label: 'DEBUG' },
  { env: 'DEBUG_NETWORK', category: 'debug', label: 'DEBUG_NETWORK' },
  { env: 'TIME',          category: 'debug', label: 'TIME' },
  { env: 'INTERACTIVE',   category: 'debug', label: 'INTERACTIVE' },
  { env: 'NOWAIT',        category: 'debug', label: 'NOWAIT' },
  { env: 'SHOW',          category: 'debug', label: 'SHOW' },
];

const SENSITIVE_PATTERN = /password|otpkey|token|secret|key$/i;

function maskLast4(s) {
  if (typeof s !== 'string' || !s) return '';
  if (s.length <= 4) return '•'.repeat(s.length);
  return '••••••' + s.slice(-4);
}

// Live scheduler config read — bypasses the module-level cfg so the scheduler
// loop (which lives in interactive-login.js) can re-read after a config save
// and reschedule without a panel restart.
export function getSchedulerConfig() {
  const s = describeConfig().effective.scheduler || {};
  return {
    loop:    s.loopSeconds     ?? 0,
    msHours: s.msScheduleHours ?? 0,
    msStart: s.msScheduleStart ?? 8,
  };
}

// Absolute path to the config file — scheduler's fs.watch targets this.
export const CONFIG_FILE_PATH = CONFIG_FILE;

// Produce the list shown in the Environment section. `reveal=true` returns
// last-4-masked values for sensitive vars; otherwise only `{set: true|false}`
// is exposed for sensitive ones.
export function describeEnv({ reveal = false } = {}) {
  return ENV_DISPLAY.map(e => {
    const raw = process.env[e.env];
    const set = raw !== undefined && raw !== '';
    const sensitive = SENSITIVE_PATTERN.test(e.env);
    let value = null;
    if (set) {
      if (!sensitive) value = raw;
      else if (reveal) value = maskLast4(raw);
    }
    return { env: e.env, label: e.label, category: e.category, group: e.group || null, note: e.note || null, set, sensitive, value };
  });
}

export function patchConfig(patches) {
  const app = readConfigFile();
  const errors = [];
  for (const [p, value] of Object.entries(patches)) {
    const field = schemaByPath.get(p);
    if (!field) { errors.push({ path: p, error: 'unknown setting' }); continue; }
    if (value === null) { deleteByPath(app, p); continue; }
    if (field.type === 'number' && typeof value !== 'number') {
      errors.push({ path: p, error: 'expected number, got ' + typeof value }); continue;
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') {
      errors.push({ path: p, error: 'expected boolean, got ' + typeof value }); continue;
    }
    if (field.type === 'string' && typeof value !== 'string') {
      errors.push({ path: p, error: 'expected string, got ' + typeof value }); continue;
    }
    setByPath(app, p, value);
  }
  if (errors.length === 0) writeConfigFile(app);
  return { errors };
}
