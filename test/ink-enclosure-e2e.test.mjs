// A circle round printed words stays on them on another width, and the arrow + note drawn from it move
// with it (PAInkFrame.followEnclosures, web/ink-frame.inline.html). SCAR (owner, Romans 7:4, iPad,
// 2026-11-22): an oval round "叫我们结果子给神" (the end of the Chinese line, wrapped to 2 rows in
// portrait) sat in empty space under the line, at the left, in landscape. Real Chromium (R6): the line
// wrap is the bug, so a fake DOM cannot show it. Invariants, each checked here:
//   1. at the width the ink was written, every placement equals origin/main's engine (b562291);
//   2. stored records are never rewritten (the bytes are the same after every reflow);
//   3. only on another width does the oval move, and its arrow + note keep their offsets to it.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';

const REF = 'b562291', OLD = '7fe85a8';   // origin/main's engine (identity control); an engine before ww tags
const PORTRAIT = 820, LANDSCAPE = 1194, TOL = 3;   // iPad-like widths (portrait: the words wrap whole onto row 2); px the oval may differ by
const TARGET = '叫我们结果子给神';
const ZH4 = '你们藉着基督的身体，在律法上也是死了，叫你们归于别人，就是归于那从死里复活的，叫我们结果子给神。';
const show = (rev, f) => execFileSync('git', ['show', `${rev}:${f}`], { cwd: ROOT, encoding: 'utf8' });
const here = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ENGINES = {
  now: here('web/ink-frame.inline.html') + here('web/ink-anchor.inline.html'),
  ref: show(REF, 'web/ink-frame.inline.html') + show(REF, 'web/ink-anchor.inline.html'),
  old: show(OLD, 'web/ink-frame.inline.html') + show(OLD, 'web/ink-anchor.inline.html'),
};
const page = (eng) => `<!doctype html><meta charset=utf-8><style>body{margin:0;font:20px/1.6 sans-serif}#v{position:relative;padding:0 16px;height:100vh;overflow:auto}.verse{margin:0 0 12px}</style>
<div id=v><div class=verse data-n=4><div class=ven>So, my brothers, you also died to the law through the body of Christ.</div><div class=vzh>${ZH4}</div></div>
<div class=verse data-n=5><div class=ven>For when we lived according to the flesh.</div><div class=vzh>因为我们属肉体的时候，那因律法而生的恶欲，就在我们肢体中发动。</div></div></div>
<script>window.PANote={ink:{MAX_CANVAS_PX:1e8,drawStroke(){},segTo(){},guardInk(){}}};</script>${ENGINES[eng]}
<script>window.A=PAInkAnchor.attach({container:document.getElementById('v'),onChange(){}});</script>`;

let browser;
before(async () => { if (!skip) browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); });

async function open(eng, width) {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  await p.setContent(page(eng));
  return p;
}
// The target words' rows, in the list's content px.
const target = (p) => p.evaluate((T) => { const el = document.querySelector('[data-n="4"] .vzh'), n = el.firstChild, s = el.textContent.indexOf(T), r = document.createRange();
  r.setStart(n, s); r.setEnd(n, s + T.length); const c = document.getElementById('v').getBoundingClientRect();
  return [...r.getClientRects()].map((x) => ({ l: x.left - c.left, t: x.top - c.top, r: x.right - c.left, b: x.bottom - c.top })); }, TARGET);
const stroke = (p, pts) => p.evaluate((pts) => { const c = document.getElementById('v'), cr = c.getBoundingClientRect();
  const ev = (type, q) => new PointerEvent(type, { pointerType: 'pen', pointerId: 7, clientX: cr.left + q[0], clientY: cr.top + q[1], pressure: 0.5, bubbles: true, cancelable: true });
  c.dispatchEvent(ev('pointerdown', pts[0])); for (const q of pts.slice(1)) window.dispatchEvent(ev('pointermove', q)); window.dispatchEvent(ev('pointerup', pts[pts.length - 1])); }, pts);
// The owner's mark: an oval round the words (ry: how far it reaches above/below their row), then 1.7 s
// later an arrow from its right side and four small letters after it.
async function write(p, ry) {
  const rows = await target(p), row = rows[rows.length - 1];
  assert.equal(new Set(rows.map((r) => r.t)).size, 1, 'the words sit on one row where they are circled');
  const cx = (row.l + row.r) / 2, cy = (row.t + row.b) / 2, rx = (row.r - row.l) / 2 + 8, h = (row.b - row.t) / 2 + ry, oval = [];
  for (let i = 0; i <= 40; i++) { const a = i / 40 * 2 * Math.PI; oval.push([cx + rx * Math.cos(a), cy + h * Math.sin(a)]); }
  await stroke(p, oval); await p.waitForTimeout(1700);
  const ax = cx + rx, ay = cy; await stroke(p, [[ax, ay], [ax + 25, ay - 3], [ax + 50, ay]]); await p.waitForTimeout(200);
  for (let k = 0; k < 4; k++) { const x = ax + 60 + k * 22, y = ay - 9; await stroke(p, [[x, y], [x + 15, y + 5], [x + 5, y + 18], [x + 16, y + 20]]); await p.waitForTimeout(150); }
  return p.evaluate(() => A.groups());
}
const places = (p) => p.evaluate(() => { A.reflow(); return A.placements().map(({ at }) => at && { ox: at.ox, oy: at.oy, s: at.s }); });
const resize = async (p, w) => { await p.setViewportSize({ width: w, height: 900 }); await p.evaluate(() => A.reflow()); };
// Each stroke's offset from the oval (the first record), the oval's from the target's first row.
function shape(at, rows) { const o = at[0]; return { oval: [o.ox - rows[0].l, o.oy - rows[0].t], rest: at.slice(1).map((a) => [a.ox - o.ox, a.oy - o.oy]) }; }
const near = (a, b, msg) => { assert.equal(a.length, b.length, msg); a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= TOL, `${msg}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)); };
function sameShape(got, want, label) {
  near(got.oval, want.oval, `${label}: the oval stays round the same words`);
  assert.equal(got.rest.length, 5, `${label}: arrow + 4 letters`);
  got.rest.forEach((r, i) => near(r, want.rest[i], `${label}: stroke ${i + 1} keeps its offset to the oval`));
}

async function scenario(eng, from, to, ry) {
  const p = await open(eng, from); const recs = await write(p, ry), bytes = JSON.stringify(recs);
  const at0 = await places(p), s0 = shape(at0, await target(p));
  await resize(p, to); const s1 = shape(await places(p), await target(p));
  await resize(p, from); const at2 = await places(p);
  assert.equal(JSON.stringify(await p.evaluate(() => A.groups())), bytes, 'stored records never rewritten by reflows');
  assert.deepStrictEqual(at2, at0, 'back at the written width: drawn as before');
  await p.close();
  return { recs, s0, s1 };
}

for (const [name, from, to] of [['portrait → landscape', PORTRAIT, LANDSCAPE], ['landscape → portrait', LANDSCAPE, PORTRAIT]]) {
  for (const ry of [12, 4]) {
    test(`${name}, oval ${ry}px past the row: it keeps its words, the arrow + note keep to it`, { skip }, async () => {
      const { s0, s1 } = await scenario('now', from, to, ry);
      sameShape(s1, s0, name);
    });
  }
}

test('control: origin/main misplaces the tall oval written in portrait (else the test above proves nothing)', { skip }, async () => {
  const { s0, s1 } = await scenario('ref', PORTRAIT, LANDSCAPE, 12);
  assert.ok(Math.abs(s1.oval[0] - s0.oval[0]) > 100, `origin/main moved the oval off its words: ${JSON.stringify([s0.oval, s1.oval])}`);
});

test('identity at the written width: the same records draw exactly as on origin/main', { skip }, async () => {
  for (const w of [PORTRAIT, LANDSCAPE]) {
    const p = await open('now', w); const recs = await write(p, 12); await p.close();
    const at = {};
    for (const eng of ['now', 'ref']) { const q = await open(eng, w); await q.evaluate((r) => A.load(r), recs); at[eng] = await places(q); await q.close(); }
    assert.deepStrictEqual(at.now, at.ref, `width ${w}`);
  }
});

test('an older note (written before ww tags) gets its oval back on the other width', { skip }, async () => {
  const p = await open('old', PORTRAIT); const recs = await write(p, 12); await p.close();
  assert.ok(recs.every((g) => g.ww == null && g.bid == null), 'really an old note');
  const run = async (eng, w) => { const q = await open(eng, w); await q.evaluate((r) => A.load(r), recs); const s = shape(await places(q), await target(q)); const at = await places(q); await q.close(); return { s, at }; };
  const atWrite = await run('now', PORTRAIT), refWrite = await run('ref', PORTRAIT);
  assert.deepStrictEqual(atWrite.at, refWrite.at, 'identity at the written width');
  sameShape((await run('now', LANDSCAPE)).s, atWrite.s, 'old note');
});
