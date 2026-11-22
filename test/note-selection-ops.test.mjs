// What you can do with a selection of handwriting · 手写选区的操作
//
// It could be moved, resized and deleted, and nothing else. No copy, no paste onto another page,
// and no way to ask the AI what the writing says — which, for a handwriting app, is the question
// people most want to ask of it. ("AI 能否识别我的手写字?" was literally the note that reported this.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);

test('the clipboard stores the selection RELATIVE to its own box', () => {
  // Absolute coordinates would paste a copy back on top of the original, and land nowhere sensible
  // on a different page — which is the case this exists for.
  const fn = /function copySel\(cut\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'copySel must be findable');
  assert.match(fn[0], /pt\[0\]=round4\(pt\[0\]-b\.x\); pt\[1\]=round4\(pt\[1\]-b\.y\);/, 'strokes are made box-relative');
  assert.match(fn[0], /x:round4\(im\.x-b\.x\),y:round4\(im\.y-b\.y\)/, 'and so are images');
  // cloneStroke, not a reference: translateSel mutates points IN PLACE, so a shallow copy would
  // let a later drag of the original silently rewrite the clipboard.
  assert.match(fn[0], /cloneStroke\(pg\.strokes\[it\.i\]\)/, 'strokes are deep-cloned');
});

test('paste lands as a unit, nudged and clamped', () => {
  // Verified numerically: a 0.2 x 0.14 selection copied from (0.20,0.30) pastes as 0.2 x 0.14 at
  // (0.08,0.10) — congruent, on the page, and the original untouched.
  const fn = /function pasteSel\(\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'pasteSel must be findable');
  assert.match(fn[0], /pushUndo\(\)/, 'undoable');
  assert.match(fn[0], /Math\.max\(0,Math\.min\(0\.98-_selClip\.w/, 'clamped so it cannot land off the page');
  assert.match(fn[0], /sel=added;/, 'the paste is selected, so it can be dragged into place at once');
  assert.match(fn[0], /touchPage\(\); scheduleSave\(\);/, 'and it is saved');
  assert.match(E, /if\(!_selClip\)\{ flash\(SEL_TXT\.empty\); return; \}/, 'an empty clipboard says so (R5)');
});

test('copy works across pages because nothing in the clipboard names a page', () => {
  // The whole point of "paste to another page": the clipboard holds geometry, not a page id, so
  // pasteSel writes into whatever page() is current when it runs.
  const fn = /function pasteSel\(\)\{[\s\S]*?\n    \}/.exec(E)[0];
  assert.match(fn, /const pg=page\(\);/, 'it writes into the CURRENT page');
  assert.doesNotMatch(/let _selClip=null;[^\n]*/.exec(E)[0], /page|id/i, 'and the clipboard names no page');
});

test('Ask AI renders the selection to ink on white, not a screenshot', () => {
  const fn = /function renderSelPng\(\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'renderSelPng must be findable');
  assert.match(fn[0], /ctx\.fillStyle='#ffffff'/, 'white ground, so the model reads ink');
  assert.match(fn[0], /scale=2/, 'at better than screen resolution');
  assert.match(fn[0], /w\*h>12e6/, 'with a canvas-area guard — iOS returns a BLANK canvas past its cap');
  // Images inside the selection go through the pad's own renderer, given a fake page carrying
  // only them, rather than a second copy of that drawing code (R3).
  assert.match(fn[0], /drawImages\(\{images:sel\.filter/, 'images reuse drawImages');
  assert.match(fn[0], /s\.t==='highlighter'[\s\S]*?s\.t!=='highlighter'/, 'highlighter behind the ink, as on screen');
});

test('Ask AI uploads once and hands over a PATH', () => {
  const fn = /async function askSelection\(\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'askSelection must be findable');
  assert.match(fn[0], /window\.PAPhoto\.toFile\(url,'handwriting\.png'\)/, 'the data URL becomes a File');
  assert.match(fn[0], /opts\.uploadImage\(file\)/, 'uploaded through the host hook');
  assert.match(fn[0], /opts\.onAskImage\(\{path/, 'and the chat is given a path, not the bytes again');
  assert.match(fn[0], /if\(!path\)\{ flash\(SEL_TXT\.noUp\); return; \}/, 'a failed upload says so rather than silently doing nothing (R5)');
});

test('the ⋯ handle means the same thing whatever is selected', () => {
  // A picture keeps the image menu (it has crop and the rest); anything else gets the selection
  // menu. Same place, same shape — an affordance that changes meaning with the selection is worse
  // than two affordances.
  assert.match(E, /if\(!im && sel\.length\)\{ const b=selBBox\(\);/, 'the handle is hit-tested for a non-image selection');
  assert.match(E, /openSelMenu\(\); return;/, 'and opens the selection menu');
  assert.match(E, /if\(!singleImage\(\)\)\{\n\s*ctx\.fillStyle='#2f6fed'; ctx\.beginPath\(\); ctx\.arc\(\(b\.x\+b\.w\)\*W,b\.y\*W,7/,
    'drawn at the selection box top-right, like the image one');
});

test('the selection menu is placed in SCREEN px and joins the one-at-a-time set', () => {
  const fn = /function openSelMenu\(at\)\{[\s\S]*?\n    \}/.exec(E)[0];
  assert.match(fn, /k=pageK\(r\)/, 'scaled — the same unit bug the image menu had');
  assert.match(fn, /Math\.max\(8,Math\.min\(at\?hx:hx-pw\+12,hr\.width-pw-8\)\)/, 'and clamped inside the host');
  assert.match(E, /for\(const s2 of \['\.pan-imgpop','\.pan-selpop'\]\)/, 'closePops closes it');
  // Its own class: sharing .pan-imgpop made q() ambiguous between the two popovers.
  assert.doesNotMatch(E, /pan-imgpop pan-selpop/, 'it does not borrow the image menu class');
});

test('Ask AI is offered only where the host can service it', () => {
  assert.match(E, /showRow\(q\('\.pan-selaskopt'\), !!\(opts\.onAskImage&&opts\.uploadImage\)\)/,
    'both hooks are required — rendering is useless without somewhere to put the bytes');
  // ONE Paste control, two clipboards. Copying an image clears a copied selection and vice
  // versa, so "paste" always means the last thing copied rather than whichever the code checked
  // first — and every Paste row in the pad is shown from that one reading.
  assert.match(E, /function syncPasteRows\(\)\{ const has=!!clipKind\(\);/, 'one function shows every Paste row');
  assert.match(E, /showRow\(q\('\.pan-pgpaste'\), has\); showRow\(q\('\.pan-selpasteopt'\), has\);/,
    'the page menu and the selection menu agree');
  assert.match(E, /function clipKind\(\)\{ return _selClip\?'sel':\(_imgClip\?'img':null\); \}/,
    'and which clipboard is live has one definition');
});

test('Insert photo is a HEADER button, at the same level as the mode tabs', () => {
  // It lived in the drawing row, so Text mode could not insert a photo at all. Putting it in the
  // ⋯ panel fixed the reach but buried it: a photo is a top-level action, not a setting. It now
  // sits beside Draw / Text / ⋯ / print, where it is one tap in either mode.
  const bar = /\(hasTop\?'<div class="pan-top">'[\s\S]*?'<\/div>'/.exec(E);
  assert.ok(bar, 'the header markup must be findable');
  assert.match(bar[0], /class="pan-hphoto"/, 'the photo button is in the header');
  assert.ok(bar[0].indexOf('pan-hphoto') < bar[0].indexOf('pan-hprint'), 'beside the print button');
  assert.match(bar[0], /\(imgHooks\?'<button class="pan-hphoto"/, 'and only where the host can store bytes');
});

test('exactly ONE photo control exists per surface', () => {
  // Two buttons for one job can disagree about which is lit, and the ⋯ row was a third. The
  // drawing row keeps its copy only in MOUNT mode, where there is no header to promote it to —
  // the same rule the T tool follows.
  assert.match(E, /\(imgHooks&&!hasTop\?'<span class="pan-sep"><\/span><button class="pan-tbtn pan-photo"/,
    'the row copy is header-conditional');
  assert.doesNotMatch(E, /data-pg="photo"/, 'and the ⋯ menu row is gone');
  assert.match(E, /photoBtn=q\('\.pan-hphoto'\)\|\|q\('\.pan-photo'\)/,
    'one variable resolves to whichever surface has one, so the wiring is written once');
});

test('Paste stays a PAGE action in the ⋯ panel', () => {
  // Unlike a photo, paste has no meaning until something has been copied, so it is a row that
  // appears rather than a button that sits there doing nothing.
  assert.match(E, /data-pg="paste"/, 'Paste is in the page menu');
  assert.match(E, /class="pan-photoopt pan-pgpaste" data-pg="paste" style="display:none"/,
    'hidden until there is something to paste');
});

test('right-click opens the same menu, under the pointer', () => {
  // A context menu that opens at a corner of the selection instead of where you clicked reads as
  // a different control. `at` is in host coordinates already, so it is used as-is.
  const fn = /ink\.addEventListener\('contextmenu',\(e\)=>\{[\s\S]*?\n    \}\);/.exec(E);
  assert.ok(fn, 'the contextmenu handler must be findable');
  assert.match(fn[0], /if\(im\) openImgMenu\(im,at\); else openSelMenu\(at\);/, 'the same two menus as the ⋯');
  // Clicking outside the selection selects what is under the pointer first: a context menu acting
  // on something you are not pointing at is worse than none.
  assert.match(fn[0], /sel=\[hit\[hit\.length-1\]\]/, 'the topmost item under the pointer is selected');
  assert.match(fn[0], /if\(!hit\.length\) return;/, 'empty paper keeps the browser menu');
  assert.match(fn[0], /if\(tool==='text'\) return;/, 'and the text region keeps its native menu');
});

test('the clipboard shortcuts never fire while typing', () => {
  // The pad shares a page with the chat composer, an ordinary input. A pad that ate its ⌘C would
  // be a far worse bug than the one these fix, so the guard is doubled: not while the text region
  // is active, and not when the event came from a field.
  const fn = /const onShortcut=\(e\)=>\{[\s\S]*?\n    \};/.exec(E);
  assert.ok(fn, 'the shortcut handler must be findable');
  assert.match(fn[0], /if\(txtEdit\|\|isTyping\(e\.target\)\) return;/, 'both guards');
  assert.match(E, /isTyping=\(t\)=> !!\(t&&\(t\.isContentEditable\|\|\/\^\(INPUT\|TEXTAREA\|SELECT\)\$\//,
    'a field is a field however it is spelled');
  // preventDefault only when it actually acts, so an unhandled ⌘C still reaches the browser.
  assert.match(fn[0], /if\(!sel\.length\) return; e\.preventDefault\(\)/, 'C/X need a selection first');
  assert.match(fn[0], /if\(!clipKind\(\)\) return; e\.preventDefault\(\)/, 'V needs something copied first');
  assert.match(fn[0], /e\.metaKey\|\|e\.ctrlKey/, '⌘ on a Mac, Ctrl elsewhere');
});

/* ══ ⌘/Ctrl+Z — undo from the keyboard ═══════════════════════════════════════════════════════
   Undo and redo existed, but only as two toolbar buttons: there was no keyboard path at all.
   These tests RUN the shipped handler rather than matching its text, because the mistakes worth
   catching here are decisions, not spellings — a lowercased key that reads ⇧⌘Z as a plain undo,
   or a preventDefault that fires before the handler knows it will act. */

const HANDLER = (() => {
  const m = /const onShortcut=\(e\)=>\{[\s\S]*?\n    \};/.exec(E);
  assert.ok(m, 'onShortcut must be findable');
  return m[0];
})();

// The shipped handler, executed against stubs. Everything it closes over is supplied here, so a
// name the engine stops providing shows up as a ReferenceError rather than a silent pass.
function mount(over = {}) {
  const calls = [];
  const env = { txtEdit: null, sel: [], moveDrag: null, resizeDrag: null, marquee: null,
    undoLen: 1, redoLen: 1, clip: 'sel', ...over };
  const scope = {
    txtEdit: env.txtEdit, sel: env.sel,
    moveDrag: env.moveDrag, resizeDrag: env.resizeDrag, marquee: env.marquee,
    isTyping: (t) => !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))),
    curUndo: () => ({ length: env.undoLen }), curRedo: () => ({ length: env.redoLen }),
    undo: () => calls.push('undo'), redo: () => calls.push('redo'),
    copySel: (cut) => calls.push(cut ? 'cut' : 'copy'), pasteAny: () => calls.push('paste'),
    clipKind: () => env.clip,
  };
  const names = Object.keys(scope);
  const fn = new Function(...names, `${HANDLER}\nreturn onShortcut;`)(...names.map((n) => scope[n]));
  return { calls, press: (key, mod = {}) => {
    let prevented = false;
    fn({ key, metaKey: true, altKey: false, shiftKey: false, target: { tagName: 'CANVAS' },
      preventDefault() { prevented = true; }, ...mod });
    return prevented;
  } };
}

test('⌘Z undoes, ⇧⌘Z and Ctrl+Y redo', () => {
  const a = mount();
  assert.equal(a.press('z'), true, 'the pad handled it');
  assert.deepEqual(a.calls, ['undo']);
  // `k` is lowercased so ⇧⌘Z arrives as 'z'. Without an explicit shiftKey test it would read as a
  // plain undo — the whole reason redo is decided here rather than by the letter alone.
  const b = mount();
  b.press('Z', { shiftKey: true });
  assert.deepEqual(b.calls, ['redo'], '⇧⌘Z is redo, not a second undo');
  const c = mount();
  c.press('y', { metaKey: false, ctrlKey: true });
  assert.deepEqual(c.calls, ['redo'], 'Ctrl+Y is redo for anyone coming from Windows');
});

test('an empty stack lets the keystroke through instead of swallowing it', () => {
  // preventDefault before knowing there is work to do makes ⌘Z do nothing ANYWHERE on the page.
  const a = mount({ undoLen: 0 });
  assert.equal(a.press('z'), false, 'not prevented');
  assert.deepEqual(a.calls, [], 'and nothing ran');
  const b = mount({ redoLen: 0 });
  assert.equal(b.press('z', { shiftKey: true }), false);
  assert.deepEqual(b.calls, []);
});

test('⌘Z never fires while typing — native undo owns the text region', () => {
  // The load-bearing one. Typing NEVER pushes an undo snapshot, but a snapshot carries the page's
  // whole HTML, so an undo mid-paragraph would restore the text as it stood before the last stroke
  // and drop every keystroke since. Both guards must hold it off.
  const a = mount({ txtEdit: { el: {} } });
  assert.equal(a.press('z'), false, 'the browser keeps the keystroke');
  assert.deepEqual(a.calls, [], 'and the pad did not undo');
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const b = mount();
    assert.equal(b.press('z', { target: { tagName } }), false, `${tagName} keeps its own undo`);
    assert.deepEqual(b.calls, []);
  }
  const c = mount();
  c.press('z', { target: { isContentEditable: true, tagName: 'DIV' } });
  assert.deepEqual(c.calls, [], 'a contenteditable is a field however it is spelled');
});

test('a keystroke mid-drag is ignored, and ⌥⌘Z is not ours', () => {
  // A move/resize pushes its snapshot on first movement and finishes in selUp; swapping the arrays
  // underneath one leaves the drag mutating points that no longer exist.
  for (const held of ['moveDrag', 'resizeDrag', 'marquee']) {
    const a = mount({ [held]: {} });
    assert.equal(a.press('z'), false, `ignored while ${held} is live`);
    assert.deepEqual(a.calls, []);
  }
  const b = mount();
  assert.equal(b.press('z', { altKey: true }), false, '⌥⌘Z is a different OS shortcut');
  assert.deepEqual(b.calls, []);
});

test('CONTROL: the stubs really can observe an undo, and C/X/V still work', () => {
  // Every assertion above is a NEGATIVE one. If this harness could not see an undo at all they
  // would all pass against a handler that does nothing.
  const a = mount();
  a.press('z');
  assert.deepEqual(a.calls, ['undo'], 'the harness observes the positive case');
  // …and adding Z did not disturb the clipboard shortcuts sharing the handler.
  const b = mount({ sel: [{ kind: 'stroke', i: 0 }] });
  b.press('c'); b.press('x'); b.press('v');
  assert.deepEqual(b.calls, ['copy', 'cut', 'paste']);
});

test('the shortcut handler is removed when the pad is destroyed', () => {
  // It used to be an anonymous arrow, so nothing could unregister it: every mount/destroy cycle
  // stranded a live document listener closed over a dead pad. Harmless-ish for ⌘C, which needs a
  // selection the dead pad no longer has — but a stranded ⌘Z calls undo() and MUTATES that pad's
  // old notebook. Bible swaps between PANote.panel() and PANote.fullscreen() on one page, so this
  // is a real sequence, not a hypothetical one.
  assert.match(E, /document\.addEventListener\('keydown',onShortcut\);/, 'registered by name');
  assert.match(E, /document\.removeEventListener\('keydown',onShortcut\);/, 'and removed in destroy()');
});
