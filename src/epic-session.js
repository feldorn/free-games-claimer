// Epic account-session probe from the profile's cookies (#163).
//
// Epic keeps two separate logins in one profile:
//
//   store.epicgames.com  EPIC_EG1 (8h) + REFRESH_EPIC_EG1 (1y)
//                        drives the store header's `isloggedin` attribute
//   .epicgames.com       EPIC_SSO + EPIC_BEARER_TOKEN (8h), EPIC_SSO_RM (1y,
//                        "remember me") — the account session the Get /
//                        checkout flow actually needs
//
// The store refresh token outlives the account session, so a profile can
// show "logged in" in the header while every claim redirects to /id/login.
// That's the #162/#163/#164/#167/#168 "session lost mid-run" cluster:
// Sharpyku's failing profile had the store cookies but no EPIC_SSO /
// EPIC_SSO_RM, and a fresh cookie export that carried them claimed at once.
//
// EPIC_SSO alone is enough for one run but expires ~8h after login; only
// EPIC_SSO_RM lets Epic re-mint it, so a daily schedule needs RM.
//
// Cookie names alone can't settle it either way: Dr4w's profile in #163 had
// EPIC_SSO_RM and still bounced to /id/login. Tested on a live profile
// (2026-10-24): EPIC_SESSION_AP (path-scoped, kept in the profile between
// runs) authenticates with no EPIC_SSO at all, while EPIC_SSO_RM by itself
// gets a 401 and no page navigation restores the session. So we also ask
// Epic: GET /id/api/account is read-only, 200 with the account JSON when the
// session is live, 401 errors.com.epicgames.unauthorized when it isn't.
// Anything else (Cloudflare page, 5xx, timeout) is "unknown" and we fall back
// to the cookie check. On a 401 Epic also clears the dead EPIC_SSO_RM. Don't
// swap in /id/api/redirect: it mints a launcher authorization code per call.
//
// EPIC_SESSION_AP is a session cookie scoped to path /id, so a cookie export
// taken from a store tab never carries it (the extensions only export what
// the open tab's URL can see). Without it even a fresh EPIC_SSO gets the 401,
// and no navigation re-mints it (#162/#163 on 2.12.16). The import says so.
//
// Zero local imports — sites.js and the runner both pull this in.

// /id/ rather than / so the path-scoped EPIC_SESSION_AP comes back too.
const ACCOUNT_URL = 'https://www.epicgames.com/id/';

// `cookies` is Playwright's context.cookies() shape: `expires` in epoch
// seconds, -1 for a session cookie (still live while it's in the jar).
export function epicAccountSession(cookies, nowMs = Date.now()) {
  const live = name => (cookies || []).find(c =>
    c.name === name
    && /(^|\.)epicgames\.com$/.test(String(c.domain || '').replace(/^\./, ''))
    && (c.expires == null || c.expires < 0 || c.expires * 1000 > nowMs));
  const sso = live('EPIC_SSO');
  const rm = live('EPIC_SSO_RM');
  // EPIC_SESSION_AP alone authenticates (see above). Only matters when the
  // probe can't answer; Epic leaves it behind after clearing SSO/RM on a 401,
  // but a 401 already settles the verdict as dead (#163).
  const ap = live('EPIC_SESSION_AP');
  return {
    ok: !!(sso || rm || ap),
    remembered: !!rm,
    // When the session will die without RM to renew it (null = n/a).
    expiresAt: !rm && sso && sso.expires > 0 ? new Date(sso.expires * 1000) : null,
  };
}

export async function readEpicAccountSession(context) {
  return epicAccountSession(await context.cookies(ACCOUNT_URL));
}

const PROBE_URL = 'https://www.epicgames.com/id/api/account';

// 'live' | 'dead' | 'unknown' from the probe's HTTP status + body text.
export function classifyAccountProbe(status, body) {
  let json = null;
  try { json = JSON.parse(body); } catch { /* HTML challenge page etc. */ }
  if (status === 200 && json && json.id) return 'live';
  if ((status === 401 || status === 403) && json && /^errors\.com\.epicgames\./.test(String(json.errorCode || ''))) return 'dead';
  return 'unknown';
}

// Epic's errorCode from a rejected probe, so the reason says why (#163).
export function accountProbeErrorCode(body) {
  try {
    const code = JSON.parse(body).errorCode;
    return /^errors\.com\.epicgames\.[\w.-]{1,120}$/.test(String(code || '')) ? code : null;
  } catch { return null; }
}

// page.request / context.request share the context's cookie jar, and Epic's
// Set-Cookie (an RM-minted EPIC_SSO) lands back in it.
export async function probeEpicAccount(context, timeout = 15000) {
  try {
    const r = await context.request.get(PROBE_URL, { headers: { accept: 'application/json' }, maxRedirects: 0, timeout });
    const status = r.status();
    const body = await r.text();
    return { state: classifyAccountProbe(status, body), status, errorCode: accountProbeErrorCode(body) };
  } catch (e) {
    return { state: 'unknown', status: null, error: String(e && e.message || e).split('\n')[0].slice(0, 200) };
  }
}

// Combines the cookie read with the live probe. `ok` false → treat as signed
// out; `reason` says why. `warning` is set when the session works now but
// nothing will renew it.
export function epicSessionVerdict(acct, probe) {
  const warning = !acct.remembered ? epicNotRememberedWarning(acct.expiresAt) : null;
  if (probe.state === 'dead') return { ok: false, reason: epicRejectedReason(probe.status, probe.errorCode), probe: probe.state };
  if (probe.state === 'live') return { ok: true, warning, probe: probe.state };
  if (!acct.ok) return { ok: false, reason: EPIC_NO_ACCOUNT_SESSION, probe: probe.state };
  return { ok: true, warning, probe: probe.state };
}

export async function checkEpicAccountSession(context) {
  const [acct, probe] = await Promise.all([readEpicAccountSession(context), probeEpicAccount(context)]);
  return { ...epicSessionVerdict(acct, probe), status: probe.status, error: probe.error };
}

export function epicRejectedReason(status, errorCode) {
  return `store shows logged in, but Epic rejected the account session (account check returned HTTP ${status}${errorCode ? `, ${errorCode}` : ''}) — claims would redirect to the login page. Log out and back in, or import a fresh cookie export that includes the .epicgames.com cookies.`;
}

export const EPIC_NO_ACCOUNT_SESSION = 'store shows logged in, but the Epic account session is gone (no EPIC_SSO / EPIC_SSO_RM / EPIC_SESSION_AP cookie) — claims would redirect to the login page. Log out and back in, or import a fresh cookie export that includes the .epicgames.com cookies.';

// Reason for a failed cookie import whose upload lacks EPIC_SESSION_AP;
// null when it was there (the failure is something else).
export function epicImportMissingSessionReason(cookies) {
  if ((cookies || []).some(c => c && c.name === 'EPIC_SESSION_AP')) return null;
  return 'the export has no EPIC_SESSION_AP cookie, which is Epic\'s account login. It only shows on www.epicgames.com/id pages, so an export from a store tab leaves it out. In the same logged-in browser, open https://www.epicgames.com/id/api/account, export the cookies from that tab and import that file too (the cookies already imported are kept).';
}

// Once the account session lapses on a device Epic still knows, /id/login
// shows an account switcher instead of the email form, and clicking the
// account signs back in without a password (CharlieRiesner, #163). Tile
// markup seen 2026-10-27: <div role="button" id="account-<id>"
// data-account-id="<id>" aria-label="<display name>">, email in its text.
export const EPIC_SWITCHER_TILE = '[role="button"][data-account-id]';

// Call on /id/login. Clicks the remembered account if the switcher shows
// and returns true; false when the email form (or nothing) shows instead.
// With several accounts listed, only clicks the one matching `email`.
export async function resumeEpicAccountSwitcher(page, email, timeout = 10000) {
  const tiles = page.locator(EPIC_SWITCHER_TILE);
  const shown = await Promise.race([
    tiles.first().waitFor({ timeout }).then(() => 'switcher'),
    page.locator('#email').waitFor({ timeout }).then(() => 'form'),
  ]).catch(() => null);
  if (shown !== 'switcher') return false;
  let tile = tiles.first();
  if (await tiles.count() > 1) {
    if (!email) return false;
    tile = tiles.filter({ hasText: email });
    if (await tile.count() !== 1) return false;
  }
  await tile.click({ delay: 111 });
  return true;
}

export function epicNotRememberedWarning(expiresAt) {
  const when = expiresAt ? ` at ${expiresAt.toISOString().replace('T', ' ').slice(0, 16)} UTC` : '';
  return `Epic account session isn't remembered (no EPIC_SSO_RM cookie) and expires${when} — scheduled runs after that will fail. Log in again with "Remember me" ticked, or re-export cookies from a browser where it was.`;
}
