// An image edit must reach disk · 图片改动必须落盘
//
// SCAR 2026-09-13. A photo was cropped in a journal note; the page redrew with the new picture,
// and on the next load the OLD image was back. Nothing errored, no save-failure pill appeared —
// the write had been SKIPPED as "nothing to send".
//
// The skip is a real optimisation with a real job: a 700ms autosave on a 6MB notebook must not
// re-POST bytes the server already confirmed. It decides by comparing contentPrint() against the
// last CONFIRMED write. But contentPrint counted images — `images+=il` — and hashed nothing about
// them. So every edit that preserves the COUNT was invisible to it:
//
//   · crop   — path and height change, count stays 1
//   · move   — x/y change, count stays 1
//   · resize — w/h change, count stays 1
//
// Measured before the fix: all three produced the byte-identical fingerprint
// `1|1|0|-1588606403|plain|#fff`. Cropping was merely the first one anybody noticed; move and
// resize had never been saved on their own either, for as long as the skip has existed.
//
// The lesson these tests pin is not "hash images". It is that a change-detector must be derived
// from everything a user can CHANGE, or it silently becomes a data-loss device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardModule } from './helpers-app.mjs';

const G = guardModule();

const noteWith = (img, opts = {}) => ({
  v: 2, template: opts.template || 'plain', bgColor: opts.bgColor || '#fff',
  pages: [{ id: 'p0', strokes: [{ p: [[0.1, 0.1, 0.5]] }], pageHtml: opts.html || '', images: img ? [img] : [] }],
});
const IMG = { path: 'a.png', x: 0.25, y: 0.2, w: 0.4, h: 0.3 };
const base = () => G.contentPrint(noteWith(IMG));

test('cropping a photo changes the fingerprint, so the save is not skipped', () => {
  // The reported case: PAScan returns a new file, it is uploaded, and the placement points at a
  // new path with a new height. Both are invisible to a counter.
  const cropped = G.contentPrint(noteWith({ ...IMG, path: 'cropped.png', h: 0.22 }));
  assert.notEqual(cropped, base(), 'a cropped photo is a different note');
});

test('moving and resizing a photo were unsaved too — the same hole, found on the way', () => {
  assert.notEqual(G.contentPrint(noteWith({ ...IMG, x: 0.6 })), base(), 'moved horizontally');
  assert.notEqual(G.contentPrint(noteWith({ ...IMG, y: 0.7 })), base(), 'moved vertically');
  assert.notEqual(G.contentPrint(noteWith({ ...IMG, w: 0.7 })), base(), 'resized');
  assert.notEqual(G.contentPrint(noteWith({ ...IMG, h: 0.55 })), base(), 'reshaped');
});

test('a note that truly has not changed still matches, or the skip stops working', () => {
  // The other half of the contract. If any edit made the fingerprint unstable, every 700ms tick
  // would re-POST the whole notebook — which on a 6.5MB note is the failure mode the skip exists
  // to prevent, and the one that made saves fail under load in the first place.
  assert.equal(G.contentPrint(noteWith(IMG)), base(), 'same content, same print');
  assert.equal(G.contentPrint(noteWith({ ...IMG })), base(), 'a fresh object with equal fields matches');
});

test('two different photos in the same place are not the same note', () => {
  // Path is the only thing separating them: same box, same page, different picture. A fingerprint
  // built from geometry alone would call these equal and skip a replacement.
  const a = G.contentPrint(noteWith({ ...IMG, path: 'one.png' }));
  const b = G.contentPrint(noteWith({ ...IMG, path: 'two.png' }));
  assert.notEqual(a, b, 'the picture itself is part of the content');
});

test('adding and removing images still registers', () => {
  // The count was never wrong — only insufficient. It must keep working.
  assert.notEqual(G.contentPrint(noteWith(null)), base(), 'removing the only image');
  const two = noteWith(IMG); two.pages[0].images.push({ ...IMG, path: 'b.png', y: 0.6 });
  assert.notEqual(G.contentPrint(two), base(), 'adding a second image');
});

test('the fingerprint is cheap enough to run on every autosave', () => {
  // It runs on a 700ms debounce over the WHOLE notebook, so it must stay linear and allocation
  // light. A hash that stringifies each page would make the guard itself the thing that stalls
  // the pen on a large note.
  const big = { v: 2, template: 'plain', bgColor: '#fff', pages: [] };
  for (let p = 0; p < 20; p++) {
    const imgs = [], strokes = [];
    for (let i = 0; i < 40; i++) imgs.push({ path: 'i' + i + '.png', x: i / 100, y: 0.1, w: 0.2, h: 0.2 });
    for (let i = 0; i < 700; i++) strokes.push({ p: [[i / 1000, 0.5, 0.5]] });
    big.pages.push({ id: 'p' + p, strokes, pageHtml: 'x'.repeat(500), images: imgs });
  }
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) G.contentPrint(big);
  const msPerCall = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  assert.ok(msPerCall < 25, `contentPrint must stay far inside the autosave debounce (took ${msPerCall.toFixed(1)}ms)`);
});

test('typed text is fingerprinted by CONTENT, not by length', () => {
  // The same hole as the image one, found while adding paragraph styles: pageHtml contributed
  // only its LENGTH, so any edit that preserves the character count was invisible to the guard.
  // A paragraph style is precisely that — <h1>Title</h1> and <h2>Title</h2> are the same length —
  // so applying one would have been skipped as "nothing to send" and lost on reload.
  const page = (html) => ({ v: 2, template: 'plain', bgColor: '#fff',
    pages: [{ id: 'p0', strokes: [], pageHtml: html, images: [] }] });
  const same = (a, b) => G.contentPrint(page(a)) === G.contentPrint(page(b));
  assert.equal(same('<h1>Title</h1>', '<h2>Title</h2>'), false, 'a style change registers');
  assert.equal(same('<p>cat</p>', '<p>dog</p>'), false, 'a same-length edit registers');
  assert.equal(same('<p>hi</p>', '<p>hi</p>'), true, 'and identical text still matches, or the skip dies');
});
