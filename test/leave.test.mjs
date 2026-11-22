// PALeave — an app's last save, made while the shell still serves the page（离开时先保存）,
// web/leave.inline.html (docs/adr/0018). Run alone in a vm, and checked on every committed app page
// as a real web.mjs serves it. The shell's side (the hold, the broker) is test/app-leave.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, scriptOf } from './helpers-app.mjs';
import { committedApps, execScripts, SYNTHETIC, withServedPages } from './helpers-every-page.mjs';

// ── 1. PALeave alone ────────────────────────────────────────────────────────────────────────────
const LEAVE = scriptOf(fs.readFileSync(path.join(ROOT, 'web', 'leave.inline.html'), 'utf8'));
// The page's window as a browser gives it to this component. dispatchEvent runs the listeners in
// order and REPORTS one that throws, then goes on (the DOM's "inner invoke" reports the exception).
function page({ PageTransitionEvent } = {}) {
  const listeners = {}, reported = [], sent = [];
  const parent = { postMessage: (m) => sent.push(m) };
  const win = {
    parent, Event, ...(PageTransitionEvent ? { PageTransitionEvent } : {}),
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
    dispatchEvent: (ev) => { for (const fn of listeners[ev.type] || []) { try { fn(ev); } catch (e) { reported.push(e); } } return true; },
  };
  const ctx = vm.createContext(win);
  vm.runInContext(LEAVE, ctx);
  const msg = (data, source = parent) => { for (const fn of listeners.message || []) fn({ data, source }); };
  return { ctx, parent, sent, reported, msg, on: win.addEventListener };
}
const SAVE = (id) => ({ pa: 'req', id, kind: 'save-data', path: 'entry.json', data: '{}' });
// What the page sent, as plain data: {pa:'left'} is made inside the vm, whose Object is another realm's.
const sentOf = (p) => JSON.parse(JSON.stringify(p.sent));
const HERE = { pa: 'here' };

test('PALeave says {pa:\'here\'} as it runs, before any script of the page\'s own', () => {
  const p = page();
  assert.deepEqual(sentOf(p), [HERE], 'the shell holds a page on a leave only once it has heard this');
});

test('PALeave: "leaving" runs the page\'s pagehide handlers, then answers "left" behind everything they sent', () => {
  const p = page();
  p.on('pagehide', () => p.parent.postMessage(SAVE(1)));
  p.on('pagehide', () => p.parent.postMessage(SAVE(2)));
  p.msg({ pa: 'leaving' });
  assert.deepEqual(sentOf(p), [HERE, SAVE(1), SAVE(2), { pa: 'left' }], 'the saves are ahead of the answer');
});

test('PALeave: a handler that throws does not stop the others, or the answer', () => {
  const p = page();
  p.on('pagehide', () => { throw new Error('broken pad'); });
  p.on('pagehide', () => p.parent.postMessage(SAVE(2)));
  p.msg({ pa: 'leaving' });
  assert.deepEqual(sentOf(p), [HERE, SAVE(2), { pa: 'left' }]);
  assert.equal(p.reported.length, 1, 'the throw was reported, as a browser reports it');
});

test('PALeave: only the shell\'s "leaving" counts, and only once', () => {
  const p = page();
  let ran = 0;
  p.on('pagehide', () => { ran++; });
  p.msg({ pa: 'leaving' }, { postMessage() {} });   // another window
  p.msg({ pa: 'prefs', fontScale: 1 });
  p.msg(null);
  assert.equal(ran, 0, 'nothing but the shell\'s "leaving" runs the handlers');
  assert.deepEqual(sentOf(p), [HERE], 'only the hello it sent as it ran');
  p.msg({ pa: 'leaving' }); p.msg({ pa: 'leaving' });
  assert.equal(ran, 1, 'once');
  assert.deepEqual(sentOf(p), [HERE, { pa: 'left' }]);
});

test('PALeave: where the engine has PageTransitionEvent, the event is a pagehide that does not persist', () => {
  class PTE extends Event { constructor(type, o) { super(type); this.persisted = o.persisted; } }
  const p = page({ PageTransitionEvent: PTE });
  let seen = null;
  p.on('pagehide', (ev) => { seen = ev; });
  p.msg({ pa: 'leaving' });
  assert.ok(seen instanceof PTE, 'CONTROL: the constructor was used');
  assert.equal(seen.type, 'pagehide');
  assert.equal(seen.persisted, false, 'the page is not going into a back-forward cache');
});

// ── 2. Served: every committed app page carries it, after PAStore, ahead of the app's own script ──
test('every committed app page gets PALeave once, after PAStore, ahead of its own script (real web.mjs)', async () => {
  const committed = committedApps();
  await withServedPages([...committed, ...SYNTHETIC('typeof PALeave')], async (served) => {
    for (const { slug } of committed) {
      const html = await served(slug);
      assert.equal(html.includes('<!--PA_LEAVE_UI-->'), false, `${slug}: no marker survives`);
      assert.equal(html.split('var PALeave = PALeave ||').length - 1, 1, `${slug}: exactly one PALeave`);
      const scripts = execScripts(html);
      assert.match(scripts[1], /var PAStore = PAStore \|\|/, `${slug}: CONTROL: PAStore second`);
      assert.match(scripts[2], /var PALeave = PALeave \|\|/, `${slug}: then PALeave, before any script of the page's own`);
    }
    for (const slug of ['syn-head-script', 'syn-no-head']) {
      const html = await served(slug);
      const ctx = vm.createContext({ setTimeout, clearTimeout, addEventListener() {}, parent: { postMessage() {} } });
      for (const s of execScripts(html)) vm.runInContext(s, ctx);
      assert.equal(ctx.early, 'object', `${slug}: it is there before the page's own script runs`);
    }
    assert.equal((await served('syn-static')).includes('PALeave'), false, 'a page with no script of its own gets nothing');
  });
});
