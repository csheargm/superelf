// The pad's icon set · 图标集
//
// The pad ran on emoji and stray Unicode: 🖊 🖍 ⌫ ⬚ ▤ ↺ ↻ ⠿ ⎙ ‹ › ＋ ✕ 🖼 📷 📄 📋 ✨ ⌗ ⧉ ✂ 🗑.
// Three problems, none cosmetic:
//   · several are COLOUR glyphs the platform paints itself, so they ignore the button's colour —
//     a selected tool could not actually look selected;
//   · every platform draws them differently, at different optical sizes and weights;
//   · ⌫ ⬚ ▤ ⠿ ⌗ ⧉ have no glyph in many fonts and fall back to a box.
// They are now one table of stroked paths on a 24×24 grid, inheriting currentColor.
//
// These tests exist because a wrong path does not throw. It renders an EMPTY BUTTON, or draws
// outside the viewBox where nothing is visible, and both look exactly like a styling problem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);
const ICON = new Function(`${/const ICON=[\s\S]*?\n  \}\)?;/.exec(E)[0]}; return ICON;`)();
const FILL = new Function(`${/const ICON_FILL=[^;\n]*;/.exec(E)[0]}; return ICON_FILL;`)();
const paths = (v) => (Array.isArray(v) ? v : [v]);

test('every icon is real path data, not an empty string', () => {
  const keys = Object.keys(ICON);
  assert.ok(keys.length >= 20, `the set covers the pad's chrome (found ${keys.length})`);
  for (const [k, v] of Object.entries(ICON)) {
    for (const d of paths(v)) {
      assert.equal(typeof d, 'string', `${k} is a string`);
      assert.match(d, /^[Mm]/, `${k} starts with a move — a path that does not is not drawn at all`);
      assert.ok(d.length > 8, `${k} draws something`);
      assert.doesNotMatch(d, /[^MmLlHhVvCcSsQqTtAaZz0-9.,\s-]/, `${k} uses only valid path syntax`);
    }
  }
});

// Walks the path rather than scanning it for numbers. A first version asserted on every number
// it found and failed on the sparkle: "-4.1" there is a RELATIVE delta, not a coordinate, and
// arc flags are bare digits inside the command. Reading path data as a bag of numbers measures
// nothing — this tracks the pen and records where it actually lands.
const ARG_COUNT = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
function extent(d) {
  const pts = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  for (const [, letter, argstr] of d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g)) {
    const up = letter.toUpperCase(), rel = letter !== up;
    const n = (argstr.match(/-?\d*\.?\d+/g) || []).map(Number);
    const step = ARG_COUNT[up];
    if (step === 0) { x = sx; y = sy; continue; }
    for (let i = 0; i + step <= n.length; i += step) {
      const a = n.slice(i, i + step);
      if (up === 'H') { x = rel ? x + a[0] : a[0]; }
      else if (up === 'V') { y = rel ? y + a[0] : a[0]; }
      else {
        // The endpoint is the LAST pair; earlier pairs are control points, which may sit outside
        // the drawn shape and are deliberately not asserted on. Arc flags (indices 3,4) are not
        // coordinates and are skipped by only reading the final pair.
        const ex = a[step - 2], ey = a[step - 1];
        x = rel ? x + ex : ex; y = rel ? y + ey : ey;
      }
      pts.push([x, y]);
      if (up === 'M' && i === 0) { sx = x; sy = y; }
    }
  }
  return pts;
}

test('every icon is drawn INSIDE the 24x24 box, not off-canvas where it is invisible', () => {
  // The silent failure: the path is valid, the button is the right size, and the drawing is
  // somewhere nobody can see. Nothing throws.
  for (const [k, v] of Object.entries(ICON)) {
    for (const d of paths(v)) {
      const pts = extent(d);
      assert.ok(pts.length >= 2, `${k} puts the pen down more than once`);
      for (const [x, y] of pts) {
        assert.ok(x >= 0 && x <= 24, `${k} runs off horizontally at x=${x.toFixed(1)}`);
        assert.ok(y >= 0 && y <= 24, `${k} runs off vertically at y=${y.toFixed(1)}`);
      }
    }
  }
});

test('every icon FILLS its box — a 3px drawing in a 24px grid reads as a speck', () => {
  // The other half: in range, but tiny or lopsided next to its neighbours. Optical consistency is
  // the whole reason for replacing the emoji.
  for (const [k, v] of Object.entries(ICON)) {
    const pts = paths(v).flatMap(extent);
    const w = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
    const h = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
    assert.ok(Math.max(w, h) >= 9, `${k} is too small for the grid (${w.toFixed(1)}x${h.toFixed(1)})`);
  }
});

test('shapes are filled and strokes are stroked', () => {
  // A sparkle, a bullet and the grip dots are SHAPES: stroking them draws their outline instead
  // of the thing, which reads as a hollow artefact rather than an icon.
  assert.deepEqual(Object.keys(FILL).sort(), ['ask', 'grip', 'more']);
  for (const k of Object.keys(FILL)) {
    for (const d of paths(ICON[k])) assert.match(d, /[zZ]|a/, `${k} is a closed shape`);
  }
  assert.match(E, /\.pan-i\{[^}]*fill:none[^}]*stroke:currentColor/, 'the default is a stroked outline');
  assert.match(E, /\.pan-i\.pan-ifill\{fill:currentColor;stroke:none\}/, 'and the fill modifier inverts it');
});

test('every icon the markup asks for exists — a typo renders a blank button', () => {
  const asked = [...E.matchAll(/ico\('([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(asked.length >= 20, `the markup uses the table (found ${asked.length} calls)`);
  for (const k of new Set(asked)) assert.ok(ICON[k], `ico('${k}') has no entry in ICON`);
  // …and ico() itself refuses an unknown key rather than emitting a broken <svg>.
  assert.match(E, /const d=ICON\[k\]; if\(!d\) return '';/, 'an unknown key yields nothing, not markup');
});

test('the tool row renders its icons through the table, letters through the letter', () => {
  // TOOLS carries icon KEYS now, except 'text' which is the letter T. Rendering blindly through
  // ico() would blank the T; rendering blindly as text would print the key name.
  assert.match(E, /\(ICON\[t\[1\]\]\?ico\(t\[1\]\):t\[1\]\)/, 'the row picks per entry');
  const tools = /const TOOLS=\[([\s\S]*?)\];/.exec(E)[1];
  const glyphs = [...tools.matchAll(/\['[a-z]+','([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(glyphs, ['pen', 'marker', 'highlighter', 'erase', 'select', 'T']);
  for (const g of glyphs.slice(0, 5)) assert.ok(ICON[g], `${g} resolves to an icon`);
});

test('no emoji or fallback-box glyph is left in the pad chrome', () => {
  // The regression this set exists to prevent. Scoped to the control markup, since note CONTENT
  // and user-facing prose may legitimately contain anything.
  const chrome = E.slice(E.indexOf("'<div class=\"pan-top\">'"), E.indexOf("'<div class=\"pan-hlpop\">'"));
  assert.ok(chrome.length > 500, 'the chrome markup was found');
  const banned = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{28FF}]/u;
  const hit = banned.exec(chrome);
  assert.equal(hit, null, `a pictographic glyph is back in the chrome: ${hit && hit[0]}`);
});

test('letters stayed letters', () => {
  // B / I / U / 1. / T are typographic controls. Drawing a picture of a letter is worse than
  // setting the letter, so these must NOT have been swept into the icon table.
  for (const cmd of ['bold', 'italic', 'underline']) {
    assert.match(E, new RegExp(`data-cmd="${cmd}"[^>]*>[BIU]<`), `${cmd} is still a letter`);
  }
  assert.match(E, /data-cmd="insertOrderedList"[^>]*>1\.</, 'the numbered list is still "1."');
  assert.match(E, /<span class="pan-mico">T<\/span>/, 'the Text tab is still a T');
});

// ── the box model the icons changed ──────────────────────────────────────────────────────────
test('a menu row puts the icon BESIDE its label, not above it', () => {
  // SCAR. A glyph sat on the text baseline; an <svg> is a block box. .pan-photoopt was
  // display:block, so the moment the menu glyphs became icons every row split into two lines and
  // the 5-item image menu grew into a ~700px column.
  const rule = /\n\.pan-photoopt\{[^}]*\}/.exec(E);
  assert.ok(rule, '.pan-photoopt must be findable');
  // "one line" is the invariant; flex was one way to get it and grid is the one that held.
  assert.match(rule[0], /display:(grid|flex)/, 'the row lays its two children out on a line');
  assert.doesNotMatch(rule[0], /display:block/, 'display:block is what broke it originally');
  assert.match(rule[0], /align-items:center/, 'icon and label share a centreline');
  assert.match(rule[0], /gap:\d+px/, 'with real space between them rather than a text space');
  // There must be exactly ONE rule deciding this. The first fix added a second, earlier one that
  // silently lost the cascade to this one — an override that changed nothing (R1/R3).
  const all = [...E.matchAll(/\.pan-photoopt(?=[,{])[^{]*\{([^}]*)\}/g)].filter((m) => /display:/.test(m[1]));
  assert.equal(all.length, 1, `exactly one rule sets .pan-photoopt display (found ${all.length})`);
});

test('menu popovers do not inherit the section gap meant for groups', () => {
  // .pan-pop's gap spaces GROUPS apart — swatches, the size slider, the checkboxes. Between menu
  // rows it is dead space stacked on top of the padding each row already carries as its tap
  // target, which is what "so much space wasted" was.
  // The selector list grows as menus are added (the paragraph-style menu is one now); what is
  // pinned is that every LIST-shaped popover opts out of the shared stack's group spacing.
  const menu = /\n\.pan-photopop,[^{]*\{([^}]*)\}/.exec(E);
  assert.ok(menu, 'the menu popovers must override the shared stack');
  for (const sel of ['.pan-imgpop', '.pan-stylepop']) assert.ok(/\n\.pan-photopop,[^{]*\{/.exec(E)[0].includes(sel), `${sel} is in the list`);
  assert.match(menu[1], /gap:0/, 'rows sit flush');
  const pop = /\n\.pan-pop\{[\s\S]*?\}/.exec(E);
  assert.match(pop[0], /gap:10px/, 'while the shared popover keeps its group spacing');
  // The row still has its own padding, or flush rows would have no tap target at all.
  assert.match(/\n\.pan-photoopt\{[^}]*\}/.exec(E)[0], /padding:\d+px \d+px/);
});

test('a destructive row is marked, in the same red the drawer sheet already uses', () => {
  // One visual language for "this removes something": the drawer's ⋯ sheet has always drawn
  // Delete in #c0392b (.pac-mopt.del), and a menu row that deletes should not look like Copy.
  const rule = /\n\.pan-photoopt\.del[^{]*\{([^}]*)\}/.exec(E);
  assert.ok(rule, 'the destructive modifier must exist');
  assert.match(rule[1], /#c0392b/, 'the same red, not a second opinion about danger');
  assert.match(/\n\.pan-photoopt\.del[^{]*\{/.exec(E)[0], /\.pan-i/,
    'the icon inherits it too, or the row is only half-warned');
  assert.match(E, /class="pan-photoopt del" data-img="delete"/, 'Delete is the row that carries it');
  // …and nothing else is. Crop, Copy and Cut change the image; only Delete removes it.
  const marked = [...E.matchAll(/class="pan-photoopt del"[^>]*data-(img|photo)="([a-z]+)"/g)].map((m) => m[2]);
  assert.deepEqual(marked, ['delete']);
});

test('a menu row cannot wrap, and its label is an element that can shrink', () => {
  // SCAR, iPad. The two WIDEST rows put their icon on its own line while the short ones stayed
  // inline. Width-dependent line breaking in a flex row is wrapping, and nothing in this
  // stylesheet asks for it — so the engine's own handling of display:flex on a <button> was
  // deciding, and the fix is to stop leaving it undecided.
  const row = /\n\.pan-photoopt\{([^}]*)\}/.exec(E);
  assert.ok(row, '.pan-photoopt must be findable');
  // Grid, not flex: two explicit columns have no wrap concept at all, so the row cannot become
  // two rows however the engine sizes the items inside it.
  assert.match(row[1], /display:grid/, 'the row is a grid');
  assert.match(row[1], /grid-template-columns:auto minmax\(0,1fr\)/, 'icon column, then a label column that may shrink');
  assert.doesNotMatch(row[1], /display:flex/, 'flex is what kept breaking');
  assert.match(row[1], /white-space:nowrap/, 'and the label itself does not break either');
  // An anonymous text item cannot be given min-width:0, so it forces the row wider than the
  // popover instead of shrinking. A real element can.
  const lbl = /\n\.pan-optlbl\{([^}]*)\}/.exec(E);
  assert.ok(lbl, 'the label has its own rule');
  assert.match(lbl[1], /min-width:0/, 'so it may shrink below its content width');
  assert.match(lbl[1], /text-overflow:ellipsis/, 'and truncates rather than overflowing the menu');
});

test('EVERY menu row carries its label in that element — both menus', () => {
  // Enumerate, do not patch the row that was reported: the photo menu has the same shape and the
  // same failure, and a half-converted menu is two layouts in one popover.
  const rows = [...E.matchAll(/data-(?:img|photo)="[a-z]+"[^>]*>'\+ico\('[a-z]+'\)\+'([^']*)/g)];
  assert.equal(rows.length, 9, `both menus are covered (found ${rows.length} rows)`);
  for (const r of rows) {
    assert.match(r[1], /^<span class="pan-optlbl">/, `a bare text label survives: ${r[1].slice(0, 30)}`);
  }
});

test('the row labels are short and parallel', () => {
  // "裁剪 · Crop & straighten" was the one row written as a sentence while every other was a verb.
  // It was also the widest, which is what made the wrap visible at all.
  const labels = [...E.matchAll(/<span class="pan-optlbl">([^<]+)</g)].map((m) => m[1]);
  assert.ok(labels.length >= 9);
  assert.ok(labels.includes('裁剪 · Crop'), 'crop is named like Copy and Cut are');
  assert.ok(!labels.some((l) => /straighten/.test(l)), 'the long form is gone');
  for (const l of labels) {
    assert.ok(l.split('·')[0].trim().split(/\s+/).length <= 3, `"${l}" is a label, not a sentence`);
  }
});

test('every icon states its intrinsic size, not just its CSS size', () => {
  // WebKit gives an <svg> with no width/height ATTRIBUTES a 300x150 intrinsic size. An item sized
  // from that rather than from the 19px the stylesheet asks for is wider than the row it sits in.
  const tag = /return '<svg class="pan-i[\s\S]*?\+paths/.exec(E);
  assert.ok(tag, "ico()'s tag must be findable");
  assert.match(tag[0], /width="24" height="24"/, 'the attributes are emitted');
  assert.match(tag[0], /viewBox="0 0 24 24"/, 'alongside the viewBox they must agree with');
  assert.match(E, /\.pan-i\{width:19px;height:19px/, 'and the stylesheet still decides the rendered size');
});

// ── the one that actually broke it ───────────────────────────────────────────────────────────
test('showing a menu row hands its display back to the stylesheet', () => {
  // THE SCAR, and it was never in the CSS. openImgMenu() hides rows the host cannot service
  // (Crop without PAScan, Ask AI without an onAskImage hook) and showed them again with
  // style.display='block' — used as a synonym for "visible". These rows are display:grid, and an
  // INLINE style outranks every rule in the stylesheet, so exactly those two rows were re-laid-out
  // as blocks: icon on its own line, label beneath. Every other row was untouched and fine.
  //
  // That is why four successive CSS fixes did nothing — flex-wrap:nowrap, the grid rewrite, the
  // shorter label, explicit svg dimensions. None of them can outrank an inline style. It is also
  // why it never reproduced in a standalone render: openImgMenu had not run.
  assert.match(E, /const showRow=\(el,on\)=>\{ if\(el\) el\.style\.display=on\?'':'none'; \};/,
    "showRow must restore '' — the empty string is what hands layout back to the sheet");
  // '' and 'none' only. A literal display TYPE re-decides what the element is.
  const writes = [...E.matchAll(/\.style\.display=([^;]+);/g)].map((m) => m[1]);
  const rowWrites = writes.filter((w) => !/^'(block|none)'$/.test(w) || /\?/.test(w));
  for (const w of rowWrites) {
    assert.doesNotMatch(w, /\?'block'/, `a row is shown as 'block': ${w}`);
  }
});

test('every row whose visibility is toggled goes through it', () => {
  // Three rows are conditional: Crop, Ask AI and Paste. Paste is in the OTHER menu and had the
  // same defect, unnoticed only because it is hidden until something is copied — enumerate, do
  // not patch the two that were reported.
  for (const call of ['showRow(cropBtn,', 'showRow(askBtn,', "showRow(q('.pan-pasteopt')"]) {
    assert.ok(E.includes(call), `${call} …) must go through the helper`);
  }
  // …and no conditional row sets display itself any more.
  const menu = E.slice(E.indexOf('function openImgMenu'), E.indexOf('function openImgMenu') + 1200);
  assert.doesNotMatch(menu, /style\.display=/, 'openImgMenu sets no display of its own');
});

test('the diagnostic menu order was restored once it had answered', () => {
  // The reorder proved the defect followed the ROWS, not their position, which is what pointed at
  // per-row inline styles. Leaving it in place would have left a diagnostic shipped as a design.
  const rows = [...E.matchAll(/data-img="([a-z]+)">'\+ico\('([a-z]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['ask', 'crop', 'copy', 'cut', 'delete'], 'reading order, destructive last');
  assert.doesNotMatch(E, /ORDER IS A DIAGNOSTIC/, 'and the note explaining the experiment is gone');
});
