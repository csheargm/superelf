// PAInkPen — the verse ink's pen sheet (web/ink-pen.inline.html), driven through the REAL Bible host
// (both copies) over the fake-DOM verse list of helpers-ink-dom: the host mounts PAInkAnchor and then
// PAInkPen exactly as it ships. What is proved, as the owner uses it:
//   1. the round button is hidden until a Pencil touches the list (a finger does not count), then stays;
//   2. the sheet's tool / size / colour change the NEXT stroke's c, w, t (and a for the highlighter);
//   3. highlighter strokes draw BEHIND pen ink (the pad's compose order); an old stroke with no t is a pen;
//   4. the eraser removes exactly the group it touches and the chapter file is rewritten without it;
//   5. the choice round-trips through app-settings / set-app-settings, keeps the app's other prefs and its
//      prompt override, a reload restores it, a shell prefs push re-reads it, a refused write is shown.
// Each new guard has a mutation control: the guard removed, the same assertion fails (R14).
// The app-settings store below mirrors web/index.html saveAppSettings: set-app-settings REPLACES the
// app's whole prefs object, and a systemPrompt that is not a non-blank string CLEARS the override.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENG_INK, ENG_PALETTE, startHarness, until } from './helpers-app.mjs';
import { COMPONENT, penStroke } from './helpers-ink-dom.mjs';

import { PEN_SRC, APPS, RED, CHAPTER, settingsStore, loadPen, boot, pick, touch, ANCHOR_NO_GATE } from './helpers-ink-pen.mjs';

// ═══ 1. the button ═══════════════════════════════════════════════════════════════════════════
// The Bible uses the floating round button (owner 2026-11-13, back to the original design): tested below.
for (const app of APPS) {
  test(`${app} (floating mode): the pen button is hidden until a Pencil touches the verses — a finger or a mouse does not count — then it stays`, async () => {
    const h = await startHarness('bible');
    try {
      const { dom, A, v16 } = await boot(app, h);
      assert.equal(A.INK_PEN.cluster.classList.contains('on'), false, 'hidden at boot');
      touch(dom, 'touch'); touch(dom, 'mouse');
      assert.equal(A.INK_PEN.isShown(), false, 'a finger and a mouse leave it hidden');
      penStroke(dom, v16.en, 11, 16, 7);
      assert.equal(A.INK_PEN.cluster.classList.contains('on'), true, 'a Pencil stroke shows it');
      assert.equal(A.INK_PEN.button.title, 'Pen tools · 笔工具', 'English then 中文');
      assert.equal(A.INK_PEN.cluster.style.right, '716px', 'pinned 12px inside the LIST\'s right edge (#verses ends at 320 in a 1024 window: the rail beside it stays clear)');
      A.INK_PEN.button.onclick(); assert.equal(A.INK_PEN.sheet.classList.contains('on'), true, 'tap opens the sheet');
      A.INK_PEN.button.onclick(); assert.equal(A.INK_PEN.sheet.classList.contains('on'), false, 'tap again closes it');
      assert.equal(A.INK_PEN.cluster.classList.contains('on'), true, 'and the button stays');
    } finally { await h.stop(); }
  });
}
test('mutation control: onPen fired for every pointer type — a finger shows the button', async () => {
  const h = await startHarness('bible');
  try {
    const { dom, A } = await boot(APPS[0], h, { anchorSrc: ANCHOR_NO_GATE(COMPONENT) });
    touch(dom, 'touch');
    assert.equal(A.INK_PEN.isShown(), true, 'without the pointerType gate the finger counts');
  } finally { await h.stop(); }
});

// ═══ 2. the sheet sets the next stroke ═══════════════════════════════════════════════════════
for (const app of APPS) {
  test(`${app}: sheet choices change the next stroke's c / w / t; the sheet shows the pad's own swatches and bilingual labels`, async () => {
    const h = await startHarness('bible');
    try {
      const { dom, A, v16 } = await boot(app, h);
      assert.equal(A.INK_PEN.ui.grid.innerHTML, ENG_PALETTE.swatchesHtml('color'), 'the pad\'s swatch markup, not a copy');
      assert.deepEqual(A.INK_PEN.ui.toolBtns.map((b) => b.title), ['Pen · 笔', 'Highlighter · 荧光笔', 'Eraser · 橡皮']);
      assert.deepEqual(A.INK_PEN.ui.sizeBtns.map((s) => s.b.title), ['Thin · 细', 'Medium · 中', 'Thick · 粗']);
      await pick(A, { t: 'highlighter', size: 'thick', c: RED });
      penStroke(dom, v16.en, 11, 16, 7);
      const hl = A.INK.groups().at(-1).strokes[0];
      assert.deepEqual({ c: hl.c, w: hl.w, t: hl.t, a: hl.a }, { c: RED, w: ENG_PALETTE.HILITE_W, t: 'highlighter', a: ENG_PALETTE.HILITE_ALPHA });
      assert.equal(A.INK_PEN.ui.cap.textContent, 'Highlighter · 荧光笔 — Thick · 粗');
      await pick(A, { t: 'pen', size: 'medium' });
      penStroke(dom, v16.en, 21, 26, 8);
      const p = A.INK.groups().at(-1).strokes[0];
      assert.deepEqual({ c: p.c, w: p.w, t: p.t, a: p.a }, { c: RED, w: 3.75, t: 'pen', a: undefined }, 'medium = a quarter along the pad\'s 1..12 scale');
    } finally { await h.stop(); }
  });
}

// The live segments (Pencil still down) must paint in the chosen colour, not the canvas default black.
const liveInk = (seen) => ({ ...ENG_INK, segTo: (ctx, ...r) => { seen.push(ctx.strokeStyle); return ENG_INK.segTo(ctx, ...r); } });
const LIVE_NO_COLOUR = (s) => s.replace("ctx.strokeStyle=pen.c; ", '');
for (const [name, anchorSrc, ok] of [['shipped', undefined, true], ['mutation control (no live strokeStyle)', LIVE_NO_COLOUR(COMPONENT), false]]) {
  test(`${name}: the live pen stroke draws in the chosen colour while the Pencil is down`, async () => {
    const h = await startHarness('bible');
    try {
      const seen = [];
      const { dom, A, v16 } = await boot(APPS[0], h, { anchorSrc, ink: liveInk(seen) });
      await pick(A, { t: 'pen', c: RED });
      penStroke(dom, v16.en, 11, 16, 7);
      assert.ok(seen.length > 0, 'live segments were drawn (no vacuous pass)');
      assert.equal(seen.every((c) => c === RED), ok, `live strokeStyle ${JSON.stringify([...new Set(seen)])}`);
    } finally { await h.stop(); }
  });
}

// ═══ 3. compose order ════════════════════════════════════════════════════════════════════════
const GROUPS = [
  { verse: 16, lang: 'en', charStart: 11, charEnd: 16, quote: 'loved', dx: 0, dy: 18, w: 50, strokes: [{ p: [[0, 0], [48, 0]], c: '#000000', w: 2 }] },   // an old stroke: no t
  { verse: 16, lang: 'en', charStart: 21, charEnd: 26, quote: 'world', dx: 0, dy: 10, w: 50, strokes: [{ p: [[0, 0], [48, 0]], c: RED, w: 22, t: 'highlighter', a: 0.3 }] },
];
const DRAW_ONE_PASS = (s) => s.replace('for(const s of g.strokes) if(isHl(s)===hl) ink.drawStroke', 'for(const s of g.strokes) if(hl) ink.drawStroke');
for (const [name, anchorSrc, want] of [['shipped', undefined, ['highlighter', 'pen']], ['mutation control (one pass, list order)', DRAW_ONE_PASS(COMPONENT), ['pen', 'highlighter']]]) {
  test(`${name}: a highlighter group loaded AFTER a pen group still draws first (behind it); an old stroke with no t is a pen`, async () => {
    const h = await startHarness('bible');
    try {
      const log = [];
      const { A } = await boot(APPS[1], h, { anchorSrc, log });
      log.length = 0; A.INK.load(GROUPS);
      assert.deepEqual(log, want);
    } finally { await h.stop(); }
  });
}

// ═══ 4. the eraser ═══════════════════════════════════════════════════════════════════════════
const inkOf = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).ink : undefined) || {};
const ERASE_OFF = (s) => s.replace("if(pen.t==='erase'){", "if(false){");
test('the eraser removes exactly the group it touches, and the chapter file is rewritten without it', async () => {
  const h = await startHarness('bible');
  try {
    const { dom, A, v16 } = await boot(APPS[0], h);
    penStroke(dom, v16.en, 11, 16, 7); penStroke(dom, v16.en, 21, 26, 8);
    await until(() => (inkOf(h.file(CHAPTER)).v16 || []).length === 2, 'both strokes saved');
    await pick(A, { t: 'erase' });
    penStroke(dom, v16.en, 12, 15, 9);                  // a short drag over "loved"
    assert.deepEqual(A.INK.groups().map((g) => g.quote), ['world'], 'only the touched group left');
    await until(() => JSON.stringify((inkOf(h.file(CHAPTER)).v16 || []).map((g) => g.quote)) === '["world"]', 'the file follows');
  } finally { await h.stop(); }
});
test('mutation control (eraser branch removed in the anchor source): the touch adds a group instead', async () => {
  const h = await startHarness('bible');
  try {
    const { dom, A, v16 } = await boot(APPS[0], h, { anchorSrc: ERASE_OFF(COMPONENT) });
    penStroke(dom, v16.en, 11, 16, 7);
    await pick(A, { t: 'erase' });
    penStroke(dom, v16.en, 12, 15, 9);
    assert.equal(A.INK.groups().length, 2, 'the guard is what makes it an eraser');
  } finally { await h.stop(); }
});

// ═══ 5. prefs ════════════════════════════════════════════════════════════════════════════════
for (const app of APPS) {
  test(`${app}: the choice round-trips through app-settings, keeps the other prefs and the prompt override; a reload and a prefs push restore it; a refused write is shown`, async () => {
    const h = await startHarness('bible');
    try {
      const store = settingsStore({ prefs: { noteSort: 'created' }, override: 'Explain briefly' });
      const { A } = await boot(app, h, { store });
      await pick(A, { t: 'highlighter', size: 'medium', c: RED });
      assert.deepEqual(store.prefs, { noteSort: 'created', inkPen: { t: 'highlighter', size: 'medium', c: RED } }, 'merged, not replaced');
      assert.equal(store.override, 'Explain briefly', 'the prompt override survives the write');
      const again = await boot(app, h, { store });       // a reload: a fresh page over the same server prefs
      assert.deepEqual(again.A.INK_PEN.choice(), { t: 'highlighter', size: 'medium', c: RED });
      assert.deepEqual(again.A.INK.pen(), { t: 'highlighter', c: RED, w: 17.6, a: ENG_PALETTE.HILITE_ALPHA }, 'the anchor draws with it');
      store.prefs.inkPen = { t: 'erase', size: 'thin', c: RED };   // changed on another device
      again.pen.fire('message', { data: { pa: 'prefs', fontScale: 1 } }); await again.A.INK_PEN.whenIdle();
      assert.equal(again.A.INK_PEN.choice().t, 'erase', 'the shell\'s prefs push re-reads');
      store.refuse = true; await pick(again.A, { t: 'pen' });
      assert.equal(again.A.INK_PEN.ui.msg.textContent, 'Not saved · 未保存 — disk full', 'R5: a refused write is said in the sheet');
    } finally { await h.stop(); }
  });
}
// The merge's mutation control moved with the merge: test/app-prefs.test.mjs (PAAppPrefs, the page's one chain).
test('penOf / valid: a stored choice is checked before it is drawn with', () => {
  const { PAInkPen: P } = loadPen(settingsStore());
  assert.deepEqual(P.valid(ENG_PALETTE, { t: 'select', size: 'huge', c: 'red' }, '#0f6355'), { t: 'pen', size: 'thin', c: '#0f6355' }, 'unknown tool/size/colour fall back');
  assert.deepEqual(P.penOf(ENG_PALETTE, { t: 'pen', size: 'thin', c: RED }), { t: 'pen', c: RED, w: 2.1 });
  assert.deepEqual(P.penOf(ENG_PALETTE, { t: 'highlighter', size: 'thin', c: RED }), { t: 'highlighter', c: RED, w: 13.2, a: ENG_PALETTE.HILITE_ALPHA });
});
test('twin: both Bible copies carry the marker after PAInkAnchor\'s and the one mount line, once', () => {
  const src = (k) => fs.readFileSync(path.join(ROOT, k === 'live' ? 'workspace' : 'workspace.example', 'apps', 'bible', 'index.html'), 'utf8');
  for (const k of ['live', 'template']) {
    const s = src(k);
    assert.equal(s.split('<!--PA_INK_ANCHOR_UI-->\n<!--PA_INK_PEN_UI-->').length, 2, `${k}: the marker, right after the anchor's`);
    assert.equal(s.split("const INK_PEN=PAInkPen.attach({container:document.getElementById('verses'),anchor:INK});").length, 2, `${k}: the mount line`);
  }
});

// R3 review 2026-11-13: the sheet dropped from "Pen · 笔" kept its old top/left after an iPad rotation
// (the resize listener only re-placed a SHOWN floating button). It now re-drops below its control.
const NO_REDROP = (s) => s.replace(' if(open&&dropFrom) drop(dropFrom);', '');
for (const app of APPS) {
  test(`${app}: on resize / rotation a sheet opened from a host control follows it; mutation control keeps the old spot`, async () => {
    assert.notEqual(NO_REDROP(PEN_SRC), PEN_SRC, 'the R14 mutation matched');
    for (const src of [PEN_SRC, NO_REDROP(PEN_SRC)]) {
      const h = await startHarness('bible');
      try {
        const { A, pen } = await boot(app, h, { penSrc: src });
        const ctl = { getBoundingClientRect: () => ({ left: 40, right: 90, top: 10, bottom: 50, width: 50, height: 40 }) };   // a host's own control (openSheet(control) mode)
        A.INK_PEN.openSheet(ctl);
        assert.equal(A.INK_PEN.sheet.style.top, '56px', 'dropped 6px below the control');
        ctl.getBoundingClientRect = () => ({ left: 300, right: 350, top: 20, bottom: 80, width: 50, height: 40 });
        pen.fire('resize', {});
        if (src === PEN_SRC) assert.equal(A.INK_PEN.sheet.style.top, '86px', 'rotation: re-dropped below the moved control');
        else assert.equal(A.INK_PEN.sheet.style.top, '56px', 'R14: without the fix the sheet stays where it was');
        A.INK_PEN.openSheet(ctl); pen.fire('resize', {});
        assert.equal(A.INK_PEN.isOpen(), false, 'a closed sheet is not re-opened by a resize');
      } finally { await h.stop(); }
    }
  });
}
