// The model-check job through the REAL scheduler core (lib/jobruns.mjs jobsTick), not Run now:
// the end-to-end file marks the job done for the day so the server's own tick stays out of it.
// What is pinned here: the schedule getter is read at every tick (a config reload moves the job),
// and of two owners and a member, exactly one person — the node owner — runs it.
// The JOBS literal lives in web.mjs, which starts a server on import, so the entry is built here in
// the same shape: ownerOnly, a `get schedule()` over a mutable config. Everything else is shipped code.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobsTick } from '../lib/jobruns.mjs';
import { applyJobPrefs, builtinsFor } from '../lib/jobs/prefs.mjs';
import { nodeOwnerId } from '../lib/owner.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-tick-'));
const users = [
  { id: 'kid', role: 'member', status: 'active', workspace: ws() },
  { id: 'owner', role: 'owner', status: 'active', workspace: ws() },
  { id: 'owner2', role: 'owner', status: 'active', workspace: ws() },
];
const cfg = { model_check_time: '06:00' };
const JOBS = { 'model-check': { name: 'model-check', ownerOnly: true, get schedule() { return { time: cfg.model_check_time }; }, run: () => null } };
// The same resolution web.mjs jobsForUser applies, built from the shipped helpers.
const jobsFor = (u) => applyJobPrefs(builtinsFor(JOBS, u.id === nodeOwnerId(users)), {});
const at = (hh, mm) => { const d = new Date(); d.setHours(hh, mm, 0, 0); return d; };
after(() => { for (const u of users) rmTemp(u.workspace); });

test('the node owner is the first active owner, never a member, and a pending owner is skipped', () => {
  assert.equal(nodeOwnerId(users), 'owner');
  assert.equal(nodeOwnerId([{ id: 'p', role: 'owner', status: 'pending' }, ...users]), 'owner');
  assert.equal(nodeOwnerId([users[0]]), null, 'a node with no owner runs it for nobody');
});

test('a due tick runs model-check exactly once, for the node owner only', async () => {
  const ran = [];
  await jobsTick({ users, jobs: jobsFor, now: at(7, 0), audit: () => {}, runJobFor: async (u, job) => { ran.push(`${u.id}:${job.name}`); return {}; } });
  assert.deepEqual(ran, ['owner:model-check'], 'one probe set, one briefing — not one per owner, none for a member');
  // Passed through, not copied: a copy would freeze the getter at the moment it was made.
  assert.equal(builtinsFor(JOBS, true)['model-check'], JOBS['model-check']);
  assert.equal(Object.getOwnPropertyDescriptor(jobsFor(users[1])['model-check'], 'schedule').get !== undefined, true,
    'the job the tick sees still carries the live getter');
  assert.deepEqual(Object.keys(builtinsFor(JOBS, false)), [], 'and a non-owner gets no ownerOnly job');
});

test('the schedule is read at every tick: a reload to a later time makes it not due yet', async () => {
  for (const u of users) fs.rmSync(path.join(u.workspace, 'job-runs.json'), { force: true });   // a fresh day
  const ran = [];
  const tick = () => jobsTick({ users, jobs: jobsFor, now: at(7, 0), audit: () => {}, runJobFor: async (u) => { ran.push(u.id); return {}; } });
  cfg.model_check_time = '08:30';      // what reloadConfig's Object.assign(cfg, fresh) does
  await tick();
  assert.deepEqual(ran, [], 'at 07:00 a job moved to 08:30 is not due');
  cfg.model_check_time = '06:30';
  await tick();
  assert.deepEqual(ran, ['owner'], 'R14 control: the same tick runs it once the time has passed');
});
