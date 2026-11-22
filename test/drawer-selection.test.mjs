// The drawer's highlight must never outlive the selection it represents.
//
// SCAR (Bible app): tapping ＋ for a new chat ran `_sel=null` but never repainted the drawer,
// so the note opened a moment earlier stayed highlighted beside a brand-new empty chat. It
// reads as "I selected that note and the app showed me a chat instead" — a bug report about
// the wrong thing entirely, because the highlight was lying about what was open.
// setActiveNote() always did both halves; newChat() did only the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeOnly } from './helpers-code.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT = fs.readFileSync(path.join(ROOT, 'web/chat-ui.inline.html'), 'utf8'); // throws if moved (R14)

const fn = (name) => {
  const i = CHAT.indexOf(`function ${name}(`);
  assert.ok(i > 0, `${name} must stay a named function`);
  return codeOnly(CHAT.slice(i, CHAT.indexOf('\n    }', i)));
};

test('every place that clears the selection also repaints the drawer', () => {
  // _sel is what the drawer renders from; setting it without setActive leaves a stale highlight.
  for (const name of ['newChat']) {
    const body = fn(name);
    assert.match(body, /_sel=null/, `${name} clears the selection`);
    assert.match(body, /drawer\.setActive\(null\)/,
      `${name} must repaint too, or the old row stays highlighted over a different surface`);
  }
});

test('setActiveNote does both halves — the pattern the others must follow', () => {
  const i = CHAT.indexOf('function setActiveNote(id)');
  assert.ok(i > 0);
  const line = CHAT.slice(i, CHAT.indexOf('\n', i));
  assert.match(line, /_sel=id\|\|null/);
  assert.match(line, /drawer\.setActive\(_sel\)/);
});

// THE INVARIANT, pinned across every app: opening the drawer must not conjure a chat.
//
// This was reported three times and patched twice, each time at whichever entry point the user
// happened to hit — the ＋ button, then the passage view's ☰, then the note pad's History.
// Every one revealed the chat surface while the drawer still highlighted a NOTE, so the screen
// said "this note is selected" over an empty new chat. Fixing them one at a time was the
// mistake; this enumerates them instead.
//
// PAChat exposes both: showList() SHOWS the chat surface and opens the drawer; showListOnly()
// opens only the drawer. A "show me my notes" affordance must use the latter.
test('no app opens the drawer via the chat-revealing showList()', () => {
  const dir = new URL('../workspace/apps/', import.meta.url);
  let apps = [];
  try { apps = fs.readdirSync(dir); } catch { return; }        // fresh checkout: no live instances
  for (const a of apps) {
    let html;
    try { html = fs.readFileSync(new URL(`../workspace/apps/${a}/index.html`, import.meta.url), 'utf8'); }
    catch { continue; }
    // .showList() but NOT .showListOnly() — the paren makes them distinguishable.
    const bad = html.match(/\w+\.showList\(\)/g) || [];
    assert.deepEqual(bad, [],
      `${a}: use showListOnly() — showList() reveals the chat over whatever the drawer says is selected`);
  }
});

test('PAChat still offers both, so the distinction stays available', () => {
  const CHAT = fs.readFileSync(new URL('../web/chat-ui.inline.html', import.meta.url), 'utf8');
  assert.match(CHAT, /showList:\(\)=>\{ show\(\); api\.showList\(\); \}/, 'the revealing one');
  assert.match(CHAT, /showListOnly:\(\)=>api\.showList\(\)/, 'and the drawer-only one');
});
