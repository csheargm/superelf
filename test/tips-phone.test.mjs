// PATips on phones（手机上的首次提示）— phone audit 2026-11-24, over the REAL component (web/tips.inline.html):
//   #3  a pen:true tip (the Bible's Pencil tips) waits until this page saw a pen pointer: a finger or a mouse never shows it;
//   #2  a shown tip whose layer turns [inert] (the shell opening an app over the home) is taken down at once,
//       with no scroll / click / resize to trigger it.
//   and a page title (h1 / header) is kept clear like a control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, scriptOf } from './helpers-app.mjs';
import { fakeEl, obsStub } from './helpers-tips.mjs';

const SRC = scriptOf(fs.readFileSync(path.join(ROOT, 'web/tips.inline.html'), 'utf8'));
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

// One page with device storage only (no account store): enough for PATips to show and remember.
function page({ heads = [], mo = null } = {}) {
  const dh = {}, mem = {};
  const store = { getItem: (k) => mem[k] || null, setItem: (k, v) => { mem[k] = v; } };
  const win = { innerWidth: 390, innerHeight: 844, addEventListener() {}, localStorage: store, sessionStorage: store,
    requestAnimationFrame: (f) => queueMicrotask(f) };
  if (mo) win.MutationObserver = mo;
  const html = fakeEl('html'), body = fakeEl('body');
  const doc = { body, documentElement: html, createElement: (t) => fakeEl(t), querySelector: () => null,
    querySelectorAll: (sel) => (/h1/.test(sel) ? heads : []),
    addEventListener: (t, f, cap) => { if (cap) (dh[t] = dh[t] || []).push(f); } };
  new Function('window', 'document', 'parent', SRC)(win, doc, {});   // eslint-disable-line no-new-func
  return { T: win.PATips, html, press: (pointerType) => (dh.pointerdown || []).forEach((f) => f({ pointerType, target: body })) };
}
const anchor = () => fakeEl('button', { top: 300, left: 20, width: 40, height: 30 });

test('#3 a pen:true tip never shows to a finger or a mouse; the first pen press brings it', async () => {
  const p = page();
  p.T.register({ id: 'pen-tip', anchor: anchor(), text: '用笔 · Pencil', pen: true });
  await flush();
  assert.equal(p.T.current(), null, 'no pen seen: hidden');
  p.press('touch'); p.press('mouse'); await flush();
  assert.equal(p.T.current(), null, 'a finger and a mouse: still hidden');
  p.press('pen'); await flush();
  assert.equal(p.T.current(), 'pen-tip', 'a pen: shown');
});

test('CONTROL: a tip without pen:true shows on a phone with no pen at all', async () => {
  const p = page();
  p.T.register({ id: 'plain', anchor: anchor(), text: '提示 · Tip' });
  await flush();
  assert.equal(p.T.current(), 'plain');
});

test('#2 the shown tip goes when its layer turns inert, with no other event', async () => {
  const MO = obsStub(); const p = page({ mo: MO });
  const a = anchor(); p.T.register({ id: 'home-more', anchor: a, text: '更多 · More' });
  await flush();
  assert.equal(p.T.current(), 'home-more');
  a.closest = (sel) => (/inert/.test(sel) ? {} : null);   // the shell made the header inert (app opened over it)
  MO.fire(); await flush();
  assert.equal(p.T.current(), null, 'taken down (unseen: it shows again on the home later)');
  assert.equal(p.html.children.filter((c) => c.className.includes('pat-tip')).length, 0);
});

test('a page title is kept clear: the tip moves off an h1 that sits right under the anchor', async () => {
  const h1 = fakeEl('h1', { top: 336, left: 0, width: 390, height: 60 });
  const p = page({ heads: [h1] });
  p.T.register({ id: 't', anchor: anchor(), text: '提示 · Tip' });
  await flush();
  const tip = p.html.children.find((c) => c.className.includes('pat-tip')).getBoundingClientRect();
  const r = h1.getBoundingClientRect();
  assert.ok(!(tip.left < r.right && r.left < tip.right && tip.top < r.bottom && r.top < tip.bottom), `tip ${tip.top}-${tip.bottom} clears the title ${r.top}-${r.bottom}`);
});
