// urlHasAllowedHost / urlHasAnyAllowedHost — run with `node test/url-security.js`.
// Mirrors the attack cases ported from P-Adamiec/Free-Games-Claimer-Remaster's
// `tests/test_url_security.py`. See `src/url-security.js` for context.
import { urlHasAllowedHost, urlHasAnyAllowedHost } from '#src/url-security.js';

const cases = [
  // exact host match
  ['https://www.gog.com/game/x', 'www.gog.com', {}, true],
  // subdomain requires opt-in
  ['https://shop.fanatical.com/x', 'fanatical.com', {}, false],
  ['https://shop.fanatical.com/x', 'fanatical.com', { allowSubdomains: true }, true],
  // lookalike / substring-sneak domains must all be rejected even with opt-in
  ['https://gog.com.evil.tld/x',  'gog.com', { allowSubdomains: true }, false],
  ['https://evil-gog.com/x',      'gog.com', { allowSubdomains: true }, false],
  ['https://notgog.com/x',        'gog.com', { allowSubdomains: true }, false],
  ['https://gog.com.co/x',        'gog.com', { allowSubdomains: true }, false],
  // host-in-path or host-in-query is rejected
  ['https://evil.tld/store.epicgames.com',       'store.epicgames.com', {}, false],
  ['https://evil.tld/?to=store.epicgames.com',   'store.epicgames.com', {}, false],
  // non-https rejected
  ['http://www.gog.com/x',  'www.gog.com', {}, false],
  // case-insensitive + trailing dot
  ['https://WWW.GOG.COM/x', 'www.gog.com', {}, true],
  ['https://www.gog.com./x', 'www.gog.com', {}, true],
  // garbage input
  ['', 'gog.com', {}, false],
  ['not a url', 'gog.com', {}, false],
  [null, 'gog.com', {}, false],
  ['https://www.gog.com/x', '', {}, false],
];

let fails = 0;
for (const [url, host, opts, expected] of cases) {
  const got = urlHasAllowedHost(url, host, opts);
  const ok = got === expected;
  if (!ok) {
    console.error(`FAIL  urlHasAllowedHost(${JSON.stringify(url)}, ${JSON.stringify(host)}, ${JSON.stringify(opts)}) → ${got}, expected ${expected}`);
    fails++;
  }
}

// urlHasAnyAllowedHost — convenience over a list
const anyCases = [
  ['https://store.epicgames.com/x', ['store.epicgames.com', 'gog.com'], { allowSubdomains: true }, true],
  ['https://www.gog.com/x',         ['store.epicgames.com', 'gog.com'], { allowSubdomains: true }, true],
  ['https://evil.tld/?r=gog.com',   ['store.epicgames.com', 'gog.com'], { allowSubdomains: true }, false],
  ['https://notgog.com/x',          ['gog.com'], { allowSubdomains: true }, false],
  // non-array input returns false
  ['https://www.gog.com/x', null, {}, false],
];

for (const [url, hosts, opts, expected] of anyCases) {
  const got = urlHasAnyAllowedHost(url, hosts, opts);
  const ok = got === expected;
  if (!ok) {
    console.error(`FAIL  urlHasAnyAllowedHost(${JSON.stringify(url)}, ${JSON.stringify(hosts)}, ${JSON.stringify(opts)}) → ${got}, expected ${expected}`);
    fails++;
  }
}

if (fails) {
  console.error(`\n${fails} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`url-security: ${cases.length + anyCases.length} tests passed.`);
}
