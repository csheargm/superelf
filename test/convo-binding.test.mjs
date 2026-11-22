// A scope's conversation binding must not outlive the conversation.
//
// REPORTED: "I asked 'what signs it refers to?' but you created a totally new chat thread."
// MEASURED before changing anything, on live data:
//   · 45 Bible conversations holding exactly ONE exchange, 6 holding more;
//   · 4 of 9 verse→thread pointers naming a file that no longer exists;
//   · every missing file present in conversations/.trash — the user had DELETED them.
//
// THE CHAIN. Deleting a chat from the ☰ list tombstoned the file but left the verse pointing at
// it. The next turn then sent that dead id; the server could not load it and silently started a
// FRESH conversation (the guard above it covered UNREADABLE but not ABSENT); and the client
// ignored the new id because its `!cid` test meant "adopt an id only when I had none". So the
// binding stayed dead and the substitution repeated on every single turn — which is exactly what
// 45 one-exchange threads for the same verse look like.
//
// Three independent defences, because one of them failing should not resurrect the loop:
//   PREVENT  delete releases the scope that points at the conversation
//   HEAL     the client adopts whatever conversation the server actually used
//   REPORT   the server says when it substituted one, instead of doing it silently
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CHAT, stripComments } from './helpers-app.mjs';

const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');

test('HEAL: the client adopts the conversation the server actually used', () => {
  const code = stripComments(CHAT);
  assert.match(code, /ev\.type==='convo'&&ev\.id&&ev\.id!==cid/,
    "adopt on DIFFERENCE — `!cid` only adopted when we had no id, so a substituted thread was ignored");
  assert.ok(!/ev\.type==='convo'&&ev\.id&&!cid/.test(code), 'the old had-none-only test is gone');
  // The title is still only set for a genuinely new thread; adopting a substitute must not
  // rename a conversation the user already knows by name.
  assert.match(code, /if\(!cid&&\(myLoad===_loadSeq\|\|key===k\)\) setTitle\(/, 'a rebind does not retitle an existing conversation');
});

test('PREVENT: deleting a conversation releases the scope bound to it', () => {
  const code = stripComments(CHAT);
  assert.match(code, /kind:'convo-delete',convoId:c\.id\}\); unbindConvo\(c\.id\);/,
    'delete unbinds — the tombstone used to leave a live-looking binding behind');
  assert.match(code, /function unbindConvo\(id\)\{/, 'and there is one place that does it');
  const fn = /function unbindConvo\(id\)\{([\s\S]*?)\n    \}/.exec(code)[1];
  assert.match(fn, /opts\.unbindConvo/, 'a host that owns its own map is asked to forget');
  assert.match(fn, /convoMap\[kk\]===id/, 'and the built-in map is cleaned directly');
});

test('PREVENT: the Bible releases the verse, and the whole-Bible scope too', () => {
  for (const rel of ['workspace.example/apps/bible/index.html', 'workspace/apps/bible/index.html']) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const src = stripComments(fs.readFileSync(p, 'utf8'));
    const fn = /unbindConvo:\(id\)=>\{([\s\S]*?)\n  \},/.exec(src);
    assert.ok(fn, `${rel}: the Bible implements the hook`);
    assert.match(fn[1], /GEN\.chat===id/, `${rel}: the whole-Bible scope is released too`);
    assert.match(fn[1], /ANN\.chat\[k\]===id/, `${rel}: and every verse bound to it`);
    assert.match(fn[1], /saveAnn\(\)/, `${rel}: and the release is persisted`);
  }
});

test('REPORT: a substituted conversation is announced, never silent', () => {
  assert.match(WEB, /const replaced = !!\(convoId && !convo\);/,
    'the server knows when it could not honour the id it was given');
  assert.match(WEB, /line\(\{ type: 'convo', id: convo\.id, title: convo\.title, \.\.\.\(replaced \?/,
    'and says so on the event the client already listens to');
  // The neighbouring UNREADABLE guard must stay: a DAMAGED file is not a missing one, and
  // starting fresh over damage would destroy recoverable history.
  assert.match(WEB, /if \(prior\.state === FILE_UNREADABLE\)/, 'a damaged conversation is still refused, not replaced');
});
