// Each app is listed once · 每个应用只列一次 (F4-6, owner decision 2026-11-23).
// The drawer listed an app twice — under the Family shelf and again under Family Apps — and the owner's
// own shared apps showed in Family Apps as "by Owner (you)". Through the real server (R6):
// /api/family-apps leaves out the viewer's own apps and every app that is on the shelf.
// CONTROL (R14): another member's shared app that is not on the shelf is still listed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const KID = 'test-kid-token-family-once-012345';
let port, root, web;
const app = (ws, slug, title) => { const d = path.join(root, ws, 'apps', slug); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), '<p>x'); fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ title, shared: true })); };
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [
    { id: 'owner', name: 'Mom', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'kid', name: 'Kid', role: 'member', token: KID, workspace: 'workspace-kid' }] } });
  app('workspace', 'chores', 'Chores'); app('workspace', 'chart', 'Chart'); app('workspace-kid', 'quiz', 'Quiz');
  fs.mkdirSync(path.join(root, 'shared-apps', 'chart'), { recursive: true });   // "chart" is on the family shelf
  fs.writeFileSync(path.join(root, 'shared-apps', 'chart', 'index.html'), '<p>x');
  fs.writeFileSync(path.join(root, 'shared-apps', 'chart', 'meta.json'), JSON.stringify({ title: 'Chart', sharedBy: 'owner' }));
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (root) rmTemp(root); });
const list = async (tok) => (await (await fetch(`http://127.0.0.1:${port}/api/family-apps`, { headers: { authorization: `Bearer ${tok}` } })).json()).map((a) => a.slug).sort();

test('the owner\'s Family Apps: not their own, not the shelf\'s — only Kid\'s quiz', async () => {
  assert.deepEqual(await list(OWNER_TOKEN), ['quiz']);
});
test('a member\'s Family Apps: Mom\'s chores; chart is under the shelf; their own quiz is in My apps', async () => {
  assert.deepEqual(await list(KID), ['chores']);
  const apps = await (await fetch(`http://127.0.0.1:${port}/api/apps`, { headers: { authorization: `Bearer ${KID}` } })).json();
  assert.equal(apps.filter((a) => a.name === 'chart').length, 1, 'chart once, from the shelf');
  assert.equal(apps.find((a) => a.name === 'chart').uid, 'shared');
});
