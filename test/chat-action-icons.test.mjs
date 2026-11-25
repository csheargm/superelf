// Chat action icons（消息操作图标）— the copy / read-aloud / ask-again / edit icons are SVGs from ONE set (R3):
// web/icons.js PAIcons, mirrored in web/chat-ui.inline.html (an app page cannot load icons.js). This pins the
// mirror equal and pins that neither chat builds an action button from a text glyph (iOS has no font for ⎘ / ✎:
// owner iPhone 2026-11-25 showed them tiny and faint).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
const PAIcons = vm.runInNewContext(read('icons.js') + ';PAIcons');
const svgOf = (k) => PAIcons.svg(k).replace(/^<svg[^>]*>|<\/svg>$/g, '');

test('chat-ui mirrors the PAIcons action icons exactly', () => {
  const src = read('chat-ui.inline.html');
  const block = src.match(/const PAC_ICON=(\{[\s\S]*?\});/);
  assert.ok(block, 'PAC_ICON map present');
  const mirror = vm.runInNewContext('(' + block[1] + ')');
  for (const k of ['copy', 'speaker', 'refresh', 'pen']) assert.equal(mirror[k], svgOf(k), `${k} differs from web/icons.js`);
});

test('no action button is built from a text glyph', () => {
  for (const [f, re] of [['chat-ui.inline.html', /mkab\('([^']*)'/g], ['index.html', /mkab\('([^']*)'/g]]) {
    const icons = [...read(f).matchAll(re)].map((x) => x[1]);
    assert.ok(icons.length >= 4, `${f}: action buttons found`);
    for (const i of icons) assert.match(i, /^[a-z]+$/, `${f}: mkab('${i}') is a glyph, not an icon name`);
  }
});
