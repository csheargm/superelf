// A scope owns exactly ONE conversation, and a "new chat" must not steal it.
//
// REPORTED, then measured on live data: John 3:2 had NINETEEN conversations and a single pointer
// — eighteen unreachable. The user's words: "it does not remember the prior conversations… there
// are so many chats in drawer that has the same verse."
//
// CAUSE: newChat() cleared curConvo but kept the PREVIOUS scope's `key`. So tapping ＋ on a verse
// that already had a thread, then typing, created a second conversation AND rebound that verse to
// it via setCid — orphaning the first. The old thread stayed on the server and stayed in the
// drawer, which is why the list filled with same-verse rows while the verse itself "forgot".
//
// A second fingerprint of the same class was already on disk: ANN.chat carried a scope named
// "null" — a send whose key was null, written as the STRING "null", which every later unkeyed
// chat then overwrote in turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CHAT, stripComments } from './helpers-app.mjs';

test('a new chat belongs to NO scope until one is chosen', () => {
  const fn = /function newChat\(\)\{([\s\S]*?)\n    \}/.exec(CHAT);
  assert.ok(fn, 'newChat exists');
  const body = stripComments(fn[1]);
  assert.match(body, /key=null; loadedKey=null;/,
    'the previous scope is released — keeping it is what rebound the verse to the new thread');
  assert.match(body, /curConvo=null/, 'and the conversation is cleared as before');
  // Order matters only in that both happen before the greeting; assert both are present in one place.
  assert.ok(body.indexOf('key=null') < body.indexOf('setTitle'), 'released before the chat is re-titled');
});

test('an unkeyed conversation is never bound to a scope', () => {
  const fn = /function setCid\(k,id\)\{([\s\S]*?)\n\n/.exec(CHAT);
  assert.ok(fn, 'setCid exists');
  const body = stripComments(fn[1]);
  assert.match(body, /if\(k===null\|\|k===undefined\|\|k===''\) return;/,
    'a null/absent key writes nothing — it used to write a scope literally named "null"');
  // The guard must come FIRST, or the host's setConvoId is already called with the bad key.
  assert.ok(body.indexOf("k===null") < body.indexOf('opts.setConvoId'),
    'the guard precedes the host callback, or the host stores the bogus key itself');
});

test('the Bible refuses a bogus scope on its own side too', () => {
  for (const rel of ['workspace.example/apps/bible/index.html', 'workspace/apps/bible/index.html']) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;          // live app is gitignored; template always exists
    const src = stripComments(fs.readFileSync(p, 'utf8'));
    const fn = /setConvoId:async\(k,id\)=>\{([\s\S]*?)\n  \},/.exec(src);
    assert.ok(fn, `${rel}: setConvoId exists`);
    assert.match(fn[1], /if\(k===null\|\|k===undefined\|\|k===''\) return \{ok:true\};/,
      `${rel}: a chapter file must never grow a scope named "null"`);
  }
});

test('the restore path is unchanged — a verse with a thread still reopens it', () => {
  // The fix must not cost the behaviour it exists to protect: opening a scope still reads the
  // stored pointer and adopts it, so an EXISTING conversation continues instead of forking.
  assert.match(CHAT, /const cid = await getCid\(k\);/, 'open() asks the host for the scope’s conversation');
  assert.match(CHAT, /curConvo = cid \|\| null;/, 'and adopts it, so the next send continues that thread');
  assert.match(CHAT, /const cid = curConvo;[\s\S]{0,80}const first=!cid;/,
    'send() continues curConvo and only creates a conversation when there is none');
});
