// PAScanDetect（幻灯片自动取景）— the straighten editor starts with its corners ON the slide.
//
// The owner (2026-11-08): "when taking a picture, the camera should try to auto frame the slide."
// The camera is the native iOS one, so framing happens on the photo: PAScanDetect.quad finds the
// bright slide in a darker room, or — "also use edge detection so dark slides get framed" — the
// four dominant edges by Sobel + Hough when brightness finds nothing, then — "also crop out the bezel
// when framing a laptop screen" — shrinks past a dark flat band to the lit screen; PAScan places its four handles there. The REAL component
// script is extracted from web/scan-detect.inline.html and RUN on synthetic images (R14: no
// re-implementation here). Known limits are pinned: as null, or as the imperfect-but-draggable quad they give.
// R11 — searched: "otsu", "hough", "Sobel", "bezel", "PAScanDetect", "autoQuad", "PA_SCAN_DETECT" — no duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DETECT = read('web/scan-detect.inline.html');
const SCAN = read('web/scan-ui.inline.html');
const WEB = read('web.mjs');

function load() {
  const js = /<script id="psd-script">([\s\S]*?)<\/script>/.exec(DETECT);
  assert.ok(js, 'the component is one script');
  const win = {};
  new Function('window', js[1])(win);
  return win.PAScanDetect;
}
const { quad, quadBy } = load();

// A synthetic photo: dark room (with noise) and one bright convex quad, in image px.
function photo(w, h, poly, { bg = 40, fg = 230, noise = 12, seed = 7 } = {}) {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2 * noise;
  const inside = (x, y) => { // point-in-convex-polygon by consistent cross-product sign
    let sgn = 0;
    for (let i = 0; i < poly.length; i++) { const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      const z = (bx - ax) * (y - ay) - (by - ay) * (x - ax); if (!z) continue; if (sgn && Math.sign(z) !== sgn) return false; sgn = Math.sign(z); }
    return true; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.max(0, Math.min(255, (poly && inside(x + 0.5, y + 0.5) ? fg : bg) + rnd())), i = (y * w + x) * 4;
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255; }
  return { data, width: w, height: h };
}
const near = (p, q, tol) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;

test('a skewed bright slide in a dark room is found, corners within 3 px', () => {
  const truth = [[60, 40], [270, 55], [255, 200], [45, 185]];                // TL,TR,BR,BL, perspective-skewed
  const q = quad(photo(320, 240, truth));
  assert.ok(q, 'a quad is returned');
  truth.forEach((t, i) => assert.ok(near(q[i], t, 3), `corner ${i}: got ${q[i]} want ${t}`));
});

test('dark content INSIDE the slide (text, a header bar with a light margin) does not shrink the frame', () => {
  // Text and a dark header bar punch holes in the bright blob; the extreme points are still the slide's.
  const truth = [[50, 30], [280, 30], [280, 210], [50, 210]];
  const img = photo(320, 240, truth);
  const dark = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * 320 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 25; } };
  dark(54, 276, 34, 60);                                                   // header bar, 4 px light margin
  for (let y = 90; y < 200; y += 12) dark(70, 260, y, y + 2);              // text lines
  const q = quad(img);
  assert.ok(q, 'a quad is returned');
  truth.forEach((t, i) => assert.ok(near(q[i], t, 3), `corner ${i}: got ${q[i]} want ${t}`));
});

test('KNOWN LIMIT: a dark band flush with the slide edge is cropped off — the handle is there to drag', () => {
  const img = photo(320, 240, [[50, 30], [280, 30], [280, 210], [50, 210]]);
  for (let y = 30; y < 60; y++) for (let x = 50; x < 280; x++) { const i = (y * 320 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 25; }
  const q = quad(img);
  assert.ok(q && near(q[0], [50, 60], 3) && near(q[1], [280, 60], 3), `frames the bright part only, got ${q}`);
});

test('a DARK slide is framed by its edges: on a gray wall, on a white wall, by the edge pass alone', () => {
  const truth = [[60, 40], [270, 55], [255, 200], [45, 185]];
  for (const bg of [120, 230]) {
    const img = photo(320, 240, truth, { bg, fg: 30 });
    assert.equal(quadBy(img, 'bright'), null, `brightness alone cannot frame a dark slide on wall ${bg}`);
    const q = quad(img);
    assert.ok(q, `wall ${bg}: a quad is returned`);
    truth.forEach((t, i) => assert.ok(near(q[i], t, 3), `wall ${bg} corner ${i}: got ${q[i]} want ${t}`));
  }
});

test('a CLEAN dark slide (noise averaged away by the downscale) is still framed — the floor, not the percentile, sets the edge level', () => {
  // The ≤320 px copy of a 12 MP photo divides sensor noise by ~12. With noise 0–2 the top-6% level
  // sits in the noise bins; an earlier draft let that percentile WIN and returned null on every clean photo.
  const truth = [[60, 40], [270, 55], [255, 200], [45, 185]];
  for (const noise of [0, 1, 2, 6]) {
    const q = quad(photo(320, 240, truth, { bg: 120, fg: 30, noise }));
    assert.ok(q, `noise ${noise}: a quad is returned`);
    truth.forEach((t, i) => assert.ok(near(q[i], t, 3), `noise ${noise} corner ${i}: got ${q[i]} want ${t}`));
  }
});

test('a bright window BESIDE a dark slide is not the slide: the blob misses the centre, so the edges decide', () => {
  const truth = [[40, 40], [210, 50], [205, 200], [35, 190]];
  const img = photo(320, 240, truth, { bg: 120, fg: 30 });
  for (let y = 20; y < 150; y++) for (let x = 230; x < 310; x++) { const i = (y * 320 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 245; }   // window, 13% of the frame
  assert.ok(quadBy(img, 'bright')[0][0] >= 225, 'brightness alone frames the window');
  const q = quad(img);
  assert.ok(q, 'a quad is returned');
  truth.forEach((t, i) => assert.ok(near(q[i], t, 3), `corner ${i}: got ${q[i]} want ${t}`));
});

test('a dark slide FULL of high-contrast text is framed by its outer edge, not a text line or the text block', () => {
  // 8 lines of 235-on-25 text with word gaps: more text-edge pixels than the 6% budget, and every
  // text line out-votes the slide's own 140-vs-25 edge in Hough space. The slide must still win.
  const truth = [[50, 30], [280, 30], [280, 210], [50, 210]];
  const img = photo(320, 240, truth, { bg: 140, fg: 25 });
  const light = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * 320 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 235; } };
  for (let y = 60; y < 200; y += 16) for (let x = 70; x < 262; x += 24) light(x, x + 18, y, y + 6);   // words 18 px wide, 6 px gaps, 6 px tall
  const q = quad(img);
  assert.ok(q, 'a quad is returned');
  truth.forEach((t, i) => assert.ok(near(q[i], t, 3), `corner ${i}: got ${q[i]} want ${t}`));
});

test('brightness runs first; edges when it finds nothing or its blob misses the centre', () => {
  assert.match(DETECT, /const r=\(b&&holdsCentre\(b,w,h\)\)\?b:\(byEdges\(g,w,h\)\|\|b\); if\(!r\) return null;\n\s*return cropBezel\(r,g,w,h\) \|\| r; \}/, 'the order is the one the header describes');
  const bright = photo(320, 240, [[60, 40], [270, 55], [255, 200], [45, 185]]);
  assert.deepEqual(quad(bright), quadBy(bright, 'bright'), 'a bright slide is the brightness answer');
});

test('known limits return null, never a wrong quad: flat, frame-filling, speck, same-shade sheet', () => {
  assert.equal(quad(photo(320, 240, null)), null, 'a flat image has no slide');
  assert.equal(quad(photo(320, 240, [[0, 0], [320, 0], [320, 240], [0, 240]])), null, 'a slide filling the frame is nothing to crop');
  assert.equal(quad(photo(320, 240, [[150, 110], [170, 110], [170, 130], [150, 130]])), null, 'a speck (a lamp) is not a slide');
  assert.equal(quad(photo(320, 240, [[60, 40], [260, 40], [260, 200], [60, 200]], { bg: 232, fg: 232, noise: 10 })), null, 'a sheet of the SAME shade as the desk: only noise separates them');
  // …but a sheet even slightly brighter than the desk is found — Otsu needs a gap, not a dark room.
  const faint = quad(photo(320, 240, [[60, 40], [260, 40], [260, 200], [60, 200]], { bg: 230, fg: 240, noise: 8 }));
  assert.ok(faint && near(faint[0], [60, 40], 4), `a 10-level gap is enough, got ${faint}`);
  assert.equal(quad({ data: new Uint8ClampedArray(0), width: 0, height: 0 }), null, 'an empty image');
  assert.equal(quad(photo(320, 240, [[60, 40], [270, 55], [255, 200], [45, 185]], { bg: 60, fg: 30, noise: 20 })), null, 'a dark slide under heavy sensor noise: the inset, not a noise quad');
  assert.equal(quadBy(photo(320, 240, null, { noise: 12 }), 'edges'), null, 'the edge pass alone finds nothing in noise');
});

// A laptop: a black bezel (outer) around a lit screen (inner) showing dark content with light text.
function laptop({ screen = 40, bezel = 0, text = true, noise = 4 } = {}) {
  const outer = [[50, 32], [277, 48], [264, 208], [37, 190]], inner = [[60, 40], [270, 55], [255, 200], [45, 185]];
  const img = photo(320, 240, outer, { bg: 155, fg: bezel, noise });
  const s = { v: 7 }; const rnd = () => ((s.v = (s.v * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2 * noise;
  const insideQ = (x, y) => { let sgn = 0; for (let i = 0; i < 4; i++) { const [ax, ay] = inner[i], [bx, by] = inner[(i + 1) % 4]; const z = (bx - ax) * (y - ay) - (by - ay) * (x - ax); if (!z) continue; if (sgn && Math.sign(z) !== sgn) return false; sgn = Math.sign(z); } return true; };
  const word = (x, y) => text && y >= 70 && y < 180 && (y - 70) % 16 < 6 && x >= 80 && x < 240 && (x - 80) % 24 < 18;
  for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) if (insideQ(x + 0.5, y + 0.5)) { const i = (y * 320 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, (word(x, y) ? 220 : screen) + rnd())); }
  return { img, outer, inner };
}

test('a dark laptop screen is framed at the SCREEN, not the bezel: the flat dark band inside all four sides is cropped', () => {
  for (const text of [true, false]) {
    const { img, outer, inner } = laptop({ text });
    assert.ok(near(quadBy(img, 'edges')[0], outer[0], 4), 'the edge pass alone stops at the bezel');
    const q = quad(img);
    assert.ok(q, `text ${text}: a quad is returned`);
    inner.forEach((t, i) => assert.ok(near(q[i], t, 4), `text ${text} corner ${i}: got ${q[i]} want ${t}`));
  }
});

// A dark slide (25 on a 140 wall) with light (235) marks painted inside it, for the bezel guards.
function darkSlide(paint) {
  const slide = [[50, 30], [280, 30], [280, 210], [50, 210]], img = photo(320, 240, slide, { bg: 140, fg: 25, noise: 4 });   // noise 4: the downscaled copy's level; at 12 the flat check alone would reject every band
  const light = (x0, x1, y0, y1, v = 235) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * 320 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; } };
  paint(light); return { slide, img };
}
const atSlide = (q, slide, what) => slide.forEach((t, i) => assert.ok(q && near(q[i], t, 3), `${what}: corner ${i} got ${q && q[i]} want ${t}`));

test('each bezel guard alone keeps a slide whole (a mutation that drops one guard crops the slide)', () => {
  // MEDIAN guard: a light 2 px frame line 6 px inside a dark slide steps up on every side, along the
  // whole side, in a straight line — only the dark interior median says it is not a screen.
  let { slide, img } = darkSlide((light) => { light(56, 274, 36, 38); light(56, 274, 202, 204); light(56, 58, 36, 204); light(272, 274, 36, 204); });
  atSlide(quad(img), slide, 'frame line');
  // STEP_COVER guard: full-width light lines on 10 of every 16 rows make the interior median light,
  // and the top and bottom sides step along their whole length; the left and right sides step only
  // where a line is (10/16 of the samples, under 80%).
  ({ slide, img } = darkSlide((light) => { for (let y = 36; y < 200; y += 16) light(56, 274, y, y + 10); }));
  atSlide(quad(img), slide, 'full-width lines');
  // FIT_PX guard: a bright interior whose TOP edge zigzags between 6 and 14 px deep in 12 px columns —
  // every sample steps, the median is light, but the steps do not lie on one line.
  // (gray 60, not bright: a bright interior would be pass 1's blob, and pass 3 would never run.)
  ({ slide, img } = darkSlide((light) => { for (let x = 56; x < 274; x += 12) light(x, Math.min(274, x + 12), ((x - 56) / 12) % 2 ? 36 : 44, 204, 60); }));
  atSlide(quad(img), slide, 'zigzag');
  // FLAT guard: a dark slide whose 10 px margin is RINGED (25/45 alternating, 1 px rings) around a
  // gray (90) content area: every sample steps at the content, in a line, the median is light — but
  // the band the walk crossed is textured, not a flat bezel.
  ({ slide, img } = darkSlide((light) => { for (let d = 0; d < 10; d++) { const v = d % 2 ? 45 : 25; light(50 + d, 280 - d, 30 + d, 31 + d, v); light(50 + d, 280 - d, 209 - d, 210 - d, v); light(50 + d, 51 + d, 30 + d, 210 - d, v); light(279 - d, 280 - d, 30 + d, 210 - d, v); } light(60, 270, 40, 200, 90); }));
  atSlide(quad(img), slide, 'ringed margin');
});

test('KNOWN LIMITS of the bezel crop: a screen that is OFF stays at the bezel; a bezel under ~4 px is missed, 5 px is cropped; a slide with a uniform darker margin is cropped to its content', () => {
  const off = laptop({ screen: 6, text: false });
  assert.ok(near(quad(off.img)[0], off.outer[0], 4), `screen off: framed at the bezel, got ${quad(off.img)}`);
  const bezelOf = (px) => { const img = photo(320, 240, [[50, 30], [280, 30], [280, 210], [50, 210]], { bg: 155, fg: 0, noise: 4 });
    for (let y = 30 + px; y < 210 - px; y++) for (let x = 50 + px; x < 280 - px; x++) { const i = (y * 320 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 40; } return img; };
  // The Hough side can sit up to 2 px inside the true edge, eating that much of a thin bezel.
  assert.ok(near(quad(bezelOf(1))[0], [50, 30], 2), `1 px bezel: left at the bezel, got ${quad(bezelOf(1))}`);
  assert.ok(near(quad(bezelOf(5))[0], [55, 35], 2), `5 px bezel: cropped to the screen, got ${quad(bezelOf(5))}`);
  // The template limit: a gray (60) slide on a 140 wall with a lighter (120) content area 10 px inside is
  // cropped to the content — the margin IS a bezel by image content. The handles drag back out.
  const tpl = photo(320, 240, [[50, 30], [280, 30], [280, 210], [50, 210]], { bg: 140, fg: 60 });
  for (let y = 40; y < 200; y++) for (let x = 60; x < 270; x++) { const i = (y * 320 + x) * 4; tpl.data[i] = tpl.data[i + 1] = tpl.data[i + 2] = 120; }
  assert.ok(near(quadBy(tpl, 'edges')[0], [50, 30], 3), 'the edge pass frames the slide');
  assert.ok(near(quad(tpl)[0], [60, 40], 3), `margin template: cropped to the content, got ${quad(tpl)}`);
});

test('KNOWN LIMIT: a bright window touching the slide merges into the quad — draggable, not null', () => {
  const img = photo(320, 240, [[60, 40], [220, 40], [220, 200], [60, 200]]);
  for (let y = 0; y < 120; y++) for (let x = 220; x < 300; x++) { const i = (y * 320 + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 235; }
  const q = quad(img);
  assert.ok(q && q[1][0] >= 290, `the merged quad reaches the window's far edge, got ${q}`);
});

test('the editor runs the detector on a small copy and falls back to the 10% inset (R5)', () => {
  assert.match(SCAN, /<!--PA_SCAN_DETECT-->\n<script id="psc-script">/, 'scan-ui carries the marker ABOVE its own script');
  assert.match(SCAN, /corners=autoQuad\(canvas,w,h\);\n\s*if\(!corners\)\{ const p=0\.1;/, 'detector first, inset second');
  assert.match(SCAN, /const DETECT_PX=320;/, 'the long edge of the detection copy is a named constant');
  assert.match(SCAN, /if\(!window\.PAScanDetect\) return null;/, 'a missing component is the fallback, not an error');
  assert.match(SCAN, /\}catch\(_\)\{ return null; \}\s*\/\/ a detector failure must never block the editor/, 'the catch says why it is silent');
});

test('web.mjs inlines the detector right after scan-ui, which carries its marker', () => {
  const list = /const PA_COMPONENTS = \[([\s\S]*?)\n\];/.exec(WEB)[1];
  const scan = list.indexOf("file: 'scan-ui.inline.html'"), det = list.indexOf("file: 'scan-detect.inline.html'");
  assert.ok(scan >= 0 && det > scan, 'scan-detect is registered AFTER scan-ui (the loop re-tests the inlined html)');
  assert.match(list, /marker: '<!--PA_SCAN_DETECT-->', file: 'scan-detect\.inline\.html'/);
  assert.ok(DETECT.split('\n').length <= 300 && SCAN.split('\n').length <= 300, 'both files inside the R4 budget');
});
