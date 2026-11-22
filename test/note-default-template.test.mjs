// A new note starts plain · 新笔记默认无模板
//
// New notes started on RULED paper, and typed text snaps its baselines to the rule gap
// (applyTextMetrics) — so every new note was a lined page whose line spacing the user had not
// asked for and could not change from the font picker. Plain leaves the text layer on ordinary
// word-processor metrics; ruled is a choice you make, not a place you start.
//
// The trap this pins: there are TWO defaults, and they must not move together. One decides what a
// NEW note is. The other decides how an OLD note is READ when its template is missing — and every
// such note was written when new notes started ruled, so it has to keep answering 'ruled' or those
// notes restyle themselves the moment they are opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);

test('a new note starts plain', () => {
  assert.match(E, /const DEFAULT_TPL='plain';/, 'the new-note default is a named constant');
  assert.match(E, /template:\(typeof tpl==='string'&&VALID_TPL\[tpl\]\?tpl:DEFAULT_TPL\)/,
    'freshNotebook uses it, and still honours a template the host asks for');
});

test('an existing note with no template still reads as ruled', () => {
  // The back-compat half. If this followed DEFAULT_TPL, every old note saved without a usable
  // template would open plain — its ruled lines gone, and its typed text re-spaced.
  const fn = /const validTemplate=o=>[\s\S]*?'ruled';/.exec(E);
  assert.ok(fn, 'validTemplate must be findable');
  assert.match(fn[0], /: 'ruled';$/m, "the READ fallback is still 'ruled'");
  assert.doesNotMatch(fn[0], /DEFAULT_TPL/, 'and is deliberately not tied to the new-note default');
});

test('nothing else falls back to a hardcoded ruled', () => {
  // Two runtime fallbacks (drawPaper, the picker sync) used a literal 'ruled'. Unreachable in
  // practice, but a literal left behind is what the next reader copies.
  const strays = [...E.matchAll(/\|\|'ruled'/g)];
  assert.equal(strays.length, 0, `no ||'ruled' fallbacks remain (found ${strays.length})`);
  assert.equal((E.match(/\|\|DEFAULT_TPL/g) || []).length, 2, 'both now follow the named default');
});

test("the Bible app's explicit plain is unaffected", () => {
  // It passes template:'plain' itself. A host that states its paper must keep winning over any
  // default, or the default becomes an override.
  assert.match(E, /VALID_TPL\[tpl\]\?tpl:/, 'a valid host template is used as-is');
});

test('plain really is the non-ruled branch', () => {
  // The whole reason for the change: RULED_TPL decides whether text snaps to rule lines, and
  // plain must not be in it or the default would have changed nothing.
  const ruled = /const RULED_TPL=[^{\n]*\{([^}]*)\}/.exec(E);
  assert.ok(ruled, 'RULED_TPL must be findable');
  assert.doesNotMatch(ruled[1], /plain/, 'plain does not snap text to rules');
  assert.deepEqual(ruled[1].split(',').map((k) => k.split(':')[0]), ['ruled', 'notebook', 'college']);
});
