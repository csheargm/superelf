// App LOAD durability — the user-flow harness for V1 (a failed read destroying good data) and
// V2 (the failure message painted underneath the overlay that hides it).
//
// WHY THIS FILE EXISTS AND WHY IT LOOKS LIKE THIS
// Round 1 shipped a "verification" whose mock was laxer than production in exactly the dimension
// that caused the incident, so it went green while the real app destroyed notebooks. Standing
// rule (R14 + harness fidelity): a mock MUST enforce the real limits and return the real error
// shapes, and nothing may pass vacuously. So:
//   * the server is REAL node:http running the repo's own readBody + BODY_LIMITS.appData +
//     saveAppData + bodyErrorResponse, over a throwaway directory. No workspace file is touched.
//   * the shell's broker — api(), its failure mapping and the whole message handler — is EXTRACTED
//     from web/index.html and run (test/helpers-shell-broker.mjs), so the app sees the exact
//     {ok:false,code,error,text} objects production produces, `text` being the shell's rendered
//     sentence.
//   * the apps are the REAL app scripts, all four of them, executed as written.
//   * PANote.LOAD, PANote.saveOutcome, PANote.richer and PANote.contentSize are EXTRACTED FROM
//     web/note-ui.inline.html and handed to the apps unchanged — the rules that decide "did this
//     read succeed" and "did this write land" are the engine's own code, not a restatement.
// HONESTLY STATED (R14) — what is NOT real here: PANote's and PAChat's *user interface* (canvas,
// pointer handling, DOM) is stubbed, because none of it can be run without a browser and none of
// it is load-bearing for these claims. The stub calls the app's load/save/saveDraft hooks in the
// same order the engine does (flush → applyScope → load) and nothing more. Claim (b) is proved
// by computing the stacking order from the REAL CSS of the real files, not by rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BODY_LIMITS } from '../lib/webutil.mjs';
import { backupPathFor } from '../lib/appdata.mjs';

import { ENGINE, CHAT, SPLIT, APPS, APP_SRC, between, stripComments, scriptOf,
  ENG, engineModule, GUARD, coreModule, startHarness, settle, until, runApp } from './helpers-app.mjs';
import { PROTO_KEYS, oldTable } from './helpers-proto.mjs';
// TODO(R4): over budget. Split seam: §1 harness fidelity and the load contract, plus the §6 R5 audit
// (static and reader-level checks) | §3-§5 and §7, the user flows through runApp.

// ═══ 1. HARNESS FIDELITY — if any of these fail, nothing below means anything (R14) ══════════

test('harness fidelity: the shared blocks are byte-identical in all four apps (R3)', () => {
  for (const [a, b] of [['// ══ PA_DATA_CORE_BEGIN', 'PA_DATA_CORE_END ══'],
    ['// ══ PA_NOTICE_JS_BEGIN', 'PA_NOTICE_JS_END ══'],
    ['/* ══ PA_NOTICE_CSS_BEGIN', 'PA_NOTICE_CSS_END ══']]) {
    const got = Object.keys(APPS).map((k) => between(APP_SRC[k], a, b));
    for (const [i, k] of Object.keys(APPS).entries()) assert.ok(got[i], `${k} carries ${a}`);
    for (const [i, k] of Object.keys(APPS).entries())
      assert.equal(got[i], got[0], `${k}'s copy of ${a} has drifted from the canonical one`);
  }
});

test('harness fidelity: the server enforces the REAL app-data cap', async () => {
  const h = await startHarness();
  try {
    const big = JSON.stringify({ pad: 'x'.repeat(BODY_LIMITS.appData + 1024) });
    const r = await h.relay({ kind: 'save-data', path: 'huge.json', data: big });
    assert.equal(r.ok, false, 'an oversize write is REFUSED — the harness can fail the way prod does');
    assert.equal(r.code, 'too-large');
    assert.equal(r.limit, BODY_LIMITS.appData);
  } finally { await h.stop(); }
});

test("harness fidelity: every app's PA_LOAD IS the engine's LOAD; there is no copy to drift", () => {
  // The apps carried a fallback copy of the rule for a page without PANote. No such page exists:
  // each app reads PANote at load. The copy could never run, and it had drifted (ADR 0015,
  // amendment). Gone from each app's template and live copy; the shelf's follow at the next promote.
  for (const app of Object.keys(APPS)) {
    assert.equal(coreModule(app, { LOAD: ENG.LOAD }).PA_LOAD, ENG.LOAD, `${app} consumes PANote.LOAD itself`);
    assert.throws(() => coreModule(app), { name: 'ReferenceError', message: /PANote/ },
      `${app} on a page without note-ui fails at load; it does not guess`);
    assert.doesNotMatch(APP_SRC[app], /NOT_FOUND_CODES/, `${app} carries no copy of the not-found codes (R3)`);
  }
  // And the rule itself is the one this whole task is about.
  assert.equal(ENG.LOAD.fromBroker({ ok: false, code: 'unauthorized' }).status, 'failed');
  assert.equal(ENG.LOAD.fromBroker({ ok: false, code: 'server-error' }).status, 'failed');
  assert.equal(ENG.LOAD.fromBroker({ ok: false, error: 'not found' }).status, 'failed', 'a code-less reply is NOT an absence');
  assert.equal(ENG.LOAD.fromBroker({ ok: false, code: 'not-found' }).status, 'absent');
});

// A read whose code is named after an Object.prototype member is a FAILURE, so the path stays
// blocked and the note on the server is not written over (ADR 0015). Run through each app's reader.
const writesAfterRead = async (LOAD, app, code) => {
  const R = coreModule(app, { LOAD }).makeReader({ load: async () => ({ ok: false, code, error: 'x' }), save: async () => ({ ok: true }) });
  const read = await R.read('entry.json');
  return { status: read.status, wrote: (await R.write('entry.json', '{"pages":[]}')).ok };
};
test('in every app, a read failing with a code named after a prototype member blocks the write', async () => {
  for (const app of Object.keys(APPS)) for (const code of PROTO_KEYS) {
    assert.deepEqual(await writesAfterRead(ENG.LOAD, app, code), { status: 'failed', wrote: false }, `${app}: ${code}`);
  }
  assert.deepEqual(await writesAfterRead(ENG.LOAD, 'notes (template)', 'not-found'), { status: 'absent', wrote: true }, 'control');
});
test("mutation: with the engine's old LOAD_NOT_FOUND, codes constructor and __proto__ unlock that write", async () => {
  const OLD = engineModule(oldTable('LOAD_NOT_FOUND')).LOAD;
  for (const app of Object.keys(APPS)) {
    const unlocked = [];
    for (const code of PROTO_KEYS) if ((await writesAfterRead(OLD, app, code)).wrote) unlocked.push(code);
    assert.deepEqual(unlocked, ['constructor', '__proto__'], app);
  }
});

test('the load deadline is defensible and expiry is a FAILURE, never an absence', async () => {
  const C = coreModule('notes (template)', { LOAD: ENG.LOAD });
  // The value: the same budget a SAVE gets, because a load carries the same 8MB over the same
  // round-trip. The 1.5s deadline it replaces expired on healthy loads of large notebooks.
  assert.equal(C.LOAD_TIMEOUT_MS, ENG.SAVE_TIMEOUT_MS, 'load deadline == PANote.SAVE_TIMEOUT_MS');
  assert.ok(C.LOAD_TIMEOUT_MS >= 20000, 'at least 20s — an 8MB notebook over Tailscale is seconds, not ms');
  for (const app of Object.keys(APPS))
    assert.match(APP_SRC[app], /const DATA=makeReader\(\{load:paLoad,save:paSave\}\)/,
      `${app} wires the reader with no timeout override, so LOAD_TIMEOUT_MS applies`);
  // Behaviour, on the real core with a short deadline: a reply that never comes is `failed`
  // and the path is blocked for writing.
  const R = C.makeReader({ load: () => new Promise(() => {}), save: async () => ({ ok: true }), timeoutMs: 40 });
  const out = await R.read('entry-a.json');
  assert.equal(out.status, 'failed');
  assert.ok(/timed out|超时/.test(out.error), 'the reason travels with the outcome (R5)');
  assert.equal((await R.write('entry-a.json', '{"pages":[]}')).ok, false, 'a timed-out read blocks the write');
});

test('the deleted 1.5s null-load pattern is gone from every app', () => {
  for (const app of Object.keys(APP_SRC)) {
    const code = stripComments(scriptOf(APP_SRC[app]));
    assert.ok(!/withTimeout\s*\(/.test(code), `${app}: withTimeout(...) is gone`);
    assert.ok(!/,\s*1500\s*\)/.test(code), `${app}: no 1500ms load deadline survives`);
    assert.ok(!/function loadJSON/.test(code), `${app}: the null-returning loadJSON is gone`);
    // …and the SCAR comment that names it is still there, so the next reader knows why.
    assert.match(APP_SRC[app], /1\.5s deadline|1500/, `${app}: the scar is documented, not just deleted`);
  }
});

// ═══ 3. CLAIM (a): a 401 / 500 / network / timeout / corrupt load NEVER leads to an overwrite ══

const FAULTS = {
  '401 expired session': { status: 401, body: '{"error":"bad token"}' },
  '500 server error': { status: 500, body: '{"error":"server error"}' },
  '502 gateway (restarted server)': { status: 502, body: 'bad gateway' },
};

const NOTEBOOK = { v: 3, id: 'nb', pages: Array.from({ length: 40 }, (_, i) => ({ id: 'p' + i, strokes: [{ p: [[1, 2]] }, { p: [[3, 4]] }], pageHtml: '<div>real work</div>', images: [] })) };
const INDEX = { v: 1, entries: Array.from({ length: 50 }, (_, i) => ({ id: 'e' + i, title: 'Note ' + i, created: 1, updated: 2, preview: 'p' })) };

for (const [name, fault] of Object.entries(FAULTS)) {
  test(`notes: a ${name} on the INDEX never overwrites journal.json`, async () => {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', INDEX);
      const before = fs.readFileSync(h.file('journal.json'));
      h.state.fault = { ...fault, only: 'journal.json', on: 'get' };   // writes still work: only the app's own refusal can save this file
      const app = runApp('notes (template)', h.relay, ['DATA', 'S', 'boot', 'IDX_PATH'], { clampTimers: true });
      await until(() => app.DATA.blockedReason(app.IDX_PATH) !== '', 'the index path to be blocked for writing');
      assert.deepEqual(fs.readFileSync(h.file('journal.json')), before, 'journal.json is byte-identical');
      assert.equal((await app.DATA.write('journal.json', '{"v":1,"entries":[]}')).ok, false, 'and the write is refused');
      assert.deepEqual(fs.readFileSync(h.file('journal.json')), before, 'still byte-identical after an attempted write');
      assert.ok(app.noticeOn() && /无法/.test(app.noticeText()), 'a bilingual failure notice is up: ' + app.noticeText());
    } finally { await h.stop(); }
  });

  test(`notes: a ${name} on an ENTRY never overwrites that notebook`, async () => {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', INDEX);
      h.put('entry-e0.json', NOTEBOOK);
      const before = fs.readFileSync(h.file('entry-e0.json'));
      h.state.fault = { ...fault, only: 'entry-e0.json', on: 'get' };
      const app = runApp('notes (template)', h.relay, ['DATA', 'S', 'openEntry', 'entryPath', 'boot'], { clampTimers: true });
      await until(() => app.S.entries.length === INDEX.entries.length, 'boot to load the index');
      await app.openEntry('e0');
      await until(() => app.DATA.blockedReason(app.entryPath('e0')) !== '', 'the entry to be blocked');
      assert.notEqual(app.DATA.blockedReason(app.entryPath('e0')), '', 'the entry is blocked for writing');
      // The pad's own save hook — the exact closure PANote calls — must refuse.
      const pad = app.captured.pads[0];
      const blank = { v: 3, pages: [{ id: 'x', strokes: [], pageHtml: '', images: [] }] };
      assert.equal((await pad.opts.save(blank)).ok, false, 'save() refuses for an unread entry');
      await settle(6);
      assert.deepEqual(fs.readFileSync(h.file('entry-e0.json')), before, 'the 40-page notebook is byte-identical');
      // …and NOTHING was created beside it either. A note has exactly one path; a blocked read must
      // not produce a second file (a directory, an index, a draft) anywhere in the note store.
      assert.deepEqual(fs.readdirSync(path.join(h.dir, 'data', 'notes')).sort(), ['entry-e0.json', 'journal.json'],
        'no second file of any kind was created for the note');
    } finally { await h.stop(); }
  });

  test(`bible: a ${name} on a chapter never wipes it (template + live)`, async () => {
    for (const app of ['bible (template)', 'bible (live)']) {
      const slug = 'bible';
      const h = await startHarness(slug);
      try {
        // ONE path for both copies. The template used to write bible-notes/ and the live app notes/;
      // the template has since been synced from live, and the prefix was redundant anyway — the
      // broker already namespaces every app's data under data/<slug>/, so "bible-notes" inside
      // the Bible app meant data/bible/bible-notes.
      const rel = 'notes/43-3.json';
        const chapter = { notes: { v16: 'a real note '.repeat(200) }, draws: { v16: { pages: [{ strokes: [{ p: [[1, 1]] }] }] } }, chat: { v16: 'convo-1' } };
        h.put(rel, chapter);
        const before = fs.readFileSync(h.file(rel));
        h.state.fault = { ...fault, only: '43-3.json', on: 'get' };
        const A = runApp(app, h.relay, ['DATA', 'loadAnn', 'saveAnn', 'annPath',
          'get ANN(){return ANN}', 'get ANN_BLOCKED(){return ANN_BLOCKED}', 'setCh:(b,c)=>{bookIdx=b;chapter=c;}'], { clampTimers: true });
        A.setCh(42, 3);
        await A.loadAnn();
        assert.notEqual(A.ANN_BLOCKED, '', `${app}: the chapter is blocked for writing`);
        const r = await A.saveAnn();
        assert.equal(r.ok, false, `${app}: saveAnn refuses`);
        await settle(4);
        assert.deepEqual(fs.readFileSync(h.file(rel)), before, `${app}: the chapter file is byte-identical`);
        assert.ok(A.noticeOn(), `${app}: the failure notice is up`);
      } finally { await h.stop(); }
    }
  });
}

test('notes: a load that never answers (timeout) never overwrites', async () => {
  const h = await startHarness('notes');
  try {
    h.put('journal.json', INDEX);
    const before = fs.readFileSync(h.file('journal.json'));
    // A relay that never replies — an iPad Wi-Fi→cellular handoff, a sleeping Tailscale tunnel.
    const dead = async (m) => (m.kind === 'data' ? new Promise(() => {}) : h.relay(m));
    const app = runApp('notes (template)', h.relay, ['DATA', 'boot', 'IDX_PATH'], { clampTimers: true });
    await settle(20);
    const R = app.DATA;                                   // the app's own reader, with its own wiring
    // Drive the same reader against the dead channel through the core's public API.
    const C = coreModule('notes (template)', { LOAD: ENG.LOAD });
    const R2 = C.makeReader({ load: dead, save: (p, d) => h.relay({ kind: 'save-data', path: p, data: d }).then((x) => (x && x.ok ? { ok: true } : { ok: false, error: 'x' })), timeoutMs: 40 });
    const out = await R2.read('journal.json');
    assert.equal(out.status, 'failed', 'a hung read is a failure, not an absence');
    assert.equal((await R2.write('journal.json', '{"v":1,"entries":[]}')).ok, false, 'and it blocks the write');
    assert.deepEqual(fs.readFileSync(h.file('journal.json')), before, 'journal.json is byte-identical');
    assert.ok(R);
  } finally { await h.stop(); }
});

test('notes: a CORRUPT index is never overwritten (unparsable is not empty)', async () => {
  const h = await startHarness('notes');
  try {
    h.put('journal.json', '{"v":1,"entries":[{"id":"e0"'); // truncated mid-write
    const before = fs.readFileSync(h.file('journal.json'));
    const app = runApp('notes (template)', h.relay, ['DATA', 'boot', 'IDX_PATH'], { clampTimers: true });
    await until(() => app.DATA.blockedReason(app.IDX_PATH) !== '', 'writes to be blocked');
    assert.notEqual(app.DATA.blockedReason(app.IDX_PATH), '', 'writes blocked');
    assert.deepEqual(fs.readFileSync(h.file('journal.json')), before, 'the truncated file is untouched');
    assert.ok(app.noticeOn(), 'and the user is told');
  } finally { await h.stop(); }
});

test('notes: a 404 whose .bak EXISTS is a fault, not a new note', async () => {
  // The file vanished but a previous generation is on the server. Treating that as "new" would
  // start blank and overwrite the recoverable bytes on the next autosave.
  const h = await startHarness('notes');
  try {
    h.put('journal.json', INDEX);
    fs.writeFileSync(backupPathFor(h.file('entry-e0.json')), JSON.stringify(NOTEBOOK));
    const C = coreModule('notes (template)', { LOAD: ENG.LOAD });
    const R = C.makeReader({ load: (p) => h.relay({ kind: 'data', path: p }), save: async () => ({ ok: false }) });
    const out = await R.read('entry-e0.json');
    assert.equal(out.status, 'failed', 'a missing file with a surviving backup is NOT absent');
    assert.equal((await R.write('entry-e0.json', '{"pages":[]}')).ok, false, 'and it is not writable');
  } finally { await h.stop(); }
});

// R14: the refusals above would be vacuous if the app never wrote at all. These are the controls.
test('CONTROL: a healthy first run DOES create the index and DOES save a note', async () => {
  const h = await startHarness('notes');
  try {
    const app = runApp('notes (template)', h.relay, ['DATA', 'S', 'boot', 'IDX_PATH', 'entryPath'], { clampTimers: true });
    await until(() => fs.existsSync(h.file('journal.json')), 'the index to be created on a first run');
    assert.ok(fs.existsSync(h.file('journal.json')), 'a proven-absent index IS created on a first run');
    assert.equal(app.DATA.blockedReason(app.IDX_PATH), '', 'nothing is blocked on a healthy channel');
    const pad = app.captured.pads[0];
    const nb = { v: 3, pages: [{ id: 'p0', strokes: [{ p: [[1, 1]] }], pageHtml: '<div>hi</div>', images: [] }] };
    const w = await pad.opts.save(nb);
    assert.equal(w.ok, true, 'the first save LANDS — the guard is not simply refusing everything');
    // A note is ONE file. Not a directory, not an index + pages: entry-<id>.json holding the
    // whole notebook, which is the shape every note already on disk is in.
    await until(() => fs.readdirSync(path.join(h.dir, 'data', 'notes')).some((f) => /^entry-.*\.json$/.test(f)), 'the note file to reach disk');
    const files = fs.readdirSync(path.join(h.dir, 'data', 'notes'));
    assert.ok(!files.some((f) => fs.statSync(path.join(h.dir, 'data', 'notes', f)).isDirectory()), 'no directory was created: ' + files.join(','));
    const one = files.filter((f) => /^entry-.*\.json$/.test(f));
    assert.equal(one.length, 1, 'exactly ONE file for the note: ' + files.join(','));
    const back = JSON.parse(fs.readFileSync(path.join(h.dir, 'data', 'notes', one[0]), 'utf8'));
    assert.equal(back.pages.length, 1, 'the file holds the whole notebook');
    assert.equal(back.pages[0].strokes.length, 1, 'and the stroke is in it');
  } finally { await h.stop(); }
});

test('CONTROL: a healthy Bible chapter with no annotations yet accepts its first write', async () => {
  const h = await startHarness('bible');
  try {
    const A = runApp('bible (template)', h.relay, ['DATA', 'loadAnn', 'saveAnn', 'annPath',
      'get ANN(){return ANN}', 'get ANN_BLOCKED(){return ANN_BLOCKED}', 'setCh:(b,c)=>{bookIdx=b;chapter=c;}'], { clampTimers: true });
    A.setCh(42, 3);
    await A.loadAnn();
    assert.equal(A.ANN_BLOCKED, '', 'a proven-absent chapter is writable');
    A.ANN.notes.v16 = 'first note';
    assert.equal((await A.saveAnn()).ok, true, 'and the first annotation lands');
    assert.ok(fs.existsSync(h.file('notes/43-3.json')));
  } finally { await h.stop(); }
});

// ═══ 4. CLAIM (c): delete / rename still work, and still refuse on an unreadable file ═════════

test('notes: delete still works — the journal index first, then the tombstone', async () => {
  const h = await startHarness('notes');
  try {
    h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'a', updated: 1 }, { id: 'e1', title: 'b', updated: 2 }] });
    h.put('entry-e0.json', NOTEBOOK);                       // a LEGACY note: the tombstone goes on its one file
    const app = runApp('notes (template)', h.relay, ['DATA', 'S', 'deleteById', 'openEntry', 'boot'], { clampTimers: true });
    await until(() => app.S.entries.length === 2, 'boot to load both entries');
    await app.openEntry('e0');                              // the layout is decided by the READ, so open it first
    await app.deleteById('e0');
    await until(() => JSON.parse(fs.readFileSync(h.file('journal.json'), 'utf8')).entries.length === 1, 'the index write to land');
    assert.deepEqual(JSON.parse(fs.readFileSync(h.file('journal.json'), 'utf8')).entries.map((e) => e.id), ['e1'], 'dereferenced from the index');
    assert.equal(JSON.parse(fs.readFileSync(h.file('entry-e0.json'), 'utf8')).deleted, true, 'tombstoned');
    app.stopPads();
  } finally { await h.stop(); }
});

test('notes: a delete whose index write fails destroys nothing and says so', async () => {
  const h = await startHarness('notes');
  try {
    h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'a', updated: 1 }] });
    h.put('entry-e0.json', NOTEBOOK);
    const app = runApp('notes (template)', h.relay, ['DATA', 'S', 'deleteById', 'boot'], { clampTimers: true });
    await until(() => app.S.entries.length === 1, 'boot to load the entry');
    const beforeIdx = fs.readFileSync(h.file('journal.json'));
    const beforeNb = fs.readFileSync(h.file('entry-e0.json'));
    h.state.fault = { status: 500, body: 'boom', only: 'journal.json' };
    await app.deleteById('e0');
    await settle(10);
    assert.deepEqual(fs.readFileSync(h.file('journal.json')), beforeIdx, 'the index is untouched');
    assert.deepEqual(fs.readFileSync(h.file('entry-e0.json')), beforeNb, 'the handwriting is untouched — the order still holds');
    assert.equal(app.S.entries.length, 1, 'the entry is restored in memory');
    assert.ok(app.noticeOn() && /删除失败/.test(app.noticeText()), 'bilingual failure notice: ' + app.noticeText());
  } finally { await h.stop(); }
});

test('bible (live): rename and delete of a listed note still work, and refuse when unreadable', async () => {
  const h = await startHarness('bible');
  try {
    const rel = 'notes/43-3.json';
    h.put(rel, { notes: { v16: 'keep me' }, draws: {}, chat: {}, titles: {} });
    const A = runApp('bible (live)', h.relay, ['DATA', 'renameChapterNote', 'deleteChapterNote', 'chapterFile', 'loadAnn',
      'setCh:(b,c)=>{bookIdx=b;chapter=c;}'], { clampTimers: true });
    A.setCh(42, 3);
    const row = { bookIdx: 42, chapter: 3, verseKey: 'v16', title: 'old' };
    assert.equal((await A.renameChapterNote(row, 'new title')).ok, true, 'rename lands');
    assert.equal(JSON.parse(fs.readFileSync(h.file(rel), 'utf8')).titles.v16, 'new title');
    assert.equal((await A.deleteChapterNote(row)).ok, true, 'delete lands');
    assert.equal(JSON.parse(fs.readFileSync(h.file(rel), 'utf8')).notes.v16, undefined, 'the note is gone');
    // …and the same two paths REFUSE when the chapter cannot be read.
    h.put(rel, { notes: { v17: 'still here' }, draws: {}, chat: {} });
    const before = fs.readFileSync(h.file(rel));
    h.state.fault = { status: 401, body: '{"error":"bad token"}', only: '43-3.json', on: 'get' };
    assert.equal((await A.renameChapterNote({ ...row, verseKey: 'v17' }, 'x')).ok, false, 'rename refuses');
    assert.equal((await A.deleteChapterNote({ ...row, verseKey: 'v17' })).ok, false, 'delete refuses');
    await settle(4);
    assert.deepEqual(fs.readFileSync(h.file(rel)), before, 'and nothing on disk changed');
  } finally { await h.stop(); }
});

// ── `titles` SURVIVES THE NEXT ANNOTATION SAVE ────────────────────────────────────────────────
// The bug these three prove gone: loadAnn() built ANN as {notes,draws,chat} and never read
// o.titles, while saveAnn() writes JSON.stringify(ANN) over the WHOLE chapter file. So the titles
// map renameChapterNote() had just written was deleted by the next stroke, text note or chat
// pointer — the rename appeared to work in the ☰ list and silently reverted. Both apps carry the
// same read-then-whole-file-write shape, so both are proved.
// R11 — searched "titles" across workspace*/, web.mjs, test/: the only definitions are
// web.mjs's /api/notes reader and renameChapterNote/deleteChapterNote; no new constant here.
for (const app of ['bible (live)', 'bible (template)']) {
  test(`${app}: an annotation save PRESERVES the titles map it did not write`, async () => {
    const h = await startHarness('bible');
    try {
      // ONE path for both copies. The template used to write bible-notes/ and the live app notes/;
      // the template has since been synced from live, and the prefix was redundant anyway — the
      // broker already namespaces every app's data under data/<slug>/, so "bible-notes" inside
      // the Bible app meant data/bible/bible-notes.
      const rel = 'notes/43-3.json';
      h.put(rel, { notes: { v16: 'a text note' }, draws: {}, chat: { v16: 'convo-1' },
        titles: { v16: 'My renamed note', general: 'Chapter thoughts' }, pins: { v16: true } });
      const A = runApp(app, h.relay, ['DATA', 'loadAnn', 'saveAnn', 'get ANN(){return ANN}',
        'setCh:(b,c)=>{bookIdx=b;chapter=c;}'], { clampTimers: true });
      A.setCh(42, 3);
      await A.loadAnn();
      A.ANN.notes.v16 = 'the note, edited';                 // the user types — one ordinary save
      assert.equal((await A.saveAnn()).ok, true, 'the annotation save lands');
      const chapter = JSON.parse(fs.readFileSync(h.file(rel), 'utf8'));
      assert.deepEqual(chapter.titles, { v16: 'My renamed note', general: 'Chapter thoughts' },
        'the titles map is still there, unchanged');
      assert.equal(chapter.notes.v16, 'the note, edited', 'and the edit itself landed');
      assert.deepEqual(chapter.chat, { v16: 'convo-1' }, 'chat pointer untouched, as before');
      assert.deepEqual(chapter.pins, { v16: true }, 'the bookmark map (plan D) rides with titles: same file, same shape, same hazard');
    } finally { await h.stop(); }
  });

  test(`${app}: MUTATION — drop the titles read and the save destroys them (R14 control)`, async () => {
    // Without this, the two tests above could pass for a reason unrelated to the fix.
    const h = await startHarness('bible');
    try {
      // ONE path for both copies. The template used to write bible-notes/ and the live app notes/;
      // the template has since been synced from live, and the prefix was redundant anyway — the
      // broker already namespaces every app's data under data/<slug>/, so "bible-notes" inside
      // the Bible app meant data/bible/bible-notes.
      const rel = 'notes/43-3.json';
      h.put(rel, { notes: {}, draws: {}, chat: {}, titles: { v16: 'My renamed note' } });
      const A = runApp(app, h.relay, ['DATA', 'loadAnn', 'saveAnn', 'get ANN(){return ANN}',
        'setCh:(b,c)=>{bookIdx=b;chapter=c;}'],
      { clampTimers: true, mutate: (src) => src                                // …back to the exact pre-fix loadAnn()
        .replace('{notes:{},draws:{},chat:{},titles:{},pins:{}}', '{notes:{},draws:{},chat:{},pins:{}}')
        .replace('ANN.titles=migrateKeys(o.titles||{});', '') });
      A.setCh(42, 3);
      await A.loadAnn();
      A.ANN.notes.v16 = 'the note, edited';
      assert.equal((await A.saveAnn()).ok, true);
      assert.equal(JSON.parse(fs.readFileSync(h.file(rel), 'utf8')).titles, undefined,
        'the defect really does destroy titles — the assertions above are not vacuous');
    } finally { await h.stop(); }
  });
}

test('bible (live): a rename survives the next stroke — the WHOLE user flow', async () => {
  // The flow the user reported: rename a note in the ☰ list, keep working in the SAME chapter,
  // find the old name back. Two causes, both proved fixed here — the titles map has to be read
  // back by loadAnn(), AND the in-memory ANN (loaded before the rename) has to learn the new
  // title, or the next saveAnn serializes the stale one straight over it.
  const h = await startHarness('bible');
  try {
    const rel = 'notes/43-3.json';
    h.put(rel, { notes: { v16: 'keep me' }, draws: {}, chat: {} });
    const A = runApp('bible (live)', h.relay, ['DATA', 'loadAnn', 'saveAnn', 'renameChapterNote',
      'get ANN(){return ANN}', 'setCh:(b,c)=>{bookIdx=b;chapter=c;}'], { clampTimers: true });
    A.setCh(42, 3);
    await A.loadAnn();                                      // the chapter is OPEN, ANN is in memory
    const row = { bookIdx: 42, chapter: 3, verseKey: 'v16', title: 'John 3:16' };
    assert.equal((await A.renameChapterNote(row, 'The verse I keep coming back to')).ok, true, 'rename lands');
    A.ANN.notes.v16 = 'keep me, plus a line';               // …and the user carries on in the same chapter
    assert.equal((await A.saveAnn()).ok, true, 'the next annotation save lands');
    assert.equal(JSON.parse(fs.readFileSync(h.file(rel), 'utf8')).titles.v16,
      'The verse I keep coming back to', 'the rename is still on disk after the save');
    // And it is still there after a reload — what the ☰ list actually reads back.
    await A.loadAnn();
    assert.equal(A.ANN.titles.v16, 'The verse I keep coming back to', 'and the reloaded chapter carries it');
  } finally { await h.stop(); }
});

test('bible (live): MUTATION — leave ANN stale after a rename and the next save reverts it', async () => {
  const h = await startHarness('bible');
  try {
    const rel = 'notes/43-3.json';
    h.put(rel, { notes: { v16: 'keep me' }, draws: {}, chat: {} });
    const A = runApp('bible (live)', h.relay, ['DATA', 'loadAnn', 'saveAnn', 'renameChapterNote',
      'get ANN(){return ANN}', 'setCh:(b,c)=>{bookIdx=b;chapter=c;}'],
    { clampTimers: true, mutate: (src) => src.replace(
      'if(r.ok&&n.bookIdx===bookIdx&&n.chapter===chapter){ ANN.titles=ANN.titles||{}; ANN.titles[n.verseKey||\'general\']=newTitle; }', '') });
    A.setCh(42, 3);
    await A.loadAnn();
    assert.equal((await A.renameChapterNote({ bookIdx: 42, chapter: 3, verseKey: 'v16' }, 'new name')).ok, true);
    A.ANN.notes.v16 = 'keep me, plus a line';
    assert.equal((await A.saveAnn()).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(h.file(rel), 'utf8')).titles.v16, undefined,
      'the stale-ANN defect really does revert the rename — the flow test above is not vacuous');
  } finally { await h.stop(); }
});

test('bible (live): a LISTED chapter that 404s is a fault, not an empty file to recreate', async () => {
  // The row came from the server's own /api/notes listing a moment ago, so "no such file" means
  // it vanished between the listing and the read. Starting from {} and writing would replace a
  // recoverable file with just the rename. mustExist is what makes that a refusal.
  const h = await startHarness('bible');
  try {
    const A = runApp('bible (live)', h.relay, ['DATA', 'renameChapterNote', 'deleteChapterNote', 'chapterFile',
      'setCh:(b,c)=>{bookIdx=b;chapter=c;}'], { clampTimers: true });
    A.setCh(42, 3);
    const row = { bookIdx: 42, chapter: 3, verseKey: 'v16', title: 'old' };
    assert.equal((await A.renameChapterNote(row, 'x')).ok, false, 'rename of a vanished listed file refuses');
    assert.ok(!fs.existsSync(h.file('notes/43-3.json')), 'and nothing was recreated in its place');
    assert.ok(A.noticeOn(), 'the refusal is on the visible notice');
    // mustExist does more than word the message: it turns the outcome into `failed`, which BLOCKS
    // the path. Without it the read would be a plain `absent` and the very next annotation save
    // would happily create a fresh file where a recoverable one used to be.
    assert.notEqual(A.DATA.blockedReason(A.chapterFile(42, 3)), '', 'the vanished file is blocked for writing');
    assert.equal((await A.DATA.write(A.chapterFile(42, 3), '{"notes":{}}')).ok, false, 'and a write to it is refused');
    assert.ok(!fs.existsSync(h.file('notes/43-3.json')), 'still nothing on disk');
  } finally { await h.stop(); }
});

test('a failed draft read BLOCKS THE DRAFT PATH — the `soft` hatch is gone (V6)', async () => {
  // THIS TEST ASSERTED THE OPPOSITE IN ROUND 2 ("its failure offers nothing and blocks nothing"),
  // and the refutation measured what that cost: with the draft path left writable, the app cleared
  // it on the strength of a MAIN-file save — 184 unconfirmed strokes, the only copy, to zero.
  // Blocking is PER PATH, so blocking the draft never blocked the entry: the hatch protected
  // nothing and destroyed work. What the draft's "softness" legitimately means — its failure does
  // not stop the ENTRY from being saved — is asserted here too, and holds without a hatch.
  const h = await startHarness('notes');
  try {
    const C = coreModule('notes (template)', { LOAD: ENG.LOAD });
    const R = C.makeReader({
      load: (p) => (p.includes('.draft.') ? Promise.resolve({ ok: false, code: 'server-error', status: 500, error: 'boom' }) : h.relay({ kind: 'data', path: p })),
      save: (p, d) => h.relay({ kind: 'save-data', path: p, data: d }).then((x) => (x && x.ok ? { ok: true } : { ok: false, error: 'x' })),
    });
    const d = await R.read('entry-a.draft.json');
    assert.equal(d.status, 'failed', 'the failure is reported as a failure');
    assert.notEqual(R.blockedReason('entry-a.draft.json'), '', 'and it BLOCKS ITS OWN PATH');
    assert.equal((await R.write('entry-a.draft.json', '{"v":1,"pages":[]}')).ok, false, 'so the draft cannot be replaced');
    assert.equal(R.blockedReason('entry-a.json'), '', 'the ENTRY is untouched by the draft failure');
    assert.equal((await R.write('entry-a.json', '{"v":3,"pages":[{"id":"p0","strokes":[]}]}')).ok, true, 'and still writable');
    // The second half of the same rule: a path this session never read may not be REPLACED either.
    assert.equal((await R.write('entry-z.draft.json', '{"v":1,"pages":[]}', { replaces: true })).ok, false,
      'a replace-only write to a never-read path is refused');
    assert.equal((await R.write('entry-z.draft.json', '{"v":1,"pages":[]}')).ok, true,
      '…while an ordinary write to that path is not blocked (the refusal is about REPLACING)');
    // …and the option itself is gone from the code, not merely unused.
    const coreSrc = stripComments(between(APP_SRC['notes (template)'], '// ══ PA_DATA_CORE_BEGIN', 'PA_DATA_CORE_END ══'));
    assert.ok(!/\bo\.soft\b|\bsoft\s*:/.test(coreSrc), 'the data core carries no `soft` option any more');
    for (const app of Object.keys(APPS))
      assert.ok(!/\bsoft\s*:\s*true/.test(stripComments(scriptOf(APP_SRC[app]))), `${app}: no caller asks for a soft read`);
  } finally { await h.stop(); }
});

// ═══ 5. CLAIM (b): the failure notice is VISIBLE above every overlay ══════════════════════════

// Painted order for elements that share the root stacking context (all of these are children of
// <body> with no transformed/filtered ancestor): a POSITIONED element with a z-index paints above
// one with a lower z-index; a STATIC element cannot take part in z-index ordering at all and is
// painted in the background/border layer beneath every positioned box. That second rule is the
// whole V2 defect, so the harness checks positioning first and the number second.
function cssRules(src) {
  const style = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const body = style.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map();
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = m[2];
    for (const sel of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const prev = out.get(sel) || '';
      out.set(sel, prev + ';' + decls);
    }
  }
  return out;
}
function boxOf(rules, sel, vars) {
  const d = rules.get(sel) || '';
  const pos = (/(?:^|;)\s*position\s*:\s*([a-z-]+)/.exec(d) || [])[1] || 'static';
  let z = (/(?:^|;)\s*z-index\s*:\s*([^;]+)/.exec(d) || [])[1];
  if (z) {
    z = z.trim();
    const v = /var\(\s*(--[\w-]+)/.exec(z);
    if (v) z = vars[v[1]];
    z = Number(z);
  }
  return { sel, position: pos, z: Number.isFinite(z) ? z : null, decls: d };
}
function varsOf(src) {
  const out = {};
  for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) out[m[1]] = m[2].trim();
  return out;
}
// Painted order: static boxes lose to every positioned box; among positioned boxes the higher
// z-index wins; equal z-index falls back to DOM order (later wins).
function paintsAbove(a, b, domOrder) {
  const posA = a.position !== 'static', posB = b.position !== 'static';
  if (posA !== posB) return posA;
  if (!posA) return domOrder(a.sel) > domOrder(b.sel);
  const za = a.z == null ? 0 : a.z, zb = b.z == null ? 0 : b.z;
  if (za !== zb) return za > zb;
  return domOrder(a.sel) > domOrder(b.sel);
}

test('bible: the save-failure notice paints ABOVE the chat overlay, the draw pad and every other layer', () => {
  const engineRules = cssRules(ENGINE), chatRules = cssRules(CHAT), splitRules = cssRules(SPLIT);
  for (const app of ['bible (template)', 'bible (live)', 'notes (template)', 'notes (live)']) {
    const src = APP_SRC[app];
    const rules = cssRules(src);
    const vars = varsOf(src.slice(0, src.indexOf('</style>')));
    const notice = boxOf(rules, '.pa-notice', vars);
    assert.notEqual(notice.position, 'static',
      `${app}: the notice MUST be positioned — a static element cannot use z-index at all (this IS the V2 defect)`);
    assert.equal(notice.position, 'fixed', `${app}: the notice is position:fixed`);
    assert.ok(Number.isFinite(notice.z), `${app}: the notice resolves a numeric z-index (got ${notice.z})`);

    // Every overlay that can be on screen over this app, from the REAL component files.
    const overlays = [
      boxOf(chatRules, '.pac-fs', {}),            // PAChat fullscreen — opaque, the V2 culprit
      boxOf(chatRules, '.pac-drawerhost', {}),    // the ☰ drawer host
      boxOf(chatRules, '.pac-lb', {}),            // the image lightbox
      boxOf(engineRules, '.pan-fs', {}),          // PANote fullscreen
      boxOf(engineRules, '.pan-lock', {}),        // the locked-note curtain
      boxOf(splitRules, '.paw-win', {}),           // PAWin's panel windows
      ...['#panel', '#search-overlay', '#back-chat', '#fab'].map((s) => boxOf(rules, s, vars)).filter((b) => b.decls),
    ];
    // Each overlay must RESOLVE, or paintsAbove compares against a phantom. A misspelled
    // selector, a var()-valued z-index, or CSS injected at runtime as a string all read as
    // "static, z=null" — which this check waves through, so the notice would "paint above"
    // something that was never actually measured. That is the vacuous-pass shape (R14).
    for (const o of overlays) {
      assert.ok(o.decls, `${app}: overlay ${o.sel} resolved NO declarations — the ladder cannot see it`);
      assert.notEqual(o.position, 'static', `${app}: overlay ${o.sel} must be positioned to take part in the ladder`);
      // A DECLARED z-index must RESOLVE. No declaration at all is fine — that is `auto`, and
      // #fab legitimately has none. What must never pass is a z-index that is written but
      // unresolvable (a var() this parser cannot see, a typo): boxOf reports that as null,
      // identical to "not declared", and the ladder would then rank it as if it were 0.
      if (/(?:^|;)\s*z-index\s*:/.test(o.decls)) {
        assert.ok(Number.isFinite(o.z), `${app}: overlay ${o.sel} declares a z-index that does not resolve (got ${o.z}) — the ladder would silently treat it as 0`);
      }
    }
    const domOrder = () => 0;
    for (const o of overlays) {
      assert.ok(paintsAbove(notice, o, domOrder),
        `${app}: the notice (${notice.position} z=${notice.z}) must paint above ${o.sel} (${o.position} z=${o.z})`);
    }
    // The regression this replaces: prove the OLD arrangement would have failed this same check.
    const oldBanner = { sel: '#daily-banner.err(old)', position: 'static', z: null };
    assert.equal(paintsAbove(oldBanner, boxOf(chatRules, '.pac-fs', {}), domOrder), false,
      'sanity: the old static banner did NOT paint above .pac-fs — the check can fail');
  }
});

test('bible: the notice element exists, starts empty, and is not the daily-reading banner', () => {
  for (const app of ['bible (template)', 'bible (live)']) {
    const src = APP_SRC[app];
    assert.match(src, /<div id="pa-notice" class="pa-notice"><\/div>/, `${app}: the notice element is in the markup and starts empty`);
    assert.ok(!/#daily-banner\.err/.test(src), `${app}: the failure state no longer shares the daily-reading banner`);
    // V6: annNotice carries the KEY through — a message is about a PATH, and only that path's own
    // success may retire it. (Round 2's signature was `(msg,kind)`, which is how an unrelated
    // success could erase a report about a file that never landed.)
    assert.match(src, /function annNotice\(msg,kind,key\)\{ paNotice\(msg,kind,key\); \}/, `${app}: annNotice routes to the shared surface, key and all`);
  }
});

test('bible: the chat-pointer write reports its own outcome (PAChat drops the promise)', async () => {
  // web/chat-ui.inline.html setCid() calls setConvoId un-awaited, so the app closure is the only
  // consumer there will ever be. It must surface AND persist by itself.
  // The PROPERTY, not the formatting: setConvoId is invoked WITHOUT await/then, so the app's
  // closure is the only consumer there will ever be. Pinning the exact shape broke when a
  // non-key guard was added above it — same un-awaited call, a false regression.
  assert.match(CHAT, /opts\.setConvoId\(k,id\);\s*return;/,
    'the caller still drops the promise — this test exists because of that');
  assert.ok(!/await\s+opts\.setConvoId|opts\.setConvoId\([^)]*\)\s*\.then/.test(CHAT),
    'and it is genuinely un-awaited, not merely written on one line');
  const h = await startHarness('bible');
  try {
    const rel = 'notes/43-3.json';
    h.put(rel, { notes: { v16: 'keep' }, draws: {}, chat: {} });
    const A = runApp('bible (live)', h.relay, ['DATA', 'loadAnn', 'setCh:(b,c)=>{bookIdx=b;chapter=c;}'], { clampTimers: true });
    A.setCh(42, 3);
    await A.loadAnn();
    const chat = A.captured.chats[0];
    // Here the WRITE is what fails — this test is about a rejected write being reported by a
    // closure whose promise the caller throws away, not about a rejected read.
    h.state.fault = { status: 401, body: '{"error":"bad token"}', only: '43-3.json', on: 'put' };
    const r = await chat.opts.setConvoId('v16', 'convo-9');
    assert.equal(r.ok, false, 'setConvoId returns the outcome instead of discarding it');
    assert.ok(A.noticeOn(), 'and the failure is on the visible, above-the-overlay notice');
    assert.match(A.noticeText(), /未保存|无法/, 'bilingual: ' + A.noticeText());
  } finally { await h.stop(); }
});

// ═══ 6. R5 audit — no ignored save/load result is left in these four files ════════════════════

test('R5: no bare catch and no discarded save/load result in the four app files', () => {
  for (const [app, src] of Object.entries(APP_SRC)) {
    const code = stripComments(scriptOf(APP_SRC[app]));
    assert.ok(!/catch\s*\{\s*\}/.test(code), `${app}: no \`catch{}\``);
    assert.ok(!/catch\s*\(\s*\w*\s*\)\s*\{\s*\}/.test(code), `${app}: no \`catch(_){}\` without a comment`);
    // R5 in full: EVERY catch must rethrow with context, surface a user-visible error, or carry a
    // comment saying why silence is correct. A catch that does none of those is the shape that
    // hid the original incident, so it fails the build rather than being found by a reviewer.
    for (const m of code.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
      let depth = 0, i = m.index + m[0].length - 1;
      for (; i < code.length; i++) { if (code[i] === '{') depth++; else if (code[i] === '}' && --depth === 0) break; }
      // Include the rest of the closing line: a one-line catch is commonly justified by a
      // trailing `// why silence is correct`, which sits just outside the braces.
      const eol = code.indexOf('\n', i); const body = code.slice(m.index, eol < 0 ? code.length : eol);
      const justified = /\/\*|\/\//.test(body)                             // (c) a comment
        || /\bthrow\b/.test(body)                                          // (a) rethrow
        || /(paNotice|annNotice|padFlash|\.flash\()/.test(body)            // (b) user-visible
        || /(ok:false|LOAD\.failed|PA_LOAD\.failed|failed\()/.test(body);  // (a) an outcome the caller must check
      assert.ok(justified, `${app}: a catch swallows silently (R5): ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    // Every await of a write is either assigned, returned, or explicitly commented.
    for (const m of code.matchAll(/^[^\n\S]*await (DATA\.write|paSave)\(/gm)) {
      const line = code.slice(code.lastIndexOf('\n', m.index) + 1, code.indexOf('\n', m.index));
      assert.ok(/^\s*(const|let|return|await)\s/.test(line) || /\/\//.test(line),
        `${app}: a write result is dropped: ${line.trim()}`);
    }
    // Raw paSave/paLoad must not be used where the guarded reader exists.
    const guarded = code.split('const DATA=makeReader')[1] || '';
    assert.ok(!/\bawait paSave\(/.test(guarded), `${app}: writes go through DATA.write, never raw paSave`);
    assert.ok(!/\bawait paLoad\(/.test(guarded), `${app}: reads go through DATA.read, never raw paLoad`);
    assert.ok(src.includes('id="pa-notice"'), `${app}: carries the visible failure surface`);
  }
});

// ═══ 7. ROUND 3 (V6) — evidence of unsaved work is never cleared on a "success" that does not
//        cover it. The three refuted claims, re-measured on the real code. ══════════════════════
//
// One bug, three symptoms, all of them the same shape: something that meant "we do not know"
// (a draft read that failed, a path never read, a report about another file) was treated as
// "there is nothing there". Each test below reproduces the refutation's own scenario against the
// real server + real relay + real app + the ENGINE'S REAL SAVE GUARD, and the MUTATION test at
// the end re-introduces each guard's absence to prove these assertions can fail.

// ROUND 5 removed the per-page store as well, so a note is once again ONE file holding the whole
// notebook. `strokesIn` counts the strokes in whatever file it is pointed at, which is what every
// assertion here is about.
const MAIN_1 = { v: 3, id: 'nb', pages: [{ id: 'p0', strokes: [{ p: [[0, 0]] }], pageHtml: '<div>legacy</div>', images: [] }] };
const strokesIn = (file) => {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(j.pages) ? j.pages.reduce((a, pg) => a + ((pg.strokes && pg.strokes.length) || 0), 0)
    : ((j.strokes && j.strokes.length) || 0);
};
const noteStore = (h) => path.join(h.dir, 'data', 'notes');

for (const app of ['notes (template)', 'notes (live)']) {
  test(`${app}: a note on disk opens, edits and saves IN PLACE — same file, no second file`, async () => {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'a', updated: 1 }] });
      h.put('entry-e0.json', MAIN_1);
      const A = runApp(app, h.relay, ['DATA', 'S', 'openEntry', 'entryPath', 'boot'], { clampTimers: true });
      await until(() => A.S.entries.length === 1, 'boot');
      await A.openEntry('e0');
      const pad = A.captured.pads[0];
      assert.equal(pad.nb.pages[0].strokes.length, 1, 'it opens with its content');
      pad.nb.pages[0].strokes.push({ p: [[9, 9]] });
      pad.guard.touch();
      assert.equal((await pad.guard.flush()).ok, true, 'and it saves');
      assert.equal(strokesIn(h.file('entry-e0.json')), 2, 'IN PLACE, in the same one file');
      // Only the note's own file and the writer's rolling backup of it (lib/appdata.mjs
      // maybeBackup — part of what makes the whole-file write recoverable). No directory, no
      // index, no page file, no draft.
      assert.deepEqual(fs.readdirSync(noteStore(h)).filter((f) => /^entry-/.test(f)).sort(),
        ['entry-e0.json', 'entry-e0.json.bak'], 'nothing but the note and its .bak');
      assert.ok(!fs.readdirSync(noteStore(h)).some((f) => fs.statSync(path.join(noteStore(h), f)).isDirectory()),
        'and no directory anywhere in the note store');
      A.stopPads();
    } finally { await h.stop(); }
  });
}

test('CONTROL: a blank page opens and its first save creates ONE file', async () => {
  // Without this the refusals above would pass on an app that simply never saves anything (R14).
  const h = await startHarness('notes');
  try {
    const A = runApp('notes (template)', h.relay, ['DATA', 'S', 'boot', 'entryPath'], { clampTimers: true });
    await until(() => A.captured.pads[0] && A.captured.pads[0].lastLoad, 'the boot pull');
    const pad = A.captured.pads[0];
    assert.equal(pad.lastLoad.status, 'absent', 'a blank page has nothing on disk — a proven absence');
    assert.equal(pad.guard.state().locked, false, 'the pad is writable');
    pad.nb = { v: 3, id: 'nb', pages: [{ id: 'p0', strokes: [{ p: [[1, 1]] }], pageHtml: '<div>hi</div>', images: [] }] };
    pad.touchPage('p0');
    assert.equal((await pad.guard.flush()).ok, true, 'and the first save LANDS');
    await until(() => A.S.entries.length === 1, 'the blank page to be promoted to a real entry');
    const id = A.S.entries[0].id;
    await until(() => fs.existsSync(h.file(A.entryPath(id))), 'its one file to reach disk');
    assert.equal(strokesIn(h.file(A.entryPath(id))), 1, 'the whole notebook, with its stroke, in that file');
    assert.ok(!fs.readdirSync(noteStore(h)).some((f) => fs.statSync(path.join(noteStore(h), f)).isDirectory()),
      'and no directory was created anywhere in the note store');
    A.stopPads();
  } finally { await h.stop(); }
});

test('V6 (c) bible (live): a failure report is retired ONLY by a success on its OWN path', async () => {
  const h = await startHarness('bible');
  try {
    h.put('notes/43-3.json', { notes: { v16: 'keep me' }, draws: {}, chat: {} });
    const A = runApp('bible (live)', h.relay, ['DATA', 'loadAnn', 'loadGen', 'saveAnn', 'saveGen', 'annPath', 'GEN_PATH',
      'paNoticeHas', 'annRetryStop', 'get ANN(){return ANN}', 'get BOOTED(){return _booted}', 'setCh:(b,c)=>{bookIdx=b;chapter=c;}'], { clampTimers: true });
    // The boot load first restores reading.json (PAReadingHistory), so its own chapter read lands later:
    // wait for it, or its SUCCESSFUL read of 43-3 would rightly retire the report this test raises below.
    for (let i = 0; i < 200 && !A.BOOTED; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(A.BOOTED, 'the boot load resolved');
    A.setCh(42, 3);
    await A.loadAnn();
    const failed = A.annPath();
    // The chapter's WRITE is rejected; everything else in the store keeps working.
    h.state.fault = { status: 500, body: '{"error":"boom"}', only: '43-3.json', on: 'put' };
    A.ANN.notes.v16 = 'edited';
    assert.equal((await A.saveAnn()).ok, false, 'the chapter write is rejected');
    assert.ok(A.paNoticeHas(failed), 'and its report is up');
    assert.ok(A.noticeOn(), 'visibly: ' + A.noticeText());

    assert.equal((await A.saveGen()).ok, true, 'an unrelated WRITE succeeds (general.json)');
    assert.ok(A.paNoticeHas(failed), 'the chapter report survives it');
    await A.loadGen();
    assert.ok(A.paNoticeHas(failed), 'an unrelated READ does not erase it either');
    A.setCh(42, 4);
    await A.loadAnn();                                   // a confirmed read of ANOTHER chapter
    assert.ok(A.paNoticeHas(failed), 'nor does a confirmed read of another chapter');
    assert.ok(A.noticeOn(), 'the surface still shows a failure: ' + A.noticeText());
    assert.match(A.noticeText(), /未保存|无法/, 'and it is still bilingual');

    // CONTROL: the ONE thing that may retire it — a success on that same path.
    A.setCh(42, 3);
    await A.loadAnn();                                   // reads fine (only writes were failing)
    assert.ok(!A.paNoticeHas(failed), 'a success on ITS OWN path does retire it');
    A.annRetryStop(failed);                              // stop the bounded ladder this test started
  } finally { await h.stop(); }
});

test('V6 (c) notes: an index-write failure survives a successful note save', async () => {
  const h = await startHarness('notes');
  try {
    h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'a', updated: 1 }] });
    h.put('entry-e0.json', MAIN_1);
    const A = runApp('notes (template)', h.relay, ['DATA', 'S', 'boot', 'openEntry', 'writeIndexNow', 'IDX_PATH', 'entryPath', 'paNoticeHas'], { clampTimers: true });
    await until(() => A.S.entries.length === 1, 'boot');
    await A.openEntry('e0');
    h.state.fault = { status: 500, body: '{"error":"boom"}', only: 'journal.json', on: 'put' };
    assert.equal((await A.writeIndexNow()).ok, false, 'the index write is rejected');
    assert.ok(A.paNoticeHas(A.IDX_PATH), 'and its report is up');
    const pad = A.captured.pads[0];
    pad.nb.pages[0].strokes.push({ p: [[5, 5]] });
    pad.guard.touch();
    assert.equal((await pad.guard.flush()).ok, true, 'the NOTE saves fine');
    assert.ok(A.paNoticeHas(A.IDX_PATH), 'and the index report is still up — a different path, a different fact');
    assert.ok(A.noticeOn(), 'still visible: ' + A.noticeText());
  } finally { await h.stop(); }
});

test('V6 (f) bible (live): exactly ONE markdown-paste handler — the engine owns it', () => {
  const code = stripComments(scriptOf(APP_SRC['bible (live)']));
  assert.ok(!/addEventListener\('paste'/.test(code), 'the app binds no paste listener at all');
  assert.ok(!/onNotePaste|mdToNoteHtml|paRenderMd|insertNoteHtml/.test(code), 'and the app-side converter is gone');
  assert.ok(!/'render-md'/.test(code), "…including its broker call — the engine's own converter is the only one");
  // The owner still exists, and still owns it: deleting BOTH sides would leave pasted markdown
  // landing as literal ** and ## again (the user-reported defect this pair fixes). Asserted
  // loosely on purpose — the engine's internals are the engine's to shape; what this file pins is
  // that the app is not a second owner.
  assert.ok(/addEventListener\('paste'/.test(ENGINE), 'the engine still binds the paste handler');
  assert.ok(/looksLikeMarkdown/.test(ENGINE) && /mdToHtml/.test(ENGINE), 'and still owns the markdown conversion');
  for (const app of Object.keys(APPS))
    assert.ok(!/function mdTo\w*Html/.test(stripComments(scriptOf(APP_SRC[app]))), `${app}: carries no second markdown dialect (R3)`);
});

test('MUTATION: every load-safety guard is load-bearing (R14 — these assertions can fail)', async () => {
  // A green suite proves nothing unless removing the fix turns it red. Each mutation below
  // re-introduces exactly one earlier behaviour in the REAL app source and re-runs the scenario.
  const setup = async (h) => {
    h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'a', updated: 1 }] });
    h.put('entry-e0.json', MAIN_1);
    h.state.fault = { status: 500, body: '{\"error\":\"boom\"}', only: 'entry-e0.json', on: 'get' };
  };
  // (1) Both barriers removed: a failed read stops blocking its path AND the replace-only check
  // is gone. A write to the note we could not read then lands, and its real strokes are destroyed.
  {
    const h = await startHarness('notes');
    try {
      await setup(h);
      const A = runApp('notes (template)', h.relay, ['DATA', 'S', 'openEntry', 'entryPath', 'boot'], { clampTimers: true,
        mutate: (s2) => s2
          .replace('known.delete(path); blocked.set(path,out.error); return out; };', 'known.delete(path); return out; };')
          .replace('if(opts&&opts.replaces&&!known.has(path)) return {ok:false,error:PA_UNKNOWN};', ''),
      });
      await until(() => A.S.entries.length === 1, 'boot');
      await A.openEntry('e0');
      const ep = A.entryPath('e0');
      const r = await A.DATA.write(ep, JSON.stringify({ v: 3, id: 'nb', pages: [{ id: 'p0', strokes: [], pageHtml: '', images: [] }] }), { replaces: true });
      assert.equal(r.ok, true, 'the MUTATED app accepts a write to the note it could not read');
      assert.equal(strokesIn(h.file('entry-e0.json')), 0, 'and the note is blanked — which is what the two guards prevent');
      A.stopPads();
    } finally { await h.stop(); }
  }
  // (2) Each barrier ALONE still refuses: defence in depth, asserted rather than assumed.
  for (const [name, mutate] of Object.entries({
    'only the path block removed': (s2) => s2.replace('known.delete(path); blocked.set(path,out.error); return out; };', 'known.delete(path); return out; };'),
    'only the replace-only check removed': (s2) => s2.replace('if(opts&&opts.replaces&&!known.has(path)) return {ok:false,error:PA_UNKNOWN};', ''),
  })) {
    const h = await startHarness('notes');
    try {
      await setup(h);
      const A = runApp('notes (template)', h.relay, ['DATA', 'S', 'openEntry', 'entryPath', 'boot'], { clampTimers: true, mutate });
      await until(() => A.S.entries.length === 1, 'boot');
      await A.openEntry('e0');
      const ep = A.entryPath('e0');
      assert.equal((await A.DATA.write(ep, '{\"v\":3,\"pages\":[]}', { replaces: true })).ok, false, `${name}: the surviving guard still refuses`);
      assert.equal(strokesIn(h.file('entry-e0.json')), 1, `${name}: the note is intact`);
      A.stopPads();
    } finally { await h.stop(); }
  }
  // (3) Make paNoticeOk global again and an unrelated success erases the report.
  {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'a', updated: 1 }] });
      h.put('entry-e0.json', MAIN_1);
      const A = runApp('notes (template)', h.relay, ['DATA', 'S', 'boot', 'openEntry', 'writeIndexNow', 'IDX_PATH', 'paNoticeHas'], { clampTimers: true,
        mutate: (s2) => s2.replace('function paNoticeOk(path){ if(PA_NOTICES.delete(path)) paRenderNotice(); }',
          'function paNoticeOk(path){ PA_NOTICES.clear(); paRenderNotice(); }'),
      });
      await until(() => A.S.entries.length === 1, 'boot');
      await A.openEntry('e0');
      h.state.fault = { status: 500, body: '{"error":"boom"}', only: 'journal.json', on: 'put' };
      assert.equal((await A.writeIndexNow()).ok, false, 'the index write is rejected');
      assert.ok(A.paNoticeHas(A.IDX_PATH), 'its report goes up');
      h.state.fault = null;
      const pad = A.captured.pads[0];
      pad.nb.pages[0].strokes.push({ p: [[5, 5]] });
      pad.guard.touch();
      assert.equal((await pad.guard.flush()).ok, true, 'an unrelated note saves');
      assert.ok(!A.paNoticeHas(A.IDX_PATH), 'and the GLOBAL surface erases the index report — the defect, reproduced');
      A.stopPads();
    } finally { await h.stop(); }
  }
});

test("a NEW note's first file — DATA.fresh, and what it refuses", async () => {
  // The other half of {replaces:true}: a path nothing has read is unwritable, and a note created
  // in this session has no read to point at. Without an explicit "I just minted this id" the very
  // first write of a new note could never be made at all. `fresh` is the app's claim, so it must
  // lose to the store's evidence.
  const h = await startHarness('notes');
  try {
    const C = coreModule('notes (template)', { LOAD: ENG.LOAD });
    const R = C.makeReader({
      load: (p) => (p.includes('blocked') ? Promise.resolve({ ok: false, code: 'server-error', status: 500, error: 'boom' }) : h.relay({ kind: 'data', path: p })),
      save: (p, d) => h.relay({ kind: 'save-data', path: p, data: d }).then((x) => (x && x.ok ? { ok: true } : { ok: false, error: 'x' })),
    });
    assert.equal((await R.write('entry-fresh.json', '{"id":"p0","strokes":[]}', { replaces: true })).ok, false, 'unread: refused');
    R.fresh('entry-fresh.json');
    assert.equal((await R.write('entry-fresh.json', '{"id":"p0","strokes":[]}', { replaces: true })).ok, true, 'minted: allowed');
    // Evidence beats assertion: a path whose read FAILED cannot be claimed fresh.
    assert.equal((await R.read('entry-blocked.json')).status, 'failed');
    R.fresh('entry-blocked.json');
    assert.equal(R.isKnown('entry-blocked.json'), false, 'a failed read cannot be overridden by the claim');
    assert.equal((await R.write('entry-blocked.json', '{"id":"p0","strokes":[]}', { replaces: true })).ok, false, 'and it stays unwritable');
  } finally { await h.stop(); }
});

test('CONTROL: the nested chapter path survives the shell relay AND the real app-data writer', async () => {
  // The Bible app's own paths are nested (notes/<b>-<c>.json) and the shell namespaces every app
  // under data/<slug>/, so a nested path is still load-bearing even though a note is one flat file.
  // Asserted against the REAL writer through the REAL relay rather than read off the source.
  const h = await startHarness('bible');
  try {
    const r = await h.relay({ kind: 'save-data', path: 'notes/43-3.json', data: JSON.stringify({ notes: { v16: 'x' }, draws: {}, chat: {} }) });
    assert.equal(r.ok, true, 'a nested chapter path is accepted: ' + JSON.stringify(r));
    assert.ok(fs.existsSync(h.file('notes/43-3.json')), 'and the directory was created for it');
    const back = await h.relay({ kind: 'data', path: 'notes/43-3.json' });
    assert.equal(back.ok, true, 'and it reads back through the same relay');
    assert.equal(JSON.parse(back.text).notes.v16, 'x');
    // Traversal is still refused, at the same seam it always was.
    assert.equal((await h.relay({ kind: 'save-data', path: '../escape.json', data: '{}' })).ok, false, 'traversal is refused');
  } finally { await h.stop(); }
});
