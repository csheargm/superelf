// The flows that used to depend on a native modal, run for real: each app's own script, the shell
// relay and a real node:http server over a throwaway directory (helpers-app.mjs). Only the DOM, the
// clock and FileReader are stubbed.
//
// THE BUG (2026-10-12): superelf runs apps under CSP `sandbox allow-scripts` with no allow-modals,
// where confirm() returns false at once and alert() does nothing. Family's "Remove this member?"
// and Productivity Hub's "Reset all data?" therefore cancelled every time, and a failed topic save
// (Daily Digest) or an import (Productivity Hub) said nothing. test/app-contract.test.mjs stops
// the calls coming back; this file proves the replacements actually do the job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHarness, until, settle } from './helpers-app.mjs';
import { htmlOf, srcOf, el, boot, writesTo, FakeFileReader, pickFile, saveFails, SHELL_SAVE_FAILED } from './helpers-sandbox-app.mjs';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ── Family: remove a member ─────────────────────────────────────────────────────────────────
const FAMILY = srcOf('workspace/apps', 'family');
const FAMILY_FILE = 'family-data.json';
const TWO = { members: [{ id: 'a', name: 'Ann', rel: 'child' }, { id: 'b', name: 'Ben', rel: 'teen' }] };

async function bootFamily(h) {
  h.put(FAMILY_FILE, TWO);
  const app = boot(FAMILY, h.relay);
  await until(() => app.run('members.length') === 2, 'the saved members are loaded');
  return app;
}
// The user's path to the Delete button: tap a member, then ✏️.
const editMember = (app, id) => app.run(`openMember('${id}'); openEdit();`);

test('family: the second tap on Delete removes the member and saves', async () => {
  const h = await startHarness('family');
  try {
    const app = await bootFamily(h);
    editMember(app, 'a');
    const btn = app.els['form-del-btn'];
    btn.textContent = 'Delete';
    app.run('deleteMember()');
    await settle();
    assert.equal(writesTo(h, FAMILY_FILE), 0, 'one tap only asks — nothing is written');
    assert.equal(btn.textContent, 'Delete? · 删除?');
    app.run('deleteMember()');
    await until(() => readJson(h.file(FAMILY_FILE)).members.length === 1, 'the delete is saved');
    assert.deepEqual(readJson(h.file(FAMILY_FILE)).members.map((m) => m.id), ['b']);
    assert.equal(btn.textContent, 'Delete', 'the button is disarmed after it acts');
  } finally { await h.stop(); }
});

test('family: an armed Delete forgets after the timeout and when another member is opened', async () => {
  const h = await startHarness('family');
  try {
    const app = await bootFamily(h);
    editMember(app, 'a');
    const btn = app.els['form-del-btn'];
    btn.textContent = 'Delete';
    app.run('deleteMember()');                            // armed for Ann…
    app.run('cancelForm()');
    editMember(app, 'b');                                 // …then Ben's form, within the 3 s
    assert.equal(btn.textContent, 'Delete', 'opening the form disarms the shared button');
    app.run('deleteMember()');
    app.clock.advance(app.run('DELETE_ARM_MS'));
    assert.equal(btn.textContent, 'Delete', 'the arm expires');
    app.run('deleteMember()');
    await settle();
    assert.equal(app.run('members.length'), 2, 'no single tap ever deleted anyone');
    assert.equal(writesTo(h, FAMILY_FILE), 0);
  } finally { await h.stop(); }
});

// ── Productivity Hub: reset and import, in the owner's copy AND the shelf copy ─────────────
const HUB_FILE = 'productivity-hub.json';
const HUB_SAVED = { tasks: [{ id: 1, text: 'Buy milk', done: false }], notes: [] };

for (const dir of ['workspace/apps', 'shared-apps']) {
  const HUB = srcOf(dir, 'productivity-hub');
  const bootHub = async (h) => {
    h.put(HUB_FILE, HUB_SAVED);
    const app = boot(HUB, h.relay, { FileReader: FakeFileReader });
    await until(() => app.run('state.tasks.length') === 1, 'the saved tasks are loaded');
    return app;
  };

  test(`${dir}/productivity-hub: Reset all data takes two taps, and a lapsed arm does not count`, async () => {
    const h = await startHarness('productivity-hub');
    try {
      const app = await bootHub(h);
      const btn = Object.assign(el('reset'), { textContent: 'Reset all data' });
      const tap = () => app.run('resetAll')(btn);
      tap();
      app.clock.advance(app.run('DELETE_ARM_MS'));
      assert.equal(btn.textContent, 'Reset all data', 'the arm expires');
      tap();
      await settle();
      // Counted by CONTENT, not by writes: advancing the clock also fires the app's own debounced
      // save from boot, which is a legitimate write of the same tasks.
      assert.equal(app.run('state.tasks.length'), 1, 'two taps 3 s apart are two first taps — nothing is wiped');
      assert.equal(readJson(h.file(HUB_FILE)).tasks.length, 1);
      assert.equal(btn.textContent, 'Reset all data? · 清空所有数据?');
      tap();
      await until(() => readJson(h.file(HUB_FILE)).tasks.length === 0, 'the reset is saved');
      assert.equal(btn.textContent, 'Reset all data');
      // The test hands resetAll a button; the page must too, or a real tap throws on btn.classList.
      assert.match(htmlOf(dir, 'productivity-hub'), /<button class="settings-btn danger" onclick="resetAll\(this\)">Reset all data</);
    } finally { await h.stop(); }
  });

  test(`${dir}/productivity-hub: an import reports its result on the page`, async () => {
    const h = await startHarness('productivity-hub');
    try {
      const app = await bootHub(h);
      await pickFile(app, '{not json');
      assert.equal(app.els['data-msg'].textContent, 'Invalid JSON file · JSON 文件无效');
      assert.equal(writesTo(h, HUB_FILE), 0, 'a bad file writes nothing');
      await pickFile(app, JSON.stringify({ tasks: [{ id: 7, text: 'Imported task', done: false }] }));
      await until(() => app.els['data-msg'].textContent === 'Imported · 已导入', '"Imported" once the import is saved');
      await until(() => readJson(h.file(HUB_FILE)).tasks[0]?.id === 7, 'the import is saved');
      const btn = Object.assign(el('reset'), { textContent: 'Reset all data' });
      app.run('resetAll')(btn); app.run('resetAll')(btn);
      assert.equal(app.els['data-msg'].textContent, '', 'a reset clears the stale "Imported"');
    } finally { await h.stop(); }
  });
}

// ── Daily Digest: a topic save that fails ──────────────────────────────────────────────────
const DIGEST = srcOf('workspace/apps', 'daily-digest');

async function openDigestEditor(h) {
  const app = boot(DIGEST, h.relay);
  await until(() => /失败|✓/.test(app.els.status?.textContent || ''), 'the first load finishes');
  app.els['edit-btn'].onclick();
  return app;
}

test('daily-digest: a failed topic save is shown in the editor, which stays open', async () => {
  const h = await startHarness('daily-digest');
  try {
    h.state.fault = saveFails('topics.json');
    const app = await openDigestEditor(h);
    await app.els['editor-save'].onclick();
    assert.match(app.els['editor-msg'].textContent, SHELL_SAVE_FAILED);
    assert.equal(app.els.editor.classList.contains('hidden'), false, 'the edits are still on screen');
    app.els['editor-close'].onclick();
    app.els['edit-btn'].onclick();
    assert.equal(app.els['editor-msg'].textContent, '', 'reopening starts clean');
  } finally { await h.stop(); }
});

// R14 control: the message must come from the failure, not from every save.
test('daily-digest: a topic save that works closes the editor with no message', async () => {
  const h = await startHarness('daily-digest');
  try {
    const app = await openDigestEditor(h);
    await app.els['editor-save'].onclick();
    assert.equal(app.els['editor-msg'].textContent, '');
    assert.equal(app.els.editor.classList.contains('hidden'), true);
    assert.equal(writesTo(h, 'topics.json'), 1);
  } finally { await h.stop(); }
});
