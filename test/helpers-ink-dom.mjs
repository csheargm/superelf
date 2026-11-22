// The fake DOM with a LAYOUT that test/ink-anchor.test.mjs and test/ink-anchor-host.test.mjs share:
// CW px per character, RH px per row, rows wrap at the list's width, a Range that reports the union of
// its character rects. EXTRACTED from ink-anchor.test.mjs (R3): one fixture, two suites. It runs the
// shipped component (web/ink-anchor.inline.html) for real against this DOM; nothing here decides an outcome.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, scriptOf } from './helpers-app.mjs';

export const COMPONENT = fs.readFileSync(path.join(ROOT, 'web', 'ink-anchor.inline.html'), 'utf8');
export const FRAME = fs.readFileSync(path.join(ROOT, 'web', 'ink-frame.inline.html'), 'utf8');   // runs first, as served
// ── a DOM with a layout: CW px per character, RH px per row, rows wrap at the list's width ──────
export const CW = 10, RH = 24, PADL = 12;
const VNUM = 20, GAP = 6, PADT = 8;
// `src`: the component source to run (a mutation control hands a rewritten copy; default the shipped one).
export function makeDom({ width = 400, childrenCount = false, src = COMPONENT } = {}) {
  const L = { width, cw: CW, scrollTop: 0, listeners: new Map(), prevented: [], stopped: 0, raf: [], timers: [] };
  const cols = () => Math.max(1, Math.floor((L.width - 2 * PADL) / L.cw));
  const rowsOf = (text, c = cols()) => Math.max(1, Math.ceil(text.length / c));
  // A line's own column count: a hidden copy measured at a fixed width (PAInkFrame's measureAt) wraps at
  // that width, every other line at the list's.
  const colsOf = (line) => (line.fixedW ? Math.max(1, Math.floor(line.fixedW / L.cw)) : cols());
  const clones = [];
  const tn = (data) => ({ nodeType: 3, data });
  function lineEl(verse, lang, text) {
    const e = { nodeType: 1, lang, verse, childNodes: [tn(text)], top: 0 };
    e.getBoundingClientRect = () => ({ left: PADL, top: e.top - L.scrollTop, width: Math.min(text.length, cols()) * L.cw, height: rowsOf(text) * RH });
    e.style = {};
    // cloneNode: a copy the component sizes with style.cssText 'width:Npx' and appends to the verse; it wraps at N.
    e.cloneNode = () => { const c = lineEl(verse, lang, e.text()); c.clone = true; Object.defineProperty(c.style, 'cssText', { set(v) { const m = /width:([\d.]+)px/.exec(v); c.fixedW = m ? +m[1] : 0; } });
      c.getBoundingClientRect = () => ({ left: 0, top: 0, width: c.fixedW, height: rowsOf(c.text(), colsOf(c)) * RH }); return c; };
    e.text = () => e.childNodes.map((n) => n.nodeType === 3 ? n.data : n.childNodes.map((c) => c.data).join('')).join('');
    return e;
  }
  const verses = [], container = {
    nodeType: 1, style: {}, children: [], scrollLeft: 0, clientLeft: 0, clientTop: 0,
    get scrollTop() { return L.scrollTop; }, set scrollTop(v) { L.scrollTop = v; },
    get scrollWidth() { return L.width; },
    // In-flow children (the orphan bucket) add to the content; childrenCount: a real scroller's scrollHeight
    // also includes its absolutely-positioned children (the canvas).
    get scrollHeight() { const flow = layout() + bucketH(); return childrenCount ? Math.max(flow, ...container.children.map((c) => parseFloat(c.style.height) || 0)) : flow; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: L.width, height: 600 }),
    querySelectorAll: (sel) => (sel === '.verse' ? verses : []),
    appendChild(c) { c.parentNode = container; container.children.push(c); return c; },
    removeChild(c) { c.parentNode = null; container.children = container.children.filter((x) => x !== c); },
    addEventListener: (t, f, o) => { L.listeners.set(t + (o === true || (o && o.capture) ? ':capture' : ''), f); },
    removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {},
  };
  const bucketEl = () => container.children.find((c) => c.className === 'pia-bucket' && c.parentNode === container);
  const bucketH = () => { const b = bucketEl(); return b ? parseFloat(b.style.height) || 0 : 0; };
  function layout() {   // stacks the verses; returns the content height
    let y = PADT;
    for (const v of verses) { y += VNUM; v.en.top = y; y += rowsOf(v.en.text()) * RH + GAP; v.zh.top = y; y += rowsOf(v.zh.text()) * RH + 10; }
    return y;
  }
  function addVerse(n, en, zh) {
    const v = { dataset: { n: String(n) }, en: lineEl(n, 'en', en), zh: lineEl(n, 'zh', zh) };
    for (const ln of [v.en, v.zh]) ln.parentNode = { appendChild(c) { c.parentNode = this; clones.push(c); L.clonesMade = (L.clonesMade || 0) + 1; }, removeChild(c) { clones.splice(clones.indexOf(c), 1); } };
    v.querySelector = (sel) => (sel === '.ven' ? v.en : sel === '.vzh' ? v.zh : null);
    verses.push(v); layout(); return v;
  }
  // The char rect model the Range reports: char i of a line sits at column i % cols, row i / cols.
  const charRect = (line, i) => (line.clone ? { left: (i % colsOf(line)) * L.cw, top: Math.floor(i / colsOf(line)) * RH, width: L.cw, height: RH }
    : { left: PADL + (i % cols()) * L.cw, top: line.top - L.scrollTop + Math.floor(i / cols()) * RH, width: L.cw, height: RH });
  const ownerLine = (node) => [...verses.flatMap((v) => [v.en, v.zh]), ...clones].find((l) => l.childNodes.includes(node) || l.childNodes.some((c) => c.nodeType === 1 && c.childNodes.includes(node)));
  const offsetIn = (line, node, off) => { let k = 0; for (const c of line.childNodes) { const kids = c.nodeType === 3 ? [c] : c.childNodes; for (const t of kids) { if (t === node) return k + off; k += t.data.length; } } throw new Error('node not in line'); };
  const document = {
    createElement: (tag) => { const ctx = { ops: [], stroke() { this.ops.push('stroke'); }, clearRect() { this.ops.push('clear'); }, setTransform() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, arc() {}, fill() {} };
      const e = { tag, style: {}, parentNode: null, className: '', textContent: '', children: [], getContext: () => ctx, ctx,
        appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
        // an in-flow block appended after the verses: the bucket sits under the content, as wide as the list
        getBoundingClientRect: () => ({ left: PADL, top: layout() - L.scrollTop, width: L.width - 2 * PADL, height: parseFloat(e.style.height) || 0 }) };
      return e; },
    createRange: () => { const r = {}; return { setStart(n, o) { r.s = [n, o]; }, setEnd(n, o) { r.e = [n, o]; },
      // one rect per row the range touches, as a browser reports a wrapped run (getClientRects)
      getClientRects() { const line = ownerLine(r.s[0]); const s = offsetIn(line, r.s[0], r.s[1]), e = offsetIn(line, r.e[0], r.e[1]); const rows = new Map();
        for (let i = s; i < e; i++) { const c = charRect(line, i), k = c.top; const u = rows.get(k); rows.set(k, !u ? c : { ...u, width: c.left + c.width - u.left }); }
        return [...rows.values()]; },
      getBoundingClientRect() { const line = ownerLine(r.s[0]); const s = offsetIn(line, r.s[0], r.s[1]), e = offsetIn(line, r.e[0], r.e[1]);
        if (e <= s) return { left: 0, top: 0, width: 0, height: 0 };
        let u = null; for (let i = s; i < e; i++) { const c = charRect(line, i); u = !u ? c : { left: Math.min(u.left, c.left), top: Math.min(u.top, c.top), width: Math.max(u.left + u.width, c.left + c.width) - Math.min(u.left, c.left), height: Math.max(u.top + u.height, c.top + c.height) - Math.min(u.top, c.top) }; }
        return u; } }; },
  };
  const window = { devicePixelRatio: 2, innerWidth: width, innerHeight: 600, addEventListener: (t, f) => L.listeners.set('w:' + t, f), removeEventListener() {}, requestAnimationFrame: (f) => L.raf.push(f) };
  const setTimeout = (f) => L.timers.push(f);
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', scriptOf(FRAME) + '\n' + scriptOf(src))(window, document, setTimeout);
  const ev = (type, extra) => Object.assign({ type, preventDefault() { L.prevented.push(type); }, stopPropagation() { L.stopped++; }, stopImmediatePropagation() { L.stopped++; } }, extra);
  const fire = (key, e) => { const f = L.listeners.get(key); if (!f) throw new Error('no listener ' + key); return f(e); };
  const flush = () => { while (L.raf.length || L.timers.length) { (L.raf.shift() || L.timers.shift())(); } };
  return { PAInkAnchor: window.PAInkAnchor, L, container, verses, addVerse, charRect, document, window, ev, fire, flush, cols, bucketEl };
}
export const VERSES = [[16, 'For God so loved the world', '神爱世人'], [17, 'For God did not send', '因为神差他的儿子']];
// A pen stroke: an underline from the left edge of char `s` to the right edge of char `e-1`, 3px under the row's middle.
export function penStroke(dom, line, s, e, id = 7) {
  const a = dom.charRect(line, s), b = dom.charRect(line, e - 1), y = a.top + RH * 0.75, xs = [a.left + 1, (a.left + b.left + CW) / 2, b.left + CW - 1];
  dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: 'pen', pointerId: id, clientX: xs[0], clientY: y, pressure: 0.6 }));
  dom.fire('w:pointermove', dom.ev('pointermove', { pointerId: id, clientX: xs[1], clientY: y + 1, pressure: 0.7 }));
  dom.fire('w:pointermove', dom.ev('pointermove', { pointerId: id, clientX: xs[2], clientY: y, pressure: 0.6 }));
  dom.fire('w:pointerup', dom.ev('pointerup', { pointerId: id, clientX: xs[2], clientY: y }));
}
