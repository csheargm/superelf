// DEFECT — THE FLOATING COMPOSER COVERED THE LAST MESSAGE'S ACTION ICONS ON IPHONE.
//
// WHAT WAS PROVEN BROKEN (screenshot from a real iPhone)
//   `.pac-log` keeps room for the floating composer with `padding-bottom: var(--pac-pill, 84px)`.
//   `--pac-pill` was only ever written by a ResizeObserver callback that DROPPED a zero-height
//   reading (`if(h)`), and nothing re-measured afterwards — so on any surface that was not laid
//   out at mount (PAChat.fullscreen() builds its overlay display:none) the flat 84px fallback
//   stood for the whole session. On a 390x844 iPhone the composer is ~127px tall — pills, gap,
//   composer, padding, and the home-indicator inset the 84 never counted — so the last message's
//   ✎/⧉ icons sat ~42px UNDERNEATH the model pill.
//
// THE GEOMETRY, REDUCED HONESTLY
//   `.pac-row` is position:absolute;bottom:0 inside `.pac`; `.pac-log` is the flex:1 sibling, so
//   the log's border-box bottom IS the row's bottom edge. The log's last child can reach at most
//   its content-box bottom, which sits `padding-bottom` above that. So the clearance between the
//   last `.pac-acts` row and `.pac-row`'s TOP edge is exactly
//       --pac-pill  −  height(.pac-row)
//   and "the icons are not covered" is exactly `--pac-pill >= rowHeight`. No layout engine is
//   needed for that reduction; the two quantities are what this harness computes.
//
// WHAT IS REAL HERE AND WHAT IS MODELLED (R14 — the fidelity boundary is stated, not hidden)
//   REAL, extracted from web/chat-ui.inline.html and executed: the PA_PILL_RESERVE measurement
//   engine (setPill, its retry, its ResizeObserver/visualViewport wiring) and the fullscreen()
//   factory's show() wiring. Every CSS number — paddings, gaps, borders, control heights, font
//   sizes, line-heights, the fallback itself — is PARSED OUT OF THE SHIPPED STYLESHEET, never
//   restated here, so retuning the CSS retunes the harness.
//   MODELLED: there is no layout engine in node. Leaf control heights are composed from their own
//   declared box (height / padding / border / font-size × line-height) and the column is summed by
//   the flex-column rule (children + gaps + padding). Text wrapping is not modelled — the 3-line
//   composer state supplies its line count explicitly. CSS `line-height:normal` has no numeric
//   value in a stylesheet, so LINE_NORMAL below is the ONE number this file invents; the fidelity
//   control immediately cross-checks the whole composed model against the height the real iPhone
//   showed, and fails if the model has drifted from the device.
//   Also modelled, deliberately: WebKit does not reliably deliver a ResizeObserver callback when
//   an ANCESTOR flips display:none→block. That gap is the fullscreen() path, and it is the reason
//   an observer alone was never enough.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT = fs.readFileSync(path.join(ROOT, 'web', 'chat-ui.inline.html'), 'utf8');
const STYLE = CHAT.slice(CHAT.indexOf('<style id="pac-style">'), CHAT.indexOf('</style>'));

// The device the bug was reported from.
const IPHONE = { width: 390, height: 844, inset: 34 };   // 390x844 CSS px, home-indicator inset
// CSS `line-height:normal` is a UA value, not a stylesheet number. ~1.2 is what WebKit uses for
// the system font. The fidelity control below is what keeps this from quietly being wrong.
const LINE_NORMAL = 1.2;
// The height the real iPhone showed for the composer stack, from the bug report.
const DEVICE_REPORTED_ROW_PX = 130;

// ── The shipped stylesheet, parsed ──────────────────────────────────────────────────────────
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function ruleBody(sel, style = STYLE) {
  // Anchored on a line start OR a preceding `}` — the stylesheet packs several rules per line.
  const m = style.match(new RegExp(`(^|\\n|\\})${esc(sel)}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `the stylesheet still declares ${sel}`);
  return m[2];
}
function decl(sel, prop, style = STYLE) {
  const m = ruleBody(sel, style).match(new RegExp(`(?:^|;)\\s*${esc(prop)}\\s*:\\s*([^;]+)`));
  assert.ok(m, `${sel} still declares ${prop}`);
  return m[1].trim();
}
// Split a shorthand on TOP-LEVEL spaces — `calc(10px + env(…))` is one token, not three.
function tokens(v) {
  const out = []; let depth = 0, cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
// Evaluate a CSS length, resolving the one env() the component uses — and a var()'s FALLBACK.
//
// This whole file models the composer at the DEFAULT font scale, which is what --pac-fs's own
// fallback spells out: `var(--pac-fs,14px)` is exactly 14px when the shell has broadcast no
// scale, and 14px is the size every assertion here was written against. Taking the fallback is
// therefore not a loosening — it is the same number, named.
//
// What is NOT modelled, and worth knowing: at A+ the composer's text grows, so the row grows and
// the reserve must grow with it. That is handled at RUNTIME by the ResizeObserver this file
// exists to police, not by these static numbers, so the geometry here stays a scale-1 model.
function px(v, inset) {
  const s = String(v).trim()
    .replace(/env\(\s*safe-area-inset-bottom\s*,\s*[^)]*\)/g, `${inset}px`)
    .replace(/var\(\s*--[\w-]+\s*,\s*([^)]+)\)/g, '$1');
  const calc = s.match(/^calc\((.+)\)$/);
  if (calc) return calc[1].split('+').map((t) => px(t.trim(), inset)).reduce((a, b) => a + b, 0);
  const n = s.match(/^(-?[\d.]+)px$/);
  assert.ok(n, `cannot evaluate CSS length ${JSON.stringify(v)}`);
  return parseFloat(n[1]);
}
const pad = (sel, side, inset, style = STYLE) => {
  const t = tokens(decl(sel, 'padding', style));
  return px(side === 'top' ? t[0] : (t.length > 2 ? t[2] : t[0]), inset);
};
const borderY = (sel, style = STYLE) => 2 * px(tokens(decl(sel, 'border', style))[0], 0);

// ── The composer's height, composed from the shipped box values ─────────────────────────────
// state: { lines = composer rows, chips = attachment chips present, pills = the pills row shown }
function rowHeight({ inset }, { lines = 1, chips = false, pills = true } = {}, style = STYLE) {
  const gap = px(decl('.pac-row', 'gap', style), 0);
  // .pac-pills — one row of buttons; `.pac-vfy` is always present, `.pac-model` joins it.
  const pillH = px(tokens(decl('.pac-model,.pac-vfy', 'padding', style))[0], 0) * 2
    + borderY('.pac-model,.pac-vfy', style)
    + px(decl('.pac-model,.pac-vfy', 'font-size', style), 0) * LINE_NORMAL;
  // .pac-frow — align-items:flex-end, so its height is its tallest child plus its own box.
  const inpFont = px(decl('.pac-inp', 'font-size', style), 0);
  const inpLine = Number(decl('.pac-inp', 'line-height', style));
  const inpH = Math.min(px(decl('.pac-inp', 'max-height', style), 0), lines * inpFont * inpLine)
    + px(tokens(decl('.pac-inp', 'padding', style))[0], 0) * 2;
  const frowH = Math.max(px(decl('.pac-go', 'height', style), 0), inpH)
    + px(tokens(decl('.pac-frow', 'padding', style))[0], 0) * 2 + borderY('.pac-frow', style);
  // .pac-chips is a flex item either way (height 0 when empty), so both gaps always count.
  const chipsH = chips ? px(decl('.pac-chip', 'height', style), 0) + px(tokens(decl('.pac-chips:not(:empty)', 'padding', style))[2], 0) : 0;
  return pad('.pac-row', 'top', inset, style) + chipsH + gap + (pills ? pillH : 0) + gap + frowH
    + pad('.pac-row', 'bottom', inset, style);
}

// ── The shipped measurement engine, extracted and executed ──────────────────────────────────
const RESERVE_BEGIN = '/* ══ PA_PILL_RESERVE_BEGIN';
const RESERVE_END = '/* ══ PA_PILL_RESERVE_END ══ */';
function reserveSource(src = CHAT) {
  const from = src.indexOf(RESERVE_BEGIN);
  const to = src.indexOf(RESERVE_END);
  assert.ok(from > 0 && to > from, 'the reservation engine must stay one contiguous block between its markers');
  return src.slice(from, to);
}
const pacConst = (name, src = CHAT) => {
  const m = src.match(new RegExp(`const ${name}=(\\d+)`));
  assert.ok(m, `the component still declares ${name}`);
  return Number(m[1]);
};

// A DOM stub whose ONLY job is to answer offsetHeight the way a browser would: the real height
// when the subtree is rendered, 0 when it is not.
function mkEngine({ rowPx, rendered = () => true, hasRO = true, hasVV = true, hasRaf = true, src = CHAT } = {}) {
  const props = {};
  const host = { style: { setProperty: (k, v) => { props[k] = v; } } };
  const el = { row: { get offsetHeight() { return rendered() ? Math.round(rowPx()) : 0; } } };
  const frames = [];
  let roCb = null, vvCb = null;
  const win = {
    ResizeObserver: hasRO ? class { constructor(cb) { roCb = cb; } observe() {} } : undefined,
    visualViewport: hasVV ? { addEventListener: (t, f) => { if (t === 'resize') vvCb = f; } } : null,
  };
  const raf = hasRaf ? (fn) => frames.push(fn) : undefined;
  // In a browser `window.ResizeObserver` and the bare `ResizeObserver` are the same binding; in a
  // Function sandbox they are not, so both spellings are supplied from the SAME stub.
  // eslint-disable-next-line no-new-func
  const setPill = new Function('el', 'host', 'window', 'ResizeObserver', 'requestAnimationFrame', 'PAC_PILL_GAP', 'PAC_PILL_TRIES',
    `${reserveSource(src)}\nreturn setPill;`)(el, host, win, win.ResizeObserver, raf, pacConst('PAC_PILL_GAP', src), pacConst('PAC_PILL_TRIES', src));
  return {
    props, setPill,
    resizeObserved: () => { assert.ok(roCb, 'the engine registered a ResizeObserver'); roCb(); },
    viewportResized: () => { assert.ok(vvCb, 'the engine listens for visualViewport resize'); vvCb(); },
    runFrames: (n = 1) => { for (let i = 0; i < n && frames.length; i++) frames.shift()(); },
    pendingFrames: () => frames.length,
    hasRO: () => !!roCb, hasVV: () => !!vvCb,
  };
}
// What the log actually reserves: the measured inline value if one was written, else the CSS rule.
const reserved = (engine, inset, src = CHAT) => {
  const style = src === CHAT ? STYLE : src.slice(src.indexOf('<style id="pac-style">'), src.indexOf('</style>'));
  return engine.props['--pac-pill'] ? px(engine.props['--pac-pill'], inset) : px(decl('.pac', '--pac-pill', style), inset);
};
// The assertion this whole file exists for.
const clearance = (engine, inset, state, src = CHAT) => reserved(engine, inset, src) - rowHeight({ inset }, state,
  src === CHAT ? STYLE : src.slice(src.indexOf('<style id="pac-style">'), src.indexOf('</style>')));

// ── R14 controls — prove the harness can fail before trusting a word it says ─────────────────

test('R14 control: the extraction found REAL code and the stylesheet is really being read', () => {
  const src = reserveSource();
  assert.match(src, /const setPill=\(\)=>\{/, 'the extracted block defines setPill');
  assert.match(src, /new ResizeObserver\(setPill\)\.observe\(el\.row\)/, 'and carries the real observer wiring');
  assert.match(src, /requestAnimationFrame\(setPill\)/, 'and the real retry');
  assert.ok(pacConst('PAC_PILL_GAP') > 0 && pacConst('PAC_PILL_TRIES') > 0);
  // No rule may reintroduce a private fallback — one number, defined once on .pac.
  assert.equal((STYLE.match(/var\(--pac-pill\s*,/g) || []).length, 0,
    'no --pac-pill consumer may carry its own fallback (R3: the value is defined once on .pac)');
  for (const sel of ['.pac-log', '.pac-scroll', '.pac-mmenu']) {
    assert.match(ruleBody(sel), /var\(--pac-pill\)/, `${sel} still positions from the shared variable`);
  }
});

test('R14 fidelity control: the composed model agrees with what the real iPhone showed', () => {
  const modelled = rowHeight(IPHONE, {});
  assert.ok(Math.abs(modelled - DEVICE_REPORTED_ROW_PX) <= 8,
    `the composed composer height (${modelled.toFixed(1)}px) must match the device's ~${DEVICE_REPORTED_ROW_PX}px; ` +
    'if it does not, this harness is measuring fiction, not the product');
  // …and it must be materially bigger than the fallback the bug shipped with, or there was no bug.
  assert.ok(modelled > 84 + 30, `the old flat 84px was ~${(modelled - 84).toFixed(0)}px short — that IS the reported symptom`);
});

test('R14 control: the harness reproduces the ORIGINAL defect when the old fallback is restored', () => {
  const old = CHAT.replace(/--pac-pill:calc\([^)]*\+ env\(safe-area-inset-bottom,0px\)\)/, '--pac-pill:84px');
  assert.notEqual(old, CHAT, 'the mutation matched nothing — it would prove nothing');
  const e = mkEngine({ rowPx: () => rowHeight(IPHONE, {}), rendered: () => false, src: old });
  assert.ok(clearance(e, IPHONE.inset, {}, old) < -30,
    'with the flat 84px back, an unmeasured iPhone surface buries the icons — the harness can see the bug');
});

// ── The four states ──────────────────────────────────────────────────────────────────────────

test('STATE 1 — initial render on a visible surface: measured, and the icons clear', () => {
  const e = mkEngine({ rowPx: () => rowHeight(IPHONE, {}) });
  assert.ok(e.props['--pac-pill'], 'a visible surface is measured at mount, not left on the fallback');
  assert.equal(reserved(e, IPHONE.inset), Math.round(rowHeight(IPHONE, {})) + pacConst('PAC_PILL_GAP'),
    'the reservation is the measured row (offsetHeight is an integer) plus the declared gap');
  assert.ok(clearance(e, IPHONE.inset, {}) >= pacConst('PAC_PILL_GAP') - 1,
    `clearance ${clearance(e, IPHONE.inset, {}).toFixed(1)}px must be at least the declared breathing room`);
});

test('STATE 2 — the model pill arrives late via the prefs push: re-measured, and the un-measured fallback already counts the pills row', () => {
  // The pill is pushed by the shell AFTER mount, so whatever it does to the row happens late.
  let pills = false;
  const e = mkEngine({ rowPx: () => rowHeight(IPHONE, { pills }) });
  const before = reserved(e, IPHONE.inset);
  pills = true; e.resizeObserved();                       // the row re-lays out → the observer fires
  assert.ok(reserved(e, IPHONE.inset) > before, 'the late pill really changed the measurement');
  assert.ok(clearance(e, IPHONE.inset, { pills: true }) >= 0, 'and the icons still clear afterwards');
  // The headline half: a surface that is NEVER measured must still reserve for the pills row.
  // The flat 84px predated that row entirely, which is how the icons ended up under the pill.
  const never = mkEngine({ rowPx: () => rowHeight(IPHONE, { pills: true }), rendered: () => false });
  assert.ok(clearance(never, IPHONE.inset, { pills: true }) >= 0,
    'the CSS fallback must clear a pills-inclusive, safe-area-inclusive composer with no measurement at all');
});

test('STATE 3 — a 3-line composer: the reservation follows the growth', () => {
  let lines = 1;
  const e = mkEngine({ rowPx: () => rowHeight(IPHONE, { lines }) });
  lines = 3; e.resizeObserved();
  assert.ok(clearance(e, IPHONE.inset, { lines: 3 }) >= 0,
    `a 3-line composer must still clear; got ${clearance(e, IPHONE.inset, { lines: 3 }).toFixed(1)}px`);
  // Growth beyond the base state is what MEASUREMENT is for — the fallback alone cannot know it.
  const never = mkEngine({ rowPx: () => rowHeight(IPHONE, { lines: 3 }), rendered: () => false });
  assert.ok(clearance(never, IPHONE.inset, { lines: 3 }) < 0,
    'stated honestly: the fallback covers the BASE composer, not a grown one — that is why re-measuring matters');
});

test('STATE 3b — attachment chips grow the row too, and are measured', () => {
  let chips = false;
  const e = mkEngine({ rowPx: () => rowHeight(IPHONE, { chips }) });
  chips = true; e.resizeObserved();
  assert.ok(clearance(e, IPHONE.inset, { chips: true }) >= 0);
});

// ── STATE 4 — the fullscreen surface, shown after being hidden ───────────────────────────────
// The shipped fullscreen() factory is EXTRACTED and RUN, with a recording Chat() whose remeasure
// is the real extracted setPill. So `fs.show()` really walks the shipped wiring.
function loadFullscreen(chatFactory, src = CHAT) {
  const from = src.indexOf('    fullscreen:(opts)=>{');
  const to = src.indexOf('// A STANDALONE slide-in list drawer', from);
  assert.ok(from > 0 && to > from, 'the fullscreen factory must stay one contiguous block');
  const body = src.slice(from, to).replace(/,\s*$/, '');
  const mkEl = () => { const c = new Set(); return { className: '', appendChild() {}, classList: { add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x) } }; };
  const doc = { createElement: mkEl, body: { appendChild() {} } };
  // eslint-disable-next-line no-new-func
  return new Function('document', 'Chat', `return ({${body}}).fullscreen;`)(doc, chatFactory);
}
// Build a fullscreen surface whose measurability follows its own overlay's `.on` class, with the
// WebKit gap modelled: the ResizeObserver is NEVER delivered for the display:none→block flip.
function mkFullscreen({ rowPx, src = CHAT } = {}) {
  let overlay = null, engine = null;
  const factory = loadFullscreen(() => {
    engine = mkEngine({ rowPx, rendered: () => !!overlay && overlay.classList.contains('on'), src });
    return { remeasure: engine.setPill, open() {}, openConvo() {}, newChat() {}, showList() {} };
  }, src);
  const api = factory({});
  overlay = api.el;
  assert.ok(overlay && !overlay.classList.contains('on'), 'a fullscreen surface starts hidden — that is the whole problem');
  return { api, engine: () => engine };
}

test('STATE 4 — a first-shown fullscreen surface: covered by the fallback BEFORE show, and measured after it', () => {
  const rowPx = () => rowHeight(IPHONE, {});
  const f = mkFullscreen({ rowPx });
  // Before show(): nothing could be measured (the overlay is display:none) and the observer never
  // fired. The CSS fallback is the ONLY thing standing between the user and the reported bug.
  assert.ok(!f.engine().props['--pac-pill'], 'a hidden surface has no measurement — by construction');
  assert.ok(clearance(f.engine(), IPHONE.inset, {}) >= 0,
    `the derived fallback must already clear the iPhone composer; got ${clearance(f.engine(), IPHONE.inset, {}).toFixed(1)}px`);
  // show() must MEASURE — that is defence (iii), and the contract is "a shown surface is measured".
  f.api.show();
  assert.ok(f.engine().props['--pac-pill'], 'show() re-measures a surface that has just become visible');
  assert.ok(clearance(f.engine(), IPHONE.inset, {}) >= pacConst('PAC_PILL_GAP') - 1);
  // Every entry point that reveals the surface goes through the same show().
  for (const entry of ['open', 'openConvo', 'newChat', 'showList']) {
    const g = mkFullscreen({ rowPx });
    g.api[entry]('k');
    assert.ok(g.engine().props['--pac-pill'], `${entry}() reveals the surface, so it must measure too`);
  }
});

test('STATE 4b — once shown, growth is measured through the observer as normal', () => {
  let lines = 1;
  const f = mkFullscreen({ rowPx: () => rowHeight(IPHONE, { lines }) });
  f.api.show();
  lines = 3; f.engine().resizeObserved();
  assert.ok(clearance(f.engine(), IPHONE.inset, { lines: 3 }) >= 0);
});

test('the iOS keyboard (visualViewport resize) re-measures', () => {
  let lines = 1;
  const e = mkEngine({ rowPx: () => rowHeight(IPHONE, { lines }) });
  assert.ok(e.hasVV(), 'the engine subscribes to visualViewport resize');
  lines = 3; e.viewportResized();
  assert.ok(clearance(e, IPHONE.inset, { lines: 3 }) >= 0);
});

test('a zero measurement schedules a RETRY instead of being accepted as measured', () => {
  let up = false;
  const e = mkEngine({ rowPx: () => rowHeight(IPHONE, {}), rendered: () => up });
  assert.ok(!e.props['--pac-pill'], 'nothing measurable → nothing recorded');
  assert.equal(e.pendingFrames(), 1, 'a retry is armed');
  up = true; e.runFrames();
  assert.ok(e.props['--pac-pill'], 'the retry picks the measurement up as soon as it exists');
  assert.ok(clearance(e, IPHONE.inset, {}) >= pacConst('PAC_PILL_GAP') - 1);
});

test('the retry is bounded and re-arms after a later success — it never spins forever', () => {
  const e = mkEngine({ rowPx: () => rowHeight(IPHONE, {}), rendered: () => false });
  const tries = pacConst('PAC_PILL_TRIES');
  for (let i = 0; i < tries + 20; i++) e.runFrames();
  assert.equal(e.pendingFrames(), 0, `the retry stops after PAC_PILL_TRIES (${tries}) attempts`);
  assert.ok(!e.props['--pac-pill'], 'and it never invents a measurement it could not take');
});

test('no requestAnimationFrame and no ResizeObserver: the engine still degrades to the safe fallback', () => {
  const e = mkEngine({ rowPx: () => rowHeight(IPHONE, {}), rendered: () => false, hasRO: false, hasVV: false, hasRaf: false });
  assert.ok(clearance(e, IPHONE.inset, {}) >= 0, 'the derived CSS fallback carries a surface with no APIs at all');
});

test('the fallback also clears with no safe-area inset (an iframe that reports env() as 0)', () => {
  const e = mkEngine({ rowPx: () => rowHeight({ inset: 0 }, {}), rendered: () => false });
  assert.ok(clearance(e, 0, {}) >= 0, 'the fallback and the row read the SAME env(), so they agree at any inset');
});

// ── Mutations — each defence must be shown to be load-bearing ────────────────────────────────

test('MUTATION 1: restore the flat 84px fallback → the un-measured iPhone surface goes red', () => {
  const old = CHAT.replace(/--pac-pill:calc\([^)]*\+ env\(safe-area-inset-bottom,0px\)\)/, '--pac-pill:84px');
  assert.notEqual(old, CHAT, 'the mutation matched nothing');
  const f = mkFullscreen({ rowPx: () => rowHeight(IPHONE, {}), src: old });
  const gap = clearance(f.engine(), IPHONE.inset, {}, old);
  assert.ok(gap < 0, `the defect reproduces: the icons sit ${Math.abs(gap).toFixed(0)}px under the composer`);
  // and the shipped fallback does not.
  const good = mkFullscreen({ rowPx: () => rowHeight(IPHONE, {}) });
  assert.ok(clearance(good.engine(), IPHONE.inset, {}) >= 0);
});

test('MUTATION 2: drop show()\'s re-measure → a revealed surface is never measured', () => {
  const noHook = CHAT.replace('const show=()=>{ ov.classList.add(\'on\'); if(chatApi) chatApi.remeasure(); }', 'const show=()=>ov.classList.add(\'on\')');
  assert.notEqual(noHook, CHAT, 'the mutation matched nothing');
  const f = mkFullscreen({ rowPx: () => rowHeight(IPHONE, {}), src: noHook });
  f.api.show();
  assert.ok(!f.engine().props['--pac-pill'],
    'without the hook a shown surface stays un-measured — it survives only on the fallback, which cannot know about growth');
  const good = mkFullscreen({ rowPx: () => rowHeight(IPHONE, {}) });
  good.api.show();
  assert.ok(good.engine().props['--pac-pill'], 'the shipped hook measures it');
});

test('MUTATION 3: drop the zero-retry → a surface that becomes measurable a frame later is missed', () => {
  const noRetry = CHAT.replace(/\n\s*if\(pillTries\+\+<PAC_PILL_TRIES[^\n]*\n/, '\n');
  assert.notEqual(noRetry, CHAT, 'the mutation matched nothing');
  let up = false;
  const e = mkEngine({ rowPx: () => rowHeight(IPHONE, {}), rendered: () => up, src: noRetry });
  assert.equal(e.pendingFrames(), 0, 'the defect reproduces: a zero is silently accepted');
  up = true;
  assert.ok(!e.props['--pac-pill'], 'and nothing ever comes back for it');
  const good = mkEngine({ rowPx: () => rowHeight(IPHONE, {}), rendered: () => up });
  assert.ok(good.props['--pac-pill'] || good.pendingFrames() === 0);
});
