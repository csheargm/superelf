// A note opens in the tool its page calls for · 笔记按内容选择打开时的工具
//
// Owner 2026-11-12 (Mac, Journal): a saved AI summary — typed text, no ink — opened on Draw, and
// the first click on it drew a stroke. ONE pad serves every note, so the tool also carried over
// from the last note. Rule (web/note-ui.inline.html openToolFor/applyOpenTool): on each OPEN
// (boot, reload to a different note) text-only → 'text'; ink → the host's draw tool; empty → the
// host's opts.tool. A refresh of the same note, or a change the user makes inside it, is kept.
//
// Known limit: no fake-DOM harness runs the whole Note() closure (it needs ~200 DOM nodes); the
// decision and the per-open state machine are lifted VERBATIM from the engine and RUN here, and
// the call sites in boot/reload are pinned by source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ENGINE, APP_SRC, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);
const grab = (re, what) => { const m = re.exec(E); assert.ok(m, `${what} must be findable`); return m[0]; };
const TOOLS_SRC = grab(/const TOOLS=\[[\s\S]*?\];/, 'TOOLS');
const INKS_SRC = grab(/const INKS=[^;]*;/, 'INKS') + grab(/const FIRST_INK=[^;]*;/, 'FIRST_INK');
const HAS_TEXT = grab(/const pageHasText=[^\n]*/, 'pageHasText');
const OPEN_FOR = grab(/function openToolFor\(pg,hostTool,byContent,textFirst\)\{[\s\S]*?\n  \}/, 'openToolFor');
const APPLY = grab(/function applyOpenTool\(\)\{[\s\S]*?\n    \}/, 'applyOpenTool');
const STARTS = grab(/function textStartsFirst\(pg\)\{[\s\S]*?\n    \}/, 'textStartsFirst');

// The engine's own decision, evaluated as written. `src` lets the mutation control swap it.
function decide(src = OPEN_FOR) {
  // eslint-disable-next-line no-new-func
  return new Function(`const ico=()=>'';${TOOLS_SRC}${INKS_SRC}${HAS_TEXT}\n${src}\nreturn openToolFor;`)();
}
// The pad as a little state machine around the REAL applyOpenTool: open(note) mirrors reload's
// "different id → applyOpenTool; then text → enterTextMode(noFocus)"; pick() is a user's tab tap.
function pad(hostTool, { byContent = true, src = OPEN_FOR } = {}) {
  const st = { tool: hostTool, lastDraw: 'pen', page: null, id: null, entered: [], strokes: 0, lit: null, row: false, textFirst: false };
  // eslint-disable-next-line no-new-func
  const apply = new Function('st', `const ico=()=>'';${TOOLS_SRC}${INKS_SRC}${HAS_TEXT}\n${src}
    const OPEN_TOOL=st.host, BY_CONTENT=st.by, page=()=>st.page, clearSelection=()=>{}, closePops=()=>{};
    const syncMode=()=>{ st.lit=tool==='text'?'text':drawRowOpen?'draw':'none'; };   // = the engine's syncMode: Draw lights only with its row open
    const toolBtns=[], topBar=true, textStartsFirst=()=>st.textFirst;
    let tool; let lastDraw; let drawRowOpen;
    ${APPLY}
    return ()=>{ tool=st.tool; lastDraw=st.lastDraw; drawRowOpen=st.row; const nf=applyOpenTool(); st.tool=tool; st.lastDraw=lastDraw; st.row=drawRowOpen; return nf; };`);
  st.host = hostTool; st.by = byContent;
  const run = apply(st);
  return {
    st,
    load(note) { const was = st.id; st.page = note.page; st.id = note.id; st.textFirst = !!note.textFirst;
      const nf = note.id !== was ? run() : false; if (st.tool === 'text') st.entered.push(nf ? 'nofocus' : 'focus'); return nf; },
    pick(t) { st.tool = t; if (t !== 'text') st.row = true; st.lit = t === 'text' ? 'text' : 'draw'; },
    click() { if (st.tool !== 'text' && st.tool !== 'select') st.strokes++; },
  };
}
const TEXT = { id: 'summary', page: { strokes: [], pageHtml: '<div>Summary of October</div>' } };
const INK = { id: 'ink', page: { strokes: [{ p: [[0.1, 0.1]] }], pageHtml: '' } };
const MIXED = { id: 'mixed', page: { strokes: [{ p: [[0.1, 0.1]] }], pageHtml: '<div>words</div>' } };
const EMPTY = { id: 'empty', page: { strokes: [], pageHtml: '<div><br></div>&nbsp;' } };
const PHOTO = { id: 'photo', page: { strokes: [], images: [{ path: 'p.jpg', x: 0.1, y: 0.05, w: 0.5, h: 0.3 }], pageHtml: '' } };
const PHOTO_TEXT = { id: 'photo-text', page: { strokes: [], images: [{ path: 'p.jpg', x: 0.1, y: 0.4, w: 0.5, h: 0.3 }], pageHtml: '<div>notes</div>' } };

test('a text-only note opened after drawing on an ink note opens on T; a click adds no stroke', () => {
  for (const host of ['select', 'pen']) {                    // Journal desktop / iPad
    const p = pad(host);
    p.load(INK); p.pick('pen'); p.click();
    assert.equal(p.st.strokes, 1, 'control: the pen draws');
    p.load(TEXT);
    assert.equal(p.st.tool, 'text', `${host} host: the summary opens in text mode`);
    assert.equal(p.st.lit, 'text', 'the T tab is lit');
    assert.equal(p.st.entered.at(-1), 'nofocus', 'no caret forced / no iPad keyboard');
    p.click();
    assert.equal(p.st.strokes, 1, 'a click on the summary draws nothing');
  }
});

test('an ink note opened after the text note gets the host draw tool, not the carried-over text', () => {
  for (const host of ['select', 'pen']) {
    const p = pad(host); p.load(TEXT); p.load(INK);
    assert.equal(p.st.tool, host); assert.equal(p.st.lit, 'draw');
  }
});

test('empty note → opts.tool; mixed text + ink → the draw tool', () => {
  const f = decide();
  for (const host of ['select', 'pen', 'text']) assert.equal(f(EMPTY.page, host, true), host, `empty keeps ${host}`);
  // A mixed page opens on what it STARTS with (owner 2026-11-13); the caller measures textFirst.
  assert.equal(f(MIXED.page, 'select', true, false), 'select', 'ink first → draw tool');
  assert.equal(f(MIXED.page, 'pen', true, false), 'pen');
  assert.equal(f(MIXED.page, 'pen', true, true), 'text', 'text first → T');
  assert.equal(f(INK.page, 'pen', true, true), 'pen', 'ink only → draw, whatever textFirst says');
});

test('Bible (opts.tool text): a page with ink or a picture opens on Draw (the pen); a text page stays text (owner 2026-11-22)', () => {
  const p = pad('text');
  p.load(TEXT); assert.equal(p.st.tool, 'text');
  assert.equal(p.st.entered.at(-1), 'focus', 'the Bible asked for text, so a text page still takes the caret');
  p.load(EMPTY); assert.equal(p.st.tool, 'text', 'an empty page keeps the host tool');
  p.load(INK); assert.equal(p.st.tool, 'pen', 'an ink page opens on the pen, as in the Journal');
  p.load(PHOTO); assert.equal(p.st.tool, 'pen', 'a picture page opens on the pen');
  p.load(TEXT); assert.equal(p.st.tool, 'text', 'and the next text note goes back to T');
});

test('pictures count like ink in every host; a text-first page with a picture opens on T', () => {
  const f = decide();
  for (const host of ['pen', 'text']) assert.equal(f(PHOTO.page, host, true, false), 'pen', `${host}: picture only → Draw`);
  assert.equal(f(PHOTO_TEXT.page, 'text', true, true), 'text', 'words above the picture → T');
  assert.equal(f(PHOTO_TEXT.page, 'text', true, false), 'pen', 'picture above the words → Draw');
});

test('a Draw chosen inside the text note stays until the next open; a same-note refresh keeps it', () => {
  const p = pad('select');
  p.load(TEXT); p.pick('pen');
  p.load(TEXT);                                              // refresh: same id
  assert.equal(p.st.tool, 'pen', 'the user\'s tool survives a refresh');
  p.load(INK); p.load({ ...TEXT, id: 'summary-2' });
  assert.equal(p.st.tool, 'text', 'the next text note opens on T again');
});

test('opts.toolByContent:false opts out', () => {
  const p = pad('select', { byContent: false }); p.load(TEXT);
  assert.equal(p.st.tool, 'select');
});

test('mutation control: with the content rule removed, the first scenario fails', () => {
  const broken = OPEN_FOR.replace(/return text\?'text':hostTool;/, 'return hostTool;');
  assert.notEqual(broken, OPEN_FOR, 'the mutation applied');
  const p = pad('select', { src: broken }); p.load(INK); p.pick('pen'); p.load(TEXT);
  assert.notEqual(p.st.tool, 'text', 'without the rule the summary opens on Draw — the reported bug');
});

test('wiring: boot and reload call the rule, reload only for a different note', () => {
  assert.match(E, /const BY_CONTENT=!\(opts&&opts\.toolByContent===false\);/, 'default on');
  assert.match(E, /reload:async\(applyScope\)=>\{ if\(tool==='text'\) exitTextMode\(\);\s*userPicked=false;[\s\S]*?const wasId=NB\.id; await pull\(true\);[\s\S]*?const rule=NB\.id!==wasId&&!userPicked;[\s\S]*?const nf=rule\?applyOpenTool\(\):false;\s*if\(tool==='text'\) enterTextMode\(nf\);/,
    'reload: a different notebook id → choose; same id → keep');
  assert.match(E, /await pull\(false\);[^\n]*\n\s*if\(!userPicked\)\{ if\(tool==='text'\) exitTextMode\(\); const nf=applyOpenTool\(\); if\(tool==='text'\) enterTextMode\(nf\); \}/,
    'boot: after the first pull, unless the user picked a tool in the load window');
  assert.match(E, /function enterTextMode\(noFocus\)\{/);
  assert.match(E, /if\(!noFocus\)\{ textLayer\.focus\(\); caretToEnd\(textLayer\); \}/, 'noFocus skips the caret');
  assert.match(E, /hasText:pageHasText\(p\),/, 'print uses the same text test (R3)');
});

test('hosts: Journal opens select/pen, Bible text, none opts out', () => {
  for (const k of ['notes (template)', 'notes (live)']) assert.match(APP_SRC[k], /tool:\(window\.matchMedia&&matchMedia\('\(pointer: coarse\)'\)\.matches\)\?'pen':'select',/, k);
  for (const k of ['bible (template)', 'bible (live)']) assert.match(APP_SRC[k], /tool:'text', template:'plain',/, k);
  for (const k of Object.keys(APP_SRC)) assert.doesNotMatch(APP_SRC[k], /toolByContent/, `${k} keeps the default`);
});

test('a tool tapped while the note is still loading wins over the content rule (review 2026-11-12)', () => {
  const ENG = fs.readFileSync(new URL('../web/note-ui.inline.html', import.meta.url), 'utf8');
  assert.match(ENG, /let userPicked=false;/, 'one flag');
  assert.match(ENG, /const t=b\.dataset\.tool; userPicked=true;/, 'a toolbar tap sets it');
  assert.equal((ENG.match(/userPicked=true; (?:if\(!inking\) )?await setTool\(/g) || []).length, 2, 'both mode tabs set it');
  assert.match(ENG, /if\(!userPicked\)\{ if\(tool==='text'\) exitTextMode\(\); const nf=applyOpenTool\(\);/, 'boot gates the rule on the flag, not on tool===OPEN_TOOL');
  assert.ok(!/if\(tool===OPEN_TOOL\)\{ if\(tool==='text'\) exitTextMode/.test(ENG), 'CONTROL: the old equality gate is gone');
  assert.ok(ENG.indexOf('userPicked=false;   // reset at the START') < ENG.indexOf('const r=await flushSave();'), 'the flag resets before the save and the load, so a tap at any point wins');
});

// Owner 2026-11-13 (iPhone): an AI summary — typed headings and bullets, plus a stray ink dot from
// before the 11-12 fix — opened on a pen behind a CLOSED draw row: neither tab lit, taps not typing.
const SUMMARY_DOT = { id: 'sumdot', textFirst: true, page: { strokes: [{ p: [[0.1, 0.9]] }], pageHtml: '<h2>AI summary</h2><ul><li>FDE</li></ul>' } };
test('a typed note with a stray dot BELOW its text opens on T (it starts with text)', () => {
  for (const host of ['select', 'pen']) {
    const p = pad(host); p.load(INK); p.load(SUMMARY_DOT);
    assert.equal(p.st.tool, 'text', `${host}: starts with text → Text mode`);
    assert.equal(p.st.lit, 'text');
  }
});
test('a note that starts with ink opens with Draw LIT — never neither tab', () => {
  for (const host of ['select', 'pen']) {
    const p = pad(host); p.load(TEXT); p.load(INK);
    assert.equal(p.st.lit, 'draw', `${host}: the Draw tab is selected`);
    const q = pad(host); q.load(TEXT); q.load({ ...MIXED, textFirst: false });
    assert.equal(q.st.lit, 'draw', `${host}: ink-first mixed page lights Draw`);
  }
  const e = pad('pen'); e.load(TEXT); e.load(EMPTY);
  assert.notEqual(e.st.lit, 'text', 'CONTROL: an empty page does not pick Text');
});
test('textStartsFirst compares the first typed line with the top-most ink, in page px', () => {
  assert.match(STARTS, /if\(!strokes\.length&&!images\.length\) return true;/);
  assert.match(STARTS, /for\(const im of images\) if\(\(im\.y\|\|0\)<inkTop\) inkTop=im\.y\|\|0;/, 'a picture\'s top counts as the top-most visual');
  assert.match(STARTS, /return \(b\.top-pr\.top\)\/\(pr\.width\/W\) <= inkTop\*W;/, 'screen px → page px, ink y is normalised by W');
  assert.match(APPLY, /openToolFor\(pg,OPEN_TOOL,BY_CONTENT,BY_CONTENT&&pg\?textStartsFirst\(pg\):false\)/, 'the measured answer reaches the rule');
});

test('a pane that cannot be measured (hidden) opens a page with text on T, never on a pen', () => {
  assert.match(STARTS, /if\(!pr\.width\|\|!W\) return true;/);
});
