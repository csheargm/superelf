// Multi-select · 多选 in the shared drawer.
//
// Asked for after a long session left dozens of stale conversations: deleting them one at a time
// through the ⋯ sheet is fine for one and not fine for forty.
//
// The part that needs a test is not the ticking — it is the DELETE. A bulk action that reports
// success because it merely finished is the vacuous-success shape (R14). If 3 of 10 fail, the
// user must be told 3 failed, and those 3 must stay selected so a retry does not mean finding
// them by hand again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, stripComments } from './helpers-app.mjs';

const CODE = stripComments(CHAT);

test('selection is a MODE, not a permanent checkbox column', () => {
  // The drawer's everyday job is opening ONE thing; a permanent column of boxes beside every row
  // makes the common action look like the rare one.
  assert.match(CODE, /let _multi=false; const _picked=new Set\(\);/, 'mode + picked set');
  assert.match(CODE, /list\.classList\.toggle\('pac-multi',_multi\)/, 'the mode is a class on the panel');
  assert.match(CHAT, /\.pac-list\.pac-multi \.pac-lrow \.pac-lbox\{display:block\}/, 'boxes appear only in the mode');
  assert.match(CHAT, /\.pac-list\.pac-multi \.pac-lmenu\{display:none\}/, 'and the per-row ⋯ steps aside');
});

test('a row that cannot be deleted offers no tick', () => {
  // Offering a tick that is then silently skipped is worse than not offering one.
  assert.match(CODE, /const box=\(_multi&&it\.onDelete\)\?'<div class="pac-lbox"><\/div>':'';/,
    'no onDelete, no box');
  assert.match(CODE, /if\(!it0\.onDelete\) return;/, 'and a tap on such a row does nothing');
});

test('in select mode a tap TICKS instead of opening', () => {
  // Opening would navigate away from the selection being built.
  const h = /if\(_multi\)\{([\s\S]*?)\n      \}/.exec(CODE);
  assert.ok(h, 'the row handler branches on the mode');
  assert.match(h[1], /_picked\.delete\(id\); row\.classList\.remove\('picked'\)/, 'untick');
  assert.match(h[1], /_picked\.add\(id\); row\.classList\.add\('picked'\)/, 'tick');
  assert.match(h[1], /syncBulk\(\); return;/, 'and never reaches the open handler');
  // Measured: calling draw() per tick rebuilt every row and DETACHED the one under the finger,
  // so rapid ticks were dropped and the scroll position jumped. Only the row may be touched.
  assert.ok(!/\bdraw\(\)/.test(h[1]), 'a tick must not rebuild the whole list');
});

test('bulk delete counts what ACTUALLY went, and says so', () => {
  const fn = /async function bulkDelete\(\)\{([\s\S]*?)\n    \}/.exec(CODE);
  assert.ok(fn, 'bulkDelete exists');
  const body = fn[1];
  assert.match(body, /pacConfirm\(host,/, 'destructive, so it confirms first');
  assert.match(body, /Delete \$\{ids\.length\} entries\?/, 'and the confirmation carries the COUNT');
  assert.match(body, /if\(r&&r\.ok===false\) failed\.push\(id\); else ok\+\+;/,
    'an outcome of {ok:false} is a FAILURE, not a completed call');
  assert.match(body, /catch\(e\)\{ failed\.push\(id\);/, 'and a throw is too');
  assert.match(body, /\$\{ok\} deleted, \$\{failed\.length\} failed/, 'a partial result is reported as partial');
  assert.match(body, /failed\.forEach\(\(id\)=>_picked\.add\(id\)\)/,
    'and what failed stays ticked, so a retry does not mean re-finding them');
  // Only a CLEAN run leaves the mode.
  assert.match(body, /\} else \{ setMulti\(false\); \}/, 'the mode closes only when everything went');
});

test('each row deletes through its OWN handler — one delete path, not two', () => {
  // This is why bulk deletion inherits the v2.76.0 unbind fix for free: a chat row's onDelete
  // already releases the scope bound to it. A second delete path would have to relearn that.
  assert.match(CODE, /const it=itemOf\(id\);\s*if\(!it\.onDelete\)\{ failed\.push\(id\); continue; \}\s*try\{ const r=await it\.onDelete\(\);/,
    'bulk delete calls the same per-row onDelete the ⋯ sheet calls');
  assert.match(CODE, /kind:'convo-delete',convoId:c\.id\}\); unbindConvo\(c\.id\);/,
    'and that handler is the one that unbinds the scope');
});

test('leaving the drawer does not leave a half-built selection armed', () => {
  assert.match(CODE, /function close\(\)\{ if\(_multi\) setMulti\(false\);/,
    'closing exits the mode — a stale selection waiting on reopen would be a trap');
});

test('shift-click selects the range between the anchor and the clicked row', () => {
  const b = CODE;
  // The anchor moves on a PLAIN tap only — a shift-click that moved it would make each
  // subsequent shift-click measure from the last range's end instead of the user's start point.
  assert.match(b, /_anchor=id;/, 'a plain tap sets the anchor');
  const branch = b.match(/if\(e\.shiftKey[^\n]*\n/)[0];
  assert.match(branch, /_anchor/, 'the range is measured from the anchor');
  assert.match(branch, /pickRange\(/, 'shift delegates to pickRange');
  // Guards: no anchor yet, or shift-clicking the anchor itself, must fall through to a plain tick
  // rather than "select a range of one" — which would silently do nothing.
  assert.match(branch, /_anchor\s*&&\s*_anchor\s*!==\s*id/, 'shift without an anchor, or onto it, ticks normally');
  // The anchor must stay put across a shift-click. If shift moved it, a second shift-click would
  // measure from the end of the first range instead of the row the user started from — so
  // widening a selection by one row would instead drag it away from the start.
  assert.ok(!/_anchor\s*=/.test(branch), 'a shift-click does not move the anchor');
});

test('a range is measured in the DRAWN order and skips rows with no box', () => {
  const b = CODE;
  assert.match(b, /_shown=groups\?groups\.drawn\(\):shown;/, 'draw() records the order actually rendered: the groups\' drawn order (closed groups left out) when the component is on the page');
  const fn = b.match(/function pickRange\([\s\S]*?\n    \}/)[0];
  // _items is the unfiltered set; a range measured there spans rows the user cannot see, so a
  // search or a tab switch would silently tick hidden entries — in a DELETE queue.
  assert.ok(!/_items/.test(fn), 'pickRange must not measure against the unfiltered list');
  assert.match(fn, /_shown\.findIndex/, 'both ends are located in the drawn order');
  assert.match(fn, /if\(a<0\|\|b<0\) return/, 'an end outside the current filter selects nothing');
  assert.match(fn, /Math\.min\(a,b\)[\s\S]*Math\.max\(a,b\)/, 'ranges work in both directions');
  assert.match(fn, /if\(it&&it\.onDelete\) _picked\.add/, 'rows with no box are skipped, not ticked');
  // Same reason the single tick does not redraw: a range touches many rows at once.
  assert.ok(!/\bdraw\(\)/.test(fn), 'a range must not rebuild the whole list');
});

test('leaving select mode forgets the anchor', () => {
  // A stale anchor would let the next session's first shift-click sweep in rows from the last one.
  assert.match(CODE.match(/function setMulti\([\s\S]*?\n    \}/)[0], /_anchor=null/, 'setMulti clears it');
});

test('shift-clicking does not smear a text selection over the rows', () => {
  // Every browser selects text on shift-click; without this the ticks are painted over in blue.
  assert.match(CHAT, /\.pac-list\.pac-multi \.pac-lrows\{[^}]*user-select:none/, 'suppressed in mode only');
});
