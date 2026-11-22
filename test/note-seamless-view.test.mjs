// Seamless vs single page · 连续视图与单页视图
//
// Manual page flipping stays; seamless ADDS the other half — a surface that always has empty
// paper below the lowest ink, so writing carries on downwards without anyone reaching for a page
// button. Notability calls the same pair "seamless" and "single page".
//
// Two things make it honest rather than just taller:
//   1. WHERE A SHEET ENDS IS VISIBLE. A page taller than a sheet will be split at print time, so
//      an invisible fold means writing across a boundary the user only discovers at the printer.
//   2. IT IS CAPPED. The page is ONE canvas; 816 wide at five sheets is already ~20M device
//      pixels at dpr 2, and past that browsers hand back BLANK canvases — which looks exactly
//      like losing the note. Beyond the cap the note does what it always did: add a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments, SHELL } from './helpers-app.mjs';

const E = stripComments(ENGINE);

test('the View picker is WITHDRAWN, not the machinery behind it', () => {
  // Seamless as built makes one page TALLER rather than stacking pages, so scrolling never
  // reaches page 2. The design was wrong, and a half-right mode on a writing surface is worse
  // than no mode — so the two buttons came out while the rendering path stayed. Reinstating it
  // should be putting the buttons back, not rebuilding it.
  assert.doesNotMatch(E, /data-view="seamless"/, 'the picker is not offered');
  assert.match(E, /const SEAMLESS_WITHDRAWN=true;/, 'and the withdrawal is explicit, not an accident of markup');
  assert.match(E, /function setSeamless\(on\)\{ if\(SEAMLESS_WITHDRAWN\) return;/, 'the setter refuses');
  // Including for a device that already stored the preference from when it shipped.
  assert.match(E, /m\.pa==='prefs'&&!SEAMLESS_WITHDRAWN&&typeof m\.seamless==='boolean'/,
    'a stored preference cannot switch it back on');
  // The path itself is still there — print's sheet splitting is built on the same geometry.
  assert.match(E, /if\(live&&seamless&&h>PAGE_H\)/, 'the divider code survives');
  assert.match(E, /seamless\n\s*\? PAGE_H\*Math\.max\(2,/, 'as does the whole-sheet height it needs');
});

test('seamless keeps a screenful of paper below the ink; single page keeps breathing room', () => {
  const line = /const tail=seamless\?([^:]+):PAGE_TAIL_PX;/.exec(E);
  assert.ok(line, 'the tail must depend on the view');
  assert.match(line[1], /r\.height/, 'seamless measures the screen, so there is always somewhere to write');
  assert.match(line[1], /Math\.max\(PAGE_TAIL_PX/, 'and never less than the single-page tail');
});

test('the surface is capped, because a blank canvas looks like a lost note', () => {
  assert.match(E, /const SEAMLESS_MAX_SHEETS=5;/, 'the cap is named');
  assert.match(E, /Math\.min\(SEAMLESS_MAX_SHEETS,Math\.ceil\(want\/PAGE_H\)\)/,
    'and applied as a ceiling on the number of sheets');
});

test('the sheet boundary is drawn on SCREEN only', () => {
  // A divider on paper would be a line printed across the note. drawPaper already knows which
  // render it is doing (`live`), so this rides that rather than inventing a second signal.
  const fn = /function drawPaper\(ctx,h,bg,fit\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'drawPaper must be findable');
  assert.match(fn[0], /if\(live&&seamless&&h>PAGE_H\)/, 'live, seamless, and only when taller than a sheet');
  assert.match(fn[0], /for\(let y=PAGE_H;y<h;y\+=PAGE_H\)/, 'one line per sheet boundary');
  assert.match(fn[0], /setLineDash/, 'dashed and faint — information, not decoration');
  // Drawn last, or the rule lines would sit on top of it.
  assert.ok(fn[0].lastIndexOf('setLineDash') > fn[0].indexOf('ctx.clearRect'), 'after the paper itself');
});

test('the device-level plumbing is intact for when it returns', () => {
  assert.match(E, /kind:'pref',seamless/, 'the pad reports it');
  assert.match(E, /typeof m\.seamless==='boolean'/, 'and accepts it back');
  assert.match(SHELL, /localStorage\.setItem\('pa_seamless', m\.seamless\?'1':'0'\)/, 'the shell stores it');
  assert.match(SHELL, /seamless:localStorage\.getItem\('pa_seamless'\)==='1'/, 'and pushes it to every app');
});

test('the default-off polarity is read the right way round', () => {
  // printInk defaults ON and must be read with !=='0'. This one defaults OFF, so it must be
  // ==='1'. Copying the wrong neighbour silently inverts the default for everyone.
  assert.doesNotMatch(SHELL, /seamless:localStorage\.getItem\('pa_seamless'\)!=='0'/,
    'seamless defaults OFF — !== "0" would turn it on for every existing device');
});

test('changing the view re-measures rather than waiting for a resize', () => {
  // The height depends on the view, and nothing else would make the page grow until the window
  // happened to change size.
  assert.match(E, /syncPaperPickers\(\); onResize\(\);/, 'the setter re-measures');
  assert.match(E, /m\.seamless!==seamless\)\{ seamless=m\.seamless; syncPaperPickers\(\); onResize\(\); \}/,
    'and so does the pref arriving from the shell — but only when it actually changed');
});

test('seamless is always at least two sheets, rounded to whole ones', () => {
  // Reported as "there is no dotted line". Two bugs in one expression: the height landed on an
  // arbitrary value like 1060, so the divider — whose loop starts AT one sheet — was drawn 4px
  // from the bottom edge where nobody sees it; and on a note short enough to want less than one
  // sheet the height stayed at exactly PAGE_H, so the loop never ran and seamless was
  // indistinguishable from single page.
  assert.match(E, /PAGE_H\*Math\.max\(2,Math\.min\(SEAMLESS_MAX_SHEETS,Math\.ceil\(want\/PAGE_H\)\)\)/,
    'whole sheets, never fewer than two');
  // Whole sheets also put the fold on screen exactly where print breaks — the divider is only
  // honest if those two agree.
  assert.match(E, /sheetH:PAGE_H,/, 'and that is the same sheet print is told about');
});
