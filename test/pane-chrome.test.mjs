// PAPaneChrome — the pane header's Float / Close, the float window and the remembered layout
// (web/pane-chrome.inline.html, ADR 0031). User flows run over the REAL split-ui, app-prefs and
// pane-chrome scripts in a fake DOM; the "shell" answers app-settings / set-app-settings the way the
// real broker does (one prefs object per app). No real timers: setTimeout is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, mediaMatches } from './helpers-app.mjs';

const read = (f) => fs.readFileSync(path.join(ROOT, 'web', f), 'utf8');
const scriptIn = (html) => [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
const SPLIT = scriptIn(read('split-ui.inline.html'));
const PREFS = scriptIn(read('app-prefs.inline.html'));
const CHROME = scriptIn(read('pane-chrome.inline.html'));

function mkEl(tag) {
  const cls = new Set();
  const n = {
    tag, textContent: '', title: '', type: '', dataset: {}, children: [], attrs: {}, _h: {}, parentNode: null,
    style: { _p: {}, setProperty(k, v) { this._p[k] = v; }, removeProperty(k) { delete this._p[k]; } },
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (c) => cls.has(c),
      toggle: (c, on) => { const w = on === undefined ? !cls.has(c) : !!on; if (w) cls.add(c); else cls.delete(c); return w; },
    },
    get firstChild() { return n.children[0] || null; },
    appendChild(c) { return n.insertBefore(c, null); },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      const i = ref ? n.children.indexOf(ref) : -1;
      n.children.splice(i < 0 ? n.children.length : i, 0, c); c.parentNode = n; return c;
    },
    removeChild(c) { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { n.attrs[k] = String(v); }, getAttribute: (k) => (k in n.attrs ? n.attrs[k] : null),
    addEventListener(t, f) { (n._h[t] = n._h[t] || []).push(f); },
    removeEventListener(t, f) { n._h[t] = (n._h[t] || []).filter((x) => x !== f); },
    fire(t, ev) {
      let stopped = false;
      const e = { preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() { stopped = true; }, currentTarget: n, ...ev };
      for (const f of (n._h[t] || []).slice()) { f(e); if (stopped) return; }
      if (typeof n['on' + t] === 'function') n['on' + t](e);
    },
    setPointerCapture() {}, getBoundingClientRect: () => ({ width: 380, height: 700, left: 0, top: 0 }),
    querySelectorAll: () => [],
  };
  Object.defineProperty(n, 'className', {
    get: () => [...cls].join(' '),
    set: (v) => { cls.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
  });
  return n;
}
const walk = (n, f, out = []) => { if (f(n)) out.push(n); n.children.forEach((c) => walk(c, f, out)); return out; };
const byClass = (n, c) => walk(n, (x) => x.classList.contains(c));

// One page: shell store (shared across "remounts" when passed in), window, document, the three scripts.
function page({ width = 1280, height = 800, store = { prefs: {} }, refuseRead = false, chrome = true } = {}) {
  const html = mkEl('html'), body = mkEl('body'); html.appendChild(body);
  const wl = {}, mqls = [];
  const win = {
    innerWidth: width, innerHeight: height,
    matchMedia: (q) => { const m = { _s: [], get matches() { return mediaMatches(q, win.innerWidth, win.innerHeight); },
      addEventListener(t, f) { m._s.push(f); } }; mqls.push(m); return m; },
    addEventListener(t, f) { (wl[t] = wl[t] || []).push(f); },
    removeEventListener(t, f) { wl[t] = (wl[t] || []).filter((x) => x !== f); },
  };
  const writes = [];
  const reply = (m) => {
    let r;
    if (m.kind === 'app-settings') r = refuseRead ? { ok: false, error: 'offline' } : { ok: true, prefs: JSON.parse(JSON.stringify(store.prefs)), systemPrompt: { override: '' } };
    else if (m.kind === 'set-app-settings') { store.prefs = JSON.parse(JSON.stringify(m.prefs)); writes.push(store.prefs); r = { ok: true }; }
    else r = { ok: false, error: 'unknown' };
    (wl.message || []).slice().forEach((f) => f({ data: { pa: 'res', id: m.id, ...r } }));
  };
  const parent = { postMessage: (m) => queueMicrotask(() => reply(m)) };
  const doc = { documentElement: html, body, createElement: mkEl, querySelector: () => null,
    addEventListener() {}, removeEventListener() {} };
  const timers = { setTimeout: () => 0, clearTimeout: () => {} };   // stubbed: no real timer in a fake-DOM test
  const run = (src) => new Function('window', 'document', 'parent', 'setTimeout', 'clearTimeout', src)(win, doc, parent, timers.setTimeout, timers.clearTimeout);
  run(SPLIT); run(PREFS); if (chrome) run(CHROME);
  const rail = win.PASplit.open({ slots: [
    { key: 'chat', title: 'Ask AI · 问一问', zone: 'right', collapsed: true, mount: () => ({}) },
    { key: 'note', title: 'Note · 笔记', zone: 'bottom', collapsed: true, mount: () => ({}) },
  ] });
  const head = (k) => byClass(body, 'pas-head').find((h) => h.children.some((c) => c.textContent === (k === 'chat' ? 'Ask AI · 问一问' : 'Note · 笔记')));
  const btn = (k, c) => byClass(head(k), c)[0];
  const rotate = (w, h) => { win.innerWidth = w; win.innerHeight = h; (wl.resize || []).slice().forEach((f) => f({})); mqls.forEach((m) => m._s.forEach((f) => f())); };
  return { win, html, body, rail, head, btn, store, writes, rotate };
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const floatWin = (p) => byClass(p.body, 'pch-win').find((w) => w.parentNode === p.body);
const layout = (p) => p.store.prefs.paneLayout || {};

test('R14 control: every slot header gets Float and Close only when the chrome is on the page', async () => {
  const p = page(); await settle();
  for (const k of ['chat', 'note']) {
    assert.ok(p.btn(k, 'pch-float-btn'), `${k}: Float`); assert.ok(p.btn(k, 'pch-close-btn'), `${k}: Close`);
    assert.ok(p.btn(k, 'pas-zoom'), `${k}: Maximise stays PASplit's own ⤢`);
  }
  const bare = page({ chrome: false });
  assert.equal(bare.btn('chat', 'pch-float-btn'), undefined, 'without the component there is nothing to find — the checks above can fail');
});

test('float: the pane leaves the rail for a window inside the viewport, and the layout is saved', async () => {
  const p = page(); await settle();
  p.rail.open(); p.rail.expand('chat');
  assert.ok(p.rail.el.classList.contains('on'), 'docked: the rail shows');
  p.btn('chat', 'pch-float-btn').fire('click');
  const w = floatWin(p);
  assert.ok(w, 'a float window is on the page');
  assert.ok(byClass(w, 'pas-slot').length === 1, 'holding the chat slot');
  assert.equal(p.rail.el.classList.contains('on'), false, 'the rail, now empty, stops pushing the page');
  const [x, y, ww, hh] = ['left', 'top', 'width', 'height'].map((k) => parseInt(w.style[k], 10));
  assert.ok(x >= 0 && y >= 0 && x + ww <= 1280 && y + hh <= 800, `inside 1280x800: ${x},${y} ${ww}x${hh}`);
  await settle();
  assert.equal(layout(p).chat.mode, 'floating', 'written through PAAppPrefs');
  assert.deepEqual(layout(p).chat.rect, { x, y, w: ww, h: hh });
  p.btn('chat', 'pch-float-btn').fire('click');            // the same control re-docks
  assert.equal(floatWin(p), undefined, 're-docked: the window is gone');
  assert.ok(p.rail.el.classList.contains('on'), 'and the rail shows it again');
  await settle(); assert.equal(layout(p).chat.mode, 'docked');
});

test('drag by the header and resize from the corner are clamped to the viewport', async () => {
  const p = page(); await settle();
  p.rail.open(); p.rail.expand('chat'); p.btn('chat', 'pch-float-btn').fire('click');
  const w = floatWin(p), h = p.head('chat');
  h.fire('pointerdown', { clientX: 100, clientY: 100, target: h });
  h.fire('pointermove', { clientX: 9000, clientY: 9000 });
  assert.equal(parseInt(w.style.left, 10) + parseInt(w.style.width, 10), 1280, 'pinned to the right edge, not off it');
  assert.equal(parseInt(w.style.top, 10) + parseInt(w.style.height, 10), 800, 'and to the bottom');
  h.fire('pointermove', { clientX: -9000, clientY: -9000 });
  assert.equal(w.style.left, '0px'); assert.equal(w.style.top, '0px');
  h.fire('pointerup', {});
  h.fire('click', {});
  assert.equal(p.rail.isCollapsed('chat'), false, 'the click that ends a drag does not collapse the pane');
  const grip = byClass(w, 'pch-grip')[0];
  h.fire('pointerdown', { clientX: 0, clientY: 0, target: h }); h.fire('pointermove', { clientX: 200, clientY: 150 }); h.fire('pointerup', {});
  h.fire('click', {});
  grip.fire('pointerdown', { clientX: 0, clientY: 0 }); grip.fire('pointermove', { clientX: 9000, clientY: 9000 }); grip.fire('pointerup', {});
  assert.equal(w.style.left, '200px', 'a resize past the edge does not move the window'); assert.equal(w.style.top, '150px');
  assert.equal(w.style.width, '1080px', 'resize stops at the right edge'); assert.equal(w.style.height, '650px', 'and the bottom');
  grip.fire('pointerdown', { clientX: 0, clientY: 0 }); grip.fire('pointermove', { clientX: -9000, clientY: -9000 }); grip.fire('pointerup', {});
  assert.equal(w.style.width, p.win.PAPaneChrome.MIN_W + 'px', 'and never below the minimum');
  p.rotate(800, 600);
  assert.ok(parseInt(w.style.left, 10) + parseInt(w.style.width, 10) <= 800, 'a smaller viewport pulls the window back in');
});

test('a plain click on a floating pane\'s header keeps it floating and open (regression)', async () => {
  const p = page(); await settle();
  p.rail.open(); p.rail.expand('chat'); p.btn('chat', 'pch-float-btn').fire('click');
  const w = floatWin(p), h = p.head('chat');
  h.fire('click', { target: h });
  assert.equal(p.rail.isCollapsed('chat'), false, 'not collapsed');
  assert.equal(floatWin(p), w, 'the window is still on the page');
  assert.ok(w.children.includes(byClass(p.body, 'pas-head').includes(h) ? h.parentNode : null), 'the pane is still inside it');
  await settle(); assert.equal(layout(p).chat.mode, 'floating');
});

test('float and close on a maximised pane write the layout once each', async () => {
  const p = page(); await settle();
  p.rail.open(); p.rail.expand('chat'); p.btn('chat', 'pas-zoom').fire('click'); await settle();
  let n = p.writes.length; p.btn('chat', 'pch-float-btn').fire('click'); await settle();
  assert.equal(p.writes.length - n, 1, 'float from max: one write'); assert.equal(layout(p).chat.mode, 'floating');
  p.btn('chat', 'pch-float-btn').fire('click'); p.btn('chat', 'pas-zoom').fire('click'); await settle();
  n = p.writes.length; p.btn('chat', 'pch-close-btn').fire('click'); await settle();
  assert.equal(p.writes.length - n, 1, 'close from max: one write'); assert.equal(layout(p).chat.mode, 'max');
});

test('maximise then restore, remembered as max then docked; maximising a floating pane docks it first', async () => {
  const p = page(); await settle();
  p.rail.open(); p.rail.expand('chat');
  p.btn('chat', 'pas-zoom').fire('click');
  assert.equal(p.rail.isMaxed('chat'), true); await settle();
  assert.equal(layout(p).chat.mode, 'max');
  p.btn('chat', 'pas-zoom').fire('click');
  assert.equal(p.rail.isMaxed(), false); await settle();
  assert.equal(layout(p).chat.mode, 'docked');
  p.btn('chat', 'pch-float-btn').fire('click');
  p.btn('chat', 'pas-zoom').fire('click');
  assert.equal(floatWin(p), undefined, 'no float window behind a maximised pane');
  assert.equal(p.rail.isMaxed('chat'), true);
});

test('close: the pane closes (floating or not) and keeps its mode for the next open', async () => {
  const p = page(); await settle();
  p.rail.open(); p.rail.expand('chat'); p.btn('chat', 'pch-float-btn').fire('click');
  p.btn('chat', 'pch-close-btn').fire('click');
  assert.equal(p.rail.isCollapsed('chat'), true, 'closed');
  assert.equal(floatWin(p), undefined, 'its window is gone');
  await settle(); assert.equal(layout(p).chat.mode, 'floating', 'still remembered as floating');
  p.rail.expand('chat');
  assert.ok(floatWin(p), 'and it reopens floating');
});

test('float, Close, then a header click reopens the pane floating; shut in the rail while closed (regression)', async () => {
  const p = page(); await settle();
  p.rail.open(); p.rail.expand('chat'); p.btn('chat', 'pch-float-btn').fire('click');
  p.btn('chat', 'pch-close-btn').fire('click');
  const h = p.head('chat'), slot = h.parentNode;
  assert.equal(floatWin(p), undefined, 'window gone');
  assert.ok(slot.classList.contains('pas-shut'), 'closed slot is laid out shut in the rail');
  assert.equal(h.getAttribute('aria-expanded'), 'false');
  h.fire('click', { target: h });
  assert.equal(p.rail.isCollapsed('chat'), false, 'the header click reopens it');
  assert.ok(floatWin(p), 'and it reopens floating');
});

test('remount: the account layout comes back when each pane opens; a pane with no entry stays docked', async () => {
  const store = { prefs: { other: 1, paneLayout: { chat: { mode: 'floating', rect: { x: 50, y: 60, w: 300, h: 250 } }, note: { mode: 'max' } } } };
  const p = page({ store }); await settle();
  assert.equal(floatWin(p), undefined, 'nothing floats while its pane is closed');
  p.rail.open(); p.rail.expand('chat');
  const w = floatWin(p);
  assert.ok(w, 'chat reopens floating');
  assert.deepEqual(['left', 'top', 'width', 'height'].map((k) => w.style[k]), ['50px', '60px', '300px', '250px']);
  p.rail.expand('note');
  assert.equal(p.rail.isMaxed('note'), true, 'note reopens maximised');
  await settle();
  assert.equal(store.prefs.other, 1, 'other app prefs survive the writes (PAAppPrefs merges)');
  const fresh = page({ store: { prefs: {} } }); await settle();
  fresh.rail.open(); fresh.rail.expand('chat'); fresh.rail.expand('note');
  assert.equal(floatWin(fresh), undefined, 'control: no entry, no float');
  assert.equal(fresh.rail.isMaxed(), false, 'control: no entry, never maximised on its own');
});

test('a refused layout read is shown on the pane header (R5) and the panes still work docked', async () => {
  const p = page({ refuseRead: true }); await settle();
  const err = byClass(p.head('chat'), 'pch-err')[0];
  assert.ok(err && /Layout not loaded · 布局未读取/.test(err.textContent), 'shown, bilingual');
  p.rail.open(); p.rail.expand('chat');
  assert.ok(p.rail.el.classList.contains('on'));
});

test('narrow screens hide Float and Maximise through PASplit\'s own gate', async () => {
  const p = page(); await settle();
  assert.equal(p.html.classList.contains('pch-narrow'), false);
  p.rotate(768, 1024);
  assert.equal(p.html.classList.contains('pch-narrow'), true, 'iPad portrait: hidden');
  const css = /<style id="pch-style">([\s\S]*?)<\/style>/.exec(read('pane-chrome.inline.html'))[1];
  assert.match(css, /html\.pch-narrow \.pch-float-btn,html\.pch-narrow \.pas-zoom\{display:none\}/);
  assert.doesNotMatch(read('pane-chrome.inline.html'), /min-width:820px/, 'no second copy of the gate (R3)');
});

test('served: split-ui carries the marker after its script; web.mjs registers pane-chrome last', () => {
  assert.ok(read('split-ui.inline.html').trimEnd().endsWith('</script>\n<!--PA_PANE_CHROME_UI-->'));
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  const list = web.slice(web.indexOf('const PA_COMPONENTS = ['), web.indexOf('\n];', web.indexOf('const PA_COMPONENTS = [')));
  const files = [...list.matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(files[files.length - 5], 'pane-chrome.inline.html');
  assert.deepEqual(files.slice(-4), ['app-bar.inline.html', 'bar-handle.css', 'reading-history.inline.html', 'ink-frame.inline.html'], 'PAAppBar, appended after it (ADR 0032), then its handle size (ADR 0034), then PAReadingHistory, then PAInkFrame');
});

// Browser test 2026-11-13: the FIRST float (no saved rect) opened at the minimum size in the top-left
// corner, because Number(null) is 0. An unset rect takes the default size at the right of the viewport.
test("first float with no saved rect takes the default size at the right, not 0,0 at the minimum", async () => {
  const C = page().win.PAPaneChrome; await settle();
  const r = C.clamp(null, 1160, 647);
  assert.deepEqual(r, { x: 1160 - 420 - 24, y: 56, w: 420, h: 480 });
  assert.deepEqual(C.clamp(undefined, 1160, 647), r);
});

// GPT release review 2026-11-13: Escape / rail.close() hid the rail but left a floating pane on screen,
// while the app's top-bar button already showed it closed. Reopening brings the float back.
test('closing the rail takes a floating pane down with it, and opening brings it back floating', async () => {
  const p = page(); await settle();
  p.rail.open(); p.rail.expand('chat'); p.btn('chat', 'pch-float-btn').fire('click');
  assert.ok(floatWin(p), 'floating');
  p.rail.close();
  assert.equal(floatWin(p), undefined, 'no floating window survives the rail closing');
  p.rail.open(); p.rail.expand('chat');
  assert.ok(floatWin(p), 'the remembered float comes back');
});

// GPT release review 2026-11-13: destroying the rail mid-drag (iPad crossing the layout gate) left
// html.pch-moving set, which blocks text selection and pane pointer events.
test('destroying the rail during a drag ends the gesture', async () => {
  const p = page(); await settle();
  p.rail.open(); p.rail.expand('chat'); p.btn('chat', 'pch-float-btn').fire('click');
  const h = p.head('chat');
  h.fire('pointerdown', { clientX: 10, clientY: 10, target: h });
  assert.ok(p.html.classList.contains('pch-moving'), 'drag in progress');
  p.rail.destroy();
  assert.equal(p.html.classList.contains('pch-moving'), false, 'gesture ended by destroy');
});

test('two floating panes: the one pressed comes to the front (regression: Note stuck under Ask AI)', async () => {
  const p = page(); await settle();
  p.rail.open(); p.rail.expand('chat'); p.btn('chat', 'pch-float-btn').fire('click');
  p.rail.expand('note'); p.btn('note', 'pch-float-btn').fire('click');
  const wins = byClass(p.body, 'pch-win').filter((w) => w.parentNode === p.body);
  assert.equal(wins.length, 2, 'both panes float');
  const holds = (w, k) => byClass(w, 'pas-head').some((h) => h === p.head(k));
  const chat = wins.find((w) => holds(w, 'chat')), note = wins.find((w) => holds(w, 'note'));
  const front = () => wins.filter((w) => w.classList.contains('pch-front'));
  assert.deepEqual(front(), [note], 'the pane floated last starts on top');
  chat.fire('pointerdown', { target: chat });
  assert.deepEqual(front(), [chat], 'pressing the chat raises it, and only it');
  note.fire('pointerdown', { target: note });
  assert.deepEqual(front(), [note], 'pressing the note brings it back to the front');
});
