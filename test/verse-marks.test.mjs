// Bible verse marks（经文高亮）— docs/plans/annotation-anchoring.md §3 (d), shipped as
// web/verse-marks.inline.html. The flow is driven on the shipped Bible app (helpers-app runApp, a
// real server, the app's OWN save path) with the component's real script: select a verse → Mark →
// a colour → ANN.marks lands in the chapter file (never the notebook) → the re-render paints a
// <mark> → a BSB wording change re-anchors a range by its quote → an unfindable quote shows the
// whole-verse fallback with the badge → Remove deletes → the dots and the ☰ chip count marks.
// CONTROL: no selection, no Mark entry; the store never carries a pixel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, APP_SRC, startHarness, runApp, until, fakeEl, scriptOf } from './helpers-app.mjs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';
import { nb, put as putIn } from './helpers-note.mjs';

const COMPONENT = fs.readFileSync(path.join(ROOT, 'web', 'verse-marks.inline.html'), 'utf8');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');

// ── a DOM just deep enough for the component: elements that keep their children, a text
//    selection the test sets, and a Range whose prefix text the test states ───────────────────
function el(tag, extra = {}) {
  const e = fakeEl(tag);
  e.nodeType = 1; e.children = []; e.parentNode = null;
  e.appendChild = (c) => { c.parentNode = e; e.children.push(c); return c; };
  e.remove = () => { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter((c) => c !== e); e.parentNode = null; };
  e.contains = (x) => { for (let n = x; n; n = n.parentNode) if (n === e) return true; return false; };
  e.querySelectorAll = () => [];
  // As in the DOM, a textContent write replaces the markup: a plain repaint must clear old <mark>s.
  let txt = ''; Object.defineProperty(e, 'textContent', { get: () => txt, set: (v) => { txt = String(v); e.innerHTML = txt; } });
  return Object.assign(e, extra);
}
// A verse block as renderVerses builds it: .vnum, .ven, .vzh under .verse[data-n].
function verseEl(n) {
  const v = el('div'); v.dataset.n = String(n); v._cls.add('verse');
  const en = el('div'), zh = el('div'); en._cls.add('ven'); zh._cls.add('vzh');
  const selfOrNull = (x, sel) => (sel.split(',').some((s) => x._cls.has(s.trim().slice(1))) ? x : null);
  for (const line of [en, zh]) {
    v.appendChild(line);
    line.matches = (sel) => !!selfOrNull(line, sel);
    line.closest = (sel) => selfOrNull(line, sel) || selfOrNull(v, sel);
  }
  v.closest = (sel) => selfOrNull(v, sel);
  v.querySelector = (sel) => (sel === '.ven' ? en : sel === '.vzh' ? zh : null);
  return v;
}
function loadComponent() {
  const state = { sel: null, body: el('body'), listeners: [] };
  const document = {
    createElement: (t) => el(t), body: state.body,
    addEventListener: (t, f) => state.listeners.push(t), removeEventListener: () => { state.listeners.pop(); },
    createRange: () => ({ selectNodeContents() {}, setEnd() {}, toString: () => (state.sel ? state.sel.before : '') }),
  };
  const window = { getSelection: () => (state.sel ? { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ commonAncestorContainer: state.sel.node, startContainer: {}, startOffset: 0, toString: () => state.sel.quote }) } : null) };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', scriptOf(COMPONENT))(window, document, (f) => f());
  return { PAVerseMarks: window.PAVerseMarks, state };
}

// ═══ pure anchoring ═══════════════════════════════════════════════════════════════════════════
test('resolve: offsets when they still hold the quote, else the quote\'s new place, else the whole line as an orphan', () => {
  const { PAVerseMarks: M } = loadComponent();
  const m = { kind: 'hl', color: 'green', lang: 'en', quote: 'loved', start: 11, end: 16 };
  assert.deepEqual(M.resolve('For God so loved the world', m), { start: 11, end: 16, orphan: false, whole: false });
  assert.deepEqual(M.resolve('For God loved the world so', m), { start: 8, end: 13, orphan: false, whole: false }, 'a BSB wording change: found by quote');
  assert.deepEqual(M.resolve('God cherished the world', m), { start: 0, end: 23, orphan: true, whole: true }, 'unfindable: whole verse, flagged');
  assert.deepEqual(M.resolve('abc', { kind: 'ul' }), { start: 0, end: 3, orphan: false, whole: true }, 'a whole-verse mark');
});

test('markupOf composes overlapping marks per character, escapes the text, and reports an orphan', () => {
  const { PAVerseMarks: M } = loadComponent();
  const text = 'a <b> c';
  assert.deepEqual(M.markupOf(text, [{ kind: 'hl', color: 'yellow' }]), { html: '<mark class="pvm pvm-hl-yellow">a &lt;b&gt; c</mark>', orphan: false });
  const both = M.markupOf('hello world', [{ kind: 'hl', color: 'pink' }, { kind: 'ul', lang: 'en', quote: 'world', start: 6, end: 11 }]);
  assert.equal(both.html, '<mark class="pvm pvm-hl-pink">hello </mark><mark class="pvm pvm-hl-pink pvm-ul">world</mark>');
  assert.equal(M.markupOf('hello world', [{ kind: 'hl', color: 'green', lang: 'en', quote: 'gone', start: 0, end: 4 }]).orphan, true);
  assert.deepEqual(M.markupOf('', [{ kind: 'hl' }]), { html: '', orphan: false });
  assert.equal(M.markupOf('x', [{ kind: 'hl', color: 'red" onclick="x' }]).html, '<mark class="pvm pvm-hl-yellow">x</mark>', 'a bogus store colour is clamped to the first swatch, never a class name');
});

// ═══ the flow, on the shipped app ═════════════════════════════════════════════════════════════
const VERSES = [{ n: 16, en: 'For God so loved the world', zh: '神爱世人' }, { n: 17, en: 'For God did not send', zh: '因为神差他的儿子' }];
const CHAPTER = 'notes/43-3.json';   // John 3, the app's boot chapter

for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: select → Mark → colour writes ANN.marks to the chapter file; re-render paints; quote re-anchors; orphan badges; Remove deletes; dots and chip count marks`, async () => {
    const h = await startHarness('bible');
    const { PAVerseMarks, state } = loadComponent();
    try {
      // The test's own copy of the component, so its fake selection drives selection(); the served page carries it inlined ahead of the app's script.
      const A = runApp(app, h.relay, ['DATA', 'VM', 'selV', 'selectVerse', 'renderVerses', 'annotatedVerses', 'updateFab', 'deleteChapterNote', 'get ANN(){return ANN}'], { clampTimers: true, globals: { PAVerseMarks } });
      await until(() => A.els.get('verses').innerHTML.includes('Could not load'), 'boot (the harness serves no corpus)');
      const wrap = A.els.get('verses'), fabMark = A.els.get('top-mark');
      const blocks = VERSES.map((v) => verseEl(v.n));
      wrap.querySelectorAll = () => blocks;
      wrap.contains = (x) => blocks.some((b) => b.contains(x));
      A.renderVerses(VERSES);
      // CONTROL: nothing selected → no Mark entry, no sheet
      assert.equal(fabMark.disabled, true, 'no selection, Highlight is disabled');
      assert.equal(A.VM.openSheet([]), null);
      assert.equal(fabMark.textContent, PAVerseMarks.TXT.mark, 'the one bilingual label, from the component');
      A.selectVerse(16, blocks[0]);
      assert.equal(fabMark.disabled, false, 'a selected verse enables Highlight');
      const sheet = fabMark.onclick();
      assert.ok(sheet && A.VM.isSheetOpen(), 'Mark opens the sheet');
      const buttons = sheet.children.filter((c) => c.id === 'button');
      assert.deepEqual(buttons.map((b) => b.className || b.textContent), ['pvm-sw pvm-sw-yellow', 'pvm-sw pvm-sw-green', 'pvm-sw pvm-sw-pink', PAVerseMarks.TXT.underline], 'three swatches + underline, no Remove yet');
      await buttons[0].onclick();
      assert.equal(A.VM.isSheetOpen(), false, 'applied and closed');
      let file = JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8'));
      assert.deepEqual(file.marks, { v16: [{ kind: 'hl', color: 'yellow' }] }, 'a whole-verse mark, through the app\'s own save');
      assert.equal(file.draws.v16, undefined, 'never the notebook'); assert.equal(file.notes.v16, undefined);
      assert.ok(A.annotatedVerses().has(16) && !A.annotatedVerses().has(17), 'the dots count marks');
      assert.equal(blocks[0].querySelector('.ven').innerHTML, '<mark class="pvm pvm-hl-yellow">For God so loved the world</mark>');
      assert.equal(blocks[0].querySelector('.vzh').innerHTML, '<mark class="pvm pvm-hl-yellow">神爱世人</mark>', 'a whole-verse mark covers both lines');
      assert.equal(blocks[1].querySelector('.ven').textContent, 'For God did not send', 'the other verse is plain');
      // A character range: the native selection inside v16's English line, marked green. The
      // selection is read when the sheet OPENS; the swatch tap (which collapses it on WebKit) comes after.
      state.sel = { node: blocks[0].querySelector('.ven'), before: 'For God so', quote: ' loved ' };
      assert.deepEqual(A.VM.selection(), { n: 16, lang: 'en', start: 11, end: 16, quote: 'loved' }, 'offsets into the line, whitespace trimmed');
      const sheet2 = fabMark.onclick(); state.sel = null;
      await sheet2.children.filter((c) => c.id === 'button')[1].onclick();
      file = JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8'));
      assert.deepEqual(file.marks.v16[1], { kind: 'hl', color: 'green', lang: 'en', quote: 'loved', start: 11, end: 16 });
      assert.doesNotMatch(JSON.stringify(file.marks), /px|[0-9]\.[0-9]{3,}/, 'no pixels, no page fractions: offsets and text only');
      assert.equal(blocks[0].querySelector('.ven').innerHTML, '<mark class="pvm pvm-hl-yellow">For God so </mark><mark class="pvm pvm-hl-green">loved</mark><mark class="pvm pvm-hl-yellow"> the world</mark>');
      // BSB wording change: the offsets no longer hold the quote → re-anchored by the quote
      A.renderVerses([{ n: 16, en: 'For God loved the world so much', zh: '神爱世人' }, VERSES[1]]);
      assert.equal(blocks[0].querySelector('.ven').innerHTML, '<mark class="pvm pvm-hl-yellow">For God </mark><mark class="pvm pvm-hl-green">loved</mark><mark class="pvm pvm-hl-yellow"> the world so much</mark>');
      // The quote is gone: the whole verse, badged, never dropped
      A.renderVerses([{ n: 16, en: 'God cherished the world', zh: '神爱世人' }, VERSES[1]]);
      assert.equal(blocks[0].querySelector('.ven').innerHTML, `<mark class="pvm pvm-hl-green">God cherished the world</mark><span class="pvm-badge">${PAVerseMarks.TXT.orphan}</span>`);
      assert.equal(JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8')).marks.v16.length, 2, 'a render never writes');
      // Remove appears once something is marked, and deletes
      const items = A.VM.sheetItems([16]);
      assert.equal(items[items.length - 1].id, 'remove');
      await items[items.length - 1].act();
      file = JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8'));
      assert.deepEqual(file.marks, {}, 'the verse\'s marks are gone');
      assert.equal(blocks[0].querySelector('.ven').textContent, 'God cherished the world', 'plain text back');
      assert.equal(A.annotatedVerses().has(16), false, 'no dot');
      assert.equal(A.VM.sheetItems([16]).some((i) => i.id === 'remove'), false);
      // Clearing the selection hides Mark again
      A.selV.clear(); A.updateFab();
      assert.equal(fabMark.disabled, true);
      // Delete from the ☰ list: a row with a note keeps its marks; a mark-only row loses them AND the paint
      await A.VM.apply({ verses: [16], kind: 'hl', color: 'pink' });
      const row = { bookIdx: 42, chapter: 3, verseKey: 'v16', hasDraws: false, marks: 1 };
      assert.equal((await A.deleteChapterNote({ ...row, hasText: true })).ok, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8')).marks, { v16: [{ kind: 'hl', color: 'pink' }] }, 'the note\'s delete keeps the marks');
      assert.equal(blocks[0].querySelector('.ven').innerHTML, '<mark class="pvm pvm-hl-pink">God cherished the world</mark>');
      assert.equal((await A.deleteChapterNote({ ...row, hasText: false })).ok, true);
      assert.deepEqual(JSON.parse(fs.readFileSync(h.file(CHAPTER), 'utf8')).marks, {}, 'a mark-only row\'s delete is the marks');
      assert.equal(blocks[0].querySelector('.ven').innerHTML, 'God cherished the world', 'and the text is repainted plain');
    } finally { await h.stop(); }
  });
}

test('remove under a text selection drops only the marks overlapping it', async () => {
  const { PAVerseMarks, state } = loadComponent();
  let saved = { v5: [{ kind: 'ul', lang: 'en', quote: 'alpha', start: 0, end: 5 }, { kind: 'hl', color: 'pink', lang: 'en', quote: 'gamma', start: 11, end: 16 }, { kind: 'hl', color: 'yellow', lang: 'zh', quote: '甲', start: 0, end: 1 }] };
  const block = verseEl(5);
  const vm = PAVerseMarks.attach({ container: Object.assign(el('div'), { querySelectorAll: () => [block], contains: () => true }), store: { get: () => saved, set: async (n) => { saved = n; return { ok: true }; } }, textOf: (n, lang) => (lang === 'zh' ? '甲乙丙' : 'alpha beta gamma'), onChange() {} });
  state.sel = { node: block.querySelector('.ven'), before: 'alpha ', quote: 'beta gamma' };
  await vm.remove([5]);
  assert.deepEqual(saved.v5, [{ kind: 'ul', lang: 'en', quote: 'alpha', start: 0, end: 5 }, { kind: 'hl', color: 'yellow', lang: 'zh', quote: '甲', start: 0, end: 1 }], 'the English underline before the range and the Chinese mark stay');
  state.sel = null;
  await vm.apply({ verses: [5], kind: 'hl', color: 'nope' });
  assert.deepEqual(saved.v5[2], { kind: 'hl', color: 'yellow' }, 'an unknown colour falls back to the first swatch');
  await vm.apply({ verses: [5], kind: 'hl', color: 'green' });
  assert.equal(saved.v5.length, 3, 'the same span marked again REPLACES its predecessor');
  assert.deepEqual(saved.v5[2], { kind: 'hl', color: 'green' });
});

// ═══ the hosts, both copies, and the serve-time registration ══════════════════════════════════
test('both Bible copies carry the marker, the hook, the fab entry, the chip and the delete; web.mjs registers the component after the one before it', () => {
  for (const app of ['bible (template)', 'bible (live)']) {
    const src = APP_SRC[app];
    assert.ok(src.includes('<!--PA_SETTINGS_UI-->\n<!--PA_VERSE_MARKS_UI-->'), `${app}: the marker, after the settings one`);
    assert.ok(src.includes('<button class="top-pane" id="top-mark" data-short="高亮" disabled></button>'), `${app}: one top-bar entry, labelled by the component`);
    assert.match(src, /const VM=PAVerseMarks\.attach\(\{\n  container:document\.getElementById\('verses'\),\n  store:\{ get:\(\)=>\(ANN\.marks\|\|\(ANN\.marks=\{\}\)\), set:async\(next\)=>\{ ANN\.marks=next; return saveAnn\(\); \} \},/, `${app}: the store is ANN.marks through saveAnn`);
    assert.match(src, /ANN\.marks=migrateKeys\(o\.marks\|\|\{\}\);/, `${app}: read back on load, or the next stroke deletes them`);
    assert.match(src, /for\(const src of \[ANN\.notes,ANN\.draws,ANN\.chat,ANN\.marks,ANN\.ink\]\)/, `${app}: the dots count marks (and the anchored ink)`);
    assert.match(src, /const rowChip=\(n\)=>\(n\.marks&&!n\.hasDraws&&!n\.hasText\)\?PAVerseMarks\.TXT\.chip:undefined;/, `${app}: only a mark-only row is a Highlight row (F2-12)`);
    assert.match(src, /chip:rowChip\(n\),/, `${app}: the row carries it`);
    assert.match(src, /if\(!n\.hasDraws&&!n\.hasText\) delete \(obj\.marks\|\|\{\}\)\[n\.verseKey\]; delete \(obj\.titles\|\|\{\}\)/, `${app}: delete drops the marks only for a mark-only row`);
    assert.match(src, /&&await loadAnn\(\)\)\{ renderDots\(\); VM\.render\(\); INK\.load\(ANN\.ink\); \}/, `${app}: a re-read of the open chapter repaints the marks and reloads the ink`);
    assert.match(src, /PAVerseMarks\.armControl\(document\.getElementById\('top-mark'\)\)\.onclick=/, `${app}: the Mark control keeps the selection through its tap`);
    assert.match(src, /d\.onclick=\(\)=>\{ const r=VM\.selection\(\); if\(!\(r&&r\.n===v\.n&&selV\.has\(v\.n\)\)\) selectVerse\(v\.n,d\); \};/, `${app}: the click guard checks the range is in THIS verse`);
    assert.equal((src.match(/PAVerseMarks\.TXT\.mark\b/g) || []).length, 1, `${app}: the label comes from the component once`);
    assert.doesNotMatch(src, /标记|Mark 标记|Highlight 高亮 · Mark/, `${app}: no second copy of the component's strings (R3)`);
  }
  const list = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('];', WEB.indexOf('const PA_COMPONENTS = [')));
  const entry = "{ marker: '<!--PA_VERSE_MARKS_UI-->', file: 'verse-marks.inline.html' },", vm = list.indexOf(entry);
  assert.ok(vm > list.indexOf("file: 'drawer-summary.inline.html'") && list.indexOf('<!--PA_VERSE_MARKS_UI-->', vm + entry.length) === -1, 'appended after the component before it, once (the list\'s append-only rule; later components come after it)');
  assert.doesNotMatch(scriptOf(COMPONENT).replace(/\/\/.*$/gm, ''), /\bpx\b|getBoundingClientRect|canvas/i, 'the component measures nothing: marks are text');
});

// ═══ /api/notes (the `notes-list` kind) lists mark-only verses over the real web.mjs ══════════
let port, root, web, WS;
before(async () => {
  port = await freePort(); root = mkWebRoot({ port }); WS = path.join(root, 'workspace');
  putIn(WS, 'bible', 'notes/43-3.json', { notes: { v3: 'born again', v4: '  ' }, draws: { v1: nb('<div>beginning</div>') }, marks: { v16: [{ kind: 'hl', color: 'yellow' }, { kind: 'ul', lang: 'en', quote: 'so loved', start: 8, end: 16 }], v1: [{ kind: 'ul' }], v2: [] } });
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });

test('notes-list rows: a mark-only verse is listed with marks=count and its quote as preview; a notebook row reports its marks too; hasText says a typed note exists; an empty list or blank note is not a row', async () => {
  const r = await api(port, '/api/notes');
  assert.equal(r.status, 200);
  const rows = Object.fromEntries((await r.json()).map((n) => [n.verseKey, [n.preview, n.hasDraws, n.hasText, n.marks]]));
  assert.deepEqual(rows, { v1: ['', true, false, 1], v16: ['so loved', false, false, 2], v3: ['born again', false, true, 0] });
});
