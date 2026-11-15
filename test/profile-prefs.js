// Session-cookie retention profile tweak (#183)
// Run with: node test/profile-prefs.js
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { keepSessionCookies } from '../src/profile-prefs.js';

console.log('--- Testing profile prefs ---\n');

let passed = 0;
const test = (title, fn) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fgc-prof-'));
  try {
    fn(dir);
    console.log(`✓ [PASS] ${title}`);
    passed++;
  } catch (err) {
    console.error(`✗ [FAIL] ${title}`);
    console.error(`  ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const prefs = dir => JSON.parse(readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
const sessionsIsFile = dir => statSync(path.join(dir, 'Default', 'Sessions')).isFile();

test('fresh profile gets pref + Sessions file', dir => {
  assert.deepEqual(keepSessionCookies(dir), { changed: true });
  assert.equal(prefs(dir).session.restore_on_startup, 1);
  assert.ok(sessionsIsFile(dir));
});

test('existing prefs are preserved, Sessions dir replaced', dir => {
  mkdirSync(path.join(dir, 'Default', 'Sessions'), { recursive: true });
  writeFileSync(path.join(dir, 'Default', 'Sessions', 'Tabs_1'), 'x');
  writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ profile: { name: 'P' }, session: { restore_on_startup: 5, startup_urls: [] } }));
  assert.deepEqual(keepSessionCookies(dir), { changed: true });
  const p = prefs(dir);
  assert.equal(p.profile.name, 'P');
  assert.equal(p.session.restore_on_startup, 1);
  assert.deepEqual(p.session.startup_urls, []);
  assert.ok(sessionsIsFile(dir));
});

test('second call is a no-op', dir => {
  keepSessionCookies(dir);
  assert.deepEqual(keepSessionCookies(dir), { changed: false });
});

test('unreadable Preferences is left alone', dir => {
  mkdirSync(path.join(dir, 'Default'), { recursive: true });
  writeFileSync(path.join(dir, 'Default', 'Preferences'), '{broken');
  const r = keepSessionCookies(dir);
  assert.equal(r.changed, false);
  assert.match(r.error, /Preferences unreadable/);
  assert.equal(readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'), '{broken');
  assert.ok(!existsSync(path.join(dir, 'Default', 'Sessions')));
});

console.log(`\n${passed} passed`);
