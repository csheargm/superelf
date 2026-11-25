// Tables · 表格
//
// A table is real HTML in the note — <table><tbody><tr><th|td> — for the same reason a Title is
// an <h1>: the structure IS the storage, so it survives printing, pasting and anything else that
// reads the file. Nothing here is a private convention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);
const TAGS = new Function(`${/const HTML_TAGS=[\s\S]*?\}\)?;/.exec(E)[0]}; return HTML_TAGS;`)();

test('TBODY is allow-listed, and that is not optional', () => {
  // Browsers insert a tbody whether or not the markup had one. Leaving it off the list would
  // unwrap every row on the first save — the structure destroyed by the thing meant to preserve
  // it, and the note would reload as loose cells.
  for (const t of ['TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']) {
    assert.ok(TAGS[t], `${t} survives sanitising`);
  }
  assert.equal(TAGS.TBODY, 'tbody');
});

test('one context-aware button: insert outside a table, edit inside one', () => {
  // Two buttons would each be wrong half the time. The selected-image ⋯ already works this way.
  const h = /if\(tableBtn\) tableBtn\.addEventListener\('click',\(\)=>\{[\s\S]*?\}\);/.exec(E);
  assert.ok(h, 'the table button must be wired');
  assert.match(h[0], /if\(caretCell\(\)\) togglePop\(tablePop,tableBtn\); else \{ insertTable\(\);/,
    'inside a table it opens the menu; outside it inserts');
});

test('a new table has a header row and somewhere to put the caret', () => {
  const fn = /function insertTable\(\)\{[\s\S]*?onTextInput\(\);\n    \}/.exec(E);
  assert.ok(fn, 'insertTable must be findable');
  assert.match(fn[0], /Array\(TABLE_COLS\)\.fill\(cell\('th'\)\)/, 'the first row is headers');
  assert.match(fn[0], /\\u200b|​/, 'each cell holds a zero-width space');
  // An empty <td> cannot be clicked into on WebKit — there is no text node for the caret to land
  // in, so the cell is unreachable and the table looks broken on exactly the target device.
  assert.match(fn[0], /<p>/, 'and a paragraph follows it');
  // A table at the very end of a note otherwise leaves nowhere to type next.
  assert.match(fn[0], /onTextInput\(\)/, 'a scripted edit commits by hand');
});

test('adding a row does not create a second header row', () => {
  // The row is CLONED for its column count, and a clone of the header row keeps its <th> cells.
  // Verified in a browser: after add-row the table had 4 rows and still exactly 3 <th>.
  const fn = /else if\(op==='row\+'\)\{[\s\S]*?row\.after\(r\); \}/.exec(E);
  assert.ok(fn, 'the row+ branch must be findable');
  assert.match(fn[0], /document\.createElement\('td'\)/, 'the copy is always body cells');
});

test('adding a column matches the cell type of the row it is added to', () => {
  // A <td> in the header row would break the header's styling and its meaning.
  const fn = /else if\(op==='col\+'\)\{[\s\S]*?\}/.exec(E);
  assert.ok(fn, 'the col+ branch must be findable');
  assert.match(fn[0], /src&&src\.tagName==='TH'\?'th':'td'/, 'th in the header row, td elsewhere');
});

test('deleting the last row or column removes the table, not a husk', () => {
  // A table with no rows is invisible but still in the document, and the caret can land in it.
  assert.match(E, /else if\(op==='row-'\)\{ if\(rows\(\)\.length>1\) row\.remove\(\); else tbl\.remove\(\); \}/,
    'the last row takes the table with it');
  assert.match(E, /else tbl\.remove\(\);/, 'and so does the last column');
});

test('Tab walks the cells, and Tab out of the last one adds a row', () => {
  // Without it the only way out of a table is the mouse — and on iPad, a hardware keyboard.
  const fn = /textLayer\.addEventListener\('keydown',\(e\)=>\{[\s\S]*?\n    \}\);/.exec(E);
  assert.ok(fn, 'the Tab handler must be findable');
  assert.match(fn[0], /if\(e\.key!=='Tab'\) return;/, 'only Tab');
  assert.match(fn[0], /cellOf\(/, 'it asks which cell the caret is in');
  assert.match(fn[0], /if\(!cell\) return;/, 'and does nothing outside a table, so Tab still works everywhere else');
  assert.match(fn[0], /e\.shiftKey\?-1:1/, 'shift-Tab goes back');
  assert.match(fn[0], /tableOp\('row\+'\)/, 'Tab past the end grows the table');
  assert.match(fn[0], /e\.preventDefault\(\)/, 'so Tab does not move focus out of the note');
});

test('every table edit is saved', () => {
  // All of them are scripted DOM edits, which fire no 'input' event. The third such case today.
  for (const fn of [/function insertTable\(\)\{[\s\S]*?\n    \}/, /function tableOp\(op\)\{[\s\S]*?\n    \}/]) {
    assert.match(fn.exec(E)[0], /onTextInput\(\);/, 'commits by hand');
  }
});

test('printing draws the cells, not just the words in them', () => {
  // Borders are CSS, not text, so a transcription built out of Ranges renders a table as loose
  // columns of words. Verified: 16 cells stroked on a 4x4 table.
  const fn = /function drawText\(ctx,html\)\{[\s\S]*?return drew; \}/.exec(E)[0];
  assert.match(fn, /el\.querySelectorAll\('td,th'\)/, 'every cell is visited');
  assert.match(fn, /ctx\.strokeRect\(x\+0\.5,y\+0\.5/, 'a half-pixel inset, so a 1px rule is crisp');
  assert.match(fn, /if\(bg&&!TRANSPARENT\.test\(bg\)\)\{ ctx\.fillStyle=bg;/, 'and a header cell keeps its tint');
});

test('the table popover joins the one-at-a-time set', () => {
  assert.match(E, /for\(const sel of \['\.pan-stylepop','\.pan-tablepop'[^\]]*\]\)/, 'closePops closes it');   // the phone ⋯ menu (.pan-ovf) joined the set too
  const guard = /e\.target\.closest\('([^']+)'\)\) return;/.exec(E);
  assert.match(guard[1], /\.pan-ftable/, 'and its button is exempt from the outside-tap close');
});
