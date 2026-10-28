// epicAccountSession / classifyAccountProbe / epicSessionVerdict — run with
// `node test/epic-session.js`. Cookie sets mirror a working profile (store +
// account cookies) and Sharpyku's failing one from #163 (store cookies only).
// Probe bodies are the shapes /id/api/account returned on 2026-10-24.
import { epicAccountSession, classifyAccountProbe, accountProbeErrorCode, epicSessionVerdict, epicImportMissingSessionReason } from '#src/epic-session.js';

const NOW = Date.UTC(2026, 9, 23, 12, 0);
const sec = ms => Math.floor(ms / 1000);
const HOUR = 3600 * 1000;
const c = (name, domain, expiresMs) => ({ name, domain, expires: expiresMs == null ? -1 : sec(expiresMs) });

const store = [
  c('EPIC_EG1', '.store.epicgames.com', NOW + 8 * HOUR),
  c('REFRESH_EPIC_EG1', '.store.epicgames.com', NOW + 365 * 24 * HOUR),
];
const sso = c('EPIC_SSO', '.epicgames.com', NOW + 8 * HOUR);
const ssoExpired = c('EPIC_SSO', '.epicgames.com', NOW - HOUR);
const rm = c('EPIC_SSO_RM', '.epicgames.com', NOW + 365 * 24 * HOUR);

const cases = [
  ['store cookies only (#163 failing profile)', store, { ok: false, remembered: false, expiresAt: null }],
  ['working profile mid-day (SSO + RM)', [...store, sso, rm], { ok: true, remembered: true, expiresAt: null }],
  ['working profile between runs (SSO expired, RM live)', [...store, ssoExpired, rm], { ok: true, remembered: true, expiresAt: null }],
  ['fresh login without remember-me', [...store, sso], { ok: true, remembered: false, expiresAt: new Date(sec(NOW + 8 * HOUR) * 1000).toISOString() }],
  ['not-remembered session after expiry', [...store, ssoExpired], { ok: false, remembered: false, expiresAt: null }],
  ['session cookie (expires -1) counts', [c('EPIC_SSO', '.epicgames.com', null)], { ok: true, remembered: false, expiresAt: null }],
  ['wrong domain ignored', [c('EPIC_SSO_RM', '.evil-epicgames.com', NOW + HOUR)], { ok: false, remembered: false, expiresAt: null }],
  ['empty / null input', null, { ok: false, remembered: false, expiresAt: null }],
];

let fails = 0;
for (const [label, cookies, expected] of cases) {
  const r = epicAccountSession(cookies, NOW);
  const got = { ok: r.ok, remembered: r.remembered, expiresAt: r.expiresAt && r.expiresAt.toISOString() };
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    console.error(`FAIL  ${label} → ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    fails++;
  }
}

const probeCases = [
  ['200 account JSON', 200, '{"id":"abc","displayName":"x","accountStatus":"ACTIVE"}', 'live'],
  ['401 unauthorized', 401, '{"errorCode":"errors.com.epicgames.unauthorized","message":"You are not authenticated. Please authenticate."}', 'dead'],
  ['403 Epic error JSON', 403, '{"errorCode":"errors.com.epicgames.common.missing_permission"}', 'dead'],
  ['403 Cloudflare challenge', 403, '<html><head><style>.cf_challenge_text_small{}</style>', 'unknown'],
  ['200 without id', 200, '{}', 'unknown'],
  ['503', 503, 'upstream error', 'unknown'],
  ['401 non-JSON', 401, 'Unauthorized', 'unknown'],
];
for (const [label, status, body, expected] of probeCases) {
  const got = classifyAccountProbe(status, body);
  if (got !== expected) { console.error(`FAIL  probe ${label} → ${got}, expected ${expected}`); fails++; }
}

const errorCodeCases = [
  ['401 Epic error', '{"errorCode":"errors.com.epicgames.unauthorized","message":"x"}', 'errors.com.epicgames.unauthorized'],
  ['Cloudflare HTML', '<html>', null],
  ['non-Epic errorCode', '{"errorCode":"<script>"}', null],
  ['200 account JSON', '{"id":"abc"}', null],
];
for (const [label, body, expected] of errorCodeCases) {
  const got = accountProbeErrorCode(body);
  if (got !== expected) { console.error(`FAIL  errorCode ${label} → ${got}, expected ${expected}`); fails++; }
}

const acct = cookies => epicAccountSession(cookies, NOW);
const verdictCases = [
  // Dr4w (#163): RM present, Epic still rejects → signed out with a reason.
  ['RM present, Epic rejects', acct([...store, rm]), { state: 'dead', status: 401 }, { ok: false, reason: /rejected.*HTTP 401/, warning: null }],
  ['Epic rejects with errorCode', acct([...store, rm]), { state: 'dead', status: 401, errorCode: 'errors.com.epicgames.unauthorized' }, { ok: false, reason: /HTTP 401, errors\.com\.epicgames\.unauthorized\)/, warning: null }],
  // Live EPIC_SESSION_AP with no SSO cookie authenticates → not signed out.
  ['no SSO cookies, Epic accepts', acct(store), { state: 'live', status: 200 }, { ok: true, reason: null, warning: /isn't remembered/ }],
  ['SSO + RM, Epic accepts', acct([...store, sso, rm]), { state: 'live', status: 200 }, { ok: true, reason: null, warning: null }],
  ['probe unknown, cookies missing → cookie verdict', acct(store), { state: 'unknown', status: 403 }, { ok: false, reason: /no EPIC_SSO.*EPIC_SESSION_AP/, warning: null }],
  ['probe unknown, RM present → ok', acct([...store, rm]), { state: 'unknown', status: null }, { ok: true, reason: null, warning: null }],
  // davidcoulson (#163): EPIC_SESSION_AP survives Epic clearing SSO/RM.
  ['probe unknown, SESSION_AP only → ok', acct([...store, c('EPIC_SESSION_AP', '.epicgames.com', null)]), { state: 'unknown', status: null }, { ok: true, reason: null, warning: /isn't remembered/ }],
  ['SESSION_AP left after a 401 → dead', acct([...store, c('EPIC_SESSION_AP', '.epicgames.com', null)]), { state: 'dead', status: 401 }, { ok: false, reason: /HTTP 401/, warning: null }],
  ['probe unknown, SSO only → ok + warning', acct([...store, sso]), { state: 'unknown', status: 503 }, { ok: true, reason: null, warning: /isn't remembered/ }],
];
const matches = (v, want) => want === null ? v == null : want.test(String(v));
for (const [label, a, probe, want] of verdictCases) {
  const v = epicSessionVerdict(a, probe);
  if (v.ok !== want.ok || !matches(v.reason, want.reason) || !matches(v.warning, want.warning)) {
    console.error(`FAIL  verdict ${label} → ${JSON.stringify(v)}`);
    fails++;
  }
}

// #162/#163: a store-tab export lacks the /id-scoped EPIC_SESSION_AP.
const sessionAp = { name: 'EPIC_SESSION_AP', value: 'x', domain: '.epicgames.com', path: '/id', expires: -1 };
const importCases = [
  ['store-tab export (store + SSO + RM)', [...store, sso, rm], /no EPIC_SESSION_AP.*\/id\/api\/account/],
  ['export with EPIC_SESSION_AP', [...store, sso, rm, sessionAp], null],
  ['empty upload', [], /no EPIC_SESSION_AP/],
];
for (const [label, cookies, want] of importCases) {
  const got = epicImportMissingSessionReason(cookies);
  if (!matches(got, want)) { console.error(`FAIL  import ${label} → ${got}`); fails++; }
}

if (fails) {
  console.error(`${fails} failure(s)`);
  process.exit(1);
}
console.log(`epic-session: ${cases.length + probeCases.length + verdictCases.length + importCases.length} cases pass`);
