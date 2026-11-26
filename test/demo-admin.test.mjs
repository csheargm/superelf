// Demo admin through the REAL web.mjs in demo mode (R6) · 演示管理接口集成测试 (ADR 0045).
// A stub Supabase signs tokens; a stub Ollama answers. Anonymous visitors, members and bad tokens get
// 404 from /api/demo/admin/*; the admin email (config) gets the summary with the visits, the member's
// email and their app counts; Reset clears only that network's visit rows and is audited; Delete my
// account removes the member's usage rows and email.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { startStubSupabase, listen } from './helpers-demo-sb.mjs';
import { AUTH_HEADER, sbUserId } from '../lib/demo-auth.mjs';
import { ADMIN_PATHS, DEMO_DELETE_PATH } from '../lib/demo.mjs';
import { USAGE_DIR } from '../lib/demo-usage.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'Owner@Example.org';
let sb, ollama, web, root, port;

before(async () => {
  sb = await startStubSupabase();
  ollama = await listen(http.createServer((req, res) => { req.resume(); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(JSON.stringify({ message: { role: 'assistant', content: 'ANSWER' }, done: true }) + '\n'); }); }));
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [], ollama_url: `http://127.0.0.1:${ollama.address().port}`,
    chat_models: [{ id: 'fast', label: 'Fast', provider: 'ollama', model: 'fake' }],
    demo: { enabled: true, behind_cloudflare: true, new_users_per_ip_per_day: 50, sessions_per_ip_per_day: 2, admin_emails: [ADMIN.toLowerCase()],
      auth: { supabase_url: sb.url, supabase_anon_key: 'public-anon', required: true } } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  web = startWeb(root); await waitReady(port);
});
after(async () => { await stopWeb(web); sb.srv.close(); ollama.close(); rmTemp(root); });

const call = (p, { token, sbToken, ip = '198.51.100.1', ...o } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...o, headers: {
  'content-type': 'application/json', 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(sbToken ? { [AUTH_HEADER]: sbToken } : {}) } });
const start = async (sbToken, ip) => (await call('/api/demo/start', { method: 'POST', sbToken, ip })).json();

test('non-admins get 404 from every admin path; the admin email gets the summary', async () => {
  const member = sb.jwt({ sub: 'member-1', email: 'm@example.org', user_metadata: { full_name: 'Mem Ber' } });
  const m = await start(member, '198.51.100.2');
  assert.ok(m.token);
  const r = await call('/api/chat', { method: 'POST', token: m.token, ip: '198.51.100.2', body: JSON.stringify({ message: 'hi', app: 'notes' }) });
  await r.text();
  await (await call(`/app/${m.uid}/notes/`, { ip: "198.51.100.2" })).text();   // the app page: counted as an open
  for (const p of [ADMIN_PATHS.me, ADMIN_PATHS.summary]) {
    assert.equal((await call(p)).status, 404, `anonymous ${p}`);
    assert.equal((await call(p, { sbToken: member })).status, 404, `member ${p}`);
    assert.equal((await call(p, { sbToken: 'not.a.jwt' })).status, 404, `bad token ${p}`);
  }
  assert.equal((await call(ADMIN_PATHS.reset, { method: 'POST', sbToken: member, body: '{"net":"00000000"}' })).status, 404);
  const admin = sb.jwt({ sub: 'owner-1', email: ADMIN });
  assert.equal((await call(ADMIN_PATHS.me, { sbToken: admin })).status, 200);
  const s = await (await call(`${ADMIN_PATHS.summary}?days=14`, { sbToken: admin })).json();
  assert.equal(s.ok, true); assert.equal(s.trend.length, 14);
  const p = s.people.find((x) => x.id === sbUserId('member-1'));
  assert.equal(p.email, 'm@example.org'); assert.equal(p.name, 'Mem Ber'); assert.equal(p.aiToday, 1);
  assert.equal(p.apps.notes.ai, 1); assert.ok(p.apps.notes.open >= 1, 'the app page open is counted');
  assert.ok(s.today.visits >= 1);
  const raw = fs.readdirSync(path.join(root, USAGE_DIR)).map((f) => fs.readFileSync(path.join(root, USAGE_DIR, f), 'utf8')).join('');
  assert.ok(!raw.includes('hi"') && !raw.includes('ANSWER') && !raw.includes('198.51.100'), 'no chat content, no IP');
  assert.ok(!JSON.stringify(s).includes('admin_emails'), 'the list never leaves the server');
});

test('Reset clears only that network\'s visit counters today, and is audited', async () => {
  const ip = '203.0.113.50';
  await call('/api/demo/start', { method: 'POST', ip }); await call('/api/demo/start', { method: 'POST', ip });
  assert.equal((await call('/api/demo/start', { method: 'POST', ip })).status, 429, 'the network is at the cap');
  const admin = sb.jwt({ sub: 'owner-1', email: ADMIN });
  const s = await (await call(ADMIN_PATHS.summary, { sbToken: admin })).json();
  const blocked = s.today.nets.filter((n) => n.blocked);
  assert.equal(blocked.length, 1);
  const others = s.today.nets.filter((n) => !n.blocked).map((n) => [n.net, n.visits]);
  const r = await (await call(ADMIN_PATHS.reset, { method: 'POST', sbToken: admin, body: JSON.stringify({ net: blocked[0].net }) })).json();
  assert.deepEqual(r, { ok: true, removed: 2 });
  assert.equal((await call('/api/demo/start', { method: 'POST', ip })).status, 200, 'the network may visit again');
  const after = await (await call(ADMIN_PATHS.summary, { sbToken: admin })).json();
  assert.deepEqual(after.today.nets.filter((n) => n.net !== blocked[0].net).map((n) => [n.net, n.visits]), others, 'other networks untouched');
  const audit = fs.readFileSync(path.join(root, 'audit.log'), 'utf8');
  assert.match(audit, new RegExp(`demo-admin-reset.*${blocked[0].net}`));
  assert.equal((await call(ADMIN_PATHS.reset, { method: 'POST', sbToken: admin, body: '{"net":"xyz"}' })).status, 400);
});

test('Delete my account removes the member\'s usage rows and kept email', async () => {
  const member = sb.jwt({ sub: 'member-del', email: 'del@example.org' });
  const m = await start(member, '198.51.100.9');
  await (await call('/api/chat', { method: 'POST', token: m.token, ip: '198.51.100.9', body: JSON.stringify({ message: 'x' }) })).text();
  const id = sbUserId('member-del'), dir = path.join(root, USAGE_DIR);
  const has = () => fs.readdirSync(dir).some((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(id));
  assert.ok(has());
  assert.equal((await call(DEMO_DELETE_PATH, { method: 'POST', token: m.token, ip: '198.51.100.9' })).status, 200);
  assert.ok(!has(), 'usage rows gone');
  assert.ok(!fs.readFileSync(path.join(root, 'demo-users.json'), 'utf8').includes('del@example.org'), 'email gone');
});
