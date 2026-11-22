// Writes INTO an app folder, and links above one · 写入应用目录与其上层链接
//
// The destination side of the workspace-write holes R13 found on 2026-10-13 (ADR 0016; the source
// side and a fork's source are test/app-fork-paths, the app-data routes test/workspace-write-paths):
//   - the update copied into the member's app folder and the bump wrote meta.json with calls that
//     follow a link at the file, and every write into apps/<slug>/ followed a link at the folder;
//   - a link at apps/ ABOVE the folder (a member's apps/ pointing at the owner's) took the update,
//     the bump, the share toggle, the delete, the forks and the admin share to the owner's apps.
// web.mjs ownAppDir and lib/appdata.mjs noLinkOnTheWay judge every part of the path; every write
// into an app folder goes through writeFileAtomic. Over HTTP on the real web.mjs (lane harness).
// R14: each refusal has a CONTROL that the same route really writes, copies or deletes an ordinary app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { api, OWNER_TOKEN } from './helpers-web.mjs';
import { startLaneServer, LANE_USERS, MEMBER_TOKEN } from './helpers-agent-lane.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const KID2_TOKEN = 'test-member2-token-0123456789abc';   // a second member, whose apps/ folder a test turns into a link
const USERS = [...LANE_USERS, { id: 'kid2', name: 'Kid2', role: 'member', token: KID2_TOKEN, workspace: 'workspace-kid2' }];
let L, KID;
const post = (route, body) => api(L.port, route, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
const asOwner = (route, body) => api(L.port, route, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
// The fixtures every test here may use: the owner's shared dst-src (a fork source) and to-share,
// also put on the shelf, so no test depends on another file's or another test's leftovers.
before(async () => {
  L = await startLaneServer({ extraConfig: { users: USERS } });
  KID = path.join(L.root, 'workspace-kid');
  fs.mkdirSync(path.join(KID, 'apps'), { recursive: true });   // the member's apps/, which tests plant links in
  for (const [slug, body] of [['dst-src', 'FROM-SOURCE'], ['to-share', 'SHELF']]) {
    const app = path.join(L.root, 'workspace', 'apps', slug);
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'index.html'), body);
    fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ shared: true, version: '1.0.0' }));
  }
  const r = await asOwner('/api/admin/share', { from: 'owner', slug: 'to-share' });
  assert.equal(r.status, 200, `fixture: to-share on the shelf: ${await r.text()}`);
});
after(async () => { if (L) await L.stop(); });

// CONTROL for the shelf-fork refusal below: a member forks a shelf app into their own apps/.
test('a member forks a shelf app into their own apps/', async () => {
  const r = await post('/api/apps/fork', { slug: 'to-share' });
  assert.equal(r.status, 200, await r.text());
  assert.equal(fs.readFileSync(path.join(KID, 'apps', 'to-share', 'index.html'), 'utf8'), 'SHELF');
});

// The DESTINATION side (R13 round 13 on the base branch, 2026-10-13): an update copied into the
// member's app folder with copyFileSync and a bump wrote meta.json with writeFileSync — both follow
// a link at the file — and every write into apps/<slug>/ followed a link at the folder itself. So a
// link at apps/f/index.html carried the update's bytes over its target (the owner's profile.json in
// the reproduction). Writes now go through writeFileAtomic, whose rename replaces a link instead of
// following it, and a linked app folder is refused. CONTROL: each file arrives as a plain file.
test('an update writes into the member\'s app folder, never through a link in it', async () => {
  const victim = path.join(L.root, 'victim.txt');
  fs.writeFileSync(victim, 'SAFE');
  const mine = path.join(KID, 'apps', 'f');
  fs.mkdirSync(mine, { recursive: true });
  fs.symlinkSync(victim, path.join(mine, 'index.html'));
  fs.writeFileSync(path.join(mine, 'meta.json'), JSON.stringify({ forkedFrom: { uid: 'owner', slug: 'dst-src' } }));
  const r = await post('/api/apps/f/update', {});
  assert.equal(r.status, 200, await r.text());
  assert.equal(fs.readFileSync(victim, 'utf8'), 'SAFE', 'the link\'s target is untouched');
  assert.ok(!fs.lstatSync(path.join(mine, 'index.html')).isSymbolicLink(), 'the file replaced the link');
  assert.equal(fs.readFileSync(path.join(mine, 'index.html'), 'utf8'), 'FROM-SOURCE', 'CONTROL: the update copied');
});

test('an app folder that is a link is refused by the update, the bump and the share toggle', async () => {
  const target = fs.mkdtempSync(path.join(L.root, 'tgt-'));
  fs.writeFileSync(path.join(target, 'meta.json'), JSON.stringify({ shared: true, version: '1.0.0', forkedFrom: { uid: 'owner', slug: 'dst-src' } }));
  fs.symlinkSync(target, path.join(KID, 'apps', 'g'), 'junction');
  const before = fs.readFileSync(path.join(target, 'meta.json'), 'utf8');
  const tries = [['POST', '/api/apps/g/update'], ['POST', '/api/apps/g/bump'], ['PATCH', '/api/apps/g/share']];
  for (const [method, route] of tries) {
    const r = await api(L.port, route, { method, body: JSON.stringify({ shared: false }), headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
    assert.equal(r.status, 400, `${method} ${route}: ${await r.text()}`);
  }
  assert.equal(fs.readFileSync(path.join(target, 'meta.json'), 'utf8'), before, 'nothing was written through the folder link');
  assert.ok(!fs.existsSync(path.join(target, 'index.html')), 'and no file was copied there');
});

test('a bump replaces a meta.json that is a link instead of writing through it', async () => {
  const victim = path.join(L.root, 'victim-meta.json');
  fs.writeFileSync(victim, JSON.stringify({ shared: true, version: '1.0.0' }));
  const app = path.join(KID, 'apps', 'bumped');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), 'x');
  fs.symlinkSync(victim, path.join(app, 'meta.json'));
  const r = await post('/api/apps/bumped/bump', {});
  assert.equal(r.status, 200, await r.text());
  assert.equal(JSON.parse(fs.readFileSync(victim, 'utf8')).version, '1.0.0', 'the link\'s target is untouched');
  assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'meta.json'), 'utf8')).version, '1.0.1', 'CONTROL: the bump happened');
});

// The update's own meta.json write went through a link at it (R13 round 9 on the fix: no test
// pinned it). CONTROL: the update happened and meta.json is a plain file.
test('an update replaces a meta.json that is a link instead of writing through it', async () => {
  const victim = path.join(L.root, 'victim-forkmeta.json');
  const forked = JSON.stringify({ forkedFrom: { uid: 'owner', slug: 'dst-src' } });
  fs.writeFileSync(victim, forked);
  const mine = path.join(KID, 'apps', 'f2');
  fs.mkdirSync(mine, { recursive: true });
  fs.symlinkSync(victim, path.join(mine, 'meta.json'));
  const r = await post('/api/apps/f2/update', {});
  assert.equal(r.status, 200, await r.text());
  assert.equal(fs.readFileSync(victim, 'utf8'), forked, 'the link\'s target is untouched');
  assert.ok(!fs.lstatSync(path.join(mine, 'meta.json')).isSymbolicLink(), 'CONTROL: meta.json is a plain file now');
});

// A link ABOVE the app folder: a member's apps/ itself (R13 round 9 on the fix). Planted here as a
// link to the owner's apps/, the bump, the share toggle and the delete reached the owner's app, and
// a peer fork from that member read through it (reproduced). Now every part of the path is judged.
test('a link at apps/ itself is refused for writes, deletes and as a fork source', async () => {
  const ownerApps = path.join(L.root, 'workspace', 'apps');
  const owned = path.join(ownerApps, 'owned');
  fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(path.join(owned, 'index.html'), 'OWNER');
  fs.writeFileSync(path.join(owned, 'meta.json'), JSON.stringify({ shared: true, version: '1.0.0' }));
  const kid2 = path.join(L.root, 'workspace-kid2');
  fs.mkdirSync(kid2, { recursive: true });
  fs.rmSync(path.join(kid2, 'apps'), { recursive: true, force: true });   // test semantics inside a sandbox, not temp-dir cleanup
  fs.symlinkSync(ownerApps, path.join(kid2, 'apps'), 'junction');
  const before = fs.readFileSync(path.join(owned, 'meta.json'), 'utf8');
  const as2 = (method, route, body = {}) => api(L.port, route, { method, body: JSON.stringify(body), headers: { authorization: `Bearer ${KID2_TOKEN}` } });
  for (const [method, route, body] of [['POST', '/api/apps/owned/bump'], ['PATCH', '/api/apps/owned/share', { shared: false }], ['DELETE', '/api/apps/owned']]) {
    const r = await as2(method, route, body);
    assert.equal(r.status, 400, `${method} ${route}: ${await r.text()}`);
  }
  assert.equal(fs.readFileSync(path.join(owned, 'meta.json'), 'utf8'), before, 'the owner\'s app is unchanged');
  assert.ok(fs.existsSync(path.join(owned, 'index.html')), 'and not deleted');
  const f = await asOwner('/api/apps/fork', { fromUid: 'kid2', slug: 'owned' });
  assert.equal(f.status, 400, `a peer fork from kid2 reads through the link: ${await f.text()}`);
  // R13 round 10: the admin share {from: kid2} would have shelved the owner's app, and kid2's own forks
  // (curated: to-share; peer: kid's pubk) would have created into the owner's apps/ through the link.
  const sh = await asOwner('/api/admin/share', { from: 'kid2', slug: 'owned' });
  assert.equal(sh.status, 400, `the admin share reads through kid2's link: ${await sh.text()}`);
  const pubk = path.join(KID, 'apps', 'pubk');
  fs.mkdirSync(pubk, { recursive: true });
  fs.writeFileSync(path.join(pubk, 'index.html'), 'K');
  fs.writeFileSync(path.join(pubk, 'meta.json'), JSON.stringify({ shared: true }));
  for (const body of [{ slug: 'to-share' }, { fromUid: 'kid', slug: 'pubk' }]) {
    const r = await as2('POST', '/api/apps/fork', body);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /app folder is a link/, `${JSON.stringify(body)}: refused for the link, not for another reason`);
  }
  assert.ok(!fs.existsSync(path.join(ownerApps, 'to-share-mine')) && !fs.existsSync(path.join(ownerApps, 'pubk')), 'nothing was created in the owner\'s apps/');
});

// CONTROL for the delete refusal above: a member deletes an ordinary app of their own.
test('a member deletes an ordinary app of their own', async () => {
  const app = path.join(KID, 'apps', 'gone-soon');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), 'x');
  const r = await api(L.port, '/api/apps/gone-soon', { method: 'DELETE', headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
  assert.equal(r.status, 200, await r.text());
  assert.ok(!fs.existsSync(app), 'the folder is gone');
});
