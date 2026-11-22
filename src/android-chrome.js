// Real Google Chrome presenting itself as one Android phone, for sites whose
// bot scoring rejects the patchright Chromium + injected-fingerprint setup
// (AliExpress's AWSC slider fails with "error: AFEDn" before it even renders).
//
// The approach follows P-Adamiec's Free-Games-Claimer-Remaster, whose
// AliExpress check-in passes the same gate: the branded Chrome binary
// (proprietary codecs and all), and the phone set through CDP, so the UA
// string, the Sec-CH-UA-* headers and navigator.userAgentData all name the
// same device and the Chrome version that is really running. No page-level
// script rewrites navigator, so nothing is left for a consistency check to
// catch.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Where patchright's `channel: 'chrome'` looks on Linux.
export const CHROME_PATH = '/opt/google/chrome/chrome';

export const chromeInstalled = () => existsSync(CHROME_PATH);

// Phones with their CSS viewport and pixel ratio. One is picked per profile and
// kept, because a device that changes between visits is itself a bot signal.
const PHONES = [
  { model: 'Pixel 7', androidVersion: '14.0.0', width: 412, height: 915, dpr: 2.625 },
  { model: 'Pixel 8', androidVersion: '15.0.0', width: 412, height: 915, dpr: 2.625 },
  { model: 'SM-S911B', androidVersion: '14.0.0', width: 360, height: 780, dpr: 3 },
  { model: 'SM-A546B', androidVersion: '14.0.0', width: 384, height: 854, dpr: 2.8125 },
];

const DEVICE_FILE = '.fgc-android-device.json';

/** The phone this profile presents, picked once and saved in the profile dir. */
export function profilePhone(profileDir) {
  const file = path.join(profileDir, DEVICE_FILE);
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const known = PHONES.find(p => p.model === saved?.model);
    if (known) return { ...known, ...saved };
  } catch {
    // no phone saved yet, or the file is unreadable: pick one below
  }
  const phone = PHONES[Math.floor(Math.random() * PHONES.length)];
  try {
    writeFileSync(file, JSON.stringify(phone));
  } catch (e) {
    console.error(`Could not save the Android device for ${profileDir}: ${e.message}`);
  }
  return phone;
}

/**
 * Chrome's brand lists for a version. The made-up "Not…Brand" entry and the
 * order follow Chromium's own GREASE rule, so they match what a real Chrome of
 * that major version sends. Ported from the Remaster's chrome_grease_brands().
 */
export function greaseBrands(major, fullVersion) {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const greaseBrand = `Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand`;
  const greaseVersion = ['8', '99', '24'][major % 3];
  const order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][major % 6];
  const entries = [
    [greaseBrand, greaseVersion, `${greaseVersion}.0.0.0`],
    ['Chromium', String(major), fullVersion],
    ['Google Chrome', String(major), fullVersion],
  ];
  const brands = [], fullVersionList = [];
  entries.forEach(([brand, short, long], i) => {
    brands[order[i]] = { brand, version: short };
    fullVersionList[order[i]] = { brand, version: long };
  });
  return { brands, fullVersionList };
}

/**
 * The CDP overrides for a phone running Chrome `fullVersion`. The UA string is
 * the reduced one Chrome on Android really sends ("Android 10; K"); the model
 * and Android version only appear in the high-entropy client hints.
 */
export function androidOverrides(phone, fullVersion, { locale = 'en-US', maxHeight } = {}) {
  const major = Number(String(fullVersion).split('.')[0]);
  const { brands, fullVersionList } = greaseBrands(major, fullVersion);
  const userAgent = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
  const language = locale.split('-')[0];
  return {
    userAgent: {
      userAgent,
      acceptLanguage: language === locale ? locale : `${locale},${language}`,
      platform: 'Linux armv81',
      userAgentMetadata: {
        brands,
        fullVersionList,
        fullVersion,
        platform: 'Android',
        platformVersion: phone.androidVersion,
        architecture: '',
        model: phone.model,
        mobile: true,
        bitness: '',
        wow64: false,
      },
    },
    // Keep the viewport inside the VNC screen so bottom sheets aren't cut off.
    metrics: {
      width: phone.width,
      height: maxHeight ? Math.min(phone.height, maxHeight) : phone.height,
      deviceScaleFactor: phone.dpr,
      mobile: true,
      screenWidth: phone.width,
      screenHeight: phone.height,
    },
  };
}

async function emulateOn(context, page, overrides) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setUserAgentOverride', overrides.userAgent);
  await cdp.send('Emulation.setDeviceMetricsOverride', overrides.metrics);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

const emulated = new WeakMap(); // page -> promise of its overrides being in place

/** Resolves once `page` carries the phone overrides (immediately for pages without them). */
export const androidReady = page => emulated.get(page) || Promise.resolve();

/**
 * Make every page of `context`, open now or opened later, the profile's phone.
 * Await androidReady(page) before navigating a page opened after this call.
 * Returns the phone, for logging.
 */
export async function attachAndroidChrome(context, profileDir, { locale, maxHeight } = {}) {
  const phone = profilePhone(profileDir);
  const fullVersion = context.browser()?.version() || await versionFromPage(context);
  const overrides = androidOverrides(phone, fullVersion, { locale, maxHeight });
  const apply = page => {
    if (!emulated.has(page)) {
      emulated.set(page, emulateOn(context, page, overrides)
        .catch(e => console.error(`Android emulation failed on a page: ${e.message.split('\n')[0]}`)));
    }
    return emulated.get(page);
  };
  context.on('page', apply);
  await Promise.all(context.pages().map(apply));
  return { ...phone, chrome: fullVersion };
}

// A persistent context has no Browser object to ask, so read the version the
// way the page sees it before any override is in place.
async function versionFromPage(context) {
  const page = context.pages()[0] || await context.newPage();
  const cdp = await context.newCDPSession(page);
  const { product } = await cdp.send('Browser.getVersion');
  await cdp.detach().catch(() => {});
  return String(product).split('/')[1];
}
