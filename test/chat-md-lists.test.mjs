// Markdown lists in a chat reply（聊天回答里的列表）— owner, v5.27.1, Bible Ask AI on Romans 7: "extra empty lines
// between bullets". SCAR: the shell's renderMd cut blocks on blank lines AFTER wrapping the list, so a LOOSE list
// (a blank line between "- " items — what models write) came out as <p>…<ul><li>a</li></p><li>b… and the browser
// turned each stray </p> into an empty paragraph: one blank gap per bullet. These run the REAL renderMd from
// web/index.html (every chat renders through it: the main chat, and PAChat — app chats, Ask AI — via render-md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL } from './helpers-app.mjs';
import { ROMANS } from './helpers-md-sample.mjs';

const src = SHELL.slice(SHELL.indexOf('const WORKSPACE_DIR_RE'), SHELL.indexOf('function stripMd'));
const renderMd = new Function(src + ';return renderMd;')();
const noStray = (h) => { assert.ok(!/<p>\s*<\/p>|<p>(?:(?!<\/p>)[^])*<(ul|ol|table|h\d|pre|blockquote)\b/.test(h), `no empty paragraph or block inside <p>: ${h}`); assert.ok(!/<\/p><li>|<li>\s*<br>|\n/.test(h), `no stray tags or newlines: ${h}`); };

test('a loose list (blank lines between items) is ONE tight list', () => {
  const h = renderMd('**2. 对应关系（4–6 节接着解释）**\n- 丈夫 = 律法／旧我\n\n- 妻子 = 信徒\n\n- 死 = 信徒与基督同死（6:3-6）\n严格说，死的是**信徒**。');
  assert.equal(h, '<p><strong>2. 对应关系（4–6 节接着解释）</strong></p><ul><li>丈夫 = 律法／旧我</li><li>妻子 = 信徒</li><li>死 = 信徒与基督同死（6:3-6）</li></ul><p>严格说，死的是<strong>信徒</strong>。</p>');
});

test('a tight list renders the same as the loose one', () => {
  assert.equal(renderMd('- a\n- b\n- c'), renderMd('- a\n\n- b\n\n\n- c'));
  assert.equal(renderMd('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
});

test('nested lists sit inside their item', () => {
  const h = renderMd('- one\n  - one.a\n  - one.b\n- two\n  1. x\n  2. y');
  assert.equal(h, '<ul><li>one<ul><li>one.a</li><li>one.b</li></ul></li><li>two<ol><li>x</li><li>y</li></ol></li></ul>');
});

test('numbered list with paragraphs between keeps its numbering', () => {
  const h = renderMd('1. 第一\n\n解释一下。\n\n2. 第二\n\n3. 第三');
  assert.equal(h, '<ol><li>第一</li></ol><p>解释一下。</p><ol start="2"><li>第二</li><li>第三</li></ol>');
  assert.equal(renderMd('1. a\n    continued\n2. b'), '<ol><li>a<br>continued</li><li>b</li></ol>', 'an indented line stays in its item');
});

test('a list right after a heading or a line of text is its own block', () => {
  assert.equal(renderMd('## 要点\n- a\n- b'), '<h2>要点</h2><ul><li>a</li><li>b</li></ul>');
  assert.equal(renderMd('Intro:\n- a'), '<p>Intro:</p><ul><li>a</li></ul>');
  assert.equal(renderMd('#### deep'), '<h3>deep</h3>');
});

test('code blocks, tables, blockquotes and rules', () => {
  assert.equal(renderMd('- a\n\n```js\nx<1\n```\n\n- b'), '<ul><li>a</li></ul><pre><code>x&lt;1</code></pre><ul><li>b</li></ul>');
  assert.equal(renderMd('| A | B |\n|---|---|\n| 1 | **2** |\n\nafter'),
    '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table><p>after</p>');
  assert.equal(renderMd('> 经上记着\n> 义人必因信得生\n\ntext'), '<blockquote>经上记着<br>义人必因信得生</blockquote><p>text</p>');
  assert.equal(renderMd('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
});

test('paragraph lines keep their breaks; blank-line runs leave no empty paragraphs', () => {
  assert.equal(renderMd('line1\nline2\n\n\n\nnext'), '<p>line1<br>line2</p><p>next</p>');
});

test('a real-shaped Romans 7 answer has no stray markup', () => {
  noStray(renderMd(ROMANS));
});
