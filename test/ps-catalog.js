// Manual smoke test for src/playstation-plus-catalog.js.
// Project pattern: ad-hoc test scripts under test/, runnable directly with node.

import { parseConceptId, normalizeTitle, matchMonthlyToCatalog } from '../src/playstation-plus-catalog.js';

let totalFail = 0;

// --- parseConceptId — 8 cases -------------------------------------------
const pcCases = [
  ['https://store.playstation.com/en-us/concept/10009923', '10009923'],
  ['https://store.playstation.com/en-us/concept/228903', '228903'],
  ['https://store.playstation.com/en-us/concept/10009923?smcid=foo', '10009923'],
  ['https://store.playstation.com/en-gb/concept/10009923', '10009923'],
  ['https://store.playstation.com/de-de/concept/10003817?smcid=pdc:bar', '10003817'],
  ['https://www.playstation.com/en-us/games/another-crab/', null],
  ['https://store.playstation.com/en-us/product/UP7131-PPSA20422_00', null],
  ['', null],
];
let pcPass = 0;
for (const [input, expected] of pcCases) {
  const got = parseConceptId(input);
  if (got === expected) pcPass++;
  else {
    totalFail++; console.error(`parseConceptId FAIL: ${JSON.stringify(input)} → expected ${JSON.stringify(expected)} got ${JSON.stringify(got)}`);
  }
}
console.log(`parseConceptId tests: ${pcPass}/${pcCases.length} OK`);

// --- normalizeTitle — 6 cases -------------------------------------------
const ntCases = [
  ['Wuchang: Fallen Feathers PS4 & PS5', 'wuchang: fallen feathers'],
  ['A Hat in Time™', 'a hat in time'],
  ['Nine Sols', 'nine sols'],
  ['Alienation™', 'alienation'],
  ['ANNO: Mutationem Collector\'s Edition PS4 & PS5', 'anno: mutationem'],
  ['Adventure Time Pirates of the Enchiridion', 'adventure time pirates of the enchiridion'],
  [null, ''],
  ['', ''],
];
let ntPass = 0;
for (const [input, expected] of ntCases) {
  const got = normalizeTitle(input);
  if (got === expected) ntPass++;
  else {
    totalFail++; console.error(`normalizeTitle FAIL: "${input}" → expected "${expected}" got "${got}"`);
  }
}
console.log(`normalizeTitle tests: ${ntPass}/${ntCases.length} OK`);

// --- matchMonthlyToCatalog — 4 cases ------------------------------------
const catalog = [
  { conceptId: '10009923', conceptUrl: 'https://store.playstation.com/en-us/concept/10009923', title: 'Another Crab\'s Treasure' },
  { conceptId: '228903', conceptUrl: 'https://store.playstation.com/en-us/concept/228903', title: 'A Hat in Time' },
  { conceptId: '10001119', conceptUrl: 'https://store.playstation.com/en-us/concept/10001119', title: 'Wuchang: Fallen Feathers PS4 & PS5' },
];

let mPass = 0;
const m1 = matchMonthlyToCatalog([{ slug: 'a-hat-in-time', slugUrl: '/en-us/games/a-hat-in-time/', title: 'A Hat in Time' }], catalog);
if (m1.matched.length === 1 && m1.matched[0].conceptId === '228903' && m1.unmatched.length === 0) mPass++;
else {
  totalFail++; console.error('matchMonthlyToCatalog FAIL case 1 (exact match):', JSON.stringify(m1));
}

const m2 = matchMonthlyToCatalog([{ slug: 'wuchang-fallen-feathers', slugUrl: '/en-us/games/wuchang-fallen-feathers/', title: 'Wuchang: Fallen Feathers' }], catalog);
if (m2.matched.length === 1 && m2.matched[0].conceptId === '10001119' && m2.unmatched.length === 0) mPass++;
else {
  totalFail++; console.error('matchMonthlyToCatalog FAIL case 2 (fuzzy via normalize):', JSON.stringify(m2));
}

const m3 = matchMonthlyToCatalog([{ slug: 'nonexistent', slugUrl: '/en-us/games/nonexistent/', title: 'Does Not Exist' }], catalog);
if (m3.matched.length === 0 && m3.unmatched.length === 1) mPass++;
else {
  totalFail++; console.error('matchMonthlyToCatalog FAIL case 3 (no match):', JSON.stringify(m3));
}

const m4 = matchMonthlyToCatalog([], catalog);
if (m4.matched.length === 0 && m4.unmatched.length === 0) mPass++;
else {
  totalFail++; console.error('matchMonthlyToCatalog FAIL case 4 (empty):', JSON.stringify(m4));
}

console.log(`matchMonthlyToCatalog tests: ${mPass}/4 OK`);

console.log(`\nTotal pass: ${pcPass + ntPass + mPass}/${pcCases.length + ntCases.length + 4}`);
process.exit(totalFail === 0 ? 0 : 1);
