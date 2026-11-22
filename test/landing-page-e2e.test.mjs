// The marketing page (docs/site/index.html) in a REAL browser (R6): at phone and desktop widths, in
// light and dark, the page never scrolls sideways and every element fits the viewport. The static
// checks in landing-page.test.mjs cannot measure layout; this does.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-e2e-gate.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';

const PAGE = pathToFileURL(path.join(ROOT, 'docs', 'site', 'index.html')).href;
const SIZES = [{ width: 320, height: 640 }, { width: 375, height: 812 }, { width: 1280, height: 800 }];
let browser;
before(async () => { if (!skip) browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); });

for (const scheme of ['light', 'dark']) {
  for (const size of SIZES) {
    test(`landing page fits ${size.width}px (${scheme})`, { skip }, async () => {
      const ctx = await browser.newContext({ viewport: size, colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto(PAGE);
      const r = await page.evaluate(() => {
        const W = document.documentElement.clientWidth;
        const wide = [...document.querySelectorAll('body *')]
          .filter((el) => { const b = el.getBoundingClientRect(); return b.right > W + 0.5 || b.left < -0.5; })
          .map((el) => `${el.tagName}.${el.className} ${el.getBoundingClientRect().right | 0}`);
        return { W, scroll: document.documentElement.scrollWidth, wide };
      });
      await ctx.close();
      assert.ok(r.scroll <= r.W, `page scrolls sideways: ${r.scroll} > ${r.W}`);
      assert.deepEqual(r.wide, [], 'every element inside the viewport');
    });
  }
}
