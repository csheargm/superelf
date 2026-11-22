// End-to-end approval loop（审批闭环）over the REAL pipeline pieces web.mjs
// wires together: synthetic breaching health data → runJob(health-brief) →
// settleProposals/annotateBriefing → notifyBriefingEmail (AgentMail stubbed at
// the fetch seam with real API shapes) → the in-app queue (pendingActions, what
// the longevity app's Pending Approvals lists) → decision. Throwaway workspaces only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { notifyBriefingEmail } from '../lib/notify.mjs';
import { runJob, getBriefing, denyAction, approveAction, pendingActions } from '../lib/autonomy.mjs';
import { settleProposals, annotateBriefing, isFlagSuppressed, executeAction } from '../lib/actions.mjs';
import { healthBriefBody } from '../lib/health-analyze.mjs';
import { ingestHealth } from '../lib/health.mjs';
import { stubAgentMail, mkAudit, mkUser as mkSharedUser } from './helpers.mjs';

const NOW = new Date(2026, 7, 30, 12);
const THRESH = { steps_min_daily: 5000, sleep_min_minutes: 360, weight_delta_kg_7d: 1.5 };
const day = (n) => { const d = new Date(NOW); d.setDate(d.getDate() - n); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const mkUser = () => mkSharedUser('aloop-');

function seedBreaching(u) { // 7d steps avg 4000 < 5000; sleep present (no gap)
  for (let n = 29; n >= 0; n--) {
    const r = { date: day(n), steps: n === 0 ? 500 : 4000, weight: 70 };
    if (n % 2 === 0) r.sleepMinutes = 400;
    ingestHealth(u, r);
  }
}

// The exact per-job wiring web.mjs uses for health-brief (manual + tick paths).
const mkJob = (u) => ({ name: 'health-brief', title: '健康简报 · Weekly Health Brief', type: 'digest',
  run: () => healthBriefBody(u, { llm: async () => '- walk after dinner 饭后散步', thresholds: THRESH, now: NOW,
    manual: false, isSuppressed: (flag) => isFlagSuppressed(u, flag, NOW.getTime()) }) });

const EMAIL = 'me@example.com';
async function runBrief(u, { preapproved = [], audit, mail }) {
  const out = await runJob(u, mkJob(u), { run: mkJob(u).run, now: NOW.getTime() });
  if (!out.briefing) return out;
  const settled = await settleProposals(u, out.proposed, { preapproved, audit, now: NOW.getTime() });
  const briefing = annotateBriefing(u, out.briefing, settled);
  const sent = await notifyBriefingEmail({ mail, email: EMAIL, user: u, briefing, audit });
  return { ...out, briefing, pending: settled.pending, settled, sent };
}
const sentText = (calls) => calls.find((c) => /\/messages\/send$/.test(c.url)).data.text;

test('(a) breaching week: briefing saved and emailed; its 1 proposal waits in the in-app queue', async () => {
  const u = mkUser();
  seedBreaching(u);
  const { mail, calls } = stubAgentMail();
  const { audit } = mkAudit();
  const out = await runBrief(u, { audit, mail });
  assert.equal(out.proposed.length, 1, 'exactly one proposal from the steps flag');
  assert.match(getBriefing(u, out.briefing.id).body, /健康简报/, 'briefing persisted');
  assert.deepEqual(out.sent, { sent: true });
  assert.match(sentText(calls), /健康简报|steps/i, 'the email carries the briefing');
  assert.ok(!/待批准行动|Approve/.test(sentText(calls)), 'and no approve controls: an email cannot decide');
  const queue = pendingActions(u);
  assert.equal(queue.length, 1, 'the proposal is decided in the app');
  assert.equal(queue[0].id, out.proposed[0].id);
  assert.match(queue[0].title, /Daily walk reminder · 每日散步提醒/);
  assert.match(queue[0].summary, /why: steps 7d avg 4000 < 5000 threshold/);
});

test('(b-cooldown) denied → the NEXT brief does not re-propose the same flag', async () => {
  const u = mkUser();
  seedBreaching(u);
  const { mail } = stubAgentMail();
  const { audit } = mkAudit();
  const first = await runBrief(u, { audit, mail });
  denyAction(u, first.proposed[0].id, NOW.getTime());
  const second = await runBrief(u, { audit, mail });
  assert.equal(second.proposed.length, 0, 'cooldown honored — the denied flag is not re-asked');
  // And while a proposal is still PENDING, a re-run must not stack a duplicate.
  const u2 = mkUser();
  seedBreaching(u2);
  await runBrief(u2, { audit, mail });
  const rerun = await runBrief(u2, { audit, mail });
  assert.equal(rerun.proposed.length, 0, 'open proposal suppresses re-proposing');
  assert.equal(pendingActions(u2).length, 1);
});

test('(c-executed) approved → the NEXT brief does not re-propose the same flag (no duplicate-reminder stacking)', async () => {
  const u = mkUser();
  seedBreaching(u);
  const { mail } = stubAgentMail();
  const { audit } = mkAudit();
  const first = await runBrief(u, { audit, mail });
  await approveAction(u, first.proposed[0].id, { execute: executeAction, now: NOW.getTime() }); // week 1: user approves, reminder registers
  const second = await runBrief(u, { audit, mail }); // week 2: steps still low — but the flag just executed
  assert.equal(second.proposed.length, 0, 'executed cooldown honored — approving once must not re-ask (and re-stack) weekly');
  assert.equal(pendingActions(u).length, 0);
});

test('(d) pre-approved type executes immediately and the briefing REPORTS it（预批准执行）', async () => {
  const u = mkUser();
  seedBreaching(u);
  const { mail, calls } = stubAgentMail();
  const { events, audit } = mkAudit();
  const out = await runBrief(u, { preapproved: ['create-reminder'], audit, mail });
  assert.equal(out.pending.length, 0, 'nothing left to ask');
  assert.equal(out.settled.executed.length, 1);
  assert.equal(pendingActions(u).length, 0);
  assert.equal(fs.existsSync(path.join(u.workspace, 'reminders.json')), true, 'reminder registered');
  assert.match(getBriefing(u, out.briefing.id).body, /done（预批准执行）: Daily walk reminder/);
  assert.match(sentText(calls), /预批准执行/, 'the email reports it as done');
  assert.equal(events.find((e) => e.ev === 'action-preapproved-done').type, 'create-reminder');
});

test('(e) pre-approved executor failure: briefing shows FAILED（执行失败）, never done', async () => {
  const u = mkUser();
  const { mail, calls } = stubAgentMail();
  const { events, audit } = mkAudit();
  const job = { name: 'health-brief', title: '健康简报', type: 'digest',
    run: async () => ({ body: '# 健康简报\n\ntrends', actions: [
      { type: 'create-reminder', title: 'Broken walk reminder', summary: 'why: x', payload: { flag: 'steps_min_daily', text: 'Walk', time: 'bogus' } }] }) };
  const out = await runJob(u, job, { run: job.run, now: NOW.getTime() });
  const settled = await settleProposals(u, out.proposed, { preapproved: ['create-reminder'], audit, now: NOW.getTime() });
  const briefing = annotateBriefing(u, out.briefing, settled);
  await notifyBriefingEmail({ mail, email: EMAIL, user: u, briefing, audit });
  assert.equal(settled.failed[0].status, 'failed');
  assert.match(getBriefing(u, briefing.id).body, /FAILED（执行失败）: Broken walk reminder — .*HH:MM/);
  assert.match(sentText(calls), /执行失败/);
  assert.equal(events.find((e) => e.ev === 'action-preapproved-failed').who, 'owner');
});
