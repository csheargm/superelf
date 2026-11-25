// The reading text never moves when a bar hides or shows (owner 2026-11-23, iPhone + iPad Safari: "when the
// bar auto-hides the whole text moves up; when it comes back it jumps again" — Bible AND Journal). REAL
// browser (R6): the real web.mjs on a throwaway root, the real shell, the shipped Bible and Journal
// templates in the sandboxed frame. For each viewport (phone / iPad, portrait / landscape) it measures a
// line's getBoundingClientRect().top before a hide, after it and after the show; all three must agree within
// 1px — mid-chapter AND at the very top. And with the bar shown, the top of the chapter is not under it.
// CONTROL (R14): the hide really happened (data-paab-hidden, the bar off-screen), else "no move" is vacuous.
// PA_E2E_ENGINE=webkit runs it in iPad Safari's engine. No Playwright: FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

const VIEWPORTS = { phone: { width: 390, height: 844 }, phoneLand: { width: 844, height: 390 },
  ipad: { width: 820, height: 1180 }, ipadLand: { width: 1180, height: 820 } };
const SETTLE_MS = 400;   // past the bar's .18s slide
const TOL = 1;
let port, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); const root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  for (const slug of ['bible', 'notes']) {
    const d = path.join(root, 'workspace', 'apps', slug); fs.mkdirSync(d, { recursive: true });
    for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, 'workspace.example', 'apps', slug, f), path.join(d, f));
  }
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

async function open(slug, ready, viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok') && OWNBAR_APPS.size > 0);
  await page.evaluate((s) => openApp(UID, s, s), slug);
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes(`/app/owner/${slug}/`)) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, `${slug} frame loaded`);
  await frame.waitForFunction(ready);
  await page.waitForFunction(() => document.querySelector('#frame').classList.contains('ownbar'));
  return { ctx, page, frame };
}
// The line's top on the PAGE's screen (frame offset + in-frame rect), so a moving iframe counts too.
async function topOf(page, frame, sel) {
  const fr = await page.evaluate(() => document.querySelector('#fr').getBoundingClientRect().top);
  return fr + await frame.evaluate((s) => document.querySelector(s).getBoundingClientRect().top, sel);
}
async function hideShow(page, frame, bar, line) {
  await frame.evaluate(() => PAAppBar.show()); await page.waitForTimeout(SETTLE_MS);
  const shown = await topOf(page, frame, line);
  await frame.evaluate(() => PAAppBar.hide()); await page.waitForTimeout(SETTLE_MS);
  // Under a loaded full suite the .18s slide can run past SETTLE_MS: wait for it to finish, not a longer sleep.
  await frame.waitForFunction((s) => document.querySelector(s).getBoundingClientRect().bottom <= 1, bar, { timeout: 5000 }).catch(() => { /* the assert below names it */ });
  assert.equal(await frame.evaluate((s) => document.querySelector(s).getAttribute('data-paab-hidden'), bar), '1', 'CONTROL: the bar hid');
  assert.ok(await frame.evaluate((s) => document.querySelector(s).getBoundingClientRect().bottom <= 1, bar), 'CONTROL: the bar is off-screen');
  const hidden = await topOf(page, frame, line);
  await frame.evaluate(() => PAAppBar.show()); await page.waitForTimeout(SETTLE_MS);
  await frame.waitForFunction((s) => document.querySelector(s).getBoundingClientRect().top >= -1, bar, { timeout: 5000 }).catch(() => { /* still() below names a bar that never came back */ });
  const back = await topOf(page, frame, line);
  return { shown, hidden, back };
}
const still = (m, what) => {
  assert.ok(Math.abs(m.hidden - m.shown) <= TOL, `${what}: hide moved the text ${m.shown} -> ${m.hidden}`);
  assert.ok(Math.abs(m.back - m.shown) <= TOL, `${what}: show moved the text ${m.shown} -> ${m.back}`);
};
const BIBLE_READY = () => document.querySelector('#nav .paab-home') && document.querySelectorAll('.verse').length > 20;

for (const [name, vp] of Object.entries(VIEWPORTS)) {
  test(`Bible ${name}: a verse stays put across bar hide + show, mid-chapter and at the top`, { skip, timeout: 90000 }, async () => {
    const { ctx, page, frame } = await open('bible', BIBLE_READY, vp);
    try {
      await frame.evaluate(() => { document.getElementById('verses').scrollTop = 0; });
      const top = await hideShow(page, frame, '#nav', '.verse');
      still(top, 'top of chapter');
      const barBottom = await frame.evaluate(() => document.getElementById('nav').getBoundingClientRect().bottom);
      const first = await frame.evaluate(() => document.querySelector('.verse').getBoundingClientRect().top);
      assert.ok(first >= barBottom - TOL, `the first verse (${first}) is not under the shown bar (${barBottom})`);
      await frame.evaluate(() => { document.getElementById('verses').scrollTop = 300; });
      await frame.evaluate(() => { const v = [...document.querySelectorAll('.verse')].find((e) => e.getBoundingClientRect().top > innerHeight / 3); v.id = 'probe-v'; });
      const mid = await hideShow(page, frame, '#nav', '#probe-v');
      still(mid, 'mid-chapter');
      console.log(`# measure bible ${name} top=${JSON.stringify(top)} mid=${JSON.stringify(mid)}`);
    } finally { await ctx.close(); }
  });
  test(`Journal ${name}: the page stays put across bar hide + show`, { skip, timeout: 90000 }, async () => {
    const { ctx, page, frame } = await open('notes', () => document.querySelector('.pan-top .paab-home') && document.querySelector('.pan-pageInner'), vp);
    try {
      const m = await hideShow(page, frame, '.pan-top', '.pan-pageInner');
      still(m, 'journal page');
      const barBottom = await frame.evaluate(() => document.querySelector('.pan-top').getBoundingClientRect().bottom);
      assert.ok(m.back - (await page.evaluate(() => document.querySelector('#fr').getBoundingClientRect().top)) >= barBottom - TOL, 'the page top is not under the shown bar');
      console.log(`# measure journal ${name} ${JSON.stringify(m)}`);
    } finally { await ctx.close(); }
  });
}

// GPT review: the daily banner sits between the bar and the scroller, so its appearing / expiring changes
// the lift's gap. Mid-chapter that must not move the verse the reader is on — bar shown OR hidden.
for (const [name, vp] of Object.entries({ phone: VIEWPORTS.phone, ipad: VIEWPORTS.ipad })) {
  test(`Bible ${name}: the daily banner appearing / expiring mid-chapter does not move the verse`, { skip, timeout: 90000 }, async () => {
    const { ctx, page, frame } = await open('bible', BIBLE_READY, vp);
    try {
      await frame.evaluate(() => { document.getElementById('verses').scrollTop = 300; });
      await frame.evaluate(() => { const v = [...document.querySelectorAll('.verse')].find((e) => e.getBoundingClientRect().top > innerHeight / 3); v.id = 'probe-v'; });
      for (const hidden of [false, true]) {
        await frame.evaluate((h) => (h ? PAAppBar.hide() : PAAppBar.show()), hidden); await page.waitForTimeout(SETTLE_MS);
        const b0 = await topOf(page, frame, '#probe-v');
        await frame.evaluate(() => { const b = document.getElementById('daily-banner'); b.textContent = 'banner'; b.classList.add('show'); });
        await page.waitForTimeout(SETTLE_MS);
        assert.ok(await frame.evaluate(() => document.getElementById('daily-banner').offsetHeight > 0), 'CONTROL: the banner showed');
        const b1 = await topOf(page, frame, '#probe-v');
        await frame.evaluate(() => document.getElementById('daily-banner').classList.remove('show'));
        await page.waitForTimeout(SETTLE_MS);
        const b2 = await topOf(page, frame, '#probe-v');
        assert.ok(Math.abs(b1 - b0) <= TOL && Math.abs(b2 - b0) <= TOL, `bar ${hidden ? 'hidden' : 'shown'}: banner moved the verse ${b0} -> ${b1} -> ${b2}`);
        console.log(`# measure banner ${name} hidden=${hidden} ${b0} ${b1} ${b2}`);
      }
    } finally { await ctx.close(); }
  });
}
