// Six Bible notes on one chapter all listed as the literal placeholder "New Note", so the user
// could not tell which row held their handwriting and reasonably concluded it was lost (it was
// not). The key already carries the creation time: free-<epoch>. These pin the derived title and
// the fact that the app's title bar and the server's listing agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { htmlToText } from '../lib/note-index.mjs';   // firstLineTitle reads pageHtml through the lib's ONE rule (R3)

// The TRACKED template, not workspace/ — that directory is the user's live data and gitignored,
// so reading it made this test unrunnable on a fresh clone. The template is kept in sync with the
// live app; when it drifts, the fix is to sync it, not to point tests at data that is not in the
// repository.
const APP = fs.readFileSync(new URL('../workspace.example/apps/bible/index.html', import.meta.url), 'utf8');
const SRV = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');

// The shipped formatter, lifted from web.mjs rather than retyped.
const srvFn = SRV.match(/export const freeStamp = \(k, now = new Date\(\)\) => \{[\s\S]*?\n\};/);
const freeStamp = new Function('k', 'now', srvFn[0].replace(/^export const freeStamp = \(k, now = new Date\(\)\) => \{/, 'now = now || new Date();').replace(/\n\};$/, ''));

test('a free-form key yields its creation time; a verse key yields nothing', () => {
  const t = new Date(2026, 8, 2, 17, 31);
  assert.equal(freeStamp(`free-${t.getTime()}`, t), ' · 17:31', 'same day → time only');
  assert.equal(freeStamp('v3', t), '', 'verse scopes keep their verse-range title');
  assert.equal(freeStamp('general', t), '');
});

test('a note from another day carries the date too', () => {
  const made = new Date(2026, 8, 1, 9, 5);
  const now = new Date(2026, 8, 2, 12, 0);
  assert.equal(freeStamp(`free-${made.getTime()}`, now), ' · 9/1 09:05');
});

test('a malformed epoch never produces a bogus date', () => {
  assert.equal(freeStamp('free-abc'), '');
  assert.equal(freeStamp('free-1'), '', 'too short to be an epoch');
  assert.equal(freeStamp(null), '');
});

test('the stored placeholder is treated as UNSET so old notes retitle with no migration', () => {
  assert.match(SRV, /LEGACY_NEW_NOTE = 'New Note'/);
  assert.match(SRV, /stored !== LEGACY_NEW_NOTE/, 'the placeholder must not win over the derived title');
  assert.doesNotMatch(APP, /titles\[freeKey\]\s*=\s*'New Note'/, 'the app must no longer store the placeholder');
});

test('an empty note is never persisted — tapping "new" and leaving discards it', () => {
  assert.doesNotMatch(APP, /if\(empty&&!k\.startsWith\('free-'\)\)/, 'persist-empty was reverted');
  assert.match(APP, /if\(empty\)\{ if\(k in ANN\.draws\)/, 'an empty notebook must not be written');
  // Lazy creation, NOT create-then-delete: with no placeholder title written either, an
  // abandoned note leaves nothing behind and no delete can race a pending save.
  assert.doesNotMatch(APP, /titles\[freeKey\]\s*=/, 'nothing may be created before there is content');
});

test('every note names itself by its first line, and falls back to its reference', () => {
  const fn = SRV.match(/export const firstLineTitle = \(data, k, max = 40\) => \{[\s\S]*?\n\};/);
  assert.ok(fn, 'firstLineTitle missing');
  const lifted = new Function('data', 'k', 'max', 'htmlToText',
    fn[0].replace(/^export const firstLineTitle = \(data, k, max = 40\) => \{/, 'max = max || 40;').replace(/\n\};$/, ''));
  const firstLineTitle = (data, k, max) => lifted(data, k, max, htmlToText);
  const withText = { notes: { 'free-1': '  Sermon notes\nsecond line' } };
  assert.equal(firstLineTitle(withText, 'free-1'), 'Sermon notes', 'plain text pane wins');
  const withHtml = { draws: { 'free-2': { pages: [{ pageHtml: '<div><b>Grace</b> 恩典</div><div>more</div>' }] } } };
  assert.equal(firstLineTitle(withHtml, 'free-2'), 'Grace 恩典', 'markup stripped, first block only');
  assert.equal(firstLineTitle({ draws: { 'free-3': { pages: [{ pageHtml: '' }] } } }, 'free-3'), '',
    'a pure drawing has no first line → the timestamp title applies');
  // CHANGED 2026-09-10, on the user's explicit instruction: "the note's title should be the same
  // in the drawer". A verse note named by its first line in the pad and by its reference in the
  // list was one note with two names. The reference is still the fallback for a note with no
  // text, so a pure-handwriting verse note reads as "John 3:1" exactly as before.
  assert.match(SRV, /const derived = firstLineTitle\(data, k\);/, 'every note is named by its own first line');
  assert.doesNotMatch(SRV, /k\.startsWith\('free-'\) \? firstLineTitle/, 'the free-form-only restriction is gone');
});

test('the app title bar and the server listing use the same format', () => {
  // This used to assert that the app's HAND COPY of the format still contained the same clock
  // arithmetic — policing a duplicate instead of removing it, and Journal never got a copy at all.
  // The format now lives once in PANote; test/note-default-title.test.mjs holds PANote and
  // web.mjs freeStamp byte-identical. Here we only pin that the app stopped keeping its own.
  const appFn = APP.match(/function freeNoteTitle\(k\)\{[\s\S]*?\n\}/);
  assert.ok(appFn, 'app-side formatter missing');
  assert.match(appFn[0], /PANote\.stamp\(/, 'the app must ask PANote for the stamp');
  for (const bit of ['toDateString()', 'padStart(2', 'getMonth()+1']) {
    assert.ok(!appFn[0].includes(bit), `the app re-grew its own copy of the format: ${bit}`);
  }
});

test('a free-form note can be OPENED and SELECTED from the drawer', () => {
  // Scar 2026-09-05: scopeKey() only yields a verse key or 'general', so clicking a free-form
  // row opened the general note (empty) and the row never highlighted — the content was fine
  // on disk the whole time. The scope must be passed explicitly.
  // Pinned as "accepts an explicit scope FIRST", not as an exact parameter list: the function has
  // since grown a third argument (rowId) and the old form failed a test that was never about the
  // arity. What matters is that a caller can hand it a scope rather than letting scopeKey() guess.
  assert.match(APP, /function openDrawFull\(forceKey,forceTitle[,)]/, 'openDrawFull must accept an explicit scope');
  assert.match(APP, /_drawScope=forceKey\|\|scopeKey\(\)/, 'an explicit scope must win over the verse-derived one');
  assert.match(APP, /function openPanel\(pane,forceKey,forceTitle[,)]/, 'openPanel must pass the scope through');
  assert.match(APP, /n\.verseKey\.startsWith\('free-'\)\?n\.verseKey:null/, 'the drawer row must pass its own key');
  assert.match(APP, /padOpen&&typeof _drawScope==='string'&&_drawScope\.startsWith\('free-'\)/,
    'currentNoteId must report the free-form scope so the row highlights');
});

test('each note carries its OWN time, so a new note sorts to the top', () => {
  // Every note in a chapter lives in ONE file; using stat.mtimeMs made them all report the same
  // instant ("now" on every row) and a newly created note could never reach the top of the list.
  assert.match(SRV, /const own = Number\(\(\(data\.draws \|\| \{\}\)\[k\] \|\| \{\}\)\.updated\) \|\| 0;/,
    'prefer the notebook\'s own updated');
  assert.match(SRV, /const born = \(\/\^free-\(\\d\{10,\}\)\$\/\.exec\(k\) \|\| \[\]\)\[1\];/,
    'fall back to the creation time encoded in the key');
  assert.doesNotMatch(SRV, /updated: stat\.mtimeMs \}\)/, 'the file mtime must no longer be the note time');
});

test('an unnamed free-form note reads as a note, not as a verse reference', () => {
  assert.match(SRV, /NEW_NOTE_LABEL = 'New Note 新笔记'/);
  assert.match(SRV, /stamp \? `\$\{NEW_NOTE_LABEL\}\$\{stamp\}`/,
    'a free-form note uses the label; a verse note keeps book+chapter+verses');
  assert.match(APP, /PANote\.NEW_NOTE_LABEL/, 'the pad title bar takes the label from PANote, not a local copy');
});
