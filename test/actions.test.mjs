// Approval-loop core（审批闭环）— lib/actions.mjs: the typed registry, executor
// dispatch, pre-approval enforcement, expiry, denial cooldown, settle+annotate.
// Workspaces are throwaway mkdtemp dirs — never a live instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ACTION_TYPES, validatePreapprovedTypes, executeAction, expireStaleActions, sweepStrandedApprovals,
  deniedRecently, executedRecently, hasOpenProposal, isFlagSuppressed, settleProposals, annotateBriefing,
  PROPOSAL_TTL_DAYS, DENIED_COOLDOWN_DAYS, EXECUTED_COOLDOWN_DAYS, EXEC_LIMBO_MINUTES,
} from '../lib/actions.mjs';
import { proposeAction, loadActions, pendingActions, approveAction, denyAction, saveBriefing, getBriefing } from '../lib/autonomy.mjs';
import { loadReminders } from '../lib/reminders.mjs';
import { mkAudit, mkUser as mkSharedUser } from './helpers.mjs';

const DAY = 86400000;
const mkUser = () => mkSharedUser('actions-');

test('registry: implemented types are inward; send_email is outward-facing', () => {
  assert.equal(ACTION_TYPES['create-reminder'].outward, false);
  assert.equal(ACTION_TYPES['noop'].outward, false);
  assert.equal(ACTION_TYPES['send_email'].outward, true, 'outward flag must exist so the pre-approval ban has something real to refuse');
});

test('pre-approval config gate: unknown and outward types are REFUSED at load', () => {
  assert.deepEqual(validatePreapprovedTypes(undefined), []);
  assert.deepEqual(validatePreapprovedTypes(['noop', 'create-reminder']), ['noop', 'create-reminder']);
  assert.throws(() => validatePreapprovedTypes(['bogus-type']), /unknown action type "bogus-type"/);
  assert.throws(() => validatePreapprovedTypes(['send_email']), /outward-facing（对外行动）and can NEVER be pre-approved/);
  assert.throws(() => validatePreapprovedTypes('noop'), /must be an array/);
});

test('executeAction: unknown type fails safe; noop acknowledges; create-reminder registers', async () => {
  const u = mkUser();
  await assert.rejects(() => executeAction(u, { type: 'launch-rocket' }), /no executor registered/);
  const ack = await executeAction(u, { type: 'noop', id: 'a0' });
  assert.equal(ack.ok, true);
  const out = await executeAction(u, { type: 'create-reminder', id: 'walk-1', payload: { text: 'Walk 散步', time: '18:00' } });
  assert.match(out.note, /提醒已创建/);
  assert.equal(loadReminders(u).length, 1);
  assert.equal(loadReminders(u)[0].time, '18:00');
});

test('executeAction: invalid create-reminder payload throws (→ approveAction records failed)', async () => {
  const u = mkUser();
  proposeAction(u, { id: 'bad1', type: 'create-reminder', title: 'Bad', payload: { text: 'x', time: '99:99' }, created: 1 });
  const res = await approveAction(u, 'bad1', { execute: executeAction });
  assert.equal(res.status, 'failed');
  assert.match(res.error, /HH:MM/);
  assert.equal(loadReminders(u).length, 0, 'nothing was registered');
});

test(`expiry: pending older than ${PROPOSAL_TTL_DAYS}d (or missing created) → expired, never executable`, async () => {
  const u = mkUser();
  const now = Date.now();
  proposeAction(u, { id: 'fresh', type: 'noop', title: 'F', created: now - DAY });
  proposeAction(u, { id: 'stale', type: 'noop', title: 'S', created: now - (PROPOSAL_TTL_DAYS + 1) * DAY });
  proposeAction(u, { id: 'nocreated', type: 'noop', title: 'N' }); // created:null cannot prove freshness → expired (fail safe)
  const expired = expireStaleActions(u, now);
  assert.deepEqual(expired.map((a) => a.id).sort(), ['nocreated', 'stale']);
  assert.deepEqual(pendingActions(u).map((a) => a.id), ['fresh']);
  let ran = 0;
  const res = await approveAction(u, 'stale', { execute: async () => { ran++; } });
  assert.equal(res.status, 'expired', 'approve of an expired action is refused');
  assert.equal(ran, 0, 'executor never ran');
});

test('decided-once: approve/deny refuse a non-pending action (double-tap safety)', async () => {
  const u = mkUser();
  proposeAction(u, { id: 'a1', type: 'noop', title: 'Once', created: Date.now() });
  let ran = 0;
  await approveAction(u, 'a1', { execute: async () => { ran++; return { ok: true }; } });
  const second = await approveAction(u, 'a1', { execute: async () => { ran++; return { ok: true }; } });
  assert.equal(ran, 1, 'executor ran exactly once');
  assert.equal(second.status, 'done', 'second tap reports the standing decision');
  assert.equal(denyAction(u, 'a1').status, 'done', 'deny after done does not overwrite');
});

test(`limbo sweep: 'approved' older than ${EXEC_LIMBO_MINUTES}min → failed "interrupted", audited; a live one untouched`, async () => {
  const u = mkUser();
  const now = Date.now();
  proposeAction(u, { id: 'zombie', type: 'create-reminder', title: 'Walk 散步', created: now });
  proposeAction(u, { id: 'live', type: 'noop', title: 'L', created: now });
  // Simulate the crash window for both: 'approved' persisted, executor never resolved.
  const list = loadActions(u);
  Object.assign(list.find((a) => a.id === 'zombie'), { status: 'approved', executeStartedAt: now - (EXEC_LIMBO_MINUTES + 1) * 60000 });
  Object.assign(list.find((a) => a.id === 'live'), { status: 'approved', executeStartedAt: now - 60000 }); // executor plausibly still running
  fs.writeFileSync(path.join(u.workspace, 'pending-actions.json'), JSON.stringify(list));
  const { events, audit } = mkAudit();
  const swept = sweepStrandedApprovals(u, now, audit);
  assert.deepEqual(swept.map((a) => a.id), ['zombie']);
  const z = loadActions(u).find((a) => a.id === 'zombie');
  assert.equal(z.status, 'failed');
  assert.equal(z.error, 'interrupted · 执行中断');
  assert.equal(loadActions(u).find((a) => a.id === 'live').status, 'approved', 'inside the window: left for its executor');
  assert.deepEqual(events, [{ ev: 'action-interrupted', who: 'owner', action: 'zombie', type: 'create-reminder' }]);
  // An 'approved' with NO timestamps cannot prove the executor is alive → closed (fail safe).
  const l2 = loadActions(u); const live = l2.find((a) => a.id === 'live');
  delete live.executeStartedAt; delete live.decided;
  fs.writeFileSync(path.join(u.workspace, 'pending-actions.json'), JSON.stringify(l2));
  assert.equal(sweepStrandedApprovals(u, now, audit)[0].id, 'live');
});

test('corrupt store: loadActions THROWS (never a silent [] that gets rewritten empty); ENOENT is []', () => {
  const u = mkUser();
  assert.deepEqual(loadActions(u), [], 'missing file = no actions yet');
  fs.writeFileSync(path.join(u.workspace, 'pending-actions.json'), '{ torn half-write');
  assert.throws(() => loadActions(u), SyntaxError, 'corruption surfaces — the store is never wiped');
  fs.writeFileSync(path.join(u.workspace, 'pending-actions.json'), '{"not":"an array"}');
  assert.throws(() => loadActions(u), /not an array/);
});

test(`denial cooldown: same flag suppressed for ${DENIED_COOLDOWN_DAYS}d; open proposals also suppress`, () => {
  const u = mkUser();
  const now = Date.now();
  proposeAction(u, { id: 'd1', type: 'create-reminder', title: 'Walk', payload: { flag: 'steps_min_daily' }, created: now });
  denyAction(u, 'd1', now);
  assert.equal(deniedRecently(u, 'steps_min_daily', now + DAY), true);
  assert.equal(deniedRecently(u, 'steps_min_daily', now + (DENIED_COOLDOWN_DAYS + 1) * DAY), false, 'cooldown elapses');
  assert.equal(deniedRecently(u, 'gap_sleep', now), false, 'other flags unaffected');
  proposeAction(u, { id: 'p1', type: 'create-reminder', title: 'Walk', payload: { flag: 'gap_sleep' }, created: now });
  assert.equal(hasOpenProposal(u, 'gap_sleep'), true);
  assert.equal(isFlagSuppressed(u, 'steps_min_daily', now), true);
  assert.equal(isFlagSuppressed(u, 'gap_sleep', now), true);
  assert.equal(isFlagSuppressed(u, 'weight_delta_kg_7d', now), false);
});

test(`executed cooldown: an APPROVED flag is suppressed for ${EXECUTED_COOLDOWN_DAYS}d — week 2 must not re-ask and stack a duplicate`, async () => {
  const u = mkUser();
  const now = Date.now();
  proposeAction(u, { id: 'w1', type: 'noop', title: 'Walk', payload: { flag: 'steps_min_daily' }, created: now });
  await approveAction(u, 'w1', { execute: async () => ({ ok: true }), now });
  assert.equal(executedRecently(u, 'steps_min_daily', now + DAY), true);
  assert.equal(isFlagSuppressed(u, 'steps_min_daily', now + DAY), true, 'status done suppresses — the old pending/denied-only check re-proposed weekly');
  assert.equal(isFlagSuppressed(u, 'steps_min_daily', now + (EXECUTED_COOLDOWN_DAYS + 1) * DAY), false, 'cooldown elapses — a still-breaching flag may re-propose later');
});

test('settleProposals: pre-approved type executes now, others stay pending, failures audited', async () => {
  const u = mkUser();
  const now = Date.now();
  const proposed = [
    proposeAction(u, { id: 's1', type: 'noop', title: 'Ack 确认', created: now }),
    proposeAction(u, { id: 's2', type: 'create-reminder', title: 'Walk 散步', payload: { flag: 'steps_min_daily', text: 'Walk 散步', time: '18:00' }, created: now }),
  ];
  const { events, audit } = mkAudit();
  const settled = await settleProposals(u, proposed, { preapproved: ['noop'], audit, now });
  assert.deepEqual(settled.pending.map((a) => a.id), ['s2'], 'non-pre-approved stays pending');
  assert.deepEqual(settled.executed.map((a) => a.id), ['s1']);
  assert.equal(loadActions(u).find((a) => a.id === 's1').status, 'done');
  assert.deepEqual(events.map((e) => e.ev), ['action-preapproved-done']);
  // A pre-approved executor failure → 'failed', audited, never reported as done.
  const bad = [proposeAction(u, { id: 's3', type: 'create-reminder', title: 'Bad 坏', payload: { time: 'nope' }, created: now })];
  const settled2 = await settleProposals(u, bad, { preapproved: ['create-reminder'], audit, now });
  assert.equal(settled2.failed.length, 1);
  assert.equal(settled2.failed[0].status, 'failed');
  assert.equal(events.at(-1).ev, 'action-preapproved-failed');
  assert.match(events.at(-1).error, /提醒内容|HH:MM/);
});

test('annotateBriefing: 预批准 outcomes are appended to the SAVED briefing body', async () => {
  const u = mkUser();
  const briefing = saveBriefing(u, { id: 'hb-1', title: '健康简报', body: '# 健康简报\n\ntrends', created: 1 });
  const settled = {
    pending: [],
    executed: [{ id: 'x1', title: 'Ack 确认', result: { note: 'acknowledged · 已确认' } }],
    failed: [{ id: 'x2', title: 'Walk 散步', error: 'bad time' }],
  };
  const out = annotateBriefing(u, briefing, settled);
  assert.match(out.body, /## Actions · 行动/);
  assert.match(out.body, /done（预批准执行）: Ack 确认 — acknowledged · 已确认/);
  assert.match(out.body, /FAILED（执行失败）: Walk 散步 — bad time/);
  assert.equal(getBriefing(u, 'hb-1').body, out.body, 'persisted, not just returned');
  const untouched = annotateBriefing(u, briefing, { pending: [{}], executed: [], failed: [] });
  assert.equal(untouched, briefing, 'nothing executed → input returned as-is');
  assert.equal(getBriefing(u, 'hb-1').body, out.body, 'store not rewritten by a no-op settle');
});
