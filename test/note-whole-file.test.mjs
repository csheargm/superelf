// ONE ATOMIC WHOLE-NOTEBOOK WRITE PER NOTE — the round-5 revert, and the three guard bugs that
// outlived the layout.
//
// WHY THIS FILE EXISTS
//   Round 4 split a note across an index.json and N page files. Adversarial verification found
//   three MEASURED loss paths in ORDINARY flows, and this file is where each of them stays dead:
//     F1  flush() resolved {ok:true} while a write it should cover was still in flight. Microtask
//         ordering: run()'s continuation was queued on that promise FIRST, so it resumed, saw the
//         user's stroke (`again`), started write #2 and cleared `dirty` — and only THEN did
//         flush() resume, read dirty===false and report success. The note switch that followed
//         proceeded believing the outgoing note was safe.
//     F2  after that switch the OLD note's failure was re-armed against the NEW notebook
//         (rearmDirty pushed the old note's page ids into the new note's dirty set). The retry
//         then wrote NOTHING and answered {ok:true,saved:0,total:0}, which the guard read as a
//         confirmed save — failure cleared, ladder reset, shrink floor re-based. The stroke was
//         gone from disk AND memory while the pad said "saved".
//     F3  deleteById used isLegacyNote(id), whose LAYOUT map only loadNote() ever filled, so
//         deleting a note this session never opened wrote a NEW-LAYOUT tombstone
//         (entry-<id>/index.json) for a LEGACY note. entry-<id>.json kept the handwriting, the
//         next open read the tombstoned index first and manufactured an "absent", and the note
//         opened EMPTY with its content unreachable.
//   The layout is reverted (one file per note) and the three guards are fixed. F1 and F2 are
//   properties of the SAVE GUARD, not of the layout, so they are proved against the guard itself.
//
// HARNESS FIDELITY (R14): the guard, the load contract and the app closures are all EXTRACTED
// from the shipped files and executed — a real node:http server with the repo's own readBody /
// BODY_LIMITS / saveAppData behind the shell's own relay. Every claim below is paired with a
// MUTATION that re-introduces the defect and shows the assertion going red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENGINE, SHELL, CHAT, APP_SRC, APPS, stripComments, scriptOf,
  startHarness, runApp, until, settle, deferred } from './helpers-app.mjs';

// The guard, extracted at the SAME boundary test/note-save.test.mjs uses (R3: one extraction rule).
// `src` is a parameter so a MUTATED engine can be built the identical way.
function guardFrom(src) {
  const from = src.indexOf('  const SAVE_TIMEOUT_MS=');
  const to = src.indexOf('\n  function Note(host, opts){');
  assert.ok(from > 0 && to > from, 'makeSaveGuard must stay a DOM-free block above function Note()');
  const block = src.slice(from, to);
  assert.match(block, /function makeSaveGuard\(cfg\)\{/, 'the extraction found the real guard');
  // eslint-disable-next-line no-new-func
  return new Function(`${block}\nreturn {makeSaveGuard,SAVE_TXT,outcomeOf};`)();
}
const G = guardFrom(ENGINE);

const NB = (n = 1) => ({ v: 2, id: 'nb', created: 1, updated: 1, template: 'ruled', bgColor: '#fdfdfb',
  pages: [{ id: 'p0', created: 1, updated: 1, strokes: Array.from({ length: n }, (_, i) => ({ c: '#111', w: 0.004, p: [[i / 100, 0.2]] })), pageHtml: '', images: [] }] });
// A real macrotask turn: enough for every queued microtask AND every already-resolved promise
// continuation to run. If a promise has not settled after this, it genuinely has not settled.
const turn = (n = 4) => new Promise((r) => { let i = n; const step = () => (--i <= 0 ? r() : setImmediate(step)); setImmediate(step); });

// ═══ (a) F1 — flush() cannot report success while a write it covers is in flight ═══════════════

// The probe, once, so the real engine and the mutated one are driven by IDENTICAL code (R14: a
// mutation test that runs a different script proves nothing).
async function f1Probe(GG) {
  const gate1 = deferred(), gate2 = deferred();
  const gates = [gate1, gate2];
  const nb = NB(1);
  let cut = 0;
  const guard = GG.makeSaveGuard({
    serialize: () => nb,
    write: () => { const g = gates[cut++]; return g ? g.promise : Promise.resolve({ ok: true }); },
    startLocked: false,
    setTimer: () => 0, clearTimer: () => {},          // no debounce/retry timers in this probe
  });
  guard.touch();
  const first = guard.flush();                        // cuts write #1
  await turn();
  assert.equal(cut, 1, 'write #1 is in flight');
  // The user draws WHILE write #1 is in the air, then the app flushes (a note switch, a hide).
  nb.pages[0].strokes.push({ c: '#111', w: 0.004, p: [[0.9, 0.9]] });
  guard.touch();
  const probe = guard.flush();
  let settled = null;
  probe.then((r) => { settled = r; });
  gate1.resolve({ ok: true });                        // write #1 lands; run() resumes and cuts write #2
  await turn();
  return { guard, first, probe, cut: () => cut, settledNow: () => settled, gate2 };
}

test('(a) F1: flush() does not resolve while a write it covers is still in flight', async () => {
  const r = await f1Probe(G);
  assert.equal(r.cut(), 2, 'the stroke drawn mid-write cut a SECOND write');
  assert.equal(r.settledNow(), null,
    'and flush() has NOT resolved — it is waiting for the write it is responsible for: ' + JSON.stringify(r.settledNow()));
  r.gate2.resolve({ ok: false, error: 'boom' });      // …and it reports that write's TRUE outcome
  const out = await r.probe;
  assert.equal(out.ok, false, 'flush reports the real outcome of the write it waited for');
  assert.match(String(out.error), /boom/, 'including its reason: ' + out.error);
  assert.equal(r.guard.state().unsaved, true, 'and the pad still knows the note is unconfirmed');
  r.guard.stop();
  await r.first.catch(() => {});
});

test('(a) MUTATION: the one-await flush reports success with the second write still in the air', async () => {
  // Exactly the pre-fix body: await inFlight ONCE, then trust `dirty`. run()'s continuation runs
  // first and clears it, so this resolves {ok:true} on a note that has not been written.
  const mutated = ENGINE.replace(
    /        let last=null;\n        for\(let step=0;step<FLUSH_MAX_STEPS;step\+\+\)\{[\s\S]*?\n        \}\n        return \{ok:false,error:SAVE_TXT\.notSaved\+' — '\+SAVE_TXT\.retry\};/,
    "        if(inFlight){ await inFlight; }\n"
    + "        if(locked) return dirty ? {ok:false,error:locked,locked:true,code:lockCode} : {ok:true,locked:true};\n"
    + "        if(!dirty&&!failed) return {ok:true};\n"
    + "        return run();");
  assert.notEqual(mutated, ENGINE, 'the mutation matched the real flush — otherwise it proves nothing');
  const r = await f1Probe(guardFrom(mutated));
  assert.equal(r.cut(), 2, 'the mutated guard also cut a second write');
  assert.deepEqual(r.settledNow(), { ok: true },
    'and it ALREADY reported success while that write was in flight — the F1 defect, reproduced');
  r.gate2.resolve({ ok: false, error: 'boom' });
  r.guard.stop();
  await Promise.all([r.first.catch(() => {}), r.probe.catch(() => {})]);
});

// ═══ (b) F2 — failure state is keyed to the note it belongs to ═════════════════════════════════

// One script, two engines (R14). `keys` drives the note the app is pointed at.
async function f2Switch(GG) {
  let key = 'A';
  let reply = { ok: false, error: 'rejected' };
  const nb = NB(2);
  const guard = GG.makeSaveGuard({
    serialize: () => nb,
    write: () => Promise.resolve(reply),
    noteKey: () => key,
    startLocked: false,
    setTimer: () => 0, clearTimer: () => {},
  });
  guard.touch();
  await guard.flush();                                 // note A's write is REJECTED
  const afterFail = guard.state();
  guard.reset();                                       // the note switch: reset runs under A's key…
  key = 'B';                                           // …then the app repoints its closures
  guard.seed(nb, true);                                // …and B loads
  const onB = guard.state();
  reply = { ok: true };
  guard.touch();
  await guard.flush();                                 // B saves fine
  const onBSaved = guard.state();
  guard.reset(); key = 'A'; guard.seed(nb, true);      // back to A
  const backOnA = guard.state();
  guard.stop();
  return { afterFail, onB, onBSaved, backOnA };
}

test("(b) F2: note A's failure never becomes note B's, and returning to A surfaces it", async () => {
  const s = await f2Switch(G);
  assert.equal(s.afterFail.failed, true, 'A really did fail');
  assert.equal(s.onB.outstanding, false, 'B does NOT inherit it as its own outstanding write');
  assert.equal(s.onB.failed, false, 'and no retry ladder is running against B');
  assert.match(s.onB.text, /之前的笔记未保存/, 'B shows only the honest "an earlier note did not save": ' + s.onB.text);
  assert.equal(s.onBSaved.outstanding, false, "B's own successful save is not contaminated");
  assert.equal(s.backOnA.outstanding, true, 'and coming back to A surfaces the write that never landed');
  assert.match(s.backOnA.text, /之前的改动未保存/, 'in A\'s own words: ' + s.backOnA.text);
});

test('(b) MUTATION: one anonymous failure key and A\'s failure is reported against B', async () => {
  const mutated = ENGINE.replace('const keyOf=()=>{ try{ return cfg.noteKey?String(cfg.noteKey()):\'\'; }',
    'const keyOf=()=>{ try{ return \'\'; }');
  assert.notEqual(mutated, ENGINE, 'the mutation matched — otherwise it proves nothing');
  const s = await f2Switch(guardFrom(mutated));
  assert.equal(s.onB.outstanding, true,
    "the MUTATED guard reports the OTHER note's failure as B's own — the cross-note leak, reproduced");
});

test('(b) F2: a write that says it wrote NOTHING is not a confirmed save', async () => {
  // The exact reply the re-armed per-page retry produced. It must not clear the failure, must not
  // reset the retry ladder, and must not re-base the shrink floor.
  let reply = { ok: false, error: 'rejected' };
  const nb = NB(3);
  const guard = G.makeSaveGuard({
    serialize: () => nb, write: () => Promise.resolve(reply), noteKey: () => 'A',
    startLocked: false, setTimer: () => 0, clearTimer: () => {},
  });
  guard.touch();
  await guard.flush();
  assert.equal(guard.state().failed, true, 'the note is in failure');
  const attempts = guard.state().attempt;
  reply = { ok: true, saved: 0, total: 0 };            // the "retry" that wrote nothing
  const r = await guard.flush();
  assert.equal(r.ok, false, 'a no-op is NOT a confirmed save: ' + JSON.stringify(r));
  assert.match(String(r.error), /未写入任何内容/, 'and it says so, bilingually: ' + r.error);
  assert.equal(guard.state().failed, true, 'the failure state survives it');
  assert.equal(guard.state().outstanding, true, "and so does the note's outstanding record");
  assert.ok(guard.state().attempt > attempts, 'the retry ladder ADVANCED rather than being reset');
  guard.stop();
});

test('(b) MUTATION: accept ok:true with saved:0 and the no-op clears the failure', async () => {
  // Anchored on the GUARD, not on the whole expression's formatting: the previous anchor spelled
  // out the entire ternary, so adding a field to the success branch silently stopped the mutation
  // from matching — a mutation test that matches nothing proves nothing.
  const mutated = ENGINE.replace('wroteNothing(m) ? {ok:false,error:SAVE_TXT.noop}', 'false ? {ok:false,error:SAVE_TXT.noop}');
  assert.notEqual(mutated, ENGINE, 'the mutation matched — otherwise it proves nothing');
  const M = guardFrom(mutated);
  let reply = { ok: false, error: 'rejected' };
  const nb = NB(3);
  const guard = M.makeSaveGuard({
    serialize: () => nb, write: () => Promise.resolve(reply), noteKey: () => 'A',
    startLocked: false, setTimer: () => 0, clearTimer: () => {},
  });
  guard.touch();
  await guard.flush();
  reply = { ok: true, saved: 0, total: 0 };
  const r = await guard.flush();
  assert.equal(r.ok, true, 'the MUTATED guard calls a no-op a save');
  assert.equal(guard.state().failed, false, 'and clears the failure on the strength of it — the F2 defect');
  assert.equal(guard.state().attempt, 0, 'ladder reset too');
  guard.stop();
});

test('(b) source pin: there is no channel through which a failure could be re-armed at all', () => {
  const code = stripComments(ENGINE);
  assert.match(code, /write:\(nb\)=>\{ nb\.updated=Date\.now\(\); return opts\.save\?opts\.save\(nb\):\{ok:true\}; \}/,
    'the engine hands the store the WHOLE notebook and nothing else');
  assert.match(code, /const raw=await cfg\.write\(nb\)|await cfg\.write\(nb\)/, 'and cfg.write takes exactly one argument');
  for (const gone of [/rearmDirty/, /dirtyPlan/, /r\.failed/])
    assert.ok(!gone.test(code), `no per-page failure channel survives: ${gone}`);
});

// ═══ (c) F3 — deleting a note this session never opened ════════════════════════════════════════

const NOTE_ON_DISK = { v: 3, id: 'nb', created: 1, updated: 2, template: 'ruled', bgColor: '#fdfdfb',
  pages: [{ id: 'p0', created: 1, updated: 2, strokes: [{ c: '#111', w: 0.004, p: [[0.1, 0.2]] }], pageHtml: '<div>real work</div>', images: [] }] };
const strokesIn = (f) => { const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  return Array.isArray(j.pages) ? j.pages.reduce((a, p) => a + ((p.strokes && p.strokes.length) || 0), 0) : 0; };

for (const app of ['notes (template)', 'notes (live)']) {
  test(`(c) F3 ${app}: deleting a NEVER-OPENED note tombstones that note's own file, and nothing else`, async () => {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'a', updated: 1 }, { id: 'e1', title: 'b', updated: 1 }] });
      h.put('entry-e0.json', NOTE_ON_DISK);
      h.put('entry-e1.json', NOTE_ON_DISK);
      const A = runApp(app, h.relay, ['DATA', 'S', 'deleteById', 'entryPath', 'boot'], { clampTimers: true });
      await until(() => A.S.entries.length === 2, 'boot to load the index');
      // e0 is NEVER opened: nothing has populated any session state about it. That is the whole
      // scenario — the old code asked a map that was empty and got the wrong answer.
      await A.deleteById('e0');
      await settle(8);
      assert.deepEqual(A.S.entries.map((e) => e.id), ['e1'], 'it is gone from the list');
      const store = path.join(h.dir, 'data', 'notes');
      const files = fs.readdirSync(store).sort();
      assert.ok(!files.some((f) => fs.statSync(path.join(store, f)).isDirectory()), 'no directory was created: ' + files.join(','));
      assert.ok(!files.some((f) => /^entry-e0\//.test(f) || f === 'index.json'), 'no second-layout file was created');
      const tomb = JSON.parse(fs.readFileSync(path.join(store, 'entry-e0.json'), 'utf8'));
      assert.equal(tomb.deleted, true, "the tombstone is on the note's OWN file: " + JSON.stringify(tomb));
      assert.equal(strokesIn(path.join(store, 'entry-e1.json')), 1, 'and the neighbour note is untouched');
      A.stopPads();
    } finally { await h.stop(); }
  });
}

test('(c) MUTATION: derive the delete path from a layout guess and the note is stranded', async () => {
  // `isLegacyNote(id)` returned false for a note the session never opened (the LAYOUT map was
  // empty), so the tombstone went to the NEW-LAYOUT path. Reproduced literally.
  const h = await startHarness('notes');
  try {
    h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'a', updated: 1 }] });
    h.put('entry-e0.json', NOTE_ON_DISK);
    const A = runApp('notes (template)', h.relay, ['DATA', 'S', 'deleteById', 'boot'], { clampTimers: true,
      mutate: (s) => s.replace('const tp=entryPath(id);', "const tp='entry-'+id+'/index.json';"),
    });
    await until(() => A.S.entries.length === 1, 'boot');
    await A.deleteById('e0');
    await settle(8);
    const store = path.join(h.dir, 'data', 'notes');
    assert.ok(fs.existsSync(path.join(store, 'entry-e0', 'index.json')),
      'the MUTATED app wrote the tombstone to a path this note does not live at');
    assert.equal(strokesIn(path.join(store, 'entry-e0.json')), 1,
      "…and the note's real handwriting is still on disk, dereferenced from the list — STRANDED, which is the F3 defect");
    A.stopPads();
  } finally { await h.stop(); }
});

// ═══ (d) the user's REAL shapes round-trip: open → edit → save → reload ═════════════════════════

test('(d) a journal note in the real whole-file shape round-trips open→edit→save→reload', async () => {
  const h = await startHarness('notes');
  try {
    h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'Journal', updated: 1 }] });
    h.put('entry-e0.json', NOTE_ON_DISK);
    const A = runApp('notes (live)', h.relay, ['DATA', 'S', 'openEntry', 'entryPath', 'boot'], { clampTimers: true });
    await until(() => A.S.entries.length === 1, 'boot');
    await A.openEntry('e0');
    const pad = A.captured.pads[0];
    assert.deepEqual(pad.nb.pages[0].strokes, NOTE_ON_DISK.pages[0].strokes, 'it opens with EXACTLY what is on disk');
    assert.equal(pad.nb.pages[0].pageHtml, '<div>real work</div>', 'text included');
    pad.nb.pages[0].strokes.push({ c: '#111', w: 0.004, p: [[0.5, 0.5]] });
    pad.guard.touch();
    assert.equal((await pad.guard.flush()).ok, true, 'and it saves');
    const onDisk = JSON.parse(fs.readFileSync(h.file('entry-e0.json'), 'utf8'));
    assert.deepEqual(onDisk.pages, pad.nb.pages, 'the file holds the WHOLE notebook, byte-faithfully');
    // Reload: what comes back is what went in.
    await A.openEntry('e0');
    assert.deepEqual(A.captured.pads[0].nb.pages[0].strokes, onDisk.pages[0].strokes, 'and a reload returns it unchanged');
    const store = path.join(h.dir, 'data', 'notes');
    assert.ok(!fs.readdirSync(store).some((f) => fs.statSync(path.join(store, f)).isDirectory()),
      'no directory was created anywhere in the note store');
    A.stopPads();
  } finally { await h.stop(); }
});

test("(d) a Bible chapter with an INLINE draws{} notebook round-trips, and its notes/chat/titles are untouched", async () => {
  const h = await startHarness('bible');
  try {
    // The user's real shape: one chapter file carrying notes + an inline notebook + chat + titles.
    const chapter = { notes: { v16: 'a text note' }, chat: { v16: 'convo-1' }, titles: { v16: 'My note' },
      draws: { v16: { v: 2, id: 'nbk', created: 1, updated: 2, template: 'ruled', bgColor: '#fdfdfb',
        pages: [{ id: 'p0', created: 1, updated: 2, strokes: [{ c: '#111', w: 0.004, p: [[0.1, 0.2]] }], pageHtml: '', images: [] }] } } };
    h.put('notes/43-3.json', chapter);
    const A = runApp('bible (live)', h.relay, ['DATA', 'loadAnn', 'annPath', 'get ANN(){return ANN}',
      'setCh:(b,c)=>{bookIdx=b;chapter=c;}', 'setScope:(k)=>{_drawScope=k;}'], { clampTimers: true });
    A.setCh(42, 3);
    await A.loadAnn();
    A.setScope('v16');
    const pad = A.captured.pads[0];
    const out = await pad.opts.load();
    assert.equal(out.status, 'loaded', 'the scope opens from the chapter file itself — no second request');
    assert.deepEqual(out.data.pages[0].strokes, chapter.draws.v16.pages[0].strokes, 'with exactly the strokes on disk');
    const nb = JSON.parse(JSON.stringify(out.data));
    nb.pages[0].strokes.push({ c: '#111', w: 0.004, p: [[0.7, 0.7]] });
    assert.equal((await pad.opts.save(nb)).ok, true, 'and it saves');
    const back = JSON.parse(fs.readFileSync(h.file('notes/43-3.json'), 'utf8'));
    // CONTRACT CHANGE (v2.53.0): a verse used to have TWO note surfaces — notes[k] text and
    // draws[k] handwriting. They are one surface now, so opening the pad MERGES the old text onto
    // the page and the save completes that merge by removing the old key. Text under the SAME key
    // is therefore expected to move, not to survive in place.
    assert.equal(back.notes.v16, undefined, 'the merged text no longer lives in notes[k]…');
    assert.match(JSON.stringify(back.draws.v16), /a text note/, '…because it moved into the notebook');
    // Other keys are still untouched — the merge is per-scope, not a wipe.
    assert.deepEqual(back.notes, {}, 'and nothing else was touched');
    assert.deepEqual(back.chat, chapter.chat, 'and its chat pointers');
    assert.deepEqual(back.titles, chapter.titles, 'and its titles (the rename scar stays fixed)');
    assert.ok(Array.isArray(back.draws.v16.pages), 'draws[k] is still the INLINE notebook — not a manifest/ref');
    assert.equal(back.draws.v16.pages[0].strokes.length, 2, 'carrying the new stroke');
    // And no per-scope directory anywhere under the chapter store.
    const dir = path.join(h.dir, 'data', 'bible', 'notes');
    assert.ok(!fs.readdirSync(dir).some((f) => fs.statSync(path.join(dir, f)).isDirectory()),
      'no per-scope directory was created: ' + fs.readdirSync(dir).join(','));
    A.stopPads();
  } finally { await h.stop(); }
});

// ═══ (e) CONTROL — the load contract still blocks writes after a failed/corrupt read ════════════

test('(e) CONTROL: a failed read still BLOCKS writes to that path (the guard that already passed)', async () => {
  const h = await startHarness('notes');
  try {
    h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'a', updated: 1 }] });
    h.put('entry-e0.json', NOTE_ON_DISK);
    const before = fs.readFileSync(h.file('entry-e0.json'));
    // ONLY the READ fails. A write would be ACCEPTED by the server, so if the app issued one the
    // note would be destroyed — that is what keeps this non-vacuous (R14).
    h.state.fault = { status: 500, body: '{"error":"boom"}', only: 'entry-e0.json', on: 'get' };
    const A = runApp('notes (live)', h.relay, ['DATA', 'S', 'openEntry', 'entryPath', 'boot'], { clampTimers: true });
    await until(() => A.S.entries.length === 1, 'boot');
    await A.openEntry('e0');
    await until(() => A.DATA.blockedReason(A.entryPath('e0')) !== '', 'the note to be blocked');
    const pad = A.captured.pads[0];
    assert.equal(pad.guard.state().locked, true, 'the pad is LOCKED — a note that could not be read is not written');
    assert.equal((await pad.opts.save(NB(1))).ok, false, "and the app's own save closure refuses");
    await settle(8);
    assert.deepEqual(fs.readFileSync(h.file('entry-e0.json')), before, 'the note is byte-identical');
    assert.ok(A.noticeOn() && /无法/.test(A.noticeText()), 'and the bilingual report is up: ' + A.noticeText());
    A.stopPads();
  } finally { await h.stop(); }
});

test('(e) CONTROL: a CORRUPT read is a failure, not an empty file, and still blocks', async () => {
  const h = await startHarness('notes');
  try {
    h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'a', updated: 1 }] });
    fs.writeFileSync(h.file('entry-e0.json'), '{"pages":[{"strokes":[');     // truncated mid-write
    const before = fs.readFileSync(h.file('entry-e0.json'));
    const A = runApp('notes (live)', h.relay, ['DATA', 'S', 'openEntry', 'entryPath', 'boot'], { clampTimers: true });
    await until(() => A.S.entries.length === 1, 'boot');
    await A.openEntry('e0');
    assert.equal((await A.DATA.read(A.entryPath('e0'))).status, 'failed', 'unparsable is NOT empty');
    assert.notEqual(A.DATA.blockedReason(A.entryPath('e0')), '', 'so the path is blocked');
    const pad = A.captured.pads[0];
    assert.equal((await pad.opts.save(NB(1))).ok, false, 'and the save refuses');
    await settle(6);
    assert.deepEqual(fs.readFileSync(h.file('entry-e0.json')), before, 'the damaged file is left exactly as found');
    A.stopPads();
  } finally { await h.stop(); }
});

// ═══ (f) grep-level proof: nothing that is SERVED reads or writes a per-page path ═══════════════

test('(f) no per-page path is read or written by any served file', () => {
  // The scar comments deliberately name what was deleted, so this runs over CODE only — a grep
  // that cannot tell a comment from a statement would fail on the documentation, or pass because
  // someone deleted the documentation.
  const served = {
    'web/note-ui.inline.html': ENGINE,
    'web/index.html': SHELL,
    'web/chat-ui.inline.html': CHAT,
    ...Object.fromEntries(Object.keys(APPS).map((k) => [APPS[k], APP_SRC[k]])),
  };
  const banned = [
    [/index\.json/, 'a page index file'],
    [/'page-'\s*\+|"page-"\s*\+|page-\$\{/, 'a per-page filename'],
    [/\bsavePages\b/, 'the per-page writer'],
    [/\bidxPath\b|\bscopeIdxPath\b/, 'the index path helper'],
    [/\breadPages\b|\breadScope\b|\bwriteScope\b/, 'the per-scope reader/writer'],
    [/\bperPageScope\b|\bisLegacyNote\b|\bIDX_PAGES\b|\bLAYOUT\b/, 'the layout guess'],
    [/\brearmDirty\b|\bdirtyPlan\b|\bdirtyPages\b|\bindexDirty\b/, 'the dirty plan'],
    [/\bDRAWS_REF\b|\bisManifest\b/, 'the chapter manifest'],
    [/parkDraft|writeDraft|draftPath|noteDraftRead/, 'the draft store (deleted in round 4, stays deleted)'],
  ];
  for (const [rel, src] of Object.entries(served)) {
    const code = stripComments(src.replace(/<!--[\s\S]*?-->/g, ''));
    for (const [re, what] of banned) {
      const m = code.match(re);
      assert.ok(!m, `${rel} still carries ${what}: ${m && m[0]}`);
    }
  }
  // CONTROL (R14): the grep can fail. Feed it the pattern it is looking for.
  assert.ok(/index\.json/.test(stripComments("const p=noteDir(id)+'index.json';")), 'the grep detects the real thing');
});

test('(f) every served app writes a note through exactly ONE path helper', () => {
  for (const [name, rel] of Object.entries(APPS)) {
    const code = stripComments(scriptOf(APP_SRC[name]));
    if (name.startsWith('notes')) {
      assert.match(code, /const entryPath=id=>'entry-'\+id\+'\.json';/, `${rel}: one path helper`);
      // Every content write and the tombstone go through it — asserted by counting the ways a
      // note path can be spelled at all.
      const spellings = [...code.matchAll(/'entry-'\s*\+/g)].length;
      assert.equal(spellings, 1, `${rel}: 'entry-'+ appears once, in the one helper (found ${spellings})`);
      assert.match(code, /const tp=entryPath\(id\);/, `${rel}: the delete tombstone uses that helper, not a layout guess`);
    } else {
      const spellings = [...code.matchAll(/notes\/\$\{bookIdx\+1\}-\$\{chapter\}|bible-notes\/\$\{bookIdx\+1\}-\$\{chapter\}/g)].length;
      assert.ok(spellings >= 1, `${rel}: the chapter path is spelled in annPath`);
      assert.ok(!/\$\{k\}\//.test(code), `${rel}: no per-scope directory is ever built`);
    }
  }
});

test('(f) the whole-file rationale is stated where the save lives (R10)', () => {
  assert.match(ENGINE, /ONE ATOMIC WHOLE-NOTEBOOK WRITE PER NOTE/, 'the engine states it beside makeSaveGuard');
  assert.match(ENGINE, /atomic by construction|ATOMIC BY CONSTRUCTION/i, 'and says why');
  assert.match(ENGINE, /8MB|BODY_LIMITS\.appData/, 'and names the cap it fits inside');
  for (const name of ['notes (template)', 'notes (live)'])
    assert.match(APP_SRC[name], /ONE FILE PER NOTE/, `${APPS[name]}: the rationale is at the store too`);
  assert.match(APP_SRC['bible (live)'], /ONE FILE PER CHAPTER/, 'and at the Bible chapter store');
  // …and each of them says what to do instead of bringing it back.
  assert.match(ENGINE, /concurrency design/, 'the engine names the precondition for revisiting it');
});

test('R11 attestation pin: the design doc for the deleted layout is gone too', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'docs', 'design', 'per-page-notebook-storage.md')),
    'a design doc describing a layout nothing implements is a trap for the next session (R7)');
});
