// The core-change checkout (docs/adr/0043 §2) on a throwaway bare remote: clone, branch per request,
// dirty refusals, the one-at-a-time lock, the deny list and caps, and that no hook ever runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { selfpubFixture, tgit } from './helpers-selfpub.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { ensureCheckout, startBranch, collectChange, acquireLock, deniedPath, discardBranch, git } from '../lib/selfpub/checkout.mjs';

const setup = () => { const fx = selfpubFixture(); const dir = ensureCheckout({ root: fx.root, cloneUrl: fx.bare }); return { fx, dir }; };

test('clone once, branch self/<date>-<id> off origin/main, no token in .git/config', () => {
  const { fx, dir } = setup();
  try {
    assert.equal(ensureCheckout({ root: fx.root, cloneUrl: fx.bare }), dir);
    const b = startBranch(dir, 'abc123', { now: new Date('2026-11-25T10:00:00Z') });
    assert.equal(b, 'self/20261125-abc123');
    assert.equal(tgit(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), b);
    assert.ok(!/extraheader|token/i.test(fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8')));
    assert.throws(() => startBranch(dir, 'BAD/ID'), { code: 'BAD_ID' });
  } finally { rmTemp(fx.d); }
});

test('dirty checkout: a foreign change is refused; an open self/* change is refused, never thrown away', () => {
  const { fx, dir } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'web', 'home.css'), 'x');
    assert.throws(() => startBranch(dir, 'abcd1'), { code: 'CHECKOUT_DIRTY' });
    tgit(dir, 'checkout', '-q', '-f', 'main'); startBranch(dir, 'abcd1');
    fs.writeFileSync(path.join(dir, 'web', 'home.css'), 'y');
    assert.throws(() => startBranch(dir, 'abcd2'), { code: 'CHANGE_OPEN' });
    assert.equal(fs.readFileSync(path.join(dir, 'web', 'home.css'), 'utf8'), 'y');
    discardBranch(dir);
    assert.equal(git(dir, ['status', '--porcelain']).trim(), '');
    startBranch(dir, 'abcd3');
  } finally { rmTemp(fx.d); }
});

test('lock: one change at a time', () => {
  const fx = selfpubFixture();
  try {
    const rel = acquireLock(fx.root);
    assert.throws(() => acquireLock(fx.root), { code: 'IN_FLIGHT' });
    rel(); acquireLock(fx.root)();
  } finally { rmTemp(fx.d); }
});

test('collectChange: writes, deletes, new files; denied paths, binaries refused; caps refuse the whole change', () => {
  const { fx, dir } = setup();
  try {
    startBranch(dir, 'abcd1');
    fs.writeFileSync(path.join(dir, 'web', 'home.css'), 'body{}\n');
    fs.writeFileSync(path.join(dir, 'web', 'new.js'), 'export {};\n');
    fs.rmSync(path.join(dir, 'test', 'public-privacy.test.mjs'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true }); fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'x');
    fs.writeFileSync(path.join(dir, 'web', 'pic.bin'), Buffer.from([1, 0, 2]));
    const c = collectChange(dir);
    assert.deepEqual(c.files.map((f) => f.path), ['web/home.css', 'web/new.js']);
    assert.deepEqual(c.deletes, []);
    assert.deepEqual(c.refused.map((r) => r.file).sort(), ['.github/workflows/ci.yml', 'test/public-privacy.test.mjs', 'web/pic.bin'], 'a deleted test is refused (it is CI evidence)');
    assert.throws(() => collectChange(dir, { maxFiles: 2 }), { code: 'TOO_MANY_FILES' });
    assert.throws(() => collectChange(dir, { maxDiffKb: 0 }), { code: 'DIFF_TOO_BIG' });
  } finally { rmTemp(fx.d); }
});

test('symlinks are never published', { skip: process.platform === 'win32' }, () => {
  const { fx, dir } = setup();
  try {
    startBranch(dir, 'abcd1');
    fs.symlinkSync('/etc/hosts', path.join(dir, 'web', 'link.txt'));
    assert.deepEqual(collectChange(dir).refused, [{ file: 'web/link.txt', why: 'not a regular file' }]);
  } finally { rmTemp(fx.d); }
});

test('deny list', () => {
  for (const p of ['.github/x', '.gitmodules', 'ops/private/a', 'a/.env.local', 'config.json', 'lib/claude-token.mjs', 'claude-auth.json']) assert.ok(deniedPath(p), p);
  for (const p of ['web/home.css', 'lib/selfpub/run.mjs', 'docs/adr/0044-self-publish.md']) assert.ok(!deniedPath(p), p);
});

test('a hook planted in the checkout never runs', { skip: process.platform === 'win32' }, () => {
  const { fx, dir } = setup();
  try {
    const mark = path.join(fx.d, 'hook-ran');
    const hook = path.join(dir, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 });
    startBranch(dir, 'abcd1');
    assert.ok(!fs.existsSync(mark));
  } finally { rmTemp(fx.d); }
});
