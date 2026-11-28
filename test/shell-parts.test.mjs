// 外壳组成清单是数据 · The shell's parts list is data (web/shell-parts.json, lib/shell-parts.mjs, docs/adr/0049).
// A self-publish copy is agent-written, so its list is validated as names only before the node's builder
// reads it; and the builder reads the COPY's list, so a change that adds a part is drawn with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateShellParts, readShellParts, nodeShellParts, MAX_SHELL_PARTS, PARTS_FILE } from '../lib/shell-parts.mjs';
import { readShell, SHELL_PARTS } from '../lib/shellhtml.mjs';
import { previewAnswer } from '../lib/selfpub/preview-page.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skipIf } from './helpers-skip.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ok = { marker: '/* PA_X_JS */', file: 'x.js' };

// A copy of this repo's web/ in a temp tree: the same shape a self-publish checkout has.
function copyTree() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'parts-')));
  fs.cpSync(path.join(ROOT, 'web'), path.join(d, 'web'), { recursive: true });
  return d;
}
// The copy adds a part the node does not have: a new file, its marker in index.html, its line in the list.
function addPart(d, file, body) {
  fs.writeFileSync(path.join(d, 'web', file), body);
  const idx = path.join(d, 'web', 'index.html');
  fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace('/* PA_SELFPUB_JS */', '/* PA_SKIN_JS */\n/* PA_SELFPUB_JS */'));
  const list = JSON.parse(fs.readFileSync(path.join(d, 'web', PARTS_FILE), 'utf8'));
  list.push({ marker: '/* PA_SKIN_JS */', file, why: 'test' });
  fs.writeFileSync(path.join(d, 'web', PARTS_FILE), JSON.stringify(list));
}

test('the node list is the file, every entry valid, and the old in-code order kept', () => {
  assert.deepEqual(SHELL_PARTS, nodeShellParts());
  assert.ok(SHELL_PARTS.length > 30);
  assert.deepEqual(SHELL_PARTS[0], ['/* PA_BAR_HANDLE_CSS */', 'bar-handle.css']);
  assert.ok(SHELL_PARTS.findIndex(([, f]) => f === 'selfpub-try.js') < SHELL_PARTS.findIndex(([, f]) => f === 'selfpub.js'), 'Try it before PASelfPub');
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'lib', 'shellhtml.mjs'), 'utf8'), /\['\/\* PA_/, 'no second list in code (R3)');
});

test('validation: names only under web/, allow-listed shapes, no traversal, no extras', () => {
  assert.deepEqual(validateShellParts([ok, { marker: '<!--PA_Y_UI-->', file: 'y.inline.html', why: 'w' }]), [['/* PA_X_JS */', 'x.js'], ['<!--PA_Y_UI-->', 'y.inline.html']]);
  for (const file of ['../x.js', 'a/x.js', '..\\x.js', '.x.js', 'x.json', 'x', 'X.js', '/etc/x.js', 'x.js\u0000', 'x..js', 'x.mjs', ''])
    assert.throws(() => validateShellParts([{ ...ok, file }]), /bad file name/, JSON.stringify(file));
  for (const marker of ['PA_X', '/*PA_X*/', '<!-- PA_X -->', '/* pa_x */', '/* PA_X */ extra', '<script>'])
    assert.throws(() => validateShellParts([{ ...ok, marker }]), /bad marker/, marker);
  assert.throws(() => validateShellParts([{ ...ok, path: '/etc' }]), /only marker, file, why/);
  assert.throws(() => validateShellParts([['/* PA_X_JS */', 'x.js']]), /only marker, file, why/);
  assert.throws(() => validateShellParts([{ ...ok, why: 3 }]), /why must be text/);
  assert.throws(() => validateShellParts([ok, { ...ok, marker: '/* PA_Z_JS */' }]), /listed twice/);
  assert.throws(() => validateShellParts({ parts: [] }), /must be an array/);
  assert.throws(() => validateShellParts(Array.from({ length: MAX_SHELL_PARTS + 1 }, (_, i) => ({ marker: `/* PA_X${i} */`, file: `x${i}.js` }))), /max/);
});

test('a copy with no parts file uses this node\'s list; a broken one throws (never read as empty)', () => {
  const d = copyTree();
  try {
    fs.rmSync(path.join(d, 'web', PARTS_FILE));
    assert.deepEqual(readShellParts(d), nodeShellParts());
    fs.writeFileSync(path.join(d, 'web', PARTS_FILE), '[{"marker":"/* PA_X */","file":"../../config.json"}]');
    assert.throws(() => readShellParts(d), /bad file name/);
    assert.throws(() => readShell(d), /bad file name/);
    fs.writeFileSync(path.join(d, 'web', PARTS_FILE), 'not json');
    assert.throws(() => readShellParts(d));
    const r = previewAnswer(d, '/');
    assert.equal(r.status, 500); assert.match(r.body, /The shell could not be built/, 'the page says why (R5)');
  } finally { rmTemp(d); }
});

test('regression: a copy that ADDS a part is assembled with it (the node list missed it before)', () => {
  const d = copyTree();
  try {
    addPart(d, 'skin.js', 'window.PA_SKIN_MARK="skin-part-drawn";\n');
    assert.ok(readShellParts(d).some(([, f]) => f === 'skin.js'));
    const page = previewAnswer(d, '/');
    assert.equal(page.status, 200); assert.match(page.body, /skin-part-drawn/);
    assert.doesNotMatch(page.body, /PA_SKIN_JS/, 'its marker was filled');
    assert.doesNotMatch(readShell(ROOT), /skin-part-drawn/, 'the node\'s own shell is unchanged');
  } finally { rmTemp(d); }
});

test('a part that is a symlink out of web/ is refused', { skip: skipIf(process.platform === 'win32', 'posix-only', 'POSIX symlinks') }, () => {
  const d = copyTree();
  try {
    fs.writeFileSync(path.join(d, 'secret.txt'), 'SECRET-OUTSIDE-WEB');
    fs.rmSync(path.join(d, 'web', 'popover.js')); fs.symlinkSync(path.join(d, 'secret.txt'), path.join(d, 'web', 'popover.js'));
    assert.throws(() => readShell(d), /points outside web/);
    assert.doesNotMatch(previewAnswer(d, '/').body, /SECRET-OUTSIDE-WEB/);
  } finally { rmTemp(d); }
});
