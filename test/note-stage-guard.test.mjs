// PANote — THE WRITING-AREA GUARD: the ink's touch guard extended to the whole stage in the drawing
// tools, and finger scrolling from the margins through the SAME manual path as on the ink.
//
// A DEFENSIVE fix (owner-approved) for "the Pencil stops until re-grip". In today's layout the page
// covers the stage, so no real touch lands on the stage, page box or gutters in the drawing tools
// (elementFromPoint, 3 viewports: 0 hits); these tests dispatch there directly to pin the wiring.
// Runs the SHIPPED routing through the shared harness (test/helpers-panote-routing.mjs: the block
// is extracted and dispatched for real, with the pad's real nesting — ink, text layer and gutters
// INSIDE the stage, bars and popovers its siblings — and a real closest()).
//
// Each scenario is a function of the harness options, so the same sequence runs plain and under
// the mutations at the bottom, each of which removes one guard from the APP'S OWN SOURCE (R14:
// every repro has a control, and a mutation that matched nothing is refused by runPad).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, ROOT, runPad, makeNode, swipe } from './helpers-panote-routing.mjs';

const DRAW_TOOLS = ['pen', 'marker', 'highlighter', 'erase', 'select'];
const PEN = { id: 2, pt: 'pen' };
const GUARDED = 'pan-guarded';
const fingers = (n, y = 300) => Array.from({ length: n }, (_, i) => ({ id: 20 + i, x: 30 + 40 * i, y }));
const tStart = (pad, el, n = 1) => { const t = fingers(n); return pad.touch(el, 'touchstart', { touches: t, changed: t }); };
const tMove = (pad, el, n = 1) => { const t = fingers(n, 340); return pad.touch(el, 'touchmove', { touches: t, changed: t }); };
const prevented = (pad, el, n = 1) => [tStart(pad, el, n).defaultPrevented, tMove(pad, el, n).defaultPrevented];
// A vertical finger drag: 40px to arm the scroll, then 200px of scrolling (600 → 360).
const drag = (pad, el, id = 5) => {
  pad.down(el, { id, pt: 'touch', x: 300, y: 600 });
  for (const y of [560, 500, 430, 360]) pad.move(el, { id, pt: 'touch', x: 300, y });
  pad.up(el, { id, pt: 'touch', x: 300, y: 360 });
};
const decisions = (pad, type) => pad.pencilLog().events.filter((e) => e.type === type);
const GUARD_EXEMPT = ENGINE.match(/const GUARD_EXEMPT='([^']+)'/)[1];   // the shipped selector, read — never restated (R3)

// ═══ 1. the guard covers the writing area in every drawing tool ══════════════════════════════
const drawingAreaPrevented = (o = {}) => {
  for (const tool of DRAW_TOOLS) {
    const pad = runPad({ tool, ...o });
    for (const el of [pad.stage, pad.pageInner, pad.gutterL, pad.gutterR, pad.ink]) {
      assert.deepEqual(prevented(pad, el), [true, true], `${tool}: touchstart/touchmove on ${el.className} is prevented`);
    }
  }
};
// ═══ 2. …but never a control ═════════════════════════════════════════════════════════════════
const controlsNotPrevented = (o = {}) => {
  const pad = runPad(o);
  // The real bars and popovers are the stage's SIBLINGS: structurally out of reach.
  for (const el of [pad.toolBtn, pad.toolbar, pad.pop, pad.popInput, pad.sendLogBtn]) {
    assert.deepEqual(prevented(pad, el), [false, false], `${el.className}: a control keeps its native touch`);
  }
  // Defence in depth — a control that ever lands IN the writing area is exempt by the selector.
  const inCls = (c) => makeNode('span', makeNode('div', pad.stage, { className: c }));   // a child of a classed control
  const exempt = [
    makeNode('button', pad.stage), makeNode('input', pad.pageInner), makeNode('select', pad.stage), makeNode('textarea', pad.stage),
    makeNode('a', pad.pageInner, { attrs: { href: '#x' } }), makeNode('div', pad.stage, { attrs: { role: 'button' } }),
    makeNode('div', pad.pageInner, { attrs: { contenteditable: 'true' } }), ...['pan-pop', 'pan-bar', 'pan-hlpop', 'pan-fmt', 'pan-top'].map(inCls),
  ];
  for (const el of exempt) assert.deepEqual(prevented(pad, el), [false, false], `${el.nodeName} ${JSON.stringify(el.attrs)} in the stage is exempt`);
  // Every member of the SHIPPED selector is exercised above — one added to GUARD_EXEMPT without a node here fails.
  for (const m of GUARD_EXEMPT.split(',')) assert.ok(exempt.some((el) => el.closest(m)), `GUARD_EXEMPT member ${m} has a node in this test`);
  // R14 control: the exemption is the selector, not "anything added" — these are not controls.
  for (const el of [makeNode('a', pad.pageInner), makeNode('div', pad.pageInner, { attrs: { contenteditable: 'false' } }), makeNode('div', pad.stage)]) {
    assert.deepEqual(prevented(pad, el), [true, true], `${el.nodeName} ${JSON.stringify(el.attrs)} is NOT a control`);
  }
};
// A selector match ABOVE the stage (the shell around the pad) must not switch the guard off.
const shellWrapperIgnored = (o = {}) => {
  const pad = runPad(o);
  pad.host.setAttribute('role', 'button');
  assert.deepEqual(prevented(pad, pad.stage), [true, true], 'a [role=button] wrapper around the pad exempts nothing');
};
// ═══ 3. the T tool keeps native text behaviour ═══════════════════════════════════════════════
const textToolNative = (o = {}) => {
  const pad = runPad({ tool: 'text', txtEdit: {}, ...o });
  pad.textLayer.setAttribute('contenteditable', 'true');
  assert.equal(pad.stage.classList.contains(GUARDED), false, 'no touch-action:none on the stage in the T tool');
  for (const el of [pad.stage, pad.pageInner, pad.textLayer]) {
    assert.deepEqual(prevented(pad, el), [false, false], `T tool: ${el.className} keeps native caret/selection/scroll`);
  }
  assert.deepEqual(prevented(pad, pad.stage, 2), [false, false], 'T tool: two fingers on the stage are native too');
  drag(pad, pad.stage);
  assert.equal(pad.stage.scrollTop, 0, 'T tool: the manual margin path is not armed (the stage scrolls natively there)');
};
// ═══ 4. margin scrolling, through the ink's own scroll path ══════════════════════════════════
const marginScrolls = (o = {}) => {
  const ink = runPad(o); drag(ink, ink.ink);
  assert.equal(ink.stage.scrollTop, 200, 'control: a finger drag on the ink scrolls 200px');
  for (const v of [{}, { tool: 'select' }, { tool: 'erase' }, { fingerDraw: true }]) {
    const pad = runPad({ ...v, ...o });
    drag(pad, pad.stage);
    assert.equal(pad.stage.scrollTop, 200, `${JSON.stringify(v)}: the same drag in the margin scrolls exactly as much`);
  }
};
const marginNeverFlips = (o = {}) => {
  const ink = runPad({ noFlip: false, ...o }); swipe(ink, ink.ink);
  assert.equal(ink.calls.begin.length, 1, 'control: with flipping ON a swipe on the ink still flips (unchanged)');
  const pad = runPad({ noFlip: false, ...o }); swipe(pad, pad.stage);
  assert.equal(pad.calls.begin.length, 0, 'a horizontal swipe in the margin never turns the page');
  assert.equal(pad.S.cur, 1);
};
// A palm in the margin before the nib: its scroll stops when the nib lands (the B fix, shared code).
const marginPalmBeforeNib = (o = {}) => {
  const pad = runPad(o);
  pad.stage.scrollTop = 200;
  pad.down(pad.stage, { id: 11, pt: 'touch', x: 20, y: 700, w: 90, h: 110 });
  pad.at(40); pad.move(pad.stage, { id: 11, pt: 'touch', x: 22, y: 676, w: 90, h: 110 });
  pad.at(16); pad.move(pad.stage, { id: 11, pt: 'touch', x: 23, y: 670, w: 90, h: 110 });
  const beforePen = pad.stage.scrollTop;
  assert.ok(beforePen > 200, `precondition: the margin drag really scrolled (${beforePen})`);
  pad.at(60); pad.down(pad.ink, { ...PEN, x: 300, y: 400 });
  for (let i = 1; i <= 5; i++) {
    pad.at(16); pad.move(pad.ink, { ...PEN, x: 300 + 10 * i, y: 400 });
    pad.move(pad.stage, { id: 11, pt: 'touch', x: 23, y: 670 - 8 * i, w: 90, h: 110 });
  }
  assert.equal(pad.stage.scrollTop, beforePen, 'the margin palm does not scroll the page under the Pencil');
  pad.down(pad.stage, { id: 12, pt: 'touch', x: 20, y: 500 });                  // a second palm lands while the pen is down
  for (const y of [470, 430, 390]) pad.move(pad.stage, { id: 12, pt: 'touch', x: 20, y });
  assert.equal(pad.stage.scrollTop, beforePen, 'nor does one that lands while the pen is down');
  pad.up(pad.ink, { ...PEN, x: 350, y: 400 });
  pad.at(50); drag(pad, pad.stage, 13);                                          // inside PEN_GRACE_MS: still the palm
  assert.equal(pad.stage.scrollTop, beforePen, 'nor one inside the grace window after the lift (penNear)');
  assert.equal(pad.calls.committed, 1, 'the Pencil stroke is one untouched stroke');
};
// ═══ 5. the recorder says when the guard acted ═══════════════════════════════════════════════
const recorderLogs = (o = {}) => {
  const pad = runPad(o);
  tStart(pad, pad.stage); tStart(pad, pad.pageInner); tStart(pad, pad.ink);
  const [m, p, i] = decisions(pad, 'touchstart');
  assert.deepEqual([m.tg, m.d], ['stage', 'guard-prevent'], 'a margin touch: guard-prevent on tg "stage"');
  assert.deepEqual([p.tg, p.d], ['pan-pageInner', 'guard-prevent'], 'a page-box touch names its class');
  assert.equal(i.tg, 'ink'); assert.equal(i.d, undefined, 'the ink is the old guard — not logged as a new prevention');
  const txt = runPad({ tool: 'text', txtEdit: {}, ...o }); tStart(txt, txt.stage);
  assert.equal(decisions(txt, 'touchstart')[0].d, undefined, 'T tool: nothing prevented, nothing logged');
};
// ═══ 6. the wiring: every margin gesture is ended, each own-route surface is routed once ═════════
const marginEnded = (o = {}) => {
  for (const end of ['up', 'cancel', null]) {                                   // null = never ended: the R14 control
    const pad = runPad(o);
    pad.down(pad.stage, { id: 5, pt: 'touch', x: 300, y: 600 });
    for (const y of [560, 500]) pad.move(pad.stage, { id: 5, pt: 'touch', x: 300, y });
    assert.ok(pad.stage.scrollTop > 0, 'precondition: the margin drag really scrolled');
    if (end) pad[end](pad.stage, { id: 5, pt: 'touch', x: 300, y: 500 });
    pad.at(5000); pad.down(pad.ink, { ...PEN, x: 300, y: 300 });
    const penDown = decisions(pad, 'pointerdown').at(-1);
    assert.equal(/scroll-dropped-pen/.test(penDown.d || ''), !end, `pointer${end}: the pen ${end ? 'finds no stale scroll' : 'drops the live one'}`);
  }
};
const routedOnce = (o = {}) => {
  const runs = [['ink', {}], ['textLayer', { tool: 'text', txtEdit: {} }]];
  for (const [k, v] of runs) {
    const pad = runPad({ ...v, ...o }); drag(pad, pad[k]);
    assert.deepEqual(decisions(pad, 'pointermove').map((e) => e.d), ['to-scroll', 'scroll', 'scroll', 'scroll'], `${k}: one decision per move, not two`);
  }
  for (const g of ['gutterL', 'gutterR']) {                                     // gutters are live in the T tool only
    const pad = runPad({ tool: 'text', txtEdit: {}, noFlip: false, ...o });
    swipe(pad, pad[g], g === 'gutterL' ? { from: 200, to: 600 } : {});
    assert.equal(pad.calls.update.length, 4, `${g}: the flip follows each of the 4 moves once`);
  }
};
const marginLogged = (o = {}) => {
  const pad = runPad(o);
  pad.down(pad.stage, { id: 5, pt: 'touch', x: 20, y: 600 }); pad.up(pad.stage, { id: 5, pt: 'touch', x: 20, y: 600 });
  pad.at(5000); pad.down(pad.ink, { ...PEN, x: 300, y: 300 });
  pad.down(pad.stage, { id: 6, pt: 'touch', x: 20, y: 600 });
  assert.deepEqual(decisions(pad, 'pointerdown').filter((e) => e.pt === 'touch').map((e) => e.d), ['margin-armed', 'margin-refused']);
};

test('drawing tools: a touch starting on the margin, page box, gutters or ink is prevented (start and move)', () => drawingAreaPrevented());
test('controls keep native touch: toolbar, its button, the popover and its input; and any control placed in the stage', () => controlsNotPrevented());
test('a selector match on the shell AROUND the pad does not exempt the writing area', () => shellWrapperIgnored());
test('T tool: no prevention anywhere in the stage (caret, selection, native scroll, two fingers)', () => textToolNative());
test('a vertical finger drag in the margin scrolls exactly like one on the ink — pen, select, eraser, finger-draw', () => marginScrolls());
test('a horizontal margin swipe never flips; the ink swipe still does with flipping on (control)', () => marginNeverFlips());
test('palm in the margin before the nib: no scrolling under the pen, nor inside the grace window', () => marginPalmBeforeNib());
test('recorder: d:"guard-prevent" on a margin/page-box touchstart, with its target class; not on ink, not in T', () => recorderLogs());
test('a margin drag ended by pointerup or pointercancel leaves no scroll for a later pen to drop (control: one never ended does)', () => marginEnded());
test('ink, text layer and gutters are routed once per move — the stage does not handle their bubbled moves again', () => routedOnce());
test('recorder: d:"margin-armed" on a margin pointerdown, d:"margin-refused" on one while the pen is down', () => marginLogged());

test('a plain Pencil stroke is unchanged: capture, ink, one commit; a pen in the margin arms nothing', () => {
  const pad = runPad();
  const t = [{ id: 2, x: 100, y: 100, tt: 'stylus' }];
  assert.equal(pad.touch(pad.ink, 'touchstart', { touches: t, changed: t }).defaultPrevented, true, 'the ink guard, as before');
  pad.down(pad.ink, { ...PEN, x: 100, y: 100 });
  assert.deepEqual(pad.ink.captured, [2]);
  pad.move(pad.ink, { ...PEN, x: 140, y: 160 }); pad.move(pad.ink, { ...PEN, x: 180, y: 220 });
  pad.up(pad.ink, { ...PEN, x: 180, y: 220 });
  assert.equal(pad.calls.extendStroke, 2); assert.equal(pad.calls.committed, 1);
  assert.equal(pad.S.penId, null); assert.deepEqual(pad.ink.captured, []);
  pad.at(5000);
  pad.down(pad.stage, { id: 7, pt: 'pen', x: 10, y: 600 });
  pad.move(pad.stage, { id: 7, pt: 'pen', x: 10, y: 400 });
  pad.up(pad.stage, { id: 7, pt: 'pen', x: 10, y: 400 });
  assert.equal(pad.stage.scrollTop, 0, 'a pen in the margin does not scroll');
  assert.equal(pad.calls.startStroke, 1, 'nor draw');
});

test('switching tools toggles the class both ways, and the guard follows it', () => {
  const pad = runPad();
  const on = () => pad.stage.classList.contains(GUARDED);
  assert.equal(on(), true, 'pen at mount: guarded');
  pad.useTool('text');
  assert.equal(on(), false); assert.deepEqual(prevented(pad, pad.stage), [false, false]);
  pad.useTool('pen');
  assert.equal(on(), true); assert.deepEqual(prevented(pad, pad.stage), [true, true]);
  pad.useTool('select');
  assert.equal(on(), true);
});

test('source pins: enter/exitTextMode call syncGuard after txtEdit changes; the class carries touch-action:none in CSS, never inline', () => {
  const body = (name) => { const m = ENGINE.match(new RegExp(`function ${name}\\(\\w*\\)\\{[\\s\\S]*?\\n    \\}`)); assert.ok(m, name); return m[0]; };
  for (const [fn, set] of [['enterTextMode', 'txtEdit={el:textLayer};'], ['exitTextMode', 'txtEdit=null;']]) {
    const b = body(fn);
    assert.ok(b.indexOf(set) >= 0 && b.indexOf('syncGuard();') > b.indexOf(set), `${fn} calls syncGuard() after ${set}`);
  }
  assert.match(ENGINE, /\.pan-stage\.pan-guarded\{touch-action:none\}/);
  assert.doesNotMatch(ENGINE, /touchAction/, 'touch-action is never written as an inline style');
});

test('two fingers: prevented in the drawing tools (no pinch to protect); item 3 of the brief, pinned', () => {
  const pad = runPad();
  assert.deepEqual(prevented(pad, pad.stage, 2), [true, true], 'a palm + finger pinch in the margin is refused');
  assert.deepEqual(prevented(pad, pad.ink, 2), [true, true], 'as it already was on the ink');
  // Nothing relies on a native pinch: no gesture listeners in PANote, and the shell forbids zoom.
  assert.doesNotMatch(ENGINE, /gesture(start|change|end)/);
  const shell = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(shell, /<meta name="viewport" content="[^"]*maximum-scale=1/);
});

// ═══ MUTATIONS — each guard removed from the shipped source must turn its scenario red ══════════
const cut = (piece, by = '') => (src) => src.split(piece).join(by);
// Red for the RIGHT reason: an AssertionError from the scenario, never runPad's own "the mutation
// matched nothing" (also an AssertionError — accepting it would pass a mutation that changed nothing).
const red = (fn, mutate) => assert.throws(() => fn({ mutate }), (e) => {
  if (process.env.PA_SHOW_MUTATION) console.log('   red because:', e.message.split('\n')[0]);
  return e instanceof assert.AssertionError && !/mutation matched nothing/.test(e.message);
});
const G = {
  exempt: 'if(c&&stage.contains(c)) return;',
  textTool: 'if(!stage.classList.contains(GUARDED_CLS)) return;       // T tool: native text behaviour',
  toggle: 'function syncGuard(){ stage.classList.toggle(GUARDED_CLS,!txtEdit); host.classList.toggle(BAR_GUARD_CLS,!txtEdit); }',
  marginDown: "stage.addEventListener('pointerdown',e=>{ if(!marginTouch(e)||!stage.classList.contains(GUARDED_CLS)) return;",
  ownRoute: 'const marginTouch=e=>e.pointerType===\'touch\'&&!ownRoute(e.target);',
  noFlip: 'flipTouch.canFlip=false; ',
  log: "if(e.type==='touchstart'&&t!==ink) pdec('guard-prevent',e);",
};
test('MUTATION selector exclusion removed — a control in the writing area loses its tap', () => red(controlsNotPrevented, cut(G.exempt)));
test('MUTATION exemption without the stage check — a matching shell wrapper switches the guard off', () => red(shellWrapperIgnored, cut(G.exempt, 'if(c) return;')));
test('MUTATION text-tool exclusion removed — the T tool loses native touch on the stage', () => red(textToolNative, cut(G.textTool)));
test('MUTATION class not toggled — no guard in the drawing tools, no margin scroll', () => {
  const m = cut(G.toggle, 'function syncGuard(){}');
  red(drawingAreaPrevented, m);
  red(marginScrolls, m);
});
test('MUTATION margin scroll not wired — a margin drag scrolls nothing', () => {
  red(marginScrolls, cut(G.marginDown, "stage.addEventListener('pointerdown',e=>{ return;"));
});
test('MUTATION own-route exclusion removed — an ink swipe is re-armed by the stage and stops flipping', () => {
  red(marginNeverFlips, cut(G.ownRoute, "const marginTouch=e=>e.pointerType==='touch';"));
});
test('MUTATION canFlip not cleared — a margin swipe turns the page', () => red(marginNeverFlips, cut(G.noFlip)));
test('MUTATION recorder decision removed — the log cannot say the guard acted', () => red(recorderLogs, cut(G.log, '')));
const W = {
  up: "stage.addEventListener('pointerup',e=>{ if(marginTouch(e)) fingerFlipEnd(e); });",
  cancel: "stage.addEventListener('pointercancel',e=>{ if(marginTouch(e)) fingerFlipEnd(e); });",
  move: "stage.addEventListener('pointermove',e=>{ if(marginTouch(e)) fingerFlipMove(e); }",
};
test('MUTATION stage pointerup / pointercancel not wired — a stale scroll outlives the drag', () => { red(marginEnded, cut(W.up)); red(marginEnded, cut(W.cancel)); });
test('MUTATION stage pointermove without marginTouch — every ink/text move is handled twice', () => red(routedOnce, cut(W.move, "stage.addEventListener('pointermove',e=>{ fingerFlipMove(e); }")));
test('MUTATION own-route exclusion drops the text layer, or the gutters — their moves are handled twice', () => {
  red(routedOnce, cut('||textLayer.contains(t)')); red(routedOnce, cut('||gutterL.contains(t)||gutterR.contains(t)'));
});
test('MUTATION margin-armed / margin-refused not logged — the log cannot say what a margin touch did', () => {
  red(marginLogged, cut(" pdec('margin-armed',e);")); red(marginLogged, cut("else pdec('margin-refused',e);"));
});
test('MUTATION a GUARD_EXEMPT member dropped (.pan-hlpop, .pan-fmt, .pan-top) — a control there loses its tap', () => {
  for (const m of [',.pan-hlpop', ',.pan-fmt', ',.pan-top']) red(controlsNotPrevented, cut(m));
});
test('MUTATION stage touch listeners passive — the browser ignores their preventDefault', () => {
  for (const t of ['touchstart', 'touchmove']) red(drawingAreaPrevented, cut(`stage.addEventListener('${t}',guardTouch,{passive:false});`, `stage.addEventListener('${t}',guardTouch,{passive:true});`));
});
