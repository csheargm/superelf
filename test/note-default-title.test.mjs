// A handwritten note has no first line to name itself by, so every one of them listed as the
// same placeholder — "Untitled 无标题" in Journal, and before that a row of identical "New Note"s
// in Bible. A user cannot tell those rows apart and reasonably concludes the handwriting was
// lost (it never was). The fix is that an unnamed note names itself by its CREATION TIME.
//
// The format was written three times — web.mjs freeStamp for the server's listing, a hand copy in
// the Bible app, and nowhere at all in Journal — which is why only one of the two apps had the
// feature. It now lives ONCE, in PANote, which is inlined into every app; the server keeps its own
// copy because it cannot import a browser component, and these tests hold the two byte-identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ENGINE, APP_SRC, TITLE_API, runApp, startHarness, until } from './helpers-app.mjs';

const SRV = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
// The shipped server formatter, lifted from web.mjs rather than retyped.
const srvSrc = SRV.match(/export const freeStamp = \(k, now = new Date\(\)\) => \{[\s\S]*?\n\};/);
const freeStamp = new Function('k', 'now', srvSrc[0]
  .replace(/^export const freeStamp = \(k, now = new Date\(\)\) => \{/, 'now = now || new Date();')
  .replace(/\n\};$/, ''));

test('PANote and the server produce the SAME stamp — one format, two runtimes', () => {
  const now = new Date(2026, 8, 8, 14, 32);
  for (const [label, d] of [
    ['same day', new Date(2026, 8, 8, 14, 32)],
    ['same day, early', new Date(2026, 8, 8, 0, 5)],
    ['another day', new Date(2026, 8, 1, 9, 5)],
    ['last year', new Date(2025, 11, 25, 23, 59)],
  ]) {
    const mine = TITLE_API.stamp(d.getTime(), now);
    assert.equal(mine, freeStamp(`free-${d.getTime()}`, now), `${label}: PANote drifted from freeStamp`);
    assert.notEqual(mine, '', `${label}: a real timestamp must produce a stamp`);
  }
});

test('an unusable timestamp yields no stamp — never a bogus date', () => {
  const now = new Date(2026, 8, 8, 14, 32);
  for (const bad of [undefined, null, '', 'nope', NaN, {}]) {
    assert.equal(TITLE_API.stamp(bad, now), '', `${JSON.stringify(bad)} must not produce a date`);
  }
  // …and the title degrades to the bare label, which is still not "Untitled".
  assert.equal(TITLE_API.defaultTitle(undefined, now), TITLE_API.NEW_NOTE_LABEL);
  assert.doesNotMatch(TITLE_API.defaultTitle(undefined, now), /Untitled|无标题/);
});

test('the label is declared ONCE on the client, and both runtimes agree on it', () => {
  assert.equal(TITLE_API.NEW_NOTE_LABEL, 'New Note 新笔记');
  assert.match(SRV, /NEW_NOTE_LABEL = 'New Note 新笔记'/, 'the server label must match PANote’s');
  assert.equal(ENGINE.match(/NEW_NOTE_LABEL\s*:/g).length, 1, 'PANote declares the label exactly once');
});

// ── R3 / the enumeration rule ── The last three reports of this class of bug were each fixed at
// one call site while the others kept the defect. This scans EVERY app instead.
test('no app re-implements the stamp; every app that names a note asks PANote', () => {
  const clock = /getHours\(\)\)\.padStart|toDateString\(\)\s*===/;
  for (const [name, src] of Object.entries(APP_SRC)) {
    assert.doesNotMatch(src, clock, `${name} re-implements the timestamp format — call PANote.stamp instead`);
    assert.doesNotMatch(src, /'Untitled 无标题'|"Untitled 无标题"/, `${name} still has a placeholder title`);
    // Only apps that actually NAME a note are in scope — the template Bible has no free-form
    // notes at all, and requiring it to call a titling API it never needs would be noise.
    if (/function freeNoteTitle|const displayTitle/.test(src)) {
      assert.match(src, /PANote\.(defaultTitle|stamp)\(/, `${name} names notes without asking PANote`);
    }
  }
});

// ── End to end ── a real index on disk, the real app boot, the real drawer rows.
const CREATED = new Date(2026, 8, 8, 14, 32).getTime();
const rowsFor = async (entries) => {
  const h = await startHarness('notes');
  try {
    h.put('journal.json', { v: 1, entries });
    const app = runApp('notes (live)', h.relay, ['S', 'boot', 'displayTitle'], { clampTimers: true });
    await until(() => app.S.entries.length === entries.length, 'boot to load the index');
    const drawer = app.captured.drawers[0];
    assert.ok(drawer, 'the notes app opens a list drawer');
    return await drawer.opts.items();
  } finally { await h.stop(); }
};

test('Journal lists a handwriting-only note by its time, not as a placeholder', async () => {
  // No title and no typed text: derivedTitleOf() finds no first line, so the fallback is the only
  // thing naming this row. This is the exact note in the bug report.
  const rows = await rowsFor([{ id: 'n1', title: '', created: CREATED, updated: CREATED, preview: '' }]);
  assert.equal(rows.length, 1);
  assert.doesNotMatch(rows[0].title, /Untitled|无标题/, 'a handwritten note must not list as a placeholder');
  assert.match(rows[0].title, /^New Note 新笔记 · /, `got ${JSON.stringify(rows[0].title)}`);
  assert.ok(rows[0].title.endsWith('14:32'), `the row carries the creation time: ${rows[0].title}`);
});

test('two handwritten notes made minutes apart are tellable apart', async () => {
  // The whole point: identical placeholder rows are what made a user believe notes were lost.
  const rows = await rowsFor([
    { id: 'a', title: '', created: CREATED, updated: CREATED, preview: '' },
    { id: 'b', title: '', created: CREATED + 7 * 60000, updated: CREATED, preview: '' },
  ]);
  assert.notEqual(rows[0].title, rows[1].title, 'two unnamed notes must not share one title');
  assert.ok(rows[0].title.endsWith('14:32') && rows[1].title.endsWith('14:39'), rows.map((r) => r.title).join(' / '));
});

test('an explicit rename and a typed first line still win over the timestamp', async () => {
  const rows = await rowsFor([
    { id: 'a', title: 'My sermon', created: CREATED, updated: CREATED, preview: '' },
    { id: 'b', title: '', derived: 'Grace 恩典', created: CREATED, updated: CREATED, preview: '' },
  ]);
  assert.equal(rows[0].title, 'My sermon', 'an explicit rename always wins');
  assert.equal(rows[1].title, 'Grace 恩典', 'a typed first line beats the timestamp');
});
