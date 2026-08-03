// normalizeClaimCommand — run with `node test/claim-cmd.js`.
// Covers the shapes a CLAIM_CMD / CLAIM_CMD_MANUAL override shows up in, and
// the ones that must pass through untouched.
// util.js first: it reads cfg in its module body while config.js imports it
// back, so entering the cycle from sites.js hits the TDZ. Same order the panel
// uses.
import '#src/util.js';
import { normalizeClaimCommand } from '#src/sites.js';

const P = 'src/platforms';

const cases = [
  // overrides written before the scrapers moved
  ['node gog.js; node steam.js', `node ${P}/gog.js; node ${P}/steam.js`],
  ['node prime-gaming.js; node epic-games.js; node microsoft.js',
    `node ${P}/prime-gaming.js; node ${P}/epic-games.js; node ${P}/microsoft.js`],
  ['node ./gog.js', `node ${P}/gog.js`],
  // short forms
  ['gog.js; steam.js', `node ${P}/gog.js; node ${P}/steam.js`],
  ['gog; steam', `node ${P}/gog.js; node ${P}/steam.js`],
  ['node gog', `node ${P}/gog.js`],
  // current spelling stays put
  [`node ${P}/gog.js`, `node ${P}/gog.js`],
  // separators, inline env and args survive
  ['node gog.js && node steam.js', `node ${P}/gog.js && node ${P}/steam.js`],
  ['node gog.js & node steam.js', `node ${P}/gog.js & node ${P}/steam.js`],
  ['MS_SKIP_WINDOW=1 node microsoft.js', `MS_SKIP_WINDOW=1 node ${P}/microsoft.js`],
  ['node gog.js --debug', `node ${P}/gog.js --debug`],
  // not ours to touch
  ['echo gog', 'echo gog'],
  ['echo "starting gog.js"', 'echo "starting gog.js"'],
  ['node /opt/mine/pre.js', 'node /opt/mine/pre.js'],
  ['bash -c "node gog.js"', 'bash -c "node gog.js"'],
  ['curl -s https://example.com/hook', 'curl -s https://example.com/hook'],
  ['', ''],
];

let failed = 0;
for (const [input, want] of cases) {
  const got = normalizeClaimCommand(input);
  if (got === want) {
    console.log(`ok    ${JSON.stringify(input)}`);
  } else {
    failed++;
    console.log(`FAIL  ${JSON.stringify(input)}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  }
}

// Rewriting twice must land in the same place — the panel logs the result, and
// a second pass over its own output shouldn't drift.
const twice = normalizeClaimCommand(normalizeClaimCommand('gog; node steam.js'));
if (twice !== `node ${P}/gog.js; node ${P}/steam.js`) {
  failed++;
  console.log(`FAIL  not idempotent: ${JSON.stringify(twice)}`);
}

console.log(`\n${failed ? `${failed} failed` : `all ${cases.length + 1} passed`}`);
process.exit(failed ? 1 : 0);
