// The job store, and the rule it exists for: creating or changing a job must NEVER require a
// server restart. Offline by construction — no scheduler, no tools, no network.
//
// The failure this file guards hardest: a job that quietly stops running. A bad file must be
// skipped AND reported, a paused job must have no turn, and an unknown tool must throw rather
// than resolve to silence — because "did nothing" and "nothing to say" look identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateJob, loadJobs, saveJob, deleteJob, jobsDir, DELIVER, MAX_JOBS } from '../lib/jobs/store.mjs';
import { makeRunner, attachRunner } from '../lib/jobs/run.mjs';
import { jobsOf, entriesOf } from '../lib/jobruns.mjs';
import { jobsView } from '../lib/jobstatus.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-jobs-'));
const GOOD = { id: 'pollen-alert', title: '花粉预警 · Pollen Alert', schedule: { time: '06:30' },
  plan: { kind: 'tool', tool: 'pollen', args: { zip: '12345', threshold: 'medium-high' } } };

test('a valid job round-trips through disk unchanged', () => {
  const dir = tmp();
  const saved = saveJob(dir, GOOD);
  assert.equal(saved.name, 'pollen-alert', 'name is what the scheduler keys on');
  assert.equal(saved.enabled, true, 'enabled defaults on');
  assert.equal(saved.deliver, 'own-message', 'a job sends its own message by default (the daily-brief fold is gone)');
  const { jobs, bad } = loadJobs(dir);
  assert.deepEqual(bad, []);
  assert.deepEqual(jobs['pollen-alert'].plan, GOOD.plan);
  assert.equal(jobs['pollen-alert'].schedule.time, '06:30');
  const onDisk = JSON.parse(fs.readFileSync(path.join(jobsDir(dir), 'pollen-alert.json'), 'utf8'));
  assert.ok(!('name' in onDisk) && !('source' in onDisk), 'derived fields are not stored');
});

test('every rejection NAMES the field — these files are hand-edited', () => {
  for (const [why, j, re] of [
    ['no title', { ...GOOD, title: '' }, /title is required/],
    ['bad time', { ...GOOD, schedule: { time: '6:3' } }, /schedule\.time must be HH:MM/],
    ['bad day', { ...GOOD, schedule: { time: '06:30', day: 9 } }, /schedule\.day must be 0-6/],
    ['no schedule', { ...GOOD, schedule: undefined }, /schedule is required/],
    ['no plan', { ...GOOD, plan: undefined }, /plan is required/],
    ['unknown plan kind', { ...GOOD, plan: { kind: 'magic' } }, /plan\.kind must be one of/],
    ['bad tool name', { ...GOOD, plan: { kind: 'tool', tool: 'Not A Slug' } }, /plan\.tool must be a slug/],
    ['bad deliver', { ...GOOD, deliver: 'carrier-pigeon' }, /deliver must be one of/],
    ['bad enabled', { ...GOOD, enabled: 'yes' }, /enabled must be true or false/],
    ['bad id', { ...GOOD, id: 'Not A Slug' }, /id must be a slug/],
    ['not an object', [GOOD], /not a JSON object/],
  ]) {
    const v = validateJob(j);
    assert.equal(v.ok, false, why);
    assert.match(v.error, re, why);
  }
  assert.match(validateJob({ ...GOOD, id: 'a' }, { id: 'b' }).error, /does not match its filename/);
});

test('ONE bad file never stops the others — it is skipped AND reported', () => {
  const dir = tmp();
  saveJob(dir, GOOD);
  saveJob(dir, { ...GOOD, id: 'second', title: 'Second' });
  fs.writeFileSync(path.join(jobsDir(dir), 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(jobsDir(dir), 'invalid.json'), JSON.stringify({ id: 'invalid', title: 'x' }));
  const seen = [];
  const { jobs, bad } = loadJobs(dir, { onBad: (id, error) => seen.push(id) });
  assert.deepEqual(Object.keys(jobs).sort(), ['pollen-alert', 'second'], 'the good jobs still load');
  assert.deepEqual(bad.map((b) => b.id).sort(), ['broken', 'invalid']);
  assert.deepEqual(seen.sort(), ['broken', 'invalid'], 'and the caller is TOLD, so it can surface them');
  assert.match(bad.find((b) => b.id === 'invalid').error, /schedule is required/, 'the reason is specific');
});

test('a missing jobs/ directory is empty, not an error', () => {
  const { jobs, bad } = loadJobs(tmp());
  assert.deepEqual(jobs, {}); assert.deepEqual(bad, []);
});

test('delete is idempotent and refuses a traversal', () => {
  const dir = tmp();
  saveJob(dir, GOOD);
  assert.equal(deleteJob(dir, 'pollen-alert'), true);
  assert.equal(deleteJob(dir, 'pollen-alert'), false, 'deleting twice is not an error');
  assert.throws(() => deleteJob(dir, '../../etc/passwd'), /invalid job id/);
  assert.throws(() => deleteJob(dir, 'a/b'), /invalid job id/);
});

test('HOT RELOAD: a job file appearing on disk is picked up with no restart', () => {
  const dir = tmp();
  const BUILT_IN = { 'daily-brief': { name: 'daily-brief', title: '每日一报', schedule: { time: '07:30' }, run: async () => ({ body: 'x' }) } };
  const runner = makeRunner({ pollen: { run: async () => ({ level: 'high' }), brief: () => ({ body: 'alert' }) } });
  const resolve = (user) => {
    const out = { ...BUILT_IN };
    for (const [n, j] of Object.entries(loadJobs(user.workspace).jobs)) if (!out[n]) out[n] = attachRunner(j, runner);
    return out;
  };
  const user = { id: 'owner', workspace: dir };

  assert.deepEqual(Object.keys(resolve(user)), ['daily-brief'], 'before: built-in only');
  saveJob(dir, GOOD);                                   // the whole point: no restart between these two lines
  assert.deepEqual(Object.keys(resolve(user)).sort(), ['daily-brief', 'pollen-alert'], 'after: picked up immediately');
  deleteJob(dir, 'pollen-alert');
  assert.deepEqual(Object.keys(resolve(user)), ['daily-brief'], 'and removal takes effect immediately too');
});

test('a built-in always wins a name collision — a file cannot shadow 每日一报', () => {
  const dir = tmp();
  saveJob(dir, { ...GOOD, id: 'daily-brief', title: 'Impostor' });
  const BUILT_IN = { 'daily-brief': { name: 'daily-brief', title: '每日一报', schedule: { time: '07:30' }, run: async () => ({ body: 'real' }) } };
  const out = { ...BUILT_IN };
  for (const [n, j] of Object.entries(loadJobs(dir).jobs)) if (!out[n]) out[n] = j;
  assert.equal(out['daily-brief'].title, '每日一报', 'the built-in survives');
});

test('jobsOf accepts a static map OR a per-user resolver', () => {
  const map = { a: { name: 'a' } };
  assert.equal(jobsOf(map, { id: 'u' }), map, 'a plain map still works — built-ins keep running');
  assert.deepEqual(jobsOf((u) => ({ [u.id]: { name: u.id } }), { id: 'zoe' }), { zoe: { name: 'zoe' } });
});

test('a PAUSED job gets no turn — and pausing is how a new job is armed safely', async () => {
  // entriesOf is the scheduler's gate: only what it returns can ever be due. A paused job
  // must not appear, or "create it paused for review" is not a safety mechanism at all.
  const on = { name: 'a', schedule: { time: '06:30' }, enabled: true };
  const off = { name: 'b', schedule: { time: '06:30' }, enabled: false };
  const builtin = { name: 'c', schedule: { time: '07:30' } };            // no `enabled` field
  const noSched = { name: 'd', enabled: true };                          // nothing to fire on
  const got = entriesOf({ a: on, b: off, c: builtin, d: noSched }).map((e) => e.name).sort();
  assert.deepEqual(got, ['a', 'c'], 'paused excluded; a built-in with no enabled field stays on');
  assert.deepEqual(entriesOf({ b: off }), [], 'a lone paused job leaves nothing due');
  // and the schedule shape survives, or dueJobs cannot match it
  assert.deepEqual(entriesOf({ a: on })[0], { name: 'a', time: '06:30' });
});

test('the runner: silence, failure and success are three DIFFERENT outcomes', async () => {
  const job = { name: 'j', plan: { kind: 'tool', tool: 't', args: {} } };
  const quiet = makeRunner({ t: { run: async () => ({}), brief: () => null } });
  assert.equal(await quiet({}, job), null, 'null = nothing to say today');

  const ok = makeRunner({ t: { run: async () => ({}), brief: () => ({ body: 'something' }) } });
  assert.deepEqual(await ok({}, job), { body: 'something' });

  // An unknown tool must THROW. Returning null would make a broken job look like a quiet one.
  await assert.rejects(() => makeRunner({})({}, job), /unknown tool "t"/);
  await assert.rejects(() => makeRunner({})({}, { name: 'j', plan: { kind: 'magic' } }), /unsupported plan kind/);
  // R14: an empty body is a failure, never a stored briefing.
  const empty = makeRunner({ t: { run: async () => ({}), brief: () => ({ body: '  ' }) } });
  await assert.rejects(() => empty({}, job), /empty briefing/);
});

test('bounds are real', () => {
  assert.ok(MAX_JOBS >= 20 && MAX_JOBS <= 200, `a sane cap, got ${MAX_JOBS}`);
  assert.deepEqual(DELIVER, ['own-message', 'feed-only'], 'fold-daily is no longer an option, only a legacy alias');
  const dir = tmp();
  for (let i = 0; i < MAX_JOBS + 5; i++) saveJob(dir, { ...GOOD, id: `j${String(i).padStart(3, '0')}` });
  assert.equal(Object.keys(loadJobs(dir).jobs).length, MAX_JOBS, 'the cap is enforced on read');
});

test('the view never promises a run the scheduler will not make', () => {
  // A paused job showed a nextDue while entriesOf excluded it — the UI saying one thing and
  // the engine doing another is exactly how a "broken" job gets reported that was only paused.
  const jobs = {
    on: { name: 'on', title: 'On', schedule: { time: '06:30' }, enabled: true, source: 'file' },
    off: { name: 'off', title: 'Off', schedule: { time: '06:30' }, enabled: false, pausedReason: 'Awaiting review', source: 'file' },
    builtin: { name: 'builtin', title: 'Built in', schedule: { time: '07:30' } },
  };
  const rows = Object.fromEntries(jobsView({ jobs, now: new Date(2026, 8, 9, 5, 0) }).map((r) => [r.name, r]));
  assert.ok(rows.on.nextDue, 'an enabled job has a next run');
  assert.equal(rows.off.nextDue, null, 'a PAUSED job has none');
  assert.equal(rows.off.paused, true);
  assert.equal(rows.off.pausedReason, 'Awaiting review', 'and says why, so it is not mistaken for broken');
  assert.equal(rows.builtin.paused, false, 'a built-in with no enabled field is not paused');
  assert.equal(rows.on.editable, true, 'file jobs are editable');
  assert.equal(rows.builtin.editable, false, 'built-ins are code, not editable in the UI');
});

// ── Legacy 'fold-daily' (the daily brief was removed 2026-10-11, docs/adr/0004) ───────────
// Job files written before the removal say deliver:'fold-daily' — it was the default, so every
// chat-created job carries it. They must keep running, as their own message, and reading them
// must never rewrite the owner's data.
test('a legacy fold-daily job FILE loads as own-message, and the file is not rewritten', () => {
  const dir = tmp();
  fs.mkdirSync(jobsDir(dir), { recursive: true });
  const file = path.join(jobsDir(dir), 'pollen-alert.json');
  const bytes = JSON.stringify({ ...GOOD, deliver: 'fold-daily', created: 1, updated: 2 }, null, 2);
  fs.writeFileSync(file, bytes);
  const before = fs.statSync(file).mtimeMs;
  const { jobs, bad } = loadJobs(dir);
  assert.deepEqual(bad, [], 'a legacy file is NOT a bad file — it must keep running');
  assert.equal(jobs['pollen-alert'].deliver, 'own-message', 'normalised on read');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the bytes on disk are untouched');
  assert.equal(fs.statSync(file).mtimeMs, before, 'and the file was not even rewritten');
});

test('fold-daily is accepted on every validate path, never rejected — an old client still saves', () => {
  const v = validateJob({ ...GOOD, deliver: 'fold-daily' });
  assert.equal(v.ok, true, v.error);
  assert.equal(v.job.deliver, 'own-message');
  // A save (PATCH/POST) is the owner's own write, so it stores the normalised value.
  const dir = tmp();
  saveJob(dir, { ...GOOD, deliver: 'fold-daily' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobsDir(dir), 'pollen-alert.json'), 'utf8')).deliver, 'own-message');
  assert.match(validateJob({ ...GOOD, deliver: 'pigeon' }).error, /deliver must be one of own-message, feed-only/,
    'an unknown value is still refused, and the error does not advertise the legacy alias');
});
