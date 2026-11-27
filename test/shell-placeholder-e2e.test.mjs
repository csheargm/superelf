// The shell composer's placeholder reads 中文 first and its Chinese part fits a phone · 输入框提示中文优先
// Triage 2026-11-23: web/index.html had placeholder="Ask, or: create an app that…" (English only).
// CONTROL (R14): the same measure on the English half alone must NOT fit at 375px, so a pass is
// not the measure being blind. Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const PHONE = { width: 375, height: 740 };
let port, root, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port });
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

test('composer placeholder is 中文 first and its Chinese clause fits at phone width', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: PHONE }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const m = await page.evaluate(() => {
    const box = document.querySelector('#box'), ph = box.placeholder, cs = getComputedStyle(box);
    const c = document.createElement('canvas').getContext('2d'); c.font = `${cs.fontSize} ${cs.fontFamily}`;
    const [zh, en] = ph.split(' · ');
    const inner = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { ph, zhW: c.measureText(zh).width, enW: c.measureText(`${zh} · ${en}`).width, inner, overflow: cs.textOverflow };
  });
  assert.match(m.ph, /^[一-鿿]/, `placeholder starts with Chinese: ${m.ph}`);
  assert.doesNotMatch(m.ph, / · [A-Za-z]/, 'one language on a 中文 device: no English half');
  assert.ok(m.zhW <= m.inner, `Chinese clause ${m.zhW}px fits the ${m.inner}px box`);
  assert.ok(m.enW > m.inner, 'CONTROL: the full pair does not fit, so the check can see overflow');
  assert.equal(m.overflow, 'ellipsis', 'the cut-off English tail ends in an ellipsis, not a hard clip');
  await ctx.close();
});
