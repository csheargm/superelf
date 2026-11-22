// lib/convo-lock.mjs — the per-conversation lock on its own: order, release on throw, independence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConvoLocks, withConvoTurn } from '../lib/convo-lock.mjs';

const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('same key: turns run one after another, in arrival order; the map empties after', async () => {
  const locks = createConvoLocks(), order = [], g = gate();
  let queued = 0;
  const t1 = withConvoTurn(locks, { userId: 'u', convoId: 'c', onQueued: () => queued++ }, async () => { order.push('1s'); await g.p; order.push('1e'); });
  const t2 = withConvoTurn(locks, { userId: 'u', convoId: 'c', onQueued: () => queued++ }, async () => { order.push('2'); });
  const t3 = withConvoTurn(locks, { userId: 'u', convoId: 'c', onQueued: () => queued++ }, async () => { order.push('3'); });
  await Promise.resolve();
  assert.deepEqual(order, ['1s']);
  g.open(); await Promise.all([t1, t2, t3]);
  assert.deepEqual(order, ['1s', '1e', '2', '3']);
  assert.equal(queued, 2, 'only the waiting turns say they are queued');
  assert.equal(locks.size(), 0);
});

test('a throwing turn releases the lock (no deadlock) and its error reaches the caller', async () => {
  const locks = createConvoLocks();
  const bad = withConvoTurn(locks, { userId: 'u', convoId: 'c', onQueued() {} }, async () => { throw new Error('lane died'); });
  const next = withConvoTurn(locks, { userId: 'u', convoId: 'c', onQueued() {} }, async () => 'ran');
  await assert.rejects(bad, /lane died/);
  assert.equal(await next, 'ran');
  assert.equal(locks.size(), 0);
});

test('different conversations and different users never wait; a new id held by hold() queues followers', async () => {
  const locks = createConvoLocks(), g = gate();
  let queued = 0;
  const onQueued = () => queued++;
  const a = withConvoTurn(locks, { userId: 'u', convoId: 'c1', onQueued }, () => g.p);
  const b = withConvoTurn(locks, { userId: 'u', convoId: 'c2', onQueued }, async () => 'b');
  const c = withConvoTurn(locks, { userId: 'v', convoId: 'c1', onQueued }, async () => 'c');
  assert.deepEqual(await Promise.all([b, c]), ['b', 'c']);
  assert.equal(queued, 0);
  const made = withConvoTurn(locks, { userId: 'u', convoId: '', onQueued }, async (hold) => { hold('new1'); await g.p; });
  const follow = withConvoTurn(locks, { userId: 'u', convoId: 'new1', onQueued }, async () => 'f');
  await Promise.resolve();
  assert.equal(queued, 1, 'the follow-up to the new conversation queued');
  g.open(); await Promise.all([a, made]);
  assert.equal(await follow, 'f');
  assert.equal(locks.size(), 0);
});
