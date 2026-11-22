// Fakes for test/tips.test.mjs: a minimal DOM element, a stubbed frame queue, stubbed observers. No real timers.
export function fakeEl(tag, rect, natW = 220) {
  const cls = new Set(), h = {};
  const n = { tag, children: [], attrs: {}, style: {}, textContent: '', parentNode: null, rect, isConnected: true,
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute: (k) => n.attrs[k],
    appendChild(c) { n.children.push(c); c.parentNode = n; return c; },
    removeChild(c) { n.children = n.children.filter((x) => x !== c); c.parentNode = null; },
    addEventListener(t, f) { (h[t] = h[t] || []).push(f); },
    fire(t) { const e = { target: n, stopPropagation() {}, preventDefault() {} }; (h[t] || []).forEach((f) => f(e)); },
    getBoundingClientRect() {
      if (n.rect) return { ...n.rect, right: n.rect.left + n.rect.width, bottom: n.rect.top + n.rect.height };
      const o = (n.parentNode && n.parentNode.cb) || { left: 0, top: 0 };   // containing-block offset (margin / transform)
      const top = (parseFloat(n.style.top) || 0) + o.top, left = (parseFloat(n.style.left) || 0) + o.left;   // a tip: natW × 40
      const w = parseFloat(n.style.width) || Math.min(natW, parseFloat(n.style.maxWidth) || Infinity);
      return { top, left, width: w, height: 40, right: left + w, bottom: top + 40 };
    } };
  Object.defineProperty(n, 'className', { get: () => [...cls].join(' '), set: (v) => { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); } });
  return n;
}

export const frames = () => { const q = []; const raf = (f) => { q.push(f); return q.length; }; raf.run = () => q.splice(0).forEach((f) => f()); raf.q = q; return raf; };

// A Resize/Mutation/IntersectionObserver stub: fire() calls every connected observer's callback.
export function obsStub() {
  const all = [];
  class O { constructor(cb) { this.cb = cb; this.els = []; all.push(this); } observe(el) { this.els.push(el); } disconnect() { this.els = []; } }
  O.fire = () => all.forEach((o) => { if (o.els.length) o.cb([]); }); O.all = all; return O;
}
export const roStub = obsStub;
