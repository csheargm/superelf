// The owner's copy of a repo app publishes back to that app (lib/publish/copy-target.mjs, collect.mjs
// copySource). Unit: the mapping (string / object forkedFrom, the '-mine' rename), the refusals (another
// user's app, an app not in the repo, no owner), and that collect re-checks the very bytes it sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectApp, copySource } from '../lib/publish/collect.mjs';
import { publishTarget } from '../lib/publish/copy-target.mjs';

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-copy-'));
  const repo = path.join(root, 'workspace.example', 'apps', 'tasks'); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'index.html'), '<h1>T</h1>\n'); fs.writeFileSync(path.join(repo, 'meta.json'), JSON.stringify({ title: '待办 Tasks' }));
  const mk = (slug, meta) => { const d = path.join(root, 'ws', 'apps', slug); fs.mkdirSync(path.join(d, 'data'), { recursive: true });
    fs.writeFileSync(path.join(d, 'index.html'), '<h1>changed</h1>\n'); fs.writeFileSync(path.join(d, 'data', 'x.json'), '{"secret":1}');
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta)); return d; };
  return { root, mk };
}

test('copySource: string form for anyone, object form only for the owner\'s own app, slugs checked', () => {
  assert.equal(copySource('tasks', 'owner'), 'tasks');
  assert.equal(copySource({ uid: 'owner', slug: 'tasks' }, 'owner'), 'tasks');
  assert.equal(copySource({ uid: 'kid', slug: 'tasks' }, 'owner'), null, 'another user\'s app');
  assert.equal(copySource({ uid: 'owner', slug: 'tasks' }, undefined), null, 'no owner: no object form');
  assert.equal(copySource('../data/x', 'owner'), null, 'not a slug');
  assert.equal(copySource(true, 'owner'), null);
});

test('publishTarget maps a shelf copy (and its -mine rename) to the repo app, with its title', () => {
  const { root, mk } = tree();
  try {
    for (const slug of ['tasks', 'tasks-mine']) {
      const t = publishTarget({ appDir: mk(slug, { title: 'Mine', forkedFrom: 'tasks' }), slug, owner: 'owner', root });
      assert.deepEqual(t, { slug: 'tasks', copyOf: { slug: 'tasks', title: '待办 Tasks' } }, slug);
    }
    const own = publishTarget({ appDir: mk('mine', { title: 'Own' }), slug: 'mine', owner: 'owner', root });
    assert.deepEqual(own, { slug: 'mine', copyOf: null }, 'an own app is unchanged');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('publishTarget refuses another user\'s app and an app not in the repo, naming what to do', () => {
  const { root, mk } = tree();
  try {
    const peer = mk('schoolwork', { forkedFrom: { uid: 'test', author: 'test', slug: 'schoolwork' } });
    assert.throws(() => publishTarget({ appDir: peer, slug: 'schoolwork', owner: 'owner', root }),
      (e) => e.code === 'FORK_OTHER' && /copy of test's app/.test(e.message) && /Make an app/.test(e.message) && !/original author/.test(e.message));
    const gone = mk('gone', { forkedFrom: 'not-in-repo' });
    assert.throws(() => publishTarget({ appDir: gone, slug: 'gone', owner: 'owner', root }), (e) => e.code === 'FORK_NOT_IN_REPO' && /not in the public repo/.test(e.message));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('collect: a copy goes only as its source, with no data/ and no per-user meta; else FORKED_APP', () => {
  const { root, mk } = tree();
  try {
    const d = mk('tasks-mine', { title: 'Mine', forkedFrom: 'tasks', shared: false, gitRef: 'abc', dataSettings: { x: 1 } });
    const { files } = collectApp(d, 'tasks', { owner: 'owner' });
    assert.deepEqual(files.map((f) => f.path), ['workspace.example/apps/tasks/index.html', 'workspace.example/apps/tasks/meta.json']);
    assert.deepEqual(JSON.parse(files[1].content.toString()), { title: 'Mine' }, 'forkedFrom, shared, gitRef, dataSettings stripped');
    assert.throws(() => collectApp(d, 'tasks'), (e) => e.code === 'FORKED_APP', 'no owner: refused (status, old callers)');
    assert.throws(() => collectApp(d, 'tasks-mine', { owner: 'owner' }), (e) => e.code === 'FORKED_APP', 'not as its own slug');
    const peer = mk('p', { forkedFrom: { uid: 'kid', slug: 'tasks' } });
    assert.throws(() => collectApp(peer, 'tasks', { owner: 'owner' }), (e) => e.code === 'FORKED_APP', 'another user\'s copy');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
