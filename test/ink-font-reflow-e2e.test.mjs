// Ink written on one device's fonts stays on its words on another device's fonts (PAInkFrame env
// fontRatio, web/ink-frame.inline.html). SCAR (owner, Romans 7:4, laptop, 2026-11-25): an oval round
// "叫我们结果子给神" written in iPad portrait sat on verse 4's English line on a laptop: the repair re-laid
// the line at the iPad's width, but other fonts wrap it elsewhere, the 1px width check refused, and the
// naive placement stood. Another device's fonts are stood in for by another size + letter-spacing (non-
// proportional, as a different font is). Synthetic strokes only. Without Playwright the file FAILS,
// unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';

const TARGET = '叫我们结果子给神', IPAD = 820;
const ZH4 = '你们藉着基督的身体，在律法上也是死了，叫你们归于别人，就是归于那从死里复活的，叫我们结果子给神。';
const REF = '62ecd54b';   // v5.27.1, the owner's node: the control
const here = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'), show = (f) => execFileSync('git', ['show', `${REF}:${f}`], { cwd: ROOT, encoding: 'utf8' });
// Read when a page is built, never at load: a shallow checkout without REF must still load (and skip) under PA_E2E_SKIP=1.
const ENGINES = { get now() { return here('web/ink-frame.inline.html') + here('web/ink-anchor.inline.html'); }, get ref() { return show('web/ink-frame.inline.html') + show('web/ink-anchor.inline.html'); } };
const IPAD_FONT = 'font:20px/1.6 sans-serif', OTHER_FONT = 'font:19px/1.5 sans-serif;letter-spacing:0.4px';
const page = (font, eng = 'now') => `<!doctype html><meta charset=utf-8><style>body{margin:0;${font}}#v{position:relative;padding:0 16px;height:100vh;overflow:auto}.verse{margin:0 0 12px}</style>
<div id=v><div class=verse data-n=4><div class=vzh>${ZH4}</div><div class=ven>So, my brothers, you also died to the law through the body of Christ.</div></div>
<div class=verse data-n=5><div class=vzh>因为我们属肉体的时候，那因律法而生的恶欲，就在我们肢体中发动。</div><div class=ven>For when we lived according to the flesh.</div></div></div>
<script>window.PANote={ink:{MAX_CANVAS_PX:1e8,drawStroke(){},segTo(){},guardInk(){}}};</script>${ENGINES[eng]}
<script>window.A=PAInkAnchor.attach({container:document.getElementById('v'),onChange(){}});</script>`;

let browser;
before(async () => { if (!skip) browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); });
const open = async (font, width, eng) => { const p = await browser.newPage({ viewport: { width, height: 900 } }); await p.setContent(page(font, eng)); return p; };
const target = (p) => p.evaluate((T) => { const el = document.querySelector('[data-n="4"] .vzh'), n = el.firstChild, s = el.textContent.indexOf(T), r = document.createRange();
  r.setStart(n, s); r.setEnd(n, s + T.length); const c = document.getElementById('v').getBoundingClientRect();
  return [...r.getClientRects()].map((x) => ({ l: x.left - c.left, t: x.top - c.top, r: x.right - c.left, b: x.bottom - c.top })); }, TARGET);
const stroke = (p, pts) => p.evaluate((pts) => { const c = document.getElementById('v'), cr = c.getBoundingClientRect();
  const ev = (type, q) => new PointerEvent(type, { pointerType: 'pen', pointerId: 7, clientX: cr.left + q[0], clientY: cr.top + q[1], pressure: 0.5, bubbles: true, cancelable: true });
  c.dispatchEvent(ev('pointerdown', pts[0])); for (const q of pts.slice(1)) window.dispatchEvent(ev('pointermove', q)); window.dispatchEvent(ev('pointerup', pts[pts.length - 1])); }, pts);
// The oval's drawn box now (list px): the first record's place + its stroke extent x scale.
const ovalBox = (p) => p.evaluate(() => { A.reflow(); const g = A.groups()[0], at = A.placements()[0].at; let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
  for (const q of g.strokes[0].p) { l = Math.min(l, q[0]); t = Math.min(t, q[1]); r = Math.max(r, q[0]); b = Math.max(b, q[1]); }
  return { l: at.ox, t: at.oy, r: at.ox + (r - l) * at.s, b: at.oy + (b - t) * at.s }; });
const area = (x) => Math.max(0, x.r - x.l) * Math.max(0, x.b - x.t);
const inter = (a, b) => area({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });

async function writeOval() {
  const p = await open(IPAD_FONT, IPAD), rows = await target(p), row = rows[rows.length - 1];
  assert.equal(rows.length, 1, 'circled on one row');
  const cx = (row.l + row.r) / 2, cy = (row.t + row.b) / 2, rx = (row.r - row.l) / 2 + 8, h = (row.b - row.t) / 2 + 12, oval = [];
  for (let i = 0; i <= 40; i++) { const a = i / 40 * 2 * Math.PI; oval.push([cx + rx * Math.cos(a), cy + h * Math.sin(a)]); }
  await stroke(p, oval); const recs = await p.evaluate(() => A.groups()), box = await ovalBox(p); await p.close();
  assert.ok(recs[0].charEnd - recs[0].charStart > TARGET.length, 'the oval reached the row above (the owner\'s case)');
  return { recs, box };
}

async function viewed(w, eng) {
  const { recs } = await writeOval(), p = await open(OTHER_FONT, w, eng);
  await p.evaluate((r) => A.load(r), recs);
  const rows = await target(p), box = await ovalBox(p);
  assert.equal(rows.length, 1, 'the words sit on one row here (as on the owner\'s laptop)');
  const en = await p.evaluate(() => { const r = document.querySelector('[data-n="4"] .ven').getBoundingClientRect(), c = document.getElementById('v').getBoundingClientRect(); return { t: r.top - c.top }; });
  await p.close();
  return { rows, box, en };
}
const rings = ({ rows, box }) => rows.every((r) => inter(r, box) >= 0.9 * area(r));
for (const w of [1000, 1280, 1600, 2000]) {
  test(`iPad oval viewed at ${w} on other fonts: it rings 叫我们结果子给神, not the English line`, { skip }, async () => {
    const { rows, box, en } = await viewed(w);
    for (const r of rows) assert.ok(inter(r, box) >= 0.9 * area(r), `each row of the words lies inside the oval: ${JSON.stringify({ r, box })}`);
    assert.ok((box.t + box.b) / 2 < en.t, `the oval's middle is above the English line: ${JSON.stringify({ box, en })}`);
  });
}

test('control: v5.27.1 (the owner\'s node) leaves the oval off its words here (else the tests above prove nothing)', { skip }, async () => {
  for (const w of [1000, 1600]) assert.equal(rings(await viewed(w, 'ref')), false, `width ${w}`);
});

test('same fonts, written width: drawn exactly where it was written (no regression)', { skip }, async () => {
  const { recs, box } = await writeOval(), p = await open(IPAD_FONT, IPAD);
  await p.evaluate((r) => A.load(r), recs); const now = await ovalBox(p); await p.close();
  assert.deepStrictEqual(now, box);
});
