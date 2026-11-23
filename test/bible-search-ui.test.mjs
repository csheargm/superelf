// Bible search box, driven on BOTH copies of the real app source (overnight 2026-11-22):
//   F2-04 a single Chinese character (爱) is a real search; one Latin letter is refused 中文 first.
// R11 — searched: "Type at least 2", "runSearch", "bible-search" — one search box per copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, startHarness, runApp, until, settle } from './helpers-app.mjs';
import { searchBible, BIBLE_DATA_DIR } from '../lib/bible.mjs';

const DATA = path.join(ROOT, BIBLE_DATA_DIR);
const EXPORTS = ['runSearch', '_booted:()=>_booted', 'el:(id)=>document.getElementById(id)'];
const tipsStub = () => ({ register() {} });

// The shell's bible-search answer comes from the REAL searchBible, as web.mjs serves it.
async function boot(app) {
  const h = await startHarness('bible');
  const asked = [];
  const relay = Object.assign(async (m) => {
    if (m.kind !== 'bible-search') return h.relay(m);
    asked.push(m.q);
    return { ok: true, id: m.id, results: searchBible(DATA, m.q) };
  }, { faults: h.relay.faults });
  const A = runApp(app, relay, EXPORTS, { clampTimers: true, globals: { PATips: tipsStub() } });
  await until(() => A._booted(), 'boot');
  await settle();
  return { h, A, asked };
}

test('searchBible: one Chinese character searches 和合本; one Latin letter does not', () => {
  const zh = searchBible(DATA, '爱');
  assert.ok(zh.length > 0, '爱 finds verses');
  assert.deepEqual(searchBible(DATA, 'a'), []);
});

for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: 爱 is searched; "a" is refused with a 中文-first reason`, async () => {
    const { h, A, asked } = await boot(app);
    try {
      const el = A.el;
      el('search-inp').value = '爱';
      await A.runSearch();
      assert.deepEqual(asked, ['爱'], 'the one-character Chinese query reached the search');
      assert.match(el('search-results').innerHTML, /class="sr"/, 'hits are listed');
      el('search-inp').value = 'a';
      await A.runSearch();
      assert.deepEqual(asked, ['爱'], 'one Latin letter is not sent');
      assert.match(el('search-results').innerHTML, /请至少输入 2 个字母 · Type at least 2 letters/);
    } finally { await h.stop(); }
  });
}
