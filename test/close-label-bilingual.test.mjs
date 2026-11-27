// 关闭 · Close — every ✕ label follows the house "中文 · English" pair (owner 2026-11-27, iPhone Bible: the
// chat's ✕ said "Close" only). PALang (web/lang.js) switches only "中文 · English" title / aria-label pairs, so a
// bare "Close" stays English in a 中文 UI and in the bilingual Bible. Enumerated, not patched at one site: every
// shared UI file and every built-in app source is scanned, and the three sites found on 2026-11-27 are pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';

const DIRS = ['web', 'shared-apps', 'workspace/apps', 'workspace.example/apps'];
const EXT = /\.(html|js|mjs)$/;
// A title / aria-label / ariaLabel whose whole value is English "Close" (any quote, escaped or not).
const BARE = /(?:title|aria-label|ariaLabel)\s*[=:]\s*\\?["'`]Close\\?["'`]|setAttribute\(\s*["'](?:title|aria-label)["']\s*,\s*["'`]Close["'`]\s*\)/g;

function files(dir) {
  const abs = path.join(ROOT, dir); if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { recursive: true }).filter((f) => EXT.test(f) && !f.includes('.versions')).map((f) => path.join(dir, f));
}

test('no English-only "Close" title / aria-label in shared UI or built-in apps', () => {
  const hits = [];
  for (const d of DIRS) for (const f of files(d)) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(BARE)) hits.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(hits, [], 'every ✕ label is "关闭 · Close"');
});

test('the three ✕ controls found on 2026-11-27 carry the pair in title AND aria-label', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.match(read('web/chat-ui.inline.html'), /class="pac-new pac-close" title="关闭 · Close" aria-label="关闭 · Close"/, 'PAChat ✕');
  assert.match(read('web/note-ui.inline.html'), /class="pan-hx" title="关闭 · Close" aria-label="关闭 · Close"/, 'PANote header ✕');
  assert.match(read('web/app-edit.js'), /id="aeClose" title="关闭 · Close" aria-label="关闭 · Close"/, 'Change-this-app ✕');
});

test('control (R14): the scan does find a bare "Close" when one is there', () => {
  for (const s of ['<button title="Close">', "b.setAttribute('aria-label','Close')", '{ariaLabel:\'Close\'}', '\\"Close\\"'.replace(/^/, 'title=')])
    assert.ok([...s.matchAll(BARE)].length === 1, s);
  assert.equal([...'<button title="关闭 · Close">'.matchAll(BARE)].length, 0, 'the pair is not a hit');
});
