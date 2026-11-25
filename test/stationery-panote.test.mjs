// Stationery inside PANote · 信纸与手写页
//
// The notebook stores only a REFERENCE ({id, source, fade?}); the design lives in PAStationery.
// What is pinned here, each against the SHIPPED code (extracted and run, or loaded whole):
//   · the reference survives PANote's sanitize() and moves the save-skip fingerprint — both are
//     mutation-tested, because either one missing silently drops the user's choice;
//   · drawPaper paints the design BEFORE any line, on screen and on paper (white paper included);
//   · an unknown or undecodable design is plain paper, never a throw;
//   · "My templates" round-trip through the host's own checked read/write;
//   · only the Journal opts in and pays for the component.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, GUARD, guardModule, between, stripComments, APP_SRC } from './helpers-app.mjs';
import { ROOT, STN_HTML, SAN_HTML, COST_HTML, GEOM_HTML, SIMP_HTML, loadStationery, withDesigns, recordingCtx, FakeImage, svg, tick } from './helpers-stationery.mjs';
import { PROTO_KEYS } from './helpers-proto.mjs';

const E = stripComments(ENGINE);
const line = (re) => { const m = re.exec(ENGINE); assert.ok(m, `the engine still declares ${re}`); return m[0]; };

// ── PANote's notebook schema, extracted ─────────────────────────────────────────────────────
function schemaModule(mutate) {
  let src = [line(/const VALID_TPL=[^;\n]*;/), line(/const PAPER_BGS=[^\n]*/), line(/const PAPER_WHITE=[^\n]*/),
    line(/const SAFE_COLOR=[^\n]*/), between(ENGINE, '  const validTemplate=o=>', '\n\n'),
    between(ENGINE, '  function sanitize(o){', '\n  }\n')].join('\n');
  if (mutate) { const b = src; src = mutate(src); assert.notEqual(src, b, 'the mutation matched nothing'); }
  // eslint-disable-next-line no-new-func
  return new Function(`const SCHEMA=2, genId=()=>'g';
    const pageTextHtml=(p)=>typeof p.pageHtml==='string'?p.pageHtml:'';\n${src}\nreturn {sanitize};`)();
}
const NB = (extra = {}) => ({ v: 2, id: 'nb', created: 1, updated: 2, template: 'plain', bgColor: '#fdfdfb',
  pages: [{ id: 'p', created: 1, updated: 1, strokes: [], pageHtml: '<p>hi</p>', images: [] }], ...extra });

test('the stationery reference survives save + reload, and junk is dropped', () => {
  const { sanitize } = schemaModule();
  const st = { id: 'gold-frame', source: 'bundled', fade: 0.3 };
  assert.deepEqual(sanitize(JSON.parse(JSON.stringify(NB({ stationery: st })))).stationery, st);
  assert.deepEqual(sanitize(NB({ stationery: { id: 'x', source: 'mine', evil: 1 } })).stationery, { id: 'x', source: 'mine' });
  for (const bad of [{ id: 'x', source: 'http' }, { id: '<svg>', source: 'bundled' }, { source: 'bundled' }, 'gold', 7]) {
    assert.equal('stationery' in sanitize(NB({ stationery: bad })), false, `${JSON.stringify(bad)} is not kept`);
  }
  assert.equal(sanitize(NB({ stationery: { id: 'x', source: 'bundled', fade: 5 } })).stationery.fade, undefined, 'fade out of range is dropped');
});

test('an old note without stationery is unchanged: no key, same fingerprint shape', () => {
  const { sanitize } = schemaModule();
  assert.equal('stationery' in sanitize(NB()), false);
  assert.match(GUARD.contentPrint(NB()), /\|plain\|#fdfdfb$/, 'the fingerprint ends where it always did');
});

test('mutation: without the sanitize() line, a reload forgets the stationery', () => {
  const m = schemaModule((s) => s.replace('const st=validStationery(o); if(st) out.stationery=st;', ''));
  assert.equal(m.sanitize(NB({ stationery: { id: 'a', source: 'bundled' } })).stationery, undefined);
});

// The notebook can be written by the Journal's confined AI turn (ADR 0002), so `source` is untrusted.
test('a source named after Object.prototype is dropped; mutation: the old object literal keeps it', () => {
  const { sanitize } = schemaModule();
  const mutant = schemaModule((s) => s.replace('Object.assign(Object.create(null),{bundled:1,mine:1,picture:1})', '{bundled:1,mine:1,picture:1}'));
  for (const source of PROTO_KEYS) {
    const nb = JSON.parse(JSON.stringify(NB({ stationery: { id: 'x', source } })));   // as read from disk
    assert.equal('stationery' in sanitize(nb), false, `shipped: source '${source}' is dropped`);
    assert.equal(mutant.sanitize(nb).stationery.source, source, `mutant: source '${source}' is kept`);
  }
  const arr = NB({ stationery: { id: 'x', source: ['bundled'] } });
  assert.equal('stationery' in sanitize(arr), false, 'a source must be a string: ["bundled"] is dropped');
  assert.deepEqual(schemaModule((s) => s.replace("typeof r.source!=='string'||", '')).sanitize(arr).stationery.source, ['bundled'], 'mutant: kept');
});

test('choosing or changing stationery changes the save fingerprint (else the save-skip guard drops it)', () => {
  const fp = (st) => GUARD.contentPrint(NB(st ? { stationery: st } : {}));
  assert.notEqual(fp({ id: 'a', source: 'bundled' }), fp(null), 'choosing one');
  assert.notEqual(fp({ id: 'a', source: 'bundled' }), fp({ id: 'b', source: 'bundled' }), 'switching designs');
  assert.notEqual(fp({ id: 'a', source: 'bundled' }), fp({ id: 'a', source: 'mine' }), 'same id, other source');
  assert.notEqual(fp({ id: 'a', source: 'bundled' }), fp({ id: 'a', source: 'bundled', fade: 0.4 }), 'fading it');
  const mutant = guardModule((s) => s.replace("+(st?'|'+st.source+':'+st.id+':'+(st.fade||0):'')", ''));
  assert.equal(mutant.contentPrint(NB({ stationery: { id: 'a', source: 'bundled' } })), mutant.contentPrint(NB()),
    'mutant: the choice is invisible to the guard — so the shipped line is what saves it');
});

// ── drawPaper, extracted and run against a recording context ───────────────────────────────
function drawPaperWith({ nb, stn, seamless = false }) {
  const src = between(ENGINE, '    function drawPaper(ctx,h,bg,fit,pw){', '\n    function drawDots(');
  const bgCtx = recordingCtx();
  // eslint-disable-next-line no-new-func
  const f = new Function('S', `let {bgCtx,W,H,NB,STN,seamless,PAGE_H,PAPER_WHITE,DEFAULT_TPL,RULE_INK,MARGIN_TPL}=S;
    const syncPaperPickers=()=>{}, ruleGap=()=>40, firstRuleY=()=>56, drawDots=()=>{}, drawMargin=()=>{};
    ${src.replace(/\n    function drawDots\($/, '')}\nreturn drawPaper;`);
  const drawPaper = f({ bgCtx, W: 816, H: 1056, NB: nb, STN: stn, seamless, PAGE_H: 1056, PAPER_WHITE: '#fdfdfb',
    DEFAULT_TPL: 'plain', RULE_INK: '#e7e6e1', MARGIN_TPL: {} });
  return { drawPaper, bgCtx };
}
const stnSpy = (log) => ({ paint: (ctx, ref, o) => { (ctx.log || log).push(['PAINT', ref.id, o]); return true; } });

test('drawPaper paints the stationery after the ground and BEFORE any line', () => {
  const { drawPaper, bgCtx } = drawPaperWith({ nb: NB({ template: 'ruled', stationery: { id: 'a', source: 'bundled' } }), stn: stnSpy() });
  drawPaper();
  const names = bgCtx.log.map((x) => x[0]);
  assert.ok(names.indexOf('fillRect') < names.indexOf('PAINT'), 'ground first');
  assert.ok(names.indexOf('PAINT') < names.indexOf('stroke'), 'design before the first line');
  assert.equal(typeof bgCtx.log.find((x) => x[0] === 'PAINT')[2].onReady, 'function', 'on screen it redraws once decoded');
});

test('print: the stationery is painted on WHITE paper too, inside the print fit, with no screen redraw hook', () => {
  const { drawPaper } = drawPaperWith({ nb: NB({ stationery: { id: 'a', source: 'bundled' } }), stn: stnSpy() });
  const sheet = recordingCtx(), fit = { k: 0.9, dx: 40 };
  drawPaper(sheet, 979, '#fdfdfb', fit);
  const p = sheet.log.find((x) => x[0] === 'PAINT');
  assert.ok(p, 'painted onto the print sheet even with the ink-on-white paper');
  assert.equal(p[2].fit, fit, 'and follows the content fit, so the design stays aligned with the ink');
  assert.equal(p[2].onReady, null);
});

test('no stationery, or a host that did not opt in: drawPaper never calls the component', () => {
  const log = [];
  drawPaperWith({ nb: NB(), stn: stnSpy(log) }).drawPaper();
  drawPaperWith({ nb: NB({ stationery: { id: 'a', source: 'bundled' } }), stn: null }).drawPaper();
  assert.equal(log.length, 0);
});

// R6, the whole path: a notebook as read from disk -> PANote's sanitize() -> drawPaper -> the REAL PAStationery.
test('a notebook whose source is an Object.prototype name opens on plain paper; mutation: both old literals crash the paint', () => {
  const open = (schema, stn, source) => { const { drawPaper, bgCtx } = drawPaperWith({ stn,
    nb: schema.sanitize(JSON.parse(JSON.stringify(NB({ stationery: { id: 'x', source } })))) }); drawPaper(); return bgCtx.log; };
  const shipped = schemaModule(), S = loadStationery();
  const oldSchema = schemaModule((s) => s.replace('Object.assign(Object.create(null),{bundled:1,mine:1,picture:1})', '{bundled:1,mine:1,picture:1}'));
  const oldS = loadStationery({ mutate: (s) => s.replace('Object.assign(Object.create(null),{bundled:new Map(),mine:new Map(),picture:new Map()})',
    '{bundled:new Map(),mine:new Map(),picture:new Map()}') });
  for (const source of PROTO_KEYS) {
    assert.ok(!open(shipped, S, source).some((x) => x[0] === 'drawImage'), `shipped: '${source}' is plain paper`);
    assert.doesNotThrow(() => open(oldSchema, S, source), `either gate alone keeps the page painting: '${source}'`);
    assert.throws(() => open(oldSchema, oldS, source), TypeError, `mutant: '${source}' throws while the page paints`);
  }
});

// ── Typed text starts inside the design's safe area ──────────────────────────────────────
// Before: the text layer was inset:0 whatever the design, so the first typed line ran through the
// top decoration on 7 of the 10 bundled designs (gold-frame's rules cut through the words).
function applyTextMetricsWith({ nb, stn, W = 408, mutate }) {
  const END = '\n    function syncPaperPickers(';
  let src = between(ENGINE, '    function applyTextMetrics(){', END).slice(0, -END.length);
  if (mutate) { const b = src; src = mutate(src); assert.notEqual(src, b, 'the mutation matched nothing'); }
  const textLayer = { style: {} };
  // eslint-disable-next-line no-new-func
  const f = new Function('S', `const {W,NB,STN,textLayer}=S; const RULED_TPL={ruled:1}, RULE_BASELINE_DROP=0.2;
    const syncStageClear=()=>{}, ruleGap=()=>40, firstRuleY=()=>56, marginPx=()=>30;
    ${src}\nreturn applyTextMetrics;`);
  f({ W, NB: nb, STN: stn, textLayer })();
  return textLayer.style;
}
test('typed text is padded into the design\'s safe area, scaled to the page width', () => {
  const S = withDesigns(loadStationery());
  for (const t of S.list()) {
    const st = applyTextMetricsWith({ nb: NB({ template: 'plain', stationery: { id: t.id, source: 'bundled' } }), stn: S, W: 408 });
    assert.deepEqual([st.paddingLeft, st.paddingTop, st.paddingRight],
      [Math.round(t.safe.x / 2) + 'px', Math.round(t.safe.y / 2) + 'px', Math.round((816 - t.safe.x - t.safe.w) / 2) + 'px'], t.id);
  }
  const plain = applyTextMetricsWith({ nb: NB({ template: 'plain' }), stn: S });
  assert.deepEqual([plain.paddingLeft, plain.paddingTop, plain.paddingRight], ['', '', ''], 'no design: the layer keeps its own padding');
  const ruled = applyTextMetricsWith({ nb: NB({ template: 'ruled' }), stn: S });
  assert.equal(ruled.paddingLeft, '30px', 'a ruled page keeps its margin'); assert.equal(ruled.paddingRight, '');
  const unknown = applyTextMetricsWith({ nb: NB({ template: 'plain', stationery: { id: 'gone', source: 'mine' } }), stn: S });
  assert.equal(unknown.paddingTop, '', 'a design not (yet) loaded: plain padding, re-applied when it arrives');
});
test('MUTATION: without the note-ui hook, typed text starts at the page edge again', () => {
  const S = withDesigns(loadStationery()), nb = NB({ template: 'plain', stationery: { id: 'gold-frame', source: 'bundled' } });
  assert.equal(applyTextMetricsWith({ nb, stn: S }).paddingTop, '50px');
  assert.equal(applyTextMetricsWith({ nb, stn: S, mutate: (s) => s.replace('if(STN) STN.inset(textLayer,NB.stationery,W);', '') }).paddingTop, '');
});
test('a design that loads LATER (My templates) re-pads the text: the picker\'s changed hook re-runs the metrics', () => {
  assert.match(ENGINE, /changed:\(\)=>\{ if\(bgCtx\)\{ drawPaper\(\); applyTextMetrics\(\); \} \}/);
});

// ── The real component's renderer ──────────────────────────────────────────────────────────
const TPL = { id: 'dots', name: '圆点 · Dots', group: 'stationery', audience: 'any', dark: false,
  safe: { x: 100, y: 100, w: 600, h: 300 }, lines: { gap: 100, top: 150, color: '#cccccc' },
  svg: svg('<rect width="816" height="1056" fill="#fff8f0"/><circle cx="40" cy="40" r="20" fill="#e0a0a0"/>') };

test('paint: unknown id -> plain paper (false, nothing drawn, no throw); known id -> image then lines', async () => {
  const S = loadStationery(); S.bundle([TPL]);
  const ctx = recordingCtx();
  assert.equal(S.paint(ctx, { id: 'no-such', source: 'bundled' }, { w: 816, h: 1056 }), false);
  assert.equal(S.paint(ctx, { id: 'dots', source: 'picture' }, { w: 816, h: 1056 }), false, 'picture: not rendered yet');
  assert.equal(ctx.log.length, 0, 'nothing drawn for an unknown design');
  let ready = 0;
  assert.equal(S.paint(ctx, { id: 'dots', source: 'bundled' }, { w: 816, h: 1056, onReady: () => ready++ }), false, 'still decoding');
  await tick();
  assert.equal(ready, 1, 'the page is told to redraw once the design decodes');
  assert.equal(S.paint(ctx, { id: 'dots', source: 'bundled', fade: 0.5 }, { w: 816, h: 1056 }), true);
  const names = ctx.log.map((x) => x[0]);
  assert.ok(names.indexOf('drawImage') < names.indexOf('stroke'), 'the design, then its writing guide');
  assert.deepEqual(ctx.log.find((x) => x[0] === 'drawImage').slice(2), [0, 0, 816, 1056]);
  assert.equal(ctx.log.filter((x) => x[0] === 'stroke').length, 3, 'lines at 150, 250, 350 inside the safe area');
  assert.ok(ctx.log.some((x) => x[0] === 'globalAlpha' && x[1] === 0.5), 'fade honoured');
});

test('paint rasterises at the DEVICE size (print resolution), and caches it per size', async () => {
  const S = loadStationery(); S.bundle([TPL]);
  await S.prime({ id: 'dots', source: 'bundled' });
  const sheet = recordingCtx(); sheet.setTransform(2.75);
  assert.ok(S.paint(sheet, { id: 'dots', source: 'bundled' }, { w: 816, h: 979, sheets: 1, fit: { k: 0.9, dx: 40 } }));
  const img = sheet.log.find((x) => x[0] === 'drawImage')[1];
  assert.equal(img.width, Math.round(816 * 2.75 * 0.9), 'raster width = page x print scale x fit');
  assert.ok(sheet.log.some((x) => x[0] === 'translate' && x[1] === 40), 'drawn inside the fit');
  const again = recordingCtx(); again.setTransform(2.75);
  S.paint(again, { id: 'dots', source: 'bundled' }, { w: 816, h: 979, sheets: 1, fit: { k: 0.9, dx: 40 } });
  assert.equal(again.log.find((x) => x[0] === 'drawImage')[1], img, 'same size: the cached bitmap');
});

test('a design that fails to decode is plain paper, and print does not wait for ever', async () => {
  const S = loadStationery(); S.bundle([TPL]);
  FakeImage.fail = true;
  try { assert.equal(await S.prime({ id: 'dots', source: 'bundled' }), false); } finally { FakeImage.fail = false; }
  assert.equal(S.paint(recordingCtx(), { id: 'dots', source: 'bundled' }, { w: 816, h: 1056 }), false);
  assert.equal(await S.prime({ id: 'nope', source: 'bundled' }), false);
});

// ── "My templates": the host's checked read/write ──────────────────────────────────────────
function memIo(files = {}, failRead = null) {
  return { files, writes: [],
    read: async (p) => (p === failRead ? { status: 'failed', error: 'boom' }
      : p in files ? { status: 'loaded', data: JSON.parse(files[p]) } : { status: 'absent', data: null }),
    write: async function (p, t) { this.writes.push(p); files[p] = t; return { ok: true }; } };
}
test('My templates round-trip: save through one instance, load through a fresh one', async () => {
  const io = memIo();
  const a = loadStationery().store(io);
  assert.deepEqual(await a.saveMine({ ...TPL, id: 'mine-1' }), { ok: true });
  assert.deepEqual(Object.keys(io.files).sort(), ['templates/index.json', 'templates/mine-1.json']);
  const S2 = loadStationery();
  const r = await S2.store(io).loadMine();
  assert.ok(r.ok, r.error);
  assert.deepEqual(S2.list().map((t) => t.source + ':' + t.id), ['mine:mine-1']);
  assert.ok(S2.has({ id: 'mine-1', source: 'mine' }));
});
test('an unsafe template is never written, and an unreadable index is reported, not overwritten', async () => {
  const io = memIo();
  const r = await loadStationery().store(io).saveMine({ ...TPL, svg: svg('<script/>') });
  assert.equal(r.ok, false); assert.equal(io.writes.length, 0);
  const io2 = memIo({}, 'templates/index.json');
  const st = loadStationery().store(io2);
  assert.equal((await st.loadMine()).ok, false);
  assert.equal((await st.saveMine(TPL)).ok, false, 'no index rewrite over a file we could not read');
  assert.equal(io2.writes.length, 0);
});

// ── Opt-in, print wiring and delivery ──────────────────────────────────────────────────────
test('the picker group exists only when the host opts in AND the component is inlined', () => {
  assert.match(E, /const STN=\(opts\.stationery&&window\.PAStationery\)\|\|null;/);
  assert.match(E, /\(STN\?'<div class="pan-tplrow pan-strow"><span class="pan-tplgrp">信纸 · Stationery<\/span><div class="pst-list"><\/div><\/div>':''\)/);
  assert.match(E, /if\(STN\) stPick=STN\.picker\(q\('\.pst-list'\)/);
  const journal = APP_SRC['notes (live)'];
  assert.match(journal, /stationery:STN_HOST\|\|false,/, 'the Journal opts in');
  for (const [k, src] of Object.entries(APP_SRC)) if (!k.startsWith('notes (live)')) assert.doesNotMatch(src, /PA_STATIONERY_UI|stationery:/, `${k} does not`);
});
test('print primes the design and treats a stationery page as a full sheet', () => {
  assert.match(E, /if\(STN&&NB\.stationery\) await STN\.prime\(NB\.stationery,cap\);/);
  assert.match(E, /drawPaper\(ctx,hCss\/k,paper,null,W\/k\);/);
  assert.match(E, /extent:Math\.max\(pageExtent\(p\),STN&&STN\.has\(NB\.stationery\)\?PAGE_H\/W:0\),/);
});
test('delivery: only the Journal carries the component; designs ride with it; R4 budget', () => {
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  const files = [.../const PA_COMPONENTS = \[([\s\S]*?)\n\];/.exec(web)[1].matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(files.indexOf('stationery-ui.inline.html') >= 0
    && files.indexOf('stationery-ui.inline.html') < files.indexOf('stationery-designs.inline.html'), 'designs after their carrier');
  assert.equal(STN_HTML.split('<!--PA_STATIONERY_DESIGNS-->').length, 2, 'stationery-ui carries the designs marker once');
  assert.doesNotMatch(ENGINE, /<!--PA_STATIONERY_UI-->/, 'note-ui does not: the Bible pays nothing');
  assert.equal(APP_SRC['notes (live)'].split('<!--PA_STATIONERY_UI-->').length, 2, 'the Journal carries it once');
  assert.ok(STN_HTML.split('\n').length <= 300, 'the component stays inside the 300-line budget');
  // The sanitizer is its own file (R4), carried by stationery-ui ABOVE its script so it runs first.
  assert.ok(files.includes('stationery-sanitize.inline.html'), 'the sanitizer is delivered');
  assert.equal(STN_HTML.split('<!--PA_STATIONERY_SANITIZE-->').length, 2, 'stationery-ui carries the sanitizer marker once');
  assert.ok(STN_HTML.indexOf('<!--PA_STATIONERY_SANITIZE-->') < STN_HTML.indexOf('<script>'), '…above its own script');
  assert.ok(SAN_HTML.split('\n').length <= 300, 'the sanitizer stays inside the 300-line budget');
  // Its render-cost budget is its own file too (R4), carried by the sanitizer ABOVE its script so it runs
  // first, and listed after its carrier (web.mjs appends a carried component after the one that carries it).
  assert.ok(files.indexOf('stationery-sanitize.inline.html') < files.indexOf('stationery-cost.inline.html'), 'the budget is delivered, after its carrier');
  assert.equal(SAN_HTML.split('<!--PA_STATIONERY_COST-->').length, 2, 'the sanitizer carries the budget marker once');
  assert.ok(SAN_HTML.indexOf('<!--PA_STATIONERY_COST-->') < SAN_HTML.indexOf('<script>'), '…above its own script');
  assert.ok(COST_HTML.split('\n').length <= 300, 'the budget stays inside the 300-line budget');
  // ...and its geometry readers, carried by the budget the same way (R4)
  assert.ok(files.indexOf('stationery-cost.inline.html') < files.indexOf('stationery-geometry.inline.html'), 'the readers are delivered, after their carrier');
  assert.equal(COST_HTML.split('<!--PA_STATIONERY_GEOMETRY-->').length, 2, 'the budget carries the readers\' marker once');
  assert.ok(COST_HTML.indexOf('<!--PA_STATIONERY_GEOMETRY-->') < COST_HTML.indexOf('<script>'), '…above its own script');
  assert.ok(GEOM_HTML.split('\n').length <= 300, 'the readers stay inside the 300-line budget');
  // ...and simplify()'s steps, carried by the sanitizer after the budget they read (R4)
  assert.ok(files.indexOf('stationery-sanitize.inline.html') < files.indexOf('stationery-simplify.inline.html'), 'the steps are delivered, after their carrier');
  const at = (mk) => SAN_HTML.indexOf(mk); assert.equal(SAN_HTML.split('<!--PA_STATIONERY_SIMPLIFY-->').length, 2, 'the sanitizer carries the steps\' marker once');
  assert.ok(at('<!--PA_STATIONERY_COST-->') < at('<!--PA_STATIONERY_SIMPLIFY-->') && at('<!--PA_STATIONERY_SIMPLIFY-->') < at('<script>'), '…after the budget, above its own script');
  assert.ok(SIMP_HTML.split('\n').length <= 300, 'the steps stay inside the 300-line budget');
  assert.ok(withDesigns(loadStationery()).list().length >= 1, 'designs are bundled');
});
