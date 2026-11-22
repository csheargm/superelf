// PANote — THE BAR GUARD: in the drawing tools a resting palm on the title row or a bar cannot start
// a native pan / zoom / selection / callout, the bars' buttons still click, and a bar that overflows
// is scrolled by a manual finger drag with palm rejection.
//
// WHY: "the Pencil stops until re-grip" (finger drawing OFF). Measured with elementFromPoint in
// Chromium at 820x1180, 1180x820, 1024x1366 and 390x844, with the hosts' real options, in both
// mounts — Journal: fullscreen; Bible: fullscreen on a phone, PANote.panel in the PASplit bottom
// zone on every iPad. Inside PANote, besides the ink, a palm can land only on .pan-top (title row,
// with the docked tool row) and the bars (.pan-pages, page-nav bar; the tool row floating on a
// phone: 413px in 376px) — all touch-action:auto before this change. Outside PANote (not guarded
// here, see docs/plans/panote-palm-flip-pen-lockout.md): the Bible's reading column and PASplit
// header above the panel.
//
// Runs the SHIPPED routing through the shared harness (test/helpers-panote-routing.mjs). The bars
// are built here with the harness's own makeNode, as children of the pad exactly as the markup
// nests them (the tool row re-parented INTO the title row when docked), with a scrollLeft the
// browser's way: clamped to [0, scrollWidth - clientWidth]. Each scenario is a function of the
// harness options, so the same sequence runs plain and under the MUTATIONS at the bottom, each of
// which removes one guard from the APP'S OWN SOURCE (R14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, runPad, makeNode } from './helpers-panote-routing.mjs';

const DRAW_TOOLS = ['pen', 'marker', 'highlighter', 'erase', 'select'];
const PEN = { id: 2, pt: 'pen' };
// The shipped names, read — never restated (R3).
const [, BAR_GUARD_CLS, GUARDED_BARS] = ENGINE.match(/const BAR_GUARD_CLS='([^']+)', GUARDED_BARS='([^']+)';/);
const SLOP = Number(ENGINE.match(/const BAR_DRAG_SLOP=(\d+);/)[1]);

const scroller = (el, scrollWidth, clientWidth) => {
  let v = 0;
  Object.defineProperty(el, 'scrollLeft', { get: () => v, set: (x) => { v = Math.max(0, Math.min(scrollWidth - clientWidth, x)); } });
  return Object.assign(el, { scrollWidth, clientWidth });
};
function bars(pad) {
  const top = makeNode('div', pad.host, { className: 'pan-top' });
  const title = makeNode('div', top, { className: 'pan-htitle' });
  const tools = scroller(makeNode('div', top, { className: 'pan-bar pan-tools pan-docked' }), 401, 21);   // phone, docked: 401px in a 21px strip
  const toolBtn = makeNode('button', tools, { className: 'pan-tbtn pan-tool' });
  const pager = scroller(makeNode('div', pad.host, { className: 'pan-bar pan-pages' }), 206, 108);
  const grip = makeNode('button', pager, { className: 'pan-grip' });
  const next = makeNode('button', pager, { className: 'pan-tbtn pan-next' });
  return { top, title, tools, toolBtn, pager, grip, next };
}
const setup = (o = {}) => { const pad = runPad(o); return { pad, b: bars(pad) }; };
const guardOn = (pad) => pad.host.classList.contains(BAR_GUARD_CLS);
// A finger drag on `el`, `dx` px sideways in `steps` moves (x 700 → 700 + dx).
const fdrag = (pad, el, dx, { id = 30, steps = 4, end = 'up' } = {}) => {
  pad.down(el, { id, pt: 'touch', x: 700, y: 1150 });
  for (let i = 1; i <= steps; i++) pad.move(el, { id, pt: 'touch', x: 700 + (dx * i) / steps, y: 1150 });
  if (end) pad[end](el, { id, pt: 'touch', x: 700 + dx, y: 1150 });
};
const tStart = (pad, el) => { const t = [{ id: 40, x: 700, y: 1150 }]; return pad.touch(el, 'touchstart', { touches: t, changed: t }); };
const tMove = (pad, el) => { const t = [{ id: 40, x: 690, y: 1150 }]; return pad.touch(el, 'touchmove', { touches: t, changed: t }); };
const entries = (pad, type) => pad.pencilLog().events.filter((e) => e.type === type);

// ═══ 1. the class follows the tool, both ways ══════════════════════════════════════════════════
const classToggles = (o = {}) => {
  for (const tool of DRAW_TOOLS) assert.equal(guardOn(runPad({ tool, ...o })), true, `${tool} at mount: the bars are guarded`);
  const t = runPad({ tool: 'text', txtEdit: {}, ...o });
  assert.equal(guardOn(t), false, 'T at mount: not guarded');
  t.useTool('pen'); assert.equal(guardOn(t), true, 'T → pen: on');
  t.useTool('text'); assert.equal(guardOn(t), false, 'pen → T: off');
  t.useTool('select'); assert.equal(guardOn(t), true, 'T → select: on');
};
// ═══ 2. the stylesheet carries the rule for every guarded bar (and everything inside it) ════════
const cssCovers = (src) => {
  const css = src.slice(src.indexOf('<style id="pan-style">'), src.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sels: sel.split(',').map((s) => s.trim()), body }));
  for (const m of GUARDED_BARS.split(',')) {
    for (const sel of [`.${BAR_GUARD_CLS} ${m}`, `.${BAR_GUARD_CLS} ${m} *`]) {
      const r = rules.find((x) => x.sels.includes(sel));
      assert.ok(r, `a stylesheet rule targets ${sel}`);
      for (const d of [/touch-action:none/, /(^|;)\s*user-select:none/, /-webkit-user-select:none/, /-webkit-touch-callout:none/]) {
        assert.match(r.body, d, `${sel} carries ${d.source}`);
      }
    }
  }
};
// ═══ 3. no prevention on a bar: its buttons keep their click ═══════════════════════════════════
const barsNotPrevented = (o = {}) => {
  const { pad, b } = setup(o);
  // R14 control: the harness CAN see a prevention — the ink's own guard prevents the same touch.
  assert.equal(tStart(pad, pad.ink).defaultPrevented, true, 'control: a touchstart on the ink is prevented');
  for (const el of [b.top, b.title, b.tools, b.toolBtn, b.pager, b.next, b.grip]) {
    assert.equal(tStart(pad, el).defaultPrevented, false, `${el.className}: touchstart not prevented (iOS would drop the click)`);
    assert.equal(tMove(pad, el).defaultPrevented, false, `${el.className}: touchmove not prevented`);
  }
  for (const el of [b.next, b.toolBtn]) {
    const d = pad.down(el, { id: 31, pt: 'touch', x: 700, y: 1150 }); const u = pad.up(el, { id: 31, pt: 'touch', x: 700, y: 1150 });
    assert.deepEqual([d.defaultPrevented, u.defaultPrevented, d._stopCalls, u._stopCalls], [false, false, 0, 0], `${el.className}: a tap's pointer events pass untouched`);
  }
  // Every touch listener the routing puts on the PAD (where bar touches bubble) is passive: it cannot prevent.
  for (const l of pad.host._listeners('touchstart').concat(pad.host._listeners('touchmove'))) {
    if (l.opt && l.opt.capture && l.opt.passive) continue;   // the recorder
    assert.equal(!!(l.opt && l.opt.passive), true, 'a touch listener on the pad is passive');
  }
};
// ═══ 4. manual sideways drag of an overflowing bar; a tap stays a tap ═════════════════════════
const manualDrag = (o = {}) => {
  const { pad, b } = setup(o);
  fdrag(pad, b.next, -80);
  assert.equal(b.pager.scrollLeft, 80, 'an 80px finger drag on the page-nav bar scrolls it 80px');
  assert.ok(b.pager.captured.includes(30), 'past the slop the bar captures the finger (moves keep coming off the bar)');
  fdrag(pad, b.next, -10, { id: 36, steps: 1 });
  assert.equal(b.pager.scrollLeft, 90, 'a second drag continues from where the bar already is (not from 0)');
  fdrag(pad, b.next, -40, { id: 37, end: null });
  pad.move(b.next, { id: 37, pt: 'touch', x: 700 - (SLOP - 4), y: 1150 });
  pad.up(b.next, { id: 37, pt: 'touch', x: 700 - (SLOP - 4), y: 1150 });
  assert.equal(b.pager.scrollLeft, 90 + SLOP - 4, 'once dragging, coming back inside the slop still tracks the finger');
  fdrag(pad, b.next, -200, { id: 32 });
  assert.equal(b.pager.scrollLeft, 98, 'clamped at its end (206 - 108)');
  fdrag(pad, b.toolBtn, -120, { id: 33 });
  assert.equal(b.tools.scrollLeft, 120, 'the tool row docked IN the title row scrolls itself (delegated from the pad)');
  b.pager.scrollLeft = 0;
  fdrag(pad, b.next, -(SLOP - 1), { id: 34, steps: 1 });
  assert.equal(b.pager.scrollLeft, 0, `a wobble under ${SLOP}px is a tap: nothing scrolls`);
  assert.ok(!b.pager.captured.includes(34), 'and nothing captured the pointer away from the button');
  fdrag(pad, b.next, -SLOP, { id: 35, steps: 1 });
  assert.equal(b.pager.scrollLeft, SLOP, `control: exactly ${SLOP}px is a drag`);
};
// Only a finger drags a bar: a Pencil (or a mouse) on a bar button is a tap or a stroke, never a scroll.
const onlyAFingerDrags = (o = {}) => {
  for (const pt of ['pen', 'mouse']) {
    const { pad, b } = setup(o);
    pad.down(b.next, { id: 3, pt, x: 700, y: 1150 });
    pad.move(b.next, { id: 3, pt, x: 680, y: 1150 });
    pad.up(b.next, { id: 3, pt, x: 680, y: 1150 });
    assert.equal(b.pager.scrollLeft, 0, `a ${pt} moving 20px on a bar button scrolls nothing`);
    pad.at(5000); fdrag(pad, b.next, -20, { id: 38 });
    assert.equal(b.pager.scrollLeft, 20, `control: a finger after the ${pt} does`);
  }
};
const gripMovesNotScrolls = (o = {}) => {
  const { pad, b } = setup(o);
  fdrag(pad, b.grip, -80);
  assert.equal(b.pager.scrollLeft, 0, 'a drag on the grip is makeMovable\'s (it moves the bar), not a scroll');
};
const endedByUpOrCancel = (o = {}) => {
  for (const end of ['up', 'cancel']) {
    const { pad, b } = setup(o);
    fdrag(pad, b.next, -40, { end });
    pad.move(b.next, { id: 30, pt: 'touch', x: 600, y: 1150 });   // a stray move with the ended id
    assert.equal(b.pager.scrollLeft, 40, `pointer${end} ends the drag: a later move scrolls nothing`);
  }
};
// ═══ 5. palm rejection: the pen owns the surface ══════════════════════════════════════════════
const palmWithPen = (o = {}) => {
  const { pad, b } = setup(o);
  pad.down(pad.ink, { ...PEN, x: 300, y: 400 });
  fdrag(pad, b.next, -80, { id: 41 });
  assert.equal(b.pager.scrollLeft, 0, 'a palm on the page-nav bar while the nib is down scrolls nothing');
  for (let i = 1; i <= 3; i++) pad.move(pad.ink, { ...PEN, x: 300 + 10 * i, y: 400 });
  pad.up(pad.ink, { ...PEN, x: 330, y: 400 });
  pad.at(50); fdrag(pad, b.next, -80, { id: 42 });
  assert.equal(b.pager.scrollLeft, 0, 'nor inside the grace window after the lift (penNear)');
  assert.equal(pad.calls.committed, 1, 'the Pencil stroke is one untouched stroke');
  pad.at(5000); fdrag(pad, b.next, -80, { id: 43 });
  assert.equal(b.pager.scrollLeft, 80, 'control: the same drag with no pen near scrolls');
};
const penLandsMidDrag = (o = {}) => {
  const { pad, b } = setup(o);
  fdrag(pad, b.next, -40, { id: 44, end: null });
  assert.equal(b.pager.scrollLeft, 40, 'precondition: the palm drag really scrolled');
  pad.down(pad.ink, { ...PEN, x: 300, y: 400 });
  pad.move(b.next, { id: 44, pt: 'touch', x: 600, y: 1150 });
  pad.up(pad.ink, { ...PEN, x: 300, y: 400 }); pad.at(5000);
  pad.move(b.next, { id: 44, pt: 'touch', x: 560, y: 1150 });
  assert.equal(b.pager.scrollLeft, 40, 'the nib landing ends the palm\'s drag for good');
};
// ═══ 6. the recorder says the palm was on a guarded bar ═══════════════════════════════════════
const recorderLogs = (o = {}) => {
  const { pad, b } = setup(o);
  tStart(pad, b.next); tStart(pad, b.title); tStart(pad, pad.ink);
  const [n, t, i] = entries(pad, 'touchstart');
  assert.deepEqual([n.tg, n.d], ['pan-tbtn', 'bar-guard'], 'a touch on a page-nav button: bar-guard, its class as tg');
  assert.deepEqual([t.tg, t.d], ['pan-htitle', 'bar-guard'], 'on the title row: bar-guard');
  assert.equal(i.d, undefined, 'on the ink: not a bar');
  pad.down(pad.ink, { ...PEN, x: 300, y: 400 });
  pad.down(b.next, { id: 45, pt: 'touch', x: 700, y: 1150 });
  pad.up(pad.ink, { ...PEN, x: 300, y: 400 }); pad.at(5000);
  fdrag(pad, b.next, -40, { id: 46, steps: 1 });
  const downs = entries(pad, 'pointerdown').filter((e) => e.pt === 'touch').map((e) => e.d);
  assert.deepEqual(downs, ['bar-refused-pen', 'bar-armed']);
  assert.equal(entries(pad, 'pointermove').at(-1).d, 'bar-drag');
};
// ═══ 7. the T tool keeps today's behaviour exactly ═════════════════════════════════════════════
const textToolUntouched = (o = {}) => {
  const { pad, b } = setup({ tool: 'text', txtEdit: {}, ...o });
  assert.equal(guardOn(pad), false);
  for (const el of [b.next, b.title]) assert.equal(tStart(pad, el).defaultPrevented, false);
  fdrag(pad, b.next, -80);
  assert.equal(b.pager.scrollLeft, 0, 'T tool: no manual drag (the bar scrolls natively there)');
  assert.deepEqual(entries(pad, 'touchstart').map((e) => e.d), [undefined, undefined], 'T tool: nothing logged as guarded');
};
// A matching class ABOVE the pad (the shell) is not one of the pad's bars.
const shellWrapperIgnored = (o = {}) => {
  const { pad } = setup(o);
  const wrap = scroller(makeNode('div', pad.doc, { className: 'pan-bar' }), 900, 300);
  pad.host.parent = wrap;
  pad.at(5000); fdrag(pad, pad.ink, -80, { id: 47 });
  assert.equal(wrap.scrollLeft, 0, 'a finger on the ink does not drag a .pan-bar wrapper around the pad');
  assert.equal(tStart(pad, pad.ink).defaultPrevented, true);
  assert.equal(entries(pad, 'touchstart').at(-1).d, undefined, 'nor is it logged as a bar touch');
};

test('the bar-guard class follows the tool: on in every drawing tool, off in T, both ways', () => classToggles());
test('the stylesheet carries touch-action / user-select / callout none for every guarded bar and its contents', () => cssCovers(ENGINE));
test('bars and their buttons are never prevented — touchstart, touchmove, a tap\'s pointer events (control: the ink is)', () => barsNotPrevented());
test('an overflowing bar scrolls by a manual finger drag; a wobble under the slop stays a tap', () => manualDrag());
test('only a finger drags a bar: a pen or a mouse moving on a bar button scrolls nothing', () => onlyAFingerDrags());
test('the grip keeps its own drag: it does not scroll the bar', () => gripMovesNotScrolls());
test('a bar drag ends on pointerup and on pointercancel', () => endedByUpOrCancel());
test('palm on a bar while the pen is down, or inside the grace window, scrolls nothing (control: later it does)', () => palmWithPen());
test('a nib landing mid-drag ends the palm\'s bar drag', () => penLandsMidDrag());
test('recorder: d:"bar-guard" on a touch on a guarded bar; bar-armed / bar-refused-pen / bar-drag', () => recorderLogs());
test('T tool unchanged: no class, no prevention, no manual drag, nothing logged', () => textToolUntouched());
test('a .pan-bar class on the shell AROUND the pad is not a bar of the pad', () => shellWrapperIgnored());
test('source pins: the class is toggled by syncGuard, never an inline touch-action; the touchstart listener is passive', () => {
  assert.match(ENGINE, /function syncGuard\(\)\{[^}]*host\.classList\.toggle\(BAR_GUARD_CLS,!txtEdit\);/);
  assert.doesNotMatch(ENGINE, /touchAction|userSelect\s*=/, 'never an inline style');
  assert.match(ENGINE, /host\.addEventListener\('touchstart',e=>\{ if\(guardedBar\(e\.target\)\) pdec\('bar-guard',e\); \},\{passive:true\}\);/);
});

// ═══ MUTATIONS — each guard removed from the shipped source must turn its scenario red ══════════
const cut = (piece, by = '') => (src) => { assert.ok(src.includes(piece), `mutation target present: ${piece.slice(0, 60)}`); return src.split(piece).join(by); };
const red = (fn, mutate) => assert.throws(() => fn({ mutate }), (e) => {
  if (process.env.PA_SHOW_MUTATION) console.log('   red because:', e.message.split('\n')[0]);
  return e instanceof assert.AssertionError && !/mutation matched nothing|mutation target present/.test(e.message);
});
const M = {
  toggle: ' host.classList.toggle(BAR_GUARD_CLS,!txtEdit);',
  textTool: 'if(!host.classList.contains(BAR_GUARD_CLS)) return null;',
  inPad: 'return b&&host.contains(b)?b:null;',
  grip: '||bar.contains(e.target.closest(\'.pan-grip\'))',
  penNear: "if(penNear()){ barDrag=null; pdec('bar-refused-pen',e); return; }",
  penId: "if(penId!==null){ barDrag=null; pdec('bar-refused-pen',e); return; }   // the pen owns the surface CONTINUOUSLY",
  slop: 'if(Math.abs(dx)<BAR_DRAG_SLOP) return; ',
  left0: 'left0:bar.scrollLeft',
  touchOnly: "if(e.pointerType!=='touch') return;\n      const bar=guardedBar",
  capture: 'try{ barDrag.bar.setPointerCapture(e.pointerId); }catch(_){',
  moved: 'barDrag.moved=true;',
  log: "if(guardedBar(e.target)) pdec('bar-guard',e);",
  up: "host.addEventListener('pointerup',barEnd);",
  cancel: "host.addEventListener('pointercancel',barEnd);",
};
test('MUTATION class not toggled — no guard: no drag, no log', () => {
  const m = cut(M.toggle); red(classToggles, m); red(manualDrag, m); red(recorderLogs, m);
});
test('MUTATION CSS rule removed, or one declaration dropped — the stylesheet check goes red', () => {
  const rule = '.pan-barguard .pan-top,.pan-barguard .pan-top *,.pan-barguard .pan-bar,.pan-barguard .pan-bar *{';
  for (const m of [cut(rule, '.pan-nothing{'), cut('.pan-barguard .pan-bar *{', '{'), cut('touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}', 'touch-action:none}'),
    cut('.pan-barguard .pan-top,', ''), cut('touch-action:none;-webkit-user-select', '-webkit-user-select')]) {
    assert.throws(() => cssCovers(m(ENGINE)), assert.AssertionError);
  }
});
test('MUTATION T-tool exclusion removed — the T tool gets a manual drag and bar-guard entries', () => red(textToolUntouched, cut(M.textTool, '')));
test('MUTATION in-pad check removed — a .pan-bar shell wrapper is dragged by a finger on the ink', () => red(shellWrapperIgnored, cut(M.inPad, 'return b;')));
test('MUTATION grip exclusion removed — dragging the grip scrolls the bar', () => red(gripMovesNotScrolls, cut(M.grip)));
test('MUTATION penNear() at the start removed — a palm drags the bar under the pen', () => red(palmWithPen, cut(M.penNear)));
test('MUTATION pen re-check on move removed — the palm keeps dragging after the nib lands', () => red(penLandsMidDrag, cut(M.penId)));
test('MUTATION slop removed — a tap\'s wobble scrolls the bar', () => red(manualDrag, cut(M.slop)));
test('MUTATION a drag starts from 0 instead of the bar\'s scrollLeft — a second drag jumps back', () => red(manualDrag, cut(M.left0, 'left0:0')));
test('MUTATION the touch-only gate removed — a pen or mouse on a bar button scrolls the bar', () => red(onlyAFingerDrags, cut(M.touchOnly, 'const bar=guardedBar')));
test('MUTATION setPointerCapture removed — the drag loses the finger once it leaves the bar', () => red(manualDrag, cut(M.capture, 'try{ void 0; }catch(_){')));
test('MUTATION moved flag never set — returning inside the slop freezes the drag', () => red(manualDrag, cut(M.moved)));
test('MUTATION bar-guard not logged — the log cannot say the palm was on a guarded bar', () => red(recorderLogs, cut(M.log, 'if(guardedBar(e.target)) void 0;')));
test('MUTATION pointerup / pointercancel not wired — a stale drag outlives the contact', () => { red(endedByUpOrCancel, cut(M.up)); red(endedByUpOrCancel, cut(M.cancel)); });
test('MUTATION a preventDefault added to the bar touchstart — buttons would lose their click on iOS', () => {
  red(barsNotPrevented, cut("if(guardedBar(e.target)) pdec('bar-guard',e); },{passive:true});", "if(guardedBar(e.target)){ pdec('bar-guard',e); e.preventDefault(); } },{passive:false});"));
});
