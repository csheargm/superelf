// Rendered markdown must not be painted through pre-wrap.
//
// SCAR: a reply came back with large blank gaps between a bullet and the text under it. The
// markdown itself was fine — .pac-m is `white-space:pre-wrap` (so a typed message keeps its line
// breaks) and rendered HTML carries newlines BETWEEN block tags, so every one of those source
// newlines was painted as a blank line ON TOP of the block margins.
//
// Measured in a browser against the real stylesheet, on a real reply's HTML:
//   .pac-m.ai            357px
//   .pac-m.ai.pac-md     143px   → 60% of the bubble was source newlines
// A plain-text bubble still computes white-space: pre-wrap and still shows 3 lines for 3 lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, SHELL, stripComments } from './helpers-app.mjs';

test('the bubble keeps pre-wrap — a typed message must keep its line breaks', () => {
  assert.match(CHAT, /\.pac-m\{[^}]*white-space:pre-wrap/, 'the default stays pre-wrap');
});

test('…and rendered markdown opts out of it', () => {
  assert.match(CHAT, /\.pac-m\.pac-md\{white-space:normal\}/, 'rendered HTML is painted as HTML');
});

test('ONE place decides rendered-vs-plain and records it', () => {
  // Two render sites (the loaded-message painter and the live streaming renderer) each used to
  // inline `innerHTML = html || esc(text)`. Two copies of that decision is how one of them keeps
  // pre-wrap off for plain text, or on for HTML.
  const code = stripComments(CHAT);
  assert.match(code, /function setBody\(d,md,html\)\{[\s\S]*?d\.classList\.toggle\('pac-md',ok\);/,
    'setBody installs the body and marks it');
  const inline = code.match(/innerHTML=\(r&&r\.ok&&r\.html\)\?r\.html:esc\(/g) || [];
  assert.equal(inline.length, 0, `no render site may inline the decision; found ${inline.length}`);
  assert.equal((code.match(/setBody\(/g) || []).length >= 3, true, 'both render sites go through it');
});

test('every fallback to plain text turns pre-wrap back ON', () => {
  // The dangerous direction: a bubble that rendered once, then falls back to text, would keep
  // pac-md and silently lose its line breaks.
  const code = stripComments(CHAT);
  assert.match(code, /catch\{ d\.textContent=md; d\.classList\.remove\('pac-md'\); \}/, 'the painter’s catch clears it');
  assert.match(code, /thinking\.textContent='No response — try rephrasing\.'; thinking\.classList\.remove\('pac-md'\);/,
    'and so does the empty-response path');
  // The other two plain-text paths reset className wholesale, which drops pac-md with it.
  for (const m of ["thinking.className='pac-m status'; thinking.textContent='🔧 '+ev.text",
                   "thinking.className='pac-m status'; thinking.textContent='⚠ '+failure"]) {
    assert.ok(code.includes(m), `a status path must reset className (drops pac-md): ${m.slice(0, 40)}`);
  }
});

test('the shell already scoped pre-wrap this way — PAChat now matches it', () => {
  // Not a new idea: the shell's own chat applies pre-wrap to .me/.status/.stream and never to the
  // rendered bubble. PAChat applied it to every .pac-m, which is where the divergence came from.
  assert.match(SHELL, /\.msg\.me\{[^}]*white-space:pre-wrap/);
  assert.match(SHELL, /\.msg\.stream\{ white-space:pre-wrap; \}/);
  const mdBubble = /\.msg\.md\{[^}]*\}/.exec(SHELL);
  if (mdBubble) assert.ok(!/pre-wrap/.test(mdBubble[0]), 'the shell never pre-wraps its rendered bubble');
});

test('nested lists do not double their spacing', () => {
  assert.match(CHAT, /\.pac-m\.ai li>ul,\.pac-m\.ai li>ol\{margin:\.15em 0\}/,
    'an inner list is spaced by its outer li, not again by itself');
});

test('a streaming delta must not wipe the rendered-markdown class', () => {
  // SCAR (introduced and reported within one release): every delta ran
  //   thinking.className='pac-m ai'
  // which wiped pac-md many times a second, while the throttled renderer only put it back every
  // 150ms. The bubble therefore flipped between white-space:normal and pre-wrap continuously —
  // and those differ by ~2.5x in height on a real reply — so the text visibly BLINKED as it
  // streamed. There was no blink before pac-md existed, which is exactly why this is pinned.
  const code = stripComments(CHAT);
  assert.ok(!/\.className='pac-m ai'/.test(code),
    "an ai-transition must use classList, or it wipes pac-md and the bubble's height oscillates");
  assert.match(code, /thinking\.classList\.remove\('status'\); thinking\.classList\.add\('ai'\);/,
    'status→ai says exactly that and leaves other classes alone');
  // The status paths DO assign className on purpose: they install plain text and want pre-wrap.
  assert.match(code, /thinking\.className='pac-m status'/, 'a status bubble resets wholesale, deliberately');
});

test('only ONE thing decides pac-md, so it cannot be half-set', () => {
  const code = stripComments(CHAT);
  const adds = code.match(/classList\.(add|toggle)\('pac-md'/g) || [];
  assert.equal(adds.length, 1, `pac-md must be set in one place only; found ${adds.length}`);
  assert.match(code, /d\.classList\.toggle\('pac-md',ok\);/, 'and that place is setBody');
});
