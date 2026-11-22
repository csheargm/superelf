// The app bar's gestures (web/app-bar.inline.html, ADR 0035) on a PHONE in a REAL browser (R6): 390x844,
// hasTouch + isMobile, with real touch swipes through CDP Input.dispatchTouchEvent on the shipped Bible and
// Journal in the real shell. Owner 2026-11-13 (iPhone):
//   a finger swipe up hides at once (ADR 0036); pull down shows (also an overscroll pull at the very top); shown, the bar hides
//   itself after IDLE_MS; keepOpen (Note pane, Highlight sheet) holds it; hidden, the page starts at the
//   safe-area top (no stripe); the Bible's phone labels are one short line; a Pencil never pulls it.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

const PHONE = { width: 390, height: 844 };
let port, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); const root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  for (const slug of ['bible', 'notes']) {
    const d = path.join(root, 'workspace', 'apps', slug); fs.mkdirSync(d, { recursive: true });
    for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, 'workspace', 'apps', slug, f), path.join(d, f));
  }
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

const READY = { bible: () => document.querySelector('#nav .paab-home') && document.querySelectorAll('.verse').length > 5,
  notes: () => document.querySelector('.pan-top .paab-home') && window.PANote };
const BAR = { bible: '#nav', notes: '.pan-top' };
async function open(slug) {
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok') && OWNBAR_APPS.size > 0);
  await page.evaluate((s) => openApp(UID, s, s), slug);
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes(`/app/owner/${slug}/`)) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, `${slug} frame loaded`);
  await frame.waitForFunction(READY[slug]);
  // A docked note list (Journal) is a keepOpen surface: close it so the bar is free to idle.
  await frame.evaluate(() => document.querySelectorAll('.pac-drawerhost.on').forEach((d) => d.classList.remove('on')));
  const cdp = await ctx.newCDPSession(page);
  // A real one-finger swipe, in page (shell) coordinates; the app frame fills the screen.
  const swipe = async (x, y0, y1, steps = 8) => {
    const pt = (y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(y0) });
    for (let i = 1; i <= steps; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y0 + ((y1 - y0) * i) / steps) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(120);
  };
  const hidden = () => frame.evaluate((s) => document.querySelector(s).getAttribute('data-paab-hidden') === '1', BAR[slug]);
  return { ctx, page, frame, swipe, hidden, cdp };
}

for (const slug of ['bible', 'notes']) {
  test(`${slug} phone: a finger swipe up hides at once; pull down shows, also at the very top`, { skip, timeout: 90000 }, async () => {
    const { ctx, frame, swipe, hidden } = await open(slug);
    try {
      await frame.evaluate(() => PAAppBar.show());
      await swipe(200, 650, 250);
      assert.equal(await hidden(), true, 'swipe up hides, well before the idle clock');
      await swipe(200, 650, 250);
      assert.equal(await hidden(), true, 'hidden stays hidden');
      if (slug === 'bible') await frame.evaluate(() => { document.getElementById('verses').scrollTop = 0; });
      await frame.evaluate(() => PAAppBar.hide());
      await swipe(200, 250, 650);
      assert.equal(await hidden(), false, 'a pull down shows it (at the top: an overscroll pull, nothing scrolls)');
      if (slug === 'bible') {   // mid-chapter: the same pull is a scroll up
        await frame.evaluate(() => { document.getElementById('verses').scrollTop = 800; PAAppBar.hide(); });
        await swipe(200, 300, 600);
        assert.equal(await hidden(), false, 'a pull down mid-chapter shows it');
      }
    } finally { await ctx.close(); }
  });

  test(`${slug} phone: shown, it hides itself after ~IDLE_MS; a tap on A+ restarts the clock`, { skip, timeout: 90000 }, async () => {
    const { ctx, frame, hidden } = await open(slug);
    try {
      const ms = await frame.evaluate(() => PAAppBar.IDLE_MS);
      assert.ok(ms >= 3000 && ms <= 5000);
      await frame.evaluate(() => PAAppBar.show());
      await frame.waitForTimeout(ms - 1200);
      const up = frame.locator('.paab-up').first();
      if (await up.isVisible()) {   // Journal phone: A-/A+ sit in a menu (keepOpen), so tap the bar's Home row instead
        await frame.evaluate(() => { const b = document.querySelector('.paab-up'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); });
      } else await frame.evaluate((s) => { const b = document.querySelector(s); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); }, BAR[slug]);
      await frame.waitForTimeout(1800);
      assert.equal(await hidden(), false, 'the tap bought a fresh idle period');
      await frame.waitForFunction((s) => document.querySelector(s).getAttribute('data-paab-hidden') === '1', BAR[slug], { timeout: ms + 500 });
    } finally { await ctx.close(); }
  });

  test(`${slug} phone: hidden, the page starts at the safe-area top — no stripe`, { skip, timeout: 90000 }, async () => {
    const { ctx, frame } = await open(slug);
    try {
      const top = () => frame.evaluate((s) => {
        const el = s === '#nav' ? document.getElementById('verses') : document.querySelector('.pan-pageInner');
        return Math.round(el.getBoundingClientRect().top);
      }, BAR[slug]);
      await frame.evaluate(() => PAAppBar.show()); await frame.waitForTimeout(300);
      const shown = await top();
      assert.ok(shown > 30, `control: shown, the page sits below the bar (${shown}px)`);
      await frame.evaluate(() => PAAppBar.hide()); await frame.waitForTimeout(400);
      // Playwright's safe-area inset is 0, so the first content row must be row 0 of the frame.
      assert.ok(Math.abs(await top()) <= 1, `hidden: the page starts at the top (${await top()}px)`);
      const hit = await frame.evaluate((s) => { const e = document.elementFromPoint(innerWidth / 4, 2); return !!(e && e.closest(s)); }, BAR[slug]);
      assert.equal(hit, false, 'the top pixel row is not the bar');
      await frame.evaluate(() => PAAppBar.show()); await frame.waitForTimeout(400);
      assert.equal(await top(), shown, 'shown again, it is back below the bar');
    } finally { await ctx.close(); }
  });

  test(`${slug} phone: an Apple Pencil pull never shows the bar; a finger pull does`, { skip, timeout: 90000 }, async () => {
    const { ctx, page, frame, swipe, hidden, cdp } = await open(slug);
    try {
      await frame.evaluate(() => PAAppBar.hide());
      const pen = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
      await pen('mousePressed', 200, 250);
      for (let i = 1; i <= 8; i++) await pen('mouseMoved', 200, 250 + i * 50);
      await pen('mouseReleased', 200, 650); await page.waitForTimeout(150);
      assert.equal(await hidden(), true, 'a real pen pointer drag down');
      // iOS: a Pencil sends pointerType 'pen' AND touch events with touchType 'stylus'.
      await frame.evaluate(() => {
        const t = document.elementFromPoint(200, 300) || document.body;
        const T = (y) => new Touch({ identifier: 9, target: t, clientX: 200, clientY: y, touchType: 'stylus' });
        t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen' }));
        t.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [T(250)] }));
        for (let y = 300; y <= 650; y += 50) t.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [T(y)] }));
        t.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
        t.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'pen' }));
      });
      assert.equal(await hidden(), true, 'stylus touches');
      await swipe(200, 250, 650);
      assert.equal(await hidden(), false, 'control: the same pull with a finger shows it');
    } finally { await ctx.close(); }
  });
}

test('bible phone: Note pane and Highlight sheet hold the bar past the idle clock', { skip, timeout: 90000 }, async () => {
  const { ctx, frame, hidden } = await open('bible');
  try {
    const ms = await frame.evaluate(() => PAAppBar.IDLE_MS);
    await frame.evaluate(() => { PAAppBar.show(); document.getElementById('top-note').click(); });
    // A phone has no rail: Note opens the pad full screen (.pan-fs.on); a wide screen presses the toggle.
    const noteUp = () => document.getElementById('top-note').getAttribute('aria-pressed') === 'true' || !!document.querySelector('.pan-fs.on');
    await frame.waitForFunction(noteUp);
    await frame.waitForTimeout(ms + 600);
    assert.equal(await hidden(), false, 'Note pane open: the bar stays');
    await frame.evaluate(() => { const x = document.querySelector('.pan-fs.on .pan-hx'); if (x) x.click(); else document.getElementById('top-note').click(); });
    await frame.waitForFunction((f) => !new Function(`return (${f})()`)(), noteUp.toString());
    await frame.waitForFunction(() => document.getElementById('nav').getAttribute('data-paab-hidden') === '1', null, { timeout: ms + 1000 });
    await frame.evaluate(() => PAAppBar.show());
    await frame.evaluate(() => { const v = [...document.querySelectorAll('.verse')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 160 && r.bottom < innerHeight - 100; });
      const line = v.querySelector('.ven') || v; const r = document.createRange(); r.selectNodeContents(line.firstChild && line.firstChild.nodeType === 3 ? line.firstChild : line); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); });
    await frame.waitForFunction(() => !document.getElementById('top-mark').disabled);
    await frame.evaluate(() => document.getElementById('top-mark').click());
    await frame.waitForSelector('.pvm-sheet');
    await frame.waitForTimeout(ms + 600);
    assert.equal(await hidden(), false, 'Highlight sheet open: the bar stays');
  } finally { await ctx.close(); }
});

test('bible phone: the top-bar controls are ONE short line each, full label kept for a11y; nothing clipped at 375 / 390px', { skip, timeout: 90000 }, async () => {
  for (const width of [375, 390]) {
    const { ctx, page, frame } = await open('bible');
    try {
      await page.setViewportSize({ width, height: 812 }); await frame.waitForTimeout(300);
      const r = await frame.evaluate(() => [...document.querySelectorAll('#top-panes .top-pane')].map((b) => {
        const cs = getComputedStyle(b, '::after'), br = b.getBoundingClientRect();
        return { id: b.id, after: cs.content, ws: cs.whiteSpace, h: Math.round(br.height), right: Math.round(br.right), over: b.scrollWidth > b.clientWidth + 1, label: b.getAttribute('aria-label') };
      }));
      const want = { 'top-mark': '"高亮"', 'top-note': '"笔记"', 'top-ai': '"问AI"' };
      for (const b of r) {
        assert.equal(b.after, want[b.id], `${width}: ${b.id} shows its short label`);
        assert.equal(b.over, false, `${width}: ${b.id} not clipped`);
        assert.ok(b.right <= width, `${width}: ${b.id} on screen (${b.right})`);
        assert.match(b.label || '', / · /, `${width}: ${b.id} keeps the full bilingual name`);
      }
      const lines = await frame.evaluate(() => [...document.querySelectorAll('#top-panes .top-pane')].map((b) => {
        // One line: a probe span with the same short text and font, in the same box, is no taller than one line.
        const p = document.createElement('span'); p.textContent = b.dataset.short; p.style.cssText = 'font-size:13px;line-height:1.5'; b.appendChild(p);
        const n = p.getClientRects().length; p.remove(); return n; }));
      assert.deepEqual(lines, lines.map(() => 1), `${width}: single line`);
    } finally { await ctx.close(); }
  }
});
