// iOS must not inflate chat text · 禁止 iOS 放大对话文字 (owner 2026-11-24, iPhone, Red Flags app):
// the long intro bubble and the long 2nd answer rendered ~2x while the short 1st answer stayed
// 14px — WebKit's text autosizing, which inflates LONG text blocks only. Desktop engines and
// Playwright do not autosize, so this pins the rule itself: once in the theme every page gets
// (shell + every app), once on the chat root for a chat hosted where the theme is not injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (f) => fs.readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const PIN = /-webkit-text-size-adjust:100%;text-size-adjust:100%/;

test('the theme pins html for the shell and every app', () => {
  const r = /(^|\n)html\{[^}]*\}/.exec(read('theme-tokens.css'));
  assert.ok(r, 'an html rule in theme-tokens.css'); assert.match(r[0], PIN);
});
test('the shared chat root pins it too', () => {
  const r = /\n\.pac\{[^}]*\}/.exec(read('chat-ui.inline.html'));
  assert.ok(r, '.pac rule'); assert.match(r[0], PIN);
});
test('100%, never none (none also blocks the user zoom in some engines)', () => {
  for (const f of ['theme-tokens.css', 'chat-ui.inline.html']) assert.doesNotMatch(read(f), /text-size-adjust:\s*none/, f);
});
