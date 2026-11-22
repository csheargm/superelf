// deploy.sh against a LIVE node · 部署时节点仍在运行
//
// web.mjs and the agent keep running while deploy.sh fetches, installs and health-checks, and the
// node holds data git never sees. Each test stages one thing a live node really does (web.mjs
// commitShelf commits to main, the agent edits a tracked app, a git command holds index.lock, an
// ignored file becomes tracked upstream, a second deploy, a stray process on the port) and pins
// that deploy.sh neither loses it nor claims a rollback or a deploy that did not happen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, git, put } from './helpers-deploy-sandbox.mjs';
import { needPosixOps, needFlock } from './helpers-platform.mjs';

const opt = { skip: needPosixOps };
const APP = 'workspace/apps/x/index.html';
const read = (w, f) => fs.readFileSync(path.join(w.node, f), 'utf8');

test('an ignored node file that origin/main starts tracking: refused, its bytes untouched', opt, () => {
  const w = world();
  put(path.join(w.node, 'node-only/data.json'), 'NODE-ONLY PERSONAL DATA\n');
  const prev = w.head();
  w.ship({ '.gitignore': 'config.json\n', 'node-only/data.json': 'REPO COPY\n' }, 'feat: track data.json');
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /node-only\/data\.json[\s\S]*already exist/, 'CONTROL: the collision guard refused, naming the path');
  assert.equal(read(w, 'node-only/data.json'), 'NODE-ONLY PERSONAL DATA\n', 'the node copy is intact');
  assert.equal(w.head(), prev, 'nothing merged');
  assert.deepEqual(w.installs(), []);
});

test('the rollback cannot reset (index.lock held): exit 3, never "ROLLED BACK"', opt, () => {
  const w = world();
  const next = w.ship({ BROKEN: 'lock' }, 'feat: broken');
  const r = w.run();
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /index\.lock/, 'CONTROL: the reset failed on the lock, as staged');
  assert.match(r.out, /ROLLBACK FAILED/);
  assert.ok(!/ROLLED BACK|was rolled back/.test(r.out), 'no rollback is claimed');
  assert.equal(w.head(), next, 'HEAD really is still the bad commit, as reported');
  assert.equal(w.installs().length, 1, 'PREV was not re-installed on a tree that is not PREV');
});

test('the syntax gate fails and the reset cannot run: exit 3, not "rolled back before the service was touched"', opt, () => {
  const w = world();
  put(path.join(w.node, '.git/hooks/post-merge'), '#!/bin/bash\n: > .git/index.lock\n', 0o755);
  const next = w.ship({ 'lib/bad.mjs': 'export const = ;\n' }, 'feat: typo');
  const r = w.run();
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /SYNTAX ERROR: lib\/bad\.mjs/, 'CONTROL: the syntax gate caught it');
  assert.ok(!/was rolled back/.test(r.out), r.out);
  assert.equal(w.head(), next);
  assert.deepEqual(w.installs(), [], 'the service was still never touched');
});

test('the server commits to main during the deploy (a shelf promote): no reset, the commit is named, exit 3', opt, () => {
  const w = world();
  const next = w.ship({ BROKEN: 'shelf' }, 'feat: broken');
  const r = w.run();
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /shelf: promote s/, 'the commit made during the deploy is listed');
  assert.ok(!/ROLLED BACK/.test(r.out));
  assert.equal(git(w.node, 'log', '-1', '--format=%s'), 'shelf: promote s', 'still on the branch, not only in the reflog');
  assert.equal(git(w.node, 'rev-parse', 'HEAD~1'), next, 'CONTROL: it was made on top of the deployed commit');
  assert.equal(read(w, 'shared-apps/s/index.html'), '<p>s</p>\n');
});

test('the agent edits a tracked app during the deploy: the rollback keeps the edit', opt, () => {
  const w = world();
  const prev = w.head();
  w.ship({ BROKEN: 'edit' }, 'feat: broken');
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ROLLED BACK/);
  assert.equal(w.head(), prev, 'rolled back');
  assert.equal(read(w, APP), '<p>edited by the new server</p>\n', 'the live edit survives the rollback');
  assert.match(r.out, /kept[\s\S]*workspace\/apps\/x\/index\.html/, 'and the operator is told about it');
  assert.equal(w.installs().length, 2, 'CONTROL: PREV was re-installed');
});

test('an edit to an app the deploy also changed: the rollback refuses to clobber it, exit 3', opt, () => {
  const w = world();
  const next = w.ship({ BROKEN: 'edit', [APP]: '<p>v2 from the repo</p>\n' }, 'feat: broken, app v2');
  const r = w.run();
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /ROLLBACK FAILED/);
  assert.equal(read(w, APP), '<p>edited by the new server</p>\n', 'the live edit survives');
  assert.equal(w.head(), next, 'HEAD is reported where it is');
});

test('a deploy already running (the lock is held): refused before fetching', opt, () => {
  const w = world({ state: ['userbus', 'lock_held'] });
  const seen = w.tracking();
  w.ship({ 'lib/a.mjs': 'export const a = 9;\n' });
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /another deploy\.sh is running/);
  assert.match(w.calls(), /^flock -n 9$/m, 'CONTROL: the lock was asked for');
  assert.equal(w.tracking(), seen, 'nothing fetched');
  assert.deepEqual(w.installs(), []);
});

test('the real flock: a second deploy.sh on the same checkout is refused, a lone one runs', { skip: needPosixOps || needFlock }, () => {
  const w = world({ realFlock: true });
  const lone = w.run();
  assert.equal(lone.code, 0, `CONTROL: an uncontended lock is taken: ${lone.out}`);
  const lockfile = path.join(w.node, '.git/deploy.lock');
  assert.ok(fs.existsSync(lockfile), 'the lock lives in the git dir');
  const held = w.runWith([path.join(w.bin, 'flock'), lockfile], []);
  assert.equal(held.code, 1, held.out);
  assert.match(held.out, /another deploy\.sh is running/);
});

test('healthy only inside web.mjs\'s listen-retry window (a stray holds the port): not deployed', opt, () => {
  const w = world();
  const prev = w.head();
  w.ship({ BROKEN: 'retrywindow' }, 'feat: cannot bind');
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.ok(!/Deployed/.test(r.out), r.out);
  assert.equal(w.head(), prev);
  assert.equal(w.installs().length, 2);
});

test('active and 200, but the unit respawns between probes: a crash loop is not healthy', opt, () => {
  const w = world();
  const prev = w.head();
  w.ship({ BROKEN: 'crashloop' }, 'feat: crash loop');
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.ok(!/Deployed/.test(r.out), r.out);
  assert.match(w.calls(), /^systemctl --user show -p MainPID --value superelf-web$/m, 'CONTROL: the process identity was read');
  assert.equal(w.head(), prev);
});

test('shelf commits made by the server: the divergence refusal names them and how to carry them over', opt, () => {
  const w = world();
  put(path.join(w.node, 'shared-apps/s/index.html'), '<p>s</p>\n');
  git(w.node, 'add', '-A'); git(w.node, 'commit', '-qm', 'shelf: promote s');
  const local = w.head();
  w.ship({ 'lib/a.mjs': 'export const a = 10;\n' });
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /diverged/, 'CONTROL: the divergence guard refused');
  assert.match(r.out, /shelf: promote s/, 'the local commit is listed');
  assert.match(r.out, /shelf commits/);
  assert.match(r.out, /git format-patch origin\/main\.\.HEAD/);
  assert.equal(w.head(), local, 'untouched');
});
