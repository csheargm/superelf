// The noun in a failed save's sentence (2026-10-12). The shell's broker names what a save-data request
// carried: the request's own `what`, else the kind's default, 'note' (web/index.html relayKindWhat).
// PAStore sent no `what`, so when Family, Productivity Hub, Calendar, Brainstorm, Rental Hunt
// or Daily Digest failed to save, the user read "Note not saved" about a family member, a task or a
// topic. PAStore now sends what:'data'. The default stays 'note': the PANote hosts (Notes, Bible) save
// their notebooks with no `what`, and their live copies are not changed by this fix.
//
// The PAStore half is pinned by the "a failed save is shown" flows of the PAStore apps in
// test/app-read-guard*.test.mjs and test/sandbox-modal-flows.test.mjs (SHELL_SAVE_FAILED). This file
// pins the other half: a PANote save that fails is answered "Note", and the screen shows that sentence.
// Run for real: the app's own script, the shell's broker (makeRelay) and a real node:http server over a
// throwaway directory.
//
// TODO: apps that send save-data themselves with no `what` still get "Note" for data that is not a
// note. On screen: Allergy (pollen.json; its flow asserts SHELL_NOTE_SAVE_FAILED) and Diabetes (shows
// r.text). Not on screen: Daily Digest's cache (shows its own 生成失败 instead), Tasks' face.json and
// PAChat's persist map (replies ignored). Each says what:'data' in its own change, in workspace/apps
// and, for Diabetes and Tasks, the workspace.example copy too.
//
// The screen (2026-10-12): PANote.saveOutcome used to keep a failed reply's `error` and drop its
// `text`, so Notes and the Bible showed "未保存 · Not saved — <raw error>" and never the shell's
// sentence; PANote's own save pill showed the raw error too. saveOutcome now carries `text`, the pill
// shows it, and the hosts show PANote.notSavedText(r). The templates (workspace.example) are changed.
// The owner's live copies (workspace/apps) are held back: a merge into main rewrites them on the live
// node at once, and that edit was left to the owner. They sit in LIVE_PENDING below, the
// PENDING-ledger way of test/app-contract.test.mjs. shared-apps/ follows at the owner's next promote
// (a byte-manifested snapshot, test/line-endings.test.mjs, never hand-edited).
//
// TODO: these saves keep a heading of their own, which names the action better than the shell's
// "Note" would: the Notes note-list save (journal.json: IDX_NOT_SAVED, and deleteById's 'Delete
// failed') and the Bible's rename/delete in another chapter's file ('Rename not saved', 'Delete not
// saved'). Each still shows the raw r.error; each needs a noun of its own in the shell first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENG, GUARD, startHarness, runApp, until } from './helpers-app.mjs';
import { saveFails, SHELL_NOTE_SAVE_FAILED } from './helpers-sandbox-app.mjs';

const NOTEBOOK = { v: 3, id: 'nb', pages: [{ id: 'p0', strokes: [{ p: [[0, 0]] }], images: [] }] };
const HOST_CALL = 'PANote.notSavedText(r)';
const OWN_WORDING = /PANote\.NOT_SAVED\s*\+/;            // a host composing its own words over the reply
const OLD_WORDING = "PANote.NOT_SAVED+' — '+r.error";
const RETRYING = ' — ' + ENG.RETRYING;
// A visible debt with an owner: these copies still show PANote.NOT_SAVED + r.error. Each must go on
// showing exactly that until the owner gives it PANote.notSavedText(r); then its line must be struck off.
const LIVE_PENDING = new Set(['notes (live)', 'bible (live)']);

// The harness's relay, recording what each save-data request named and what the shell answered.
function recordingSaves(h) {
  const saves = [];
  const relay = async (m) => {
    const r = await h.relay(m);
    if (m.kind === 'save-data') saves.push({ path: m.path, what: m.what, reply: r });
    return r;
  };
  return { relay, lastTo: (name) => saves.filter((s) => s.path.endsWith(name)).at(-1) };
}

function assertNoteNoun(sent) {
  assert.ok(sent, 'the save was sent (a save never sent would prove nothing)');
  assert.equal(sent.what, undefined, 'a PANote host names no noun: the shell default decides it');
  assert.equal(sent.reply.ok, false);
  assert.match(sent.reply.text, SHELL_NOTE_SAVE_FAILED);
}

// One failed note save in the Notes app → {sent, outcome, screen, pill}. `pill` is PANote's own save
// bar: the stub pad runs the engine's real guard, and state().text is what renderSave paints.
async function notesSaveFails(key, opts = {}) {
  const h = await startHarness('notes');
  const saves = recordingSaves(h);
  let A;
  try {
    h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'a', updated: 1 }] });
    h.put('entry-e0.json', NOTEBOOK);
    A = runApp(key, saves.relay, ['S', 'openEntry'], { clampTimers: true, ...opts });
    await until(() => A.S.entries.length === 1, 'boot');
    await A.openEntry('e0');
    h.state.fault = saveFails('entry-e0.json');
    const pad = A.captured.pads[0];
    pad.nb.pages[0].strokes.push({ p: [[5, 5]] });
    pad.guard.touch();
    const outcome = await pad.guard.flush();
    return { sent: saves.lastTo('entry-e0.json'), outcome, screen: A.noticeOn() ? A.noticeText() : '', pill: pad.guard.state().text };
  } finally { A?.stopPads(); await h.stop(); }
}

// Every Bible PANote save is this chapter write: the notebook goes into the chapter object and the
// whole chapter file is written by saveAnn.
async function bibleSaveFails(key, opts = {}) {
  const h = await startHarness('bible');
  const saves = recordingSaves(h);
  let A;
  try {
    h.put('notes/43-3.json', { notes: { v16: 'keep me' }, draws: {}, chat: {} });
    A = runApp(key, saves.relay, ['loadAnn', 'saveAnn', 'annPath', 'annRetryStop', 'get ANN(){return ANN}',
      'setCh:(b,c)=>{bookIdx=b;chapter=c;}'], { clampTimers: true, ...opts });
    A.setCh(42, 3);
    await A.loadAnn();
    h.state.fault = saveFails('43-3.json');
    A.ANN.draws.v16 = NOTEBOOK;
    const outcome = await A.saveAnn();
    return { sent: saves.lastTo('43-3.json'), outcome, screen: A.noticeOn() ? A.noticeText() : '' };
  } finally { if (A) A.annRetryStop(A.annPath()); await h.stop(); }
}

for (const [app, run] of [['notes', notesSaveFails], ['bible', bibleSaveFails]]) {
  for (const key of [`${app} (template)`, `${app} (live)`]) {
    const how = LIVE_PENDING.has(key) ? 'shown in its old words (LIVE_PENDING)' : 'shown';
    test(`${key}: a PANote save that fails is answered "Note not saved" and ${how}`, async () => {
      const { sent, outcome, screen, pill } = await run(key);
      assert.equal(outcome.ok, false, 'the save is rejected');
      assertNoteNoun(sent);
      assert.equal(outcome.text, sent.reply.text, "PANote.saveOutcome hands the app the shell's sentence");
      if (app === 'notes') assert.equal(pill, sent.reply.text + RETRYING, "PANote's own pill says the same sentence");
      if (!LIVE_PENDING.has(key)) return assert.match(screen, SHELL_NOTE_SAVE_FAILED, 'on screen: ' + screen);
      assert.doesNotMatch(screen, SHELL_NOTE_SAVE_FAILED, `${key} shows the shell's sentence now: strike it off LIVE_PENDING`);
      assert.ok(screen.startsWith(ENG.SAVE_TXT.notSaved + ' — '), 'still reported, in its old words: ' + screen);
    });
  }
  // CONTROL (R14): the screen check can fail. The template with its old wording put back shows the
  // bare error, and the same assertion rejects it — so the pass above is the change, not the harness.
  test(`CONTROL: ${app} (template) with the old host wording is caught on screen`, async () => {
    const { screen } = await run(`${app} (template)`, { mutate: (src) => src.split(HOST_CALL).join(OLD_WORDING) });
    assert.ok(screen.startsWith(ENG.SAVE_TXT.notSaved + ' — '), 'the old wording is up: ' + screen);
    assert.doesNotMatch(screen, SHELL_NOTE_SAVE_FAILED);
  });
}

test('saveOutcome carries the shell sentence; notSavedText prefers it', () => {
  const { outcomeOf, notSavedText, SAVE_TXT } = ENG;
  assert.deepEqual(outcomeOf({ ok: false, code: 'server-error', error: 'e', text: 'T' }), { ok: false, error: 'e', text: 'T' });
  assert.deepEqual(outcomeOf({ ok: false, error: 'e' }), { ok: false, error: 'e' }, 'no sentence, no text key: the shape is unchanged');
  assert.deepEqual(outcomeOf({ ok: false, error: 'e', text: '' }), { ok: false, error: 'e' }, 'an empty sentence is no sentence');
  assert.deepEqual(outcomeOf({ ok: true }), { ok: true }, 'a success stays exactly {ok:true}');
  assert.equal(notSavedText({ ok: false, error: 'e', text: 'T' }), 'T', "the shell's words, alone");
  assert.equal(notSavedText({ ok: false, error: 'save timed out' }), SAVE_TXT.notSaved + ' — save timed out',
    'a failure the shell never saw keeps its reason');
  assert.equal(notSavedText(undefined), SAVE_TXT.notSaved, 'and is never empty');
});

// The pill follows the LAST failure: a shell sentence, then a failure nothing worded (a timeout).
test("PANote's pill shows the shell sentence, and its own words for a failure the shell never saw", async () => {
  const replies = [{ ok: false, code: 'server-error', error: 'e', text: 'T' }, { ok: false, error: 'save timed out' }];
  const g = GUARD.makeSaveGuard({ serialize: () => NOTEBOOK, write: async () => replies.shift(),
    startLocked: false, setTimer: () => 0, clearTimer: () => {} });   // no retry fires: each flush is one write
  g.touch(); await g.flush();
  assert.equal(g.state().text, 'T' + RETRYING);
  assert.equal(g.state().error, 'e', 'the raw reason stays for the tooltip');
  g.touch(); await g.flush();
  assert.equal(g.state().text, 'save timed out — ' + ENG.SAVE_TXT.retry, 'the earlier sentence is not shown for a later failure');
  g.stop();
});

// Every PANote host shows the reply through notSavedText, not words of its own: all template hosts,
// and each live host once it is off LIVE_PENDING (so a site the owner's edit misses is caught).
test('no PANote host composes its own not-saved wording over a reply', () => {
  const hostsIn = (rel) => {
    const dir = path.join(ROOT, rel);
    return !fs.existsSync(dir) ? [] : fs.readdirSync(dir).map((s) => [s, path.join(dir, s, 'index.html')])
      .filter(([, f]) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('PANote.saveOutcome'));
  };
  const templates = hostsIn('workspace.example/apps');
  assert.deepEqual(templates.map(([s]) => s).sort(), ['bible', 'notes'], 'the PANote hosts this test knows');
  const live = hostsIn('workspace/apps').filter(([s]) => !LIVE_PENDING.has(`${s} (live)`));
  for (const [slug, f] of [...templates, ...live]) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), OWN_WORDING, `${slug}: ${f}`);
});
