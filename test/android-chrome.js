// Android-phone overrides for Google Chrome (AE_REAL_CHROME)
// Run with: node test/android-chrome.js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { greaseBrands, androidOverrides, profilePhone } from '../src/android-chrome.js';

console.log('--- Testing Android Chrome overrides ---\n');

let passed = 0;
const test = (title, fn) => {
  try {
    fn();
    console.log(`✓ [PASS] ${title}`);
    passed++;
  } catch (err) {
    console.error(`✗ [FAIL] ${title}`);
    console.error(`  ${err.message}\n`);
    process.exitCode = 1;
  }
};

const header = brands => brands.map(b => `"${b.brand}";v="${b.version}"`).join(', ');

// Sec-CH-UA as real Chrome sends it for these versions.
test('GREASE brands match Chrome 131', () => {
  assert.equal(header(greaseBrands(131, '131.0.6778.85').brands), '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"');
});

test('GREASE brands match Chrome 120', () => {
  assert.equal(header(greaseBrands(120, '120.0.6099.71').brands), '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
});

test('full version list carries the full version in the same order', () => {
  const { brands, fullVersionList } = greaseBrands(131, '131.0.6778.85');
  assert.deepEqual(fullVersionList.map(b => b.brand), brands.map(b => b.brand));
  assert.equal(fullVersionList.find(b => b.brand === 'Google Chrome').version, '131.0.6778.85');
});

test('UA string, client hints and metrics name the same phone and Chrome', () => {
  const phone = { model: 'Pixel 7', androidVersion: '14.0.0', width: 412, height: 915, dpr: 2.625 };
  const o = androidOverrides(phone, '142.0.7444.59', { locale: 'pt-BR', maxHeight: 1040 });
  assert.equal(o.userAgent.userAgent, 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36');
  assert.equal(o.userAgent.userAgentMetadata.platform, 'Android');
  assert.equal(o.userAgent.userAgentMetadata.model, 'Pixel 7');
  assert.equal(o.userAgent.userAgentMetadata.mobile, true);
  assert.equal(o.userAgent.userAgentMetadata.fullVersion, '142.0.7444.59');
  assert.equal(o.userAgent.acceptLanguage, 'pt-BR,pt');
  assert.deepEqual([o.metrics.width, o.metrics.height, o.metrics.mobile], [412, 915, true]);
});

test('viewport height is capped to the VNC screen', () => {
  const phone = { model: 'Pixel 7', androidVersion: '14.0.0', width: 412, height: 915, dpr: 2.625 };
  assert.equal(androidOverrides(phone, '142.0.7444.59', { maxHeight: 700 }).metrics.height, 700);
});

test('a profile keeps the phone it was given', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fgc-android-'));
  const first = profilePhone(dir);
  assert.equal(JSON.parse(readFileSync(path.join(dir, '.fgc-android-device.json'), 'utf8')).model, first.model);
  for (let i = 0; i < 5; i++) assert.equal(profilePhone(dir).model, first.model);
});

console.log(`\n${passed} passed`);
