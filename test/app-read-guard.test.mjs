// A FAILED read must never become an empty start, run for real: each app's own script, the shell
// relay and a real node:http server over a throwaway directory (helpers-app.mjs,
// helpers-sandbox-app.mjs). Only the DOM and the clock are stubbed.
//
// THE BUG (found by code reading, 2026-10-12): Family, Productivity Hub and Daily Digest took ANY
// failed or unreadable read of their data file as "nothing saved yet", so the next save — an Add,
// a debounced autosave, a topic edit — wrote that empty or default state over the user's real
// file. Same bug and same fix as badminton (commit ffbc839): 'not-found' is a first run; any other
// failure is shown and blocks saves until a read succeeds.
//
// Every fault below fails only the READ (`on:'get'`), so a save the app wrongly sends WOULD land
// and overwrite the file. A fault that also refused writes would make every "the file survived"
// assertion vacuous (R14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { until } from './helpers-app.mjs';
import { htmlOf, srcOf, boot, writesTo, FakeFileReader, pickFile, readFails, saveFails, textOf as text, fileText,
  unreadable, withHarness, heldReads, refusedOrSent, SHELL_SAVE_FAILED } from './helpers-sandbox-app.mjs';

// A value out of the app's vm realm, as plain JSON: its arrays carry another realm's prototype.
const valueOf = (app, expr) => JSON.parse(app.run(`JSON.stringify(${expr})`));

// ── Family ─────────────────────────────────────────────────────────────────────────────────
const FAMILY = srcOf('workspace/apps', 'family');
const FAMILY_FILE = 'family-data.json';
const TWO = JSON.stringify({ members: [{ id: 'a', name: 'Ann', rel: 'child' }, { id: 'b', name: 'Ben', rel: 'teen' }] });
const grid = (app) => app.els['member-grid']?.innerHTML || '';
const EMPTY_FAMILY = /Add your family members/;

// The user's path: + Add family member, a name, Save. Driven even while + is off, to prove the
// save itself refuses — the disabled button is only the first line.
function addMember(app, name) {
  app.run('openAdd()');
  app.els['f-name'].value = name;
  app.run('saveMember()');
}

for (const [why, prep, said] of unreadable(FAMILY_FILE, TWO)) {
  test(`family: when ${why}, adding a member cannot overwrite the saved family`, () => withHarness('family', async (h) => {
    prep(h);
    const before = fileText(h, FAMILY_FILE);
    const app = boot(FAMILY, h.relay);
    await until(() => grid(app) !== '' || text(app, 'status') !== '', 'the first read has settled');
    const shown = grid(app);
    addMember(app, 'Cy');
    await refusedOrSent(app, h, FAMILY_FILE);
    assert.equal(writesTo(h, FAMILY_FILE), 0, 'no save was sent over the unread file');
    assert.equal(fileText(h, FAMILY_FILE), before);
    assert.doesNotMatch(shown, EMPTY_FAMILY, 'a failed read is not shown as an empty family');
    assert.match(text(app, 'status'), said || /^家庭文件无法读取 · Family file unreadable/, 'the reason is on screen');
    assert.equal(app.els['add-btn']?.disabled, true, '+ Add stays off');
  }));
}

test('family: + Add starts off, and a save made while the first read is in flight is refused', () => withHarness('family', async (h) => {
  h.put(FAMILY_FILE, TWO);
  const read = heldReads(h.relay);
  const app = boot(FAMILY, read.relay);
  addMember(app, 'Cy');
  await refusedOrSent(app, h, FAMILY_FILE);
  assert.equal(writesTo(h, FAMILY_FILE), 0, 'no save before the read returns');
  assert.match(htmlOf('workspace/apps', 'family'), /<button class="add-member-btn" id="add-btn"[^>]*\bdisabled\b/,
    '+ Add starts disabled in the page itself');
  read.release();
  await until(() => app.run('members.length') === 2, 'the saved members load');
  assert.equal(app.els['add-btn'].disabled, false, '+ Add is on once the family has loaded');
  assert.equal(text(app, 'status'), '', 'the "still loading" note clears');
  assert.equal(fileText(h, FAMILY_FILE), TWO);
}));

// R14 control: the guard must not also block the genuine first run.
test('family: no saved file yet starts empty, and the first member is saved', () => withHarness('family', async (h) => {
  const app = boot(FAMILY, h.relay);
  await until(() => EMPTY_FAMILY.test(grid(app)), 'the empty state');
  addMember(app, 'Cy');
  await until(() => fs.existsSync(h.file(FAMILY_FILE)), 'the first member is saved');
  assert.deepEqual(JSON.parse(fileText(h, FAMILY_FILE)).members.map((m) => m.name), ['Cy']);
}));

test('family: a failed save is shown, not dropped', () => withHarness('family', async (h) => {
  h.put(FAMILY_FILE, TWO);
  const app = boot(FAMILY, h.relay);
  await until(() => app.run('members.length') === 2, 'the saved members load');
  h.state.fault = saveFails(FAMILY_FILE);
  addMember(app, 'Cy');
  await until(() => text(app, 'status') !== '', 'the failure is on screen');
  assert.match(text(app, 'status'), SHELL_SAVE_FAILED);
  assert.equal(fileText(h, FAMILY_FILE), TWO);
}));

// ── Productivity Hub, in the owner's copy AND the shelf copy ───────────────────────────────
const HUB_FILE = 'productivity-hub.json';
const HUB_SAVED = JSON.stringify({ tasks: [{ id: 1, text: 'Buy milk', done: false }], notes: [] });
const PAST_ANY_DEBOUNCE_MS = 60_000;
// init() ticks the clock only after the first read has settled.
const hubSettled = (app) => text(app, 'clock-time') !== '';

// The user's path: type a task, press +. The app saves on a debounce, so the clock moves past it.
function addTask(app, words) {
  app.run("document.getElementById('task-input')").value = words;
  app.run('addTask()');
  app.clock.advance(PAST_ANY_DEBOUNCE_MS);
}

for (const dir of ['workspace/apps', 'shared-apps']) {
  const HUB = srcOf(dir, 'productivity-hub');

  for (const [why, prep, said] of unreadable(HUB_FILE, HUB_SAVED)) {
    test(`${dir}/productivity-hub: when ${why}, no save overwrites the saved tasks`, () => withHarness('productivity-hub', async (h) => {
      prep(h);
      const before = fileText(h, HUB_FILE);
      const app = boot(HUB, h.relay);
      await until(() => hubSettled(app), 'the first read has settled');
      addTask(app, 'Call Mom');
      await refusedOrSent(app, h, HUB_FILE);
      assert.equal(writesTo(h, HUB_FILE), 0, 'no save was sent over the unread file');
      assert.equal(fileText(h, HUB_FILE), before);
      assert.match(text(app, 'status'), /\S.* — 未保存 · not saved/, 'the reason is on screen');
      assert.match(text(app, 'status'), said || (dir === 'shared-apps' ? /^Data file unreadable · 数据文件无法读取/ : /^数据文件无法读取 · Data file unreadable/), 'in the shell\'s words when the read failed');
    }));
  }

  test(`${dir}/productivity-hub: an import after a failed read is not saved, and does not say "Imported"`, () => withHarness('productivity-hub', async (h) => {
    h.put(HUB_FILE, HUB_SAVED);
    h.state.fault = readFails(HUB_FILE);
    const app = boot(HUB, h.relay, { FileReader: FakeFileReader });
    await until(() => hubSettled(app), 'the first read has settled');
    await pickFile(app, JSON.stringify({ tasks: [{ id: 7, text: 'Imported task', done: false }] }));
    await until(() => text(app, 'data-msg') !== '', 'the import reports');
    assert.equal(writesTo(h, HUB_FILE), 0, 'no save was sent over the unread file');
    assert.equal(text(app, 'data-msg'), dir === 'shared-apps' ? 'Import not saved · 导入未保存' : '导入未保存 · Import not saved');   // shared-apps: the shelf snapshot keeps its words until promoted
    assert.equal(fileText(h, HUB_FILE), HUB_SAVED);
  }));

  test(`${dir}/productivity-hub: a change made while the first read is in flight is not saved over it`, () => withHarness('productivity-hub', async (h) => {
    h.put(HUB_FILE, HUB_SAVED);
    const read = heldReads(h.relay);
    const app = boot(HUB, read.relay);
    addTask(app, 'Call Mom');
    await refusedOrSent(app, h, HUB_FILE);
    assert.equal(writesTo(h, HUB_FILE), 0, 'no save before the read returns');
    read.release();
    await until(() => hubSettled(app), 'the saved tasks load');
    assert.deepEqual(valueOf(app, 'state.tasks.map((t) => t.text)'), ['Buy milk']);
    assert.equal(text(app, 'status'), '', 'the "still loading" note clears');
    assert.equal(fileText(h, HUB_FILE), HUB_SAVED);
  }));

  // R14 control: the guard must not also block the genuine first run.
  test(`${dir}/productivity-hub: no saved file yet starts empty, and the first task is saved`, () => withHarness('productivity-hub', async (h) => {
    const app = boot(HUB, h.relay);
    await until(() => hubSettled(app), 'the first read has settled');
    addTask(app, 'Call Mom');
    await until(() => fs.existsSync(h.file(HUB_FILE)), 'the first task is saved');
    assert.deepEqual(JSON.parse(fileText(h, HUB_FILE)).tasks.map((t) => t.text), ['Call Mom']);
  }));

  test(`${dir}/productivity-hub: a failed save is shown, not dropped`, () => withHarness('productivity-hub', async (h) => {
    h.put(HUB_FILE, HUB_SAVED);
    const app = boot(HUB, h.relay);
    await until(() => hubSettled(app), 'the saved tasks load');
    h.state.fault = saveFails(HUB_FILE);
    addTask(app, 'Call Mom');
    await until(() => text(app, 'status') !== '', 'the failure is on screen');
    assert.match(text(app, 'status'), SHELL_SAVE_FAILED);
    assert.equal(fileText(h, HUB_FILE), HUB_SAVED);
  }));
}

// ── Daily Digest ───────────────────────────────────────────────────────────────────────────
const DIGEST = srcOf('workspace/apps', 'daily-digest');
const TOPICS = 'data/daily-digest/topics.json';   // the app's own path; the shell namespaces it again
const MINE = JSON.stringify([{ key: 'garden', name: 'My garden', icon: '🌱', query: 'roses' }]);
const TOPICS_NOT_LOADED = /主题未能读取/;
const digestSettled = (app) => /失败|✓/.test(text(app, 'status')) || TOPICS_NOT_LOADED.test(text(app, 'status'));

// The user's path: 编辑, then 保存并刷新. Save is pressed even when the editor did not open, to
// prove the save itself refuses. The sheet starts hidden, as the page's class="modal hidden" has it.
async function saveTopics(app) {
  app.run("document.getElementById('editor')").classList.add('hidden');
  app.els['edit-btn'].onclick();
  await app.els['editor-save'].onclick();
}
const editorOpen = (app) => !app.els.editor.classList.contains('hidden');

for (const [why, prep, said] of unreadable(TOPICS, MINE)) {
  test(`daily-digest: when ${why}, the default topics are never saved over the user's`, () => withHarness('daily-digest', async (h) => {
    prep(h);
    const before = fileText(h, TOPICS);
    const app = boot(DIGEST, h.relay);
    await until(() => digestSettled(app), 'the first load has settled');
    await saveTopics(app);
    assert.equal(writesTo(h, 'topics.json'), 0, 'no topic save was sent over the unread file');
    assert.equal(fileText(h, TOPICS), before);
    assert.equal(editorOpen(app), false, 'the editor never offered the defaults as the user\'s topics');
    assert.match(text(app, 'status'), TOPICS_NOT_LOADED, 'the reason is on screen');
    if (said) assert.match(text(app, 'status'), said, 'with the shell\'s sentence for the failed read');
  }));
}

test('daily-digest: 编辑 tapped while the topics are still loading does not offer the defaults', () => withHarness('daily-digest', async (h) => {
  h.put(TOPICS, MINE);
  const read = heldReads(h.relay);
  const app = boot(DIGEST, read.relay);
  await saveTopics(app);
  assert.equal(writesTo(h, 'topics.json'), 0, 'no topic save before the read returns');
  assert.equal(editorOpen(app), false, 'the editor waits for the user\'s topics');
  read.release();
  await until(() => digestSettled(app), 'the first load has settled');
  await saveTopics(app);
  assert.equal(writesTo(h, 'topics.json'), 1, 'once loaded, the save goes through');
  assert.deepEqual(JSON.parse(fileText(h, TOPICS)), JSON.parse(MINE), 'the editor then saves the user\'s own list');
}));

test('daily-digest: 刷新 reads the topics again, and once they load the user\'s list is what saves', () => withHarness('daily-digest', async (h) => {
  h.put(TOPICS, MINE);
  h.state.fault = readFails('topics.json');
  const app = boot(DIGEST, h.relay);
  await until(() => TOPICS_NOT_LOADED.test(text(app, 'status')), 'the read failure is on screen');
  h.state.fault = null;
  app.els['refresh-btn'].onclick();
  await until(() => /失败|✓/.test(text(app, 'status')), 'the retried load has settled');
  await saveTopics(app);
  assert.equal(writesTo(h, 'topics.json'), 1, 'after the retry the save goes through');
  assert.deepEqual(JSON.parse(fileText(h, TOPICS)), JSON.parse(MINE));
}));

// R14 control: the guard must not also block the genuine first run.
test('daily-digest: no topics file yet uses the defaults, and saving them works', () => withHarness('daily-digest', async (h) => {
  const app = boot(DIGEST, h.relay);
  await until(() => digestSettled(app), 'the first load has settled');
  await saveTopics(app);
  assert.deepEqual(JSON.parse(fileText(h, TOPICS)).map((t) => t.key), valueOf(app, 'DEFAULT_TOPICS.map((t) => t.key)'));
}));
