// A tap on stacked pictures selects the one on TOP (owner, 2026-11-08).
//
// Pictures paint in array order, so the newest import sits over the older ones. The hit-tests used
// findIndex — the FIRST match, i.e. the bottom picture — so a new photo dropped over an old one could
// not be selected: the old one lit up every time. One helper (imageAt) scans the paint order backwards.
// R11 — searched: "findIndex(im", "findLastIndex", "imageAt", "SEL_TAP_PX" — no duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);
const helper = /const imageAt=\(nx,ny\)=>page\(\)\.images\.findLastIndex\((im=>[^\n]*?)\);\n/.exec(E);

test('imageAt returns the top-most (last-painted) picture under the point', () => {
  assert.ok(helper, 'imageAt is one line scanning the paint order backwards');
  const images = [{ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }];  // [1] imported later, drawn on top
  const imageAt = new Function('page', `${helper[0]}\nreturn imageAt;`)(() => ({ images }));
  assert.equal(imageAt(0.3, 0.3), 1, 'inside both → the newer one');
  assert.equal(imageAt(0.15, 0.15), 0, 'inside only the old one → the old one');
  assert.equal(imageAt(0.9, 0.9), -1, 'outside both → nothing');
});

test('every picture hit-test goes through imageAt — no bottom-first findIndex is left', () => {
  assert.doesNotMatch(E, /images\.findIndex\(im=>/, 'the bug pattern must not come back anywhere (enumerate, do not patch one site)');
  const uses = E.match(/imageAt\(/g) || [];
  assert.ok(uses.length >= 3, `double-tap + dblclick + select-tap call sites at least, got ${uses.length}`);
});

test('a TAP with the select tool picks the top picture; a DRAG still box-selects everything', () => {
  const up = /function selUp\(\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(up, 'selUp must be findable');
  assert.match(up[0], /tap=r\.w\*W<SEL_TAP_PX&&r\.h\*W<SEL_TAP_PX, top=tap\?imageAt\(r\.x,r\.y\):-1/, 'a tap is a marquee under SEL_TAP_PX in both directions');
  assert.match(up[0], /sel= top>=0\?\[\{kind:'image',i:top\}\]:itemsInRect\(r\)/, 'top picture wins; otherwise the old box-select');
  assert.match(E, /const SEL_TAP_PX=4;/, 'the tap threshold is a named constant');
});

test('a tap inside an existing selection box switches to the picture on top under it', () => {
  // With the bottom picture selected, the top one lies inside the selection box (+pad), so selDown
  // starts a moveDrag instead of a marquee. If that drag never moves, it was a tap: select the top picture.
  const up = /function selUp\(\)\{[\s\S]*?\n    \}/.exec(E)[0];
  assert.match(up, /const \{moved,lx,ly\}=moveDrag; moveDrag=null; if\(moved\)\{ touchPage\(\); scheduleSave\(\); return; \}/, 'a real move saves and stops');
  assert.match(up, /const top=imageAt\(lx,ly\); if\(top>=0&&!\(sel\.length===1&&sel\[0\]\.kind==='image'&&sel\[0\]\.i===top\)\)\{ sel=\[\{kind:'image',i:top\}\]; redrawPage\(\); \}/, 'an unmoved tap re-targets the top picture');
});
