// web/note-text.inline.html — the Transcript panel（转写）, RUN against a small DOM stub with a fake
// PAStore.ask: the state line (transcribing / failed with reason / needs the Mac node / transcribed /
// nothing / not saved), the per-page ink, photo text and labels, the re-read while pages are owed,
// close. Plus the pins that wire it: the page-settings row and its handler in PANote, the marker,
// web.mjs's registration after note-ui, the selectable-panel exemption, and both hosts' opts.doc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SRC, stripComments } from './helpers-app.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TEXT = read('web/note-text.inline.html'), ENGINE = read('web/note-ui.inline.html'), WEB = read('web.mjs');
const E = stripComments(ENGINE);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function el(tag) {
  const on = {}, qs = {};
  const e = { tag, className: '', innerHTML: '', _t: '', children: [], on, attrs: {},
    classList: { add: (k) => { e.className = [...new Set([...e.className.split(' ').filter(Boolean), k])].join(' '); }, remove: (k) => { e.className = e.className.split(' ').filter((x) => x && x !== k).join(' '); }, contains: (k) => e.className.split(' ').includes(k) },
    appendChild(k) { e.children.push(k); return k; }, setAttribute(k, v) { e.attrs[k] = v; },
    addEventListener(t, fn) { (on[t] ||= []).push(fn); }, querySelector: (s) => (qs[s] ||= el(s)),
    set textContent(v) { e._t = String(v); }, get textContent() { return e._t; } };
  return e;
}
const WHERE = { ink: 'Ink 手写', photo: 'Photo 图片', transcript: '转写 · Transcript' };   // the title is PANote's ONE constant (R3)
// One attached panel over a fake host. `answer` plays the node (PAStore.ask); `doc` is the host's.
function panel({ answer, doc = () => ({ path: 'entry-1.json', scope: '' }) } = {}) {
  const src = TEXT.slice(TEXT.indexOf('>', TEXT.indexOf('<script id="pnt-script">')) + 1, TEXT.indexOf('</script>', TEXT.indexOf('<script id="pnt-script">')));
  const asked = [];
  const window = { PA_TEXT_REFRESH_MS: 30, PANote: { SEARCH_TXT: WHERE }, ...(answer ? { PAStore: { ask: async (o) => { asked.push(o); return answer(asked.length); } } } : {}) };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(window, { createElement: el });
  const host = el('host');
  const p = window.PANoteText.attach({ host, doc });
  const dom = host.children[0];
  return { p, asked, dom, TXT: window.PANoteText.TXT, state: () => dom.querySelector('.pan-trstate').textContent, body: () => dom.querySelector('.pan-trbody').innerHTML,
    close: () => { for (const fn of dom.on.click || []) fn({ target: { closest: (s) => (s === '.pan-trx' ? {} : null) } }); } };
}
const page = (n, extra) => ({ path: 'entry-1.json', scope: '', page: n, pending: false, src: { typed: 'typed', ink: '', photo: '' }, labels: [], ...extra });

test('open asks the node for THIS note\'s pages (src + labels, by path and scope) and shows ink, photo text and labels per page; typed-only pages are left out', async () => {
  const P = panel({ answer: () => ({ ok: true, pages: [
    page(0, { src: { typed: 'typed', ink: 'line one\nline two #ores', photo: '' } }),
    page(1),
    page(2, { src: { typed: '', ink: '', photo: 'Receipt <total> 12.50' }, labels: ['document', 'receipt'] }),
  ], pending: 0, ocr: 'ready' }) });
  assert.equal(P.dom.className, 'pan-tr'); assert.equal(P.dom.attrs.role, 'dialog');
  assert.match(P.dom.innerHTML, /转写 · Transcript/); assert.match(P.dom.innerHTML, /class="pan-trx"/, 'a close button');
  assert.equal(await P.p.open(), true);
  assert.deepEqual(P.asked, [{ kind: 'note-text', paths: ['entry-1.json'], scope: '', fields: ['src', 'labels'] }], 'the note\'s file and scope, the transcript fields, no tags');
  assert.ok(P.p.isOpen());
  assert.equal(P.state(), P.TXT.ready);
  const b = P.body();
  assert.match(b, /<div class="pan-trpg">第 1 页 · Page 1<\/div><div class="pan-trsrc">Ink 手写<\/div><div>line one\nline two #ores<\/div>/, 'page numbers are 1-based; the heading is PANote\'s own where-label');
  assert.doesNotMatch(b, /Page 2/, 'a typed-only page has no transcript');
  assert.match(b, /第 3 页 · Page 3<\/div><div class="pan-trsrc">Photo 图片<\/div><div>Receipt &lt;total&gt; 12.50<\/div><div class="pan-trsrc">图片标签 · Picture labels<\/div><div>document · receipt<\/div>/, 'escaped, labels joined');
  P.close();
  assert.equal(P.p.isOpen(), false);
});

test('the state line: transcribing re-reads until the page is done; failed on this node carries the reason; needs the Mac node; a page failure; nothing to show', async () => {
  const T = panel({ answer: (n) => ({ ok: true, pages: [page(0, { pending: n < 3, src: { typed: '', ink: n < 3 ? '' : 'done now', photo: '' } })], pending: n < 3 ? 1 : 0, ocr: 'ready' }) });
  await T.p.open();
  assert.equal(T.state(), T.TXT.transcribing);
  assert.match(T.body(), /Page 1/, 'an owed page is listed while it is transcribed');
  await tick(100);
  assert.equal(T.asked.length, 3, 're-read every interval while owed, then stopped');
  assert.equal(T.state(), T.TXT.ready); assert.match(T.body(), /done now/);
  const F = panel({ answer: () => ({ ok: true, pages: [page(0, { pending: true })], pending: 1, ocr: 'failed', reason: 'swiftc: no toolchain' }) });
  await F.p.open();
  assert.equal(F.state(), '本机识别失败 · Failed on this node — swiftc: no toolchain');
  F.close(); await tick(60);
  assert.equal(F.asked.length, 1, 'closing stops the re-read');
  const U = panel({ answer: () => ({ ok: true, pages: [page(0, { pending: true })], pending: 1, ocr: 'unavailable' }) });
  await U.p.open(); assert.equal(U.state(), U.TXT.noOcr); await tick(60);
  assert.equal(U.asked.length, 1, 'no Mac node: nothing can progress, so no re-read is armed'); U.close();
  await tick(60); assert.equal(F.asked.length, 1, 'an environmental failure arms no re-read either');
  const B = panel({ answer: () => ({ ok: true, pages: [page(0, { error: 'panote-ocr ink: tool died' })], pending: 0, ocr: 'ready' }) });
  await B.p.open(); assert.equal(B.state(), '本机识别失败 · Failed on this node — panote-ocr ink: tool died');
  const N = panel({ answer: () => ({ ok: true, pages: [page(0)], pending: 0, ocr: 'ready' }) });
  await N.p.open(); assert.equal(N.state(), N.TXT.none); assert.equal(N.body(), '');
});

test('no doc (a note not saved yet) asks nothing; a failed read is said on the state line; a reply after close is dropped (R5)', async () => {
  const D = panel({ answer: () => ({ ok: true, pages: [] }), doc: () => null });
  assert.equal(await D.p.open(), false); assert.equal(D.state(), D.TXT.unsaved); assert.deepEqual(D.asked, []);
  const F = panel({ answer: () => ({ ok: false, code: 'server-error', text: '笔记文本失败 (500) · Note text failed' }) });
  await F.p.open(); assert.equal(F.state(), '笔记文本失败 (500) · Note text failed');
  const N = panel();   // no PAStore on the page
  await N.p.open(); assert.equal(N.state(), N.TXT.unavailable);
  let release; const slow = new Promise((r) => { release = r; });
  const L = panel({ answer: () => slow });
  const opening = L.p.open(); L.close(); release({ ok: true, pages: [page(0, { src: { typed: '', ink: 'late', photo: '' } })] });
  assert.equal(await opening, false); assert.equal(L.body(), '', 'the late reply did not paint a closed panel');
});

test('pins: the panel paints ABOVE the pad header (its ✕ must be tappable) and a reload of another note closes it', () => {
  const z = (src, cls) => Number((src.match(new RegExp(`\\.${cls}\\{[^}]*z-index:(\\d+)`)) || [])[1]);
  assert.ok(z(TEXT, 'pan-tr') > z(ENGINE, 'pan-top'), `pan-tr ${z(TEXT, 'pan-tr')} must be above pan-top ${z(ENGINE, 'pan-top')}`);
  assert.ok(z(TEXT, 'pan-tr') < z(ENGINE, 'pan-fs'), 'and below the fullscreen layer');
  assert.match(E, /reload:async\(applyScope\)=>\{[^\n]*\n\s*if\(textPanel\) textPanel\.close\(\);/, 'reload() closes the transcript of the outgoing note');
});

test('pins: PANote\'s page-settings row opens it, the marker and registration follow note-ui, the panel is selectable, both hosts pass opts.doc', () => {
  const sheet = E.slice(E.indexOf("'<div class=\"pan-pop pan-paperpop\">'"), E.indexOf("'<div class=\"pan-customlbl\">模板 · Template</div>'"));
  assert.match(sheet, /<button class="pan-photoopt pan-pgtext" data-pg="text">.*SEARCH_TXT\.transcript/, 'one row in the page-settings sheet, before Template');
  assert.match(E, /else if\(a==='text'\)\{ if\(textPanel\) textPanel\.open\(\); else flash\(NO_TEXT_PANEL\); \}/, 'the data-pg dispatcher opens it (or says the component is missing)');
  assert.match(E, /const textPanel=window\.PANoteText\?window\.PANoteText\.attach\(\{host,doc:\(\)=>\(typeof opts\.doc==='function'\?opts\.doc\(\):null\)\}\):null;/, 'PANote lends it the host and the host\'s doc()');
  assert.match(E, /transcript:\(\)=>textPanel\?textPanel\.open\(\):Promise\.resolve\(false\),/, 'and exposes it on the pad API');
  assert.ok(ENGINE.trimEnd().endsWith('<!--PA_NOTE_TEXT_UI-->'), 'the marker ends note-ui');
  const comps = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('];', WEB.indexOf('const PA_COMPONENTS = [')));
  assert.ok(comps.indexOf("file: 'note-text.inline.html'") > comps.indexOf("file: 'note-ui.inline.html'"), 'registered after note-ui');
  assert.match(E, /closest\('\.pan-txted,\.pan-linkpop,\.pan-tr'\)/, 'the selectstart guard lets the panel be selected (copy is the owner\'s act)');
  assert.match(TEXT, /\.pan-trbody\{[^}]*user-select:text/, 'and the body says so in CSS');
  for (const k of ['notes (live)', 'notes (template)']) assert.match(APP_SRC[k], /\n  doc:\(\)=>curId\?\{path:entryPath\(curId\)\}:null,/, `${k}: the journal names its entry file, none for a blank page`);
  for (const k of ['bible (live)', 'bible (template)']) assert.match(APP_SRC[k], /\n  doc:\(\)=>\(\{path:chapterFile\(bookIdx,chapter\),scope:_drawScope\}\),/, `${k}: the Bible names its chapter file and draws key`);
  assert.doesNotMatch(TEXT, /save-data|pageHtml|strokes/, 'the component never writes a note: the transcript is read, not stored');
});
