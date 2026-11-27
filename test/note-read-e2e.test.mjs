// iPhone fit-width page + Read view + per-device text size · 手机适配宽度、阅读视图、按设备字号
//
// Plan journal-iphone step 2 (rules 2 + 4). Real web.mjs on a throwaway root, the shipped Journal, an
// iPhone viewport with touch (WebKit in CI's iPhone job via PA_E2E_ENGINE) and an iPad viewport as the
// control: at 820px the page scale and every control must be what they were before this step.
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
const PAGE_W = 816, MIN_PAGE_W = 700;
// Written on an iPad: a stroke across the page and one at its far right edge (x 0.6 → 0.98).
const IPAD_INK = [{ p: [[0.05, 0.05, 0.5], [0.5, 0.06, 0.5]], c: '#1c1e1d', w: 0.004, t: 'pen' },
  { p: [[0.6, 0.12, 0.5], [0.98, 0.14, 0.5]], c: '#1c1e1d', w: 0.004, t: 'pen' }];
const WORDS = 'In the beginning was the Word and the Word was with God and the Word was God. ';
const HTML = '<div>' + WORDS.repeat(6) + '</div><div>起初有道，道与神同在，道就是神。</div>';
let root;
const notePath = (id) => path.join(root, 'workspace', 'data', 'notes', `entry-${id}.json`);
const readNote = (id) => { try { return JSON.parse(fs.readFileSync(notePath(id), 'utf8')); } catch { return null; /* mid-write: read again */ } };

function seed() {
  const d = path.join(root, 'workspace', 'data', 'notes'); fs.mkdirSync(d, { recursive: true });
  const t = Date.now();
  const notes = { ipadInk: { strokes: IPAD_INK, pageHtml: HTML }, plainText: { strokes: [], pageHtml: HTML } };
  for (const [id, pg] of Object.entries(notes)) fs.writeFileSync(notePath(id), JSON.stringify({ v: 2, id, created: t, updated: t, template: 'plain',
    pages: [{ id: 'p' + id, created: t, updated: t, images: [], ...pg }] }));
  fs.writeFileSync(path.join(d, 'journal.json'), JSON.stringify({ v: 1, entries: Object.keys(notes).map((id, i) => ({ id, title: id, created: t - i, updated: t - i, preview: '' })) }));
}
const open = async (page, frame, id) => { await frame.evaluate((i) => openEntry(i), id); await page.waitForTimeout(600); };
const touches = (frame, steps) => frame.evaluate(async (ss) => {
  const ink = document.querySelector('.pan-ink');
  for (const [type, id, x, y, prim] of ss) {
    ink.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: id, isPrimary: !!prim, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5, buttons: type === 'pointerup' ? 0 : 1 }));
    await new Promise((r) => requestAnimationFrame(r));
  }
}, steps);
const geom = (frame) => frame.evaluate(() => { const st = document.querySelector('.pan-stage'), pi = document.querySelector('.pan-pageInner'), ink = document.querySelector('.pan-ink');
  const r = ink.getBoundingClientRect(), sr = st.getBoundingClientRect(), b = document.querySelector('.pan-ovfread'), br = b.getBoundingClientRect();
  return { zoom: Number(pi.style.zoom), stageW: sr.width, inkL: r.left, inkR: r.right, stageL: sr.left, stageR: sr.right,
    sideScroll: st.scrollWidth - st.clientWidth, readBtn: getComputedStyle(b).display !== 'none', readW: br.width, readH: br.height }; });
const SAVE_BUDGET_MS = 15000;
async function until(fn) { const end = Date.now() + SAVE_BUDGET_MS; let v; while (!(v = fn()) && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return v; }

before(async () => { await setup({ slugs: ['notes'] }); if (!skip) { root = serverRoot(); seed(); } });
after(teardown);

test('iPhone: an iPad ink note fits the screen width — every stroke shows, no sideways cut-off', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  await open(page, frame, 'ipadInk');
  const g = await geom(frame);
  assert.ok(Math.abs(g.zoom - g.stageW / PAGE_W) < 0.01, `the page fits the width: zoom ${g.zoom} = ${g.stageW}/${PAGE_W}`);
  assert.ok(g.zoom < MIN_PAGE_W / PAGE_W, 'below the old 700px floor (phone only)');
  assert.ok(g.inkL >= g.stageL - 1 && g.inkR <= g.stageR + 1, `the whole page (x 0→1, the 0.98 stroke too) is on screen (${g.inkL}-${g.inkR} in ${g.stageL}-${g.stageR})`);
  assert.ok(g.sideScroll <= 1, `no sideways scroll (${g.sideScroll}px)`);
  // A text-only page keeps the reflowed text it had (the floor stays there: nothing on it is placed against the page).
  await open(page, frame, 'plainText');
  const t = await geom(frame);
  assert.ok(Math.abs(t.zoom - MIN_PAGE_W / PAGE_W) < 0.01, `a page with no ink keeps its old scale (${t.zoom})`);
  await ctx.close();
});

test('iPhone: editing on the phone leaves the stored ink coordinates unchanged', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  await open(page, frame, 'ipadInk');
  const before = JSON.stringify(readNote('ipadInk').pages[0].strokes);
  // One finger at the middle of the screen → page x ≈ 0.5 in page units, whatever the scale.
  const g = await geom(frame); const x0 = g.stageL + g.stageW * 0.4, x1 = g.stageL + g.stageW * 0.6;
  await touches(frame, [['pointerdown', 81, x0, 500, true], ['pointermove', 81, (x0 + x1) / 2, 510], ['pointermove', 81, x1, 520], ['pointerup', 81, x1, 520]]);
  const saved = await until(() => { const n = readNote('ipadInk'); return n && n.pages[0].strokes.length === 3 ? n : null; });
  assert.ok(saved, 'the phone stroke saved');
  const strokes = saved.pages[0].strokes;
  assert.equal(JSON.stringify(strokes.slice(0, 2)), before, 'the iPad strokes are byte-for-byte unchanged');
  const xs = strokes[2].p.map((p) => p[0]);
  assert.ok(Math.min(...xs) > 0.35 && Math.max(...xs) < 0.65, `the new stroke is in 816px page units (x ${Math.min(...xs)}–${Math.max(...xs)})`);
  await ctx.close();
});

test('iPhone: Read view — reflowed text ≥18px, ink hidden and labelled; A+ is per device, never in the note', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  let frame = await openJournal(page, { touch: true });
  await open(page, frame, 'ipadInk');
  const g = await geom(frame);
  await frame.locator('.pan-hmore').click();
  const m = await geom(frame);
  assert.ok(m.readBtn && m.readH >= 44, `Read view heads the phone ⋯ menu, 44px tall (${m.readW}x${m.readH})`);
  const reg = await frame.evaluate(() => (window.PATips ? PATips.registered() : []).find((r) => r.id === 'note-read-view'));
  assert.ok(reg, 'its first-use tip is registered'); assert.match(reg.text, /^[一-鿿]/, 'Chinese first'); assert.match(reg.text, / · [A-Z]/, 'then English');
  const fileBefore = fs.readFileSync(notePath('ipadInk'), 'utf8');
  await frame.locator('.pan-ovfread').click();
  const rv = () => frame.evaluate(() => { const v = document.querySelector('.pnp-read'), b = v.querySelector('.pnp-rbody'), p = b.querySelector('div');
    return { shown: !v.hidden && v.getBoundingClientRect().width > 0, title: v.querySelector('.pnp-rtitle').textContent, inkNote: !v.querySelector('.pnp-rnote').hidden,
      font: parseFloat(getComputedStyle(p).fontSize), lines: p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight),
      wrap: b.scrollWidth <= b.clientWidth + 1, text: b.textContent, width: v.getBoundingClientRect().width,
      editable: !!b.querySelector('[contenteditable]') }; });
  let s = await rv();
  assert.ok(s.shown, 'Read view opens'); assert.match(s.title, /^阅读视图 · Read view/, 'clearly labelled, 中文 first');
  assert.ok(s.inkNote, 'it says the ink is hidden, not deleted');
  assert.ok(s.font >= 18, `text is at least 18px (${s.font})`);
  assert.ok(s.wrap && s.lines > 3, `the text wraps to the phone width (${s.lines.toFixed(1)} lines, no sideways scroll)`);
  assert.ok(s.text.includes('In the beginning') && s.text.includes('起初有道'), 'the page text is all there');
  assert.ok(!s.editable, 'read only');
  // The pad under it is inert, and editing keys never reach it (a hardware keyboard on a phone).
  assert.equal(await frame.evaluate(() => document.querySelector('.pan-stage').inert), true, 'the page under Read view is inert');
  for (const k of ['Delete', 'Backspace', 'Meta+z', 'x']) await page.keyboard.press(k);
  await frame.locator('.pnp-rmore').click();
  s = await rv(); assert.equal(s.font, 20, 'A+ grows the text');
  await page.waitForFunction(() => localStorage.getItem('pa_notereadsize') === '20', null, { timeout: 5000 });
  await page.waitForTimeout(1500);                         // a save, had one been triggered, would be on disk now
  assert.equal(fs.readFileSync(notePath('ipadInk'), 'utf8'), fileBefore, 'A+ changed nothing in the saved note');
  await frame.locator('.pnp-rclose').click();
  assert.equal(await frame.evaluate(() => document.querySelector('.pnp-read').hidden), true, 'closes');
  assert.equal(await frame.evaluate(() => document.querySelector('.pan-stage').inert), false, 'and gives the page back');
  // The size is this device's: a fresh load gets it back from the shell.
  await page.reload(); frame = await openJournal(page, { touch: true });
  await open(page, frame, 'ipadInk');
  await frame.locator('.pan-hmore').click(); await frame.locator('.pan-ovfread').click();
  s = await rv(); assert.equal(s.font, 20, 'the device keeps its size');
  await frame.locator('.pnp-rless').click();
  s = await rv(); assert.equal(s.font, 18, 'A− back to 18px');
  assert.equal(await frame.evaluate(() => document.querySelector('.pnp-rless').disabled), true, 'A− stops at 18px: never under');
  await ctx.close();
});

test('iPad 820: the page scale is the old one and the Read view button is hidden', { skip }, async () => {
  const ctx = await newContext(IPAD); const page = await ctx.newPage();
  const frame = await openJournal(page);
  await open(page, frame, 'ipadInk');
  const g = await geom(frame);
  assert.ok(!g.readBtn, 'no Read view entry off a phone');
  assert.equal(await frame.evaluate(() => getComputedStyle(document.querySelector('.pan-readbtn')).display), 'none', 'nor a header button');
  const want = Math.max(MIN_PAGE_W / PAGE_W, g.stageW / PAGE_W);
  assert.ok(Math.abs(g.zoom - want) < 1e-3, `zoom is max(700, width)/816 as before (${g.zoom} vs ${want})`);
  assert.equal(await frame.evaluate(() => document.querySelector('.pnp-read').hidden), true, 'Read view stays closed');
  await ctx.close();
});
