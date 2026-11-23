// Create / edit / delete a job over HTTP, against a real server — the half that makes the
// store usable from the web UI instead of by hand-editing JSON.
//
// The rules pinned here: a built-in is CODE and is never writable; a new job is created
// PAUSED so it cannot message anyone before a person has seen it; and a rejection carries the
// server's own sentence, because a job editor that fails without saying why is unusable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let port, root, web;
const MEMBER_TOKEN = 'test-member-token-0123456789abcd';
before(async () => {
  port = await freePort();
  // A second household member: a built-in's off switch is per person, so one person turning it
  // off must not turn it off for the other.
  root = mkWebRoot({ port, extraConfig: { users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-kid' },
  ] } });
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });

const J = (p, opt) => api(port, p, opt);
const asKid = (p, opt = {}) => api(port, p, { ...opt, headers: { authorization: `Bearer ${MEMBER_TOKEN}`, ...(opt.headers || {}) } });
const post = (p, body, method = 'POST') => J(p, { method, body: JSON.stringify(body) });
const GOOD = { id: 'pollen-alert', title: '花粉预警 · Pollen Alert', schedule: { time: '06:30' },
  plan: { kind: 'tool', tool: 'pollen', args: { zip: '12345', threshold: 'medium-high' } } };

test('the tool catalogue is offered, and says which tools can actually RUN', async () => {
  const t = await (await J('/api/jobs/tools')).json();
  assert.ok(t.tools.pollen, 'pollen is catalogued');
  assert.ok(Array.isArray(t.runnable) && t.runnable.includes('pollen'), 'and is runnable');
  assert.ok(t.runnable.length < Object.keys(t.tools).length,
    'declared-but-not-yet-runnable tools exist and must be distinguishable — offering one would create a job that can never do anything');
  for (const m of Object.values(t.tools)) assert.ok('effects' in m, 'every manifest declares effects; read-only is what allows unattended running');
  assert.equal(JSON.stringify(t).includes('key'), JSON.stringify(t).includes('_key'), 'no secret VALUES in the catalogue');
});

test('a NEW job is created paused, with a reason', async () => {
  const r = await (await post('/api/jobs', GOOD)).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.job.enabled, false, 'never armed on creation');
  assert.match(r.job.pausedReason, /review/i, 'and it says why, so it is not mistaken for broken');
  assert.equal(r.job.deliver, 'own-message', 'a job sends its own message by default');
  const files = await (await J('/api/jobs/files')).json();
  assert.ok(files.jobs['pollen-alert'], 'and it is now an editable record');
  assert.ok(!files.jobs['health-brief'], 'built-ins are NOT listed as editable — the write routes refuse them');
});

test('the job appears in the view with no restart, and reads as paused', async () => {
  const rows = await (await J('/api/jobs')).json();
  const row = rows.find((r) => r.name === 'pollen-alert');
  assert.ok(row, 'a job created a moment ago is already in the view');
  assert.equal(row.paused, true);
  assert.equal(row.nextDue, null, 'a paused job must not advertise a next run');
  assert.equal(row.editable, true);
  assert.equal(rows.find((r) => r.name === 'health-brief').editable, false, 'built-ins are not editable');
});

test('a built-in cannot be overwritten, re-titled or deleted — but it CAN be switched off', async () => {
  assert.equal((await post('/api/jobs', { ...GOOD, id: 'health-brief' })).status, 409);
  assert.equal((await J('/api/jobs/health-brief', { method: 'DELETE' })).status, 403, 'there is no file to delete');
  // Its title, prompt and schedule are code and stay code…
  assert.equal((await post('/api/jobs/health-brief', { title: 'mine now' }, 'PATCH')).status, 403);
  assert.equal((await post('/api/jobs/health-brief', { enabled: false, title: 'mine now' }, 'PATCH')).status, 403,
    'a real field smuggled in beside enabled is still a rejection');
  assert.equal((await post('/api/jobs/health-brief', { enabled: 'no' }, 'PATCH')).status, 403, 'and enabled is a boolean');
  const rows = await (await J('/api/jobs')).json();
  const row = rows.find((r) => r.name === 'health-brief');
  assert.ok(row, '健康简报 is still there and untouched');
  assert.equal(row.label, '健康简报 · Weekly Health Brief', 'with its title unchanged');
});

test('turning a built-in off is the ONE thing a user can say about it, and it sticks', async () => {
  // A built-in briefing (then 每日一报, since removed) arrived every morning with no way to stop
  // it: no Edit button, and PATCH/DELETE both answered 403. "I don't want this briefing" was
  // unsayable, which is the bug this closes. Pinned on the remaining built-in, 健康简报.
  assert.equal((await post('/api/jobs/health-brief', { enabled: false }, 'PATCH')).status, 200);
  const off = (await (await J('/api/jobs')).json()).find((r) => r.name === 'health-brief');
  assert.equal(off.paused, true, 'the row reads paused');
  assert.equal(off.nextDue, null, 'and offers no next run — a paused job must not advertise a time it will not keep');
  assert.match(off.pausedReason, /turned off here/, 'and says the user did it, so it never reads as a fault');
  // Written as a per-user override beside job-runs.json, NOT into the jobs/ directory, where
  // every .json is scanned as a job file.
  const prefs = JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'job-prefs.json'), 'utf8'));
  assert.deepEqual(prefs['health-brief'], { enabled: false });
  assert.ok(!fs.existsSync(path.join(root, 'workspace', 'jobs', 'health-brief.json')), 'no shadow file was invented');
  // Run now still works — switching off the schedule is not the same as disowning the job.
  assert.equal((await J('/api/jobs/health-brief/run', { method: 'POST' })).status, 200);
  // …and back on again, which must leave NO leftover key: the file is a list of deliberate
  // exceptions, not a copy of the defaults that can drift away from them.
  assert.equal((await post('/api/jobs/health-brief', { enabled: true }, 'PATCH')).status, 200);
  const on = (await (await J('/api/jobs')).json()).find((r) => r.name === 'health-brief');
  assert.equal(on.paused, false, 'it is back');
  assert.ok(on.nextDue, 'with a next run again');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'job-prefs.json'), 'utf8'))['health-brief'], undefined);
});

test('one person switching a built-in off does not switch it off for the household', async () => {
  // The JOBS literal is module-level and shared by every user. Writing `enabled` onto it — the
  // obvious implementation — would turn one person's briefing off for everyone in the house.
  // (This used to compare against the OTHER built-in, 每日一报. With one built-in left, the
  // household half is checked directly: a second member's row.)
  await post('/api/jobs/health-brief', { enabled: false }, 'PATCH');
  const rows = await (await J('/api/jobs')).json();
  assert.equal(rows.find((r) => r.name === 'health-brief').paused, true, 'this user turned it off');
  const kidRows = await (await asKid('/api/jobs')).json();
  assert.equal(kidRows.find((r) => r.name === 'health-brief').paused, false,
    'and the other member still has it — the override is per person, not a blanket');
  assert.ok(!fs.existsSync(path.join(root, 'workspace-kid', 'job-prefs.json')), 'nothing was written for them');
  await post('/api/jobs/health-brief', { enabled: true }, 'PATCH');
});

test('a rejection carries the reason — the editor shows the SERVER\'s sentence', async () => {
  for (const [patch, re] of [[{ schedule: { time: '25:00' } }, /HH:MM/], [{ title: '' }, /title is required/],
    [{ plan: { kind: 'magic' } }, /plan\.kind/], [{ deliver: 'pigeon' }, /deliver must be one of/]]) {
    const r = await post('/api/jobs/pollen-alert', patch, 'PATCH');
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, re);
  }
  assert.equal((await post('/api/jobs/nope', { title: 'x' }, 'PATCH')).status, 404, 'an unknown job is 404, not a silent create');
});

test('a patch MERGES — editing the time does not wipe the plan', async () => {
  const r = await (await post('/api/jobs/pollen-alert', { schedule: { time: '07:15' }, enabled: true }, 'PATCH')).json();
  assert.equal(r.job.schedule.time, '07:15');
  assert.equal(r.job.enabled, true);
  assert.deepEqual(r.job.plan.args, GOOD.plan.args, 'untouched fields survive');
  assert.equal(r.job.id, 'pollen-alert', 'the id is never patchable');
  const again = await (await post('/api/jobs/pollen-alert', { id: 'renamed' }, 'PATCH')).json();
  assert.equal(again.job.id, 'pollen-alert', 'attempting to rename via patch does not fork the file');
});

test('delete removes it from every surface at once', async () => {
  assert.equal((await J('/api/jobs/pollen-alert', { method: 'DELETE' })).status, 200);
  assert.ok(!(await (await J('/api/jobs/files')).json()).jobs['pollen-alert']);
  assert.ok(!(await (await J('/api/jobs')).json()).find((r) => r.name === 'pollen-alert'));
  assert.equal((await J('/api/jobs/pollen-alert', { method: 'DELETE' })).status, 404, 'deleting twice is a 404, not a crash');
});

test('the editor is in the shell, and only offers tools that can run', () => {
  const SHELL = readShell(ROOT);
  for (const n of ['id="jobNew"', 'id="jobEdit"', 'function openJobEditor', 'data-editjob', '/api/jobs/files']) {
    assert.ok(SHELL.includes(n), `the shell must carry ${n}`);
  }
  assert.match(SHELL, /t\.runnable\.map/, 'the tool list comes from runnable, not from every manifest');
  // A failed catalogue answers {error} with a 200 body; without normalising, .runnable is
  // undefined and the editor threw on .map — a button that did nothing and said nothing.
  assert.match(SHELL, /Array\.isArray\(raw\.runnable\)/, 'the catalogue reply must be shape-checked');
  assert.match(SHELL, /if\(!t\.runnable\.length\)/, 'no runnable tools must render a sentence, not an unusable form');
});

test('Run now RETURNS the result — "ran ok" with nothing to look at is not an answer', async () => {
  // A manual run is a person asking right now: pressing Run now and getting only a tick, with
  // the output somewhere else, is not an answer.
  //
  // Uses the BUILT-IN 健康简报: a MANUAL run on an empty health store always produces its fixed
  // "no data yet" body, with no network and no model call. (It used the daily brief until that
  // was removed.) A job whose tool decides there is nothing to say would exercise the skipped
  // branch instead, and then this assertion would silently never run.
  const r = await (await J('/api/jobs/health-brief/run', { method: 'POST' })).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.skipped, undefined, 'precondition: a manual weekly brief on no data still has something to say');
  assert.ok(typeof r.body === 'string' && r.body.trim(), 'the result comes back with its text');
  assert.match(r.body, /No health data received yet/, 'and it is the real brief, not a placeholder');
  assert.ok(!('folded' in r), 'the reply no longer carries the removed fold flag');
  assert.ok('truncated' in r, 'the caller is told whether it was shortened');
  assert.ok(r.briefing, 'and the full briefing is in the feed as well');
});

test('a legacy fold-daily job FILE still loads — as own-message, with its file untouched', async () => {
  // Written before the daily brief was removed (2026-10-11): the server must keep running it,
  // and must not rewrite the owner's data just by reading it.
  const dir = path.join(root, 'workspace', 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'legacy-fold.json');
  const bytes = JSON.stringify({ ...GOOD, id: 'legacy-fold', deliver: 'fold-daily', enabled: false }, null, 2);
  fs.writeFileSync(file, bytes);
  const files = await (await J('/api/jobs/files')).json();
  assert.ok(files.jobs['legacy-fold'], 'not skipped as a bad file');
  assert.equal(files.jobs['legacy-fold'].deliver, 'own-message', 'served normalised');
  assert.ok((await (await J('/api/jobs')).json()).find((r) => r.name === 'legacy-fold'), 'and listed in the Jobs view');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the file on disk is byte-for-byte unchanged');
  fs.unlinkSync(file);
});

test('the Run-now body is capped — a status reply is not a document channel', () => {
  const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(WEB, /const RUN_BODY_MAX = \d+/, 'the cap is a named constant');
  assert.match(WEB, /slice\(0, RUN_BODY_MAX\)/);
  // Pressing Run now is a deliberate act: the person wants the result, in the app and by email.
  assert.match(WEB, /if \(out\.briefing\) \{\s*\n\s*pushBriefing\(user, out\.briefing\);/,
    'a manual run always pushes, whatever deliver says');
});

test('the Settings UI actually displays it', () => {
  const SHELL = readShell(ROOT);
  assert.ok(SHELL.includes('id="jobRunOut"'), 'there is somewhere to show it');
  assert.match(SHELL, /j&&j\.ok&&j\.body/, 'and the reply body is read');
  assert.match(SHELL, /今日无需报告 · Nothing to report today/, 'a silent run says so, rather than looking broken');
});

// ── Per-job model（每个任务指定模型）──────────────────────────────────────────────────────
// Hermes pins a model per job so "a global model change never stops a scheduled job". Same
// idea here, with one addition: a model pinned on a tool that never calls one is REFUSED
// rather than ignored, because a setting that silently does nothing is the failure mode this
// engine guards hardest against.
test('a job may pin a model — and a global change then cannot alter it', async () => {
  const models = await (await J('/api/models')).json();
  const lane = models.find((m) => m.id === 'kimi') || models[0];
  const r = await (await post('/api/jobs', { id: 'news-pinned', title: 'News',
    schedule: { time: '07:00' }, plan: { kind: 'tool', tool: 'research', args: { question: 'x' } },
    model: lane.id })).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.job.model, lane.id, 'the pin is stored on the job');

  // Editing something else must not drop it.
  const p = await (await post('/api/jobs/news-pinned', { schedule: { time: '08:00' } }, 'PATCH')).json();
  assert.equal(p.job.model, lane.id, 'a patch must not silently unpin the model');

  // …and a patch is cross-checked too. Validating only on create would let an edit smuggle in
  // a model that does not exist, which then fails at 07:00 with nobody watching.
  const bad = await post('/api/jobs/news-pinned', { model: 'no-such-model' }, 'PATCH');
  assert.equal(bad.status, 400, 'a bad model must be refused on PATCH, not only on POST');
  assert.match((await bad.json()).error, /unknown model/);
  assert.equal((await (await J('/api/jobs/files')).json()).jobs['news-pinned'].model, lane.id,
    'and the refused patch changed nothing');
  await J('/api/jobs/news-pinned', { method: 'DELETE' });
});

test('an unknown model, or one on a tool that uses none, is REFUSED not ignored', async () => {
  const bad = await post('/api/jobs', { id: 'news-bad', title: 'News', schedule: { time: '07:00' },
    plan: { kind: 'tool', tool: 'research', args: { question: 'x' } }, model: 'no-such-model' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /unknown model/, 'and it lists what IS available');

  const inert = await post('/api/jobs', { id: 'pollen-bad', title: 'Pollen', schedule: { time: '07:00' },
    plan: { kind: 'tool', tool: 'pollen', args: { zip: '12345' } }, model: 'kimi' });
  assert.equal(inert.status, 400);
  assert.match((await inert.json()).error, /does not use a model/,
    'a pin that could never take effect must not be accepted');
});

test('no model is the normal case — blank means the tool\'s own lane', async () => {
  const r = await (await post('/api/jobs', { ...GOOD, id: 'no-model' })).json();
  assert.equal(r.ok, true);
  assert.equal(r.job.model, '', 'absent, not null or undefined — one shape on disk');
  await J('/api/jobs/no-model', { method: 'DELETE' });
});

test('the editor offers the picker ONLY where it applies', () => {
  const SHELL = readShell(ROOT);
  assert.match(SHELL, /id="jeModelRow"/);
  assert.match(SHELL, /if\(!man\.usesModel\)\{ row\.style\.display='none'/,
    'a deterministic tool must not show a model picker');
  assert.match(SHELL, /\$\('#jeTool'\)\.onchange=syncModelRow/, 'and it follows the tool selection');
});
