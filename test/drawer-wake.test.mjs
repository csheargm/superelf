// The conversation list re-reads itself when you come back · 回到页面时重新读取列表
//
// Reported: a laptop left open overnight still listed the previous day's conversations as the
// newest, while the same account on a phone listed them correctly. The list is fetched once, at
// load, and nothing ever asks again — there is no polling and no push. (That report turned out to
// ALSO involve being signed in as a different user, but this gap is real and independent: chats
// made on one device never appear on another already-open one.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT = fs.readFileSync(path.join(ROOT, 'web', 'chat-ui.inline.html'), 'utf8');
const handler = () => {
  const m = /const onWake=\(\)=>\{[\s\S]*?\n    \};/.exec(CHAT);
  assert.ok(m, 'onWake must be findable');
  return m[0];
};

test('coming back to the tab re-reads the list', () => {
  const fn = handler();
  assert.match(fn, /refresh\(true\)/, 'a FORCED refresh, so the host re-pulls rather than redrawing stale items');
  assert.match(CHAT, /document\.addEventListener\('visibilitychange',onWake\)/, 'tab becomes visible');
  assert.match(CHAT, /window\.addEventListener\('focus',onWake\)/, 'and window regains focus');
});

test('it is NOT polling — nothing happens while nobody is looking', () => {
  // A timer would cost every device in the household something, forever, to fix a problem that
  // exists only at the instant someone looks — and browsers throttle background timers, so it
  // would be least reliable exactly when it had to be right.
  const fn = handler();
  assert.match(fn, /if\(document\.visibilityState==='hidden'\) return;/, 'hidden tabs do nothing');
  assert.ok(!/setInterval/.test(fn), 'no interval in the wake path');
  // The only setInterval in the component is the elapsed-time ticker for a message in flight.
  assert.equal((CHAT.match(/setInterval\(/g) || []).length, 1, 'still exactly one timer in the whole component');
});

test('one tab switch causes one fetch, not two', () => {
  // focus and visibilitychange both fire. Without the throttle every return to the tab would
  // double every request the host makes in onRefresh.
  const fn = handler();
  assert.match(fn, /if\(now-_woke<WAKE_MIN_MS\) return;/, 'throttled');
  assert.match(CHAT, /const WAKE_MIN_MS=3000;/, 'with the window defined once');
});

test('the listener cannot outlive the drawer', () => {
  // It is on `document`, which outlives the element that owns it. Two defences, because I left an
  // anonymous one leaking earlier the same day and would rather not rely on callers remembering.
  const fn = handler();
  assert.match(fn, /if\(!host\.isConnected\)\{/, 'a torn-down drawer unhooks itself on the next event');
  assert.match(CHAT, /destroy:\(\)=>\{ document\.removeEventListener\('visibilitychange',onWake\); window\.removeEventListener\('focus',onWake\); \}/,
    'and the drawer exposes a real teardown');
});

test('CONTROL: refresh(true) is the same path the Refresh button uses', () => {
  // If the wake path called something of its own, the button and the automatic refresh could
  // drift into fetching different things (R3).
  assert.match(CHAT, /async function refresh\(forced\)\{\s*\n?\s*if\(forced===true&&c\.onRefresh\)/,
    'one refresh function, taking the same forced flag');
});
