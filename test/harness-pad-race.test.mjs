// R14 / harness fidelity — the pad stub must carry the ENGINE's overlapping-load guard.
//
// Overlapping pulls are ordinary in this app, not exotic: boot() sets S.entries and only THEN
// awaits pad.open(), so anything that opens a note while boot is still loading — a test, or a
// user tapping the drawer on a slow connection — has two loads in flight at once. The shipped
// engine settles that in pull(): `const seq=++pullSeq` … `if(seq!==pullSeq) return out`, so the
// NEWEST pull owns the pad whatever order the responses arrive in.
//
// The stub in helpers-app.mjs assigned pad.nb unconditionally. When the older response happened
// to land last it replaced the notebook with pre-edit content, so a test saw strokes it had
// already saved to disk missing from memory. That was the ~1-run-in-6 suite flake in
// note-whole-file (d) — it only ever appeared under the full suite, because only then did the
// scheduling shift enough to reorder the two responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHarness, runApp, until, settle, deferred } from './helpers-app.mjs';

const NOTE = { v: 3, id: 'nb', created: 1, updated: 2, template: 'ruled', bgColor: '#fdfdfb',
  pages: [{ id: 'p0', created: 1, updated: 2, strokes: [{ c: '#111', w: 0.004, p: [[0.1, 0.2]] }], pageHtml: '<div>real work</div>', images: [] }] };

// Boot's load is HELD until after a second open has landed and saved, so the stale response is
// guaranteed to arrive last. Left to chance this ordering appears about one run in six.
async function withStaleBootLoad(fn) {
  const h = await startHarness('notes');
  h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'Journal', updated: 1 }] });
  h.put('entry-e0.json', NOTE);
  let held = false, staleResolved = false;
  const { promise: gate, resolve: release } = deferred();
  const relay = async (m) => {
    const isNoteRead = m && m.kind === 'data' && String(m.path || '').includes('entry-e0');
    if (isNoteRead && !held) {                       // the FIRST note read is boot's
      held = true;
      const out = await h.relay(m);                  // read really happens, then parks
      await gate;
      staleResolved = true;
      return out;
    }
    return h.relay(m);
  };
  try { await fn({ h, relay, release, fired: () => held, stale: () => staleResolved }); }
  finally { await h.stop(); }
}

test('a superseded load never replaces the notebook a newer open already saved', async () => {
  await withStaleBootLoad(async ({ h, relay, release, fired, stale }) => {
    const A = runApp('notes (live)', relay, ['DATA', 'S', 'openEntry', 'entryPath', 'boot'], { clampTimers: true });
    await until(() => A.S.entries.length === 1, 'boot read the index');
    await A.openEntry('e0');                         // the second pull — this one owns the pad
    assert.equal(fired(), true, 'precondition: boot\'s load really is parked, so a race exists at all');
    assert.equal(stale(), false, 'and it has NOT resolved yet — otherwise this proves nothing');

    const pad = A.captured.pads[0];
    pad.nb.pages[0].strokes.push({ c: '#111', w: 0.004, p: [[0.5, 0.5]] });
    pad.guard.touch();
    assert.equal((await pad.guard.flush()).ok, true, 'the new stroke is saved');
    const onDisk = JSON.parse(fs.readFileSync(h.file('entry-e0.json'), 'utf8'));
    assert.equal(onDisk.pages[0].strokes.length, 2, 'two strokes really are on disk');

    release();                                       // boot's stale response lands NOW
    await settle();
    assert.equal(stale(), true, 'R14: the stale load really did arrive — the race was exercised');
    assert.deepEqual(pad.nb.pages, onDisk.pages,
      'memory still matches disk — the older load did not overwrite the newer notebook');
    A.stopPads();
  });
});

test('the engine the stub mirrors still has the guard', () => {
  // The stub copies a real mechanism. If the engine ever drops it, the stub is mirroring fiction
  // and this file's other test would be pinning behaviour production no longer has.
  const eng = fs.readFileSync(new URL('../web/note-ui.inline.html', import.meta.url), 'utf8');
  assert.match(eng, /const seq\s*=\s*\+\+pullSeq/, 'pull() still claims a sequence');
  assert.match(eng, /if\(seq!==pullSeq\)\s*return/, 'and still abandons a superseded pull');
});
