// Promoting an app commits the shelf · 上架即提交
//
// shared-apps/ became tracked in v3.5.0, so promote/rollback/unshare left the repo dirty until a
// person remembered to commit — the exact drift the tracking was meant to end.
//
// The two rules this pins matter more than the feature. The commit is PATHSPEC-ONLY, because this
// working tree usually has somebody editing in it and sweeping their half-finished work into a
// release commit would be worse than never committing. And a git failure must NEVER fail the
// promote: the files are the operation, the commit is bookkeeping. An app on the shelf but not
// committed is recoverable; a promote that threw after writing files is not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const fn = () => {
  const m = /function commitShelf\(slug, message\)\{?[\s\S]*?\n\}/.exec(WEB);
  assert.ok(m, 'commitShelf must be findable');
  return m[0];
};

test('it commits ONLY the shelf path, never the index', () => {
  const f = fn();
  // `git commit -- <path>` commits those paths and ignores the index. Without the pathspec, an
  // unrelated staged change gets published inside a release commit.
  assert.match(f, /git\(\['commit', '-m', message, '--', rel\]\)/, 'commit is pathspec-scoped');
  assert.match(f, /git\(\['add', '-A', '--', rel\]\)/, 'and so is the add (-A so an unshare stages its deletion)');
  assert.match(f, /const rel = `shared-apps\/\$\{slug\}`/, 'the path is the one slug being changed');
  assert.ok(!/\bgit\(\['commit', '-a'|\-\-all/.test(f), 'never commits everything');
});

test('it never pushes', () => {
  // Pushing is outward-facing and belongs to a person, not to a settings click.
  assert.ok(!/push/.test(fn()), 'no push in the shelf commit path');
});

test('a git failure is swallowed and audited, never thrown', () => {
  const f = fn();
  assert.match(f, /catch \(e\)/, 'the whole thing is guarded');
  assert.match(f, /audit\('shelf-commit-failed'/, 'and a real failure is reported (R5)');
  assert.match(f, /nothing to commit\|no changes added\|nothing added/,
    'identical bytes is SUCCESS — the shelf already matched the repo');
  assert.ok(!/throw/.test(f), 'it never rethrows: the files are the operation');
});

test('promote still succeeds when the root is not a git repo at all', async () => {
  // The strongest form of "never fail the operation": the throwaway test root has no .git, so
  // every git call in commitShelf fails. The promote must still return ok and the app must still
  // land on the shelf.
  const port = await freePort();
  const root = mkWebRoot({ port });
  const web = startWeb(root);
  try {
    await waitReady(port);
    assert.equal(fs.existsSync(path.join(root, '.git')), false, 'precondition: not a repo');
    const appDir = path.join(root, 'workspace', 'apps', 'vocab');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'index.html'), '<h1>vocab</h1>');
    fs.writeFileSync(path.join(appDir, 'meta.json'), JSON.stringify({ title: 'Vocab' }));
    const r = await api(port, '/api/admin/share', {
      method: 'POST',
      headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'owner', slug: 'vocab' }),
    });
    assert.equal(r.status, 200, 'the promote succeeded despite git being unavailable');
    assert.deepEqual(await r.json(), { ok: true });
    assert.ok(fs.existsSync(path.join(root, 'shared-apps', 'vocab', 'index.html')), 'and the app really is on the shelf');
  } finally { await stopWeb(web); rmTemp(root); }
});
