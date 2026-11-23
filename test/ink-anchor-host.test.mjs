// PAInkAnchor phase 3 — the hosts twin, the device readout and the served page
// (docs/plans/annotation-anchoring.md §3 b, ADR 0028). What is proved here, on the SHIPPED sources:
//   1. the two Bible copies (workspace.example template, workspace live) carry the SAME anchored-ink
//      hunks — one hook text, so a fix to one is a fix to both (the twin rule);
//   2. web.mjs's sendAppHtml, run over the Bible source with the REAL component list, hands the page
//      PAInkAnchor once, after PANote (it draws with PANote.ink), with no marker left behind;
//   3. the real host boots over the fake-DOM list, mounts the overlay, and INK.readout() is the device
//      line the ⚙ sheet shows: viewport, dpr, the shell's A-/A+ scale, the text column, the ink count —
//      and it follows a prefs message and a wording change (an orphan is counted, never dropped).
// R14 controls: the readout is asserted against numbers the fixture sets, never against a default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, APP_SRC, startHarness, runApp, until } from './helpers-app.mjs';
import { COMPONENT, makeDom, VERSES, penStroke } from './helpers-ink-dom.mjs';

const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const TEMPLATE = APP_SRC['bible (template)'], LIVE = APP_SRC['bible (live)'];
const HOOKS = [
  '<!--PA_INK_ANCHOR_UI-->',
  'ANN.ink=migrateKeys(o.ink||{});',
  'if(annOk) INK.load(ANN.ink);',
  'VM.render(); INK.render();',
  'for(const src of [ANN.notes,ANN.draws,ANN.chat,ANN.marks,ANN.ink])',
  '&&await loadAnn()){ renderDots(); VM.render(); INK.load(ANN.ink); }',
  'const INK_READOUT={label:PAInkAnchor.READOUT_LABEL,readout:true,getValue:()=>INK.readout()};',
];

// ═══ 1. the twin ═════════════════════════════════════════════════════════════════════════════
test('the template and the live Bible carry identical anchored-ink hunks: every hook line, the mount block, and the ⚙ wiring', () => {
  for (const hook of HOOKS) {
    assert.equal(TEMPLATE.split(hook).length, 2, `template carries once: ${hook}`);
    assert.equal(LIVE.split(hook).length, 2, `live carries once: ${hook}`);
  }
  const block = (src) => { const a = src.indexOf('// ── Anchored ink（经文上的手写）'), b = src.indexOf('\n', src.indexOf('const INK_READOUT=', a)); assert.ok(a > 0 && b > a, 'the mount block is there'); return src.slice(a, b); };
  assert.equal(block(TEMPLATE), block(LIVE), 'the mount block (comment, attach, readout const) is the same text in both copies');
  assert.match(block(LIVE), /TODO\(R4 seam\)/, 'the hook names its split seam');
  // The ⚙ wiring differs in CONTEXT (the live copy has an explain-prompt extra, the template none), but
  // both hand PASettings the same INK_READOUT entry inside `extras:[…]`.
  for (const [name, src] of [['template', TEMPLATE], ['live', LIVE]]) {
    const i = src.indexOf('PASettings.attach({'), j = src.indexOf('});', i);
    assert.ok(i > 0 && j > i, `${name}: PASettings is attached`);
    assert.match(src.slice(i, j), /extras:\[[\s\S]*INK_READOUT\]/, `${name}: INK_READOUT is the LAST extras entry of the ⚙ sheet`);
    assert.ok(src.indexOf('const INK_READOUT=') < i, `${name}: the entry exists before the sheet that reads it`);
  }
});

// ═══ 2. the served page ══════════════════════════════════════════════════════════════════════
// sendAppHtml's inlining loop, run for real over the Bible source with the list web.mjs ships.
function inlineLikeTheShell(html) {
  const list = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('];', WEB.indexOf('const PA_COMPONENTS = ')) + 2);
  // eslint-disable-next-line no-new-func
  const markers = (WEB.match(/^const PA_\w+_MARKER\s*=\s*'[^']*';$/gm) || []).join('\n');   // the named markers the list refers to
  const components = new Function(markers + '\n' + list.replace('const PA_COMPONENTS =', 'return'))();
  assert.ok(components.length > 5 && components.every((c) => c.marker && c.file), 'the real list, evaluated');
  assert.match(WEB.slice(WEB.indexOf('function sendAppHtml(')), /for \(const c of PA_COMPONENTS\) \{\n\s+if \(!html\.includes\(c\.marker\)\) continue;[\s\S]*?html = html\.split\(c\.marker\)\.join\(snippet\);/, 'the loop this test mirrors');
  for (const c of components) {
    if (!html.includes(c.marker)) continue;
    html = html.split(c.marker).join(fs.readFileSync(path.join(ROOT, 'web', c.file), 'utf8'));
  }
  return html;
}
test('the shell serves PAInkAnchor to the Bible page: inlined once, after PANote, no marker left; a page without the marker gets none', () => {
  for (const [name, src] of [['template', TEMPLATE], ['live', LIVE]]) {
    const page = inlineLikeTheShell(src);
    assert.equal(page.split('window.PAInkAnchor={').length, 2, `${name}: the component is in the served page once`);
    assert.ok(!page.includes('<!--PA_INK_ANCHOR_UI-->'), `${name}: the marker was replaced`);
    assert.ok(page.indexOf('window.PANote=') < page.indexOf('window.PAInkAnchor={'), `${name}: PANote (its renderer) comes first`);
    assert.ok(page.indexOf('window.PAInkAnchor={') < page.indexOf('PAInkAnchor.attach({container:document.getElementById(\'verses\')'), `${name}: the component precedes the host script that mounts it`);
  }
  const notes = APP_SRC['notes (template)'];
  assert.ok(!notes.includes('<!--PA_INK_ANCHOR_UI-->'), 'control: the Journal does not carry the marker');
  assert.ok(!inlineLikeTheShell(notes).includes('window.PAInkAnchor={'), 'and so is served without the component');
});

// ═══ 3. the readout ══════════════════════════════════════════════════════════════════════════
test('READOUT: one line, English then 中文, from the numbers it is given', () => {
  const { PAInkAnchor: M } = makeDom();
  assert.equal(M.READOUT({ w: 834, h: 1194, dpr: 2, fs: 1.25, textW: 652.4, n: 3, orphans: 1 }),
    'Device 设备: 834×1194 px · dpr 2 · A 1.25 · text 652px · ink 笔迹 3 · orphan 孤立 1');
  assert.equal(M.READOUT({ w: 1366, h: 1024, dpr: 2, fs: 1, textW: 1366, n: 0, orphans: 0 }),
    'Device 设备: 1366×1024 px · dpr 2 · A 1 · text 1366px · ink 笔迹 0 · orphan 孤立 0');
  assert.equal(M.READOUT_LABEL, '设备读数 · Device readout');
  assert.match(COMPONENT, /READOUT_LABEL='设备读数 · Device readout'/, 'the label lives in the component once; the hosts read it from there');
});

for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: boot mounts the overlay; INK.readout() reports the live viewport, the shell's font scale, the text column and the ink count, and follows a prefs message and a wording change`, async () => {
    const h = await startHarness('bible');
    try {
      const dom = makeDom({ width: 400 });
      const PAInkAnchor = { ...dom.PAInkAnchor, attach: (o) => dom.PAInkAnchor.attach({ ...o, container: dom.container }) };
      const A = runApp(app, h.relay, ['INK', 'INK_READOUT', 'renderVerses'], { clampTimers: true, globals: { PAInkAnchor } });
      await until(() => A.els.get('verses').innerHTML.includes('Could not load'), 'boot (the harness serves no corpus)');
      assert.ok(A.INK && A.INK.canvas, 'mounted at boot');
      assert.equal(A.INK_READOUT.label, '设备读数 · Device readout'); assert.equal(A.INK_READOUT.readout, true);
      assert.equal(A.INK_READOUT.getValue(), 'Device 设备: 400×600 px · dpr 2 · A 1 · text 400px · ink 笔迹 0 · orphan 孤立 0', 'the ⚙ entry reads the overlay\'s own line');
      const v16 = dom.addVerse(...VERSES[0]);
      A.renderVerses([{ n: 16, en: VERSES[0][1], zh: VERSES[0][2] }]);
      A.INK.load([{ verse: 16, lang: 'en', charStart: 11, charEnd: 16, quote: 'loved', dx: 1, dy: 18, w: 50, strokes: [{ p: [[0, 0], [48, 0]], c: '#000', w: 2, t: 'pen' }] }]);
      assert.equal(A.INK.readout(), 'Device 设备: 400×600 px · dpr 2 · A 1 · text 400px · ink 笔迹 1 · orphan 孤立 0', 'one anchored group');
      dom.fire('w:message', { data: { pa: 'prefs', fontScale: 1.3 } }); dom.flush();
      dom.L.width = 820; dom.window.innerWidth = 820;    // the rail closed / the iPad turned
      assert.equal(A.INK.readout(), 'Device 设备: 820×600 px · dpr 2 · A 1.3 · text 820px · ink 笔迹 1 · orphan 孤立 0', 'the shell\'s A-/A+ and the new width');
      v16.en.childNodes = [{ nodeType: 3, data: 'God cherished the world' }];
      A.renderVerses([{ n: 16, en: 'God cherished the world', zh: VERSES[0][2] }]);
      assert.equal(A.INK.readout(), 'Device 设备: 820×600 px · dpr 2 · A 1.3 · text 820px · ink 笔迹 1 · orphan 孤立 1', 'the phrase is gone: counted as an orphan, still one group');
    } finally { await h.stop(); }
  });
}

// ═══ 4. rapid strokes: one save chain per chapter ════════════════════════════════════════════
// SCAR: changed() fires per stroke and each ran its own whole-chapter write; the broker orders
// nothing, so write 1 (A) landing after write 2 (A+B) left the file without B — the same for two
// quick scrubs. The relay below is the slow broker: the FIRST save-data request is held back until
// a second one has completed (the unserialised order), or `ms` elapse with no second request (the
// serialised order, where the second write cannot start until the first has answered). A test waits
// for every forwarded write to SETTLE before reading the file: asserting as soon as the file looked
// right let the stale first write land after the assertion (and after the harness had closed).
const CHAPTER = 'notes/43-3.json', NEXT = 'notes/43-4.json';   // John 3 (the boot chapter), John 4
function firstWriteLandsLast(relay, ms = 300) {
  let release = null, n = 0, settled = 0;
  const gate = new Promise((res) => { release = res; setTimeout(res, ms); });
  const wrapped = async (m) => {
    if (m.kind !== 'save-data') return relay(m);
    if (++n === 1) await gate;
    const r = await relay(m); settled++; release(); return r;
  };
  return Object.assign(wrapped, { writes: () => n, settled: () => settled });
}
const inkOf = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).ink : undefined) || {};
async function bootOverSlowBroker(app, h) {
  const dom = makeDom({ width: 400 });
  const PAInkAnchor = { ...dom.PAInkAnchor, attach: (o) => dom.PAInkAnchor.attach({ ...o, container: dom.container }) };
  const relay = firstWriteLandsLast(h.relay);
  const A = runApp(app, relay, ['INK', 'renderVerses', 'load', 'set chapter(c){chapter=c}', 'get ANN(){return ANN}'], { clampTimers: true, globals: { PAInkAnchor } });
  await until(() => A.els.get('verses').innerHTML.includes('Could not load'), 'boot (the harness serves no corpus)');
  const v16 = dom.addVerse(...VERSES[0]); dom.addVerse(...VERSES[1]);
  A.renderVerses(VERSES.map(([n, en, zh]) => ({ n, en, zh })));
  assert.ok(!fs.existsSync(h.file(CHAPTER)), 'control: no chapter file yet');
  return { dom, A, relay, v16 };
}
for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: two strokes in one tick, the first write landing last — the file still holds both`, async () => {
    const h = await startHarness('bible');
    try {
      const { dom, A, relay, v16 } = await bootOverSlowBroker(app, h);
      penStroke(dom, v16.en, 11, 16, 7); penStroke(dom, v16.en, 21, 26, 8);   // "loved", "world": no await between them
      assert.equal(A.INK.groups().length, 2, 'both groups are in memory');
      await until(() => relay.settled() >= 2, 'two writes answered');
      assert.equal(relay.writes(), 2, 'exactly two writes: the second issued only after the first answered (coalesced, not dropped)');
      assert.deepEqual(inkOf(h.file(CHAPTER)).v16.map((g) => g.quote), ['loved', 'world'], 'the file carries both strokes after the last write settled');
    } finally { await h.stop(); }
  });

  test(`${app}: the user leaves the chapter while its ink save is in flight — the queued write goes to THAT chapter's file`, async () => {
    const h = await startHarness('bible');
    try {
      const { dom, A, relay, v16 } = await bootOverSlowBroker(app, h);
      penStroke(dom, v16.en, 11, 16, 7); penStroke(dom, v16.en, 21, 26, 8);
      A.chapter = 4; const loading = A.load();     // John 4: ANN is reset synchronously, the read is in flight
      await loading;
      assert.deepEqual(A.INK.groups(), [], 'John 4 has no ink');
      await until(() => relay.settled() >= 2, 'two writes answered');
      assert.equal(relay.writes(), 2);
      assert.deepEqual(inkOf(h.file(CHAPTER)).v16.map((g) => g.quote), ['loved', 'world'], 'John 3 carries both strokes');
      assert.deepEqual(inkOf(h.file(NEXT)), {}, 'nothing was written to John 4');
      assert.deepEqual(A.ANN.ink || {}, {}, 'and memory is John 4: empty');
    } finally { await h.stop(); }
  });
}
