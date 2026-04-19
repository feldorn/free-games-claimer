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
