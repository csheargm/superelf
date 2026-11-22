#!/usr/bin/env node
// Local API smoke test — hits only 127.0.0.1, never egresses. Run: node smoke.mjs
import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const OWNER = cfg.users[0].token;
const BASE = `http://127.0.0.1:${cfg.web_port || 8787}`;
const j = async (r) => { try { return await r.json(); } catch { return null; } }
const post = (p, body, tok) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
const get = (p, tok) => fetch(BASE + p, { headers: tok ? { authorization: 'Bearer ' + tok } : {} });
const del = (p, tok) => fetch(BASE + p, { method: 'DELETE', headers: { authorization: 'Bearer ' + tok } });

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

try {
  const boot = await j(await post('/api/login', { token: OWNER }));
  ok('owner bootstrap login', boot?.ok && boot.role === 'owner');
  const OS = boot.token;
  ok('session ping returns role', (await j(await get('/api/ping', OS)))?.role === 'owner');

  const reg = await j(await post('/api/register', { username: 'smoke1', name: 'Smoke', password: '4242' }));
  ok('self-register auto-approves + session', reg?.ok && reg.token);
  ok('login with username+PIN', (await j(await post('/api/login', { username: 'smoke1', password: '4242' })))?.ok);
  ok('wrong PIN rejected', (await post('/api/login', { username: 'smoke1', password: '0000' })).status === 401);

  const es = (await j(await post('/api/login', { username: 'smoke1', password: '4242' }))).token;
  ok('member blocked from admin', (await get('/api/admin/audit', es)).status === 403);
  ok('member sees no owner data', (await j(await get('/api/convos', es)))?.length === 0);
  ok('owner audit log records events', Array.isArray(await j(await get('/api/admin/audit', OS))));
  ok('traversal blocked', (await get('/api/data/..%2f..%2fconfig.json', es)).status === 400);

  await del('/api/admin/users/smoke1', OS);
  // Admin delete SOFT-deletes (renames workspace-smoke1 -> workspace-smoke1.deleted-<ts>),
  // so remove by prefix — an exact 'workspace-smoke1' rmSync misses the rename and leaks a
  // dir every run. (Mirrors the workspace-ghost cleanup below.)
  for (const d of fs.readdirSync('.')) if (d.startsWith('workspace-smoke1')) fs.rmSync(d, { recursive: true, force: true });
  ok('deleted member session revoked', (await get('/api/ping', es)).status === 401);

  // --- delete→re-register must NOT inherit data (tombstone) ---
  const r1 = await j(await post('/api/register', { username: 'ghost', name: 'Ghost', password: '5555' }));
  const g1 = r1.token;
  await post('/api/chat', { message: 'remember the secret is 42' }, g1); // creates a convo in ghost's ws
  await del('/api/admin/users/ghost', OS);
  const r2 = await j(await post('/api/register', { username: 'ghost', name: 'Ghost2', password: '6666' }));
  const g2 = r2.token;
  ok('re-registered username inherits NO old data', (await j(await get('/api/convos', g2)))?.length === 0);
  await del('/api/admin/users/ghost', OS);
  // clean tombstones
  for (const d of fs.readdirSync('.')) if (d.startsWith('workspace-ghost')) fs.rmSync(d, { recursive: true, force: true });

  // --- app dir must not serve data files ---
  fs.mkdirSync('workspace/apps/leaky', { recursive: true });
  fs.writeFileSync('workspace/apps/leaky/index.html', '<h1>ok</h1>');
  fs.writeFileSync('workspace/apps/leaky/secret.json', '{"private":true}');
  ok('app html served', (await get('/app/owner/leaky/')).status === 200);
  ok('app data file NOT served', (await get('/app/owner/leaky/secret.json')).status === 404);
  fs.rmSync('workspace/apps/leaky', { recursive: true, force: true });

} catch (e) {
  console.error('smoke error:', e.message); fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
