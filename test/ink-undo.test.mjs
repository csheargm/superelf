// Undo / redo of the verse ink (web/ink-anchor.inline.html) and the floating pen cluster that drives it
// (web/ink-pen.inline.html, owner 2026-11-15: "redo and undo beside the pen floating icon … make the
// floating panel movable"). What is proved:
//   1. the anchor's history: a stroke, an erase and a clear each undo and redo; a new action clears redo;
//      a chapter load resets both stacks; every step saves through onChange and tells onHistory;
//   2. inside the REAL Bible host: the ↶ ↷ buttons step the chapter FILE back and forward, and look
//      disabled when there is nothing to step to;
//   3. placement: clampPos keeps the cluster inside the viewport and safe areas, sheetPos keeps the sheet
//      on screen beside it, and a remembered spot (viewport fractions, keyed per screen) is restored.
// The drag gesture itself runs in a real browser: test/ink-undo-e2e.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENG_INK, startHarness, until } from './helpers-app.mjs';
import { COMPONENT, makeDom, VERSES, penStroke } from './helpers-ink-dom.mjs';
import { CHAPTER, settingsStore, loadPen, boot } from './helpers-ink-pen.mjs';
import fs from 'node:fs';

function anchorOf(src) {
  const dom = makeDom({ width: 400, src });
  const v16 = dom.addVerse(...VERSES[0]); dom.addVerse(...VERSES[1]);
  const saves = [], hist = [];
  const I = dom.PAInkAnchor.attach({ container: dom.container, ink: ENG_INK, onChange: (p, g) => saves.push(g.map((x) => x.quote)) });
  I.onHistory(() => hist.push([I.canUndo(), I.canRedo()]));
  return { dom, v16, I, saves, hist };
}
const quotes = (I) => I.groups().map((g) => g.quote);

// ═══ 1. the history stacks ═══════════════════════════════════════════════════════════════════
test('stroke, erase and clear each undo and redo; every step saves and notifies', () => {
  const { dom, v16, I, saves, hist } = anchorOf();
  assert.deepEqual([I.canUndo(), I.canRedo(), I.undo(), I.redo()], [false, false, false, false], 'nothing to step to at first');
  penStroke(dom, v16.en, 11, 16, 7); penStroke(dom, v16.en, 21, 26, 8);
  assert.deepEqual(quotes(I), ['loved', 'world']);
  I.setPen({ t: 'erase' }); penStroke(dom, v16.en, 12, 15, 9);
  assert.deepEqual(quotes(I), ['world'], 'the eraser took "loved"');
  assert.equal(I.undo(), true); assert.deepEqual(quotes(I), ['loved', 'world'], 'undo brings the erased group back');
  assert.equal(I.undo(), true); assert.deepEqual(quotes(I), ['loved'], 'undo takes the last stroke away');
  assert.equal(I.redo(), true); assert.deepEqual(quotes(I), ['loved', 'world'], 'redo puts it back');
  I.clear(); assert.deepEqual(quotes(I), []);
  assert.equal(I.undo(), true); assert.deepEqual(quotes(I), ['loved', 'world'], 'clear undoes too');
  assert.deepEqual(saves.at(-1), ['loved', 'world'], 'each step goes down the normal save path');
  assert.equal(saves.length, 8, '2 strokes + erase + undo + undo + redo + clear + undo');
  assert.deepEqual(hist.at(-1), [true, true], 'onHistory told after every step');
});
test('a new action clears redo; a chapter load resets both stacks without saving', () => {
  const { dom, v16, I, saves } = anchorOf();
  penStroke(dom, v16.en, 11, 16, 7); I.undo();
  assert.equal(I.canRedo(), true);
  penStroke(dom, v16.en, 21, 26, 8);
  assert.deepEqual([I.canRedo(), I.redo(), quotes(I)], [false, false, ['world']], 'redo is gone once you write again');
  const n = saves.length; I.load({});
  assert.deepEqual([I.canUndo(), I.canRedo(), saves.length], [false, false, n], 'a new chapter starts with no history, and a load never writes');
});
test('mutation control (redo kept on a new action): the stale redo would come back', () => {
  const { dom, v16, I } = anchorOf(COMPONENT.replace('redoS=[]; groups=next;', 'groups=next;'));
  penStroke(dom, v16.en, 11, 16, 7); I.undo(); penStroke(dom, v16.en, 21, 26, 8);
  assert.equal(I.canRedo(), true, 'without the reset redo survives — the guard is what clears it');
});

// ═══ 2. the buttons in the Bible host ════════════════════════════════════════════════════════
const inkOf = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).ink : undefined) || {};
const fileQuotes = (h) => JSON.stringify((inkOf(h.file(CHAPTER)).v16 || []).map((g) => g.quote));
test('Bible: ↶ and ↷ beside the pen button step the chapter file back and forward, disabled-looking when empty', async () => {
  const h = await startHarness('bible');
  try {
    const { dom, A, v16 } = await boot('bible (live)', h);
    const P = A.INK_PEN, off = (b) => b.classList.contains('off');
    assert.deepEqual([P.undoButton.title, P.redoButton.title], ['撤销 · Undo', '重做 · Redo'], 'English then 中文');
    assert.deepEqual([off(P.undoButton), off(P.redoButton)], [true, true], 'nothing to undo or redo at boot');
    assert.equal(P.cluster.classList.contains('on'), false, 'hidden with the pen button until a Pencil comes');
    penStroke(dom, v16.en, 11, 16, 7); penStroke(dom, v16.en, 21, 26, 8);
    assert.equal(P.cluster.classList.contains('on'), true);
    await until(() => fileQuotes(h) === '["loved","world"]', 'both strokes saved');
    assert.deepEqual([off(P.undoButton), off(P.redoButton)], [false, true]);
    P.undoButton.onclick();
    await until(() => fileQuotes(h) === '["loved"]', 'undo rewrites the chapter file');
    assert.deepEqual([off(P.undoButton), off(P.redoButton)], [false, false]);
    P.redoButton.onclick();
    await until(() => fileQuotes(h) === '["loved","world"]', 'redo rewrites it back');
    A.INK.load({});
    assert.deepEqual([off(P.undoButton), off(P.redoButton)], [true, true], 'another chapter: no history');
  } finally { await h.stop(); }
});

// ═══ 3. placement ════════════════════════════════════════════════════════════════════════════
test('clampPos keeps the cluster inside the viewport minus safe areas; sheetPos keeps the sheet on screen', () => {
  const { PAInkPen: P } = loadPen(settingsStore());
  const ins = { t: 20, r: 0, b: 34, l: 0 };
  assert.deepEqual(P.clampPos(-50, -50, 130, 42, 390, 844, ins), { x: 12, y: 32 }, 'top-left corner: edge + safe area');
  assert.deepEqual(P.clampPos(900, 2000, 130, 42, 390, 844, ins), { x: 248, y: 756 }, 'bottom-right: 390-12-130, 844-34-12-42');
  assert.deepEqual(P.clampPos(100, 300, 130, 42, 390, 844, ins), { x: 100, y: 300 }, 'inside: untouched');
  assert.deepEqual(P.sheetPos({ left: 100, top: 400, right: 230, bottom: 442 }, 200, 180, 390, 844, ins), { x: 30, y: 212 }, 'room above: the sheet sits over the cluster, right edges aligned');
  assert.deepEqual(P.sheetPos({ left: 0, top: 40, right: 130, bottom: 82 }, 200, 180, 390, 844, ins), { x: 12, y: 90 }, 'no room above: below it, clamped from the left edge');
  assert.equal(P.devKey(1024, 768), P.devKey(768, 1024), 'one remembered spot per screen, across rotation');
});
test('Bible: a remembered spot for this screen is restored (clamped) when the cluster shows', async () => {
  const h = await startHarness('bible');
  try {
    const store = settingsStore({ prefs: { inkPenPos: { '768x1024': { fx: 0.1, fy: 0.1 }, '390x844': { fx: 0.9, fy: 0.9 } } } });
    const { dom, A, v16 } = await boot('bible (live)', h, { store });
    penStroke(dom, v16.en, 11, 16, 7);
    const s = A.INK_PEN.cluster.style;
    assert.deepEqual([s.left, s.top, s.right], ['102px', '77px', 'auto'], 'this screen\'s fractions of 1024×768, not the phone\'s');
  } finally { await h.stop(); }
});
