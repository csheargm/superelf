// The note-size cliff, said out loud · 笔记容量上限提示
//
// SCAR 2026-09-12. A live journal note reached 6.54 MB — 4 pages, 2,067 strokes, 328,708 points —
// against an 8 MB cap, and the user reported losing handwriting. The store had been MEASURING the
// distance to that cap since the day it was written (lib/appdata.mjs stamps
// warn:'approaching_limit' past a quarter of the cap, and the shell relays save-data replies
// verbatim precisely so telemetry survives) — but outcomeOf collapsed every successful reply to a
// bare {ok:true}, so the number was computed, transmitted, and thrown away by every client.
//
// The result was the worst shape available: the ONLY sign of the limit was a save being refused
// AT it, mid-sentence, with a page of Pencil strokes live in memory and nowhere else. The cap was
// raised, but the cap is runway; THIS is the fix, and it is the part that must not rot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, guardModule, stripComments } from './helpers-app.mjs';
import { APP_DATA_MAX_BYTES, APP_DATA_WARN_BYTES } from '../lib/appdata.mjs';

const G = guardModule();
const E = stripComments(ENGINE);

const NB = () => ({ v: 2, pages: [{ id: 'p0', strokes: [{ p: [[1, 1]] }], pageHtml: '', images: [] }] });

// A guard wired to a write that answers like the real store.
function guardWith(reply, onWarn, noteKey) {
  const timers = new Map(); let seq = 0;
  const g = G.makeSaveGuard({
    serialize: NB,
    write: async () => reply,
    noteKey: noteKey || (() => 'n1'),
    onWarn,
    setTimer: (fn, ms) => { timers.set(++seq, fn); return seq; },
    clearTimer: (id) => timers.delete(id),
    startLocked: false,
  });
  return g;
}

test('the cap was raised, and the warning still fires below the note that hit it', () => {
  assert.equal(APP_DATA_MAX_BYTES, 16 * 1024 * 1024, 'cap raised to 16 MB');
  // This is the load-bearing relationship, not the absolute number: the warn threshold is cap/4,
  // so raising the cap RAISES the alarm too. At 32 MB the threshold would have been 8 MB — above
  // the 6.54 MB note that caused the report, silencing the very warning being added here.
  assert.equal(APP_DATA_WARN_BYTES, Math.floor(APP_DATA_MAX_BYTES / 4));
  const theNote = 6.54 * 1024 * 1024;
  assert.ok(theNote >= APP_DATA_WARN_BYTES, 'the note that lost handwriting would now warn');
  assert.ok(theNote < APP_DATA_MAX_BYTES, 'and still saves');
});

test('a successful save carries the size telemetry instead of discarding it', () => {
  const r = G.outcomeOf({ ok: true, saved: 1, bytes: 7_000_000, limit: 16_777_216, warn: 'approaching_limit' });
  assert.equal(r.ok, true);
  assert.equal(r.warn, 'approaching_limit', 'the store measured it; the client must not drop it');
  assert.equal(r.bytes, 7_000_000);
  assert.equal(r.limit, 16_777_216);
});

test('a quiet save stays quiet, and a failure is still just a failure', () => {
  const quiet = G.outcomeOf({ ok: true, saved: 1, bytes: 1000, limit: 16_777_216, warn: null });
  // EXACTLY {ok:true} — this outcome is a shared contract (PANote.saveOutcome) that callers all
  // over the repo compare against, so an ordinary save must not start carrying fields that mean
  // nothing to them. Telemetry appears only when there is telemetry.
  assert.deepEqual(quiet, { ok: true }, 'a quiet save is unchanged, field for field');
  const bad = G.outcomeOf({ ok: false, error: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal(bad.warn, undefined, 'a refusal reports the refusal, not telemetry');
});

test('the warning reaches the app — once per note, not once per stroke', async () => {
  // A 700ms autosave fires on every stroke. Warning each time would train the user to ignore it,
  // which is the same outcome as not warning at all.
  const seen = [];
  const g = guardWith({ ok: true, saved: 1, bytes: 7_000_000, limit: 16_777_216, warn: 'approaching_limit' },
    (r) => seen.push(r.bytes));
  g.touch(); await g.flush();
  g.touch(); await g.flush();
  g.touch(); await g.flush();
  assert.equal(seen.length, 1, 'said once');
  assert.equal(seen[0], 7_000_000, 'and it carries the real size');
});

test('a save that did NOT land never warns about size', async () => {
  // The pill is already saying something louder and more urgent; a size note on top of it is
  // noise competing with the message that matters.
  const seen = [];
  const g = guardWith({ ok: false, error: 'rejected' }, () => seen.push(1));
  g.touch(); await g.flush();
  assert.equal(seen.length, 0, 'no warning for a write that failed');
});

test('a warning that throws cannot turn a good save into a failed one', async () => {
  const g = guardWith({ ok: true, saved: 1, bytes: 7_000_000, limit: 16_777_216, warn: 'approaching_limit' },
    () => { throw new Error('boom'); });
  g.touch();
  const r = await g.flush();
  assert.equal(r.ok, true, 'the save is still confirmed');
  assert.equal(g.state().failed, false, 'and the pad is not put into a failure state');
});

test('the pad says it in both languages and names the numbers', () => {
  // "Getting large" with no number is unactionable — the user cannot tell whether to split now or
  // in a month. The message carries current size AND the cap.
  const fn = /onWarn:\(r\)=>\{[\s\S]*?\n      \},/.exec(E);
  assert.ok(fn, 'PANote supplies an onWarn handler');
  assert.match(fn[0], /_sizeWarned===k/, 'latched per note');
  assert.match(fn[0], /mb\(r\.bytes\)\}\/\$\{mb\(r\.limit\)\}/, 'it names size and cap');
  assert.match(fn[0], /笔记较大/, 'bilingual, like every other user-facing string here');
  assert.match(fn[0], /flash\(/, 'and it goes to a real surface');
});

test('the telemetry survives the whole path, not just the ends', () => {
  // Three places drop it if anyone "simplifies" them: the store must stamp it, the shell must
  // relay save-data replies verbatim, and outcomeOf must carry it through.
  assert.match(E, /if\(r\.warn&&cfg\.onWarn\)/, 'the guard forwards it on a confirmed write');
  assert.match(E, /m\.warn \? \{ok:true,warn:m\.warn/, 'outcomeOf carries it when there is something to carry');
});
