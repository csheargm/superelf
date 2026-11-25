// Printing a handwritten note · 打印手写笔记
//
// The whole feature exists around one hostile fact: an app page is sandbox="allow-scripts" with
// no allow-modals, so ITS window.print() is a SILENT no-op — it returns undefined, throws
// nothing, and fires neither beforeprint nor afterprint, while typeof window.print stays
// 'function'. Every naive implementation of this feature therefore *reports success and prints
// nothing*. These tests exist mostly to keep that from being reintroduced.
//
// The rest pins the two decisions that are easy to undo by accident: the pad owns the only
// renderer (a second one drifts and the printout stops matching the note), and a page's print
// height comes from its INK, because the pad has no paper size at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, SHELL, PRINT, ROOT, stripComments } from './helpers-app.mjs';
import fs from 'node:fs';
import path from 'node:path';

const P = stripComments(PRINT);
const E = stripComments(ENGINE);
const S = stripComments(SHELL);

// ── the pure maths, run for real ──────────────────────────────────────────────────────────
// Extracted and executed rather than regex-matched: the bug these guard against (a canvas over
// the platform's area cap comes back BLANK, not an exception) is invisible to a source-only test.
const API = (() => {
  const scale = /function fitScale[\s\S]*?return px>MAX_PX \? s\*Math\.sqrt\(MAX_PX\/px\) : s;\n  \}/.exec(P);
  const geo = /function pageHeight\(info,paper\)[\s\S]*?function noteFit\(info,paper\)\{[\s\S]*?\n  \}/.exec(P);
  const paper = /const LETTER_REGIONS=[^\n]*\n  function defaultPaper[^\n]*/.exec(P);
  assert.ok(scale && geo && paper, 'fitScale, pageHeight, noteFit and defaultPaper must be extractable');
  const T = /const TARGET_W=(\d+);/.exec(P)[1], M = /const MAX_PX=([\d.e]+);/.exec(P)[1];
  const pad = /const PAD_RATIO=([\d.]+);/.exec(P)[1];
  return new Function(
    `const TARGET_W=${T}, MAX_PX=${M}, PAD_RATIO=${pad}, LETTER_ASPECT=1056/816, A4_ASPECT=285/198;` + paper[0] + ';' +
    scale[0] + geo[0] + '; return { pageHeight, fitScale, noteFit, defaultPaper, TARGET_W, MAX_PX };'
  )();
})();

test('a page prints at 300dpi across a sheet', () => {
  assert.equal(API.TARGET_W, 2244);
  // Measured against the real notebook: a 900px-wide page renders 2244px across.
  assert.equal(Math.round(900 * API.fitScale(900, 400)), 2244);
});

test('every printed page is the pad sheet, a Letter page', () => {
  // Not the old 1.20 box: that left a white band under every sheet (owner 2026-11-25).
  for (const extent of [0, 0.5, 1.2, 2.0]) {
    assert.equal(API.pageHeight({ width: 816, sheetH: 1056, pages: [{ extent }] }), 1056);
  }
  assert.equal(API.pageHeight({ width: 816 }), 1056, 'a host without sheetH still gets Letter');
  // A4 is taller: the page continues down to fill it rather than floating in a band.
  assert.equal(API.pageHeight({ width: 816, sheetH: 1056 }, 'a4'), Math.round(816 * 285 / 198));
  assert.match(P, /const A4_ASPECT=\(297-12\)\/\(210-12\);/, 'the A4 box matches the shell 6mm inner margin');
  assert.doesNotMatch(P, /SHEET_ASPECT/, 'the 1.20 band is gone');
});

test('one scale for the whole note, from content alone', () => {
  const info = (exts) => ({ width: 816, sheetH: 1056, pages: exts.map((extent) => ({ extent })) });
  assert.equal(API.noteFit(info([0.3, 1.2, 1.25])).k, 1, 'content inside the sheet is never scaled');
  const k = API.noteFit(info([0.4, 1.37])).k;
  assert.ok(k < 1 && 1.37 * 816 * k <= 1056, 'the deepest page decides and lands inside the sheet');
  assert.equal(API.noteFit(info([0.4, 1.37, 0.2])).k, k, 'and every page gets that same k');
  // GPT review: a stroke centred just above the sheet foot still has a thick edge below it.
  const edge = API.noteFit(info([1.29])).k;
  assert.ok(edge < 1 && (1.29 + 0.04) * 816 * edge <= 1056 + 1e-9, 'padding counts even when the centreline fits');
});

test('stationery stays registered with the ink when the note is scaled', () => {
  const N = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
  assert.match(N, /STN\.paint\(ctx,NB\.stationery,\{w:W,h,/, 'stationery uses the pad width, not the stretched paper width');
});

test('the same strokes print the same from a 12.9in and an 11in iPad', () => {
  // The device enters print only through screen height, which no longer reaches the geometry:
  // extents are stored in page-width units and the sheet is fixed. Same content -> same k.
  const pages = [{ extent: 0.9 }, { extent: 1.33 }];
  const ipad129 = { width: 816, sheetH: 1056, pages }, ipad11 = { width: 816, sheetH: 1056, pages };
  assert.equal(API.noteFit(ipad129).k, API.noteFit(ipad11).k);
  assert.equal(API.pageHeight(ipad129), API.pageHeight(ipad11));
});

test('paper defaults by locale', () => {
  assert.equal(API.defaultPaper('en-US'), 'letter');
  assert.equal(API.defaultPaper('zh-CN'), 'a4');
  assert.equal(API.defaultPaper('en-GB'), 'a4');
  assert.equal(API.defaultPaper(''), 'a4');
  assert.match(P, /kind:'print', title:opts\.title\|\|'', paper, pages:r\.pages/, 'and is sent to the shell');
});

test('an oversized page loses resolution, never its ink', () => {
  // iOS caps canvas area and returns a BLANK canvas rather than throwing. Printing blank sheets
  // is indistinguishable from a note that failed to save, so the scale gives way instead.
  const full = API.fitScale(900, 400);
  const huge = API.fitScale(900, 14 * 900);
  assert.ok(huge < full, 'a very tall page is scaled down');
  assert.ok((900 * huge) * (14 * 900 * huge) <= API.MAX_PX * 1.001, 'and lands inside the pixel budget');
  // Every real page measured (max extent 1.07) must stay at full resolution.
  assert.equal(API.fitScale(900, API.pageHeight({ width: 900 })), full,
    'a realistic page is never downscaled');
});

// ── the sandbox rule ──────────────────────────────────────────────────────────────────────

test('the app never calls window.print() — it cannot, and it fails silently', () => {
  assert.ok(!/window\.print\s*\(/.test(P), 'PAPrint must not call print() inside the sandbox');
  assert.ok(!/window\.print\s*\(/.test(E), 'nor may the pad');
  // The shell is the one place allowed to, because it is not sandboxed.
  assert.match(S, /window\.print\(\)/, 'the shell owns the call');
});

test('a print that did not happen is never reported as success', () => {
  // The silent no-op means "the call returned" proves nothing. PAPrint must believe the SHELL.
  const fn = /note:async\(api,opts\)=>\{[\s\S]*?\n    \},/.exec(P);
  assert.ok(fn, 'PAPrint.note exists');
  assert.match(fn[0], /if\(!res\|\|!res\.ok\) return \{ok:false/, 'no reply, or a refusal, is a failure');
  assert.ok(!/try\{[^}]*ask\(/.test(fn[0]), 'the shell round trip is not swallowed by a try/catch');
  // And the button must say so either way — a print that silently does nothing looks like a
  // broken button, which is the exact failure mode the sandbox produces.
  const btn = /const pb=q\('\.pan-hprint'\);[\s\S]*?\n      \}\); \}/.exec(E);
  assert.ok(btn, 'the print button is bound');
  assert.match(btn[0], /if\(!r\.ok\) flash\(/, 'a failure is spoken');
  assert.match(btn[0], /catch\(e\)\{ flash\(/, 'and so is a throw (R5)');
});

test('typed text is PRINTED, not warned about', () => {
  // This test used to pin a warning saying typed text is not printed. That was the honest
  // answer while a page had no fixed shape — there was no "where this paragraph sits on the
  // sheet" to render into. A Letter page makes it a transcription, so the R14 property is now
  // satisfied the strong way: the words are carried, not apologised for.
  assert.match(E, /drawText\(ctx,pg\.pageHtml\);/, 'printPage draws the page text');
  assert.doesNotMatch(P, /noText/, 'and the apology is gone');
  assert.doesNotMatch(P, /warn\.text/, 'along with the flag that carried it');
  // Drawn FIRST, because on screen the text layer sits beneath the ink canvas (ADR 0021): a
  // stroke across a typed word shows on the page, so it must show on the sheet too. The print
  // order mirrors the screen's: paper, text, pictures, highlighter, pen.
  const fn = /function printPage\([\s\S]*?return true; \}/.exec(E)[0];
  assert.ok(fn.indexOf('drawText(') < fn.indexOf('drawImages('), 'text is drawn under the pictures');
  assert.ok(fn.indexOf('drawText(') < fn.indexOf('drawStroke('), 'and under the ink');
  // hasText survives for a different job: a text-only page still has to count as content.
  assert.match(E, /hasText:pageHasText\(p\),/, 'the pad still reports it');
  assert.match(E, /const pageHasText=\(p\)=>!!String\(\(p&&p\.pageHtml\)\|\|''\)/, 'through the one text test (R3)');
});

test('the text renderer transcribes the browser layout rather than re-laying it out', () => {
  // A second layout engine would drift from the screen, silently, and the printout would slowly
  // stop matching the note — the same reason PAPrint is forbidden its own stroke renderer.
  const fn = /function drawText\(ctx,html\)\{[\s\S]*?return drew; \}/.exec(E);
  assert.ok(fn, 'drawText must be findable');
  assert.match(fn[0], /createTreeWalker\(el,NodeFilter\.SHOW_TEXT\)/, 'it walks the real DOM');
  assert.match(fn[0], /r\.getClientRects\(\)\[0\]/, 'and reads where the browser put each word');
  assert.doesNotMatch(fn[0], /measureText\([^)]*\)\.width/, 'it never measures its own wrapping');
});

test('the baseline is derived from the font, not guessed', () => {
  // MEASURED in a browser: getClientRects returns the FONT box (height 21 for an 18px font whose
  // ascent+descent is 17+4), so baseline = bottom − descent. That formula is what makes mixed
  // sizes on one line share a baseline; a guess like bottom−height/4 would stagger them.
  const fn = /function drawText\(ctx,html\)\{[\s\S]*?return drew; \}/.exec(E)[0];
  assert.match(fn, /desc=tm\.fontBoundingBoxDescent\|\|fsz\*0\.22/, 'descent from the font metrics, with a fallback');
  assert.match(fn, /yb=rc\.bottom-base\.top-desc/, 'baseline is the box bottom less the descent');
});

test('the measuring copy cannot disturb the page being edited', () => {
  // printPage renders page i, but the live text layer only ever holds the CURRENT page. Re-using
  // it would mean writing another page's HTML into the editor mid-print.
  const fn = /function textMeasureEl\(\)\{[\s\S]*?return measureEl;\n    \}/.exec(E);
  assert.ok(fn, 'the measuring element must be findable');
  assert.match(fn[0], /createElement\('div'\)/, 'it is its own element');
  assert.match(fn[0], /visibility:hidden/, 'hidden but LAID OUT');
  assert.doesNotMatch(fn[0], /display:none/, 'display:none has no boxes to measure');
  assert.match(fn[0], /width:'\+W\+'px/, 'at page width, so it wraps exactly as the page does');
  assert.match(fn[0], /for\(const k of \['lineHeight','fontSize','paddingTop','paddingLeft'\]\)/,
    "and carries the live layer's ruled-template metrics, or ruled pages print at the wrong spacing");
});

test('list markers are drawn, because ::marker has no Range to transcribe', () => {
  // A pseudo-element is not a text node, so a pure transcription prints a bulleted list as
  // unmarked paragraphs — content silently lost, which is what R14 is about.
  const fn = /function drawText\(ctx,html\)\{[\s\S]*?return drew; \}/.exec(E)[0];
  assert.match(fn, /el\.querySelectorAll\('li'\)/, 'list items are visited');
  assert.match(fn, /ordered\?\(\[\.\.\.li\.parentElement\.children\]\.indexOf\(li\)\+1\)\+'\.':/,
    'ordered lists are numbered by position, unordered get a bullet');
  // The marker rides its item's FIRST LINE baseline, transcribed like every other word. Computing
  // it from the box bottom ignores the line box's half-leading — measured: every bullet sat ~4px
  // below its own text.
  assert.match(fn, /yb=rc\.bottom-base\.top-desc; break;/, 'the marker baseline is transcribed, not computed');
  assert.match(fn, /if\(yb==null\)/, 'and an EMPTY item still gets a marker');
});

test('unresolved photos are still reported', () => {
  // An unresolved photo prints as drawImages' grey placeholder box; say so rather than ship it.
  assert.match(E, /unresolved:\(p\.images\|\|\[\]\)\.filter/, 'unresolved photos are counted');
  assert.match(P, /if\(pg\.unresolved\) warn\.photo=true;/, 'and reported');
});

// ── one renderer, not two ─────────────────────────────────────────────────────────────────

test('the pad owns the only renderer; PAPrint draws nothing itself', () => {
  // A second stroke/paper renderer would drift from the pad and the printout would slowly stop
  // matching the note — silently, which is why this is pinned rather than left to judgement.
  for (const sym of ['drawStroke', 'drawFlat', 'drawPaper', 'drawDots', 'segWidth']) {
    assert.ok(!new RegExp('function\\s+' + sym).test(P), `PAPrint must not define ${sym}`);
  }
  assert.match(P, /note\.printPage\(i,ctx,scale,hCss\b/, 'it asks the pad to draw');
});

test('the paper renderer serves the screen and the sheet from one definition', () => {
  const fn = /function drawPaper\(ctx,h,bg,fit,pw\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'drawPaper takes a context, a height and a background');
  assert.match(fn[0], /ctx=ctx\|\|bgCtx; h=h\|\|H;/, 'and still defaults to the live layer');
  // Ruled lines are painted onto the CANVAS, so they are image content in the printout and the
  // print dialog's "background graphics" setting cannot drop them. Keeping them on the canvas is
  // load-bearing for printing, not an implementation detail.
  assert.ok(!/bgCtx\./.test(fn[0]), 'it must draw into the passed context, not the live one');
  assert.match(fn[0], /if\(live\) syncPaperPickers\(\)/, 'a print render must not touch the DOM');
});

test('print functions are defined once, not copied for the button', () => {
  assert.equal((E.match(/function printPage\(/g) || []).length, 1, 'one printPage');
  assert.equal((E.match(/function printInfo\(/g) || []).length, 1, 'one printInfo');
  assert.match(E, /printInfo, printPrime, printPage,/, 'the public API reuses them');
  assert.match(E, /window\.PAPrint\.note\(\{printInfo,printPrime,printPage\}/, 'and so does the button');
});

// ── delivery ──────────────────────────────────────────────────────────────────────────────

test('PAPrint is registered LAST, and rides along with the pad', () => {
  const engine = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  const list = /const PA_COMPONENTS = \[([\s\S]*?)\n\];/.exec(engine);
  assert.ok(list, 'the component list is findable');
  const files = [...list[1].matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  // NOT "print is last" — that names the calendar, not the invariant, and fails the moment any
  // component is appended after it (PAScan was, and this test broke for a reason unrelated to
  // print). What matters is that print comes after the component whose marker CARRIES it.
  assert.ok(files.includes('print-ui.inline.html'), 'print-ui is registered');
  assert.ok(files.indexOf('note-ui.inline.html') < files.indexOf('print-ui.inline.html'),
    'note-ui CARRIES the print marker, so print must be registered after it');
  // Carried by the pad means every app that mounts PANote gets print with no per-app edit.
  assert.match(ENGINE, /<!--PA_PRINT_UI-->/, 'note-ui carries the marker');
});

test('the shell prints the pages and nothing else', () => {
  const br = /\} else if\(m\.kind==='print'\)\{[\s\S]*?\n    \} else reply/.exec(S);
  assert.ok(br, 'the shell handles kind:print');
  assert.match(br[0], /await Promise\.all\(imgs\.map/, 'it waits for decode — printing early yields blank sheets');
  assert.match(br[0], /classList\.add\('pa-printing'\)/, 'it marks the document while printing');
  assert.match(br[0], /classList\.remove\('pa-printing'\)/, 'and unmarks it afterwards');
  assert.match(br[0], /root\.innerHTML='';/, 'and releases the pages (~1MB each)');
  assert.match(br[0], /if\(!pages\.length\) return reply\(\{ok:false/, 'an empty print is refused, not faked');
  // Chrome must not reach the paper.
  assert.match(S, /html\.pa-printing body>\*:not\(#printRoot\)\{display:none!important\}/, 'shell chrome is hidden');
  assert.match(S, /#printRoot\{display:none\}/, 'and the print surface never shows on screen');
  // One note page per sheet, centred in a physical-unit box on a zero-margin page.
  assert.match(S, /\.pr-sheet\{display:flex;align-items:center;justify-content:center/, 'the sheet centres its page');
  assert.match(S, /height:calc\(var\(--pr-paper-h,279\.4mm\) - 12mm\);margin-top:6mm;padding:0 6mm/, 'even inner margin in mm');
  assert.match(S, /object-fit:contain/, 'the image fits, never crops');
  assert.match(br[0], /getElementById\('prPageSize'\); if\(pps\) pps\.remove\(\)/, 'teardown drops the note paper rule, so a later Ctrl+P is the ordinary shell');
  assert.match(S, /@page\{margin:10mm\}/, 'the ordinary shell keeps its margin; only a note print is zero-margin');
  assert.match(br[0], /@page\{size:'\+pz\.w\+' '\+pz\.h\+';margin:0\}/, 'page size from the chosen paper');
  assert.match(S, /\.pr-sheet\{[^}]*page-break-after:always/, 'one page per sheet');
});

test('nothing event-driven may reclaim the print surface', () => {
  // TWO iPad scars, the same mistake at different distances:
  //  1. teardown on the line after window.print() — desktop print() BLOCKS, iOS returns at once,
  //     so the surface vanished before the preview rendered and iOS printed the app instead;
  //  2. teardown on `afterprint` — with NO printer chosen the preview was right, and the instant a
  //     real printer was selected the chrome came back zoomed. Choosing a printer makes iOS
  //     RE-RENDER for that printer's paper, and iOS fires afterprint when the first PREVIEW is
  //     made, not when the user is done. The re-render found the surface already gone.
  // So the surface is held on a timer, and only a timer.
  const br = /\} else if\(m\.kind==='print'\)\{[\s\S]*?\n    \} else reply/.exec(S);
  assert.ok(br, 'the shell handles kind:print');
  assert.ok(!/addEventListener\('afterprint'/.test(br[0]),
    'afterprint must NOT tear the surface down — iOS fires it while the dialog is still open');
  assert.ok(!/addEventListener\('beforeprint'/.test(br[0]), 'nor any other print event');
  assert.match(br[0], /root\._paHold=setTimeout\(teardown,HOLD_MS\)/, 'a timer reclaims it');
  // Print #1's timer must not fire into print #2.
  assert.match(br[0], /if\(root\._paHold\) clearTimeout\(root\._paHold\);/,
    'a new print clears the previous hold first');
  // Long enough that choosing a printer, paper and margins never outlasts it.
  const hold = /const HOLD_MS=(\d+);/.exec(br[0]);
  assert.ok(hold && Number(hold[1]) >= 300000, `the hold is minutes, not seconds (got ${hold && hold[1]})`);
  // The ONE place a prompt teardown is allowed: after a print() that BLOCKED. A blocking call
  // only returns once the dialog is closed, so the surface has already been used — that is
  // desktop, and cleaning up there stops a later Ctrl+P printing this note instead of the app.
  // Measured, not sniffed: no user-agent test may creep in here.
  assert.match(br[0], /if\(Date\.now\(\)-t0>\d+\)\{ clearTimeout\(root\._paHold\); teardown\(\); \}/,
    'a blocking print() reclaims the surface immediately');
  assert.ok(!/navigator\.(userAgent|platform)/.test(br[0]), 'platform is inferred from behaviour, never sniffed');

  // Walk the statements after print(): still nothing may tear down before the reply.
  const lines = br[0].split('\n');
  const start = lines.findIndex((l) => l.includes('window.print()'));
  let inCatch = false;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes('catch(err)')) inCatch = true;
    if (inCatch) { if (l.includes('reply({ok:false')) inCatch = false; continue; }
    if (l.includes('reply({ok:true')) break;
    assert.ok(!/\bteardown\(\)/.test(l), `nothing tears down before the reply — found: ${l.trim()}`);
  }
});

test('the print stylesheet contains no viewport units', () => {
  // SCAR 2026-09-12 (iPad). The sheets were 100vh flex boxes. In paginated media iOS resolves vh
  // against the SCREEN viewport rather than the page box, so each sheet became far taller than the
  // paper: the image centred inside it under a wide white band, the rest was clipped, and a
  // FOUR-page note printed as a single cut-off page. vh/vw/vmin/vmax describe a screen; a sheet of
  // paper is not one. Comments are stripped first — an earlier assertion in this file matched the
  // very comment explaining the bug and passed while the bug was present.
  const block = /@media print\{([\s\S]*?)\n\}/.exec(S);
  assert.ok(block, 'the print block is findable');
  const css = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\b\d*\.?\d+v(h|w|min|max)\b/.test(css),
    'no viewport units may appear in print rules');
});

test('printing neutralises the app shell, or nothing paginates', () => {
  // THE bug behind "a 4-page note prints as 1 cut-off page", on desktop AND iPad. The shell is a
  // viewport-pinned app layout: html and body carry a fixed height (100dvh, and height:100%
  // !important under display-mode:standalone) plus overflow:hidden, and body is a column flex
  // container. Printed, that is a fixed-height CLIPPING box: the sheets after the first have
  // nowhere to flow. Measured after the fix — body height went from clipped to 3829px, exactly the
  // sum of the four sheets, each at its image's own aspect ratio.
  const block = /@media print\{([\s\S]*?)\n\}/.exec(S);
  assert.ok(block, 'the print block is findable');
  const css = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const shell = /html\.pa-printing, html\.pa-printing body\{([^}]*)\}/.exec(css);
  assert.ok(shell, 'the print block overrides html AND body together');
  for (const [prop, val] of [['display', 'block'], ['height', 'auto'], ['overflow', 'visible']]) {
    const m = new RegExp(prop + ':' + val + '!important').test(shell[1]);
    assert.ok(m, `${prop}:${val} must be forced — found: ${shell[1]}`);
  }
  // !important is not decoration here: the rule it has to beat (html.standalone body) carries it.
  assert.match(S, /html\.standalone, html\.standalone body\{ height:100% !important/,
    'the standalone rule this must outrank still exists — if it is ever removed, revisit the above');
  assert.match(css, /#printRoot\{display:block!important;height:auto!important;overflow:visible!important\}/,
    'and the print surface itself must not be clipped either');
});

test('ink only, on white paper, by default', () => {
  // On screen the paper tint separates the page from the app. On paper it is a full-bleed colour
  // wash over every sheet — the note measured here is #fbf3c4 across 100% of each page — which
  // costs a great deal of colour toner and buys nothing a printed page needs.
  assert.match(P, /const\s+PAPER_WHITE\s*=\s*'#ffffff'/, 'print has its own paper colour');
  // The DEFAULT is the load-bearing part: only an explicit false opts out, so an unset preference
  // prints on white. Written as `inkOnly===false` rather than a truthiness test for that reason.
  assert.match(P, /inkOnly\s*===\s*false\s*\?\s*undefined\s*:\s*PAPER_WHITE/, 'only an explicit false opts out');
  assert.match(P, /note\.printPage\(i,ctx,scale,hCss,paper\b/, 'and the pad is told which paper');
  // undefined, not white, is what leaves the note's own colour in place.
  const fn = /function drawPaper\(ctx,h,bg,fit,pw\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'drawPaper takes a background override');
  assert.match(fn[0], /ctx\.fillStyle=bg\|\|paperColor\(\);/, 'the note keeps its colour when none is given');
  assert.match(E, /function paperColor\(\)\{ return NB\.bgColor\|\|PAPER_WHITE; \}/, '— its own colour, else the default');
});

test('ink that would vanish on white is reported, not silently dropped', () => {
  // The pen palette contains #ffffff and several near-whites, and every paper tint is light, so
  // white-on-yellow is a real thing to have drawn. Printed on white it disappears — which is ink
  // lost from the page with no sign, the shape this repo keeps having to stamp out (R5/R14).
  assert.match(E, /const\s+LIGHT_INK\s*=\s*0\.\d+/, 'the pad knows what counts as too light');
  assert.match(E, /lightInk:\(p\.strokes\|\|\[\]\)\.filter\(st=>inkLum\(st\.c\)>LIGHT_INK\)\.length/, 'and counts it per page');
  // Only a problem on white: against the note's own tint those strokes read fine.
  assert.match(P, /if\(paper&&pg\.lightInk\) warn\.lightInk=true;/, 'reported only when printing on white');
  assert.match(P, /lightInk:'浅色墨迹在白纸上看不见 · Very light ink will not show on white paper'/, 'bilingual, like every other message');
});

test('the print setting is a device preference that defaults ON', () => {
  // Same shape as the pad's one existing device toggle (fingerDraw): a checkbox that posts
  // kind:'pref', a shell that stores it, and a prefs broadcast that restores it everywhere.
  assert.match(E, /class="pan-inkcb" checked/, 'the box ships checked');
  assert.match(E, /kind:'pref',printInk/, 'the pad tells the shell');
  assert.match(S, /if\(typeof m\.printInk==='boolean'\) localStorage\.setItem\('pa_printink'/, 'the shell stores it');
  // THE DEFAULT INVERTS IF THIS IS WRITTEN ===\'1\'. fingerDraw reads ==='1' because its safe
  // default is off; this one's safe default is ON, so an unset value must read as true.
  assert.match(S, /printInk:localStorage\.getItem\('pa_printink'\)!=='0'/, "unset means ink-only");
  assert.ok(!/printInk:localStorage\.getItem\('pa_printink'\)==='1'/.test(S), 'never ===1 — that flips the default');
  assert.match(E, /typeof m\.printInk==='boolean'\)\{ printInk=m\.printInk/, 'and the pad restores it from the broadcast');
});

test('every page carries its number, a lone page included', () => {
  // Shipped multi-page-only first, reasoning that "1 / 1" was noise on a single sheet. Asked for
  // on every page instead: a printout leaves the app and becomes a loose sheet of paper, and the
  // marking is what makes it filable. Measured on a real render: glyph box ~63-69x32px inset
  // 4.2mm from both edges at 300dpi.
  // Numbered by SHEET, not by page: a tall page now prints as several sheets, and "2 / 3" has to
  // describe the stack in the reader's hand rather than an internal page count they cannot see.
  assert.match(P, /\n      stampPageNumber\(ctx,c,out\.length\+1,plan\.length\);/,
    'stamped unconditionally, once per emitted sheet');
  assert.ok(!/plan\.length>1\)\s*stampPageNumber/.test(P), 'not gated on sheet count');
  const fn = /function stampPageNumber\([\s\S]*?\n  \}/.exec(P);
  assert.ok(fn, 'the stamp is its own function');
  assert.match(fn[0], /n\+' \/ '\+total/, 'a numeric fraction, which needs no translation');
  assert.match(P, /NUM_SIZE=0\.013/, 'and small');
  assert.match(fn[0], /textAlign='center'/, 'bottom CENTRE — nothing else in the footer');
  assert.match(fn[0], /c\.width\/2, c\.height-inset/, 'centred on the sheet');
});

test('the page number is drawn INTO the image, never added to the sheet', () => {
  // Each sheet is now exactly page-shaped (SHEET_ASPECT). An extra element inside .pr-sheet would
  // push it past one printed page and emit a BLANK sheet after every note page — the same class of
  // bug as the app shell's fixed height, arriving from the opposite direction.
  const sheet = /root\.innerHTML=pages\.map\([^;]*\);/.exec(S);
  assert.ok(sheet, 'the shell builds the sheets');
  assert.ok(!/pr-num|pr-caption|<span|<p>/.test(sheet[0]),
    'a sheet holds the image and nothing else');
  assert.match(sheet[0], /<div class="pr-sheet"><img alt=""><\/div>/, 'image only');
  // Drawn in device pixels: printPage restores the transform, so the stamp must set its own.
  const fn = /function stampPageNumber\([\s\S]*?\n  \}/.exec(P);
  assert.match(fn[0], /setTransform\(1,0,0,1,0,0\)/, 'the stamp sets its own transform');
});

test('the stamp is the same physical size whatever the render resolution', () => {
  // Sizes as fractions of page WIDTH, not pixel constants: a page downscaled by the canvas-area
  // guard would otherwise get a stamp that grows relative to the paper.
  assert.match(P, /const NUM_INK='#\w{6}', NUM_SIZE=0\.\d+, NUM_INSET=0\.\d+;/, 'fractions, not pixels');
  const fn = /function stampPageNumber\([\s\S]*?\n  \}/.exec(P);
  assert.match(fn[0], /c\.width\*NUM_SIZE/, 'font size scales with the page');
  assert.match(fn[0], /c\.width\*NUM_INSET/, 'and so does the inset');
  // Both insets come off the WIDTH, so the corner gap is square and clears the printer's
  // non-printable border even at "no margins" (measured 4.2mm at 300dpi).
  assert.match(fn[0], /c\.height-inset/, "inset from the foot");
});

test('paper, rules and ink share ONE transform', () => {
  // Owner 2026-11-25: shrunk ink sat in a narrow column off the full-size rule lines. The scale
  // now comes FIRST and the paper is drawn inside it, out to the sheet edge (W/k), so the lines
  // shrink with the handwriting that sits on them and still reach the edge of the paper.
  const fn = /function printPage\(i,ctx,scale,hCss,paper,fit\)\{[\s\S]*?\n      return true; \}/.exec(E);
  assert.ok(fn, 'printPage takes the fit');
  const scaleAt = fn[0].indexOf('ctx.scale(k,k)'), paperAt = fn[0].indexOf('drawPaper(ctx,hCss/k,paper,null,W/k)');
  const inkAt = fn[0].indexOf('drawStroke(');
  assert.ok(scaleAt > 0 && paperAt > scaleAt && inkAt > paperAt, 'scale, then paper, then ink');
  assert.doesNotMatch(fn[0], /fit\.dx|fit\.dy|translate/, 'no separate content offset');
  assert.match(E, /function drawPaper\(ctx,h,bg,fit,pw\)\{/, 'paper takes its own width');
});

test('one note page prints as one sheet', () => {
  assert.match(P, /const plan=info\.pages\.map\(\(_,i\)=>i\);/, 'a sheet per page, nothing more');
  assert.doesNotMatch(P, /sheetsOf|fitSlice|fitContent/, 'per-page fitting is gone');
});
