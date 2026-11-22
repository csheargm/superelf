// The marketing page (site/index.html) in a REAL browser (R6): it never scrolls sideways at
// phone and desktop widths in light and dark, in both languages; the EN / 中文 toggle follows the
// browser language, switches and remembers; and without JavaScript the page reads in English.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-e2e-gate.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';

const PAGE = pathToFileURL(path.join(ROOT, 'site', 'index.html')).href;
const SIZES = [{ width: 320, height: 640 }, { width: 375, height: 812 }, { width: 1280, height: 800 }];
let browser;
// Hermetic: the page's one external request (the Cloudflare analytics beacon) is blocked, so
// tests never reach the network; every check here must hold without it.
before(async () => {
  if (skip) return;
  browser = await chromium.launch();
  const real = browser.newContext.bind(browser);
  browser.newContext = async (o) => { const c = await real(o); await c.route(/^https?:/, (r) => r.abort()); return c; };
});
after(async () => { if (browser) await browser.close(); });

// What the reader sees: the language of the visible hero headline.
const shown = (page) => page.evaluate(() => [...document.querySelectorAll('h1 > [lang]')]
  .filter((e) => e.getClientRects().length).map((e) => e.lang));
const fits = (page) => page.evaluate(() => {
  const W = document.documentElement.clientWidth;
  const wide = [...document.querySelectorAll('body *')]
    .filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.right > W + 0.5 || b.left < -0.5); })
    .map((el) => `${el.tagName}.${el.className} ${el.getBoundingClientRect().right | 0}`);
  return { W, scroll: document.documentElement.scrollWidth, wide };
});

for (const scheme of ['light', 'dark']) {
  for (const size of SIZES) {
    test(`landing page fits ${size.width}px (${scheme}), English and Chinese`, { skip }, async () => {
      for (const locale of ['en-US', 'zh-CN']) {
        const ctx = await browser.newContext({ viewport: size, colorScheme: scheme, locale });
        const page = await ctx.newPage();
        await page.goto(PAGE);
        const r = await fits(page);
        await ctx.close();
        assert.ok(r.scroll <= r.W, `${locale}: page scrolls sideways: ${r.scroll} > ${r.W}`);
        assert.deepEqual(r.wide, [], `${locale}: every element inside the viewport`);
      }
    });
  }
}

test('language toggle follows the browser, switches, and remembers', { skip }, async () => {
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(PAGE);
  assert.deepEqual(await shown(page), ['zh-Hans'], 'Chinese browser starts in Chinese');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-Hans');
  await page.click('#lang');
  assert.deepEqual(await shown(page), ['en'], 'one click: English only');
  assert.equal(await page.textContent('#lang'), '中文');
  await page.reload();
  assert.deepEqual(await shown(page), ['en'], 'choice remembered over the browser language');
  await ctx.close();
  const en = await browser.newContext({ locale: 'en-US' });
  const p2 = await en.newPage();
  await p2.goto(PAGE);
  assert.deepEqual(await shown(p2), ['en'], 'English browser starts in English');
  await en.close();
});

test('without JavaScript the page is English and the toggle is hidden', { skip }, async () => {
  const ctx = await browser.newContext({ javaScriptEnabled: false, locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(PAGE);
  assert.deepEqual(await shown(page), ['en']);
  assert.equal(await page.isVisible('#lang'), false);
  await ctx.close();
});
