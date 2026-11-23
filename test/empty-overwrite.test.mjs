// THE EMPTY-OVERWRITE CLASS（空文档覆盖）— server side, 2026-09-02 round 2.
//
// THE DEFECT, stated once
//   Every store in the tree read itself leniently: `try { JSON.parse(read(f)) } catch
//   { return {} }`. That turns THREE different situations into one answer:
//     · the file is genuinely not there (a first save — fine);
//     · the file is there but the read failed (EACCES, EIO, a mount blip);
//     · the file is there but its bytes are damaged (a truncate-then-crash).
//   The handler then merged its small new input into that empty document and wrote it
//   back — replacing months of health samples, a whole month of meals, a profile, an
//   app's metadata or a conversation with a near-empty file, and answering 200 ok:true.
//   The user is told the save SUCCEEDED at the exact moment their data is destroyed.
//
// THE FIX BEING REGRESSED
//   lib/readjson.mjs readJsonState / readJsonForUpdate: read-before-write refuses to
//   proceed on anything but "absent" or "ok", and the refusal is a machine-readable
//   500 {code:'file_unreadable'} carrying a bilingual reason. The damaged bytes stay on
//   disk, so the data is still recoverable.
//
// R14 — every guard here is paired with a CONTROL proving it is not simply refusing
// everything: with the file ABSENT (the genuine first-save case) the same request must
// succeed. A guard that blocks the happy path too would be a different bug, not a fix.
//
// Real web.mjs over real HTTP on a throwaway root + workspace + ephemeral port; the
// lib-level cases run the real modules against throwaway workspaces. Never live data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';
import { FILE_UNREADABLE_CODE } from '../lib/readjson.mjs';
import { ingestHealth, recentHealth } from '../lib/health.mjs';
import { appendMeal } from '../lib/meals.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const TORN = '{"v":1,"entries":[{"id":"a"';   // killed between open and the closing brace
let port, root, web;
const ws = (rel) => path.join(root, 'workspace', rel);
const tmpWs = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-eo-'));

before(async () => { port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port); });
after(async () => { await stopWeb(web); rmTemp(root); });

// ── Profile（个人资料）────────────────────────────────────────────────────────
test('PUT /api/profile: a damaged profile.json is REFUSED, not rebuilt from the one field sent', async () => {
  const f = ws('profile.json');
  const good = { name: 'Owner', about: 'twelve years of notes about me', prefs: 'short answers', mailVips: ['a@b.example'] };
  fs.writeFileSync(f, JSON.stringify(good, null, 2));
  // CONTROL first (R14): while the file is READABLE the write works normally.
  const ok = await api(port, '/api/profile', { method: 'PUT', body: JSON.stringify({ name: 'Owner 2' }) });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).about, good.about, 'and the fields it did not send survive');
  // Now damage it the way a truncate-then-crash does.
  fs.writeFileSync(f, TORN);
  const r = await api(port, '/api/profile', { method: 'PUT', body: JSON.stringify({ name: 'Owner 3' }) });
  assert.equal(r.status, 500, 'a save that cannot read the previous version is a FAILURE, never a silent rewrite');
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.code, FILE_UNREADABLE_CODE, 'machine-readable: the client can say "nothing was saved" instead of guessing');
  assert.match(j.text, /拒绝覆盖/, 'bilingual reason');
  assert.equal(fs.readFileSync(f, 'utf8'), TORN, 'the damaged bytes are STILL THERE — recoverable, not replaced by {name:"Owner 3"}');
  fs.writeFileSync(f, JSON.stringify(good, null, 2)); // leave the root usable for the tests below
});

test('the profile GET stays lenient — a damaged file must not black out the settings screen', async () => {
  const f = ws('profile.json');
  const keep = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, TORN);
  const r = await api(port, '/api/profile');
  assert.equal(r.status, 200, 'reading is not writing: showing defaults destroys nothing');
  fs.writeFileSync(f, keep);
});

// ── App metadata（应用元数据）────────────────────────────────────────────────
test('PATCH /api/apps/:slug/share: a damaged meta.json is refused, not flattened to {"shared":true}', async () => {
  const dir = ws('apps/journal');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Journal</title>');
  const meta = { title: '日记 · Journal', desc: 'handwriting notebook', forkedFrom: { uid: 'owner', slug: 'notes' } };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  // CONTROL: a readable meta.json flips the flag and KEEPS every other field.
  const ok = await api(port, '/api/apps/journal/share', { method: 'PATCH', body: JSON.stringify({ shared: true }) });
  assert.equal(ok.status, 200);
  const after1 = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(after1.shared, true);
  assert.equal(after1.title, meta.title, 'title survived the toggle');
  assert.deepEqual(after1.forkedFrom, meta.forkedFrom, 'and so did the fork provenance');
  // Damaged: the swallowed `catch {}` used to make this write {"shared":true} alone.
  fs.writeFileSync(path.join(dir, 'meta.json'), TORN);
  const r = await api(port, '/api/apps/journal/share', { method: 'PATCH', body: JSON.stringify({ shared: false }) });
  assert.equal(r.status, 500);
  assert.equal((await r.json()).code, FILE_UNREADABLE_CODE);
  assert.equal(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'), TORN, 'title, desc and provenance were not thrown away');
});

// ── Conversations（对话）─────────────────────────────────────────────────────
test('POST /api/chat: a damaged conversation does NOT silently fork a new one and orphan the history', async () => {
  const cid = 'abc123def456';
  const dir = ws('conversations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${cid}.json`), TORN);
  const before = fs.readdirSync(dir).sort();
  const r = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify({ message: 'hello', convoId: cid }) });
  assert.equal(r.status, 500, 'refused BEFORE the stream starts, so the client gets a status it can read');
  const j = await r.json();
  assert.equal(j.code, FILE_UNREADABLE_CODE);
  assert.match(j.error, /无法读取该对话/, 'bilingual: the user is told which thing could not be read');
  assert.equal(fs.readFileSync(path.join(dir, `${cid}.json`), 'utf8'), TORN, 'the damaged conversation is still on disk for repair');
  assert.deepEqual(fs.readdirSync(dir).sort(), before,
    'and NO new conversation file appeared — the old behaviour started a fresh id here, and the app then stored that id as its pointer, making the real history unreachable');
});

test('the same route with a conversation that is merely ABSENT is not refused (the guard is not a wall)', async () => {
  // CONTROL (R14). An unknown id is a normal "start a new thread" — it must reach the
  // model lane. The lane itself has no CLI in a throwaway root, so the turn ends in a
  // streamed error; what matters is that it is a 200 NDJSON stream, NOT a 500 refusal.
  const r = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify({ message: 'hello', convoId: 'zzz999zzz999' }) });
  assert.equal(r.status, 200, 'an absent conversation still starts a chat');
  assert.match(r.headers.get('content-type') || '', /ndjson/);
  await r.body.cancel();
});

// ── Health（健康数据）────────────────────────────────────────────────────────
test('health ingest: a damaged health.json cannot be replaced by today\'s single row', () => {
  const w = tmpWs();
  const user = { id: 'u', workspace: w };
  // CONTROL: a genuine first ingest (file absent) works, and a second merges.
  assert.equal(ingestHealth(user, { date: '2026-08-01', steps: 8000 }).ok, true);
  assert.equal(ingestHealth(user, { date: '2026-08-02', steps: 9000 }).ok, true);
  assert.equal(recentHealth(user, 30).length, 2, 'two days of history stored');
  const f = path.join(w, 'health.json');
  const good = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, TORN);
  let err = null;
  try { ingestHealth(user, { date: '2026-08-03', steps: 100 }); } catch (e) { err = e; }
  assert.ok(err, 'the ingest throws instead of storing a one-day store');
  assert.equal(err.code, FILE_UNREADABLE_CODE);
  assert.equal(fs.readFileSync(f, 'utf8'), TORN, 'and 120 days of history were not replaced by one row');
  fs.writeFileSync(f, good);
  assert.equal(ingestHealth(user, { date: '2026-08-03', steps: 100 }).ok, true, 'once the file is readable again the ingest resumes');
  assert.equal(recentHealth(user, 30).length, 3);
  rmTemp(w);
});

test('health ingest v2: a damaged DAY file cannot be replaced by the samples in one upload', () => {
  const w = tmpWs();
  const user = { id: 'u', workspace: w };
  const payload = (iso, v) => ({ schema: 'health.v2', source: 'test', metrics: [{ metric: 'steps', unit: 'count', samples: [{ ts: iso, value: v }] }] });
  assert.equal(ingestHealth(user, payload('2026-08-10T09:00:00Z', 100)).ok, true);
  assert.equal(ingestHealth(user, payload('2026-08-10T10:00:00Z', 200)).ok, true);
  const dayFiles = fs.readdirSync(path.join(w, 'health')).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  assert.equal(dayFiles.length, 1, 'one day file holding both samples');
  const df = path.join(w, 'health', dayFiles[0]);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(df, 'utf8'))).length, 2);
  fs.writeFileSync(df, TORN);
  let err = null;
  try { ingestHealth(user, payload('2026-08-10T11:00:00Z', 300)); } catch (e) { err = e; }
  assert.ok(err && err.code === FILE_UNREADABLE_CODE, 'refused');
  assert.equal(fs.readFileSync(df, 'utf8'), TORN, 'a whole day of raw samples was not reduced to the one just uploaded');
  rmTemp(w);
});

// ── Meals（饮食记录）────────────────────────────────────────────────────────
test('appendMeal: a damaged month cannot be replaced by the single record being logged', () => {
  const w = tmpWs();
  const user = { id: 'u', workspace: w };
  const rec = (n) => ({ id: `meal-${n}`, ts: Date.parse('2026-08-15T12:00:00Z') + n, date: '2026-08-15', time: '12:00', slot: 'lunch', photo: `uploads/${n}.jpg` });
  for (let i = 0; i < 5; i++) appendMeal(user, rec(i));   // CONTROL: normal appends accumulate
  const f = path.join(w, 'meals', '2026-08.json');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).length, 5);
  fs.writeFileSync(f, TORN);
  let err = null;
  try { appendMeal(user, rec(9)); } catch (e) { err = e; }
  assert.ok(err && err.code === FILE_UNREADABLE_CODE, 'refused instead of writing a one-record month');
  assert.equal(fs.readFileSync(f, 'utf8'), TORN, 'the month\'s records are still on disk');
  rmTemp(w);
});

// ── Writes land on the file they claim to（写入落在自己的文件上）─────────────
test('saveConvo derives its path from the validated id — a stray id cannot land on another chat', () => {
  // fileURLToPath, not URL.pathname: on Windows the pathname is /D:/..., which is no file path.
  const WEB = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web.mjs'), 'utf8');
  const fn = WEB.slice(WEB.indexOf('function saveConvo(u, c)'), WEB.indexOf('function listConvos(u)'));
  assert.ok(fn.length > 50, 'found the real saveConvo');
  assert.match(fn, /convoFile\(u, c && c\.id\)/, 'the path comes from the SAME validator the read uses (R3)');
  assert.match(fn, /throw new Error/, 'and an invalid id is refused loudly, never concatenated into a path');
  assert.equal(/path\.join\(convosDir\(u\), c\.id \+ '\.json'\)/.test(fn), false,
    'the raw concatenation is gone: a document whose id disagrees with its filename used to make this write REPLACE a different conversation');
});
