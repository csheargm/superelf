// Publish · 发布 (docs/adr/0039): code-only collection, the fail-closed privacy gate, the PII
// heuristic, and the token field staying write-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectApp, MAX_FILE_BYTES } from '../lib/publish/collect.mjs';
import { loadTermsStrict, scanFiles } from '../lib/publish/scan.mjs';
import { adminConfigView, CONFIG_FIELDS } from '../lib/adminconfig.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
function app() {
  const d = tmp(); const a = path.join(d, 'myapp');
  fs.mkdirSync(path.join(a, 'data'), { recursive: true }); fs.mkdirSync(path.join(a, 'img'));
  fs.writeFileSync(path.join(a, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(a, 'meta.json'), JSON.stringify({ title: 'My App', shared: true, forkedFrom: { uid: 'x' }, gitRef: 'abc' }));
  fs.writeFileSync(path.join(a, 'app.js'), 'export const x = 1;');
  fs.writeFileSync(path.join(a, 'img', 'a.svg'), '<svg/>');
  fs.writeFileSync(path.join(a, 'data', 'notes.json'), '{"secret":"diary"}');
  fs.writeFileSync(path.join(a, 'settings.json'), '{}');
  fs.writeFileSync(path.join(a, '.env'), 'K=1');
  fs.writeFileSync(path.join(a, 'big.js'), Buffer.alloc(MAX_FILE_BYTES + 1, 97));
  return { d, a };
}

test('collect takes code only: never data/, dotfiles, other JSON, oversize files; meta loses local fields', () => {
  const { d, a } = app();
  try {
    const { files, refused } = collectApp(a, 'myapp');
    assert.deepEqual(files.map((f) => f.path), ['app.js', 'img/a.svg', 'index.html', 'meta.json'].map((f) => `workspace.example/apps/myapp/${f}`));
    assert.ok(!files.some((f) => f.path.includes('/data/')), 'data/ never leaves');
    assert.deepEqual(refused.map((r) => r.file).sort(), ['.env', 'big.js', 'settings.json']);
    const meta = JSON.parse(files.find((f) => f.path.endsWith('meta.json')).content);
    assert.deepEqual(meta, { title: 'My App' });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('collect refuses symlinks (file and folder) and a linked app folder', () => {
  const { d, a } = app();
  try {
    fs.writeFileSync(path.join(d, 'outside.js'), 'leak');
    fs.symlinkSync(path.join(d, 'outside.js'), path.join(a, 'link.js'));
    fs.symlinkSync(d, path.join(a, 'up'));
    const { files, refused } = collectApp(a, 'myapp');
    assert.ok(!files.some((f) => /link\.js|\/up\//.test(f.path)));
    assert.deepEqual(refused.filter((r) => r.why === 'symlink').map((r) => r.file).sort(), ['link.js', 'up']);
    fs.symlinkSync(a, path.join(d, 'alias'));
    assert.throws(() => collectApp(path.join(d, 'alias'), 'myapp'), { code: 'LINKED_APP' });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('privacy gate fails CLOSED: a missing or empty term file refuses', () => {
  const r = tmp();
  try {
    assert.throws(() => loadTermsStrict(r), { code: 'PRIVACY_TERMS_MISSING' });
    fs.writeFileSync(path.join(r, 'privacy-terms.txt'), 'Zorblax\n');
    assert.throws(() => loadTermsStrict(r), { code: 'PRIVACY_TERMS_MISSING' }, 'the second file is missing');
    fs.mkdirSync(path.join(r, 'workspace')); fs.writeFileSync(path.join(r, 'workspace/identity-denylist.txt'), '# only a comment\n\n');
    assert.throws(() => loadTermsStrict(r), { code: 'PRIVACY_TERMS_MISSING' }, 'comments only = empty');
    fs.writeFileSync(path.join(r, 'workspace/identity-denylist.txt'), 'Quux Town\n');
    assert.deepEqual(loadTermsStrict(r), ['Zorblax', 'Quux Town']);
    assert.throws(() => scanFiles([], []), { code: 'PRIVACY_TERMS_MISSING' }, 'no terms is never a clean scan (R14)');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('scan hits return file:line and the line text: terms, emails, keys, phones, street addresses', () => {
  const f = (p, s) => ({ path: p, content: Buffer.from(s) });
  const hits = scanFiles([
    f('a/index.html', 'ok\nby Zorblax\n'),
    f('a/app.js', 'const m = "pat.person' + '@' + 'realmail.com";\nconst k = "' + 'ghp' + '_abcdefghijklmnopqrstuvwxyz12";\n'),
    // Built at run time: the repo's own identity scan (test/identity-leak.test.mjs) reads this file too.
    f('a/b.js', ['call (415) 555-' + '0134 now', '手机 138' + '12345678', 'at 1600 ' + 'Pennsylvania Avenue', '北京市长安街1号', ''].join('\n')),
    f('a/c.js', 'version 5.4.0 on 2026-11-23, port 8080\n'),
  ], ['Zorblax']);
  const got = hits.map((h) => `${h.file}:${h.line} ${h.rule}`);
  assert.deepEqual(got, ['a/index.html:2 term #1', 'a/app.js:1 email address', 'a/app.js:2 key-shaped string',
    'a/b.js:1 phone number', 'a/b.js:2 phone number', 'a/b.js:3 street address', 'a/b.js:4 street address']);
  assert.equal(hits[0].text, 'by Zorblax', 'the owner sees the line itself');
});

test('github_publish_token is a write-only secret under Advanced: the view never carries it', () => {
  const f = CONFIG_FIELDS.find((x) => x.key === 'github_publish_token');
  assert.equal(f.kind, 'secret'); assert.equal(f.advanced, true); assert.match(f.purpose, /[一-鿿].* · [A-Za-z]/);
  const tok = ['github', 'pat', 'SECRETVALUE_0123456789abcdef'].join('_');
  const view = JSON.stringify(adminConfigView({ github_publish_token: tok }));
  assert.ok(!view.includes(tok), 'value never serialized');
  assert.ok(view.includes('github_publish_token'));
});
