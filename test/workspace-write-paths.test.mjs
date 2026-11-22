// App data cannot plant the CLI's project config · 应用数据写不进 .claude 与 .mcp.json
//
// THE HOLE (R13 round 3, 2026-10-13): POST /api/save-data took any `.json` path in the caller's own
// workspace. A signed-in member could write <their workspace>/.claude/settings.json (a SessionStart
// hook), .claude/settings.local.json, or .mcp.json (a server command). The next CLI run there loads
// them with no approval (measured on Claude Code 2.1.161, ADR 0016), and every agent run's cwd is the
// workspace root, so the member's next chat ran a command of their choosing as the server's Unix
// user, past every deny. The CLI refuses its own agent those paths; this route did not.
// AND (R13 round 1 on the fix, 2026-10-13): the `..` check ran on the RAW text, but safeJoin decodes.
// So an app sent `%2E%2E/%2E%2E/profile.json`; the broker namespaced it to data/<slug>/…, the server
// decoded it to <workspace>/profile.json and wrote it — the owner's system prompt, read by the
// owner's unrestricted lane — or another app's data, or an untagged conversation (reproduced). And a
// symlink inside the workspace led a plain path into .claude/.
// THE FIX: lib/appdata.mjs appDataFile judges the DECODED segments (no `..`, none starting with a
// dot) and, on disk, refuses a path through any symlink. Both routes and the test fake server use it.
//
// Over HTTP on the real web.mjs, as the member the dot hole was for, and through the real shell
// broker as an app in the owner's session. R14: each has an ordinary path written by the same route.
// The app-shelf and fork routes' share of the same holes: test/app-fork-paths.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appDataFile, APP_DATA_DIR } from '../lib/appdata.mjs';
import { INDEX_DIR } from '../lib/note-search.mjs';
import { writeFileAtomic } from '../lib/atomicwrite.mjs';
import { saveJob, jobPath } from '../lib/jobs/store.mjs';
import { readShell } from '../lib/shellhtml.mjs';
import { ROOT } from './helpers-app.mjs';
import { api, OWNER_TOKEN } from './helpers-web.mjs';
import { startLaneServer, MEMBER_TOKEN } from './helpers-agent-lane.mjs';
import { loadShellBroker } from './helpers-shell-broker.mjs';

const BAD = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', '.CLAUDE/settings.json',
  '%2Eclaude/settings.json', '%2emcp.json', './.mcp.json', 'data/notes/.hidden.json', 'data/.x/notes.json',
  '%2E%2E/profile.json', 'data/notes/%2E%2E/%2E%2E/profile.json', 'data/notes/%2e%2e/journal/x.json', 'data\\..\\profile.json',
  // R13 round 3: the server holds the namespace itself — only data/<slug>/… is app data.
  'profile.json', 'conversations/abcdef123456.json', 'data/x.json', 'data/Notes/x.json', 'data/con/x.json',
  'data\\notes\\x.json'];   // R13 round 4: a backslash is an ordinary character on POSIX — it landed at the root
let L, KID;
before(async () => { L = await startLaneServer(); KID = path.join(L.root, 'workspace-kid'); });
after(async () => { if (L) await L.stop(); });
const post = (route, body) => api(L.port, route, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });

test('CONTROL: the member saves an ordinary app-data file through the same route', async () => {
  const r = await post('/api/save-data', { path: 'data/notes/x.json', data: '{"a":1}' });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(KID, 'data/notes/x.json'), 'utf8'), '{"a":1}');
});

test('save-data refuses every dot-path, in JSON, and writes nothing', async () => {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };   // absent: compared as null
  for (const bad of BAD) {
    const target = path.join(KID, decodeURIComponent(bad));   // where safeJoin would have put it
    const was = read(target);                                   // profile.json exists already
    const r = await post('/api/save-data', { path: bad, data: '{"hooks":{}}' });
    assert.equal(r.status, 400, `refused: ${bad}`);
    assert.equal((await r.json()).code, 'bad_path', bad);
    assert.equal(read(target), was, `not written: ${bad}`);
  }
  assert.ok(!fs.existsSync(path.join(KID, '.claude')), 'no .claude directory was created either');
});

test('restore-data refuses a dot-path too (it renames <path>.bak over <path>)', async () => {
  fs.writeFileSync(path.join(KID, '.mcp.json.bak'), '{"mcpServers":{}}');   // as if a backup sat there
  const r = await post('/api/restore-data', { path: '.mcp.json' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'bad_path');
  assert.ok(!fs.existsSync(path.join(KID, '.mcp.json')), 'nothing was restored into place');
});

test('an app in the owner\'s session cannot climb out of data/<slug>/ by encoding `..` (the real broker)', async () => {
  const ws = path.join(L.root, 'workspace');
  const profile = path.join(ws, 'profile.json');
  const was = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : null;
  const B = loadShellBroker(`http://127.0.0.1:${L.port}`, { token: OWNER_TOKEN, app: 'notes' });
  await B.post({ id: 'ok', kind: 'save-data', path: 'mine.json', data: '{"a":1}' });
  assert.equal(B.reply('ok').ok, true, `CONTROL: ${B.said('ok')}`);
  assert.equal(fs.readFileSync(path.join(ws, 'data/notes/mine.json'), 'utf8'), '{"a":1}', 'CONTROL: written under data/notes/');
  for (const [i, bad] of ['%2E%2E/%2E%2E/profile.json', '%2e%2e/journal/entry.json', '%2E%2E/%2E%2E/conversations/abcdef123456.json'].entries()) {
    await B.post({ id: `bad${i}`, kind: 'save-data', path: bad, data: '{"systemPrompts":{"global":"PLANTED"}}' });
    assert.equal(B.reply(`bad${i}`).ok, false, `refused: ${bad} ${B.said(`bad${i}`)}`);
  }
  assert.equal(fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : null, was, 'the owner\'s profile.json is unchanged');
  assert.ok(!fs.existsSync(path.join(ws, 'data/journal/entry.json')), 'another app\'s data is untouched');
  assert.ok(!fs.existsSync(path.join(ws, 'conversations/abcdef123456.json')), 'no conversation was planted');
});

test('a symlink inside the workspace cannot carry an app-data path anywhere', async () => {
  fs.mkdirSync(path.join(KID, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(KID, 'data'), { recursive: true });
  fs.symlinkSync(path.join(KID, '.claude'), path.join(KID, 'data/cfg'), 'junction');   // 'junction': no admin on Windows
  try {
    const r = await post('/api/save-data', { path: 'data/cfg/settings.json', data: '{"hooks":{}}' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'bad_path');
    assert.ok(!fs.existsSync(path.join(KID, '.claude/settings.json')), 'nothing written through the link');
  } finally { fs.rmSync(path.join(KID, 'data/cfg')); fs.rmSync(path.join(KID, '.claude'), { recursive: true }); }
});

test('appDataFile, driven directly', () => {
  const ws = L.root;
  assert.equal(appDataFile(ws, 'data/notes/x.json'), path.join(ws, 'data/notes/x.json'));
  assert.equal(appDataFile(ws, 'data/notes/notes.v2.json'), path.join(ws, 'data/notes/notes.v2.json'), 'a dot inside a name is fine');
  // namespace:false (the two stand-in test servers): the rest of the rule still holds.
  assert.equal(appDataFile(ws, 'notes.v2.json', { namespace: false }), path.join(ws, 'notes.v2.json'));
  for (const bad of ['.mcp.json', '%2E%2E/x.json', '.claude/settings.json']) assert.equal(appDataFile(ws, bad, { namespace: false }), null, bad);
  for (const bad of [...BAD, '../x.json', '/etc/x.json', 'x.txt', '', null, 7]) assert.equal(appDataFile(ws, bad), null, JSON.stringify(bad));
});

// ADR 0014: an app's own markdown (Tasks' tasks.md). Only under data/<slug>/, only a plain ASCII name
// (no '~' short name, colon stream or device on Windows), and never a file an agent CLI loads as
// instructions — Claude Code loads a CLAUDE.md from any folder the agent reads in. Judged decoded.
test('appDataFile takes an app\'s own .md, and never an agent instruction file', () => {
  const ws = L.root;
  for (const ok of ['data/tasks/tasks.md', 'data/tasks/sub/list.md']) assert.equal(appDataFile(ws, ok), path.join(ws, ok), ok);
  for (const bad of ['tasks.md', 'CLAUDE.md', 'memory/a/b.md', 'data/tasks.md', 'data/tasks/CLAUDE.md', 'data/tasks/claude.md',
    'data/tasks/Agents.md', 'data/tasks/sub/CLAUDE.local.md', 'data/tasks/agents.override.md', 'data/tasks/GEMINI.md',
    'data/tasks/%43LAUDE.md', 'data/tasks/CLAUDE~1.md', 'data/tasks/CLAUDE.md:x.md', 'data/tasks/a b.md', 'data/tasks/con.md',
    'data/tasks/.claude/x.md', 'data/tasks/x.MD', 'data/tasks/x.md.txt']) assert.equal(appDataFile(ws, bad), null, bad);
  assert.equal(appDataFile(ws, 'notes.md', { namespace: false }), null, 'markdown only inside an app\'s own data');
});

// ── R13 round 2 on the fix (2026-10-13) ─────────────────────────────────────────────────────────
// The broker namespaced app data only when the frame URL carried a slug, and passed a BARE path when
// it did not — the frame is about:blank after the user leaves an app, and a browser that still
// delivers the old app's message (a pagehide flush) then wrote at the workspace root (reproduced
// with an empty slug: the owner's profile.json replaced). Now it refuses. CONTROL: the 'notes' frame
// above saves normally through the same loader.
test('with no app slug in the frame, the broker refuses app data instead of using a bare path', async () => {
  const ws = path.join(L.root, 'workspace');
  const was = fs.readFileSync(path.join(ws, 'profile.json'), 'utf8');
  const B = loadShellBroker(`http://127.0.0.1:${L.port}`, { token: OWNER_TOKEN, app: '' });
  await B.post({ id: 'w', kind: 'save-data', path: 'profile.json', data: '{"systemPrompts":{"global":"PLANTED"}}' });
  assert.equal(B.reply('w').ok, false, B.said('w'));
  await B.post({ id: 'r', kind: 'data', path: 'profile.json' });
  assert.equal(B.reply('r').ok, false, B.said('r'));
  assert.equal(fs.readFileSync(path.join(ws, 'profile.json'), 'utf8'), was, 'the owner\'s profile.json is unchanged');
});

// restore-data read <path>.bak through a symlink (only the named file was judged).
test('restore-data refuses a backup that is a symlink', async () => {
  const dir = path.join(KID, 'data', 'notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(L.root, 'workspace', 'profile.json'), path.join(dir, 'leak.json.bak'));
  try {
    const r = await post('/api/restore-data', { path: 'data/notes/leak.json' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'bad_path');
    assert.ok(!fs.existsSync(path.join(dir, 'leak.json')), 'nothing was copied into place');
  } finally { fs.rmSync(path.join(dir, 'leak.json.bak')); }
});

// The note index (<ws>/search/<slug>.json, lib/note-search.mjs) is a workspace write too: a link at
// <ws>/search would carry the plain typed text of every page wherever it points (R13 on note search p1).
test('note search never writes its index through a link at <ws>/search', async () => {
  const victim = fs.mkdtempSync(path.join(L.root, 'victim-'));
  const link = path.join(KID, INDEX_DIR);
  const secret = path.join(KID, 'data', 'notes', 'secret.json');
  fs.mkdirSync(path.dirname(secret), { recursive: true });
  fs.writeFileSync(secret, JSON.stringify({ pages: [{ pageHtml: '<p>secret journal text #tag</p>', strokes: [], images: [] }] }));
  fs.rmSync(link, { recursive: true, force: true });   // an earlier save's hook may have made the real folder
  fs.symlinkSync(victim, link, 'junction');
  try {
    const r = await api(L.port, '/api/note-search?app=notes&q=secret', { headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
    assert.equal(r.status, 500);
    assert.equal((await r.json()).code, 'search_failed');
    assert.deepEqual(fs.readdirSync(victim), [], 'nothing landed where the link points');
    const audit = fs.readFileSync(path.join(L.root, 'audit.log'), 'utf8');
    assert.match(audit, /note-search-failed.*index_path_refused/, 'the refusal is audited with its code');
  } finally { fs.rmSync(link); fs.rmSync(secret); }
});

// R13 round 2 #8 on note search: the scan read THROUGH a link at data/<slug> — a member's
// `ln -s ../workspace/data/notes data/notes` indexed the owner's journal into the member's workspace.
test('note search never scans through a link at data/<slug>', async () => {
  const victim = fs.mkdtempSync(path.join(L.root, 'victim-'));
  fs.writeFileSync(path.join(victim, 'owner.json'), JSON.stringify({ pages: [{ pageHtml: '<p>secret owner text</p>', strokes: [], images: [] }] }));
  const link = path.join(KID, 'data', 'leak');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(victim, link, 'junction');
  try {
    const r = await api(L.port, '/api/note-search?app=leak&q=secret', { headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
    assert.equal(r.status, 500);
    assert.equal((await r.json()).code, 'search_failed');
    assert.ok(!fs.existsSync(path.join(KID, INDEX_DIR, 'leak.json')), 'no index was written for the linked app');
    const audit = fs.readFileSync(path.join(L.root, 'audit.log'), 'utf8');
    assert.match(audit, /note-search-failed.*data_path_refused/, 'the refusal is audited with its code');
  } finally { fs.rmSync(link); }
});

// writeFileAtomic opened its tmp name with 'w', which follows a symlink planted at that (predictable)
// name. Now 'wx': a stale or planted entry is removed, never written through.
test('an atomic write never writes through a link planted at its tmp name', () => {
  const dir = fs.mkdtempSync(path.join(L.root, 'aw-'));
  const victim = path.join(dir, 'victim.json');
  fs.writeFileSync(victim, 'SAFE');
  const f = path.join(dir, 'f.json');
  const planted = Array.from({ length: 50 }, (_, i) => `${f}.${process.pid}.${i + 1}.tmp`);
  for (const t of planted) fs.symlinkSync(victim, t);
  writeFileAtomic(f, 'NEW');
  assert.equal(fs.readFileSync(f, 'utf8'), 'NEW', 'CONTROL: the write itself happened');
  assert.ok(planted.some((t) => { try { fs.lstatSync(t); return false; } catch { return true; /* gone: the write removed it */ } }), 'CONTROL: the write met a planted link (writeSeq was in range)');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'SAFE', 'the link\'s target is untouched');
  assert.ok(!fs.lstatSync(f).isSymbolicLink(), 'the file is a file');
});

// ── R13 round 3 on the fix ──────────────────────────────────────────────────────────────────────
// The broker's namespace literal is lib/appdata.mjs APP_DATA_DIR (R3: the precedent is
// APP_ORIGIN_HEADER, pinned by test/app-agent-confinement.test.mjs).
test('the broker namespaces app data under APP_DATA_DIR, the same root the server requires', () => {
  assert.ok(readShell(ROOT).includes(`const appData=(pp)=>'${APP_DATA_DIR}/'+appSlug+'/'+pp;`));
});

// saveJob wrote <id>.json.tmp with a plain writeFileSync, through a link planted there. It now goes
// through writeFileAtomic. CONTROL: the job is saved.
test('a job save never writes through a link at its old tmp name', () => {
  const dir = fs.mkdtempSync(path.join(L.root, 'jobs-'));
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'SAFE');
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  fs.symlinkSync(victim, `${jobPath(dir, 'pollen')}.tmp`);
  saveJob(dir, { id: 'pollen', title: 'Pollen', schedule: { time: '06:30' }, plan: { kind: 'tool', tool: 'pollen' } });
  assert.equal(JSON.parse(fs.readFileSync(jobPath(dir, 'pollen'), 'utf8')).title, 'Pollen', 'CONTROL: saved');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'SAFE', 'the link\'s target is untouched');
  assert.ok(!fs.lstatSync(jobPath(dir, 'pollen')).isSymbolicLink(), 'the job file is a file');
});
