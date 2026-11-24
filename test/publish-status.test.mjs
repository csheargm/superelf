// The ⋯ menu's Publish line (lib/publish/status.mjs): not in the repo / up to date / N changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoStatus, cachedRepoStatus, STATUS_TTL_MS } from '../lib/publish/status.mjs';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pubst-'));
  const mine = path.join(root, 'workspace', 'apps', 'myapp'), repo = path.join(root, 'workspace.example', 'apps', 'myapp');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(mine, 'meta.json'), JSON.stringify({ title: 'My App', shared: true }));
  return { root, mine, repo, args: { appDir: mine, slug: 'myapp', root } };
}
const copyAsPublished = (mine, repo) => { fs.mkdirSync(repo, { recursive: true }); fs.writeFileSync(path.join(repo, 'index.html'), fs.readFileSync(path.join(mine, 'index.html'))); fs.writeFileSync(path.join(repo, 'meta.json'), JSON.stringify({ title: 'My App' }, null, 2) + '\n'); };

test('an app not in the repo: inRepo false', () => {
  const { root, args } = setup();
  try { assert.deepEqual(repoStatus(args), { inRepo: false, upToDate: false, changedFiles: 2 }); } finally { fs.rmSync(root, { recursive: true }); }
});

test('same code as the repo copy (local meta fields ignored): up to date', () => {
  const { root, mine, repo, args } = setup();
  try { copyAsPublished(mine, repo); assert.deepEqual(repoStatus(args), { inRepo: true, upToDate: true, changedFiles: 0 }); } finally { fs.rmSync(root, { recursive: true }); }
});

test('changed and added files count once; repo-only files and data/ never count (Publish cannot remove)', () => {
  const { root, mine, repo, args } = setup();
  try {
    copyAsPublished(mine, repo);
    fs.writeFileSync(path.join(mine, 'index.html'), '<h1>changed</h1>');   // changed
    fs.writeFileSync(path.join(mine, 'app.js'), 'x');                      // added
    fs.writeFileSync(path.join(repo, 'old.css'), 'a{}');                    // repo-only: not counted
    fs.mkdirSync(path.join(mine, 'data')); fs.writeFileSync(path.join(mine, 'data', 'n.json'), '{}');
    assert.deepEqual(repoStatus(args), { inRepo: true, upToDate: false, changedFiles: 2 });
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('cache answers within the TTL and looks again after it', () => {
  const { root, mine, repo, args } = setup();
  try {
    copyAsPublished(mine, repo);
    assert.equal(cachedRepoStatus(args, 1000).upToDate, true);
    fs.writeFileSync(path.join(mine, 'index.html'), '<h1>changed</h1>');
    assert.equal(cachedRepoStatus(args, 1000 + STATUS_TTL_MS - 1).upToDate, true);
    assert.equal(cachedRepoStatus(args, 1000 + STATUS_TTL_MS).changedFiles, 1);
  } finally { fs.rmSync(root, { recursive: true }); }
});
