// Built-in app updates reach an existing install (owner report 2026-11-23: the live Docker node kept the
// 857c8f2 Bible, so F2-03's chapter buttons and swipe never arrived). The REAL web.mjs boots on a throwaway
// root laid out like a Docker node (builtin-apps/ from the image, an old install on the data volume).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateInstalledApps, sha256, VERSIONS_FILE } from '../lib/builtin-app-update.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, waitFor } from './helpers-web.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '857c8f2';   // the commit the live private node's Bible matched
const atRev = (rev, p) => execFileSync('git', ['show', `${rev}:${p}`], { cwd: REPO });
const put = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const known = () => JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8'));
const hasGitHistory = (() => { try { atRev(OLD, 'workspace/apps/bible/index.html'); return true; } catch { return false; } })();

test('the versions manifest lists every tracked built-in page (regenerate with tools/gen-builtin-app-versions.mjs)', () => {
  const k = known();
  for (const root of ['workspace/apps', 'workspace.example/apps', 'shared-apps']) {
    for (const slug of fs.readdirSync(path.join(REPO, root))) {
      const f = path.join(REPO, root, slug, 'index.html');
      if (fs.existsSync(f)) assert.ok((k[slug] || []).includes(sha256(fs.readFileSync(f))), `${root}/${slug} is missing from lib/builtin-app-versions.json`);
    }
  }
});

test('the shelf Bible carries F2-03 like the owner copy, and its manifest matches the file', () => {
  assert.equal(sha256(fs.readFileSync(path.join(REPO, 'shared-apps/bible/index.html'))), sha256(fs.readFileSync(path.join(REPO, 'workspace/apps/bible/index.html'))));
  assert.match(fs.readFileSync(path.join(REPO, 'shared-apps/bible/index.html'), 'utf8'), /id="end-next"|end-next/);
});

test('updateInstalledApps: a known old page is replaced; an edited one, a missing one and data are left alone', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-bau-'));
  try {
    put(path.join(d, 'src/bible/index.html'), 'NEW'); put(path.join(d, 'src/notes/index.html'), 'NEW-N'); put(path.join(d, 'src/tasks/index.html'), 'NEW-T');
    put(path.join(d, 'dst/bible/index.html'), 'OLD'); put(path.join(d, 'dst/bible/meta.json'), JSON.stringify({ title: 'Mine', files: { 'index.html': 'x' } }));
    put(path.join(d, 'dst/bible/data.json'), '{"keep":1}');
    put(path.join(d, 'dst/notes/index.html'), 'MY EDIT');
    const r = updateInstalledApps(path.join(d, 'src'), path.join(d, 'dst'), { bible: [sha256('OLD')], notes: [sha256('OLD-N')] });
    assert.deepEqual(r, { updated: ['bible'], edited: ['notes'], current: [] });
    assert.equal(fs.readFileSync(path.join(d, 'dst/bible/index.html'), 'utf8'), 'NEW');
    const meta = JSON.parse(fs.readFileSync(path.join(d, 'dst/bible/meta.json'), 'utf8'));
    assert.equal(meta.title, 'Mine', 'user meta fields kept');
    assert.notEqual(meta.files['index.html'], 'x', 'manifest refreshed');
    assert.equal(fs.readFileSync(path.join(d, 'dst/bible/data.json'), 'utf8'), '{"keep":1}');
    assert.equal(fs.readFileSync(path.join(d, 'dst/notes/index.html'), 'utf8'), 'MY EDIT', 'an edited app is never overwritten');
    assert.equal(fs.existsSync(path.join(d, 'dst/tasks')), false, 'an app the user does not have is not added');
    assert.deepEqual(updateInstalledApps(path.join(d, 'src'), path.join(d, 'dst'), {}).current, ['bible'], 'second run: nothing to do');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('real start-up on a Docker-shaped root: the old 857c8f2 Bible (owner + shelf) becomes the current one; notes and an edited app survive',
  { skip: !hasGitHistory && 'needs git history', timeout: 60000 }, async () => {
    const port = await freePort(); const root = mkWebRoot({ port });
    const cur = fs.readFileSync(path.join(REPO, 'workspace/apps/bible/index.html'));
    put(path.join(root, 'builtin-apps/workspace-apps/bible/index.html'), cur);
    put(path.join(root, 'builtin-apps/workspace-apps/notes/index.html'), fs.readFileSync(path.join(REPO, 'workspace/apps/notes/index.html')));
    put(path.join(root, 'builtin-apps/shared-apps/bible/index.html'), fs.readFileSync(path.join(REPO, 'shared-apps/bible/index.html')));
    const own = path.join(root, 'workspace/apps');
    put(path.join(own, 'bible/index.html'), atRev(OLD, 'workspace/apps/bible/index.html'));
    put(path.join(own, 'bible/meta.json'), atRev(OLD, 'workspace/apps/bible/meta.json'));
    put(path.join(own, 'notes/index.html'), '<!doctype html><p>my own notes app</p>');
    const note = path.join(root, 'workspace/data/bible/notes/1-1.json'); put(note, '{"notes":{"v1":"mine"}}');
    put(path.join(root, 'shared-apps/bible/index.html'), atRev(OLD, 'shared-apps/bible/index.html'));
    put(path.join(root, 'shared-apps/bible/meta.json'), JSON.stringify({ title: 'Bible 圣经', sharedBy: 'owner', files: { 'index.html': 'stale' } }));
    assert.doesNotMatch(fs.readFileSync(path.join(own, 'bible/index.html'), 'utf8'), /end-next/, 'CONTROL (R14): the old copy really lacks F2-03');
    const web = startWeb(root);
    try {
      await waitReady(port);
      await waitFor(() => sha256(fs.readFileSync(path.join(own, 'bible/index.html'))) === sha256(cur), 'owner Bible updated');
      assert.match(fs.readFileSync(path.join(own, 'bible/index.html'), 'utf8'), /end-next/);
      assert.match(fs.readFileSync(path.join(root, 'shared-apps/bible/index.html'), 'utf8'), /end-next/, 'shelf copy updated');
      const meta = JSON.parse(fs.readFileSync(path.join(root, 'shared-apps/bible/meta.json'), 'utf8'));
      assert.equal(meta.sharedBy, 'owner'); assert.notEqual(meta.files['index.html'], 'stale');
      assert.equal(fs.readFileSync(note, 'utf8'), '{"notes":{"v1":"mine"}}', 'user data untouched');
      assert.match(fs.readFileSync(path.join(own, 'notes/index.html'), 'utf8'), /my own notes app/, 'an edited app is kept');
      const res = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
      assert.ok(res, 'node is serving');
    } finally { await stopWeb(web); fs.rmSync(root, { recursive: true, force: true }); }
  });

// Members too (2026-11-23): a member's workspace-<id>/apps was seeded from workspace.example and kept its
// old Bible for ever. Same rule as the owner: a known repo version is replaced from the image's member
// template; an edited page, an app the template does not ship and data/ are never touched.
test('real start-up: an owner and two members — the unedited member Bible is updated, the edited one and all data are kept',
  { skip: !hasGitHistory && 'needs git history', timeout: 60000 }, async () => {
    const port = await freePort();
    const users = [{ id: 'owner', name: 'Owner', role: 'owner', token: 'test-owner-token-abcdefgh', workspace: 'workspace' },
      { id: 'amy', name: 'Amy', role: 'member', token: 'test-amy-token-abcdefghij', workspace: 'workspace-amy' },
      { id: 'ben', name: 'Ben', role: 'member', token: 'test-ben-token-abcdefghij', workspace: 'workspace-ben' }];
    const root = mkWebRoot({ port, extraConfig: { users } });
    const tpl = fs.readFileSync(path.join(REPO, 'workspace.example/apps/bible/index.html'));
    const cur = fs.readFileSync(path.join(REPO, 'workspace/apps/bible/index.html'));
    put(path.join(root, 'builtin-apps/workspace-apps/bible/index.html'), cur);
    put(path.join(root, 'workspace.example/apps/bible/index.html'), tpl);              // the image's member template
    const old = atRev(OLD, 'workspace.example/apps/bible/index.html');
    put(path.join(root, 'workspace/apps/bible/index.html'), atRev(OLD, 'workspace/apps/bible/index.html'));
    const amy = path.join(root, 'workspace-amy'), ben = path.join(root, 'workspace-ben');
    for (const w of [amy, ben]) put(path.join(w, 'memory', '.keep'), '');
    put(path.join(amy, 'apps/bible/index.html'), old);
    put(path.join(amy, 'apps/mine/index.html'), '<p>amy built this</p>');           // not a built-in: never touched
    const amyNote = path.join(amy, 'data/bible/notes/43-3.json'); put(amyNote, '{"notes":{"v16":"amy"}}');
    const benPage = Buffer.concat([old, Buffer.from('\n<!-- ben edited -->')]);
    put(path.join(ben, 'apps/bible/index.html'), benPage);
    const benNote = path.join(ben, 'data/bible/notes/1-1.json'); put(benNote, '{"notes":{"v1":"ben"}}');
    assert.ok(known().bible.includes(sha256(old)), 'CONTROL (R14): amy\'s copy is a known repo version');
    assert.notEqual(sha256(old), sha256(tpl), 'CONTROL (R14): amy\'s copy really is old');
    const web = startWeb(root);
    try {
      await waitReady(port);
      await waitFor(() => sha256(fs.readFileSync(path.join(amy, 'apps/bible/index.html'))) === sha256(tpl), 'member amy\'s Bible updated');
      assert.equal(sha256(fs.readFileSync(path.join(root, 'workspace/apps/bible/index.html'))), sha256(cur), 'owner still updated');
      assert.deepEqual(fs.readFileSync(path.join(ben, 'apps/bible/index.html')), benPage, 'member ben\'s edited Bible is kept');
      assert.equal(fs.readFileSync(path.join(amy, 'apps/mine/index.html'), 'utf8'), '<p>amy built this</p>');
      assert.equal(fs.readFileSync(amyNote, 'utf8'), '{"notes":{"v16":"amy"}}', 'amy\'s data untouched');
      assert.equal(fs.readFileSync(benNote, 'utf8'), '{"notes":{"v1":"ben"}}', 'ben\'s data untouched');
      const log = fs.readFileSync(path.join(root, 'audit.log'), 'utf8');
      assert.match(log, /builtin-apps-update[^\n]*workspace-ben[^\n]*"edited":\["bible"\]/, 'the kept edit is reported');
    } finally { await stopWeb(web); fs.rmSync(root, { recursive: true, force: true }); }
  });
