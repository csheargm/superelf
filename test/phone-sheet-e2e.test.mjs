// iPhone tool strip + the ONE bottom sheet + the list on a phone · 手机工具条、底部面板与列表
//
// Plan journal-iphone step 3 (rule 5 and the minor items). Real web.mjs on a throwaway root, the Journal
// template (it carries the app bar), an iPhone viewport with touch (WebKit in CI's iPhone job via
// PA_E2E_ENGINE) and an iPad viewport as the control: at 820px every control and menu is where it was.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { skip, setup, teardown, newContext, openJournal, port } from './helpers-note-link.mjs';

const serverRoot = () => { const pid = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -Fp | head -1`).toString().trim().slice(1);
  return execSync(`lsof -a -p ${pid} -d cwd -Fn | tail -1`).toString().trim().slice(1); };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const IPAD = { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const INK = [{ p: [[0.05, 0.05, 0.5], [0.5, 0.06, 0.5]], c: '#1c1e1d', w: 0.004, t: 'pen' }];
const TAP = 44;
let root;

function seed() {
  const d = path.join(root, 'workspace', 'data', 'notes'); fs.mkdirSync(d, { recursive: true });
  const t = Date.now();
  const notes = { inkA: { strokes: INK, pageHtml: '' }, blankB: { strokes: [], pageHtml: '' } };
  for (const [id, pg] of Object.entries(notes)) fs.writeFileSync(path.join(d, `entry-${id}.json`), JSON.stringify({ v: 2, id, created: t, updated: t, template: 'plain',
    pages: [{ id: 'p' + id, created: t, updated: t, images: [], ...pg }] }));
  fs.writeFileSync(path.join(d, 'journal.json'), JSON.stringify({ v: 1, entries: Object.keys(notes).map((id, i) => ({ id, title: id, created: t - i, updated: t - i, preview: '' })) }));
}
const open = async (page, frame, id) => { await frame.evaluate((i) => openEntry(i), id); await page.waitForTimeout(600); };
const drawOn = async (frame) => { await frame.evaluate(() => { const d = document.querySelector('.pan-mdraw'); if (!d.classList.contains('on')) d.click(); });
  await frame.waitForFunction(() => !document.querySelector('.pan-tools').classList.contains('pan-off')); };
// The tool strip's shown controls, in frame px.
const strip = (frame) => frame.evaluate(() => [...document.querySelectorAll('.pan-tools > *')].filter((e) => e.getBoundingClientRect().width > 0)
  .map((e) => { const r = e.getBoundingClientRect(); return { cls: e.className, tool: e.dataset.tool || '', l: r.left, r: r.right, w: r.width, h: r.height }; }));
const box = (frame, sel) => frame.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
  return { on: e.classList.contains('on'), l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, pos: cs.position, shown: cs.display !== 'none' && r.width > 0, vw: innerWidth, vh: innerHeight }; }, sel);

before(async () => { await setup({ slugs: ['notes'], from: path.join('workspace.example', 'apps', 'notes') }); if (!skip) { root = serverRoot(); seed(); } });
after(teardown);

// FIRST: tips are stored on the account, and any later press dismisses the one on screen for good.
test('iPhone: the strip ⋯ has its one-time bilingual tip, 中文 first, and it shows', { skip }, async () => {
  const ctx = await newContext(PHONE);
  // Tips show one per load and any press dismisses the one on screen, so a recorder notes every tip that is
  // actually on screen (its ✕ has a box) in each load of the app frame.
  await ctx.addInitScript(() => { window.__tipsShown = []; setInterval(() => { try { const id = window.PATips && window.PATips.current(), x = document.querySelector('.pat-x');
    if (id && x && x.getBoundingClientRect().width > 0 && !window.__tipsShown.includes(id)) window.__tipsShown.push(id); } catch { /* the shell frame has no PATips */ } }, 30); });
  const page = await ctx.newPage();
  let frame = await openJournal(page, { touch: true });
  for (let i = 0; i < 12; i++) {
    await open(page, frame, 'inkA'); await drawOn(frame);
    await frame.evaluate(() => PATips.check()); await page.waitForTimeout(500);
    if ((await frame.evaluate(() => PATips.seen() || [])).includes('note-tool-more') || (await frame.evaluate(() => window.__tipsShown)).includes('note-tool-more')) break;
    if (await frame.evaluate(() => PATips.current())) await frame.evaluate(() => document.querySelector('.pat-x').click());
    await page.reload(); frame = await openJournal(page, { touch: true });   // one tip per load
  }
  assert.ok((await frame.evaluate(() => window.__tipsShown)).includes('note-tool-more'), 'the strip ⋯ tip was on screen on the phone');
  const text = await frame.evaluate(() => PATips.registered().find((r) => r.id === 'note-tool-more').text);
  assert.match(text, /^更多工具/, 'Chinese first'); assert.match(text, / · More tools/, 'then English');
  await ctx.close();
});

test('iPhone: the strip is pen, eraser, undo, redo and ⋯ (with the pen toggle), all inside 390px and 44px tall', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  await open(page, frame, 'inkA'); await drawOn(frame);
  const s = await strip(frame);
  const has = (re) => s.some((c) => re.test(c.cls) || re.test(c.tool));
  for (const [re, what] of [[/^pen$/, 'pen'], [/^erase$/, 'eraser'], [/pan-undo/, 'undo'], [/pan-redo/, 'redo'], [/pan-toolmore/, '⋯']]) assert.ok(has(re), `${what} is on the strip`);
  for (const re of [/^marker$/, /^highlighter$/, /^select$/, /pan-inkbtn/]) assert.ok(!has(re), `${re} moved into the ⋯ sheet`);
  for (const c of s) { assert.ok(c.l >= 0 && c.r <= 390, `${c.cls} ${c.tool} is inside 390px (${c.l}-${c.r})`); assert.ok(c.h >= TAP && c.w >= TAP, `${c.cls} ${c.tool} is a 44px tap (${c.w}x${c.h})`); }
  // The header row too: nothing off the right edge.
  const head = await frame.evaluate(() => [...document.querySelectorAll('.pan-top button')].filter((e) => e.getBoundingClientRect().width > 0 && !e.closest('.pan-tools')).map((e) => e.getBoundingClientRect().right));
  assert.ok(head.every((r) => r <= 390), `the header fits (${head.map(Math.round)})`);
  // Undo works from the strip: a finger stroke, then undo takes it away.
  const before = await frame.evaluate(() => document.querySelector('.pan-undo').disabled);
  assert.equal(before, true, 'nothing to undo yet');
  await frame.evaluate(async () => { const ink = document.querySelector('.pan-ink'), r = ink.getBoundingClientRect(), y = r.top + 300;
    for (const [type, x] of [['pointerdown', 100], ['pointermove', 150], ['pointermove', 200], ['pointerup', 200]]) {
      ink.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 7, isPrimary: true, clientX: x, clientY: y, pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1 }));
      await new Promise((res) => requestAnimationFrame(res)); } });
  await frame.waitForFunction(() => !document.querySelector('.pan-undo').disabled);
  await frame.locator('.pan-undo').click();
  await frame.waitForFunction(() => !document.querySelector('.pan-redo').disabled);
  await ctx.close();
});

test('iPhone: ⋯, colour/size and the header ⋯ open as one bottom sheet; a sheet row presses its tool', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  await open(page, frame, 'inkA'); await drawOn(frame);
  await frame.locator('.pan-toolmore').click();
  let b = await box(frame, '.pan-toolsheet');
  assert.ok(b.on && b.pos === 'fixed', 'the ⋯ sheet opens');
  assert.ok(Math.abs(b.b - b.vh) < 1 && b.l <= 0.5 && Math.abs(b.r - b.vw) < 1, `at the bottom edge, full width (${b.l}-${b.r}, bottom ${b.b}/${b.vh})`);
  const rows = await frame.evaluate(() => [...document.querySelectorAll('.pan-toolsheet button')].map((e) => ({ k: e.dataset.k, t: e.textContent, h: e.getBoundingClientRect().height })));
  assert.deepEqual(rows.map((r) => r.k), ['marker', 'highlighter', 'select', 'ink'], 'the rest of the drawing controls');
  for (const r of rows) { assert.ok(r.h >= TAP, `${r.k} row is 44px (${r.h})`); assert.match(r.t, /^[一-鿿][^A-Za-z]*$/, `${r.k} label is 中文 on a 中文 device`); }
  await frame.locator('.pan-toolsheet [data-k=marker]').click();
  assert.deepEqual(await frame.evaluate(() => [...document.querySelectorAll('.pan-tool.on')].map((e) => e.dataset.tool)), ['marker'], 'the Marker row picked the marker');
  assert.equal((await box(frame, '.pan-toolsheet')).on, false, 'and the sheet closed');
  await frame.locator('.pan-toolmore').click();
  assert.equal(await frame.evaluate(() => document.querySelector('.pan-toolsheet [data-k=marker]').getAttribute('aria-checked')), 'true', 'the tool in use reads as checked');
  await frame.locator('.pan-toolsheet [data-k=ink]').click();
  b = await box(frame, '.pan-inkpop');
  assert.ok(b.on && b.pos === 'fixed' && Math.abs(b.b - b.vh) < 1 && Math.abs(b.w - b.vw) < 1, `colour/size is the same bottom sheet (${b.l}-${b.r}, ${b.t}-${b.b})`);
  assert.ok(b.t > 0, 'its top is on screen');
  await frame.locator('.pan-mtext').tap();   // a tap outside closes it, as before
  assert.equal((await box(frame, '.pan-inkpop')).on, false, 'outside tap closes it');
  await frame.locator('.pan-hmore').click();
  b = await box(frame, '.pan-ovf');
  assert.ok(b.on && b.pos === 'fixed' && Math.abs(b.b - b.vh) < 1, 'the header ⋯ menu is the same bottom sheet');
  await ctx.close();
});

test('iPhone: opening a note from the list closes the list; the list ⋯ is the bottom sheet and Ask AI closes it', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  await open(page, frame, 'blankB');
  await frame.evaluate(() => drawer.open());
  await frame.waitForFunction(() => document.querySelector('.pac-drawerhost.on .pac-lrow[data-id="inkA"]'));
  // The list on a phone: tag chips ≥12px, the search box a 44px target.
  const list = await frame.evaluate(() => { const q = document.querySelector('.pac-q'), t = document.createElement('button'); t.className = 'pac-ltag'; t.textContent = '#tag';
    document.querySelector('.pac-lrow').appendChild(t); const fs = parseFloat(getComputedStyle(t).fontSize); t.remove(); return { q: q.getBoundingClientRect().height, chip: fs }; });
  assert.ok(list.q >= TAP, `search box ${list.q}px`); assert.ok(list.chip >= 12, `tag chip ${list.chip}px`);
  await frame.locator('.pac-lrow[data-id="inkA"] .pac-lttl').tap();
  await frame.waitForFunction(() => !document.querySelector('.pac-drawerhost.on'), null, { timeout: 5000 });
  await frame.waitForFunction(() => document.querySelector('.pan-htitle').textContent.includes('inkA'), null, { timeout: 5000 });
  // The list ⋯: a bottom sheet (with Cancel), not a popover pinned to the 44px button.
  await frame.evaluate(() => drawer.open()); await frame.waitForSelector('.pac-drawerhost.on .pac-dmore');
  await frame.locator('.pac-drawerhost.on .pac-dmore').click();
  const m = await box(frame, '.pac-modal .pac-mbox');
  assert.ok(m && m.pos === 'fixed' && Math.abs(m.b - m.vh) < 1 && Math.abs(m.w - m.vw) < 1, `the list ⋯ is the bottom sheet (${m && [m.l, m.r, m.t, m.b]})`);
  assert.ok(await frame.evaluate(() => [...document.querySelectorAll('.pac-modal .pac-mopt')].every((b) => b.getBoundingClientRect().height >= 44)), 'its rows are 44px');
  // Ask AI opening (here the chat's open, the call every Ask AI path makes) closes the sheet.
  await frame.evaluate(() => document.querySelector('.pan-hask').click());
  await frame.waitForFunction(() => !document.querySelector('.pac-modal'), null, { timeout: 5000 });
  await ctx.close();
});

test('iPhone: no empty grey strip above the page once the bar hides; no "Tap to type" in Draw mode', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  await open(page, frame, 'blankB'); await drawOn(frame);
  const ph = await frame.evaluate(() => getComputedStyle(document.querySelector('.pan-textlayer'), '::before').content);
  assert.ok(ph === 'none' || ph === 'normal' || ph === '', `no placeholder in Draw mode (${ph})`);
  const top0 = await frame.evaluate(() => document.querySelector('.pan-pageInner').getBoundingClientRect().top);
  await frame.evaluate(() => { PAAppBar.hold(false); PAAppBar.hide(); });
  await frame.waitForFunction(() => document.querySelector('.pan-top').getAttribute('data-paab-hidden') === '1'); await page.waitForTimeout(400);
  assert.equal(await frame.evaluate(() => document.querySelector('.pan-pageInner').getBoundingClientRect().top), top0, 'the text stays put (owner 2026-11-23)');
  // The room above the page is the note's paper, not the grey desk: no empty grey strip.
  const bg = await frame.evaluate(() => { const st = document.querySelector('.pan-stage'), c = document.createElement('canvas').getContext('2d'); c.fillStyle = getComputedStyle(st).backgroundColor; const a = c.fillStyle;
    c.fillStyle = getComputedStyle(document.querySelector('.pan')).getPropertyValue('--pan-paperc').trim(); return [a, c.fillStyle]; });
  assert.equal(bg[0], bg[1], `the strip above the page wears the paper (${bg})`);
  assert.notEqual(bg[0], '#eceded', 'not the grey desk');
  await ctx.close();
});

test('iPad 820: the strip, popovers, list menus and page offset are what they were', { skip }, async () => {
  const ctx = await newContext(IPAD); const page = await ctx.newPage();
  const frame = await openJournal(page);
  await open(page, frame, 'inkA'); await drawOn(frame);
  const s = await strip(frame);
  for (const t of ['pen', 'marker', 'highlighter', 'erase', 'select']) assert.ok(s.some((c) => c.tool === t), `${t} stays on the strip`);
  assert.ok(s.some((c) => /pan-inkbtn/.test(c.cls)), 'colour/size stays on the strip');
  assert.equal((await box(frame, '.pan-toolmore')).shown, false, 'no ⋯ on the strip');
  await frame.locator('.pan-inkbtn').click();
  const b = await box(frame, '.pan-inkpop');
  assert.ok(b.on && b.pos === 'absolute' && b.w < b.vw - 16, `colour/size is the old popover (${b.pos}, ${b.w}px)`);
  await frame.locator('.pan-inkbtn').click();
  // The page sits under the bar, and stays there when the bar hides (iPad: unchanged).
  const top0 = await frame.evaluate(() => document.querySelector('.pan-pageInner').getBoundingClientRect().top);
  await frame.evaluate(() => { PAAppBar.hold(false); PAAppBar.hide(); });
  await frame.waitForFunction(() => document.querySelector('.pan-top').getAttribute('data-paab-hidden') === '1');
  await page.waitForTimeout(400);
  assert.equal(await frame.evaluate(() => document.querySelector('.pan-pageInner').getBoundingClientRect().top), top0, 'the page does not move');
  assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector('.pan-stage')).backgroundColor), 'rgb(236, 237, 237)', 'the iPad stage keeps its grey desk');
  await frame.evaluate(() => PAAppBar.hold(true));
  // The list: ⋯ is the anchored popover, and opening a row keeps the list.
  await frame.evaluate(() => drawer.open()); await frame.waitForSelector('.pac-drawerhost.on .pac-dmore');
  await frame.locator('.pac-drawerhost.on .pac-dmore').click();
  const m = await box(frame, '.pac-modal .pac-mbox');
  assert.ok(m && m.pos === 'absolute' && m.w < 400, `the list ⋯ is the old popover (${m && m.pos}, ${m && m.w}px)`);
  await page.keyboard.press('Escape');
  await frame.waitForFunction(() => !document.querySelector('.pac-modal'));
  await frame.locator('.pac-lrow[data-id="blankB"] .pac-lttl').tap();
  await page.waitForTimeout(800);
  assert.equal(await frame.evaluate(() => !!document.querySelector('.pac-drawerhost.on')), true, 'the list stays open beside the note');
  await ctx.close();
});
