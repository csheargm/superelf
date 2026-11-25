// Every tip can be closed · 提示都能关掉 (owner 2026-11-24: tips stayed stuck with no way to close them).
// Over the REAL PATips (web/tips.inline.html) with a stubbed account store (window.PATipsStore, as the shell's
// web/tips-store.js) and stubbed local/session storage: the seen-store fallbacks, Escape, one at a time, an inert
// layer, a modal dialog host, and a placement that never covers another control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, scriptOf } from './helpers-app.mjs';
import { fakeEl } from './helpers-tips.mjs';

const TIPS = scriptOf(fs.readFileSync(path.join(ROOT, 'web/tips.inline.html'), 'utf8'));
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m }; };
const blocked = () => ({ getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } });
// acct: {list, readOk, writeOk} — the account; null = no store at all.
function page({ src = TIPS, acct = { list: [], readOk: true, writeOk: true }, local = mem(), session = mem(), ctrls = [], one = false, modal = null } = {}) {
  const dh = {};
  const win = { innerWidth: 390, innerHeight: 844, addEventListener() {}, localStorage: local, sessionStorage: session };
  if (acct) win.PATipsStore = { oneAtATimeOnly: one, writes: [],
    read: async () => (acct.readOk ? { ok: true, list: acct.list.slice() } : { ok: false }),
    write: async (l) => { win.PATipsStore.writes.push(l); if (!acct.writeOk) return { ok: false }; acct.list = l.slice(); return { ok: true }; },
    reset: async () => ({ ok: true }) };
  const html = fakeEl('html');
  const doc = { body: fakeEl('body'), documentElement: html, createElement: (t) => fakeEl(t), querySelector: (q) => (/:modal/.test(q) ? modal : null),
    querySelectorAll: () => ctrls, addEventListener: (t, f) => { (dh[t] = dh[t] || []).push(f); } };
  new Function('window', 'document', 'parent', src)(win, doc, {});   // eslint-disable-line no-new-func
  const tip = () => html.children.find((c) => c.classList.contains('pat-tip'));
  return { win, T: win.PATips, tip, fire: (t, e) => (dh[t] || []).forEach((f) => f(e || {})), html };
}
const anchor = (top = 100, left = 20, extra = {}) => Object.assign(fakeEl('button', { top, left, width: 40, height: 30 }), { closest: () => null }, extra);

test('the ✕ is a 44px target named 关闭提示 · Dismiss tip; a tap on it closes the tip and stores the id', async () => {
  const p = page(); p.T.register({ id: 'a', anchor: anchor(), text: '甲 · A' }); await flush();
  const x = p.tip().children[1];
  assert.equal(x.attrs['aria-label'], '关闭提示 · Dismiss tip');
  assert.match(fs.readFileSync(path.join(ROOT, 'web/tips.inline.html'), 'utf8'), /\.pat-x\{[^}]*width:44px;height:44px/);
  p.tip().fire('click'); await flush();
  assert.equal(p.tip(), undefined); assert.deepEqual(p.win.PATipsStore.writes.at(-1), ['a']);
});

test('Escape closes the tip; so does the first press outside it', async () => {
  const p = page(); p.T.register({ id: 'e', anchor: anchor(), text: 'E' }); await flush();
  p.fire('keydown', { key: 'Enter', target: {} }); assert.ok(p.tip(), 'CONTROL: another key leaves it');
  p.fire('keydown', { key: 'Escape', target: {} }); await flush(); assert.equal(p.tip(), undefined, 'Escape closed it');
  const q = page(); q.T.register({ id: 'o', anchor: anchor(), text: 'O' }); await flush();
  q.fire('pointerdown', { target: {} }); await flush(); assert.equal(q.tip(), undefined, 'an outside press closed it');
});

test('account read refused: the device copy decides (tip shows, closed once, stays closed on reload)', async () => {
  const local = mem(), acct = { list: [], readOk: false, writeOk: false };
  const p = page({ acct, local }); p.T.register({ id: 'f', anchor: anchor(), text: 'F' }); await flush();
  assert.ok(p.tip(), 'shows with only device storage'); p.tip().fire('click'); await flush();
  assert.deepEqual(JSON.parse(local.m.get('pa_tips_seen')), ['f']);
  const p2 = page({ acct, local, session: mem() }); p2.T.register({ id: 'f', anchor: anchor(), text: 'F' }); await flush();
  assert.equal(p2.tip(), undefined, 'the device copy keeps it closed');
});

test('account write refused and localStorage blocked: closed now, and not shown again this session', async () => {
  const session = mem(), acct = { list: [], readOk: true, writeOk: false };
  const p = page({ acct, local: blocked(), session }); p.T.register({ id: 's', anchor: anchor(), text: 'S' }); await flush();
  p.tip().fire('click'); await flush(); assert.equal(p.tip(), undefined, 'closed for this page');
  const p2 = page({ acct, local: blocked(), session }); p2.T.register({ id: 's', anchor: anchor(), text: 'S' }); await flush();
  assert.equal(p2.tip(), undefined, 'the tab copy keeps it closed this session');
  const p3 = page({ acct, local: blocked(), session: mem() }); p3.T.register({ id: 's', anchor: anchor(), text: 'S' }); await flush();
  assert.ok(p3.tip(), 'CONTROL (R14): a new session, never remembered anywhere, shows it again');
});

test('a second device: the account list keeps it closed (no device copy)', async () => {
  const acct = { list: [], readOk: true, writeOk: true };
  const p = page({ acct }); p.T.register({ id: 'd', anchor: anchor(), text: 'D' }); await flush(); p.tip().fire('click'); await flush();
  const p2 = page({ acct, local: mem(), session: mem() }); p2.T.register({ id: 'd', anchor: anchor(), text: 'D' }); await flush();
  assert.equal(p2.tip(), undefined);
});

test('one tip at a time; the shell (oneAtATimeOnly) shows the next after a dismissal, an app page waits for the next open', async () => {
  for (const one of [false, true]) {
    const p = page({ one }); p.T.register({ id: '1', anchor: anchor(100), text: '一' }); p.T.register({ id: '2', anchor: anchor(300), text: '二' }); await flush();
    assert.equal(p.html.children.filter((c) => c.classList.contains('pat-tip')).length, 1, 'one on screen');
    p.tip().fire('click'); await flush(); p.fire('click'); await flush();
    assert.equal(p.T.current(), one ? '2' : null);
  }
});

test('an anchor inside an inert or hidden layer gets no tip', async () => {
  const p = page(); p.T.register({ id: 'i', anchor: anchor(100, 20, { closest: (s) => (/inert/.test(s) ? {} : null) }), text: 'I' }); await flush();
  assert.equal(p.tip(), undefined);
});

test('an anchor in an open modal dialog: the tip goes into that dialog (the top layer), not under it', async () => {
  const dlg = fakeEl('dialog'); const p = page();
  p.T.register({ id: 'm', anchor: anchor(100, 20, { closest: (s) => (s === 'dialog[open]' ? dlg : null) }), text: 'M' }); await flush();
  assert.ok(dlg.children.some((c) => c.classList.contains('pat-tip')));
});

test('placement: the tip never covers another control when there is a free spot', async () => {
  const below = fakeEl('button', { top: 436, left: 0, width: 390, height: 60 });   // a row of controls right under the anchor
  const p = page({ ctrls: [below] }); p.T.register({ id: 'c', anchor: anchor(400), text: 'C' }); await flush();
  const r = p.tip().getBoundingClientRect(), b = below.getBoundingClientRect(), a = { top: 400, bottom: 430, left: 20, right: 60 };
  const hit = (x, y) => x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom;
  assert.equal(hit(r, b), false, 'not over the control row'); assert.equal(hit(r, a), false, 'not over its own control');
  const NO_AVOID = TIPS.replace('const covers=(ctrls,box)=>ctrls.reduce((n,r)=>n+(hit(r,box)?1:0),0);', 'const covers=()=>0;');
  assert.notEqual(NO_AVOID, TIPS, 'the R14 mutation matched');
  const q = page({ src: NO_AVOID, ctrls: [below] }); q.T.register({ id: 'c', anchor: anchor(400), text: 'C' }); await flush();
  assert.equal(hit(q.tip().getBoundingClientRect(), b), true, 'CONTROL (R14): without the scan it lands on the row');
});

test('profile.tipsSeen keeps only short tip ids, deduped and capped (lib/tips-seen.mjs)', async () => {
  const { tipsSeenOf, TIPS_SEEN_MAX } = await import('../lib/tips-seen.mjs');
  assert.deepEqual(tipsSeenOf(['tip:home-more', 'tip:home-more', 'Bad Id', 5, 'x'.repeat(65), 'app-own-bar']), ['tip:home-more', 'app-own-bar']);
  assert.deepEqual(tipsSeenOf('nope'), []);
  assert.equal(tipsSeenOf(Array.from({ length: TIPS_SEEN_MAX + 5 }, (_, i) => 't' + i)).length, TIPS_SEEN_MAX);
});

test('account read refused, localStorage blocked, sessionStorage works: tips still show and stay closed this session (GPT r1)', async () => {
  const session = mem(), acct = { list: [], readOk: false, writeOk: false };
  const p = page({ acct, local: blocked(), session }); p.T.register({ id: 'q', anchor: anchor(), text: 'Q' }); await flush();
  assert.ok(p.tip(), 'the tab copy is enough to show'); p.tip().children[1].fire('pointerdown'); await flush();
  assert.equal(p.tip(), undefined, 'the ✕ closes on its own press (a host may swallow the click)');
  const p2 = page({ acct, local: blocked(), session }); p2.T.register({ id: 'q', anchor: anchor(), text: 'Q' }); await flush();
  assert.equal(p2.tip(), undefined);
});

test('placement: off-screen controls do not use up the scan budget (GPT r1)', async () => {
  const far = Array.from({ length: 450 }, (_, i) => fakeEl('button', { top: 2000 + i * 40, left: 0, width: 390, height: 30 }));
  const below = fakeEl('button', { top: 436, left: 0, width: 390, height: 60 });
  const p = page({ ctrls: [...far, below] }); p.T.register({ id: 'b', anchor: anchor(400), text: 'B' }); await flush();
  const r = p.tip().getBoundingClientRect();
  assert.equal(r.top < 496 && r.top + r.height > 436, false, 'the visible row is still avoided');
});

test('GPT r2: an anchor behind an open modal dialog gets no tip', async () => {
  const p = page({ modal: { contains: () => false } }); p.T.register({ id: 'u', anchor: anchor(), text: 'U' }); await flush();
  assert.equal(p.tip(), undefined);
  const q = page({ modal: {} }); q.T.register({ id: 'u', anchor: anchor(100, 20, { closest: (sel) => (/:modal/.test(sel) ? {} : null) }), text: 'U' }); await flush();
  assert.ok(q.tip(), 'CONTROL: an anchor inside the modal gets its tip');
});

test('GPT r2: hide() stores nothing; the shell shows the next tip right after an Escape (no other event)', async () => {
  const r = page({ one: true }); r.T.register({ id: 'h', anchor: anchor(), text: 'H' }); await flush();
  r.T.hide(); await flush(); assert.equal(r.tip(), undefined); assert.deepEqual(r.win.PATipsStore.writes, [], 'hide stores nothing');
  const n = page({ one: true }); n.T.register({ id: '1', anchor: anchor(100), text: '一' }); n.T.register({ id: '2', anchor: anchor(300), text: '二' }); await flush();
  n.fire('keydown', { key: 'Escape', target: {} }); await flush();
  assert.equal(n.T.current(), '2');
});

test('GPT r3: device copies are per account; hide() mutes only that tip; reset waits for a pending write', async () => {
  const local = mem();
  const a = page({ local, session: mem() }); a.win.PATipsStore.who = () => 'acct-a'; a.T.register({ id: 'k', anchor: anchor(), text: 'K' }); await flush();
  a.tip().fire('click'); await flush();
  assert.ok(local.m.has('pa_tips_seen:acct-a'), 'stored under the account');
  const b = page({ local, session: mem(), acct: { list: [], readOk: false, writeOk: false } }); b.win.PATipsStore.who = () => 'acct-b';
  b.T.register({ id: 'k', anchor: anchor(), text: 'K' }); await flush(); assert.ok(b.tip(), 'another account on this browser still sees it');
  const h = page({ one: true }); h.T.register({ id: '1', anchor: anchor(100), text: '一' }); h.T.register({ id: '2', anchor: anchor(300), text: '二' }); await flush();
  h.T.hide(); await flush(); assert.equal(h.T.current(), '2', 'the next tip may show; the hidden one is muted');
  const order = []; const r = page(); r.win.PATipsStore.write = async () => { await flush(); order.push('write'); return { ok: true }; };
  r.win.PATipsStore.reset = async () => { order.push('reset'); return { ok: true }; };
  r.T.register({ id: 'w', anchor: anchor(), text: 'W' }); await flush(); r.tip().fire('click'); await r.T.reset(); await flush();
  assert.deepEqual(order, ['write', 'reset']);
});
