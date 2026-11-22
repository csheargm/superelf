// App folders and a fork's source stay where they say · 应用目录与分叉来源不越界
//
// The app-shelf and fork routes' share of the workspace-write holes R13 found on 2026-10-13
// (ADR 0016; the app-data routes are test/workspace-write-paths):
//   - /api/apps/<slug>/update, the shelf's update check and the changelog joined
//     meta.forkedFrom.slug unchecked — the forker's own file — so `../data/evil` reached outside
//     the source user's apps/ (web.mjs forkSource now judges it: a string slug, an active account);
//   - a source app folder that IS a link, or reached through one, was copied as that link by the
//     share, the shelf fork, the peer fork and the update (refuseLinkedSource in lib/sharedapps.mjs
//     for the folder itself; lib/appdata.mjs noLinkOnTheWay, in web.mjs, for every part of the path);
//   - a peer fork copied a shared app's links (it copies through copyNoLinks now);
//   - the curated fork and the admin share answered a malformed request with Node's own message.
// Over HTTP on the real web.mjs (lane harness), plus the library calls where no request reaches
// them. R14: each refusal has a CONTROL that the same route really copies an ordinary app.
// Writes INTO an app folder, and links above one: test/app-folder-writes.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { copyNoLinks, promote, listShared, fork, FORK_REFUSED } from '../lib/sharedapps.mjs';
import { api, OWNER_TOKEN } from './helpers-web.mjs';
import { startLaneServer, LANE_USERS, MEMBER_TOKEN } from './helpers-agent-lane.mjs';

// The lane harness's accounts plus a PENDING one: an app shared from it must not be pulled into
// anyone's fork (forkSource requires an active source, as a peer fork does).
const USERS = [...LANE_USERS,
  { id: 'gone', name: 'Gone', role: 'member', status: 'pending', token: 'test-pending-token-0123456789abc', workspace: 'workspace-gone' }];
let L, KID;
before(async () => { L = await startLaneServer({ extraConfig: { users: USERS } }); KID = path.join(L.root, 'workspace-kid'); });
after(async () => { if (L) await L.stop(); });
const post = (route, body) => api(L.port, route, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
const asOwner = (route, body) => api(L.port, route, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${OWNER_TOKEN}` } });

// A peer fork (R13 round 1 on the fix): POST /api/apps/fork {fromUid} copied a member's shared app
// with fs.cpSync, symlinks and all — unlike a shelf fork, which copies through copyNoLinks. Now both
// do. CONTROL: the app's real file arrives.
test('a peer fork copies a shared app without its symlinks', async () => {
  const src = path.join(KID, 'apps', 'linky');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'index.html'), '<p>hi</p>');
  fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({ title: 'Linky', shared: true }));
  fs.symlinkSync(path.join(KID, 'profile.json'), path.join(src, 'link.json'));
  const r = await api(L.port, '/api/apps/fork', { method: 'POST', body: JSON.stringify({ fromUid: 'kid', slug: 'linky' }), headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
  assert.equal(r.status, 200, await r.text());
  const dst = path.join(L.root, 'workspace', 'apps', 'linky');
  assert.equal(fs.readFileSync(path.join(dst, 'index.html'), 'utf8'), '<p>hi</p>', 'CONTROL: the app was copied');
  assert.throws(() => fs.lstatSync(path.join(dst, 'link.json')), { code: 'ENOENT' }, 'the link was not');
});

// copyNoLinks copied an app folder that IS a symlink as that link, then walked through it, deleting
// links inside the sharer's real folder (and the fork's meta.json write went through it too).
test('copyNoLinks refuses a source folder that is itself a symlink, and touches nothing', () => {
  const dir = fs.mkdtempSync(path.join(L.root, 'cnl-'));
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'index.html'), 'x');
  fs.symlinkSync(path.join(real, 'index.html'), path.join(real, 'inner-link'));
  fs.symlinkSync(real, path.join(dir, 'app'), 'junction');
  assert.throws(() => copyNoLinks(path.join(dir, 'app'), path.join(dir, 'copy')), /link/);
  assert.ok(fs.lstatSync(path.join(real, 'inner-link')).isSymbolicLink(), 'the sharer\'s folder is untouched');
  assert.ok(!fs.existsSync(path.join(dir, 'copy')), 'no copy was made');
  copyNoLinks(real, path.join(dir, 'copy2'));
  assert.equal(fs.readFileSync(path.join(dir, 'copy2', 'index.html'), 'utf8'), 'x', 'CONTROL: a plain folder copies');
});

// promote archived the live shelf copy BEFORE copyNoLinks refused a linked source, so a failed share
// emptied the shelf entry. Now the source is judged first. CONTROL: a plain folder shares.
test('a share refused for a linked source leaves the live shelf copy in place', () => {
  const dir = fs.mkdtempSync(path.join(L.root, 'shelf-'));
  const shared = path.join(dir, 'shared'), real = path.join(dir, 'real');
  fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'index.html'), 'v1');
  promote(shared, 'myapp', real, 'owner');
  assert.deepEqual(listShared(shared).map((a) => a.name), ['myapp'], 'CONTROL: the plain folder shared');
  fs.symlinkSync(real, path.join(dir, 'linked'), 'junction');
  assert.throws(() => promote(shared, 'myapp', path.join(dir, 'linked'), 'owner'), /link/);
  assert.deepEqual(listShared(shared).map((a) => a.name), ['myapp'], 'the live shelf copy is still there');
});

// /api/apps/<slug>/update joined meta.forkedFrom.slug unchecked. That file is the forker's own (their
// agent can edit it), so `../data/evil` climbed out of the owner's apps/ into data/ that an app had
// written: the owner's files were copied into the member's app (reproduced). CONTROL: a real shared
// owner app updates through the same route.
test('an app update cannot follow a forkedFrom slug out of the source app folder', async () => {
  const ownerWs = path.join(L.root, 'workspace');
  const evil = path.join(ownerWs, 'data', 'evil');
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'meta.json'), '{"shared":true,"version":"9.0.0"}');
  fs.writeFileSync(path.join(evil, 'dump.json'), '{"secret":"owner"}');
  const mine = path.join(KID, 'apps', 'mine');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'index.html'), 'v1');
  fs.writeFileSync(path.join(mine, 'meta.json'), JSON.stringify({ forkedFrom: { uid: 'owner', slug: '../data/evil', version: '1.0.0' } }));
  const r = await post('/api/apps/mine/update', {});
  assert.equal(r.status, 400, await r.text());
  assert.ok(!fs.existsSync(path.join(mine, 'dump.json')), 'nothing of the owner\'s was copied');
  // The shelf's update check reads the same forkSource: it offers no update from that folder.
  const shelf = async () => (await (await api(L.port, '/api/apps', { headers: { authorization: `Bearer ${MEMBER_TOKEN}` } })).json()).find((a) => a.name === 'mine');
  assert.equal((await shelf()).hasUpdate, false, 'no update offered from ../data/evil');
  // A slug that is not a string (an array) is no fork: the member's shelf still loads.
  fs.writeFileSync(path.join(mine, 'meta.json'), JSON.stringify({ forkedFrom: { uid: 'owner', slug: ['shared-one'] } }));
  assert.equal((await shelf()).hasUpdate, false, 'the shelf answered');
  const real = path.join(ownerWs, 'apps', 'shared-one');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'index.html'), 'v2');
  fs.writeFileSync(path.join(real, 'meta.json'), JSON.stringify({ shared: true, version: '2.0.0' }));
  fs.writeFileSync(path.join(mine, 'meta.json'), JSON.stringify({ forkedFrom: { uid: 'owner', slug: 'shared-one' } }));
  const ok = await post('/api/apps/mine/update', {});
  assert.equal(ok.status, 200, await ok.text());
  assert.equal(fs.readFileSync(path.join(mine, 'index.html'), 'utf8'), 'v2', 'CONTROL: the update copied the source');
  // CONTROL for the shelf check: once the source publishes a new version, the shelf offers it.
  fs.writeFileSync(path.join(real, 'meta.json'), JSON.stringify({ shared: true, version: '2.1.0' }));
  assert.equal((await shelf()).hasUpdate, true, 'CONTROL: a real fork is offered its update');
});

test('an update from an account that is not active is refused', async () => {
  const old = path.join(L.root, 'workspace-gone', 'apps', 'old');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'index.html'), 'GONE');
  fs.writeFileSync(path.join(old, 'meta.json'), JSON.stringify({ shared: true, version: '3.0.0' }));
  const mine = path.join(KID, 'apps', 'mine2');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'index.html'), 'v1');
  fs.writeFileSync(path.join(mine, 'meta.json'), JSON.stringify({ forkedFrom: { uid: 'gone', slug: 'old', version: '1.0.0' } }));
  const r = await post('/api/apps/mine2/update', {});
  assert.equal(r.status, 404, await r.text());
  assert.equal(fs.readFileSync(path.join(mine, 'index.html'), 'utf8'), 'v1', 'nothing was pulled from the pending account');
});

// The peer fork's link refusal over HTTP (round 3 added it; no request drove it).
test('a peer fork of an app folder that is a link answers 400 and copies nothing', async () => {
  const real = fs.mkdtempSync(path.join(L.root, 'linked-app-'));
  fs.writeFileSync(path.join(real, 'index.html'), 'x');
  fs.writeFileSync(path.join(real, 'meta.json'), JSON.stringify({ shared: true }));
  fs.mkdirSync(path.join(KID, 'apps'), { recursive: true });
  fs.symlinkSync(real, path.join(KID, 'apps', 'linkapp'), 'junction');
  const r = await api(L.port, '/api/apps/fork', { method: 'POST', body: JSON.stringify({ fromUid: 'kid', slug: 'linkapp' }), headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
  assert.equal(r.status, 400, await r.text());
  assert.ok(!fs.existsSync(path.join(L.root, 'workspace', 'apps', 'linkapp')), 'no copy was made');
});

// A shelf fork's own refusals carry FORK_REFUSED, so the route answers them 400 and anything else 500.
test('the shelf fork marks its own refusals, and the route answers them 400', async () => {
  const dir = fs.mkdtempSync(path.join(L.root, 'shelf2-'));
  for (const slug of ['..', 'missing']) assert.throws(() => fork(dir, slug, dir), (e) => e.code === FORK_REFUSED, slug);
  for (const slug of ['missing-app', '..', '']) {
    const r = await api(L.port, '/api/apps/fork', { method: 'POST', body: JSON.stringify({ slug }), headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    assert.equal(r.status, 400, `${JSON.stringify(slug)}: ${await r.text()}`);
  }
});

// An update read its source app folder through a link (readdirSync follows it): the owner's
// apps/linked -> data/foo copied data/foo's files into the member's fork (reproduced). It now
// refuses a linked source as every other copy of an app folder does. CONTROL: the shared-one
// update in the forkedFrom test above copies through the same route.
test('an update refuses a source app folder that is a link', async () => {
  const ownerWs = path.join(L.root, 'workspace');
  const real = path.join(ownerWs, 'data', 'foo');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'meta.json'), JSON.stringify({ shared: true, version: '1.0.0' }));
  fs.writeFileSync(path.join(real, 'secret.json'), '{"secret":"owner"}');
  fs.mkdirSync(path.join(ownerWs, 'apps'), { recursive: true });
  fs.symlinkSync(real, path.join(ownerWs, 'apps', 'linked'), 'junction');
  const mine = path.join(KID, 'apps', 'mine3');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'index.html'), 'v1');
  fs.writeFileSync(path.join(mine, 'meta.json'), JSON.stringify({ forkedFrom: { uid: 'owner', slug: 'linked' } }));
  const r = await post('/api/apps/mine3/update', {});
  assert.equal(r.status, 400, await r.text());
  assert.ok(!fs.existsSync(path.join(mine, 'secret.json')), 'nothing was copied through the link');
});

// The admin share checked slugOk(String(slug)) and joined the raw value: an array slug answered
// 400 with Node's own message. Now it is "bad user or slug". CONTROL: a real app shares.
test('the admin share takes only a string slug', async () => {
  for (const slug of [['shared-one'], 7]) {
    const r = await asOwner('/api/admin/share', { from: 'owner', slug });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /bad user or slug/, JSON.stringify(slug));
  }
  const app = path.join(L.root, 'workspace', 'apps', 'to-share');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), 'x');
  const ok = await asOwner('/api/admin/share', { from: 'owner', slug: 'to-share' });
  assert.equal(ok.status, 200, `CONTROL: ${await ok.text()}`);
});
