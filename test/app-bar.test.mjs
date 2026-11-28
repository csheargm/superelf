// PAAppBar (web/app-bar.inline.html, ADR 0032) with NO browser, so these run when Playwright is
// absent (the real-browser flows live in test/app-own-bar-e2e.test.mjs and skip there). The component
// runs in a vm with a minimal DOM stub; the host wiring in Bible and Journal is pinned by source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers-app.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPT = read('web/app-bar.inline.html').match(/<script id="paab-script">([\s\S]*?)<\/script>/)[1];

function fakeEl(tag) {
  const e = { tag, children: [], style: {}, attrs: {}, listeners: {}, parentNode: null, inert: false,
    classList: { set: new Set(), add(c) { this.set.add(c); }, toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    append(...cs) { cs.forEach((c) => this.appendChild(c)); },
    insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? 0 : i, 0, c); return c; },
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; },
    contains(x) { return x === this || this.children.some((c) => c.contains(x)); },
    querySelector() { return null; }, get firstChild() { return this.children[0] || null; }, offsetHeight: 40 };
  return e;
}
// A fake clock (the idle hide is IDLE_MS): clock.advance(ms) fires due timers in order.
function fakeClock() {
  let now = 0, id = 0; const due = new Map();
  return { setTimeout: (f, ms) => { due.set(++id, { f, at: now + ms }); return id; }, clearTimeout: (i) => due.delete(i),
    advance(ms) { const end = now + ms; for (;;) { const next = [...due].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break; due.delete(next[0]); now = next[1].at; next[1].f(); } now = end; } };
}
function document_hidden(docL) { docL.__doc.hidden = true; (docL.visibilitychange || []).forEach((f) => f({})); }
function run({ scroller, hoverNone = true } = {}) {
  const docL = {}, winL = {}, clock = fakeClock();
  const body = fakeEl('body');
  const document = { body, activeElement: null, createElement: fakeEl, addEventListener(t, f) { (docL[t] ||= []).push(f); } };
  docL.__doc = document;
  const win = { document, getComputedStyle: () => ({ position: 'static' }), matchMedia: (q) => ({ matches: q === '(hover:none)' ? hoverNone : false, addEventListener() {} }),
    addEventListener(t, f, o) { (winL[t] ||= []).push(f); (win.opts ||= {})[t] = o; }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  win.parent = { postMessage() {} }; win.window = win;
  vm.runInNewContext(SCRIPT, win);
  const bar = fakeEl('div');
  win.PAAppBar.attach({ bar, scroller, keepOpen: () => win.keep === true });
  winL.message.forEach((f) => f({ data: { pa: 'prefs', ownBar: true }, source: win.parent }));
  const emit = (t, e) => (winL[t] || []).forEach((f) => f(e));
  const touch = (x, y, extra = {}) => ({ clientX: x, clientY: y, ...extra });
  // A one-finger drag from (x,y0) to (x,y1), as touchstart / touchmove / touchend.
  const drag = (y0, y1, { x = 100, pointerType = 'touch', touchType = 'direct' } = {}) => {
    emit('pointerdown', { pointerType });
    emit('touchstart', { touches: [touch(x, y0, { touchType })] });
    for (let k = 1; k <= 4; k++) emit('touchmove', { touches: [touch(x, y0 + ((y1 - y0) * k) / 4, { touchType })] });
    emit('touchend', { touches: [] }); emit('pointerup', { pointerType });
  };
  return { win, bar, docL, winL, clock, drag, emit, handle: body.children.find((c) => c.className === 'paab-handle') };
}

test('hidden bar is inert (out of the tab order / VoiceOver); shown again it is not', () => {
  const { win, bar } = run();
  assert.equal(win.PAAppBar.state().mounted, true);
  win.PAAppBar.hide();
  assert.equal(bar.inert, true, 'inert while hidden'); assert.equal(bar.getAttribute('data-paab-hidden'), '1');
  win.PAAppBar.show();
  assert.equal(bar.inert, false, 'inert cleared when shown');
});

test('idle: shown on open, hides itself after IDLE_MS; keepOpen holds it and it hides once released', () => {
  const { win, clock } = run();
  const ms = win.PAAppBar.IDLE_MS;
  assert.ok(ms >= 3000 && ms <= 5000, 'about 4 s');
  clock.advance(ms - 50); assert.equal(win.PAAppBar.state().hidden, false, 'still up just before');
  clock.advance(100); assert.equal(win.PAAppBar.state().hidden, true, 'hidden after the idle time');
  win.PAAppBar.show(); win.keep = true; clock.advance(ms * 3);
  assert.equal(win.PAAppBar.state().hidden, false, 'never hides while keepOpen');
  win.keep = false; clock.advance(ms + 10);
  assert.equal(win.PAAppBar.state().hidden, true, 'hides once the menu is gone');
});

test('a pointer released outside the frame (no pointerup) is cleared by a buttonless move (pen: a mouse never idles the bar, F2-06)', () => {
  const { win, clock, emit } = run();
  const ms = win.PAAppBar.IDLE_MS;
  emit('pointerdown', { pointerType: 'pen', pointerId: 7 }); clock.advance(ms * 3);
  assert.equal(win.PAAppBar.state().hidden, false, 'held while down');
  emit('pointermove', { pointerType: 'pen', pointerId: 7, buttons: 1 }); clock.advance(ms + 10);
  assert.equal(win.PAAppBar.state().hidden, false, 'a drag with the button still down keeps it');
  emit('pointermove', { pointerType: 'pen', pointerId: 7, buttons: 0 }); clock.advance(ms + 10);
  assert.equal(win.PAAppBar.state().hidden, true, 'idle hide resumes after the lost pointerup');
});

test('never hides mid-stroke (a pointer is down), however long; only a real end signal releases it', () => {
  const { win, clock, emit, docL } = run();
  const ms = win.PAAppBar.IDLE_MS;
  emit('pointerdown', { pointerType: 'pen', pointerId: 2 }); clock.advance(ms * 10);
  assert.equal(win.PAAppBar.state().hidden, false, 'held through a 40 s Pencil stroke (no retry cap)');
  emit('pointerup', { pointerType: 'pen', pointerId: 2 }); clock.advance(ms + 10);
  assert.equal(win.PAAppBar.state().hidden, true, 'hides after the stroke');
  win.PAAppBar.show(); emit('pointerdown', { pointerType: 'pen', pointerId: 1 }); clock.advance(ms * 5);
  assert.equal(win.PAAppBar.state().hidden, false, 'still down: held');
  emit('blur', {}); clock.advance(ms + 10);
  assert.equal(win.PAAppBar.state().hidden, true, 'a lost pointerup is cleared by blur');
  win.PAAppBar.show(); emit('pointerdown', { pointerType: 'pen', pointerId: 3 });
  emit('lostpointercapture', { pointerType: 'pen', pointerId: 3 }); clock.advance(ms + 10);
  assert.equal(win.PAAppBar.state().hidden, true, 'lostpointercapture ends it');
  win.PAAppBar.show(); emit('pointerdown', { pointerType: 'pen', pointerId: 4 });
  document_hidden(docL); clock.advance(ms + 10);
  assert.equal(win.PAAppBar.state().hidden, true, 'visibilitychange to hidden clears it');
});

test('a finger stays down through iOS pointercancel (native scroll took it) until touchend', () => {
  const { win, clock, emit } = run();
  const ms = win.PAAppBar.IDLE_MS;
  emit('pointerdown', { pointerType: 'touch', pointerId: 7 });
  emit('touchstart', { touches: [{ clientX: 100, clientY: 400 }] });
  emit('pointercancel', { pointerType: 'touch', pointerId: 7 }); clock.advance(ms * 5);
  assert.equal(win.PAAppBar.state().hidden, false, 'finger still on the glass: held');
  emit('touchend', { touches: [] }); clock.advance(ms + 10);
  assert.equal(win.PAAppBar.state().hidden, true, 'hides after touchend');
  win.PAAppBar.show(); emit('touchstart', { touches: [{ clientX: 1, clientY: 1 }] });
  emit('touchcancel', { touches: [] }); clock.advance(ms + 10);
  assert.equal(win.PAAppBar.state().hidden, true, 'touchcancel ends it');
});

test('hold(true) keeps the bar until hold(false)', () => {
  const { win, clock } = run();
  win.PAAppBar.hold(true); clock.advance(win.PAAppBar.IDLE_MS * 3);
  assert.equal(win.PAAppBar.state().hidden, false);
  win.PAAppBar.hold(false); clock.advance(win.PAAppBar.IDLE_MS + 10);
  assert.equal(win.PAAppBar.state().hidden, true);
});

test('a use of the bar restarts the idle clock', () => {
  const { win, bar, clock } = run();
  const ms = win.PAAppBar.IDLE_MS;
  clock.advance(ms - 500); fire(bar, 'pointerdown'); fire(bar, 'click');
  clock.advance(ms - 500); assert.equal(win.PAAppBar.state().hidden, false, 'the tap bought a fresh IDLE_MS');
  clock.advance(600); assert.equal(win.PAAppBar.state().hidden, true);
});

test('a finger swipe up hides at once (owner final, ADR 0036); pull down shows; keepOpen beats the swipe', () => {
  const { win, drag } = run();
  drag(400, 100); assert.equal(win.PAAppBar.state().hidden, true, 'swipe up hides, no idle wait');
  drag(100, 400); assert.equal(win.PAAppBar.state().hidden, false, 'a pull down shows it');
  win.keep = true; drag(400, 100); assert.equal(win.PAAppBar.state().hidden, false, 'a menu from the bar is open: stays');
  win.keep = false; drag(400, 100); assert.equal(win.PAAppBar.state().hidden, true, 'menu closed: the swipe hides');
  win.PAAppBar.show(); drag(100, 100 - win.PAAppBar.PULL_PX + 4); assert.equal(win.PAAppBar.state().hidden, false, 'a swipe shorter than PULL_PX: nothing');
  drag(100, 400, { pointerType: 'pen' }); drag(400, 100, { touchType: 'stylus' }); assert.equal(win.PAAppBar.state().hidden, false, 'a Pencil swipe up never hides');
});

test('scroller: a user scroll forward hides, scroll up shows; a programmatic jump on open does not hide', () => {
  const sc = { scrollTop: 0, l: {}, addEventListener(t, f) { this.l[t] = f; } };
  const { win, emit } = run({ scroller: sc });
  const to = (y) => { sc.scrollTop = y; sc.l.scroll(); };
  to(600); assert.equal(win.PAAppBar.state().hidden, false, 'no user input: a jump to a verse keeps the bar');
  emit('touchstart', { touches: [{ clientX: 1, clientY: 500 }] }); to(700); emit('touchend', { touches: [] });
  assert.equal(win.PAAppBar.state().hidden, true, 'finger scroll forward hides');
  to(690); assert.equal(win.PAAppBar.state().hidden, true, 'small back-scroll: nothing');
  to(660); assert.equal(win.PAAppBar.state().hidden, false, 'scroll up adds up past PULL_PX: shows');
  emit('keydown', {}); to(800); assert.equal(win.PAAppBar.state().hidden, true, 'key scroll forward hides');
});

test('a pull shorter than PULL_PX, a sideways drag, two fingers: no show', () => {
  const { win, drag, emit } = run();
  win.PAAppBar.hide();
  drag(100, 100 + win.PAAppBar.PULL_PX - 4); assert.equal(win.PAAppBar.state().hidden, true, 'short');
  emit('touchstart', { touches: [{ clientX: 0, clientY: 0 }] });
  emit('touchmove', { touches: [{ clientX: 200, clientY: 60 }] }); assert.equal(win.PAAppBar.state().hidden, true, 'more across than down');
  emit('touchstart', { touches: [{ clientX: 0, clientY: 0 }, { clientX: 50, clientY: 0 }] });
  emit('touchmove', { touches: [{ clientX: 0, clientY: 200 }, { clientX: 50, clientY: 200 }] });
  assert.equal(win.PAAppBar.state().hidden, true, 'pinch / two fingers');
});

test('Apple Pencil never pulls the bar (pointerType pen, touchType stylus); listeners are passive', () => {
  const { win, drag } = run();
  win.PAAppBar.hide();
  drag(100, 500, { pointerType: 'pen' }); assert.equal(win.PAAppBar.state().hidden, true, 'pointerType pen');
  drag(100, 500, { touchType: 'stylus' }); assert.equal(win.PAAppBar.state().hidden, true, 'touchType stylus');
  drag(100, 500); assert.equal(win.PAAppBar.state().hidden, false, 'control: the same pull with a finger shows it');
  for (const t of ['pointerdown', 'touchstart', 'touchmove', 'wheel']) assert.equal(win.opts[t].passive, true, `${t} passive`);
  assert.doesNotMatch(SCRIPT, /preventDefault\(/, 'the component never prevents default');
});

test('wheel up shows; wheel down never hides (a wheel is a mouse, F2-06); no page-touch hide or handle "stays" state left', () => {
  const { win, emit } = run();
  win.PAAppBar.hide(); emit('wheel', { deltaY: -40 }); assert.equal(win.PAAppBar.state().hidden, false, 'wheel up shows');
  emit('wheel', { deltaY: 40 }); assert.equal(win.PAAppBar.state().hidden, false, 'wheel down: the bar stays for a mouse reader');
  assert.doesNotMatch(SCRIPT, /SCROLL_HIDE_PX|touchHides|byHandle/, 'no page-touch hide left');
});

test('a page touch no longer hides the bar (Journal touchHides removed)', () => {
  const { win, docL, emit } = run();
  (docL.pointerdown || []).forEach((f) => f({ target: {} })); emit('pointerdown', { pointerType: 'touch', target: {} });
  assert.equal(win.PAAppBar.state().hidden, false);
});

test('Journal keepOpen uses PANote\'s ONE popover check (R3), identical in both copies', () => {
  const engine = read('web/note-ui.inline.html');
  assert.match(engine, /const POPS_OPEN='\.pan-pop\.on,\.pan-hlpop\.on';/);
  assert.match(engine, /return \{\s*\n\s*popsOpen,/, 'the pad API exports popsOpen');
  const wiring = (p) => read(p).match(/PAAppBar\.attach\([\s\S]*?\}\);/)[0];
  const a = wiring('workspace/apps/notes/index.html'), b = wiring('workspace.example/apps/notes/index.html');
  assert.equal(a, b, 'workspace and workspace.example agree');
  assert.match(a, /keepOpen:\(\)=>pad\.popsOpen\(\)/);
  assert.doesNotMatch(a, /\.pan-pop\.on/, 'no hand copy of the popover selector');
  assert.equal(wiring('workspace/apps/bible/index.html'), wiring('workspace.example/apps/bible/index.html'));
});

test('R4: the over-budget hosts name a split seam beside the bar wiring', () => {
  for (const p of ['workspace/apps/bible/index.html', 'workspace.example/apps/bible/index.html', 'workspace/apps/notes/index.html', 'workspace.example/apps/notes/index.html'])
    assert.match(read(p), /TODO\(R4 seam\): this PAAppBar wiring/, p);
});

const fire = (el, t, e = {}) => (el.listeners[t] || []).forEach((f) => f({ pointerType: 'mouse', ...e }));
test('handle tap shows the bar on the same idle clock; a Pencil press on the handle does not', () => {
  const { win, handle, clock } = run();
  win.PAAppBar.hide();
  fire(handle, 'pointerdown', { pointerType: 'pen' }); fire(handle, 'click');
  assert.equal(win.PAAppBar.state().hidden, true, 'Pencil: no');
  fire(handle, 'pointerdown'); fire(handle, 'click');
  assert.equal(win.PAAppBar.state().hidden, false, 'the handle shows it');
  clock.advance(win.PAAppBar.IDLE_MS + 10);
  assert.equal(win.PAAppBar.state().hidden, true, 'and it idles away like any shown bar');
});
test('R3: ONE handle size for the shell and PAAppBar (web/bar-handle.css), inlined into both', () => {
  const css = read('web/bar-handle.css');
  assert.match(css, /--pa-handle-w:120px;--pa-handle-h:28px;--pa-grab-w:60px;--pa-grab-h:6px/);
  const bar = read('web/app-bar.inline.html'), shell = read('web/index.html');
  for (const [name, src] of [['app-bar', bar], ['shell', shell]]) {
    assert.ok(src.includes('/* PA_BAR_HANDLE_CSS */'), `${name} carries the marker`);
    assert.doesNotMatch(src, /--pa-handle-w:\s*\d/, `${name} does not define the size itself`);
  }
  assert.match(bar, /\.paab-handle\{[^}]*width:var\(--pa-handle-w\);height:var\(--pa-handle-h\)/);
  assert.match(shell, /#barpeek\{[^}]*width:var\(--pa-handle-w\); height:var\(--pa-handle-h\)/);
  assert.ok(JSON.parse(read('web/shell-parts.json')).some((e) => e.marker === '/* PA_BAR_HANDLE_CSS */' && e.file === 'bar-handle.css'), 'a shell part (web/shell-parts.json, docs/adr/0049)');
  assert.match(read('web.mjs'), /marker: '\/\* PA_BAR_HANDLE_CSS \*\/', file: 'bar-handle\.css'/);
});

// F2-06 (owner 2026-11-23): the bar hides by itself only on touch while reading — never for a mouse.
test('F2-06: a desktop (hover) reader: the bar never idles away and a mouse-driven scroll never hides it', () => {
  const sc = fakeEl('div'); sc.scrollTop = 0;
  const { win, clock, emit } = run({ scroller: sc, hoverNone: false });
  clock.advance(win.PAAppBar.IDLE_MS * 3); assert.equal(win.PAAppBar.state().hidden, false, 'no idle hide on a hover device');
  emit('keydown', {}); sc.scrollTop = 300; (sc.listeners.scroll || []).forEach((f) => f());
  assert.equal(win.PAAppBar.state().hidden, false, 'a keyboard / wheel scroll forward does not hide it');
});
test('F2-06: touch hides (idle), a mouse click switches it off, the next touch switches it back on', () => {
  const { win, clock, emit, drag } = run();
  clock.advance(win.PAAppBar.IDLE_MS + 10); assert.equal(win.PAAppBar.state().hidden, true, 'control: touch device idles away');
  win.PAAppBar.show(); emit('pointerdown', { pointerType: 'mouse', pointerId: 9 }); emit('pointerup', { pointerType: 'mouse', pointerId: 9 });
  clock.advance(win.PAAppBar.IDLE_MS * 3); assert.equal(win.PAAppBar.state().hidden, false, 'after a mouse input it stays');
  drag(300, 320); clock.advance(win.PAAppBar.IDLE_MS + 10);
  assert.equal(win.PAAppBar.state().hidden, false, 'a touch re-arms nothing until the clock restarts');
  win.PAAppBar.show(); clock.advance(win.PAAppBar.IDLE_MS + 10);
  assert.equal(win.PAAppBar.state().hidden, true, 'touch again: it idles away');
});
test('F2-06: the Bible keeps the bar while a verse or words are selected (both copies)', () => {
  for (const f of ['workspace/apps/bible/index.html', 'workspace.example/apps/bible/index.html'])
    assert.match(read(f), /keepOpen:\(\)=>INK_PEN\.isOpen\(\)\|\|barPaneUp\(\)\|\|markVerses\(\)\.length>0\|\|/, f);
});

test('ADR 0040: a long press on ← Home asks the shell for 改这个应用 (edit-app), and is not also a Home tap', () => {
  const { win, bar, clock } = run();
  const posts = []; win.parent.postMessage = (m) => posts.push(m.type);
  const home = bar.children.find((c) => c.className === 'paab-btn paab-home');
  fire(home, 'pointerdown'); clock.advance(200); fire(home, 'pointerup'); fire(home, 'click');
  assert.deepEqual(posts, ['home'], 'a tap is Home');
  posts.length = 0;
  fire(home, 'pointerdown'); clock.advance(700); fire(home, 'pointerup'); fire(home, 'click');
  assert.deepEqual(posts, ['edit-app'], 'a long press is edit-app only');
  posts.length = 0; fire(home, 'pointerdown'); clock.advance(100); fire(home, 'click');
  assert.deepEqual(posts, ['home'], 'the next tap is Home again');
});
