// Bible reader fixes in a REAL browser (R6): the real web.mjs on a throwaway root, the real shell and the
// shipped Bible in its sandboxed iframe. Each test names the triage item it covers (overnight 2026-11-23).
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

let port, web, browser, root;
const NOTES = () => path.join(root, 'workspace', 'data', 'bible', 'notes');
before(async () => {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  const d = path.join(root, 'workspace', 'apps', 'bible'); fs.mkdirSync(d, { recursive: true });
  for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, 'workspace', 'apps', 'bible', f), path.join(d, f));
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

const ready = () => document.querySelector('#nav .paab-home') && document.querySelectorAll('.verse').length > 5;
async function open({ viewport = { width: 1100, height: 850 }, touch = false } = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp(UID, 'bible', 'bible'));
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'bible frame loaded');
  await frame.waitForFunction(ready);
  return { ctx, page, frame };
}

// F2-07: the first-use bar tip leaves at the first tap anywhere (and is remembered). Runs first: tipsSeen lives on this server.
test('F2-07: the app-bar tip is dismissed by the first tap on the page, and stays dismissed on reopen', { skip, timeout: 90000 }, async () => {
  let { ctx, frame } = await open();
  try {
    await frame.waitForFunction(() => PATips.current() === 'app-own-bar');
    await frame.locator('.verse').nth(3).click();
    await frame.waitForFunction(() => !document.querySelector('.pat-tip'));
    await frame.evaluate(() => PATips.whenIdle());
  } finally { await ctx.close(); }
  ({ ctx, frame } = await open());
  try {
    await frame.waitForTimeout(1500);
    assert.notEqual(await frame.evaluate(() => PATips.current()), 'app-own-bar', 'not shown again');
    assert.ok(await frame.evaluate(() => PATips.seen().includes('app-own-bar')));
  } finally { await ctx.close(); }
});

// F2-12: a verse with only a highlight is listed as a Highlight row, not as a "Note".
test('F2-12: ☰ lists a highlight-only verse as 高亮 · Highlight; a verse with note text stays Note', { skip, timeout: 90000 }, async () => {
  fs.mkdirSync(NOTES(), { recursive: true });
  fs.writeFileSync(path.join(NOTES(), '1-1.json'), JSON.stringify({ notes: { v2: 'In the beginning — my note' }, marks: { v1: [{ kind: 'hl', color: 'yellow' }] } }));
  const { ctx, frame } = await open();
  try {
    await frame.locator('#log-btn').click();
    await frame.waitForFunction(() => document.querySelectorAll('.pac-lrow').length >= 2);
    const rows = await frame.evaluate(() => [...document.querySelectorAll('.pac-lrow')].map((r) => ({
      title: r.querySelector('.pac-lttl').textContent, chip: (r.querySelector('.pac-lchip') || {}).textContent || '' })));
    const hl = rows.find((r) => /Genesis 1:1$/.test(r.title)), note = rows.find((r) => /my note/.test(r.title));
    assert.ok(hl && note, JSON.stringify(rows));
    assert.equal(hl.chip, '高亮 · Highlight', 'highlight-only verse');
    assert.equal(note.chip, 'Note', 'control: a verse with note text keeps the Note chip');
  } finally { await ctx.close(); }
});

// F2-11: a direct /app/owner/bible/ link with no session lands on the shell's sign-in, then opens the Bible.
test('F2-11: signed-out direct app link → shell sign-in with #open; after sign-in the Bible opens and the hash is cleared', { skip, timeout: 90000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  try {
    const page = await ctx.newPage();
    const resp = await page.goto(`http://127.0.0.1:${port}/app/owner/bible/`);
    assert.equal(new URL(page.url()).hash, '#open=owner/bible', 'redirected to the shell with the return path');
    assert.ok(resp.ok(), 'the shell page, not a bare "not found"');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /^not found$/);
    await page.evaluate((t) => localStorage.setItem('pa_session', t), OWNER_TOKEN);   // stands in for the sign-in step
    await page.reload();
    let frame = null;
    for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
    assert.ok(frame, 'the Bible opened from the link');
    await frame.waitForFunction(ready);
    assert.equal(new URL(page.url()).hash, '', 'the hash is consumed: Home or a reload does not reopen it');
  } finally { await ctx.close(); }
});

// F2-06: the top bar hides by itself only on touch while reading; never for a desktop mouse, never while a verse is selected.
const barHidden = (frame) => frame.evaluate(() => document.querySelector('#nav').getAttribute('data-paab-hidden') === '1');
test('F2-06: desktop mouse — the bar stays past the idle clock and after a wheel down', { skip, timeout: 90000 }, async () => {
  const { ctx, page, frame } = await open();
  try {
    const ms = await frame.evaluate(() => PAAppBar.IDLE_MS);
    await page.mouse.move(500, 500); await page.mouse.wheel(0, 300);
    await frame.waitForTimeout(ms + 800);
    assert.equal(await barHidden(frame), false);
  } finally { await ctx.close(); }
});
test('F2-06: touch — a selected verse holds the bar; cleared, it idles away (control)', { skip, timeout: 90000 }, async () => {
  const { ctx, frame } = await open({ viewport: { width: 820, height: 1180 }, touch: true });
  try {
    const ms = await frame.evaluate(() => PAAppBar.IDLE_MS);
    await frame.locator('.verse').nth(2).tap();
    await frame.waitForFunction(() => !document.getElementById('top-mark').disabled);
    await frame.waitForTimeout(ms + 800);
    assert.equal(await barHidden(frame), false, 'held while a verse is selected');
    await frame.locator('.verse').nth(2).tap();   // a second tap clears it
    await frame.waitForFunction(() => document.getElementById('top-mark').disabled);
    await frame.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); PAAppBar.show(); });
    await frame.waitForFunction(() => document.querySelector('#nav').getAttribute('data-paab-hidden') === '1', null, { timeout: ms + 3000 });
  } finally { await ctx.close(); }
});

// F2-03: next / previous chapter — buttons at the chapter end, ← → on desktop, a finger swipe on touch.
const where = (frame) => frame.evaluate(() => [+document.getElementById('book-sel').value, +document.getElementById('ch-label').value]);
test('F2-03: chapter-end buttons step chapters (across books), ← → keys step on desktop, but not while typing', { skip, timeout: 90000 }, async () => {
  const { ctx, frame } = await open();
  try {
    await frame.evaluate(() => { bookIdx = 0; chapter = 50; document.getElementById('book-sel').value = 0; return load(); });
    assert.equal(await frame.locator('#end-prev').isDisabled(), false);
    await frame.locator('#end-next').scrollIntoViewIfNeeded(); await frame.locator('#end-next').click();
    await frame.waitForFunction(() => +document.getElementById('book-sel').value === 1 && document.querySelectorAll('.verse').length > 5);
    assert.deepEqual(await where(frame), [1, 1], 'Genesis 50 → Exodus 1');
    await frame.locator('body').press('ArrowLeft');
    await frame.waitForFunction(() => +document.getElementById('book-sel').value === 0);
    assert.deepEqual(await where(frame), [0, 50], '← goes back across the book');
    await frame.locator('#search-btn').click(); await frame.locator('#search-inp').press('ArrowRight');
    assert.deepEqual(await where(frame), [0, 50], 'an arrow in the search box moves the caret, not the chapter');
    await frame.locator('#search-close').click();
    await frame.evaluate(() => { bookIdx = 0; chapter = 1; document.getElementById('book-sel').value = 0; return load(); });
    assert.equal(await frame.locator('#end-prev').isDisabled(), true, 'Genesis 1 has no previous');
  } finally { await ctx.close(); }
});
test('F2-03: a finger swipe left turns to the next chapter, right goes back; a vertical drag does not', { skip, timeout: 90000 }, async () => {
  const { ctx, page, frame } = await open({ viewport: { width: 820, height: 1180 }, touch: true });
  try {
    await frame.evaluate(() => { bookIdx = 42; chapter = 3; document.getElementById('book-sel').value = 42; return load(); });   // a known chapter, whatever the history restored
    const start = await where(frame);
    const cdp = await ctx.newCDPSession(page);
    const swipe = async (x0, y0, x1, y1) => {
      const pt = (x, y) => [{ x, y, id: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) });
      for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x0 + ((x1 - x0) * k) / 6, y0 + ((y1 - y0) * k) / 6) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(600, 600, 200, 620);
    await frame.waitForFunction((c) => +document.getElementById('ch-label').value === c + 1 && document.querySelectorAll('.verse').length > 5, start[1]);
    await swipe(200, 600, 600, 610);
    await frame.waitForFunction((c) => +document.getElementById('ch-label').value === c, start[1]);
    await swipe(400, 800, 420, 400); await frame.waitForTimeout(600);
    assert.deepEqual(await where(frame), start, 'a vertical drag scrolls, it never turns the page');
  } finally { await ctx.close(); }
});

// Triage 2026-11-23 item 7: each Bible open logged four 404s ("Failed to load resource") for data that
// does not exist yet — general.json, notes/<book>-<ch>.json and both .bak. Now none. CONTROL (R14): the
// same reads DID happen (answered 204), so a pass is not the reads being skipped.
test('opening the Bible on a fresh account logs no 404 for absent data files', { skip, timeout: 60000 }, async () => {
  fs.rmSync(path.join(root, 'workspace', 'data', 'bible'), { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage(); const bad = [], absent = [];
  page.on('response', (r) => { const u = r.url(); if (!u.includes('/api/data/')) return; if (r.status() >= 400) bad.push(`${r.status()} ${u}`); if (r.status() === 204) absent.push(u); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp(UID, 'bible', 'bible'));
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
  await frame.waitForFunction(ready); await page.waitForTimeout(800);
  assert.deepEqual(bad, [], 'no 4xx/5xx data reads');
  assert.ok(absent.some((u) => /general\.json\.bak\?/.test(u)), `CONTROL: the .bak probe ran and was answered 204: ${absent.join(' ')}`);
  await ctx.close();
});
