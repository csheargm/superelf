// The hosts' side of bookmarks (docs/plans/note-features.md D): the Journal's onPin writes `pin:true`
// into journal.json through writeIndexNow and never touches the note file (helpers-app runApp, a
// real server); the Bible's rows and pinChapterNote are pinned in both shipped copies, and
// /api/notes answers `pin` per row over the REAL web.mjs. Template and live copies are both checked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_SRC, startHarness, runApp, until } from './helpers-app.mjs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';
import { nb, put as putIn } from './helpers-note.mjs';

const NOTEBOOK = { v: 3, id: 'nb', pages: [{ id: 'p0', strokes: [], pageHtml: '<div>landlord</div>', images: [] }] };
const INDEX = { v: 1, entries: [{ id: 'e0', title: 'Note 0', created: 1, updated: 2, preview: 'p' }, { id: 'e1', title: 'Note 1', created: 3, updated: 4, preview: 'q' }] };

for (const app of ['notes (template)', 'notes (live)']) {
  test(`${app}: onPin(id, flag) writes pin:true into journal.json and removes it again; the note file is untouched; rows carry pin`, async () => {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', INDEX); h.put('entry-e0.json', NOTEBOOK);
      const noteFile = path.join(h.dir, 'data', 'notes', 'entry-e0.json'), idx = path.join(h.dir, 'data', 'notes', 'journal.json');
      const noteBefore = fs.readFileSync(noteFile, 'utf8');
      const A = runApp(app, h.relay, ['DATA', 'S', 'boot'], { clampTimers: true });
      await until(() => A.S.entries.length === 2, 'boot to load the index');
      const drawer = A.captured.drawers[0];
      assert.equal(typeof drawer.opts.onPin, 'function', 'the drawer gets the hook');
      await drawer.opts.onPin('e0', true);
      let saved = JSON.parse(fs.readFileSync(idx, 'utf8'));
      assert.deepEqual(saved.entries.map((e) => [e.id, e.pin]), [['e0', true], ['e1', undefined]], 'the flag, on that entry only, absent = not');
      assert.deepEqual((await drawer.opts.items()).map((r) => [r.id, r.pin]), [['e1', false], ['e0', true]], 'the rows read the same flag');
      await drawer.opts.onPin('e0', false);
      saved = JSON.parse(fs.readFileSync(idx, 'utf8'));
      assert.equal('pin' in saved.entries[0], false, 'unbookmark deletes the key rather than writing false');
      assert.equal(fs.readFileSync(noteFile, 'utf8'), noteBefore, 'a bookmark never rewrites the note');
      await drawer.opts.onPin('nope', true);
      assert.equal(fs.readFileSync(idx, 'utf8'), JSON.stringify(saved), 'an unknown id writes nothing');
    } finally { await h.stop(); }
  });
}

test('the Bible rows pass pin and onPin, pinChapterNote keeps pins beside titles, loadAnn carries them, delete drops them — in both copies', () => {
  for (const app of ['bible (template)', 'bible (live)']) {
    const src = APP_SRC[app];
    assert.match(src, /onPin:\(flag\)=>pinChapterNote\(n,flag\), pin:!!n\.pin,/, `${app}: the augment row`);
    assert.match(src, /async function pinChapterNote\(n,flag\)\{\n  const obj=await readChapterOrRefuse\(n\.bookIdx,n\.chapter\);/, `${app}: read-then-write through the refusing reader, like rename`);
    assert.match(src, /obj\.pins=obj\.pins\|\|\{\}; if\(flag\) obj\.pins\[n\.verseKey\|\|'general'\]=true; else delete obj\.pins\[n\.verseKey\|\|'general'\];/, `${app}: the same key rule as titles`);
    assert.match(src, /ANN=\{notes:\{\},draws:\{\},chat:\{\},titles:\{\},pins:\{\}\}/, `${app}: ANN carries pins, or the next stroke deletes them`);
    assert.match(src, /ANN\.pins=migrateKeys\(o\.pins\|\|\{\}\);/, `${app}: read back on load`);
    assert.match(src, /if\(r\.ok&&n\.bookIdx===bookIdx&&n\.chapter===chapter\) ANN\.pins=obj\.pins;/, `${app}: the open chapter's in-memory copy follows the file`);
    assert.match(src, /delete \(obj\.titles\|\|\{\}\)\[n\.verseKey\]; delete \(obj\.pins\|\|\{\}\)\[n\.verseKey\]; \}/, `${app}: delete drops the pin with the note`);
  }
});

// ── /api/notes (the `notes-list` kind) over the real web.mjs ────────────────────────────────────
let port, root, web, WS;
before(async () => {
  port = await freePort(); root = mkWebRoot({ port }); WS = path.join(root, 'workspace');
  putIn(WS, 'bible', 'notes/43-3.json', { draws: { v16: nb('<div>神爱世人</div>'), 'free-1700000000000': nb('<div>free note</div>') }, titles: { v16: 'Loved' }, pins: { v16: true } });
  putIn(WS, 'bible', 'notes/01-1.json', { draws: { v1: nb('<div>beginning</div>') } });
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });

test('notes-list returns pin per row like title: true where the chapter file pins the scope, false elsewhere, absent map included', async () => {
  const r = await api(port, '/api/notes');
  assert.equal(r.status, 200);
  const rows = (await r.json()).map((n) => [n.verseKey, n.title, n.pin]).sort();
  assert.deepEqual(rows, [['free-1700000000000', 'free note', false], ['v1', 'beginning', false], ['v16', 'Loved', true]]);
});

// ── `created` per row (plan E review): the draw notebook's own, else the free-<epoch> key, else 0 ──
test('notes-list returns created per row: the notebook\'s created, the free key\'s epoch when the notebook has none, 0 for a text-only verse note', async () => {
  putIn(WS, 'bible', 'notes/40-5.json', { notes: { v3: 'text only' }, draws: { 'free-1600000000000': { v: 2, id: 'x', pages: [] } } });
  const r = await api(port, '/api/notes');
  const rows = Object.fromEntries((await r.json()).map((n) => [`${n.bookIdx}:${n.chapter}:${n.verseKey}`, n.created]));
  assert.equal(rows['42:3:v16'], 1, 'the notebook\'s own created');
  assert.equal(rows['42:3:free-1700000000000'], 1, 'a notebook with created wins over its key');
  assert.equal(rows['39:5:free-1600000000000'], 1600000000000, 'no created in the notebook: the key\'s epoch');
  assert.equal(rows['39:5:v3'], 0, 'a text-only verse note: unknown, the app falls back to updated');
});
