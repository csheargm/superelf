// PAStationery test fixture, shared by test/stationery-sanitize.test.mjs, test/stationery-sanitize-cost.test.mjs
// and test/stationery-panote.test.mjs (R3: one loader, not two).
//
// Fidelity (R14, stated plainly): the component's OWN <script> is executed — never restated. In
// Node there is no DOMParser, so sanitize() runs on its strict tokenizer alone (the browser adds
// the DOMParser cross-check on top). Image and canvas are stubbed: an Image "decodes" on the next
// microtask, and a canvas context RECORDS what was drawn so order and transforms can be asserted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settle } from './helpers-timing.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
export const STN_HTML = read('web', 'stationery-ui.inline.html');
export const SAN_HTML = read('web', 'stationery-sanitize.inline.html');
export const COST_HTML = read('web', 'stationery-cost.inline.html');
export const GEOM_HTML = read('web', 'stationery-geometry.inline.html');
export const SIMP_HTML = read('web', 'stationery-simplify.inline.html');
export const DESIGNS_HTML = read('web', 'stationery-designs.inline.html');

export function scriptBody(html) {
  const a = html.indexOf('<script>'), b = html.indexOf('</script>', a);
  assert.ok(a >= 0 && b > a, 'the component carries one <script>');
  return html.slice(a + '<script>'.length, b);
}

// A 2D context that records every call, and tracks the scale part of its transform the way a
// real one does (save/restore/scale/setTransform), so device-size decisions can be checked.
export function recordingCtx(log = []) {
  const stack = []; let a = 1;
  const rec = (name) => (...args) => { log.push([name, ...args]); };
  return {
    log,
    save() { stack.push(a); log.push(['save']); }, restore() { a = stack.pop() ?? 1; log.push(['restore']); },
    scale(x) { a *= x; log.push(['scale', x]); }, setTransform(x) { a = x; log.push(['setTransform', x]); },
    getTransform: () => ({ a, b: 0 }), translate: rec('translate'), drawImage: rec('drawImage'),
    clearRect: rec('clearRect'), fillRect: rec('fillRect'), beginPath: rec('beginPath'), moveTo: rec('moveTo'),
    lineTo: rec('lineTo'), stroke: rec('stroke'), arc: rec('arc'), fill: rec('fill'), setLineDash: rec('setLineDash'),
    getImageData: () => ({ data: [0, 0, 0, 0] }),
    set fillStyle(v) { log.push(['fillStyle', v]); }, set strokeStyle(v) { log.push(['strokeStyle', v]); },
    set globalAlpha(v) { log.push(['globalAlpha', v]); }, set lineWidth(v) { log.push(['lineWidth', v]); },
    set globalCompositeOperation(v) { log.push(['globalCompositeOperation', v]); },
  };
}

// FakeImage.fail = true makes the next decodes fail, as a broken data: URL would.
export class FakeImage {
  static fail = false;
  set src(v) { this._src = v; const bad = FakeImage.fail; queueMicrotask(() => (bad ? this.onerror : this.onload)?.()); }
  get src() { return this._src; }
}
// The canvas's top-left pixel, replayed from its log by Canvas 2D's rules for OPAQUE paint (partial alpha is
// not modelled): drawImage paints the SVG's corner — a full-page <rect fill> as its first shape gives that
// colour, anything else leaves the pixel as it was — fillRect over the corner paints fillStyle, clearRect
// clears it, and 'destination-over' paints only a pixel still transparent ('none'). Other operations fail loudly.
const svgCorner = (src) => { const m = /^data:image\/svg\+xml;charset=utf-8,(.*)$/.exec(String(src));
  const r = m && /^<svg[^>]*><rect width="816" height="1056" fill="(#[0-9a-f]{6})"\/>/i.exec(decodeURIComponent(m[1])); return r ? r[1] : 'none'; };
function cornerOf(log) {
  let px = 'none', op = 'source-over', fill = '#000000';
  for (const [k, ...a] of log) {
    if (k === 'globalCompositeOperation') { assert.ok(['source-over', 'destination-over'].includes(a[0]), `unmodelled operation ${a[0]}`); op = a[0]; }
    if (k === 'fillStyle') fill = a[0];
    const atCorner = k === 'drawImage' ? a[1] <= 0 && a[2] <= 0 : a[0] <= 0 && a[1] <= 0;
    if (k === 'clearRect' && atCorner) px = 'none';
    const paint = !atCorner ? 'none' : k === 'drawImage' ? svgCorner(a[0].src) : k === 'fillRect' ? fill : 'none';
    if (paint !== 'none' && (op === 'source-over' || px === 'none')) px = paint;
  }
  return px;
}
// toDataURL names what the canvas holds — its size, its top-left pixel (cornerOf) and the source of the last
// image drawn into it — so an encoded picture can be traced to the template, the width and the ground it sits on.
const fakeDocument = () => ({
  createElement: (tag) => { assert.equal(tag, 'canvas'); const c = { width: 0, height: 0, log: [] };
    c.getContext = () => recordingCtx(c.log);
    c.toDataURL = (type = 'image/png') => { const d = c.log.filter((l) => l[0] === 'drawImage').pop();
      return `data:${type};w=${c.width};h=${c.height};corner=${cornerOf(c.log)};of=${d ? d[1].src : ''}`; };
    return c; },
});

// Load the shipped component: the budget's geometry readers, the budget, simplify()'s steps, the sanitizer, then the
// engine, in the order the page runs them (each carries the markers of the ones before it above its own script).
// `mutate` rewrites the joined source first (mutation testing); it must match. `DOMParser` stands in for the browser's
// (Node has none, so sanitize() skips its cross-check): pass XmlDomParser to run that rule. `globals` shadows globals the
// components read, as a page without them would see them (simplify()'s clock: { performance: undefined, Date }).
export function loadStationery({ mutate, DOMParser, globals = {} } = {}) {
  let src = [GEOM_HTML, COST_HTML, SIMP_HTML, SAN_HTML, STN_HTML].map(scriptBody).join('\n;\n');
  if (mutate) { const before = src; src = mutate(src); assert.notEqual(src, before, 'the mutation matched nothing — it would prove nothing'); }
  const window = { devicePixelRatio: 1 };
  // eslint-disable-next-line no-new-func
  new Function('window', 'Image', 'document', 'DOMParser', ...Object.keys(globals), src)(window, FakeImage, fakeDocument(), DOMParser, ...Object.values(globals));
  assert.ok(window.PAStationery, 'the component defines window.PAStationery');
  return window.PAStationery;
}
// The browser's XML parser as domAgrees() reads it, over sanitize()'s own output (start tags, quoted attributes, no text):
// a parse error for a character XML 1.0 refuses (a C0 control but tab, LF and CR; U+FFFE, U+FFFF; a lone surrogate), else
// the root and one element per start tag. Chromium refuses result="a&#xFFFF;" this way (R13 round 2, measured).
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export class XmlDomParser {
  parseFromString(s) {
    const bad = NOT_XML.test(s), n = (s.match(/<[A-Za-z]/g) || []).length, root = /^<([A-Za-z]+)[^>]*?\sxmlns="([^"]*)"/.exec(s);
    const list = (k) => ({ length: k });
    return { getElementsByTagName: (t) => list(bad && t === 'parsererror' ? 1 : 0),
      documentElement: bad || !root ? null : { localName: root[1], namespaceURI: root[2], getElementsByTagName: () => list(n - 1) } };
  }
}
// The bundled designs, run against a loaded component exactly as the page runs them.
export function withDesigns(S) {
  // eslint-disable-next-line no-new-func
  new Function('PAStationery', scriptBody(DESIGNS_HTML))(S);
  return S;
}
export const VB = 'viewBox="0 0 816 1056"';
export const FP = 'width="816" height="1056"';   // a full-page shape (R3: one fixture for the cost tests)
// Paint fixtures of the cost tests (stationery-sanitize-paint, stationery-sanitize-bounds; R3: one copy each)
export const LG = '<linearGradient id="lg"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#ccd"/></linearGradient>';
export const PT = '<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#eee"/></pattern>';
export const HALF = `<rect ${FP} fill="#fff" fill-opacity="0.5"/>`;               // a see-through full-page rect
export const SMALL = '<rect width="81.6" height="105.6" fill="url(#lg)"';        // a gradient rect a tenth of the page wide and tall (open tag)
export const dashed = (d, n, a = '') => svg(`<path fill="none" stroke="#000" stroke-dasharray="0.01"${a} d="${d}"/>`.repeat(n));
// n gradient stops at uneven offsets: a seeded random, so each call gives the same stops; op adds a stop-opacity to each.
export function unevenStops(n, op) {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: n }, rnd).sort((a, b) => a - b).map((o, i) => `<stop offset="${o.toFixed(6)}" stop-color="#${(i * 2654435761 >>> 8 & 0xffffff).toString(16).padStart(6, '0')}"`
    + `${op ? ` stop-opacity="${(0.3 + 0.7 * rnd()).toFixed(2)}"` : ''}/>`).join('');
}
export const R16 = `<radialGradient id="g">${unevenStops(16, true)}</radialGradient>`;   // the costliest gradient that gets through
// n hearts painted with url(#id): 45 or more put a pattern design over the budget (the simplify suites; R3: one copy)
export const heartsOf = (id, n) => `<path d="M10 30C10 10 40 10 40 30C40 50 10 60 10 80C10 60-20 50-20 30C-20 10 10 10 10 30Z" fill="url(#${id})"/>`.repeat(n);
// A doubling <use> chain: fan^levels circles through `levels` links, #l0 to #l<levels>; `more` is added to each element's
// attributes (the simplify suites; R3: one copy)
export const useChain = (levels, fan, more = '') => { let c = `<circle id="l0" r="1" fill="#c33"${more}/>`;
  for (let i = 1; i <= levels; i++) c += `<g id="l${i}"${more}>${`<use href="#l${i - 1}" x="${i}"${more}/>`.repeat(fan)}</g>`; return c; };
export const svg = (inner, rootAttrs = VB) => `<svg xmlns="http://www.w3.org/2000/svg" ${rootAttrs}>${inner}</svg>`;
export const tick = () => new Promise((r) => setTimeout(r, 0));
// simplify()'s note and an AI turn that answers with `text` (test/stationery-simplify*.test.mjs; R3: one copy each)
export const simplifiedNote = (en, zh) => `已简化：去掉了${zh} · Simplified to draw fast, without ${en}`;
// simplify()'s deadline (stationery-simplify SIMPLIFY_MS) reads a wall clock: on a loaded runner (CI's windows-latest, run
// 43090576890, 460 layers) a design is refused plain (fail closed, by design). A test that pins WHAT a design is simplified
// into passes NO_DEADLINE, a clock that never moves, or loads the page with loadStill, whose performance.now() never moves —
// the studio's calls too. The work budget still applies; stationery-simplify-deadline proves the deadline (R13 round 5).
export const NO_DEADLINE = Object.freeze({ clock: () => 0 });
const STILL_CLOCK = { performance: { now: () => 0 } };   // a clock that never moves: no deadline is ever passed
export const loadStill = (o = {}) => loadStationery({ ...o, globals: { ...STILL_CLOCK, ...o.globals } });
export const TOO_COMPLEX = '太复杂，iPad 画不动 · Too complex for the iPad to draw — 请重试或要求简单些 · try again or ask for a simpler design';
export const answerWith = (text) => async () => ({ ok: true, text: 'Here is your design:\n\n' + text + '\n\nEnjoy!', convoId: 'c1', error: '' });
// How often re matches s; and a mutant that must match the shipped text EXACTLY once — one that matched twice or not at all
// would prove nothing (the simplify suites; R3: one copy each).
export const countMatches = (s, re) => (s.match(re) || []).length;
export const replaceOnce = (from, to) => (s) => { assert.equal(s.split(from).length, 2, `mutation target, exactly once: ${from}`); return s.replace(from, to); };

// ── The studio (AI design + pictures) and PAChat.complete, loaded from the SHIPPED files ─────
export const STUDIO_HTML = read('web', 'stationery-studio.inline.html');
export const PICKER_HTML = read('web', 'stationery-picker.inline.html');
const CHAT_HTML = read('web', 'chat-ui.inline.html');

// A canvas whose pixels are a promise the test makes: `alpha` decides whether getImageData shows a
// transparent pixel. toDataURL RECORDS the type and quality it was asked for (the format decision).
export function fakeCanvasDoc({ alpha = false } = {}) {
  const made = [];
  return { made, createElement: (tag) => { assert.equal(tag, 'canvas');
    // `encodedAt` is the size at encode time (the canvas is released afterwards); `reads` every pixel read.
    const c = { width: 0, height: 0, log: [], encoded: null, encodedAt: null, reads: [] };
    const ctx = recordingCtx(c.log);
    // alpha: the LAST pixel of the page is transparent, so a scan must reach the end to see it.
    ctx.getImageData = (x, y, w, h) => { c.reads.push([y, h]); const d = new Uint8ClampedArray(w * h * 4).fill(255);
      if (alpha && y + h >= c.height) d[d.length - 1] = 0; return { data: d }; };
    c.getContext = () => ctx;
    c.toDataURL = (type, q) => { c.encoded = { type, q }; c.encodedAt = [c.width, c.height]; return `data:${type};base64,${'A'.repeat(64)}`; };
    made.push(c); return c; } };
}
// PAPhoto, faked at its documented API: toCanvas never enlarges (papScale), toFile keeps the type,
// fits() compares against a cap the test sets, upload is supplied by the test (the HOST's channel).
export function fakePhoto({ cap = 0, maxEdge = 1600 } = {}) {
  return { DEFAULT_MAX_EDGE: maxEdge, decoded: [],
    sources: [],
    toCanvas(file, edge) { this.decoded.push(edge); const s = Math.min(1, edge / Math.max(file.w, file.h));
      const w = Math.round(file.w * s), h = Math.round(file.h * s), canvas = { src: file.name, width: w, height: h };
      this.sources.push(canvas); return Promise.resolve({ canvas, w, h }); },
    toFile: (url, name) => ({ name, type: /^data:([^;]+)/.exec(url)[1], size: url.length, url }),
    fits: (bytes) => !cap || bytes <= cap };
}
// Load the shipped studio against a loaded PAStationery. `mutate` must match (mutation testing).
export function loadStudio(S, { photo = fakePhoto(), document = fakeCanvasDoc(), mutate } = {}) {
  let src = scriptBody(STUDIO_HTML);
  if (mutate) { const before = src; src = mutate(src); assert.notEqual(src, before, 'the mutation matched nothing — it would prove nothing'); }
  const window = { PAStationery: S, PAPhoto: photo };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(window, document);
  assert.ok(window.PAStationeryStudio, 'the studio defines window.PAStationeryStudio');
  return window.PAStationeryStudio;
}
// PAChat.complete, RUN from chat-ui's own source: its broker head (ids, the waiter map, the message
// listener, reqChat) plus the `complete:` member. `shell(msg, reply)` plays the shell relay: it gets
// the posted request and answers with the relay's own envelopes ({ev} per event, then {done:true}).
export function loadComplete(shell) {
  const head = CHAT_HTML.slice(CHAT_HTML.indexOf('  let _cid=0;'), CHAT_HTML.indexOf('  /* ── Size limits'));
  const a = CHAT_HTML.indexOf('    complete:(message,o)=>'), b = CHAT_HTML.indexOf('}); },', a);
  assert.ok(head.includes('const reqChat=') && a > 0 && b > a, 'reqChat and PAChat.complete are both findable');
  const posted = []; let listener = null;
  const window = { addEventListener: (t, fn) => { if (t === 'message') listener = fn; } };
  const parent = { postMessage: (m) => { posted.push(m); queueMicrotask(() => shell(m, (r) => listener({ data: { pa: 'res', id: m.id, ...r } }))); } };
  // eslint-disable-next-line no-new-func
  const api = new Function('window', 'parent', `${head}\nreturn {${CHAT_HTML.slice(a, b + 6)}};`)(window, parent);
  return { complete: api.complete, posted };
}

// ── A minimal DOM for the picker: just what stationery-picker touches. A click on a DISABLED
// button does nothing, as in a browser — that is the behaviour the busy guard relies on. ─────
export class FakeEl {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.style = {}; this.dataset = {};
    this.attrs = {}; this.on = {}; this.className = ''; this.textContent = ''; this.value = ''; this.disabled = false; this.width = 0; this.height = 0;
    const cls = () => new Set(this.className.split(/\s+/).filter(Boolean)), set = (c) => { this.className = [...c].join(' '); };
    this.classList = { contains: (k) => cls().has(k), add: (k) => set(cls().add(k)),
      remove: (k) => { const c = cls(); c.delete(k); set(c); }, toggle: (k, on) => { const c = cls(); (on ?? !c.has(k)) ? c.add(k) : c.delete(k); set(c); } }; }
  append(...els) { for (const e of els) { e.parentNode = this; this.children.push(e); } }
  appendChild(e) { this.append(e); return e; }
  after(...els) { const p = this.parentNode, i = p.children.indexOf(this); for (const e of els) e.parentNode = p; p.children.splice(i + 1, 0, ...els); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, fn) { if (typeof fn === 'function') (this.on[t] ||= []).push(fn); }   // a browser ignores null
  click() { if (!this.disabled) for (const fn of this.on.click || []) fn(); }
  getContext() { return recordingCtx(); }
  querySelectorAll(sel) { const out = [], hit = (e) => (sel[0] === '.' ? e.classList.contains(sel.slice(1)) : e.tagName === sel.toUpperCase());
    const walk = (e) => { for (const k of e.children) { if (hit(k)) out.push(k); walk(k); } }; walk(this); return out; }
  set textContent(v) { this._t = String(v); if (v === '' && this.children) this.children = []; }
  get textContent() { return this._t; }
}
// `mutate` must match (mutation testing). `win` adds to the page's window (PAChat, innerWidth, devicePixelRatio).
export function loadPicker(S, ST, { mutate, win } = {}) {
  let src = scriptBody(PICKER_HTML);
  if (mutate) { const before = src; src = mutate(src); assert.notEqual(src, before, 'the mutation matched nothing — it would prove nothing'); }
  const document = { createElement: (t) => new FakeEl(t) };
  const window = { PAStationery: S, PAStationeryStudio: ST, devicePixelRatio: 1, ...win };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(window, document);
  return { picker: window.PAStationeryPicker, document };
}
// The picker mounted with its studio, as PANote mounts it for the Journal — the user-flow fixture of
// test/stationery-flow.test.mjs and test/stationery-design-e2e.test.mjs (R3: one, not two).
// `mutate` rewrites the picker, `studioMutate` the studio (mutation testing; each must match);
// `channel` replaces the fake AI (the default records each turn in `pending` and answers on demand);
// `win` adds to the picker's window (loadPicker) — e.g. the page's PAChat, for the draft zoom; `opts` adds to
// the host's mount options (e.g. its paper()). end() presses Cancel and answers every turn still out, so a live
// run's elapsed-time ticker (a REAL setInterval) and the studio's wait timer stop even when an assertion threw
// first: register it with t.after, or a failing test leaves node --test running with no summary.
export function mountStudio(mutate, studioMutate, channel, win, opts, globals) {
  const S = loadStationery({ globals }), ST = loadStudio(S, { mutate: studioMutate });
  const pending = []; const ai = channel || ((message, o) => new Promise((res) => pending.push({ message, o, res })));
  const host = new FakeEl('div'), list = new FakeEl('div'); host.append(list);
  const { picker } = loadPicker(S, ST, { mutate, win });
  picker.mount(list, { current: () => null, choose: () => {}, studio: { ai, store: { saveMine: async () => ({ ok: true }) }, upload: async () => ({ ok: false }) }, ...opts });
  // Labels read '中文 · English': a key like 'Design ·' names the English half, so it matches
  // either half's start (the old English-first prefix keys keep working).
  const btn = (t) => { const k = t.replace(/\s*·\s*$/, ''), all = host.querySelectorAll('button');
    const en = (b) => { const s = String(b.textContent), i = s.lastIndexOf(' · '); return i < 0 ? s : s.slice(i + 3); };
    return all.find((b) => en(b) === k) || all.find((b) => b.textContent.startsWith(t)) || all.find((b) => en(b).startsWith(k)); };
  host.querySelectorAll('textarea')[0].value = 'pink dots';
  const draft = host.querySelectorAll('.pst-draft')[0], msg = draft.children.find((c) => c.classList.contains('pst-msg'));
  const prev = draft.children.find((c) => c.classList.contains('pst-prev'));
  const end = async () => { btn('Cancel').click(); for (const p of pending) p.res({ ok: false, error: 'test over' }); await settle(); };
  return { host, pending, btn, msg, prev, end, say: () => msg.textContent, drawn: () => prev.classList.contains('on') };
}

// The Journal's studio as the person uses it (the simplify suites' user flow; R3: one copy): Design is pressed with 'pink
// dots', reply(text) answers that AI turn and lets the page settle, `saved` holds what Keep stored. Ends with the test.
export function draftFlow(t, mutate, studioMutate) {
  const turns = [], saved = [], ai = () => new Promise((res) => turns.push(res));
  const store = { saveMine: async (tpl) => { saved.push(tpl); return { ok: true }; } };
  // A still clock: simplify()'s 150 ms deadline is pinned with fake clocks in stationery-simplify-deadline; here a slow CI
  // runner (windows-latest) passed it on the real clock and the user flow read the plain refusal (CI on ff5c1ce, 27a7431).
  const m = mountStudio(mutate, studioMutate, ai, undefined, { studio: { ai, store, upload: async () => ({ ok: false }) } }, STILL_CLOCK);
  t.after(async () => { for (const res of turns) res({ ok: false, error: 'test over' }); await m.end(); });
  m.btn('✨').click(); m.btn('Design ·').click();
  return { ...m, saved, reply: async (text) => { turns.shift()({ ok: true, text, convoId: 'c1', error: '' }); await settle(); } };
}

// The WHOLE shipped chat-ui script, run against a small recording DOM: the real window.PAChat, plus
// one mounted chat whose log the test can tap. `body.children` is what chat-ui appended to the page
// (its lightbox); `key(k)` presses a key on the document. `mutate` must match (mutation testing).
// `parent`: the shell stub chat-ui posts its requests to; a test that must answer them (a convo load, a
// turn) passes one whose postMessage calls back the window's 'message' listener (captured through `win`).
const APP_PREFS_HTML = fs.readFileSync(path.join(ROOT, 'web', 'app-prefs.inline.html'), 'utf8');
export const APP_PREFS_SRC = APP_PREFS_HTML.slice(APP_PREFS_HTML.indexOf('>', APP_PREFS_HTML.indexOf('<script id="pap-script">')) + 1, APP_PREFS_HTML.lastIndexOf('</script>'));
export function loadChatUi({ mutate, win = {}, parent = { postMessage() {} } } = {}) {
  const at = CHAT_HTML.indexOf('<script id="pac-script">');
  // The served page has web/reply-clean.js inlined at its marker (web.mjs PA_COMPONENTS): so does this harness.
  let src = CHAT_HTML.slice(CHAT_HTML.indexOf('>', at) + 1, CHAT_HTML.indexOf('</script>', at)).split('/* PA_REPLY_CLEAN_JS */').join(read('web', 'reply-clean.js'));
  if (mutate) { const before = src; src = mutate(src); assert.notEqual(src, before, 'the mutation matched nothing — it would prove nothing'); }
  const el = (tag) => { const c = new Set(), kids = [], on = {}, qs = {};
    return { tagName: String(tag).toUpperCase(), children: kids, style: {}, dataset: {}, on, className: '', value: '',
      classList: { add: (...k) => k.forEach((x) => c.add(x)), remove: (...k) => k.forEach((x) => c.delete(x)), contains: (k) => c.has(k),
        toggle: (k, v) => ((v ?? !c.has(k)) ? c.add(k) : c.delete(k)) },
      appendChild: (k) => { kids.push(k); return k; }, append: (...k) => kids.push(...k), get firstChild() { return kids[0] ?? null; },
      addEventListener: (t, fn) => (on[t] ||= []).push(fn), removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
      querySelector: (s) => (qs[s] ||= el('div')), querySelectorAll: () => [], focus() {}, isConnected: true, remove() { this.isConnected = false; },
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) }; };
  const docOn = {};
  const document = { createElement: el, head: el('head'), body: el('body'), documentElement: el('html'),
    addEventListener: (t, fn) => (docOn[t] ||= []).push(fn), querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 390, innerHeight: 844, ...win };
  const stubs = [class { observe() {} disconnect() {} }, () => 0, { getItem: () => null, setItem() {} }];
  // eslint-disable-next-line no-new-func
  // chat-ui carries PA_APP_PREFS_UI, so the served page has PAAppPrefs on the same window and parent (timeouts never run here).
  // eslint-disable-next-line no-new-func
  new Function('window', 'parent', 'setTimeout', 'clearTimeout', APP_PREFS_SRC)(window, parent, () => 0, () => {});
  new Function('window', 'document', 'parent', 'ResizeObserver', 'requestAnimationFrame', 'localStorage', src)(window, document, parent, ...stubs);
  assert.ok(window.PAChat, 'chat-ui defines window.PAChat');
  const chatHost = el('div'); window.PAChat.mount(chatHost, {});
  return { PAChat: window.PAChat, body: document.body, window,
    tapChatImage: (src) => { for (const fn of chatHost.querySelector('.pac-log').on.click || []) fn({ target: { tagName: 'IMG', src } }); },
    key: (k) => { for (const fn of docOn.keydown || []) fn({ key: k }); } };
}
