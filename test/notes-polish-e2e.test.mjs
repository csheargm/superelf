// Journal polish, in a REAL browser · 笔记细节（真实浏览器）
//
// The shipped Journal (shared-apps/notes) in the real shell on a throwaway root (test/helpers-note-link.mjs —
// never the live node). One test per overnight finding of the notes batch (F3-xx): each drives the flow the
// tester hit and pins the fixed behaviour. Run: PA_PLAYWRIGHT=/path/to/playwright/index.mjs node --test test/notes-polish-e2e.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, setup, teardown, newContext, openJournal } from './helpers-note-link.mjs';

before(() => setup());
after(teardown);

test('F3-11: a drawer row preview keeps a space between lines ("#family Remember the hymn", never "#familyRemember")', { skip, timeout: 60000 }, async () => {
  const ctx = await newContext(); const page = await ctx.newPage();
  const frame = await openJournal(page);
  const got = await frame.evaluate(() => previewOf({ pages: [{ pageHtml: '<div>#family</div><div>Remember the hymn</div><p>a</p><ul><li>b</li><li>c</li></ul>x<br>y' }] }));
  assert.equal(got, '#family Remember the hymn a b c x y');
  assert.equal(await frame.evaluate(() => previewOf({ pages: [{ pageHtml: 'one <b>bold</b>word' }] })), 'one boldword', 'inline tags add no space');
  assert.equal(await frame.evaluate(() => previewOf({ pages: [{ pageHtml: '#morning<div>Remember the hymn</div>' }] })), '#morning Remember the hymn', 'the first line outside a block, as the editor writes it after Enter');
  await ctx.close();
});
