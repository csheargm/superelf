// PABusy — "any unsaved work?"（有未保存的工作吗）, web/busy.inline.html (docs/adr/0026). Run alone in a
// vm, and checked on every committed app page as a real web.mjs serves it. The shell's side is
// test/shell-update.test.mjs; PANote's and PAChat's one-line registrations are pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, scriptOf } from './helpers-app.mjs';
import { committedApps, execScripts, SYNTHETIC, withServedPages } from './helpers-every-page.mjs';

const BUSY = scriptOf(fs.readFileSync(path.join(ROOT, 'web', 'busy.inline.html'), 'utf8'));
function page() {
  const listeners = {}, sent = [];
  const parent = { postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))) };
  const win = { parent, addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); } };
  const ctx = vm.createContext(win);
  vm.runInContext(BUSY, ctx);
  const ask = (source = parent, data = { kind: 'pa-busy?' }) => { for (const fn of listeners.message || []) fn({ data, source }); };
  return { api: ctx.PABusy, sent, ask };
}

test('no watcher → busy:false; a watcher that says so → busy:true; a watcher that throws counts as busy (fail closed)', () => {
  const p = page();
  p.ask();
  assert.deepEqual(p.sent, [{ kind: 'pa-busy', busy: false }]);
  let unsaved = false;
  p.api.watch(() => unsaved);
  p.ask(); assert.equal(p.sent[1].busy, false);
  unsaved = true;
  p.ask(); assert.equal(p.sent[2].busy, true);
  unsaved = false;
  p.api.watch(() => { throw new Error('cannot tell'); });
  p.ask(); assert.equal(p.sent[3].busy, true, 'a watcher that cannot answer cannot prove the page idle');
  assert.equal(p.api.busy(), true);
});

test('answers only the parent\'s pa-busy? — not another window, not another kind', () => {
  const p = page();
  p.ask({ postMessage() {} });
  p.ask(undefined, { kind: 'other' });
  p.ask(undefined, { pa: 'leaving' });
  assert.deepEqual(p.sent, []);
  p.api.watch('not a function');   // ignored, never throws
  p.ask(); assert.equal(p.sent.length, 1);
});

test('PANote registers a stroke in progress or its save guard\'s unsaved state, PAChat a streaming turn or a draft — one line each', () => {
  const note = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
  const chat = fs.readFileSync(path.join(ROOT, 'web', 'chat-ui.inline.html'), 'utf8');
  assert.equal(note.split('PABusy.watch(()=>drawing||guard.state().unsaved)').length, 2, 'PANote: mid-stroke (the guard cannot see an uncommitted stroke) or the guard\'s unsaved (dirty, in flight or failed)');
  assert.equal(chat.split('PABusy.watch(()=>sending||!!el.inp.value.trim()||atts.length>0)').length, 2, 'PAChat: while a turn streams, or with typed text / attachments not yet sent');
});

test('every committed app page gets PABusy once, after PA, ahead of its own script (real web.mjs)', async () => {
  const committed = committedApps();
  await withServedPages([...committed, ...SYNTHETIC('typeof PABusy')], async (served) => {
    for (const { slug } of committed) {
      const html = await served(slug);
      assert.equal(html.includes('<!--PA_BUSY_UI-->'), false, `${slug}: no marker survives`);
      assert.equal(html.split('var PABusy = PABusy ||').length - 1, 1, `${slug}: exactly one PABusy`);
      const scripts = execScripts(html);
      const i = scripts.findIndex((s) => /var PABusy = PABusy \|\|/.test(s));
      assert.ok(i > scripts.findIndex((s) => /var PA = PA \|\|/.test(s)), `${slug}: after PA`);
    }
    for (const slug of ['syn-head-script', 'syn-no-head']) {
      const html = await served(slug);
      const ctx = vm.createContext({ setTimeout, clearTimeout, addEventListener() {}, parent: { postMessage() {} } });
      for (const s of execScripts(html)) vm.runInContext(s, ctx);
      assert.equal(ctx.early, 'object', `${slug}: it is there before the page's own script runs`);
    }
  });
});
