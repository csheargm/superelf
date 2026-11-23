// Owner 2026-11-13: the explain turn showed its whole instruction prompt as the user bubble, and the
// floating composer covered the end of the answer. The bubble now shows header + verse only; the
// model still gets the instructions; a composer resize keeps a pinned log pinned.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const BIBLE = fs.readFileSync(new URL('../workspace/apps/bible/index.html', import.meta.url), 'utf8');
const CHAT = fs.readFileSync(new URL('../web/chat-ui.inline.html', import.meta.url), 'utf8');
const slice = (a, b) => BIBLE.slice(BIBLE.indexOf(a), BIBLE.indexOf(b));
const ctx = { selV: new Set([2]), VERSES: [{ n: 2, en: 'He came at night.', zh: '这人夜里来见耶稣。' }] };
vm.runInNewContext(slice('const EXPLAIN_PROMPT_BODY=', 'let rail=null') + ';this.explainMsg=explainMsg;this.showMe=showMe;this.setO=v=>{_explainPromptOverride=v};', ctx);

test('the model gets the instructions; the bubble shows header + verse only', () => {
  const m = ctx.explainMsg('John 3:2');
  assert.match(m, /FIRST REPLY/); assert.match(m, /He came at night/);
  assert.equal(ctx.showMe(m), '释经 Explain — John 3:2\nHe came at night.\n这人夜里来见耶稣。');
});
test('a custom prompt is hidden the same way', () => {
  ctx.setO('My own instructions'); const m = ctx.explainMsg('John 3:2'); ctx.setO(null);
  assert.match(m, /My own instructions/); assert.doesNotMatch(ctx.showMe(m), /My own/);
});
test('old stored explain turns show their header line; ordinary turns are untouched', () => {
  assert.equal(ctx.showMe('释经 Explain — John 6:2\nAnswer briefly first.\n\nFIRST REPLY …'), '释经 Explain — John 6:2');
  assert.equal(ctx.showMe('What does this mean?\nline 2'), 'What does this mean?\nline 2');
});
test('PAChat renders every user turn through opts.showMe (live + both history paths)', () => {
  assert.equal((CHAT.match(/shownMe\(cleanMe\(mm\.text\)\)/g) || []).length, 2);
  assert.match(CHAT, /const shown=shownMe\(q\); const um=addMsg\('me',shown,mine\)/);
  assert.match(BIBLE, /\n  showMe,/);
});
test('a taller composer re-pins a log that was at the bottom', () => {
  assert.match(CHAT, /PA_PILL_RESERVE_END[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if\(window\.ResizeObserver\) new ResizeObserver\(\(\)=>\{ if\(nearBottom\(\)\) pin\(\); \}\)\.observe\(el\.row\);/);
});

test('note title: book + chapter with no selection; verse ref + first words with one', async () => {
  const fs = await import('node:fs'); const vm = await import('node:vm');
  const S = fs.readFileSync(new URL('../workspace/apps/bible/index.html', import.meta.url), 'utf8');
  const code = S.slice(S.indexOf('function scopeRef(){'), S.indexOf('\n', S.indexOf("return `${zh} `+scopeRef()")));
  const ctx = { BOOKS: [['Romans', '罗马书', 16]], bookIdx: 0, chapter: 3, selV: new Set(), VERSES: [{ n: 4, en: 'Certainly not! Let God be true and every man a liar.' }] };
  vm.runInNewContext(code.replace('const TITLE_WORDS', 'var TITLE_WORDS') + ';this.t=scopeTitle;', ctx);
  assert.equal(ctx.t(), '罗马书 3 · Romans');
  ctx.selV.add(4);
  assert.equal(ctx.t(), '罗马书 3:4 · Romans — Certainly not! Let God be…');
});
