// PANote: a write that would change nothing is not sent（跳过无变化的保存）.
//
// WHAT IS BEING PROVED, AND HOW IT IS COUNTED: not "the guard says it skipped" — REQUEST COUNTS
// at a real server. The harness is test/helpers-app.mjs, which is the repo's standard fixture:
// a real node:http server using the repo's OWN readBody + BODY_LIMITS + saveAppData, behind the
// shell's own broker (test/helpers-shell-broker.mjs), driving the ENGINE'S OWN makeSaveGuard from
// web/note-ui.inline.html. Nothing about saving is re-implemented here.
//
// THE THING THIS OPTIMISATION MUST NOT BECOME: the 2026-09-02 scar was a write that did nothing
// and reported {ok:true,saved:0}, which cleared a real failure and re-based the shrink floor onto
// a notebook that had never been written. So every test below is about the FAILURE side as much
// as the fast side: a failed save is still retried with unchanged bytes, a skip never clears a
// failure, a skip re-arms the shrink guard, and switching notes cannot make one note's bytes
// vouch for another's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUARD, guardModule, startHarness, settle } from './helpers-app.mjs';

const NOTE_A = 'entry-aaa.json';
const NOTE_B = 'entry-bbb.json';

// Notebook fixtures at the density measured on live data (lib/appdata.mjs: 21.7 bytes/point).
let pid = 0;
const page = () => ({ id: 'p' + (++pid), created: 1, updated: 1, strokes: [], pageHtml: '', images: [] });
const notebook = (id) => ({ v: 2, id, created: 1, updated: 1, template: 'ruled', bgColor: '#fdfdfb', pages: [page()] });
const stroke = (seed, pts = 120) => ({ c: '#141414', w: 0.004, p: Array.from({ length: pts }, (_, i) => [0.1 + i * 1e-4 + seed * 1e-3, 0.2 + i * 1e-4, 0.5]) });

// Controllable timers — the retry ladder is fired deterministically, never slept through.
function fakeClock() {
  const jobs = new Map(); let id = 0;
  return {
    setTimer: (fn, ms) => { const k = ++id; jobs.set(k, { fn, ms }); return k; },
    clearTimer: (k) => jobs.delete(k),
    pending: () => [...jobs.values()],
    async fire() { const all = [...jobs.entries()]; jobs.clear(); for (const [, j] of all) await j.fn(); },
  };
}

// One pad, wired the way web/note-ui.inline.html wires it: serialize returns the live notebook,
// write stamps nb.updated and posts the WHOLE notebook through the shell relay, noteKey names the
// note. `guardOf` lets a mutation test swap in a deliberately broken extraction of the same code.
function mountPad(h, { clock, guardOf = GUARD, note = NOTE_A } = {}) {
  const st = { key: note, nb: notebook('nb-' + note) };
  const seen = [];
  const guard = guardOf.makeSaveGuard({
    serialize: () => st.nb,
    write: (nb) => { nb.updated = Date.now(); return h.relay({ kind: 'save-data', path: st.key, data: nb }).then(guardOf.outcomeOf); },
    noteKey: () => st.key,
    onState: (s) => seen.push(s),
    setTimer: clock ? clock.setTimer : undefined, clearTimer: clock ? clock.clearTimer : undefined,
  });
  guard.seed(st.nb, true);                                  // the real lifecycle: mount → load → seed
  return {
    st, guard, seen,
    // Drawing goes through the same two steps endStroke() takes: mutate the notebook, tell the guard.
    draw: (seed) => { st.nb.pages[0].strokes.push(stroke(seed)); guard.touch(); },
    undraw: () => { st.nb.pages[0].strokes.pop(); guard.allowShrink(); guard.touch(); },
    // A "no-op change": exactly what an image drag that ends where it began, or a text region
    // committed unchanged, does — it tells the guard the notebook was touched, and stamps the
    // page mtime, without altering a byte of content.
    noop: () => { st.nb.pages[0].updated = Date.now(); guard.touch(); },
    saves: () => h.state.puts.filter((p) => p.endsWith(st.key)).length,
  };
}

const withHarness = async (fn) => { const h = await startHarness('notes'); try { await fn(h); } finally { await h.stop(); } };

// ═══ R14 CONTROLS — the harness must be able to see a write, and to fail ═════════════════════

test('control: a real change is SENT, and the request count is what proves it', async () => {
  await withHarness(async (h) => {
    const pad = mountPad(h);
    pad.draw(1);
    assert.deepEqual(await pad.guard.flush(), { ok: true });
    assert.equal(pad.saves(), 1, 'one write reached the real server');
    assert.equal(h.state.puts.length, 1);
    pad.draw(2);
    assert.deepEqual(await pad.guard.flush(), { ok: true });
    assert.equal(pad.saves(), 2, 'a second real change is a second write');
    pad.guard.stop();
  });
});

test('control: the mtime churn is real — a literal byte compare could never fire', () => {
  // This is why the skip compares CONTENT and excludes the `updated` key by name. Two notebooks
  // that differ ONLY by their mtimes are byte-different, and every no-op flow stamps one.
  const a = notebook('x'); const b = JSON.parse(JSON.stringify(a));
  b.updated = a.updated + 1; b.pages[0].updated = a.pages[0].updated + 1;
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'literally different bytes…');
  assert.equal(GUARD.contentPrint(a), GUARD.contentPrint(b), '…identical content');
  const c = JSON.parse(JSON.stringify(a)); c.pages[0].strokes.push(stroke(1));
  assert.notEqual(GUARD.contentPrint(a), GUARD.contentPrint(c), 'and a real edit is never equal');
});

// ═══ THE WIN ═════════════════════════════════════════════════════════════════════════════════

test('draw → save → no-op change → ZERO new requests; a real change → exactly one', async () => {
  await withHarness(async (h) => {
    const pad = mountPad(h);
    pad.draw(1);
    await pad.guard.flush();
    assert.equal(pad.saves(), 1);

    pad.noop();
    const skipped = await pad.guard.flush();
    assert.deepEqual(skipped, { ok: true, skipped: true }, 'the reply says a write was SKIPPED, not that one happened');
    assert.equal(pad.saves(), 1, 'no second request left the device');
    assert.equal(pad.guard.state().unsaved, false, 'and the pad is honestly clean');

    pad.noop(); pad.guard.schedule(); pad.noop();
    await pad.guard.flush();
    assert.equal(pad.saves(), 1, 'repeated no-ops stay at zero requests');

    pad.draw(2);
    await pad.guard.flush();
    assert.equal(pad.saves(), 2, 'the next real change is written immediately');
    pad.guard.stop();
  });
});

test('undo back to the last confirmed state is a no-op write too', async () => {
  await withHarness(async (h) => {
    const pad = mountPad(h);
    pad.draw(1);
    await pad.guard.flush();
    assert.equal(pad.saves(), 1);
    pad.draw(2);                                            // a stroke the user then takes back
    pad.undraw();
    await pad.guard.flush();
    assert.equal(pad.saves(), 1, 'the notebook is back to what is on disk — nothing to send');
    assert.equal(pad.guard.state().unsaved, false);
    pad.guard.stop();
  });
});

test('the file on disk is untouched by a skip — and still correct', async () => {
  await withHarness(async (h) => {
    const pad = mountPad(h);
    pad.draw(1);
    await pad.guard.flush();
    const fs = await import('node:fs');
    const first = fs.readFileSync(h.file(NOTE_A), 'utf8');
    pad.noop();
    await pad.guard.flush();
    assert.equal(fs.readFileSync(h.file(NOTE_A), 'utf8'), first, 'byte-identical file, no rewrite, no .bak churn');
    assert.equal(JSON.parse(first).pages[0].strokes.length, 1);
    pad.guard.stop();
  });
});

// ═══ THE FAILURE SIDE — none of it may be weakened ═══════════════════════════════════════════

test('a FAILED save is still retried even though its bytes never change', async () => {
  await withHarness(async (h) => {
    const clock = fakeClock();
    const pad = mountPad(h, { clock });
    pad.draw(1);
    await pad.guard.flush();
    assert.equal(pad.saves(), 1, 'the baseline write landed');

    h.state.fault = { status: 500, on: 'put', body: 'error' };
    pad.draw(2);
    const bad = await pad.guard.flush();
    assert.equal(bad.ok, false, 'the failure is reported, not swallowed');
    assert.equal(pad.saves(), 2);
    assert.equal(pad.guard.state().failed, true);

    // The retry re-sends the SAME bytes. If "unchanged" were the test, this would be skipped
    // for ever and the stroke would never reach disk — the whole point of `!failed`.
    for (let i = 0; i < 3; i++) { await clock.fire(); await settle(); }
    assert.ok(pad.saves() >= 3, `the ladder kept re-sending identical bytes (requests: ${pad.saves()})`);
    assert.equal(pad.guard.state().failed, true, 'and it is still failing, honestly');

    h.state.fault = null;
    await clock.fire(); await settle();
    assert.equal(pad.guard.state().failed, false, 'a real retry landed it');
    const fs = await import('node:fs');
    assert.equal(JSON.parse(fs.readFileSync(h.file(NOTE_A), 'utf8')).pages[0].strokes.length, 2, 'both strokes are on disk');
    pad.guard.stop();
  });
});

test('a skip never clears a failure — while a ladder is running, every write is sent', async () => {
  await withHarness(async (h) => {
    const clock = fakeClock();
    const pad = mountPad(h, { clock });
    pad.draw(1);
    await pad.guard.flush();

    h.state.fault = { status: 500, on: 'put', body: 'error' };
    pad.draw(2);
    await pad.guard.flush();
    assert.equal(pad.guard.state().failed, true);
    const afterFailure = pad.saves();

    // Back to exactly the last CONFIRMED content while the failure is live. The skip must NOT
    // fire — a failure may be retired only by a confirmed write or the user's tap.
    pad.undraw();
    const r = await pad.guard.flush();
    assert.equal(r.ok, false, 'still failing, and it says so');
    assert.notEqual(r.skipped, true, 'the reply is a real failure, never a fabricated "already saved"');
    assert.ok(pad.saves() > afterFailure, 'the write was attempted rather than assumed unnecessary');
    assert.equal(pad.guard.state().failed, true);
    pad.guard.stop();
  });
});

test('the shrink guard is re-armed by a skip — a later collapse is still refused', async () => {
  await withHarness(async (h) => {
    const pad = mountPad(h);
    pad.draw(1); pad.draw(2);
    await pad.guard.flush();
    assert.equal(pad.saves(), 1);

    pad.guard.allowShrink();                                // armed by an erase the user then undid
    pad.noop();
    assert.deepEqual(await pad.guard.flush(), { ok: true, skipped: true });

    // If the skip had left allowShrink armed, this collapse would be written straight through.
    pad.st.nb.pages[0].strokes.length = 0;
    pad.guard.touch();
    const r = await pad.guard.flush();
    assert.equal(r.ok, false, 'the shrink guard refused it');
    assert.match(String(r.error), /strokes 2→0|笔迹变少/, r.error);
    assert.equal(pad.saves(), 1, 'and nothing was written');
    pad.guard.stop();
  });
});

// ═══ CROSS-NOTE — one note's bytes may never vouch for another's ═════════════════════════════

test('two notes with identical content: the second is still written (the key is compared too)', async () => {
  await withHarness(async (h) => {
    const pad = mountPad(h);
    pad.draw(1);
    await pad.guard.flush();
    assert.equal(h.state.puts.length, 1);

    // The app switches notes: reset() (still under the OUTGOING key), repoint, load, seed.
    pad.guard.reset();
    pad.st.key = NOTE_B;
    pad.guard.seed(pad.st.nb, true);
    pad.guard.touch();                                      // note B holds byte-identical content
    const r = await pad.guard.flush();
    assert.deepEqual(r, { ok: true }, 'a real write, not a skip');
    assert.equal(h.state.puts.length, 2);
    const fs = await import('node:fs');
    assert.ok(fs.existsSync(h.file(NOTE_B)), 'note B exists on disk in its own right');
    pad.guard.stop();
  });
});

test('a failed LOAD forgets the last confirmed bytes — the next write is never skipped', async () => {
  await withHarness(async (h) => {
    const pad = mountPad(h);
    pad.draw(1);
    await pad.guard.flush();
    assert.equal(pad.saves(), 1);

    pad.guard.lock('读取失败 · read failed', 'load_failed');  // the store could not be read
    pad.guard.seed(pad.st.nb, true);                         // …then a retry succeeded
    pad.guard.touch();
    assert.deepEqual(await pad.guard.flush(), { ok: true }, 'written, because nothing may be assumed durable across a lock');
    assert.equal(pad.saves(), 2);
    pad.guard.stop();
  });
});

// ═══ MUTATION TESTS — each half of the condition removed must turn a named assertion red ═════

const SKIP_COND = 'if(!failed && lastOk && lastOk.key===who && lastOk.fp===print){';

test('MUTATION without `!failed`, a live failure is silently declared saved', async () => {
  const broken = guardModule((s) => s.replace(SKIP_COND, 'if(lastOk && lastOk.key===who && lastOk.fp===print){'));
  await withHarness(async (h) => {
    const clock = fakeClock();
    const pad = mountPad(h, { clock, guardOf: broken });
    pad.draw(1);
    await pad.guard.flush();
    h.state.fault = { status: 500, on: 'put', body: 'error' };
    pad.draw(2);
    await pad.guard.flush();
    assert.equal(pad.guard.state().failed, true);
    const afterFailure = pad.saves();
    pad.undraw();
    const r = await pad.guard.flush();
    assert.deepEqual(r, { ok: true, skipped: true }, 'DEFECT: flush() answered ok while a failure was live — every caller checks r.ok');
    assert.equal(pad.saves(), afterFailure, 'DEFECT: nothing was even attempted');
    assert.equal(pad.guard.state().failed, true, 'the guard still knows it failed — which is exactly what makes the ok:true reply a lie');
    pad.guard.stop();
  });
});

test('MUTATION without the note-key comparison, note B rides on note A\'s confirmation', async () => {
  const broken = guardModule((s) => s.replace(SKIP_COND, 'if(!failed && lastOk && lastOk.fp===print){'));
  await withHarness(async (h) => {
    const pad = mountPad(h, { guardOf: broken });
    pad.draw(1);
    await pad.guard.flush();
    pad.guard.reset();
    pad.st.key = NOTE_B;
    pad.guard.seed(pad.st.nb, true);
    pad.guard.touch();
    // reset() clears lastOk, so re-establish the cross-note case the key comparison exists for:
    // a confirmed write of B, then back to A holding identical content.
    await pad.guard.flush();
    pad.st.key = NOTE_A;
    pad.guard.touch();
    const r = await pad.guard.flush();
    assert.deepEqual(r, { ok: true, skipped: true }, 'DEFECT: note A was declared saved by note B\'s confirmation');
    const fs = await import('node:fs');
    assert.equal(fs.readFileSync(h.file(NOTE_A), 'utf8').length > 0, true);
    pad.guard.stop();
  });
});

test('MUTATION with a literal byte compare, the skip never fires at all', async () => {
  // The R14 half: implementing "byte-identical" literally would look like a feature and do
  // nothing, because every no-op flow stamps an mtime.
  // Re-aimed at the CURRENT fingerprint. It used to target a one-line
  // `JSON.stringify(nb, …skip mtime…)`; contentPrint has since become a content hash (so that a
  // crop, move or resize, which all keep the image COUNT, still register). The mutation target
  // moved with it and the test had been matching nothing — passing no judgement on anything.
  // The property under test is unchanged: a fingerprint taken over the WHOLE notebook includes
  // the mtime that every no-op flow stamps, so it can never be equal twice and the skip is dead.
  const literal = guardModule((s) => s.replace(
    "const contentPrint=(nb)=>{\n    if(!nb||!Array.isArray(nb.pages)) return '';",
    'const contentPrint=(nb)=>{\n    return JSON.stringify(nb);'));
  await withHarness(async (h) => {
    const pad = mountPad(h, { guardOf: literal });
    pad.draw(1);
    await pad.guard.flush();
    assert.equal(pad.saves(), 1);
    pad.noop();
    await pad.guard.flush();
    assert.equal(pad.saves(), 2, 'DEFECT: a no-op change was written anyway — the optimisation would not exist');
    pad.guard.stop();
  });
});
