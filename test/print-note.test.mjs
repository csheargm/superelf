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
  const body = /function pageHeight[\s\S]*?return px>MAX_PX \? s\*Math\.sqrt\(MAX_PX\/px\) : s;\n  \}/.exec(P);
  assert.ok(body, 'pageHeight and fitScale must be extractable');
  const consts = /const TARGET_W=(\d+);/.exec(P)[1] + ',' + /const MAX_PX=([\d.e]+);/.exec(P)[1];
  const pads = /const PAD_RATIO=([\d.]+), SHEET_ASPECT=([\d.]+);/.exec(P);
  return new Function(
    `const TARGET_W=${consts.split(',')[0]}, MAX_PX=${consts.split(',')[1]};` +
    `const PAD_RATIO=${pads[1]}, SHEET_ASPECT=${pads[2]};` +
    body[0] + '; return { pageHeight, fitScale, fitContent, TARGET_W, MAX_PX };'
  )();
})();

test('a page prints at 300dpi across a sheet', () => {
  // A4 portrait inside 10mm margins is 190mm ≈ 7.48in. 2244/7.48 ≈ 300.
  assert.equal(API.TARGET_W, 2244);
  assert.ok(Math.abs(API.TARGET_W / 7.48 - 300) < 2, 'the target width is 300dpi, not a round number');
  // Measured against the real notebook: a 900px-wide page renders 2244px across.
  assert.equal(Math.round(900 * API.fitScale(900, 400)), 2244);
});

test('every page is the same page-shaped box, whatever the ink', () => {
  // TWO failures forced this, one from each side. A height that followed the content printed a
  // white band under short pages; and when it exceeded the printable box, the overflow cost a
  // WHOLE SHEET (iPad, 2026-09-12: a 4-page note printed as 8 — content, blank, content, blank,
  // each blank carrying the page-number stamp that had spilled off the page before it).
  const info = { width: 900 };
  const sheet = Math.round(900 * 1.20);
  for (const extent of [0, 0.172, 1.132, 1.234, 2.0]) {
    assert.equal(API.pageHeight(info, { extent }), sheet, `extent ${extent} is the same box`);
  }
});

test('a page that holds more than the sheet is scaled to fit, not spilled', () => {
  const info = { width: 900 };
  // Shorter than the page: untouched.
  assert.equal(API.fitContent(info, { extent: 0.5 }).k, 1, 'short pages are not scaled');
  // Taller: scaled so the ink lands inside the page. Measured on a real render, the lowest ink on
  // an extent-2.0 page sat at 98.2% of the sheet — inside it, not cut off at the edge.
  const tall = API.fitContent(info, { extent: 2.0 });
  assert.ok(tall.k < 1 && tall.k > 0, 'tall pages shrink');
  assert.ok((2.0 + 0.04) * tall.k <= 1.201, 'and land inside the page');
  assert.ok(tall.dx > 0, 'and stay centred while they do');
});

test('the page is shorter than the paper, on purpose', () => {
  // 1.20, not Letter's 1.294. The printable box is NOT the sheet: margins only make it relatively
  // TALLER (harmless), but an OS header/footer steals height ONLY, which lowers its aspect.
  // Measured: Letter with 10mm margins is 1.324, so a 1.294 render survives ~2% of stolen height
  // and spills at 4%. 1.20 tolerates ~9%, which covers iOS's URL/date footer.
  const letterPrintable = (279.4 - 20) / (215.9 - 20);
  assert.ok(1.20 < letterPrintable * 0.93,
    'the render leaves real headroom under the printable box, not a rounding margin');
  assert.match(P, /SHEET_ASPECT=1\.20;/, 'and the constant says so');
});

test('an oversized page loses resolution, never its ink', () => {
  // iOS caps canvas area and returns a BLANK canvas rather than throwing. Printing blank sheets
  // is indistinguishable from a note that failed to save, so the scale gives way instead.
  const full = API.fitScale(900, 400);
  const huge = API.fitScale(900, 14 * 900);
  assert.ok(huge < full, 'a very tall page is scaled down');
  assert.ok((900 * huge) * (14 * 900 * huge) <= API.MAX_PX * 1.001, 'and lands inside the pixel budget');
  // Every real page measured (max extent 1.07) must stay at full resolution.
  assert.equal(API.fitScale(900, API.pageHeight({ width: 900 }, { extent: 1.07 })), full,
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
  const fn = /function drawPaper\(ctx,h,bg,fit\)\{[\s\S]*?\n    \}/.exec(E);
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
  // One note page per sheet, fitted to the PAGE WIDTH.
  assert.match(S, /\.pr-sheet img\{display:block;width:100%;height:auto/, 'the image fills the page width');
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
  const fn = /function drawPaper\(ctx,h,bg,fit\)\{[\s\S]*?\n    \}/.exec(E);
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
  assert.match(P, /lightInk:'Very light ink will not show on white paper · 浅色墨迹在白纸上看不见'/, 'bilingual, like every other message');
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
  assert.match(fn[0], /textAlign='right'/, 'bottom RIGHT');
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
  assert.match(fn[0], /c\.width-inset, c\.height-inset/, 'inset from both edges equally');
});

test('the paper fills the page even when the writing is shrunk', () => {
  // Only the CONTENT scales. Scaling the paper with it would shrink the painted area and leave
  // the very white band that fitting the page to the sheet exists to remove — a mutation that
  // survived the first pass of these tests, which is why the ORDER is pinned and not just the
  // presence of a transform.
  const fn = /function printPage\(i,ctx,scale,hCss,paper,fit\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'printPage takes the fit');
  const paperAt = fn[0].indexOf('drawPaper(');
  const scaleAt = fn[0].indexOf('ctx.scale(fit.k');
  assert.ok(paperAt > 0 && scaleAt > 0, 'both the paper and the fit transform are there');
  assert.ok(paperAt < scaleAt, 'the paper is painted BEFORE the content is scaled down');
  // And the scale applies to the ink that follows it.
  const inkAt = fn[0].indexOf('drawImages(');
  assert.ok(scaleAt < inkAt, 'the ink is drawn inside the scaled transform');
});

// ── a tall page becomes several sheets ───────────────────────────────────────────────────────
test('print breaks where the screen draws its divider', () => {
  // The seamless view draws a fold at every sheet boundary. If print broke somewhere else the
  // divider would be a lie — writing would land across a boundary the user thought they saw.
  assert.match(E, /sheetH:PAGE_H,/, 'the pad exports the sheet it divides on');
  assert.match(P, /const w=info\.width\|\|700, sheetH=info\.sheetH\|\|pageHeight\(info\);/,
    'print reads it rather than owning a second one');
});

test('a tall page prints as several sheets instead of one shrunken one', () => {
  // Before: a five-sheet note was scaled onto a single sheet at 20%, which is not a printout of
  // anything. fitContent still handles a SHORT page exactly as it did.
  assert.match(P, /function sheetsOf\(info,pg\)\{/, 'sheets are counted from the content');
  assert.match(P, /Math\.ceil\(contentH\/sheetH\)/, 'one per sheet-height of content');
  assert.match(P, /if\(sheetsOf\(info,pg\)<=1\) return fitContent\(info,pg\);/,
    'a short page keeps its old behaviour exactly');
  assert.match(P, /dy:-s\*sheetH\*k/, 'each later sheet shows a later slice');
  // The plan is built before rendering, so the page-number total is known for the first sheet.
  assert.match(P, /const plan=\[\];/, 'the sheet plan is computed up front');
});

test('the emitted image aspect is unchanged, deliberately', () => {
  // The slice is Letter (1.294) but the IMAGE stays 1.20, so content shrinks ~7% and sits with a
  // small band. The shell prints images at width:100%;height:auto — an image taller in aspect
  // than the printable box spills onto the next sheet and costs a blank one (SCAR 2026-09-12:
  // a 4-page note printed as 8 sheets, content/blank/content/blank). The band is what buys that.
  // The emitted image is SHORTER than the sheet, deliberately. Using the pad's own sheet height
  // made one printed sheet exactly the page on screen — correct on a laptop, and wrong on iPad,
  // where iOS Safari always prints its own header and footer (URL, date, "Page 1 of 4") with no
  // way to switch them off. They take the printable box from ~1.324 to ~1.26, so a 1.294 image
  // spilled and a 2-page note printed as 4 sheets — sheets 2 and 4 carrying our own "1/2" and
  // "2/2" stamps at the top, which is how it was identified.
  assert.match(P, /function pageHeight\(info\)\{ return Math\.round\(\(info\.width\|\|700\)\*SHEET_ASPECT\); \}/,
    'the image height comes from the safe aspect, never from the page');
  assert.doesNotMatch(/function pageHeight[\s\S]*?\}/.exec(P)[0], /sheetH/,
    'info.sheetH must not creep back in here');
  assert.match(P, /const k=pageH\/sheetH;/, 'a screen sheet is fitted into a printed sheet');
});

test('the sheet count is bounded', () => {
  // A corrupt extent should not ask the printer for ten thousand sheets. The pad caps its own
  // surface at five, so anything past this guard is bad data rather than a long note.
  assert.match(P, /const MAX_SHEETS_PER_PAGE=8;/, 'a named ceiling');
  assert.match(P, /Math\.min\(MAX_SHEETS_PER_PAGE,Math\.ceil/, 'applied to the count');
});

test('one page prints as one sheet', () => {
  // SCAR. A page is now at least as tall as the SCREEN, so it can exceed a Letter sheet, and
  // writing at the bottom of the screen sits below the sheet line. Splitting there was literally
  // correct and completely unhelpful: a 2-page note printed as 4 sheets, three nearly empty.
  // What the user counted was pages, and what they expected back was pages.
  assert.match(P, /const SPLIT_TALL_PAGES=false;/, 'splitting is off');
  assert.match(P, /if\(!SPLIT_TALL_PAGES\) return 1;/, 'so every page contributes exactly one sheet');
  // The splitting path is kept, not deleted: it exists for a page that is genuinely several
  // sheets long — the seamless view — which is withdrawn rather than abandoned.
  assert.match(P, /Math\.ceil\(contentH\/sheetH\)/, 'the split arithmetic survives behind the flag');
  assert.match(P, /dy:-s\*sheetH\*k/, 'as does the slice offset');
});

test('a page taller than a sheet is fitted, not cropped', () => {
  // fitContent scales the whole page down when its content exceeds the sheet. Without it the foot
  // of a screen-tall page — exactly where "bottom of page 1" gets written — would be cut off.
  const fn = /function fitContent\(info,pg\)\{[\s\S]*?\n  \}/.exec(P);
  assert.ok(fn, 'fitContent must be findable');
  assert.match(fn[0], /const k=contentH>pageH \? pageH\/contentH : 1;/, 'shrink to fit, never crop');
  assert.match(fn[0], /dx:\(w\*\(1-k\)\)\/2/, 'and stay centred while it does');
});
