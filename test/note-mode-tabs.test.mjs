// The pad's toolbar became two tabs · 工具栏改为两个模式标签
//
// The pad put every control on screen at once: a header (☰ / title / ✨ / ⎙ / ✕), a 12-button
// tool row, a 6-button page row, and in text mode a 10-control formatting row. 22 controls on a
// surface whose entire job is to be blank, 31 once you typed.
//
// Draw and Text are now TABS over the two control rows. The resting state is the header alone;
// a tab reveals only its own row; tapping the open tab closes it. Same controls, one row at a
// time, chosen rather than all present.
//
// Two things make that safe, and both are pinned here:
//   1. MOUNT MODE HAS NO HEADER. With no .pan-top there is nowhere to promote T to and no tab to
//      reopen the row with, so the row must never be hidden there — hiding it would strand the
//      user with no way to reach any tool at all.
//   2. THE TABS FOLLOW THE TOOL. A second copy of "am I in text mode?" would drift from the real
//      one, and the drift shows as a lit tab over a page that is not in that mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);

test('the resting header is the tabs and nothing else', () => {
  const bar = /\(hasTop\?'<div class="pan-top">'[\s\S]*?'<\/div>'/.exec(E);
  assert.ok(bar, 'the header markup must be findable');
  for (const cls of ['pan-hist', 'pan-htitle', 'pan-hask', 'pan-mdraw', 'pan-mtext', 'pan-hprint']) {
    assert.ok(bar[0].includes(cls), `the header carries ${cls}`);
  }
  assert.match(bar[0], /data-mode="draw"/, 'Draw is a mode tab');
  assert.match(bar[0], /data-mode="text"/, 'Text is a mode tab');
  // Both are bilingual and labelled, like every other control here.
  assert.match(bar[0], /title="手写 · Draw"/);
  assert.match(bar[0], /title="文字 · Text"/);
});

test('T moved to the header — it is not in both places', () => {
  // A T in the row AND a Text tab is two controls for one mode, and they can disagree about
  // which is lit.
  // Anchored on the predicate that mentions hasTop: TOOLS.filter is now used twice (the second
  // derives the inking set), and a bare /TOOLS\.filter/ matches whichever comes first in the file.
  const row = /TOOLS\.filter\((t=>[^)]*hasTop[^)]*\))\)\.map/.exec(E);
  assert.ok(row, 'the tool row filters TOOLS');
  assert.match(row[1], /hasTop&&t\[0\]==='text'/, "T leaves the row only where a header can hold it");
});

test('the tool row still holds every OTHER tool', () => {
  // The filter must remove exactly one entry. A stricter predicate would silently drop tools.
  const tools = /const TOOLS=\[([\s\S]*?)\];/.exec(E);
  assert.ok(tools, 'TOOLS must be findable');
  const ids = [...tools[1].matchAll(/\['([a-z]+)',/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['pen', 'marker', 'highlighter', 'erase', 'select', 'text']);
  // …and TOOLS itself is untouched, so VALID_TOOL still accepts 'text' from opts.tool.
  assert.match(E, /const VALID_TOOL=[^;\n]*Object\.fromEntries\(TOOLS\.map/, 'tool validation still derives from TOOLS');
});

// ── the tab state, RUN ───────────────────────────────────────────────────────────────────────
function modeModule(topBar) {
  const src = /function syncMode\(\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(src, 'syncMode must be extractable');
  const el = () => ({ cls: new Set(), attrs: {},
    classList: { toggle: (c, on) => { const s = el.store; on ? s.add(c) : s.delete(c); } } });
  const nodes = {};
  const mk = (name) => {
    const set = new Set();
    nodes[name] = { on: () => set.has('on'), off: () => set.has('pan-off'),
      pressed: () => nodes[name].aria };
    return { classList: { toggle: (c, on) => (on ? set.add(c) : set.delete(c)) },
      setAttribute: (_k, v) => { nodes[name].aria = v; } };
  };
  const els = { '.pan-tools': mk('tools'), '.pan-mdraw': mk('draw'), '.pan-mtext': mk('text') };
  const state = { tool: 'pen', drawRowOpen: false };
  const fn = new Function('q', 'topBar', 'state', `
    let tool, drawRowOpen;
    ${src[0]}
    return (t, d) => { tool=t; drawRowOpen=d; syncMode(); };`)((sel) => els[sel], topBar, state);
  return { fn, nodes };
}

test('the resting state shows no control row at all', () => {
  const m = modeModule({});
  m.fn('pen', false);
  assert.equal(m.nodes.tools.off(), true, 'the tool row is away');
  assert.equal(m.nodes.draw.on(), false, 'and neither tab is lit');
  assert.equal(m.nodes.text.on(), false);
});

test('a tab lights only its own row', () => {
  const m = modeModule({});
  m.fn('pen', true);
  assert.equal(m.nodes.tools.off(), false, 'Draw opens the tool row');
  assert.equal(m.nodes.draw.on(), true);
  assert.equal(m.nodes.text.on(), false, 'and Text stays dark');

  m.fn('text', true);
  assert.equal(m.nodes.text.on(), true, 'Text lights in text mode');
  assert.equal(m.nodes.draw.on(), false, 'Draw goes dark even though the row was asked for');
  assert.equal(m.nodes.tools.off(), true, 'and its row is put away — one row at a time');
});

test('the tabs follow the TOOL, not a second copy of it', () => {
  // Entering text mode by any route (mount-mode T, opts.tool, a restored note) must light the
  // Text tab, or the header claims a mode the page is not in.
  const m = modeModule({});
  m.fn('text', false);
  assert.equal(m.nodes.text.on(), true, 'lit without anyone touching the tab');
  assert.equal(m.nodes.draw.on(), false);
});

test('mount mode never hides the tool row — there is no tab to bring it back', () => {
  // The scar this guards: with no .pan-top, T has nowhere to be promoted to and no tab exists, so
  // hiding the row leaves no way to reach ANY tool.
  const m = modeModule(null);
  m.fn('text', false);
  assert.equal(m.nodes.tools.off(), false, 'the row is untouched without a header');
  m.fn('pen', false);
  assert.equal(m.nodes.tools.off(), false);
});

test('aria-pressed tracks the lit tab', () => {
  const m = modeModule({});
  m.fn('pen', true);
  assert.equal(m.nodes.draw.pressed(), 'true');
  assert.equal(m.nodes.text.pressed(), 'false');
});

// ── the wiring around it ─────────────────────────────────────────────────────────────────────
test('boot leaves the row closed where a tab can reopen it, open where none can', () => {
  assert.match(E, /drawRowOpen=!topBar; syncMode\(\);/,
    'the boot state is derived from whether a header exists, not hardcoded');
  // dockTools() still runs first: a row that measures itself while hidden lands in the wrong
  // place the first time it is asked for.
  // lastIndexOf: the Draw tab's handler calls dockTools() too, and it appears earlier.
  const boot = E.slice(E.lastIndexOf('dockTools();'), E.indexOf('drawRowOpen=!topBar'));
  assert.ok(boot.length < 400, 'the close follows the dock immediately');
});

test('Draw means DRAW — it lands on an inking tool, never on Select or the Eraser', () => {
  // Select and the Eraser live in the drawing row but put no ink on the page. The desktop boot
  // tool is Select, so a Draw tab that merely opened the row left the user in the one mode where
  // the pen does nothing — reported as "the default selection should be pen, not select".
  const inks = new Function(`${/const TOOLS=\[[\s\S]*?\];/.exec(E)[0]}
    ${/const INKS=[^;]*;/.exec(E)[0]}
    ${/const FIRST_INK=[^;]*;/.exec(E)[0]}
    return { INKS, FIRST_INK, TOOLS };`)();
  assert.deepEqual(Object.keys(inks.INKS), ['pen', 'marker', 'highlighter'], 'only these put ink down');
  assert.equal(inks.FIRST_INK, 'pen', 'and the pen is where Draw starts');
  // Derived from the tool table, not kept as a second list that can drift from it.
  assert.match(E, /const INKS=[^;\n]*Object\.fromEntries\(TOOLS\.filter/, 'the inking set comes from TOOLS');
  assert.match(E, /const FIRST_INK=TOOLS\.find/, 'as does the default');
  assert.match(E, /if\(INKS\[t\]\) lastDraw=t;/, 'and only an inking tool is remembered as "last draw"');
  assert.match(E, /let lastDraw=FIRST_INK;/, 'the initial value follows the table too');

  const draw = /\{ const db=q\('\.pan-mdraw'\)[\s\S]*?\}\); \}/.exec(E);
  assert.ok(draw, 'the Draw tab is wired');
  assert.match(draw[0], /const inking=!!INKS\[tool\];/, 'it asks whether the current tool inks');
  assert.match(draw[0], /if\(!inking\) await setTool\(lastDraw\);/,
    'and switches when it does not — from Select, the Eraser or text alike');
});

test('tapping Draw while already inking closes the row', () => {
  // The close gesture survives, but only from a state where the tab is already doing its job.
  const draw = /\{ const db=q\('\.pan-mdraw'\)[\s\S]*?\}\); \}/.exec(E)[0];
  assert.match(draw, /if\(drawRowOpen&&inking\)\{ drawRowOpen=false;/,
    'open + inking is the only state where a tap hides the row');
  assert.match(draw, /drawRowOpen=true; syncMode\(\);/, 'every other tap opens it');
});

test('the Text tab still returns you to a drawing tool, not to nothing', () => {
  const txt = /\{ const tb2=q\('\.pan-mtext'\)[\s\S]*?\}\); \}/.exec(E);
  assert.ok(txt, 'the Text tab is wired');
  assert.match(txt[0], /setTool\(tool==='text'\?lastDraw:'text'\)/,
    'leaving text lands on the last INKING tool — never on a header with no mode');
});
