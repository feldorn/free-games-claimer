import { firefox } from 'playwright-firefox';
import { cfg } from './config.js';
import { filenamify, datetime } from './util.js';

export const stealth = async context => {
  const enabledEvasions = [
    'chrome.app',
    'chrome.csi',
    'chrome.loadTimes',
    'chrome.runtime',
    'iframe.contentWindow',
    'media.codecs',
    'navigator.hardwareConcurrency',
    'navigator.languages',
    'navigator.permissions',
    'navigator.plugins',
    'navigator.webdriver',
    'sourceurl',
    'webgl.vendor',
    'window.outerdimensions',
  ];
  const mock = {
    callbacks: [],
    async evaluateOnNewDocument(...args) {
      this.callbacks.push({ cb: args[0], a: args[1] });
    },
  };
  for (const e of enabledEvasions) {
    const evasion = await import(`puppeteer-extra-plugin-stealth/evasions/${e}/index.js`);
    evasion.default().onPageCreated(mock);
  }
  for (const evasion of mock.callbacks) {
    await context.addInitScript(evasion.cb, evasion.a);
  }
};

export const handleSIGINT = (context = null) => process.on('SIGINT', async () => {
  console.error('\nInterrupted by SIGINT. Exit!');
  process.exitCode = 130;
  if (context) await context.close();
});

export async function launchBrowser(browserDir, { userAgent, recordPrefix, applyStealth = true } = {}) {
  const context = await firefox.launchPersistentContext(browserDir, {
    headless: cfg.headless,
    viewport: { width: cfg.width, height: cfg.height },
    locale: 'en-US',
    ...(userAgent && { userAgent }),
    recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined,
    recordHar: cfg.record && recordPrefix ? { path: `data/record/${recordPrefix}-${filenamify(datetime())}.har` } : undefined,
    handleSIGINT: false,
  });

  handleSIGINT(context);
  if (applyStealth) await stealth(context);
  if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

  const page = context.pages().length ? context.pages()[0] : await context.newPage();
  await page.setViewportSize({ width: cfg.width, height: cfg.height });

  return { context, page };
}
