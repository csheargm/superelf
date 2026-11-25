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

test('GPT review: a shelf entry another account shared is theirs; a bad meta refuses; other repo refuses', () => {
  const { root, mk } = tree();
  try {
    const shelf = path.join(root, 'shared-apps', 'tasks'); fs.mkdirSync(shelf, { recursive: true });
    fs.writeFileSync(path.join(shelf, 'meta.json'), JSON.stringify({ sharedBy: 'kid' }));
    const d = mk('tasks-mine', { forkedFrom: 'tasks' });
    assert.throws(() => publishTarget({ appDir: d, slug: 'tasks-mine', owner: 'owner', root }), (e) => e.code === 'FORK_OTHER');
    fs.writeFileSync(path.join(shelf, 'meta.json'), JSON.stringify({ sharedBy: 'owner' }));
    assert.equal(publishTarget({ appDir: d, slug: 'tasks-mine', owner: 'owner', root }).slug, 'tasks');
    assert.throws(() => publishTarget({ appDir: d, slug: 'tasks-mine', owner: 'owner', root, defaultRepo: false }), (e) => e.code === 'FORK_OTHER_REPO');
    fs.writeFileSync(path.join(d, 'meta.json'), `{"forkedFrom":"tasks"}${' '.repeat((1 << 20) + 1)}`);
    assert.throws(() => publishTarget({ appDir: d, slug: 'tasks-mine', owner: 'owner', root }), (e) => e.code === 'BAD_META', 'oversize meta is not read');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('GPT review: shelf fields (promotedFrom, files, sharedBy) never reach the published meta', () => {
  const { root, mk } = tree();
  try {
    const d = mk('tasks-mine', { title: 'T', forkedFrom: 'tasks', sharedBy: 'owner', promotedAt: 'x', promotedFrom: { uid: 'owner', slug: 'tasks' }, files: { 'data/a.json': 'abc' } });
    const meta = collectApp(d, 'tasks', { owner: 'owner' }).files.find((f) => f.path.endsWith('meta.json'));
    assert.deepEqual(JSON.parse(meta.content.toString()), { title: 'T' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('GPT review: one local app never runs two publishes (the status key is locked too)', async () => {
  const { startPublish, previewPublish } = await import('../lib/publish/run.mjs');
  const { root, mk } = tree();
  try {
    const d = mk('tasks-mine', { forkedFrom: 'tasks' });
    fs.writeFileSync(path.join(root, 'privacy-terms.txt'), 'Zorblax\n');
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true }); fs.writeFileSync(path.join(root, 'workspace', 'identity-denylist.txt'), 'Quux Town\n');
    const o = { token: 't', repo: 'csheargm/superelf', api: 'http://127.0.0.1:9', termsRoot: root };
    const { hash } = previewPublish({ appDir: d, slug: 'tasks', owner: 'owner', options: o });
    let release; const gate = new Promise((r) => { release = r; });
    const fetchFn = async () => { await gate; throw new Error('offline'); };   // the first publish waits on GitHub
    const first = startPublish({ appDir: d, slug: 'tasks', owner: 'owner', key: 'tasks-mine', options: o, fetchFn, expectHash: hash });
    await assert.rejects(startPublish({ appDir: d, slug: 'other', owner: 'owner', key: 'tasks-mine', options: o, expectHash: 'x' }), (e) => e.code === 'IN_FLIGHT');
    release(); assert.equal((await first).status.code, 'GITHUB_UNREACHABLE');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
