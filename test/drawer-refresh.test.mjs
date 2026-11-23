// The drawer's refresh button · 抽屉刷新按钮
//
// The list is drawn from whatever the host last handed over. When the note index has changed on
// disk — another device wrote it, a sync landed — the drawer shows the old list until something
// else happens to reload it. The ↺ button asks the host to re-read FIRST, then redraws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT } from './helpers-app.mjs';

test('a forced refresh re-reads from the host before redrawing', () => {
  const fn = /async function refresh\(forced\)\{[\s\S]*?draw\(\); \}/.exec(CHAT);
  assert.ok(fn, 'refresh must be findable');
  assert.ok(fn[0].indexOf('c.onRefresh()') < fn[0].indexOf('c.items()'),
    're-read first, then rebuild the list from what came back');
  assert.match(fn[0], /catch\(e\)\{ console\.warn\('\[PAChat\] onRefresh failed'/,
    'a failed re-read still redraws the list rather than leaving the drawer blank (R5)');
});

test('forced is compared to true, not merely truthy', () => {
  // refresh is EXPORTED on the drawer API. A host wiring it straight to a handler
  // (onclick=drawer.refresh) hands it an Event, which is truthy — every ordinary redraw would
  // silently become a disk re-read.
  assert.match(CHAT, /if\(forced===true&&c\.onRefresh\)/, 'an Event cannot force a re-read');
});

test('an ordinary redraw never re-reads', () => {
  // Every internal caller — opening the drawer, finishing a rename or delete — must stay cheap.
  for (const call of ['await refresh();']) {
    assert.ok(CHAT.includes(call), `${call} still exists unforced`);
  }
  // TWO callers force it now, and they are named rather than counted: a bare count would pass on
  // a third one added by accident, which is the thing this guards against. Ordinary internal
  // redraws — open, rename, delete — must still stay unforced and cheap.
  assert.equal((CHAT.match(/refresh\(true\)/g) || []).length, 2, 'only the two deliberate callers force it');
  const menu = /async function moreMenu\(anchor\)\{[\s\S]*?\n      await acts\[pick\]\.run\(\); \}/.exec(CHAT);
  assert.ok(menu && /\{label:'刷新 · Refresh',run:\(\)=>refresh\(true\)\}/.test(menu[0]), 'the ⋯ sheet\'s Refresh entry forces it');
  const wake = /const onWake=\(\)=>\{[\s\S]*?\n    \};/.exec(CHAT);
  assert.ok(wake && /refresh\(true\)/.test(wake[0]), 'and returning to the tab forces it');
});

test('the entry says what it is, in the header\'s ONE ⋯ sheet (owner 2026-11-11), and no ↺ button is left in the header', () => {
  assert.match(CHAT, /'<button class="pac-new pac-dmore" title="更多 · More" aria-label="更多 · More">⋯<\/button>'/, 'bilingual, like its neighbours');
  assert.doesNotMatch(CHAT, /pac-drefresh|pac-dsort|pac-dsel\b/, 'the three header buttons are gone (test/drawer-groups.test.mjs drives the sheet)');
});

test('the host handler is passed through listDrawer', () => {
  assert.match(CHAT, /onRefresh:o\.onRefresh,/, 'an app can supply its own re-read');
});
