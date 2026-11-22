// Dragging a floating bar MOVES it · 拖动工具条应移动而非拉伸
//
// SCAR. Dragging the page bar's grip made it grow horizontally across the page instead of moving.
// Reported as "it enlarges the panel".
//
// The cause is a CSS positioning rule, not the drag maths. An absolutely positioned box with BOTH
// left and right set is STRETCHED between them — width stops being shrink-to-fit and becomes
// (containing block − left − right). makeMovable wrote `left` on every pointermove but never
// cleared `right`, and the page bar is the one bar anchored `right:8px` in CSS (the others use
// left:50% + translateX). So every drag left the CSS right anchor in place and pinned the bar's
// two edges to different points.
//
// It had already been got right vertically — `bottom:'auto'` and `transform:'none'` are cleared on
// the same line, for exactly this reason. `right` was simply missed, and only one bar in the set
// happened to use it.
//
// So the test is not "clear right". It is the INVARIANT that generalises: whatever a movable bar's
// stylesheet anchors it with, the drag must neutralise. A bar added later anchored `right` or
// `bottom` must not reintroduce this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);
const INSETS = ['left', 'right', 'top', 'bottom'];

// The CSS rules that position a bar the drag machinery can move.
const MOVABLE = ['.pan-bar', '.pan-tools', '.pan-pages', '.pan-fmt', '.pan-docktop'];
function ruleOf(sel) {
  const i = E.indexOf(`\n${sel}{`);
  return i < 0 ? '' : E.slice(i, E.indexOf('}', i) + 1);
}
const anchorsIn = (css) =>
  INSETS.filter((k) => new RegExp(`(^|[;{\\s])${k}\\s*:`).test(css))
    .concat(/(^|[;{\s])transform\s*:/.test(css) ? ['transform'] : []);

// The block that runs on every pointermove.
const MOVE = (() => {
  const m = /if\(!g\) return; const dx[\s\S]*?if\(dock\) dock\.hint/.exec(E);
  assert.ok(m, 'the pointermove body must be extractable');
  return m[0];
})();

test('the drag writes EVERY inset the stylesheet anchors a bar with', () => {
  const anchored = new Set();
  for (const sel of MOVABLE) for (const k of anchorsIn(ruleOf(sel))) anchored.add(k);
  assert.ok(anchored.has('right'), 'a bar in this set IS anchored by right — that is the scar');
  assert.ok(anchored.has('left') && anchored.has('bottom') && anchored.has('transform'));
  for (const k of anchored) {
    assert.match(MOVE, new RegExp(`style\\.${k}=`),
      `a bar is anchored with ${k}, so the drag must overwrite it or the bar stretches instead of moving`);
  }
});

test('opposite edges are never pinned at once — that is what stretches a box', () => {
  // The precise failure: left AND right both live at the end of a pointermove.
  const pairs = [['left', 'right'], ['top', 'bottom']];
  for (const [a, b] of pairs) {
    const setsA = new RegExp(`style\\.${a}=(?!'auto')`).test(MOVE);
    const setsB = new RegExp(`style\\.${b}=(?!'auto')`).test(MOVE);
    assert.ok(!(setsA && setsB), `${a} and ${b} must not both be given a value`);
    assert.match(MOVE, new RegExp(`style\\.${a}=|style\\.${b}=`), `${a}/${b} is addressed at all`);
  }
  assert.match(MOVE, /style\.right='auto'/, 'the right anchor is released');
  assert.match(MOVE, /style\.bottom='auto'/, 'as the bottom one already was');
});

test('docking hands every inset back to the stylesheet', () => {
  // dock() sheds the inline styles so the CSS layout owns the bar again. One left behind pins the
  // docked bar to a stale drag position.
  const dock = /const dock=\(\)=>\{[\s\S]*?docked=true; \};/.exec(E);
  assert.ok(dock, 'dock() must be findable');
  const shed = /barEl\.style\.[a-zA-Z=.]*='';/.exec(dock[0]);
  assert.ok(shed, 'dock() clears inline styles');
  for (const k of [...INSETS, 'transform']) {
    assert.ok(shed[0].includes(`style.${k}`), `dock() must release ${k} too`);
  }
});

test('the page bar is still anchored bottom-right by CSS when it has not been dragged', () => {
  // The other half: the fix must not "solve" the stretch by deleting the anchor. An undragged page
  // bar sits bottom-right, clear of the safe area, and that is its resting home.
  const pages = ruleOf('.pan-pages');
  assert.match(pages, /right:calc\(env\(safe-area-inset-right/, 'anchored right, inside the safe area');
  assert.match(pages, /bottom:calc\(env\(safe-area-inset-bottom/, 'and bottom');
  assert.match(pages, /left:auto/, 'with the shared left:50% centring explicitly cancelled');
  assert.match(pages, /transform:none/, 'and the shared translateX too');
});
