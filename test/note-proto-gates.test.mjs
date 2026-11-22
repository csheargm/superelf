// PANote's other gates, and the invariant over ALL of note-ui · 原型上的名字 (ADR 0015)
//
// The flows a user meets (a page's id, an image's path, a stored template, a store's reply code) are
// in test/note-proto-keys.test.mjs. Here:
//   · the host's opts.tool (VALID_TOOL), with a string check;
//   · the rich-text sanitizer's tag tables (HTML_DROP, HTML_TAGS), keyed by an element's tagName;
//   · the invariant: no plain-object table is indexed with [ ] or tested with `in`, anywhere in
//     web/note-ui.inline.html. Tables that no input reaches (ICON, ICON_FILL, INKS, RULED_TPL,
//     MARGIN_TPL, STYLE_OK, byKind) are pinned by the invariant alone.
// Each gate is mutation-tested: the old plain table is put back and the same value gets through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, mutated } from './helpers-app.mjs';
import { codeOnly } from './helpers-code.mjs';
import { PROTO_KEYS, plainIndexed, plainAgain, oldTable } from './helpers-proto.mjs';

const CORE = ENGINE.slice(ENGINE.indexOf('  const SCHEMA='), ENGINE.indexOf('\n  function Note(host, opts){'));
assert.ok(CORE.length > 1000, 'the DOM-free core is still a block above function Note()');
function core(names, mutate) {
  // eslint-disable-next-line no-new-func
  return new Function(`${mutated(CORE, mutate, 'engine')}\nreturn {${names}};`)();
}

// ── The host's opts.tool ─────────────────────────────────────────────────────────────────────
const OPEN_TOOL = (() => { const i = ENGINE.indexOf('    const OPEN_TOOL='); return ENGINE.slice(i, ENGINE.indexOf('\n', i)); })();
const openTool = (tool, mutate) => {
  // eslint-disable-next-line no-new-func
  return new Function('opts', mutated(`${CORE}\n${OPEN_TOOL}\nreturn OPEN_TOOL;`, mutate, 'OPEN_TOOL'))({ tool });
};
test("a host tool named after a prototype member, or not a string, opens on the pen", () => {
  for (const tool of [...PROTO_KEYS, ['text']]) assert.equal(openTool(tool), 'pen', String(tool));
  assert.equal(openTool('text'), 'text', 'control: a real tool is honoured');
});
test('mutation: with the old VALID_TOOL, each name is kept; without the string check, ["text"] is', () => {
  for (const tool of PROTO_KEYS) assert.equal(openTool(tool, oldTable('VALID_TOOL')), tool);
  assert.deepEqual(openTool(['text'], (s) => s.replace("typeof opts.tool==='string'&&", '')), ['text']);
});

// ── The rich-text sanitizer's tag tables ─────────────────────────────────────────────────────
// A tree as a real browser parses `<p>a<svg><constructor>b</constructor></svg>c</p>`. Measured in
// Chrome: inside <svg> (or <math>) the tagName keeps its lower case, 'constructor'; in HTML it is
// 'CONSTRUCTOR'. Other prototype names cannot be a tagName: the parser lower-cases toString to
// tostring, and __proto__ does not open a tag. The fake createElement applies the DOM's own name
// check, so a bad tag name throws InvalidCharacterError here as it does in a browser (R14).
const text = (nodeValue) => ({ nodeType: 3, nodeValue });
const el = (tagName, ...kids) => ({ nodeType: 1, tagName, childNodes: kids.map((k) => (typeof k === 'string' ? text(k) : k)),
  style: { getPropertyValue: () => '' } });
const fakeDoc = {
  createTextNode: text,
  createElement(name) {
    if (!/^[A-Za-z][^\t\n\f\r />\0]*$/.test(String(name))) throw Object.assign(new Error(`bad tag name ${name}`), { name: 'InvalidCharacterError' });
    return { nodeType: 1, tagName: String(name).toUpperCase(), childNodes: [], style: { setProperty() {} }, appendChild(n) { this.childNodes.push(n); } };
  },
};
const html = (n) => (n.nodeType === 3 ? n.nodeValue : `<${n.tagName.toLowerCase()}>${n.childNodes.map(html).join('')}</${n.tagName.toLowerCase()}>`);
const clean = (mutate) => {
  const { cleanInto } = core('cleanInto', mutate);
  const out = fakeDoc.createElement('div');
  cleanInto(el('DIV', el('P', 'a', el('svg', el('constructor', 'b')), 'c')), out, fakeDoc);
  return out.childNodes.map(html).join('');
};
test('an unknown tag named constructor is unwrapped like any other: its text is kept', () => {
  assert.equal(clean(), '<p>abc</p>');
});
test('mutation: with the old HTML_DROP its text is dropped; with only the old HTML_TAGS, sanitizing throws', () => {
  assert.equal(clean(oldTable('HTML_DROP')), '<p>ac</p>', 'as measured in Chrome before the fix');
  assert.throws(() => clean(oldTable('HTML_TAGS')), { name: 'InvalidCharacterError' });
});

// ── The invariant, over ALL of note-ui ───────────────────────────────────────────────────────
// The scan and its limits: plainIndexed in test/helpers-proto.mjs, whose shapes are pinned by
// test/stationery-proto-keys.test.mjs. Comments are stripped first (codeOnly), so prose is not code.
const NOTE_UI = codeOnly(ENGINE);
const TABLES = ['ICON', 'ICON_FILL', 'INKS', 'VALID_TOOL', 'VALID_TPL', 'RULED_TPL', 'MARGIN_TPL', 'STATIONERY_SRC', 'HTML_TAGS',
  'HTML_DROP', 'STYLE_OK', 'LINK_PAIR', 'LOAD_NOT_FOUND', 'pages', 'imgCache', 'byKind', 'undoStacks', 'redoStacks'];
test('invariant: no plain-object table is indexed with [ ] or tested with `in`, anywhere in note-ui', () => {
  assert.deepEqual(plainIndexed(NOTE_UI), []);
});
test('mutation: with every prototype-free table made plain again, the invariant names each one', () => {
  for (const shape of ['literal', 'assign']) assert.deepEqual(plainIndexed(plainAgain(NOTE_UI, shape)), TABLES, shape);
});
test('mutation: a reset in pull() written as undoStacks={} is named too', () => {
  assert.deepEqual(plainIndexed(NOTE_UI.replace(' clearHistory(); clearSelection(); }', ' undoStacks={}; clearSelection(); }')), ['undoStacks']);
});
