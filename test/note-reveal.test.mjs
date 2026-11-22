// web/note-reveal.inline.html — the search-hit reveal, RUN against a small DOM stub: the page flip is
// PANote's own flipTo (recorded here), the boxes become px of the page's width, typed runs are marked
// through the Custom Highlight API where it exists, and everything clears at the next touch or after
// the interval. Plus the pins that wire it: note-ui carries the marker, web.mjs inlines it after
// note-ui, PANote lends it the page and exports reveal().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const REVEAL = read('web/note-reveal.inline.html'), ENGINE = read('web/note-ui.inline.html'), WEB = read('web.mjs');
const MARKER = '<!--PA_NOTE_REVEAL_UI-->';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function el(tag, extra = {}) {
  const on = {};
  const e = { tag, style: {}, className: '', children: [], parent: null, removed: false, on, ...extra,
    appendChild(k) { e.children.push(k); k.parent = e; return k; },
    remove() { e.removed = true; if (e.parent) e.parent.children = e.parent.children.filter((x) => x !== e); },
    addEventListener(t, fn, o) { (on[t] ||= []).push({ fn, o }); } };
  return e;
}
// One attached reveal over a fake pad. `typed` installs a fake Custom Highlight API over the text
// layer's text nodes; without it the page has no such API (an older WebKit).
function pad({ typed = null, width = 800 } = {}) {
  const src = REVEAL.slice(REVEAL.indexOf('<script id="pnr-script">') + '<script id="pnr-script">'.length, REVEAL.indexOf('</script>', REVEAL.indexOf('<script id="pnr-script">')));
  const host = el('host'), stage = el('stage'), pageInner = el('pageInner', { clientWidth: width }), textLayer = el('textLayer');
  const window = { PA_REVEAL_MS: 40 };
  const document = { createElement: (t) => el(t) };
  if (typed) {
    const ranges = [];
    window.CSS = { highlights: new Map() };
    window.Highlight = class { constructor() { this.ranges = []; } add(r) { this.ranges.push(r); ranges.push(r); } };
    window.NodeFilter = { SHOW_TEXT: 4 };
    document.createTreeWalker = (root, what) => { assert.equal(root, textLayer); assert.equal(what, 4); let i = -1; return { nextNode: () => typed[++i] ? { data: typed[i] } : null }; };
    document.createRange = () => ({ setStart(n, a) { this.node = n.data; this.a = a; }, setEnd(_n, b) { this.b = b; } });
    window.ranges = ranges;
  }
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(window, document);
  const flips = [];
  const r = window.PANoteReveal.attach({ host, stage, pageInner, textLayer, flipTo: async (n) => { flips.push(n); return n < 5; }, listen: (t, type, fn, o) => t.addEventListener(type, fn, o) });
  const touch = () => { for (const l of host.on.pointerdown || []) l.fn({}); };
  const layer = () => pageInner.children.find((c) => c.className === 'pan-reveal') || null;
  return { r, flips, touch, layer, host, window };
}
const px = (d) => [d.style.left, d.style.top, d.style.width, d.style.height];

test('a hit opens on its page through PANote\'s own flipTo, and its boxes become rectangles in px of the page width', async () => {
  const P = pad();
  assert.equal(await P.r.show({ page: 2, boxes: [[0.1, 0.25, 0.5, 0.05], [0, 0, 0.001, 0.001], 'junk', [1, 2, 3]], terms: [] }), true);
  assert.deepEqual(P.flips, [2], 'flipped once, to the hit page');
  const L = P.layer();
  assert.ok(L, 'one overlay in the page (it rides the page on a flip)');
  assert.deepEqual(L.children.map(px), [['80px', '200px', '400px', '40px'], ['0px', '0px', '2px', '2px']], 'x, y, w, h all scale by the width (the page\'s one unit); a sliver is still visible; malformed boxes are skipped');
  assert.ok(P.r.active());
  assert.equal(await P.r.show({ page: 0, boxes: [[0.1, 0.1, 0.1, 0.1]] }), true, 'a second show replaces the first');
  assert.deepEqual(P.flips, [2, 0], 'page 0 flips too: a kept-in-memory reload leaves the pad where it was (flipTo itself refuses target===cur)');
  assert.equal(P.host.children.length + 0, 0); assert.equal(P.layer().children.length, 1, 'the old overlay is gone, the new one has one box');
});

test('the reveal ends at the next touch of the pad, or on its own after the interval; a hidden pad draws nothing', async () => {
  const P = pad();
  await P.r.show({ page: 0, boxes: [[0.1, 0.1, 0.1, 0.1]] });
  const l = P.host.on.pointerdown[0];
  assert.deepEqual(l.o, { capture: true, passive: true }, 'capture + passive: it never changes what the touch does');
  P.touch();
  assert.equal(P.layer(), null, 'gone at the touch'); assert.equal(P.r.active(), false);
  await P.r.show({ page: 0, boxes: [[0.1, 0.1, 0.1, 0.1]] });
  await tick(90);
  assert.equal(P.layer(), null, 'gone after PA_REVEAL_MS (40 ms here; REVEAL_MS in the page)'); assert.equal(P.r.active(), false);
  assert.equal(P.window.PANoteReveal.REVEAL_MS, 4000);
  const hidden = pad({ width: 0 });
  assert.equal(await hidden.r.show({ page: 0, boxes: [[0.1, 0.1, 0.1, 0.1]] }), false, 'no width: no rectangle could be placed');
  assert.equal(hidden.layer(), null);
  for (const bad of [null, 'x', {}, { page: 'a' }, { boxes: 'no' }]) assert.equal(await hidden.r.show(bad), false, `${JSON.stringify(bad)}: nothing, no throw`);
});

test('typed text is MARKED through the Custom Highlight API (never wrapped: the text layer is the saved page), and skipped where the API is missing', async () => {
  const P = pad({ typed: ['Met the Landlord about', 'the landlord\'s roof'] });
  assert.equal(await P.r.show({ page: 0, boxes: [], terms: ['landlord', 'ROOF', '', 7] }), true);
  assert.deepEqual(P.window.ranges.map((r) => [r.node, r.a, r.b]), [['Met the Landlord about', 8, 16], ['the landlord\'s roof', 4, 12], ['the landlord\'s roof', 15, 19]], 'every occurrence, case-folded; non-strings ignored');
  assert.ok(P.window.CSS.highlights.has('pan-reveal'), 'registered under the ::highlight() name');
  assert.match(REVEAL, /::highlight\(pan-reveal\)\{background:/, 'and styled under that name');
  assert.equal(P.layer(), null, 'no overlay for typed text');
  P.touch();
  assert.equal(P.window.CSS.highlights.has('pan-reveal'), false, 'cleared with the rest');
  const none = pad();
  assert.equal(await none.r.show({ page: 1, boxes: [], terms: ['landlord'] }), false, 'no API: typed text is not marked — but the page still flipped');
  assert.deepEqual(none.flips, [1]);
  assert.doesNotMatch(REVEAL, /\.innerHTML\s*=|<mark|insertAdjacentHTML|surroundContents/, 'the component never writes into the text layer');
});

test('wired: note-ui carries the marker once, web.mjs inlines the component after note-ui, PANote lends the page and exports reveal()', () => {
  assert.equal(ENGINE.split(MARKER).length, 2, 'note-ui carries the marker once');
  const list = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('];', WEB.indexOf('const PA_COMPONENTS = [')));
  assert.ok(list.indexOf("'note-ui.inline.html'") < list.indexOf("'note-reveal.inline.html'"), 'registered after note-ui, which carries its marker');
  assert.match(list, /\{ marker: '<!--PA_NOTE_REVEAL_UI-->', file: 'note-reveal\.inline\.html' \}/);
  assert.match(ENGINE, /const reveal=window\.PANoteReveal\?window\.PANoteReveal\.attach\(\{host,stage,pageInner,textLayer,flipTo,listen:listenG\}\):null;/, 'the glue lends the real page and the real flip');
  assert.match(ENGINE, /\n      reveal:\(at\)=>reveal\?reveal\.show\(at\):Promise\.resolve\(false\),/, 'on the pad API, so fullscreen() and panel() carry it through Object.assign');
  assert.equal((ENGINE.match(/PANoteReveal/g) || []).length, 2, 'attached from ONE place');
  assert.match(ENGINE, /terms:Array\.isArray\(r\.terms\)\?r\.terms\.filter\(t=>typeof t==='string'\):\[\]/, 'PANote.search passes the reply\'s terms through');
});
