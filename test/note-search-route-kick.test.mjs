// The search KICK on its own server (R13 round 1 #8, R14 control): notebooks with ink on disk before the
// server starts, no /api/save-data in this root, so the ONLY thing that can start the OCR worker is
// the first GET /api/note-search. With the kick removed from noteOcrState this suite fails (the main
// route suite does not: there the save hook's worker drains every page of the app). The server's
// `note_ocr_cmd` is the committed fake tool (helpers-web): real queue, real execFile, no Vision.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, waitFor } from './helpers-web.mjs';
import { INDEX_DIR } from '../lib/note-search.mjs';
import { nb, put } from './helpers-note.mjs';

let port, root, web, WS;
before(async () => {
  port = await freePort(); root = mkWebRoot({ port }); WS = path.join(root, 'workspace');
  put(WS, 'notes', 'old-1.json', nb('<div>typed roof</div>', 100));
  put(WS, 'notes', 'old-2.json', nb('', 200));
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });

test('an old node backfills on its FIRST search: the GET alone starts the worker, no save involved', async () => {
  assert.ok(!fs.existsSync(path.join(WS, INDEX_DIR)), 'CONTROL: no index yet — nothing has run before this search');
  const first = await api(port, '/api/note-search?app=notes&q=roof').then(async (x) => ({ status: x.status, body: await x.json() }));
  assert.equal(first.status, 200);
  assert.equal(first.body.ocr, 'ready');
  assert.ok(first.body.pending >= 1, `the reply counts the ink pages it found owed, got ${first.body.pending}`);
  const index = () => JSON.parse(fs.readFileSync(path.join(WS, INDEX_DIR, 'notes.json'), 'utf8'));
  await waitFor(() => { try { return index().records.filter((x) => x.need.ink && x.done.ink === x.need.ink).length === 2; } catch { return false; } }, 'the search-kicked worker to transcribe both pages', { timeoutMs: 15000 });
  assert.deepEqual(index().records.map((x) => [x.path, x.src.ink.includes('Saturday pollen moderate 1')]).sort(), [['old-1.json', true], ['old-2.json', true]], 'the fake tool ran on both (pass B\'s line names the stroke count)');
  const ink = await api(port, '/api/note-search?app=notes&q=saturday').then((x) => x.json());
  assert.deepEqual(ink.hits.map((h) => h.where), ['ink', 'ink']);
  assert.equal(ink.pending, 0);
  const audit = fs.existsSync(path.join(root, 'audit.log')) ? fs.readFileSync(path.join(root, 'audit.log'), 'utf8') : '';
  assert.doesNotMatch(audit, /note-ocr-failed/);
});
