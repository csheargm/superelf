// Screen pixels are not page pixels · 屏幕像素 ≠ 页面像素
//
// Every screen→page conversion in the pad divided a SCREEN distance by W, the LOGICAL page width.
// That is exact only while the page is rendered at 1:1 — which it always has been, because the
// page has always been sized to whatever the screen was. The moment the page becomes a fixed
// surface scaled to fit the device (a real paper size, so a note looks the same on an 11" iPad and
// a laptop), every one of those divisions is wrong by the scale factor, and ink lands where the
// pen is not.
//
// This pins the unit discipline BEFORE the page model changes under it: a screen distance is
// always measured against a MEASURED screen width, never against the logical one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);

test('the screen↔page ratio has exactly one definition', () => {
  assert.match(E, /const pageK=\(r\)=>\{ const w=\(r\|\|ink\.getBoundingClientRect\(\)\)\.width; return w>0 \? w\/W : 1; \};/,
    'one helper, measured from the element rather than assumed');
});

test('a hidden pad falls back to 1:1 instead of writing NaN into the note', () => {
  // A closed pad measures 0. Dividing by it yields NaN/Infinity coordinates, which persist into
  // the stroke array and are unrecoverable — the same shape as the 0x0-viewport scars.
  const fn = /const pageK=\(r\)=>\{[^}]*\}/.exec(E)[0];
  assert.match(fn, /w>0 \? w\/W : 1/, 'zero width is answered with 1, not a division');
});

test('every screen→page conversion goes through it', () => {
  // The whole point: find any conversion still dividing a client-space distance by the bare W.
  const strays = [...E.matchAll(/\(e\.client[XY][^)]*\)\/W(?![*a-zA-Z])/g)];
  assert.equal(strays.length, 0,
    `a screen distance is still divided by the logical width: ${strays.map((m) => m[0]).join(', ')}`);
  // …and the four that exist all use the ratio.
  for (const site of [
    /const pointAt=e=>\{ const r=ink\.getBoundingClientRect\(\), k=pageK\(r\);/,
    /const nx=\(e\.clientX-r\.left\)\/\(W\*k\), ny=\(e\.clientY-r\.top\)\/\(W\*k\);/,
    /const nX=e=>\{ const r=ink\.getBoundingClientRect\(\); return \(e\.clientX-r\.left\)\/\(W\*pageK\(r\)\); \};/,
    /const nY=e=>\{ const r=ink\.getBoundingClientRect\(\); return \(e\.clientY-r\.top\)\/\(W\*pageK\(r\)\); \};/,
  ]) assert.match(E, site, `converted: ${site}`);
});

test('the page-flip gesture measures against the screen too', () => {
  // It compares a drag distance to a fraction of the page. Left in logical units, a flip would
  // need a longer or shorter swipe depending on the zoom — the gesture would feel different on
  // every device, which is the same bug wearing different clothes.
  assert.match(E, /prog=\(-t\.dir\*dx\)\/\(W\*pageK\(\)\)/, 'the flip threshold is scale-invariant');
});

test('y is still normalised by WIDTH, not height', () => {
  // The stroke model stores x AND y as fractions of the page WIDTH, so a page can grow downwards
  // without restating every point. A "fix" that divided y by the height would silently rescale
  // every existing note vertically.
  assert.match(E, /const nY=e=>\{[^}]*\/\(W\*pageK\(r\)\); \};/, 'nY divides by the width');
  assert.doesNotMatch(E, /const nY=e=>\{[^}]*\/\(H[*)]/, 'never by the height');
});

// ── the page model itself ────────────────────────────────────────────────────────────────────
test('a page is US Letter, on every device', () => {
  // 8.5in x 11in at 96 CSS dpi. The numbers matter less than the fact that there IS one size:
  // ink is placed against the page width and typed text wraps at it, so a page whose shape
  // follows the screen makes the two layers disagree about where a line is.
  assert.match(E, /const PAGE_W=816, PAGE_H=1056;/, 'Letter at 96dpi');
  // PAGE_ASPECT was declared with this and never read — print derives its own sheet aspect, on
  // purpose (see print-ui). A constant nothing consumes is not documentation, it is a claim that
  // something uses it; deleted rather than kept "for later" (R1/R7).
  assert.doesNotMatch(E, /const PAGE_ASPECT=/, 'no constant that nothing reads');
  assert.match(E, /W=PAGE_W;/, 'the page width is the page width, not the stage width');
  // Word-boundary: `lastW=r.width` is the resize observer's bookkeeping, not the page width, and
  // a looser pattern fails on it while proving nothing.
  assert.doesNotMatch(E, /\bW=r\.width;/, 'and never the device again');
});

test('the page still grows downwards for content past the sheet', () => {
  // Existing notes have ink below where a Letter bottom edge now falls. Clipping it would hide
  // real handwriting; splitting it onto a new page is a separate decision with its own risks.
  // Pinned as the invariant rather than the expression: the sheet is a FLOOR (a page is never
  // shorter than Letter) and the height follows the content above it. The tail it adds now
  // depends on the view — seamless keeps a screenful, single page keeps breathing room — and
  // there is a ceiling on top, because one canvas cannot grow without limit.
  assert.match(E, /const want=Math\.ceil\(pageExtent\(page\(\)\)\*W\)\+tail;/,
    'the wanted height comes from the content plus the view\'s tail');
  // A Letter page is relatively narrower than an 11" iPad in portrait, so fitting the width left
  // a strip of dead grey beneath it. The page extends to fill the screen — and that costs no
  // paper, because print counts sheets from the CONTENT extent, never from the page height.
  assert.match(E, /const screenH=Math\.ceil\(r\.height\/k\);/, 'the screen height is known in page px');
  assert.match(E, /: Math\.max\(PAGE_H,screenH,want\);/,
    'single page is never shorter than a sheet, the screen, or its own content');
});

test('the page fills the screen, and stays crisp by rendering at device resolution', () => {
  // This was capped at 1:1, on the theory that magnifying an 816px bitmap softens the ink. True,
  // but the cap was the wrong answer: it left a 12.9" iPad showing an 816px page in a grey field,
  // using about half the screen. Crispness comes from the BACKING STORE following the on-screen
  // size, which is what the dpr does now — so the page is free to grow.
  assert.doesNotMatch(E, /Math\.min\(1,r\.width\/PAGE_W\)/, 'the 1:1 cap is gone');
  assert.match(E, /dpr=Math\.min\(window\.devicePixelRatio\|\|1,2\)\*k;/, 'the backing store follows the scale');
  // Single page fits BOTH axes so the whole sheet is visible; seamless fits the width because it
  // is meant to run off the bottom.
  // Fit the WIDTH in both views. Fitting both axes kept the whole sheet visible but stranded a
  // narrow page between two wide margins in landscape — the screen-waste report in the other
  // orientation. A document viewer fills the width and scrolls.
  assert.match(E, /const k=Math\.max\(MIN_PAGE_W\/PAGE_W, r\.width\/PAGE_W\);/, 'width, always');
});

test('the canvas budget is a data-loss guard, not tuning', () => {
  // iOS refuses a canvas past roughly this and returns a BLANK one without throwing. A tall
  // seamless page at a large scale would ask for exactly that, and a blank page reads as a lost
  // note rather than as a limit. Clamped by AREA, since it is the product that overflows.
  assert.match(E, /const MAX_CANVAS_PX=16e6;/, 'a named budget');
  assert.match(E, /if\(area>MAX_CANVAS_PX\) dpr\*=Math\.sqrt\(MAX_CANVAS_PX\/area\);/,
    'resolution is reduced rather than the page being refused');
});

test('centring divides by the scale, because `left` is scaled too', () => {
  // Measured in a browser, not reasoned: on a zoomed element `left` is interpreted in the
  // element's own space, so asking for 314px at k=0.8 lands at 251. The page would sit
  // progressively further left the more it was shrunk.
  assert.match(E, /const left=Math\.max\(0,Math\.round\(\(\(r\.width-PAGE_W\*k\)\/2\)\/k\)\);/,
    'the offset is divided by k');
});

test('zoom is used rather than transform, and both layers get it', () => {
  // transform does not participate in layout: the stage would scroll the UNSCALED extent and
  // hit-testing would need its own correction. zoom keeps clientX and the scroll box in one space.
  assert.match(E, /el\.style\.zoom=k;/, 'the page is fitted with zoom');
  assert.match(E, /for\(const el of \[pageInner,flip\]\)/,
    'the flip layer gets identical geometry, or a page turn would jump');
});

test("the selected-image menu is placed in SCREEN px, like every other conversion", () => {
  // SCAR. It positioned itself with (im.x+im.w)*W — a PAGE coordinate — added to r.left, a SCREEN
  // one. The menu therefore drifted left of the ⋯ handle it belongs to, by an amount that GROWS
  // with the zoom: ~58px at k=1.2, ~250px on a full-width laptop pane. The drawing path had the
  // same mix-up and was fixed; this one was missed because it is placement, not input, so nothing
  // landed in the wrong place — it just looked wrong.
  const fn = /const r=ink\.getBoundingClientRect\(\), hr=host\.getBoundingClientRect\(\), k=pageK\(r\);[\s\S]*?bottom='auto';/.exec(E);
  assert.ok(fn, 'the image menu placement must be findable');
  // The handle position is scaled; an explicit point (a right-click) is already in host
  // coordinates and is used as-is. Both forms live in one expression.
  assert.match(fn[0], /const hx=at\?at\.x:\(\(im\.x\+im\.w\)\*W\*k \+ r\.left - hr\.left\);/, 'x is scaled');
  assert.match(fn[0], /const hy=at\?at\.y:\(im\.y\*W\*k \+ r\.top - hr\.top\);/, 'and so is y');
  // Hangs LEFT from the handle instead of centring on it: the handle is at the image's top-RIGHT,
  // so a centred menu puts half of itself past the edge of a full-width photo.
  assert.match(fn[0], /transform='none'/, 'no centring transform');
  assert.match(fn[0], /Math\.max\(8,Math\.min\(at\?hx:hx-pw\+12,hr\.width-pw-8\)\)/,
    'clamped inside the host either way — a pointer near the right edge must not push it off');
});
