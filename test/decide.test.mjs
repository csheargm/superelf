// Single-writer decision core (lib/decide.mjs) — the cross-process race family
// (R13): two surfaces deciding one action must serialize so the executor runs
// AT MOST ONCE and a decision is never silently reverted. Throwaway mkdtemp
// workspaces only; executors are counting stubs (no real side channels).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decideAction, withUserLock } from '../lib/decide.mjs';
import { proposeAction, loadActions } from '../lib/autonomy.mjs';
import { EXEC_LIMBO_MINUTES } from '../lib/actions.mjs';
import { mkUser, mkAudit } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const propose = (u, id = 'a1', over = {}) =>
  proposeAction(u, { id, type: 'noop', title: 'Once', payload: { flag: 'f1' }, created: Date.now(), ...over });

test('concurrent approve + deny on ONE action: exactly one wins, executor runs at most once', async () => {
  const u = mkUser('decide-');
  propose(u);
  let ran = 0;
  const slowExec = async () => { await sleep(40); ran++; return { ok: true, note: 'x' }; };
  const { audit } = mkAudit();
  // Both fired in the same tick — the un-serialized read-check-write let both
  // see 'pending' (approve executed AND the store ended 'denied').
  const [a, d] = await Promise.all([
    decideAction(u, 'a1', 'approve', { execute: slowExec, audit }),
    decideAction(u, 'a1', 'deny', { audit }),
  ]);
  assert.equal([a, d].filter((x) => x.wasPending).length, 1, 'exactly one decision won');
  assert.equal(ran, 1, 'executor ran exactly once (approve was queued first)');
  assert.equal(a.decided.status, 'done');
  assert.equal(d.decided.status, 'done', 'the loser reports the standing decision, it does not overwrite');
  assert.equal(loadActions(u)[0].status, 'done', 'the store holds ONE final status');
});

test('deny-then-approve: the approve refuses — the executor NEVER runs after a denial', async () => {
  const u = mkUser('decide-');
  propose(u);
  let ran = 0;
  const { audit } = mkAudit();
  const [d, a] = await Promise.all([
    decideAction(u, 'a1', 'deny', { audit }),
    decideAction(u, 'a1', 'approve', { execute: async () => { ran++; return { ok: true }; }, audit }),
  ]);
  assert.equal(d.wasPending, true, 'the deny won (queued first)');
  assert.equal(a.wasPending, false, 'the approve was a refused replay');
  assert.equal(ran, 0, 'no side effect after an explicit denial');
  assert.equal(loadActions(u)[0].status, 'denied');
});

test('the tick\'s proposal store joins the same queue — no lost update against a slow decision', async () => {
  const u = mkUser('decide-');
  propose(u, 'a1');
  const { audit } = mkAudit();
  // A decision holding the store across a slow executor, interleaved with the
  // tick writing a fresh proposal (whole-file save). Unserialized, last writer
  // reverted the other's write (decision back to 'pending', or proposal gone).
  const [dec] = await Promise.all([
    decideAction(u, 'a1', 'approve', { execute: async () => { await sleep(40); return { ok: true }; }, audit }),
    withUserLock(u.id, () => propose(u, 'a2')),
  ]);
  assert.equal(dec.decided.status, 'done');
  const byId = Object.fromEntries(loadActions(u).map((x) => [x.id, x.status]));
  assert.deepEqual(byId, { a1: 'done', a2: 'pending' }, 'both writes survived — nothing reverted, nothing lost');
});

test('decideAction sweeps first: stale pending expires, a crash-stranded approval closes as failed', async () => {
  const u = mkUser('decide-');
  const now = Date.now();
  propose(u, 'stale', { created: now - 9 * 86400000 });
  propose(u, 'zombie', { created: now });
  // Simulate the crash window: 'approved' written, executor never resolved.
  const list = loadActions(u);
  Object.assign(list.find((x) => x.id === 'zombie'), { status: 'approved', executeStartedAt: now - (EXEC_LIMBO_MINUTES + 1) * 60000 });
  fs.writeFileSync(path.join(u.workspace, 'pending-actions.json'), JSON.stringify(list));
  const { events, audit } = mkAudit();
  let ran = 0;
  const out = await decideAction(u, 'stale', 'approve', { execute: async () => { ran++; }, audit, now });
  assert.equal(out.decided.status, 'expired', 'TTL-dead proposal expired inside the lock, not executed');
  assert.equal(ran, 0);
  const zombie = loadActions(u).find((x) => x.id === 'zombie');
  assert.equal(zombie.status, 'failed');
  assert.match(zombie.error, /interrupted · 执行中断/);
  assert.ok(events.some((e) => e.ev === 'action-interrupted' && e.action === 'zombie'), 'limbo close is audited');
});

test('audit: only a WINNING decision audits', async () => {
  const u = mkUser('decide-');
  propose(u);
  const { events, audit } = mkAudit();
  await decideAction(u, 'a1', 'deny', { audit });
  await decideAction(u, 'a1', 'deny', { audit }); // replay: no second audit row
  const rows = events.filter((e) => e.ev === 'action-denied');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].who, rows[0].action], ['owner', 'a1'], 'the row names who decided what');
  assert.equal((await decideAction(u, 'nope', 'deny', { audit })), null, 'unknown id → null, caller reports honestly');
});
