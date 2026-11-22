// Paragraph styles · 段落样式
//
// Title / Heading / Subheading / Body / Monostyled / Block Quote, plus strikethrough and a dashed
// list — the set Apple Notes offers, because that is the vocabulary the user already has.
//
// THE STRUCTURE IS THE STORAGE. A Title is an <h1> in the note's HTML, not a class or a private
// marker, so the note keeps its meaning when it is printed, pasted elsewhere, or read by anything
// that is not this app. Every new tag therefore has to pass the sanitizer, which is the part that
// needs guarding: it builds FRESH elements and copies only allow-listed styles, so a tag added
// here can carry nothing a <p> could not already carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments, guardModule } from './helpers-app.mjs';

const E = stripComments(ENGINE);
const TAGS = new Function(`${/const HTML_TAGS=[\s\S]*?\}\)?;/.exec(E)[0]}; return HTML_TAGS;`)();

test('the block tags the styles produce all survive sanitising', () => {
  for (const [src, out] of [['H1', 'h1'], ['H2', 'h2'], ['H3', 'h3'], ['PRE', 'pre'], ['BLOCKQUOTE', 'blockquote']]) {
    assert.equal(TAGS[src], out, `${src} is kept`);
  }
});

test('strikethrough normalises to one spelling', () => {
  // Engines disagree about whether execCommand('strikeThrough') emits <s>, <strike> or <del>.
  // Three spellings of one thing in stored notes is how a later tidy-up drops two of them.
  assert.equal(TAGS.S, 's');
  assert.equal(TAGS.STRIKE, 's');
  assert.equal(TAGS.DEL, 's');
});

test('a dashed list is a marker, not a class — classes do not survive', () => {
  // cleanInto creates fresh elements, so no attribute carries over. The marker has to be a STYLE.
  const ok = /'list-style-type':(\/[^/]+\/)/.exec(E);
  assert.ok(ok, 'list-style-type must be allow-listed');
  const re = new Function(`return ${ok[1]}`)();
  assert.ok(re.test("'– '"), 'the dashed marker passes');
  for (const good of ['disc', 'circle', 'square', 'decimal', 'none']) assert.ok(re.test(good), `${good} passes`);
  // …and the allow-list is TIGHT. list-style-type takes an arbitrary quoted string in modern CSS,
  // which is user content reaching a rendering slot.
  for (const bad of ["'javascript:x'", "'\\\\75 rl(x)'", 'url(x)', "'a very long attacker string'", '"– "']) {
    assert.equal(re.test(bad), false, `${bad} is refused`);
  }
});

test('the style menu is its own preview', () => {
  // Each row is set in the style it applies, which is why Apple's needs no icons or explanation.
  const t = /const TXT_STYLES=\[([\s\S]*?)\];/.exec(E);
  assert.ok(t, 'TXT_STYLES must be findable');
  const tags = [...t[1].matchAll(/\['([a-z0-9]+)'/g)].map((m) => m[1]);
  assert.deepEqual(tags, ['h1', 'h2', 'h3', 'p', 'pre', 'blockquote'], "Apple's order");
  assert.match(E, /data-style="'\+st\[0\]\+'"><span style="'\+st\[2\]\+'"/, 'the row wears its own style');
  // Every style in the table must be a tag the sanitizer keeps, or choosing it would silently
  // unwrap to body text on the next load.
  for (const tag of tags) assert.ok(Object.values(TAGS).includes(tag), `${tag} survives sanitising`);
});

test('formatBlock is used, and it is the one execCommand that suits this', () => {
  // Unlike fontSize, formatBlock acts on the BLOCK containing the caret, so it does not depend on
  // a selection surviving the popover's focus change — and the freeze added for the size picker
  // covers the caret anyway.
  assert.match(E, /fmtExec\('formatBlock','<'\+tag\+'>'\)/, 'applied through the shared command path');
  assert.match(E, /function caretBlock\(\)\{/, 'the current block is known, so the menu can tick it');
  assert.match(E, /if\(t==='div'\) return 'p';/, 'a bare div IS body text');
});

test('dashed and bulleted stay ONE list implementation', () => {
  // insertUnorderedList already handles selection, nesting and the caret. Rebuilding that for a
  // different marker would be two list engines that drift apart.
  const fn = /if\(dashBtn\) dashBtn\.addEventListener\('click',\(\)=>\{[\s\S]*?onTextInput\(\); \}\);/.exec(E);
  assert.ok(fn, 'the dashed button must be wired');
  assert.match(fn[0], /fmtExec\('insertUnorderedList'\)/, 'it makes an ordinary bulleted list first');
  assert.match(fn[0], /n\.style\.listStyleType=DASH_MARKER/, 'and only restyles the marker');
  assert.match(fn[0], /onTextInput\(\)/, 'a scripted edit fires no input event, so the save is triggered by hand');
});

test('the style popover joins the one-at-a-time set', () => {
  // The list grew when tables arrived; what is pinned is that this popover is in it.
  const loop = /for\(const sel of \[([^\]]*)\]\)\{ const el=q\(sel\); if\(el\) el\.classList\.remove\('on'\); \}/.exec(E);
  assert.ok(loop, 'closePops must close the text popovers');
  assert.match(loop[1], /'\.pan-stylepop'/, 'including this one');
  const guard = /e\.target\.closest\('([^']+)'\)\) return;/.exec(E);
  assert.match(guard[1], /\.pan-fstyle/, 'and its button is exempt from the outside-tap close');
});

test('the fingerprint notices a style change', () => {
  // contentPrint hashes pageHtml length among other things. A style change rewrites the tag, so
  // the length moves — but a same-length swap must still register, or applying a style could be
  // skipped as "nothing to send" (the crop-not-saving shape).
  const G = guardModule();
  const page = (html) => ({ v: 2, template: 'plain', bgColor: '#fff', pages: [{ id: 'p0', strokes: [], pageHtml: html, images: [] }] });
  assert.notEqual(G.contentPrint(page('<h1>Some title</h1>')), G.contentPrint(page('<h2>Some title</h2>')),
    'h1 and h2 of the same text are different notes');
});

// ── the two axes have to agree ───────────────────────────────────────────────────────────────
test('the size picker recognises every block a style can produce', () => {
  // Reported as "the font size changing is not working". With only P|DIV|LI in the list, putting
  // the caret in a Title and choosing a size walked PAST the heading to the region itself, found
  // no block, and flashed "select the text to resize" — measured: the old pattern matches nothing
  // inside an <h2>, the new one returns H2.
  assert.match(E, /const BLOCK_TAGS=\/\^\(P\|DIV\|LI\|H1\|H2\|H3\|PRE\|BLOCKQUOTE\)\$\//,
    'every style block is a block the size picker can size');
  // The bare-text fallback must ask the same question, or it fires on a page that HAS blocks.
  assert.match(E, /const BLOCK_SEL='p,div,li,h1,h2,h3,pre,blockquote';/, 'one list, two spellings');
  assert.match(E, /if\(!el\.querySelector\(BLOCK_SEL\)\)/, 'and the selector form is used');
});

test('a paragraph style owns the size of its block', () => {
  // Reported as "the header is not working". Styles size themselves in em; an explicit font-size
  // left inside the block out-specifies that, so a Title applied over picker-sized text stayed
  // body-sized and the style looked like it had done nothing. Verified in a browser: applying
  // Title to <span style="font-size:32px"> now yields <h1>…</h1> rendering at 34.2px.
  const fn = /function clearSizesIn\(el\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'clearSizesIn must be findable');
  assert.match(fn[0], /el\.style\.removeProperty\('font-size'\)/, 'the block itself');
  assert.match(fn[0], /querySelectorAll\('\[style\]'\)/, 'and everything inside it');
  assert.match(fn[0], /par\.removeChild\(n\)/, 'a span left saying nothing is unwrapped');
  assert.match(E, /clearSizesIn\(blockAtCaret\(\)\);/, 'applying a style clears them');
  // The picker still wins AFTER — that is then a deliberate choice made on a Title, not a
  // leftover from before it was one.
  assert.ok(E.indexOf('clearSizesIn(blockAtCaret());') > E.indexOf("fmtExec('formatBlock'"),
    'cleared after the block is formed, not before');
});

test('applying a style is saved', () => {
  // formatBlock and clearSizesIn are scripted DOM edits; neither fires an 'input' event, so
  // without this the style shows on screen and is gone on reload.
  const fn = /function applyStyle\(tag\)\{[\s\S]*?syncStylePop\(\);/.exec(E);
  assert.ok(fn, 'applyStyle must be findable');
  assert.match(fn[0], /onTextInput\(\);/, 'the commit is triggered by hand');
});

test('the style button reports the style the caret is in', () => {
  // "when title is selected, it still shows Aa". A control that always reads the same thing tells
  // you what it does and never what the document IS — the same complaint as the size picker
  // showing a stale value. Both are now driven from syncFmtState, which already runs on every
  // selection change.
  assert.match(E, /sb\.textContent=st\?st\[3\]:'Aa';/, 'it wears the short name, or Aa outside the region');
  assert.match(E, /const cur=caretBlock\(\), st=TXT_STYLES\.find\(x=>x\[0\]===cur\);/,
    'read from caretBlock — the SAME reading the menu ticks with, so the two cannot disagree');
  assert.match(E, /sb&&!selFrozen/, 'and not rewritten while a control is being operated');
  // Every style needs a short name, or the button would blank out on the one that lacks it.
  const t = /const TXT_STYLES=\[([\s\S]*?)\];/.exec(E)[1];
  const shorts = [...t.matchAll(/,'([A-Za-z]+)'\],?$/gm)].map((m) => m[1]);
  assert.deepEqual(shorts, ['Title', 'Heading', 'Sub', 'Body', 'Mono', 'Quote']);
});

test('the button has a stable width, since it now carries a word', () => {
  // A control that resizes as the caret moves drags every button beside it along with it.
  assert.match(E, /\.pan-fmtbtn\.pan-fstyle\{[^}]*min-width:52px/, 'a floor on its width');
  assert.match(E, /\.pan-fmtbtn\.pan-fstyle\{[^}]*width:auto/, 'and room to hold the longest name');
});
