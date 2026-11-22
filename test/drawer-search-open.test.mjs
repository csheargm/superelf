// Phase 3 of note search in the shared drawer: a hit row opens WHERE it matched. Split from
// test/drawer-search.test.mjs (R4); the fixture is test/helpers-drawer-search.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hit, tick, SETTLE_MS, drawer } from './helpers-drawer-search.mjs';

// The hit's page, boxes and the reply's terms travel as onOpen's second argument (listDrawer
// forwards it); a row opened without a hit gets undefined.
test('a hit row\'s click passes {page, boxes, terms} as onOpen\'s second argument; a plain row passes nothing', async () => {
  const H = { ...hit('entry-2.json', 'ink', 'Saturday pollen'), page: 3, boxes: [[0.1, 0.2, 0.5, 0.05]] };
  const D = await drawer(async () => ({ ok: true, hits: [H], terms: ['pollen'] }));
  await D.type('pollen'); await tick(SETTLE_MS);
  D.click('b'); D.click('a');
  assert.deepEqual(D.opened, [['b', { page: 3, boxes: [[0.1, 0.2, 0.5, 0.05]], terms: ['pollen'] }], ['a', undefined]], 'the hit at click time, from the current query; the unmatched row carries nothing');
  await D.type(''); D.click('b');
  assert.deepEqual(D.opened[2], ['b', undefined], 'the box cleared: the same row is a plain open again');
  const old = await drawer(async () => ({ ok: true, hits: [hit('entry-2.json')] }));
  await old.type('landlord'); await tick(SETTLE_MS); old.click('b');
  assert.deepEqual(old.opened, [['b', { page: 0, boxes: [], terms: [] }]], 'a phase 2 reply (no boxes, no terms): page only');
});
