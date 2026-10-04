// Small URL validation helpers — ported from P-Adamiec/Free-Games-Claimer-Remaster
// (`src/core/url_security.py`). HTTPS-only strict host match: a URL is only
// considered to point at an allowed host when its hostname EQUALS the allowed
// host OR (opt-in) ends with "." + allowed host.
//
// The previous substring check `url.includes("gog.com")` incorrectly matches
// `https://gog.com.evil.tld/x`, `https://evil-gog.com/x`, `https://notgog.com/x`,
// `https://gog.com.co/x`, and `https://evil.tld/?r=gog.com` (host-in-query).
// This helper rejects all of those while still accepting legitimate subdomains
// when the caller opts in.
//
// Used in the discovery pipeline (gamerpower.js + freegamefindings.js) where
// untrusted third-party URLs route to collector scripts by domain match.

/**
 * Returns true iff `url` is https:// AND its hostname matches `allowedHost`
 * (exact match, or — when `allowSubdomains` is true — ends with "." + allowedHost).
 * Case-insensitive; trailing dots on the hostname are stripped. Garbage input,
 * missing hostnames, and non-https schemes all return false.
 */
export function urlHasAllowedHost(url, allowedHost, { allowSubdomains = false } = {}) {
  if (typeof url !== 'string' || !url || typeof allowedHost !== 'string' || !allowedHost) return false;
  let parsed;
  try { parsed = new URL(url); }
  catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  if (!parsed.hostname) return false;
  const hostname = parsed.hostname.replace(/\.+$/, '').toLowerCase();
  const allowed = allowedHost.replace(/\.+$/, '').toLowerCase();
  if (!hostname || !allowed) return false;
  return hostname === allowed || (allowSubdomains && hostname.endsWith('.' + allowed));
}

/**
 * Returns true iff `url`'s hostname matches ANY entry in `allowedHosts`.
 * Convenience over calling `urlHasAllowedHost` in a loop — used by callers
 * that currently do `domains.some(d => url.includes(d))`.
 */
export function urlHasAnyAllowedHost(url, allowedHosts, opts = {}) {
  if (!Array.isArray(allowedHosts)) return false;
  for (const h of allowedHosts) {
    if (urlHasAllowedHost(url, h, opts)) return true;
  }
  return false;
}
