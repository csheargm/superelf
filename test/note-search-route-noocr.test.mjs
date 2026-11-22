// GET /api/note-search on a node that cannot transcribe, both ways it happens: a LINUX node (platform
// branch: `note_ocr_cmd` empty, the platform stood in through NOTE_OCR_PLATFORM, read at use time —
// R13 round 1 #13) and a node whose configured `note_ocr_cmd` names nothing that runs (cmd branch).
// Either way the reply says `ocr:'unavailable'`, the pages stay `pending`, nothing is run and nothing is
// audited as a failure. Own servers: the main route suite's server has the fake tool.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';
import { INDEX_DIR } from '../lib/note-search.mjs';
import { nb, stroke, put } from './helpers-note.mjs';

const servers = {};
async function boot(name, extraConfig, env = {}) {
  const port = await freePort(); const root = mkWebRoot({ port, extraConfig }); const WS = path.join(root, 'workspace');
  put(WS, 'notes', 'entry-1.json', { ...nb('<div>typed roof</div>'), pages: [{ id: 'p', created: 1, updated: 2, strokes: [stroke], pageHtml: '<div>typed roof</div>', images: [] }, { id: 'q', created: 1, updated: 2, strokes: [stroke, stroke], pageHtml: '', images: [] }] });
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);                     // startWeb's child inherits this process's env
  try { servers[name] = { port, root, WS, web: startWeb(root) }; } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  await waitReady(port);
}
before(async () => {
  await boot('linux', { note_ocr_cmd: '' }, { NOTE_OCR_PLATFORM: 'linux' });
  await boot('nocmd', { note_ocr_cmd: '/no/such/panote-ocr' });
});
after(async () => { for (const s of Object.values(servers)) await stopWeb(s.web); });

async function unavailable({ port, root, WS }) {
  const r = await api(port, '/api/note-search?app=notes&q=roof').then(async (x) => ({ status: x.status, body: await x.json() }));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.ocr, r.body.pending, 'reason' in r.body], [true, 'unavailable', 2, false], 'both pages carry ink nobody can read here; unavailable carries no failure reason');
  assert.deepEqual(r.body.hits.map((h) => [h.path, h.where]), [['entry-1.json', 'typed']]);
  await new Promise((d) => setTimeout(d, 400));
  const idx = JSON.parse(fs.readFileSync(path.join(WS, INDEX_DIR, 'notes.json'), 'utf8'));
  assert.deepEqual(idx.records.map((x) => [x.done.ink, x.src.ink, x.ocrError]), [[null, '', {}], [null, '', {}]], 'untouched: no worker ran, no error recorded (it will be transcribed on a Mac node)');
  const audit = fs.existsSync(path.join(root, 'audit.log')) ? fs.readFileSync(path.join(root, 'audit.log'), 'utf8') : '';
  assert.doesNotMatch(audit, /note-ocr-failed/, 'unavailable is a status, not a failure');
}
test('a Linux node (platform branch, no cmd): ocr:unavailable, ink pages pending, typed search works, nothing audited', () => unavailable(servers.linux));
test('a node whose note_ocr_cmd does not run (cmd branch): the same', () => unavailable(servers.nocmd));
