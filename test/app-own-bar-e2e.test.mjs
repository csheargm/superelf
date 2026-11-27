// The app's own bar (web/app-bar.inline.html, ADR 0032) in a REAL browser (R6): the real web.mjs on a
// throwaway root, the real shell, and the shipped Bible and Journal (workspace/apps) in its sandboxed
// iframe. Checks: the shell bar and its handle are gone for an ownBar app; ← Home inside the app goes
// Home; A+ inside the app steps the SAME setting the shell's A+ does; the Bible bar hides on scroll down
// and returns on scroll up; the Journal bar hides on a page touch and returns from the handle; a pen
// stroke still inks while it hides. CONTROLS (R14): an app WITHOUT ownBar keeps the shell bar and peek
// handle, its forged {pa:'shell'} messages do nothing, and neither does one posted by the shell window.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

let port, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); const root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  for (const [slug, src, meta] of [['bible', 'bible', null], ['notes', 'notes', null], ['plain', 'notes', { title: 'Plain', desc: 'no own bar' }]]) {
    const d = path.join(root, 'workspace', 'apps', slug); fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'workspace', 'apps', src, 'index.html'), path.join(d, 'index.html'));
    if (meta) fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta));
    else fs.copyFileSync(path.join(ROOT, 'workspace', 'apps', src, 'meta.json'), path.join(d, 'meta.json'));
  }
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

async function open(slug, ready, viewport = { width: 1100, height: 850 }) {
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
  return { ctx, page, frame };
}
const shellBar = (page) => page.evaluate(() => ({ cls: document.querySelector('#frame').className,
  bar: getComputedStyle(document.querySelector('#frame .bar')).display, peek: getComputedStyle(document.querySelector('#barpeek')).display }));
const barHidden = (frame, sel) => frame.evaluate((s) => document.querySelector(s).getAttribute('data-paab-hidden') === '1', sel);

test('Bible: own bar replaces the shell bar; A+ steps the shell setting; scroll up shows, down does nothing; Home goes home', { skip, timeout: 90000 }, async () => {
  const { ctx, page, frame } = await open('bible', () => document.querySelector('#nav .paab-home') && document.querySelectorAll('.verse').length > 5);
  try {
    await page.waitForFunction(() => document.querySelector('#frame').classList.contains('ownbar'));
    assert.deepEqual(await shellBar(page), { cls: 'peek ownbar', bar: 'none', peek: 'none' }, 'no shell bar and no shell handle');
    const fs0 = await page.evaluate(() => FS_STEPS[fsIdx]);
    await frame.locator('#nav .paab-up').click();
    await page.waitForFunction((v) => FS_STEPS[fsIdx] > v, fs0);
    const fs1 = await page.evaluate(() => FS_STEPS[fsIdx]);
    await page.evaluate(() => fsStep(-1));    // the shell's own step, for the same distance
    assert.equal(await page.evaluate(() => FS_STEPS[fsIdx]), fs0, 'one in-app A+ = one shell step');
    await frame.waitForFunction((v) => getComputedStyle(document.documentElement).getPropertyValue('--fs').trim() === String(v), fs0);
    assert.ok(fs1 > fs0);
    assert.match(await frame.locator('#nav .paab-up').getAttribute('title'), /长按恢复默认 · long-press to reset/, 'titles from the shell (one source)');
    assert.equal(await barHidden(frame, '#nav'), false);
    await frame.evaluate(() => { PAAppBar.show(); document.getElementById('verses').scrollTop = 400; });
    await frame.waitForTimeout(150);
    assert.equal(await barHidden(frame, '#nav'), false, 'scrolling down does not hide it (ADR 0035)');
    await frame.evaluate(() => PAAppBar.hide());
    assert.equal(await frame.evaluate(() => document.querySelector('.paab-handle').classList.contains('on')), true, 'the handle shows while hidden');
    await frame.evaluate(() => { document.getElementById('verses').scrollTop = 600; });
    await frame.waitForTimeout(150);
    assert.equal(await barHidden(frame, '#nav'), true, 'scrolling down does not show it either');
    await frame.evaluate(() => { document.getElementById('verses').scrollTop = 300; });
    await frame.waitForFunction(() => document.getElementById('nav').getAttribute('data-paab-hidden') === '0');
    // A tip beside Home (ADR 0030): it may wait behind another page tip, so it must at least be registered.
    assert.ok(await frame.evaluate(() => PATips.registered().some((r) => r.id === 'app-own-bar')), 'the first-use tip is registered');
    await frame.locator('#nav .paab-home').click();
    await page.waitForFunction(() => document.querySelector('#frame').style.display === 'none');
  } finally { await ctx.close(); }
});

test('Bible: an open search keeps the bar (keepOpen)', { skip, timeout: 60000 }, async () => {
  const { ctx, frame } = await open('bible', () => document.querySelector('#nav .paab-home') && document.querySelectorAll('.verse').length > 5);
  try {
    await frame.evaluate(() => { PAAppBar.show(); document.getElementById('search-overlay').classList.add('on'); });
    await frame.waitForTimeout(await frame.evaluate(() => PAAppBar.IDLE_MS + 600));
    assert.equal(await barHidden(frame, '#nav'), false, 'never hides under an open sheet');
  } finally { await ctx.close(); }
});

// R3 review 2026-11-13: Highlight opens the PAVerseMarks sheet, which keepOpen did not see, so a bar the
// handle brought back hid at once after the tap (and on a tap inside the sheet).
test('Bible: Highlight on a handle-shown bar keeps the bar while its sheet is open', { skip, timeout: 90000 }, async () => {
  const { ctx, frame } = await open('bible', () => document.querySelector('#nav .paab-home') && document.querySelectorAll('.verse').length > 5);
  try {
    await frame.evaluate(() => PAAppBar.hide());
    await frame.locator('.paab-handle').click();
    await frame.waitForFunction(() => document.querySelector('#nav').getAttribute('data-paab-hidden') === '0');
    await frame.evaluate(() => { const v = [...document.querySelectorAll('.verse')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight; });
      const line = v.querySelector('.ven') || v; const r = document.createRange(); r.selectNodeContents(line.firstChild && line.firstChild.nodeType === 3 ? line.firstChild : line); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); });
    await frame.waitForFunction(() => !document.getElementById('top-mark').disabled);
    await frame.locator('#top-mark').click();
    await frame.waitForSelector('.pvm-sheet');
    await frame.waitForTimeout(await frame.evaluate(() => PAAppBar.IDLE_MS + 600));   // past the idle clock
    assert.equal(await barHidden(frame, '#nav'), false, 'the bar stays while the Highlight sheet is open');
    const box = await frame.locator('.pvm-sheet').boundingBox();
    await frame.evaluate(([x, y]) => document.elementFromPoint(x, y).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })), [box.x + 2, box.y + 2]);
    assert.equal(await barHidden(frame, '#nav'), false, 'a tap inside the sheet keeps it');
  } finally { await ctx.close(); }
});

test('Journal: own bar; a pen stroke inks and leaves the bar as it was; the handle brings it back', { skip, timeout: 90000 }, async () => {
  const { ctx, page, frame } = await open('notes', () => document.querySelector('.pan-top .paab-home') && window.PANote);
  try {
    await page.waitForFunction(() => document.querySelector('#frame').classList.contains('ownbar'));
    assert.equal((await shellBar(page)).bar, 'none');
    assert.ok(await frame.evaluate(() => document.querySelector('.pan-top').firstElementChild.classList.contains('paab-home')), 'Home is the leftmost control');
    await frame.evaluate(() => window.PANotesBoot);   // the list docks at the end of boot: look only after it (helpers-note-link.mjs)
    if (await frame.evaluate(() => !!document.querySelector('.pac-drawerhost.on'))) {   // a docked list closes on the first page tap
      const b = await page.locator('#fr').boundingBox(); await page.mouse.click(b.x + b.width - 40, b.y + b.height / 2);
      await frame.waitForFunction(() => !document.querySelector('.pac-drawerhost.on'));
    }
    const box = await page.locator('#fr').boundingBox();
    const cdp = await ctx.newCDPSession(page);
    const pen = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
    const x0 = box.x + box.width / 2, y0 = box.y + box.height / 2;
    const inkOf = () => frame.evaluate(() => [...document.querySelectorAll('.pan-fs canvas')].map((c) => c.width ? c.toDataURL().length : 0).join(','));
    await frame.locator('.pan-top .pan-mdraw').click(); await page.waitForTimeout(200);   // Draw mode: the pen inks
    const before = await inkOf();
    await pen('mousePressed', x0, y0);
    for (let i = 1; i <= 8; i++) await pen('mouseMoved', x0 + i * 12, y0 + i * 4);
    await pen('mouseReleased', x0 + 96, y0 + 32);
    await page.waitForTimeout(300);
    assert.notEqual(await inkOf(), before, 'the stroke inked: the bar took nothing from the pen');
    assert.equal(await barHidden(frame, '.pan-top'), false, 'a Pencil stroke neither hides (ADR 0035) …');
    await frame.evaluate(() => PAAppBar.hide());
    await pen('mousePressed', x0, y0 - 100);
    for (let i = 1; i <= 8; i++) await pen('mouseMoved', x0, y0 - 100 + i * 25);
    await pen('mouseReleased', x0, y0 + 100);
    await page.waitForTimeout(200);
    assert.equal(await barHidden(frame, '.pan-top'), true, '… nor a downward Pencil stroke shows it');
    await frame.locator('.paab-handle').click();
    await frame.waitForFunction(() => document.querySelector('.pan-top').getAttribute('data-paab-hidden') === '0');
  } finally { await ctx.close(); }
});

test('CONTROL: an app without ownBar keeps the shell bar, and forged shell messages do nothing', { skip, timeout: 60000 }, async () => {
  const { ctx, page, frame } = await open('plain', () => window.PANote && document.querySelector('.pan-top'));
  try {
    await page.waitForTimeout(500);
    const s = await shellBar(page);
    assert.equal(s.cls.includes('ownbar'), false); assert.equal(s.peek, 'flex', 'the shell handle is there');
    assert.equal(await frame.evaluate(() => !!document.querySelector('.paab-home')), false, 'the component draws nothing without ownBar');
    const fs0 = await page.evaluate(() => fsIdx);
    await frame.evaluate(() => { parent.postMessage({ pa: 'shell', type: 'ready' }, '*'); parent.postMessage({ pa: 'shell', type: 'font', d: 1 }, '*'); parent.postMessage({ pa: 'shell', type: 'home' }, '*'); });
    await page.evaluate(() => { postMessage({ pa: 'shell', type: 'home' }, '*'); postMessage({ pa: 'shell', type: 'font', d: 1 }, '*'); });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.querySelector('#frame').style.display), 'flex', 'still in the app');
    assert.equal(await page.evaluate(() => fsIdx), fs0, 'no font step');
    assert.equal((await shellBar(page)).cls.includes('ownbar'), false);
  } finally { await ctx.close(); }
});

test('phone 375px: the Bible and Journal bars do not run off the screen', { skip, timeout: 90000 }, async () => {
  for (const [slug, sel, ready] of [['bible', '#nav', () => document.querySelector('#nav .paab-home')], ['notes', '.pan-top', () => document.querySelector('.pan-top .paab-home')]]) {
    const { ctx, frame } = await open(slug, ready, { width: 375, height: 812 });
    try {
      const out = await frame.evaluate((s) => [...document.querySelectorAll(`${s} button, ${s} select`)].filter((e) => e.offsetParent)
        .map((e) => ({ c: e.className || e.id, r: Math.round(e.getBoundingClientRect().right) })).filter((x) => x.r > innerWidth + 1), sel);
      assert.deepEqual(out, [], `${slug}: nothing past the right edge`);
      if (slug === 'notes') assert.equal(await frame.evaluate(() => !!document.querySelector('.pan-paperpop .paab-narrow .paab-up')), true, 'Journal phone: A-/A+ sit in the page-settings menu');
    } finally { await ctx.close(); }
  }
});

// The component alone (top-level page: its parent is itself, so it hears its own prefs and posts).
const BAR = fs.readFileSync(path.join(ROOT, 'web', 'app-bar.inline.html'), 'utf8');
const HOST = `<div id="bar" style="display:flex"><button id="menu">☰</button></div><div id="sc" style="height:300px;overflow:auto"><div style="height:3000px"></div></div>
${BAR}<script>window.got=[];addEventListener('message',(e)=>{ if(e.data&&e.data.pa==='shell') got.push(e.data); });
window.open_=false; PAAppBar.attach({bar:document.getElementById('bar'),scroller:document.getElementById('sc'),keepOpen:()=>open_});
document.addEventListener('pointerdown',(e)=>{ window.prevented=e.defaultPrevented; });</script>`;
test('component: draws nothing until ownBar; posts exact messages; long-press resets without a step; passive touch; keepOpen', { skip, timeout: 60000 }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(HOST);
    assert.equal(await page.evaluate(() => !!document.querySelector('.paab-home')), false, 'off by default');
    await page.evaluate(() => postMessage({ pa: 'prefs', ownBar: true, fsTitles: ['dn', 'up'] }, '*'));
    await page.waitForSelector('#bar .paab-home');
    await page.waitForFunction(() => got.some((m) => m.type === 'ready'));
    await page.click('.paab-up'); await page.click('.paab-dn'); await page.click('.paab-home');
    await page.waitForFunction(() => got.length >= 4);
    assert.deepEqual(await page.evaluate(() => got.slice(1)), [{ pa: 'shell', type: 'font', d: 1 }, { pa: 'shell', type: 'font', d: -1 }, { pa: 'shell', type: 'home', d: 0 }]);
    const box = await page.locator('.paab-up').boundingBox();
    await page.evaluate(() => { got.length = 0; });
    await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up();
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => got), [{ pa: 'shell', type: 'font', d: 0 }], 'reset only, no step');
    assert.equal(await page.locator('.paab-up').getAttribute('title'), 'up');
    await page.evaluate(() => { PAAppBar.show(); document.getElementById('sc').scrollTop = 400; });
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => PAAppBar.state().hidden), false, 'scroll down: nothing');
    await page.mouse.click(200, 200);
    assert.equal(await page.evaluate(() => PAAppBar.state().hidden), false, 'a page touch: nothing');
    assert.equal(await page.evaluate(() => window.prevented), false, 'the listeners never prevent default');
    await page.evaluate(() => { open_ = true; PAAppBar.hide(); });
    assert.equal(await page.evaluate(() => PAAppBar.state().hidden), false, 'keepOpen blocks hiding');
    await page.evaluate(() => { open_ = false; PAAppBar.hide(); document.getElementById('sc').scrollTop = 300; });
    await page.waitForFunction(() => !PAAppBar.state().hidden);
  } finally { await page.close(); }
});

test('Journal: a tap inside the open highlight popover keeps the bar; a hidden bar is inert', { skip, timeout: 90000 }, async () => {
  const { ctx, frame } = await open('notes', () => document.querySelector('.pan-top .paab-home') && window.PANote);
  try {
    await frame.evaluate(() => { const p = document.querySelector('.pan-hlpop'); p.classList.add('on'); p.style.cssText += ';left:200px;top:300px;width:120px;height:80px'; });
    await frame.evaluate(() => { PAAppBar.show(); const p = document.querySelector('.pan-hlpop'); p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })); });
    await frame.waitForTimeout(await frame.evaluate(() => PAAppBar.IDLE_MS + 600));   // past the idle clock
    assert.equal(await barHidden(frame, '.pan-top'), false, 'never hides under the highlight popover');
    await frame.evaluate(() => document.querySelector('.pan-hlpop').classList.remove('on'));
    await frame.evaluate(() => PAAppBar.hide());
    assert.equal(await frame.evaluate(() => document.querySelector('.pan-top').inert), true, 'hidden: out of the tab order');
    await frame.evaluate(() => PAAppBar.show());
    assert.equal(await frame.evaluate(() => document.querySelector('.pan-top').inert), false);
  } finally { await ctx.close(); }
});
