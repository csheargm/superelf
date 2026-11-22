// Changing the font size changes the font size · 字号选择必须真的改变字号
//
// SCAR. Choosing a size from the picker moved the CARET and left the text untouched.
//
// The cause is not in the size command. Pressing ANY toolbar control takes focus off the
// contenteditable region, which collapses the selection and fires selectionchange — and the
// selectionchange listener answered by calling saveSel(), overwriting the user's real selection
// with the collapsed caret that the focus move had just created. By the time the control's own
// handler ran, restoreSel() put back a caret, and execCommand styled nothing.
//
// Every command had this. The size picker showed it worst because a <select> needs TWO
// interactions to complete — open, then choose — so there is far more time for a selectionchange
// to land in between.
//
// Second, smaller defect: syncFmtState only ever synced the [data-cmd] buttons, so the picker
// reported whatever was chosen last. Moving the caret into 32px text still read 18 — the control
// was lying about the document, which reads as "it didn't take effect".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);

test('the saved selection cannot be overwritten while a control is being operated', () => {
  assert.match(E, /function saveSel\(\)\{ if\(selFrozen\) return;/,
    'saveSel must refuse to re-save while frozen — that overwrite IS the bug');
  // The freeze blocks SAVING only. If it blocked restoring, every command would target the
  // caret instead of the selection, which is the same defect wearing a different hat.
  const restore = /function restoreSel\(\)\{[^}]*\}/.exec(E);
  assert.ok(restore, 'restoreSel must be findable');
  assert.doesNotMatch(restore[0], /selFrozen/, 'restoring is never blocked');
});

test('the selection is recorded BEFORE focus leaves the region', () => {
  // On pointerdown the selection is still the user's; one tick later it is gone. Capture phase,
  // or the region's own handlers run first and the value saved is already collapsed.
  const arm = /fmtBar\.addEventListener\('pointerdown',\(\)=>\{([^}]*)\},true\);/.exec(E);
  assert.ok(arm, 'the bar must arm the freeze on pointerdown, in the capture phase');
  assert.match(arm[1], /selFrozen=false; saveSel\(\); selFrozen=true;/,
    'save first, then freeze — freezing first would save nothing');
});

test('the freeze is released by every command, and by a return to the text', () => {
  // A freeze that outlives its command would pin the selection forever: the next command would
  // target wherever the last one left off, which is worse than the original bug.
  assert.match(E, /function endFmt\(sync\)\{ selFrozen=false; saveSel\(\);/, 'commands end by unfreezing');
  const enders = (E.match(/endFmt\(/g) || []).length;
  assert.ok(enders >= 5, `every command routes through it (found ${enders} references)`);
  assert.doesNotMatch(E, /\}catch\(_\)\{ \/\* size no-op[^}]*\}\n\s*saveSel\(\); \}/,
    'no command still ends with a bare saveSel()');
  for (const ev of ['pointerdown', 'keydown']) {
    assert.match(E, new RegExp(`textLayer\\.addEventListener\\('${ev}',\\(\\)=>\\{ selFrozen=false; \\}\\);`),
      `returning to the text by ${ev} releases it`);
  }
});

test('the picker reports the size at the caret', () => {
  assert.match(E, /function caretFontPx\(\)\{/, 'the current size is measurable');
  // Measured from the DOM. queryCommandValue('fontSize') answers in the 1-7 <font> scale, which
  // this app deliberately does not use — it converts <font size=7> into span[style=font-size:px].
  const fn = /function caretFontPx\(\)\{[\s\S]*?\n    \}/.exec(E);
  assert.match(fn[0], /getComputedStyle\(n\)\.fontSize/, 'read from the DOM, not the <font> scale');
  assert.doesNotMatch(fn[0], /queryCommandValue/, 'the 1-7 scale would report a size this app never sets');
  assert.match(fn[0], /textLayer\.contains\(n\)/, 'and only when the caret is actually in the region');
  // It must not fight the user mid-choice.
  assert.match(E, /if\(sel&&!selFrozen\)\{ const px=caretFontPx\(\);/,
    'the picker is not rewritten while it is being operated');
  assert.match(E, /some\(o=>\+o\.value===px\)/,
    'and only snaps to a size it actually offers, rather than inventing an option');
});

test('the size command does not go through execCommand at all', () => {
  // SCAR, second round. It used execCommand('fontSize','7') and rewrote the resulting <font> into
  // a span. That is correct in Blink (measured in a browser) and unreliable elsewhere, because it
  // depends on the ENGINE still holding the user's selection after focus has gone to the <select>
  // and come back. Wrapping the saved Range ourselves depends on nothing but the range.
  const fn = /function fmtFontSize\(px\)\{[\s\S]*?endFmt\(false\); \}/.exec(E);
  assert.ok(fn, 'fmtFontSize must be findable');
  assert.doesNotMatch(fn[0], /execCommand/, 'no engine command in the size path');
  assert.match(fn[0], /savedRange&&el\.contains\(savedRange\.commonAncestorContainer\)/,
    'the range is checked against the region before anything is touched');
  assert.match(fn[0], /r\.collapsed \? sizeBlock\(r,px,el\) : sizeRange\(r,px\)/,
    'a selection is wrapped; a bare caret sizes its block');
});

test('a bare caret sizes the paragraph, the way a word processor does', () => {
  // The case execCommand could not express: with no selection it only sets the TYPING style, so
  // nothing on screen changes and the control reads as dead. Verified in a browser:
  //   <div>first</div><div>second</div>, caret in the second → the second div carries the size.
  const fn = /function sizeBlock\(r,px,el\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'sizeBlock must be findable');
  // The list grew when paragraph styles arrived — a caret in a Title has to find the Title, not
  // walk past it. What is pinned is that the set is NAMED and covers the ordinary body blocks;
  // which blocks a STYLE can produce belongs to test/note-text-styles.test.mjs.
  assert.match(E, /const BLOCK_TAGS=\/\^\([A-Z0-9|]+\)\$\//, 'the blocks it walks up to are named');
  for (const t of ['P', 'DIV', 'LI']) assert.ok(/const BLOCK_TAGS=\/\^\(([A-Z0-9|]+)\)\$\//.exec(E)[1].split('|').includes(t),
    `${t} is still one of them`);
  assert.match(fn[0], /b\.style\.fontSize=px\+'px'/, 'the block carries the size');
  // A fresh note is bare text in the region until the first Enter. Sizing the REGION would style
  // every future paragraph, so that case wraps what is there — and only when nothing block-level
  // exists to catch it.
  assert.match(fn[0], /if\(!el\.querySelector\(BLOCK_SEL\)\)/, 'the bare-text case is guarded');
  assert.doesNotMatch(fn[0], /el\.style\.fontSize/, 'the region itself is never sized');
  assert.match(fn[0], /return false;/, 'and it reports when it could not size anything');
});

test('re-sizing strips the size already inside the selection', () => {
  // A nested span[font-size] out-specifies the new wrapper, so part of the text refuses to change
  // — "it only worked on some of it". Verified in a browser: sizing 48px text to 24px leaves one
  // span and zero nested sizes.
  const fn = /function sizeRange\(r,px\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'sizeRange must be findable');
  assert.match(fn[0], /n\.style\.removeProperty\('font-size'\)/, 'inner sizes are dropped');
  assert.match(fn[0], /if\(!n\.getAttribute\('style'\)\)/, 'and a span left saying nothing is unwrapped');
  assert.match(fn[0], /savedRange=nr\.cloneRange\(\)/, 'the new span becomes the selection, so a second change lands on it');
});

test('a scripted edit still gets saved', () => {
  // The region persists through an 'input' listener, and programmatic DOM changes fire no input
  // event. Without this the size is applied on screen and lost on reload — the save-skip shape.
  const fn = /function fmtFontSize\(px\)\{[\s\S]*?endFmt\(false\); \}/.exec(E)[0];
  assert.match(fn, /onTextInput\(\);/, 'the commit is triggered by hand');
  assert.ok(fn.indexOf('onTextInput();') > fn.indexOf('const done='), 'after the edit, not before');
  assert.match(E, /const onTextInput=\(\)=>\{ clearTimeout\(textTimer\); textTimer=setTimeout\(commitPageHtml/,
    'and that is the same debounce typing uses');
});

test('nothing to size says so instead of failing silently', () => {
  const fn = /function fmtFontSize\(px\)\{[\s\S]*?endFmt\(false\); \}/.exec(E)[0];
  assert.match(fn, /if\(!done\)\{ flash\(/, 'the user is told (R5)');
  assert.match(fn, /请先选择要改变字号的文字/, 'bilingual, like every other message here');
});
