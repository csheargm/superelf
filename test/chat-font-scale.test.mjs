// A-/A+ must reach the chat, not just the app's own text.
//
// Reported 2026-09-11: in the Bible, A-/A+ resized the scripture and left the chat beside it
// unchanged. The plumbing was already there and this component simply consumed neither end of it:
// the shell broadcasts {pa:'prefs', fontScale}, and web.mjs turns that into ONE of two mechanisms —
//   · `zoom`  for apps sized in absolute px (everything scales for free), or
//   · `--fs`  for apps that mount PANote, whose canvas coordinates come from a MEASURED element
//             width, so zoom would re-lay the page out instead of magnifying it.
// chat-ui was written in absolute px and read no `--fs`, so in a --fs app it never moved.
//
// Measured in a browser after the fix, against the real stylesheet:
//   --fs   verses   message   status
//   0.85   14.45     11.9     10.23
//   1.00   17.00     14.0     12.04
//   1.25   21.25     17.5     15.05
//   1.50   25.50     21.0     18.06
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, SHELL, stripComments } from './helpers-app.mjs';

test('the chat has ONE definition of its reading size', () => {
  assert.match(CHAT, /\.pac\{[^}]*--pac-fs:calc\(14px \* var\(--fs,1\)\)\}/,
    'declared on the chat root, derived from the broadcast scale');
  // R3: one source. Every consumer references it rather than restating the arithmetic.
  const restated = (stripComments(CHAT).match(/calc\(14px \* var\(--fs/g) || []).length;
  assert.equal(restated, 1, `the scale arithmetic must appear once; found ${restated}`);
});

test('everything the user READS follows it', () => {
  const code = stripComments(CHAT);
  assert.match(code, /\.pac-m\{[^}]*font-size:var\(--pac-fs,14px\)/, 'message bubbles');
  assert.match(code, /\.pac-inp\{[^}]*font-size:var\(--pac-fs,14px\)/,
    'and the composer — what you type must match what you read back');
  assert.match(code, /\.pac-title\{[^}]*font-size:var\(--pac-fs,14px\)/, 'and the conversation title');
  // Proportions are kept rather than re-pinned: status was 12 of 14, code 13 of 14.
  assert.match(code, /\.pac-m\.status\{[^}]*font-size:calc\(var\(--pac-fs,14px\) \* \.86\)/, 'status stays smaller');
  assert.ok((code.match(/font-size:calc\(var\(--pac-fs,14px\) \* \.93\)/g) || []).length === 2,
    'pre and code keep their 13/14 ratio');
});

test('chrome keeps its pixels — A+ asks for bigger TEXT, not a deformed composer', () => {
  const code = stripComments(CHAT);
  for (const [sel, px] of [['.pac-plus', '20px'], ['.pac-go', '16px'], ['.pac-scroll', '16px']]) {
    const rule = new RegExp(`\\${sel}\\{[^}]*font-size:${px}`);
    assert.match(code, rule, `${sel} is an icon/button and stays fixed so the row does not deform`);
  }
});

test('a fallback exists, so a host that never sends a scale still renders', () => {
  // An app opened outside the shell receives no prefs at all: var(--fs,1) and the var()'s own
  // 14px fallback both have to hold, or the chat renders at 0 or inherits something unrelated.
  assert.match(CHAT, /var\(--fs,1\)/, '--fs defaults to 1');
  const uses = stripComments(CHAT).match(/var\(--pac-fs,14px\)/g) || [];
  assert.ok(uses.length >= 3, 'and every consumer carries the px fallback');
});

test('the shell scales its own chat the same way — this is the established idiom', () => {
  assert.match(SHELL, /body\{[^}]*font:calc\(17px \* var\(--fs,1\)\)/,
    'the shell sizes its body from the scale, so its chat log inherits it');
});
