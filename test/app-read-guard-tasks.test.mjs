// A FAILED read of the task list must never become an empty list — the guard of
// test/app-read-guard*.test.mjs, for Tasks. Run for real: the app's own script as served (PATwoTap,
// PAStore first), the shell relay and a real node:http server over a throwaway directory
// (helpers-sandbox-app.mjs).
//
// THE BUG (2026-10-12): Tasks read tasks.md by hand and took ANY failed read, the first run's
// 'not-found' included, as "Could not load tasks.", with its list left empty. The add bar sits outside
// that list and still worked, so one added task was saved as the whole file, over the user's list. A
// task added while the read was in flight did the same.
//
// One thing differs from the JSON apps (ADR 0010, "Tasks"): tasks.md is markdown, so any text is a
// list and "the file does not parse" cannot happen. It is saved through save-data, which writes an
// app's own .md as sent (ADR 0014), to the harness's real server and real writer (lib/appdata.mjs), so
// a write the app wrongly sends DOES land, and is counted. Until 2026-10-13 the app's agent wrote the
// list (an `ask`, seconds to minutes per save); any `ask` the app sends now is recorded, and must not be.
// Every flow runs on the owner's copy and on the template a new user gets (they may differ later).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settle, until, deferred } from './helpers-app.mjs';
import { htmlOf, srcOf, boot, writesTo, readFails, saveFails, textOf, fileText, withHarness, heldReads,
  refusedOrSent, SHELL_READ_FAILED, SHELL_SAVE_FAILED } from './helpers-sandbox-app.mjs';

const FILE = 'tasks.md';
const SAVED = '## Today\n- [ ] Call Mom\n- [x] Pay rent\n\n## Later\n- [ ] Fix bike\n';
const elOf = (app, id) => app.run(`document.getElementById('${id}')`);
const tasksOf = (app) => JSON.parse(app.run("JSON.stringify(lines.filter((l) => l.kind === 'task').map((l) => l.text))"));
const listShown = (app) => textOf(app, 'root') + elOf(app, 'root').innerHTML;
// A tap on Add, or Enter in the box: the app's own wiring. `addPast` calls addTask() itself, as nothing
// in the browser can while the bar is disabled, to prove PAStore refuses the save anyway.
const add = (app, text) => { elOf(app, 'add-input').value = text; elOf(app, 'add-btn').onclick(); };
const addByEnter = (app, text) => { elOf(app, 'add-input').value = text; elOf(app, 'add-input').on.keydown({ key: 'Enter', preventDefault() {} }); };
const addPast = (app, text) => { elOf(app, 'add-input').value = text; app.run('addTask()'); };
// A tap on a list row: the rendered row showing `text` must carry `call`, then it runs as the tap does
// (the rows are innerHTML strings, so their onclick cannot be fired here). Ties the index to the task.
const tap = (app, call, text) => {
  const row = elOf(app, 'root').innerHTML.split(/(?=<div class="item|<h2>)/).find((r) => r.includes(`onclick="${call}"`));
  assert.ok(row && row.includes(`>${text}<`), `the row showing "${text}" carries ${call}`);
  app.run(call);
};
const face = (h) => (fs.existsSync(h.file('face.json')) ? JSON.parse(fileText(h, 'face.json')).value : null);
const faceWrites = (run) => run.sent.filter((m) => m.kind === 'save-data' && m.path === 'face.json').length;

// Every request the app sends, logged when it is sent: `saves` are its saves of the list, `asks` any
// agent run (none is wanted). `run.held` holds back the saves in order, one gate each, before they
// reach the server (a slow network); a save with no gate left goes at once.
function watch(relay, run) {
  return async (m) => {
    run.sent.push(m);
    if (m.kind === 'ask') run.asks.push(m);
    if (m.kind === 'save-data' && m.path === FILE) { run.saves.push(m); const held = run.held.shift(); if (held) await held; }
    return relay(m);
  };
}

// Boots the app; `ready()` resolves once its read of tasks.md has come back and been handled.
function start(dir, h, relay = h.relay) {
  const run = { asks: [], saves: [], held: [], sent: [] };
  let read = false;
  const watched = async (m) => { const r = await relay(m); if (m.kind === 'data') read = true; return r; };
  const app = boot(srcOf(dir, 'tasks'), watch(watched, run));
  const ready = async () => { await until(() => read, 'the read is back'); await settle(); };
  return { app, ready, run };
}

for (const dir of ['workspace/apps', 'workspace.example/apps']) {
  test(`${dir}/tasks: when the read fails, adding a task cannot replace the saved list`, () => withHarness('tasks', async (h) => {
    h.put(FILE, SAVED);
    h.state.fault = readFails(FILE);
    const { app, ready, run } = start(dir, h);
    await ready();
    assert.match(textOf(app, 'root'), SHELL_READ_FAILED, 'the reason is on screen');
    assert.doesNotMatch(listShown(app), /No tasks/, 'a failed read is not shown as an empty list');
    assert.equal(elOf(app, 'add-btn').disabled, true, 'the add button stays off');
    assert.equal(elOf(app, 'add-input').disabled, true, 'and so does the box (Enter adds too)');
    addPast(app, 'Buy milk');
    await refusedOrSent(app, h, FILE);
    assert.equal(run.saves.length + run.asks.length, 0, 'nothing is sent over the unread list');
    assert.equal(writesTo(h, FILE), 0);
    assert.equal(fileText(h, FILE), SAVED);
    assert.match(textOf(app, 'status'), SHELL_READ_FAILED, 'the refusal says why');
    assert.equal(faceWrites(run), 0, 'nor is a face counted from a list that was never read');
  }));

  test(`${dir}/tasks: a read that answers no text is unreadable, not an empty list`, () => withHarness('tasks', async (h) => {
    h.put(FILE, SAVED);
    const { app, ready, run } = start(dir, h, (m) => (m.kind === 'data' ? Promise.resolve({ ok: true }) : h.relay(m)));
    await ready();
    assert.match(textOf(app, 'root'), /unreadable/i);
    addPast(app, 'Buy milk');
    await refusedOrSent(app, h, FILE);
    assert.equal(run.saves.length + run.asks.length, 0);
    assert.equal(fileText(h, FILE), SAVED);
  }));

  test(`${dir}/tasks: a task added while the read is in flight is refused`, () => withHarness('tasks', async (h) => {
    h.put(FILE, SAVED);
    const read = heldReads(h.relay);
    const { app, ready, run } = start(dir, h, read.relay);
    assert.match(htmlOf(dir, 'tasks'), /id="add-input"[^>]*\bdisabled\b/, 'the box starts off');
    assert.match(htmlOf(dir, 'tasks'), /id="add-btn"[^>]*\bdisabled\b/, 'the button starts off');
    addPast(app, 'Buy milk');
    await refusedOrSent(app, h, FILE);
    assert.equal(run.saves.length + run.asks.length, 0, 'no write before the read returns');
    read.release();
    await ready();
    assert.deepEqual(tasksOf(app), ['Call Mom', 'Pay rent', 'Fix bike'], 'the saved list is what shows');
    assert.equal(elOf(app, 'add-btn').disabled, false, 'and the bar comes on');
    assert.equal(fileText(h, FILE), SAVED);
  }));

  // R14 control: the guard must not also block the genuine first run.
  test(`${dir}/tasks: no tasks.md yet starts empty, and the first task is saved`, () => withHarness('tasks', async (h) => {
    const { app, ready, run } = start(dir, h);
    await ready();
    assert.match(listShown(app), /No tasks/, 'a first run shows its empty list');
    assert.doesNotMatch(listShown(app) + textOf(app, 'status'), /load|unreadable|error/i, 'not a failure');
    assert.equal(elOf(app, 'add-btn').disabled, false, 'the add bar is on');
    await until(() => face(h) === '0', 'the tile says nothing is open');
    add(app, 'Buy milk');
    await until(() => fs.existsSync(h.file(FILE)), 'the first task is saved');
    assert.equal(fileText(h, FILE), '- [ ] Buy milk');
    assert.deepEqual({ ...run.saves[0], id: 0 }, { pa: 'req', id: 0, kind: 'save-data', what: 'data', path: FILE, data: '- [ ] Buy milk' },
      'the list itself, through save-data, so a failure reads "Data … not saved"');
    assert.equal(run.asks.length, 0, 'no agent run');
    await until(() => /Saved/.test(textOf(app, 'status')), 'it says so');
    await until(() => face(h) === '1', 'and the tile counts it');
  }));

  // R14 control: a list that DID load is saved whole — the guard costs the user no task.
  test(`${dir}/tasks: a saved list loads, and an added task is saved with every other one`, () => withHarness('tasks', async (h) => {
    h.put(FILE, SAVED);
    const { app, ready } = start(dir, h);
    await ready();
    assert.deepEqual(tasksOf(app), ['Call Mom', 'Pay rent', 'Fix bike'], 'markdown is read as markdown, not parsed as JSON');
    assert.equal(textOf(app, 'status'), '', 'nothing to report');
    addByEnter(app, 'Buy milk');
    await until(() => /Saved/.test(textOf(app, 'status')), 'the save is done');
    assert.equal(fileText(h, FILE), '## Today\n- [ ] Call Mom\n- [x] Pay rent\n\n## Later\n- [ ] Fix bike\n- [ ] Buy milk\n');
  }));

  // THE BUG (2026-10-13): each save was an agent run of seconds to minutes, and the follow-up save of a
  // change made meanwhile was sent only when it was back, and leaving then blanked the frame (before
  // ADR 0018), so a change made in that time was lost. Now the list leaves the page in the same tap, as
  // one save-data the shell relays: the app is not touched again below, and the write lands. Leaving
  // itself (a held page, ADR 0018) is test/app-leave-tasks.test.mjs; real browsers: ADR 0014.
  test(`${dir}/tasks: a change leaves the page in the same tap, so the app has nothing left to send`, () => withHarness('tasks', async (h) => {
    h.put(FILE, SAVED);
    const { app, ready, run } = start(dir, h);
    await ready();
    add(app, 'Buy milk');
    assert.equal(run.saves.length, 1, 'sent before the tap returns, not after an agent run');
    assert.match(run.saves[0].data, /- \[ \] Buy milk/);
    await until(() => /Buy milk/.test(fileText(h, FILE)), 'the write lands with the app left alone');
    assert.equal(fileText(h, FILE), '## Today\n- [ ] Call Mom\n- [x] Pay rent\n\n## Later\n- [ ] Fix bike\n- [ ] Buy milk\n');
    assert.equal(run.asks.length, 0, 'no agent run, for this save or any other');
  }));

  // THE BUG (2026-10-12): save() returned at once while a save was out, so a change made in that
  // time was on screen but never sent, the first save's reply said "Saved ✓", and a reload lost it.
  test(`${dir}/tasks: changes made while a save is out are sent after it, in one more save`, () => withHarness('tasks', async (h) => {
    h.put(FILE, SAVED);
    const { app, ready, run } = start(dir, h);
    await ready();
    const first = deferred(), second = deferred();
    run.held.push(first.promise, second.promise);
    add(app, 'Buy milk');
    await until(() => run.saves.length === 1, 'the first save is out');
    tap(app, 'toggleDone(1)', 'Call Mom');      // ticked while the save is out
    tap(app, 'startEdit(5)', 'Fix bike');       // opened, then deleted, while the save is out
    tap(app, 'deleteTask(5)', 'Fix bike');
    await settle();
    assert.equal(run.saves.length, 1, 'one save at a time: two saves out at once could land out of order');
    assert.equal(textOf(app, 'status'), 'Saving…');
    first.resolve();
    await until(() => run.saves.length === 2, 'one more save is sent when the first is back');
    await settle();
    assert.equal(textOf(app, 'status'), 'Saving…', 'the first reply does not say "Saved ✓" over changes not yet sent');
    second.resolve();
    await until(() => /Saved/.test(textOf(app, 'status')), 'the last save is done');
    await settle();
    assert.equal(fileText(h, FILE), '## Today\n- [x] Call Mom\n- [x] Pay rent\n\n## Later\n- [ ] Buy milk\n', 'every change is in the file');
    assert.equal(run.saves.length, 2, 'two changes made while it was out cost one more save, not two');
    assert.equal(face(h), '1', 'the tile counts the list as saved last');
    assert.equal(faceWrites(run), 3, 'a face on load and one per save sent');
  }));

  // The save after it sends the whole list, so it also carries what a failed save did not write.
  test(`${dir}/tasks: a save that fails while a change is made is written whole by the save after it`, () => withHarness('tasks', async (h) => {
    h.put(FILE, SAVED);
    const { app, ready, run } = start(dir, h);
    await ready();
    const first = deferred(), second = deferred();
    run.held.push(first.promise, second.promise);
    h.state.fault = saveFails(FILE);
    add(app, 'Buy milk');
    await until(() => run.saves.length === 1, 'the first save is out');
    tap(app, 'toggleDone(1)', 'Call Mom');      // ticked while the save is out
    first.resolve();
    await until(() => run.saves.length === 2, 'one more save is sent when the failed one is back');
    assert.equal(fileText(h, FILE), SAVED, 'the first save wrote nothing');
    h.state.fault = null;
    second.resolve();
    await until(() => /Saved/.test(textOf(app, 'status')), 'the last save is done');
    assert.equal(fileText(h, FILE), '## Today\n- [x] Call Mom\n- [x] Pay rent\n\n## Later\n- [ ] Fix bike\n- [ ] Buy milk\n',
      'the failed save\'s task is in the file too');
  }));

  test(`${dir}/tasks: a failed save shows the shell's sentence, and it stays`, () => withHarness('tasks', async (h) => {
    h.put(FILE, SAVED);
    const { app, ready, run } = start(dir, h);
    await ready();
    h.state.fault = saveFails(FILE);
    add(app, 'Buy milk');
    await until(() => SHELL_SAVE_FAILED.test(textOf(app, 'status')), 'the failure is on screen');
    app.clock.advance(10000);
    assert.match(textOf(app, 'status'), SHELL_SAVE_FAILED, 'not cleared like a success');
    assert.equal(fileText(h, FILE), SAVED);
  }));

  // A success clears its "Saved ✓" after 2 s. That clear must not land on a save that failed since.
  test(`${dir}/tasks: an earlier success never clears a later failure`, () => withHarness('tasks', async (h) => {
    h.put(FILE, SAVED);
    const { app, ready, run } = start(dir, h);
    await ready();
    add(app, 'Buy milk');
    await until(() => /Saved/.test(textOf(app, 'status')), 'the first save is done');
    app.clock.advance(1000);
    h.state.fault = saveFails(FILE);
    add(app, 'Call the bank');
    await until(() => SHELL_SAVE_FAILED.test(textOf(app, 'status')), 'the second save failed, on screen');
    app.clock.advance(1500);                    // past the first save's 2 s
    assert.match(textOf(app, 'status'), SHELL_SAVE_FAILED, 'still on screen');
  }));
}
