import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveBriefing, listBriefings, getBriefing,
  proposeAction, pendingActions, setActionStatus, loadActions,
  isReadOnly, runJob, approveAction, denyAction,
} from '../lib/autonomy.mjs';

function mkUser() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-'));
  return { workspace: ws, id: 'owner' };
}

test('briefings: save, list newest-first, get by id', () => {
  const u = mkUser();
  saveBriefing(u, { id: 'brief-100', job: 'test-brief', title: 'A', body: 'first', created: 100 });
  saveBriefing(u, { id: 'brief-200', job: 'test-brief', title: 'B', body: 'second', created: 200 });
  const list = listBriefings(u);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'brief-200', 'newest first');
  assert.equal(getBriefing(u, 'brief-100').body, 'first');
  assert.equal(getBriefing(u, 'nope'), null);
});

test('briefings: rejects a path-traversal id', () => {
  const u = mkUser();
  assert.throws(() => saveBriefing(u, { id: '../evil', body: 'x' }));
  assert.equal(getBriefing(u, '../../etc/passwd'), null);
});

test('safe-action policy: read-only auto, unknown treated as side-effecting', () => {
  assert.equal(isReadOnly('summarize'), true);
  assert.equal(isReadOnly('DIGEST'), true);
  assert.equal(isReadOnly('send_email'), false);
  assert.equal(isReadOnly('delete'), false);
  assert.equal(isReadOnly('whatever-unknown'), false, 'unknown must NOT be auto-run');
  assert.equal(isReadOnly(undefined), false);
});

test('actions: propose is idempotent, pending filters, deny works', () => {
  const u = mkUser();
  proposeAction(u, { id: 'a1', type: 'send_email', title: 'Reply to X', created: 1 });
  proposeAction(u, { id: 'a1', type: 'send_email', title: 'dup', created: 1 }); // idempotent
  assert.equal(loadActions(u).length, 1);
  assert.equal(pendingActions(u).length, 1);
  denyAction(u, 'a1');
  assert.equal(pendingActions(u).length, 0);
  assert.equal(loadActions(u)[0].status, 'denied');
});

test('runJob: writes a briefing + queues proposed actions (stub run)', async () => {
  const u = mkUser();
  const job = { name: 'test-brief', title: 'Test Brief', type: 'propose' };
  const run = async () => ({
    body: 'You have 2 unread emails and 1 meeting today.',
    actions: [{ type: 'send_email', title: 'Reply to Alice', summary: 'Draft ready', payload: { to: 'alice' } }],
  });
  const { briefing, proposed } = await runJob(u, job, { run, now: 500 });
  assert.equal(briefing.id, 'test-brief-500');
  assert.match(getBriefing(u, briefing.id).body, /2 unread/);
  assert.equal(proposed.length, 1);
  assert.equal(pendingActions(u)[0].title, 'Reply to Alice');
  assert.equal(pendingActions(u)[0].status, 'pending');
});

test('runJob: a run returning null is a SKIP — no briefing stored (R14: silence ≠ empty all-good)', async () => {
  const u = mkUser();
  const job = { name: 'daily-brief', title: 'Daily Brief', type: 'digest' };
  const out = await runJob(u, job, { run: async () => null, now: 700 });
  assert.equal(out.skipped, true);
  assert.equal(out.briefing, null);
  assert.equal(listBriefings(u).length, 0, 'nothing was stored');
});

test('approveAction: runs execute exactly once, marks done', async () => {
  const u = mkUser();
  proposeAction(u, { id: 'a1', type: 'send_email', title: 'Reply', created: 1 });
  let executed = 0;
  const done = await approveAction(u, 'a1', { execute: async () => { executed++; return { ok: true, sent: true }; }, now: 9 });
  assert.equal(executed, 1);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { ok: true, sent: true });
  assert.equal(pendingActions(u).length, 0);
});

test('approveAction: a failing execute marks the action failed, not done', async () => {
  const u = mkUser();
  proposeAction(u, { id: 'a2', type: 'send_email', title: 'Reply', created: 1 });
  const res = await approveAction(u, 'a2', { execute: async () => { throw new Error('smtp down'); } });
  assert.equal(res.status, 'failed');
  assert.match(res.error, /smtp down/);
});

// Moved from test/jobs-fold.test.mjs when the daily-brief fold was removed (2026-10-11): the
// stamp itself is runJob's contract and stays.
test('runJob stamps the job\'s deliver onto the briefing, or nothing downstream can honour it', async () => {
  const u = mkUser();
  const out = await runJob(u, { name: 'p', title: 'P', deliver: 'own-message' },
    { run: async () => ({ body: 'x' }), now: 1000 });
  assert.equal(out.briefing.deliver, 'own-message');
  const plain = await runJob(u, { name: 'q', title: 'Q' }, { run: async () => ({ body: 'y' }), now: 2000 });
  assert.equal(plain.briefing.deliver, null, 'a built-in carries none and is pushed as before');
});
