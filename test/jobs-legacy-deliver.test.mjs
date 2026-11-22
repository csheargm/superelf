process.env.TZ = 'Asia/Shanghai';   // once-per-LOCAL-day marks — pin TZ so asserts hold anywhere
// A job FILE written before the daily brief was removed (2026-10-11, docs/adr/0004) says
// deliver:'fold-daily'. Before the removal such a job SAVED its briefing but did not push it —
// it rode in the next 每日一报. With the brief gone, a job that still folded would never reach
// anyone. This is the user flow (R6): the on-disk file is read by the real store, run by the
// real tick and runner, saved by the real runJob, and pushed through the real notifier — and
// it arrives as its OWN message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJobs, jobsDir } from '../lib/jobs/store.mjs';
import { makeRunner, attachRunner } from '../lib/jobs/run.mjs';
import { jobsTick } from '../lib/jobruns.mjs';
import { runJob, listBriefings, getBriefing } from '../lib/autonomy.mjs';
import { notifyBriefingEmail } from '../lib/notify.mjs';
import { stubAgentMail } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const NOON = new Date(2026, 9, 12, 12, 0);

// The fake replaces only the network edge (the tool's data source and AgentMail's HTTP call);
// every guard in between is the shipped code.
const TOOLS = { pollen: { run: async () => ({ level: 'high' }), brief: () => ({ body: '# Pollen\n\nHigh today' }) } };

test('a legacy fold-daily job file runs on schedule and delivers its OWN message', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-deliver-'));
  const user = { id: 'owner', status: 'active', workspace: ws };
  fs.mkdirSync(jobsDir(ws), { recursive: true });
  const file = path.join(jobsDir(ws), 'pollen-alert.json');
  const bytes = JSON.stringify({ title: '花粉预警 · Pollen Alert', schedule: { time: '06:30' },
    plan: { kind: 'tool', tool: 'pollen', args: { zip: '12345' } }, deliver: 'fold-daily' }, null, 2);
  fs.writeFileSync(file, bytes);

  const { mail, calls } = stubAgentMail();
  const sent = () => calls.filter((c) => /\/messages\/send$/.test(c.url)).map((c) => c.data);
  const log = [];
  const audit = (ev, x) => log.push({ ev, ...x });
  const runner = makeRunner(TOOLS);
  const jobsFor = (u) => Object.fromEntries(Object.entries(loadJobs(u.workspace).jobs)
    .map(([k, j]) => [k, attachRunner(j, runner)]));

  await jobsTick({ users: [user], jobs: jobsFor, now: NOON, audit,
    runJobFor: async (u, job) => {
      const out = await runJob(u, job, { run: job.run, now: NOON.getTime() });
      if (out.briefing) await notifyBriefingEmail({ mail, email: 'owner@example.com', user: u, briefing: out.briefing, audit });
      return out;
    } });

  assert.ok(log.some((e) => e.ev === 'job-run' && e.job === 'pollen-alert' && e.briefing), JSON.stringify(log));
  assert.equal(sent().length, 1, 'one message, sent now — not held for a brief that no longer exists');
  assert.equal(sent()[0].to, 'owner@example.com');
  assert.match(sent()[0].text, /High today/);
  const [b] = listBriefings(user);
  assert.equal(getBriefing(user, b.id).deliver, 'own-message', 'the briefing is stamped with the normalised value');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the job file on disk was not rewritten');
});

test('web.mjs pushes EVERY saved briefing — no deliver value can hold one back', () => {
  const i = WEB.indexOf('const pushBriefing = async');
  assert.ok(i > 0, 'pushBriefing exists');
  const fn = WEB.slice(i, WEB.indexOf('\n};\n', i));
  assert.ok(!/deliver/.test(fn), 'pushBriefing reads no deliver field, so nothing is silently deferred');
  assert.match(fn, /notifyBriefingEmail\(/, 'by email');
  assert.match(WEB, /if \(out && out\.briefing\) await pushBriefing\(u, out\.briefing\);/,
    'the scheduled tick pushes every briefing it saved');
  assert.ok(!/jobs\/fold\.mjs|markFolded|FOLD_DELIVER|foldedFor/.test(WEB.replace(/\/\/.*$/gm, '')),
    'the fold machinery is gone from the server');
  assert.ok(!fs.existsSync(path.join(ROOT, 'lib', 'jobs', 'fold.mjs')), 'and so is its module');
});
