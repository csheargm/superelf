// iPhone phone mode: one finger inks, two fingers pan, a pinch zooms (per note, per device), and the
// pen toggle replaces the 16px checkbox · 手机模式：一指书写，两指滚动，捏合缩放，笔开关
//
// Plan journal-iphone step 1 (rules 3 + 2-zoom). Real web.mjs on a throwaway root, the shipped
// Journal, an iPhone viewport with touch (WebKit in CI's iPhone job via PA_E2E_ENGINE) and an iPad
// viewport as the control: at 820px nothing here may act. Pointer events are synthetic (dispatched
// on the ink canvas); the real finger feel needs a real iPhone.
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
const TOP_INK = { p: [[0.1, 0.004, 0.5], [0.4, 0.008, 0.5]], c: '#1c1e1d', w: 0.004, t: 'pen' };
// A dot far down the page: the page grows to its ink (note-ui pageExtent), so the stage always has
// far more scroll room than the pan below travels. Without it the room was only the page's tail
// past the viewport — 61px to 151px depending on the bar's measured clearance — and a correct pan
// was clamped below the 100px the test asked for (CI flake, v5.37.0).
const DEEP_INK = { p: [[0.5, 5, 0.5], [0.502, 5.002, 0.5]], c: '#1c1e1d', w: 0.004, t: 'pen' };
const PAN_TRAVEL = 295;   // the two-finger centre moves 595 → 300 while both are down
const IDS = ['phoneA', 'phoneB'];
let root;
const notePath = (id) => path.join(root, 'workspace', 'data', 'notes', `entry-${id}.json`);
const strokesOnDisk = (id) => { try { return JSON.parse(fs.readFileSync(notePath(id), 'utf8')).pages[0].strokes.length; } catch { return -1; /* mid-write: read again */ } };

function seed() {
  const d = path.join(root, 'workspace', 'data', 'notes'); fs.mkdirSync(d, { recursive: true });
  const t = Date.now();
  IDS.forEach((id) => fs.writeFileSync(notePath(id), JSON.stringify({ v: 2, id, created: t, updated: t, template: 'plain',
    pages: [{ id: 'p' + id, created: t, updated: t, strokes: [TOP_INK, DEEP_INK], pageHtml: '', images: [] }] })));
  fs.writeFileSync(path.join(d, 'journal.json'), JSON.stringify({ v: 1, entries: IDS.map((id, i) => ({ id, title: id, created: t - i, updated: t - i, preview: '' })) }));
}
const open = async (page, frame, id) => { await frame.evaluate((i) => openEntry(i), id); await page.waitForTimeout(500); };
// Touch pointers on the ink canvas, in frame coordinates. steps: [[type, id, x, y, isPrimary]].
const touches = (frame, steps) => frame.evaluate(async (ss) => {
  const ink = document.querySelector('.pan-ink');
  for (const [type, id, x, y, prim] of ss) {
    ink.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: id, isPrimary: !!prim, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5, buttons: type === 'pointerup' ? 0 : 1 }));
    await new Promise((r) => requestAnimationFrame(r));
  }
}, steps);
const state = (frame) => frame.evaluate(() => { const st = document.querySelector('.pan-stage'), pi = document.querySelector('.pan-pageInner'), b = document.querySelector('.pan-fingerbtn');
  const r = b.getBoundingClientRect(), row = document.querySelector('.pan-fingerrow');
  return { zoom: Number(pi.style.zoom), top: st.scrollTop, left: st.scrollLeft, btn: getComputedStyle(b).display !== 'none', btnH: r.height, btnW: r.width,
    pressed: b.getAttribute('aria-pressed'), row: getComputedStyle(row).display !== 'none', phone: document.querySelector('.pan').classList.contains('pan-phone') }; });
const settle = (page) => page.waitForTimeout(1500);   // the note's save debounce: only for "nothing was saved" checks
// A stroke that SHOULD save: wait for it on disk (a slow CI runner can take longer than one debounce).
const SAVE_BUDGET_MS = 15000;
async function strokesReach(id, n) {
  const end = Date.now() + SAVE_BUDGET_MS; let got;
  while ((got = strokesOnDisk(id)) !== n && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return got;
}

before(async () => { await setup({ slugs: ['notes'] }); if (!skip) { root = serverRoot(); seed(); } });
after(teardown);

// FIRST: tips are stored on the account, and any later press dismisses the one on screen for good.
test('iPhone: the pen toggle has its one-time bilingual tip, 中文 first', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  let frame = await openJournal(page, { touch: true });
  await open(page, frame, 'phoneB');                       // an ink note opens in Draw: the tool row (and the toggle) shows
  const reg = await frame.evaluate(() => (window.PATips ? PATips.registered() : []).find((r) => r.id === 'note-finger-pen'));
  assert.ok(reg, 'the tip is registered');
  assert.match(reg.text, /^[一-鿿]/, 'Chinese first'); assert.match(reg.text, / · [A-Z]/, 'then English');
  // Tips show one per page open: dismiss whatever shows until ours does (bounded).
  let shown = false;
  for (let i = 0; i < 8 && !shown; i++) {
    await frame.evaluate(() => PATips.check()); await page.waitForTimeout(400);
    const cur = await frame.evaluate(() => PATips.current());
    if (cur === 'note-finger-pen') { shown = true; break; }
    if (cur) await frame.evaluate(() => document.querySelector('.pat-x').click());
    else { await frame.evaluate(() => location.reload()).catch(() => { /* the frame navigated away mid-call */ });
      await page.waitForTimeout(1500); frame = page.frames().find((f) => f.url().includes('/app/owner/notes/'));
      await frame.waitForFunction(() => window.PATips && window.PANote && document.querySelector('.pan-fingerbtn'));
      await open(page, frame, 'phoneB'); }
    await page.waitForTimeout(600);
  }
  assert.ok(shown, 'the pen-toggle tip shows on the phone');
  await ctx.close();
});

test('iPhone: the pen toggle replaces the checkbox, is on by default and 44px; one finger inks', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  await open(page, frame, 'phoneA');
  const s = await state(frame);
  assert.ok(s.phone, 'phone mode is on at 390px with a coarse pointer');
  assert.ok(s.btn, 'the pen toggle shows'); assert.ok(!s.row, 'the 16px checkbox row is hidden');
  assert.ok(s.btnH >= 44 && s.btnW >= 44, `the toggle is at least 44px (${s.btnW}x${s.btnH})`);
  assert.equal(s.pressed, 'true', 'a phone with no stored choice and no pen inks with the finger');
  const n0 = strokesOnDisk('phoneA');
  await touches(frame, [['pointerdown', 11, 120, 400, true], ['pointermove', 11, 150, 420], ['pointermove', 11, 190, 440], ['pointerup', 11, 190, 440]]);
  assert.equal(await strokesReach('phoneA', n0 + 1), n0 + 1, 'the one-finger stroke saved as ink');
  // Off: a finger no longer inks.
  await frame.locator('.pan-fingerbtn').click();
  assert.equal((await state(frame)).pressed, 'false', 'the toggle turns finger ink off');
  await touches(frame, [['pointerdown', 12, 120, 500, true], ['pointermove', 12, 125, 520], ['pointermove', 12, 128, 560], ['pointerup', 12, 128, 560]]);
  await settle(page);
  assert.equal(strokesOnDisk('phoneA'), n0 + 1, 'with the pen off a finger draws nothing');
  await frame.locator('.pan-fingerbtn').click();
  assert.equal((await state(frame)).pressed, 'true', 'and back on');
  await page.waitForFunction(() => localStorage.getItem('pa_fingerdraw') === '1', null, { timeout: 5000 });   // the choice is stored on the device
  await ctx.close();
});

test('iPhone: two fingers pan with no new ink; a pinch zooms, is clamped to 3x and stays with the note', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  await open(page, frame, 'phoneA');
  const n0 = strokesOnDisk('phoneA');
  const s0 = await state(frame);
  const room = await frame.evaluate(() => { const st = document.querySelector('.pan-stage'); return st.scrollHeight - st.clientHeight - st.scrollTop; });
  assert.ok(room > PAN_TRAVEL, `precondition: the page has room to pan ${PAN_TRAVEL}px (has ${room})`);
  // First finger starts (it would ink), second lands: the stroke is dropped and both fingers move up.
  await touches(frame, [['pointerdown', 21, 150, 600, true], ['pointermove', 21, 152, 590], ['pointerdown', 22, 250, 600],
    ['pointermove', 21, 150, 450], ['pointermove', 22, 250, 450], ['pointermove', 21, 150, 300], ['pointermove', 22, 250, 300],
    ['pointerup', 22, 250, 300], ['pointermove', 21, 150, 200], ['pointerup', 21, 150, 200]]);
  await settle(page);
  const s1 = await state(frame);
  assert.ok(Math.abs(s1.top - s0.top - PAN_TRAVEL) <= 1, `two fingers scrolled the page by their travel, ${PAN_TRAVEL}px (${s0.top} → ${s1.top})`);
  assert.equal(strokesOnDisk('phoneA'), n0, 'no ink from the two-finger move (nor from the finger left down)');
  assert.equal(s1.zoom, s0.zoom, 'a parallel move does not zoom');
  // Pinch out 2x.
  const spread = []; for (let d = 2; d <= 100; d += 2) spread.push(['pointermove', 31, 190 - d, 400], ['pointermove', 32, 210 + d, 400]);   // 20px → 220px apart
  await touches(frame, [['pointerdown', 31, 190, 400, true], ['pointerdown', 32, 210, 400], ...spread, ['pointerup', 31, 90, 400], ['pointerup', 32, 310, 400]]);
  await page.waitForTimeout(300);
  const s2 = await state(frame);
  assert.ok(Math.abs(s2.zoom / s0.zoom - 3) < 0.05, `the pinch zoomed in, clamped at 3x (${s0.zoom} → ${s2.zoom})`);
  assert.ok(s2.zoom / s0.zoom <= 3.001, 'never past 3x');
  assert.equal(strokesOnDisk('phoneA'), n0, 'the pinch drew nothing');
  // Pinch in past fit: clamped at fit.
  await touches(frame, [['pointerdown', 41, 100, 400, true], ['pointerdown', 42, 300, 400], ['pointermove', 41, 180, 400], ['pointermove', 42, 220, 400],
    ['pointermove', 41, 198, 400], ['pointermove', 42, 202, 400], ['pointerup', 41, 198, 400], ['pointerup', 42, 202, 400]]);
  await page.waitForTimeout(300);
  assert.ok(Math.abs((await state(frame)).zoom - s0.zoom) < 1e-3, 'a pinch in stops at fit');
  // Zoom in again (the first 12% of the spread is slop), switch notes, come back: the zoom is locked to the note.
  const out = []; for (let d = 2; d <= 50; d += 2) out.push(['pointermove', 51, 150 - d, 400], ['pointermove', 52, 250 + d, 400]);   // 100px → 200px apart
  await touches(frame, [['pointerdown', 51, 150, 400, true], ['pointerdown', 52, 250, 400], ...out, ['pointerup', 51, 100, 400], ['pointerup', 52, 300, 400]]);
  await page.waitForTimeout(300);
  const z2 = (await state(frame)).zoom;
  assert.ok(z2 / s0.zoom > 1.2 && z2 / s0.zoom < 2.01, `zoomed in (${z2 / s0.zoom}x)`);
  await open(page, frame, 'phoneB');
  assert.ok(Math.abs((await state(frame)).zoom - s0.zoom) < 1e-3, 'another note opens at fit');
  await open(page, frame, 'phoneA');
  assert.ok(Math.abs((await state(frame)).zoom - z2) < 1e-3, 'the first note reopens at its own zoom');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pa_notezoom') || '{}'));
  assert.ok(Object.keys(stored).some((k) => k.endsWith('\nphoneA')), 'the zoom is stored per note on this device');
  // One finger still inks after all that.
  await touches(frame, [['pointerdown', 61, 120, 400, true], ['pointermove', 61, 150, 420], ['pointermove', 61, 190, 440], ['pointerup', 61, 190, 440]]);
  assert.equal(await strokesReach('phoneA', n0 + 1), n0 + 1, 'one finger inks at 2x');
  await ctx.close();
});

// Nightly review 2026-11-27: the shell's saved zooms can arrive AFTER the note rendered; they only
// took effect on some later layout pass. Simulate the late prefs message and check the page at once.
test('iPhone: a saved zoom that arrives after the note rendered applies straight away', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  await open(page, frame, 'phoneB');
  const z0 = (await state(frame)).zoom;
  await frame.evaluate(() => window.postMessage({ pa: 'prefs', noteZoom: { phoneB: 2 } }, '*'));
  await page.waitForTimeout(300);
  const z1 = (await state(frame)).zoom;
  assert.ok(Math.abs(z1 / z0 - 2) < 0.01, `the late zoom applies without another layout (${z0} → ${z1})`);
  await frame.evaluate(() => window.postMessage({ pa: 'prefs', noteZoom: {} }, '*'));
  await page.waitForTimeout(300);
  assert.ok(Math.abs((await state(frame)).zoom - z0) < 1e-3, 'and a cleared one goes back to fit');
  await ctx.close();
});

test('iPad 820: no phone mode — the checkbox stays, the toggle is hidden, two fingers do not zoom', { skip }, async () => {
  const ctx = await newContext(IPAD); const page = await ctx.newPage();
  const frame = await openJournal(page);                   // the docked list is put away with a click
  await open(page, frame, 'phoneB');
  const s0 = await state(frame);
  assert.ok(!s0.phone && !s0.btn && s0.row, 'iPad: no .pan-phone, no toggle, the checkbox row shows');
  await touches(frame, [['pointerdown', 71, 300, 500, true], ['pointerdown', 72, 400, 500], ['pointermove', 71, 250, 500], ['pointermove', 72, 450, 500],
    ['pointerup', 71, 250, 500], ['pointerup', 72, 450, 500]]);
  await page.waitForTimeout(300);
  assert.equal((await state(frame)).zoom, s0.zoom, 'iPad: a two-finger spread changes no zoom');
  await ctx.close();
});
