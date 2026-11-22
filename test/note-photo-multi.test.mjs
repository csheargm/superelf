// The journal's Photo Library picks SEVERAL photos at once (owner, 2026-11-01) and lays them out
// staggered, so none hides the one before. The camera and scan paths stay single: the camera
// yields one shot, and the straighten editor takes one photo at a time.
// R11 — searched: "multiple", "PHOTO_STAGGER", "addPhoto(" — one call site, no duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');

test('the library pick asks for several photos; camera and scan ask for one', () => {
  assert.match(ENGINE, /const camera=mode==='camera'\|\|mode==='scan';\s*\n\s*const picked=await window\.PAPhoto\.pick\(\{accept:'image\/\*', camera, multiple:!camera\}\)/,
    'multiple is the inverse of camera — one pick call, no second picker');
});

// photoSpot, run: the spots cycle so the 20th photo is as much on the page as the first.
const spotSrc = /const PHOTO_STAGGER=([0-9.]+), PHOTO_SPOTS=(\d+);\s*\n\s*const photoSpot=\(i\)=>\{[^\n]*\};/.exec(ENGINE);
test('several photos are each placed at photoSpot(i) and never sent to the single-photo editor', () => {
  assert.match(ENGINE, /if\(picked\.files\.length>1\)\{\s*for\(let i=0;i<picked\.files\.length;i\+\+\) await addPhoto\(picked\.files\[i\],photoSpot\(i\)\);\s*return;\s*\}/,
    'the multi-photo branch returns before the PAScan editor');
  assert.match(ENGINE, /const x=at\?at\.x:0\.25, y=at\?at\.y:0\.18;/, 'a single photo keeps its old spot');
});

test('photoSpot keeps a half-page-wide photo inside the page for the 1st, 8th and 20th photo alike', () => {
  assert.ok(spotSrc, 'photoSpot is one line next to its constants');
  const round4 = (v) => Math.round(v * 1e4) / 1e4;
  const photoSpot = new Function('round4', `${spotSrc[0]}\nreturn photoSpot;`)(round4);
  const W = 0.5, H = 0.5 * 0.75;                                       // the placement width; a 4:3 photo
  for (let i = 0; i < 40; i++) {
    const { x, y } = photoSpot(i);
    assert.ok(x >= 0 && x + W <= 1 && y >= 0 && y + H <= 1, `photo ${i + 1} at ${x},${y} is on the page`);
  }
  assert.notDeepEqual(photoSpot(0), photoSpot(1), 'consecutive photos do not cover each other');
  assert.deepEqual(photoSpot(Number(spotSrc[2])), photoSpot(0), 'the spots cycle');
  // CONTROL (R14): the unclamped rule the review caught (0.25 + i*0.05) fails this same check.
  assert.ok(0.25 + 20 * 0.05 + W > 1, 'the old rule put the 21st photo off the page');
});
