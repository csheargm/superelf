// The owner's iPad Pro 11" rotation in a REAL browser (R6), on a throwaway web root (never the live node):
// Romans 7, a handwritten Chinese sentence written in LANDSCAPE (1194 px) in the gap between v5's Chinese
// line and v6's English line, each character's top just inside v5zh and its lower dot just inside v6en;
// then the viewport turns to PORTRAIT (834 px). SCAR (2026-11-22, after 1a654f7): dots of the characters
// were left behind one row away. Every stroke of the sentence must move by the same amount.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

const LANDSCAPE = { width: 1194, height: 834 }, PORTRAIT = { width: 834, height: 1194 };
let port, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); const root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  const d = path.join(root, 'workspace', 'apps', 'bible'); fs.mkdirSync(d, { recursive: true });
  for (const f of ['index.html', 'meta.json']) { const s = path.join(ROOT, 'workspace', 'apps', 'bible', f); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(d, f)); }
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

async function openRomans7() {
  const ctx = await browser.newContext({ viewport: LANDSCAPE });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp(UID, 'bible', 'bible'));
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'bible frame loaded');
  await frame.waitForFunction(() => typeof INK_PEN === 'object' && document.querySelectorAll('.verse').length > 5, null, { timeout: 90000 });
  await frame.evaluate(() => PATips.dismiss());
  await frame.evaluate(async () => { bookIdx = BOOKS.findIndex((b) => b[0] === 'Romans'); chapter = 7; await load(); });
  await frame.waitForFunction(() => document.querySelector('.verse[data-n="6"] .ven') && !ANN_LOADING, null, { timeout: 90000 });
  return { ctx, page, frame };
}
// Six characters of four strokes (dash, tall vertical, upper dot, lower dot) in the v5zh/v6en gap, as Pencil
// PointerEvents (down on the element under the pen, moves and up on the window), 200 ms apart.
// The real fonts decide which Chinese line gains a row in portrait; the owner's was 7:5. Pick the first verse
// n of the chapter whose zh line, copied at the portrait width, is taller (7:5 when it does).
const pickVerse = (frame, narrowBy) => frame.evaluate((d) => {
  for (const v of document.querySelectorAll('.verse')) {
    const zh = v.querySelector('.vzh'), n = +v.dataset.n, next = document.querySelector(`.verse[data-n="${n + 1}"] .ven`); if (!zh || !next) continue;
    const c = zh.cloneNode(true), w = zh.getBoundingClientRect().width; c.style.cssText = `position:absolute;visibility:hidden;width:${w - d}px`; zh.parentNode.appendChild(c);
    const grows = c.getBoundingClientRect().height > zh.getBoundingClientRect().height + 4; c.remove(); if (grows) return n;
  }
  return null;
}, narrowBy);
const writeSentence = (frame, n) => frame.evaluate(async (n) => {
  const zh = document.querySelector(`.verse[data-n="${n}"] .vzh`).getBoundingClientRect(), en = document.querySelector(`.verse[data-n="${n + 1}"] .ven`).getBoundingClientRect();
  const top = zh.bottom - 6, low = Math.max(top + 30, en.top + 2);
  let id = 40;
  const draw = async (pts) => {
    const ev = (t, [x, y]) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerType: 'pen', pointerId: id, clientX: x, clientY: y, pressure: 0.5 });
    document.elementFromPoint(...pts[0]).dispatchEvent(ev('pointerdown', pts[0]));
    for (const p of pts.slice(1)) window.dispatchEvent(ev('pointermove', p));
    window.dispatchEvent(ev('pointerup', pts.at(-1))); id++;
    await new Promise((r) => setTimeout(r, 200));
  };
  for (let c = 0; c < 6; c++) {
    const x = zh.left + 300 + c * 28;
    await draw([[x, top + 4], [x + 9, top + 4], [x + 18, top + 4]]);
    await draw([[x + 9, top], [x + 9, top + 11], [x + 9, low - 6]]);
    await draw([[x + 3, top + 12], [x + 3.5, top + 12.5], [x + 4, top + 13]]);
    await draw([[x + 14, low], [x + 14.5, low + 0.5], [x + 15, low + 1]]);
  }
  return { zhH: zh.height, gap: en.top - zh.bottom };
}, n);
const placed = (frame) => frame.evaluate(() => INK.placements().map((p) => p.at && { ox: p.at.ox, oy: p.at.oy, s: p.at.s }));
const lines = (frame, n) => frame.evaluate((n) => [`.verse[data-n="${n}"] .vzh`, `.verse[data-n="${n + 1}"] .ven`].map((s) => document.querySelector(s).getBoundingClientRect().top + document.getElementById('verses').scrollTop), n);

test('iPad 11" landscape -> portrait, Romans 7: every stroke of the handwritten sentence moves together', { skip }, async () => {
  const { ctx, page, frame } = await openRomans7();
  try {
    const n = await pickVerse(frame, LANDSCAPE.width - PORTRAIT.width); assert.ok(n, 'a Chinese line of Romans 7 gains a row in portrait');
    await writeSentence(frame, n);
    await frame.waitForFunction(() => INK.groups().length === 24, null, { timeout: 10000 });
    const b = await placed(frame), lb = await lines(frame, n);
    await page.setViewportSize(PORTRAIT);
    await frame.waitForFunction((w) => document.getElementById('verses').clientWidth < w, LANDSCAPE.width - 200);
    await page.waitForTimeout(300);
    const a = await placed(frame), la = await lines(frame, n);
    assert.ok(a.every(Boolean) && b.every(Boolean), 'every stroke has a place on the text');
    const mv = a.map((p, i) => [p.ox - b[i].ox, p.oy - b[i].oy]), span = (k) => Math.max(...mv.map((m) => m[k])) - Math.min(...mv.map((m) => m[k]));
    console.log(`# rotation (v${n}zh / v${n + 1}en): zh moved ${Math.round(la[0] - lb[0])}, en moved ${Math.round(la[1] - lb[1])}; sibling spread dx ${span(0).toFixed(2)} dy ${span(1).toFixed(2)}; scales ${[...new Set(a.map((p) => p.s))].join(',')}`);
    assert.notEqual(Math.round(la[0] - lb[0]), Math.round(la[1] - lb[1]), 'the two lines moved by different amounts (the case that split the word)');
    assert.ok(span(0) < 0.5 && span(1) < 0.5, `siblings drift dx ${span(0)} dy ${span(1)}`);
    assert.equal(new Set(a.map((p) => p.s)).size, 1, 'one scale for the whole sentence');
  } finally { await ctx.close(); }
});
