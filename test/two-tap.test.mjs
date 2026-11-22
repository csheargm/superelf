// PATwoTap — the one two-tap destructive button（两次点击确认）, web/two-tap.inline.html.
//
// Apps run under CSP `sandbox allow-scripts` with no allow-modals, where confirm() returns false at
// once, so a destructive action asks in place: the first tap arms, a second within the window acts.
// Five apps carried a hand-written copy of that; they now share this one. Here the REAL file is
// run (never restated) against a clock the test moves by hand, and a REAL web.mjs proves every
// committed app page receives it ahead of its own script. Each app's own flow through it is
// test/sandbox-modal-flows.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, scriptOf, fakeEl } from './helpers-app.mjs';
import { codeOnly } from './helpers-code.mjs';
import { committedApps, execScripts, SYNTHETIC, withServedPages } from './helpers-every-page.mjs';

const HELPER = scriptOf(fs.readFileSync(path.join(ROOT, 'web', 'two-tap.inline.html'), 'utf8'));
const MARKER = '<!--PA_TWO_TAP_UI-->';

function boot() {
  let now = 0, seq = 0;
  const due = new Map();
  const ctx = vm.createContext({
    setTimeout: (fn, ms = 0) => { due.set(++seq, { fn, at: now + ms }); return seq; },
    clearTimeout: (id) => { due.delete(id); },
  });
  vm.runInContext(HELPER, ctx);
  const advance = (ms) => { now += ms; for (const [id, t] of [...due]) if (t.at <= now) { due.delete(id); t.fn(); } };
  return { T: ctx.PATwoTap, advance, pending: () => due.size, rerun: () => vm.runInContext(HELPER, ctx), ctx };
}
const button = (text) => Object.assign(fakeEl('btn'), { textContent: text });
const asking = (b) => b.classList.contains('arm');

test('a first press asks and does not act; a second press acts and disarms', () => {
  const { T } = boot();
  const b = button('Delete');
  assert.equal(T.press(b), false, 'one tap only asks');
  assert.equal(b.textContent, 'Delete? · 删除?');
  assert.ok(asking(b), 'with the class every app styles as asking');
  assert.equal(T.press(b), true, 'the second tap acts');
  assert.equal(b.textContent, 'Delete', 'and the button is back to its own label');
  assert.equal(asking(b), false);
});

test('an ask lapses after the window, and a lapsed ask does not count', () => {
  const { T, advance, pending } = boot();
  const b = button('Delete');
  T.press(b);
  advance(T.MS - 1);
  assert.ok(asking(b), 'still asking just inside the window');
  advance(1);
  assert.equal(b.textContent, 'Delete', 'forgotten at the window');
  assert.equal(pending(), 0);
  assert.equal(T.press(b), false, 'two taps a window apart are two first taps');
});

test('label and window are the caller\'s; the restored text is the button\'s own', () => {
  const { T, advance } = boot();
  const b = button('✕');
  T.press(b, { label: 'Reset all data? · 清空所有数据?', ms: 4000 });
  assert.equal(b.textContent, 'Reset all data? · 清空所有数据?');
  advance(3000);
  assert.ok(asking(b), 'a longer window is honoured');
  advance(1000);
  assert.equal(b.textContent, '✕');
});

test('acting cancels the expiry, so a later timer cannot rewrite the button', () => {
  const { T, advance, pending } = boot();
  const b = button('Delete');
  T.press(b); T.press(b);
  assert.equal(pending(), 0, 'no timer left behind');
  b.textContent = 'Deleted';
  advance(T.MS);
  assert.equal(b.textContent, 'Deleted');
});

test('disarm forgets an ask now, and is a no-op on a button that is not asking', () => {
  const { T, pending } = boot();
  const b = button('Delete');
  T.press(b);
  T.disarm(b);
  assert.equal(pending(), 0, 'its timer goes with it');
  assert.equal(b.textContent, 'Delete');
  assert.equal(T.press(b), false, 'after a disarm the next tap asks again — a reused button never acts on one tap');
  const idle = button('Keep me');
  T.disarm(idle);
  assert.equal(idle.textContent, 'Keep me');
});

test('buttons are independent: an ask on one never lets another act', () => {
  const { T, advance } = boot();
  const a = button('A'), b = button('B');
  T.press(a);
  assert.equal(T.press(b), false, 'B asks on its own first tap');
  assert.equal(T.press(a), true, 'A still acts on its second');
  advance(T.MS);
  assert.equal(b.textContent, 'B', "B's own window still runs");
});

test('rows: one row asks at a time, the ask is read by the renderer, and it lapses', () => {
  const { T, advance } = boot();
  const arm = T.rows(4000);
  let draws = 0;
  const redraw = () => draws++;
  assert.equal(arm.asking('r:0'), false);
  assert.equal(arm.press('r:0', redraw), false, 'one tap only asks');
  assert.equal(arm.asking('r:0'), true);
  assert.equal(draws, 1, 'and redraws so the row shows it');
  assert.equal(arm.press('r:1', redraw), false, 'a tap on another row is that row\'s first tap');
  assert.equal(arm.asking('r:0'), false, 'the ask moved');
  assert.equal(arm.press('r:1', redraw), true, 'only a second tap on the SAME row acts');
  assert.equal(arm.asking('r:1'), false);
  arm.press('r:2', redraw);
  draws = 0;
  advance(4000);
  assert.equal(arm.asking('r:2'), false, 'forgotten at the window');
  assert.equal(draws, 1, 'with a redraw, so the row stops asking on screen');
  assert.equal(arm.press('r:2', redraw), false, 'a lapsed ask does not count');
});

test('a second copy on the page keeps the first instance and its state', () => {
  const { T, rerun, ctx } = boot();
  const b = button('Delete');
  T.press(b);
  rerun();
  assert.equal(ctx.PATwoTap, T);
  assert.equal(ctx.PATwoTap.press(b), true);
});

// One label. The picker said "删除？" (full-width ？) and diabetes said only "Delete?"; a private
// spelling drifts, so every asking button reads PATwoTap.LABEL instead.
test('no app or component spells its own "Delete?" label — they read PATwoTap.LABEL', () => {
  const components = fs.readdirSync(path.join(ROOT, 'web'))
    .filter((f) => f.endsWith('.inline.html') && f !== 'two-tap.inline.html')
    .map((f) => ({ slug: `web/${f}`, html: fs.readFileSync(path.join(ROOT, 'web', f), 'utf8') }));
  const OWN_LABEL = /[>'"`]\s*Delete\?|删除？/;
  const found = [...committedApps(), ...components].flatMap(({ slug, html }) =>
    codeOnly(html).split('\n').filter((l) => OWN_LABEL.test(l)).map((l) => `${slug}: ${l.trim()}`));
  assert.deepEqual(found, []);
  assert.match(fs.readFileSync(path.join(ROOT, 'web', 'two-tap.inline.html'), 'utf8'), /const LABEL = 'Delete\? · 删除\?';/,
    'the one spelling lives in the component');
});

// ── Served: every committed app page carries it, ahead of the app's own script ─────────────
test('every committed app page gets PATwoTap once, as its first script (real web.mjs)', async () => {
  const committed = committedApps();
  await withServedPages([...committed, ...SYNTHETIC('PATwoTap.MS')], async (served) => {
    for (const { slug } of committed) {
      const html = await served(slug);
      assert.equal(html.includes(MARKER), false, `${slug}: no marker survives`);
      assert.equal(html.split('var PATwoTap = PATwoTap ||').length - 1, 1, `${slug}: exactly one PATwoTap`);
      assert.match(execScripts(html)[0], /var PATwoTap = PATwoTap \|\|/, `${slug}: and it runs before any other script`);
    }
    for (const slug of ['syn-head-script', 'syn-no-head']) {
      const html = await served(slug);
      const scripts = execScripts(html);
      assert.match(scripts[0], /var PATwoTap/, `${slug}: ahead of a script with no </head> before it`);
      assert.ok(html.startsWith('<!doctype html>'), `${slug}: never ahead of the doctype (that is quirks mode)`);
      // Every script in page order: PAStore (test/store.test.mjs) also runs ahead of the page's own.
      const ctx = vm.createContext({ setTimeout, clearTimeout, addEventListener() {}, parent: { postMessage() {} } });
      for (const s of scripts) vm.runInContext(s, ctx);
      assert.equal(ctx.early, 3000, `${slug}: the page's own script can use it at top level`);
    }
    assert.equal((await served('syn-static')).includes('PATwoTap'), false, 'a page with no script of its own gets nothing');
  });
});
