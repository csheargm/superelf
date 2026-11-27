// Bible on an iPhone · iPhone 上的圣经 (owner 2026-11-27, 390x844, pointer coarse): three bugs, each driven as the
// reader meets it in the REAL shell + the shipped Bible in its sandboxed frame (R6):
//   1. pick a chapter from the bar → the bar slid away on the idle clock and the reader lost Note / Ask AI. A pick
//      in the bar now holds it until the reader next touches the page (web/app-bar.inline.html); CONTROL (R14):
//      after that touch the idle clock hides it again, so the reading feature is not switched off.
//   2. the chat's ✕ said "Close" only; it is "关闭 · Close" (also test/close-label-bilingual.test.mjs, every site).
//   3. Ask AI showed no pressed state while its full-screen chat was open; aria-pressed + .on follow the chat now,
//      and clear when it closes. iPad 820 and desktop 1280 / 1920: the same button keeps its pressed state.
// Run it in Safari's engine with PA_E2E_ENGINE=webkit (the harness default is Chromium). PA_SHOTS=<dir> saves
// pictures at 390 / 820 / 1280 / 1920. Without Playwright it FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium as engine } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { fitProblems } from './helpers-visual.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const SHOTS = process.env.PA_SHOTS || '';
const IPHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const IPAD = { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true };
const desk = (width) => ({ viewport: { width, height: width > 1500 ? 1080 : 850 } });
const SLACK_MS = 800;

let port, root, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  const d = path.join(root, 'workspace', 'apps', 'bible'); fs.mkdirSync(d, { recursive: true });
  for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, 'workspace', 'apps', 'bible', f), path.join(d, f));
  web = startWeb(root); await waitReady(port);
  browser = await engine.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

async function open(opts) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp(UID, 'bible', 'bible'));
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'bible frame loaded');
  await frame.waitForFunction(() => document.querySelector('#nav .paab-home') && document.querySelectorAll('.verse').length > 5 && window.PATips);
  // First-use tips are another feature: dismissed here so a tip never takes the taps under test.
  for (let i = 0; i < 8 && await frame.locator('.pat-tip button').count(); i++) await frame.locator('.pat-tip button').first().click();
  return { ctx, page, frame };
}
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name + '.png') }) : null);
const barHidden = (frame) => frame.evaluate(() => document.getElementById('nav').getAttribute('data-paab-hidden') === '1');
// The control is on screen AND is what a finger at its centre would hit (nothing slid over it, nothing covers it).
const reachable = (frame, sel) => frame.evaluate((s) => { const b = document.querySelector(s), r = b.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight || r.width === 0) return false;
  const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && (e === b || b.contains(e)); }, sel);
// Polled for up to SLIDE_WAIT_MS: a control that is mid-slide is not yet where the finger lands (CI WebKit, 2026-11-27).
const SLIDE_WAIT_MS = 2000;
async function reachableSoon(frame, sel) {
  for (const end = Date.now() + SLIDE_WAIT_MS; ; await frame.waitForTimeout(50)) {
    if (await reachable(frame, sel)) return true;
    if (Date.now() > end) return false;
  }
}
const pressed = (frame) => frame.evaluate(() => { const b = document.getElementById('top-ai'); return { aria: b.getAttribute('aria-pressed'), on: b.classList.contains('on') }; });
const tapIn = async (page, frame, sel) => { const b = await frame.locator(sel).boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };

test('iPhone: after picking a chapter the bar stays (Ask AI reachable past the idle clock); a touch on the text lets it idle away again', { skip, timeout: 120000 }, async () => {
  const { ctx, page, frame } = await open(IPHONE);
  try {
    const idle = await frame.evaluate(() => PAAppBar.IDLE_MS);
    await tapIn(page, frame, '#ch-label');                       // the finger on the picker (iOS: the wheel opens)
    await frame.locator('#ch-label').selectOption('5');
    await frame.waitForFunction(() => document.getElementById('ch-label').value === '5' && document.querySelectorAll('.verse').length > 5);
    await frame.evaluate(() => document.activeElement && document.activeElement.blur());   // iOS: Done closes the wheel
    await frame.waitForTimeout(idle + SLACK_MS);
    assert.equal(await barHidden(frame), false, 'the bar is still shown after the idle clock');
    assert.equal(await reachable(frame, '#top-ai'), true, 'Ask AI can be tapped');
    assert.equal(await reachable(frame, '#ch-label'), true, 'and the chapter picker');
    assert.deepEqual(await fitProblems(frame, '#nav'), [], 'the bar fits at 390 with nothing cut');
    await shot(page, 'iphone-390-after-chapter-pick');
    // CONTROL: the reader goes back to the text (select a verse, tap again to clear it) — then it idles away as before.
    await tapIn(page, frame, '.verse:nth-of-type(3)');
    await frame.waitForFunction(() => !document.getElementById('top-mark').disabled);
    await tapIn(page, frame, '.verse:nth-of-type(3)');
    await frame.waitForFunction(() => document.getElementById('top-mark').disabled);
    await frame.waitForFunction(() => document.getElementById('nav').getAttribute('data-paab-hidden') === '1', null, { timeout: idle + 3000 });
    // ...and it comes back from the handle.
    await tapIn(page, frame, '.paab-handle');
    await frame.waitForFunction(() => document.getElementById('nav').getAttribute('data-paab-hidden') === '0');
    // The bar slides back in (.18s transform): wait out the slide, then the button must be under the finger.
    assert.equal(await reachableSoon(frame, '#top-ai'), true, 'back from the handle');
  } finally { await ctx.close(); }
});

test('iPhone: Ask AI shows pressed while its chat is open, clears on ✕; the ✕ is labelled 关闭 · Close', { skip, timeout: 120000 }, async () => {
  const { ctx, page, frame } = await open(IPHONE);
  try {
    assert.deepEqual(await pressed(frame), { aria: 'false', on: false }, 'boot: not pressed');
    await tapIn(page, frame, '#top-ai');
    await frame.waitForFunction(() => document.querySelector('.pac-fs.on'));
    await frame.waitForFunction(() => document.getElementById('top-ai').getAttribute('aria-pressed') === 'true');
    assert.deepEqual(await pressed(frame), { aria: 'true', on: true }, 'pressed while the chat is open');
    const x = frame.locator('.pac-fs.on .pac-close');
    assert.equal(await x.getAttribute('title'), '关闭 · Close', 'bilingual title (the Bible keeps both)');
    assert.equal(await x.getAttribute('aria-label'), '关闭 · Close', 'and the same for VoiceOver');
    assert.deepEqual(await fitProblems(frame), [], 'the open chat fits at 390');
    await shot(page, 'iphone-390-ask-ai-open');
    await tapIn(page, frame, '.pac-fs.on .pac-close');
    await frame.waitForFunction(() => !document.querySelector('.pac-fs.on'));
    await frame.waitForFunction(() => document.getElementById('top-ai').getAttribute('aria-pressed') === 'false');
    assert.deepEqual(await pressed(frame), { aria: 'false', on: false }, 'cleared when the chat closes');
  } finally { await ctx.close(); }
});

for (const [label, opts] of [['iPad 820', IPAD], ['desktop 1280', desk(1280)], ['desktop 1920', desk(1920)]]) {
  test(`${label}: Ask AI pressed while its chat is open, cleared after; the bar fits`, { skip, timeout: 120000 }, async () => {
    const { ctx, page, frame } = await open(opts);
    try {
      const w = opts.viewport.width;
      assert.deepEqual(await fitProblems(frame, '#nav'), [], `the bar fits at ${w}`);
      await frame.locator('#top-ai').click();
      await frame.waitForFunction(() => document.getElementById('top-ai').getAttribute('aria-pressed') === 'true');
      assert.deepEqual(await pressed(frame), { aria: 'true', on: true });
      await shot(page, `w${w}-ask-ai-open`);
      // Close it the way this width offers: the full-screen ✕, or the same top-bar button in the rail.
      if (await frame.locator('.pac-fs.on').count()) await frame.locator('.pac-fs.on .pac-close').click();
      else await frame.locator('#top-ai').click();
      await frame.waitForFunction(() => document.getElementById('top-ai').getAttribute('aria-pressed') === 'false');
      assert.deepEqual(await pressed(frame), { aria: 'false', on: false });
    } finally { await ctx.close(); }
  });
}
