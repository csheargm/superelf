// The public demo node, as a visitor meets it (lib/demo.mjs, lib/demo-routes.mjs, lib/demo-quota.mjs):
// the REAL web.mjs in demo mode, with only Ollama and the claude CLI faked. A visitor is signed in
// anonymously, chats on an Ollama lane, hits the daily AI cap and is told so in EN + 中文; the
// agent lane, sign-in, admin and every unlisted route are refused; the disk cap refuses writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { QUOTA_MESSAGES } from '../lib/demo-quota.mjs';
import { DEMO_REFUSED, DEMO_COOKIE } from '../lib/demo.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = [
  { id: 'fast', label: 'Fast', group: 'Fast', provider: 'ollama', model: 'fake-fast' },
  { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', model: null },
];
const DEMO = { enabled: true, auth: { required: false }, behind_cloudflare: true, reply_max_kb: 1, ai_calls_per_user_per_day: 2, ai_calls_per_ip_per_day: 100, new_users_per_ip_per_day: 3, user_disk_mb: 1, total_disk_gb: 5 };

function startOllamaStub() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }).on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (b.includes('LONGREPLY')) { for (let i = 0; i < 20; i++) res.write(JSON.stringify({ message: { role: 'assistant', content: 'y'.repeat(200) }, done: false }) + '\n'); return res.end(JSON.stringify({ done: true }) + '\n'); }
      if (b.includes('CUTOFF')) return res.end(JSON.stringify({ message: { role: 'assistant', content: 'half' }, done: false }) + '\n');
      if (b.includes('SLOW')) return setTimeout(() => res.end(JSON.stringify({ message: { role: 'assistant', content: 'FAST-ANSWER' }, done: true }) + '\n'), 600);
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'FAST-ANSWER' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

let ollama, web, root, port, spawnLog, ipSeq = 0;
before(async () => {
  ollama = await startOllamaStub();
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [], demo: DEMO, ollama_url: `http://127.0.0.1:${ollama.address().port}`, chat_models: MODELS } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  spawnLog = path.join(root, 'spawns.log');
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', `#!/bin/sh\necho spawned >> "${spawnLog}"\necho '{"type":"result","subtype":"success","result":"AGENT"}'\n`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root); await waitReady(port);
});
after(async () => { await stopWeb(web); ollama.close(); rmTemp(root); });

const req = (p, { token, ip, cookie, ...opts } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...opts, headers: {
  'content-type': 'application/json', 'cf-connecting-ip': ip || '203.0.113.1',
  ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) } });
async function visit(ip = `198.51.100.${++ipSeq}`, cookie) {
  const r = await req('/api/demo/start', { method: 'POST', ip, cookie });
  const j = await r.json();
  return { r, j, ip, token: j.token, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const chat = (v, body) => req('/api/chat', { method: 'POST', token: v.token, ip: v.ip, body: JSON.stringify(body) });
const lines = async (r) => (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const spawned = () => fs.existsSync(spawnLog);

test('the shell boots a visitor in: anonymous session, seeded apps, own cookie brings them back', async () => {
  const shell = await (await req('/')).text();
  assert.match(shell, /\/api\/demo\/start/, 'the shell carries the demo boot script');
  assert.equal((await (await req('/api/setup-status')).json()).needsSetup, false, 'no owner-setup form on a demo node');
  const v = await visit();
  assert.equal(v.r.status, 200, JSON.stringify(v.j));
  assert.match(v.j.uid, /^anon-[0-9a-f]{16}$/);
  assert.ok(v.cookie.startsWith(`${DEMO_COOKIE}=${v.j.uid}`));
  const models = await (await req('/api/models', { token: v.token })).json();
  assert.deepEqual(models.map((m) => m.id), ['fast'], 'the chooser offers only lanes a demo turn can use');
  assert.match(shell, /#shellVfy,#login\{display:none/, 'Verify and the refused sign-in dialog are hidden');
  const apps = await (await req('/api/apps', { token: v.token })).json();
  assert.ok(apps.some((a) => a.name === 'notes'), 'apps seeded from workspace.example');
  const back = await visit(v.ip, v.cookie);
  assert.equal(back.j.uid, v.j.uid, 'a returning visitor keeps their workspace');
  for (let i = 0; i < 3; i++) await visit(v.ip, v.cookie);
  assert.equal((await req('/api/ping', { token: v.token })).status, 401, 'repeat visits keep only the newest few sessions');
  assert.equal((await req('/api/ping', { token: back.token })).status, 401);
  const forged = await visit(v.ip, `${DEMO_COOKIE}=${v.j.uid}`);
  assert.notEqual(forged.j.uid, v.j.uid, 'the public id alone is not a credential');
  assert.match(shell, /\/api\/ping/, 'a stale stored session is checked, not trusted');
});

test("a visitor cannot become an account, read an account's apps, or run two chat turns at once", async () => {
  const v = await visit();
  const put = await req('/api/profile', { method: 'PUT', token: v.token, ip: v.ip, body: JSON.stringify({ name: 'x', password: 'secret-pin' }) });
  assert.equal(put.status, 200);
  const users = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).users.map((u) => u.id);
  assert.ok(!users.includes(v.j.uid), 'never written into config.json');
  const slow = chat(v, { message: 'SLOW one' });
  await new Promise((r) => setTimeout(r, 150));
  const second = await chat(v, { message: 'overlap, in another chat' });
  const save = await req('/api/save-data', { method: 'POST', token: v.token, ip: v.ip, body: JSON.stringify({ path: 'data/longevity/bind.json', data: { convo: 'x' } }) });
  assert.equal(save.status, 200, 'an app can save the new chat id while the reply is still coming');
  assert.equal(second.status, 409);
  assert.equal((await slow).status, 200);
});

test('an anonymous visitor chats, then hits the daily AI cap and is told so in EN + 中文', async () => {
  const v = await visit();
  for (let i = 0; i < DEMO.ai_calls_per_user_per_day; i++) {
    const r = await chat(v, { message: `hello ${i}` });
    assert.equal(r.status, 200);
    const ev = await lines(r);
    assert.ok(ev.some((e) => e.type === 'done' && e.text === 'FAST-ANSWER'), JSON.stringify(ev));
  }
  const over = await chat(v, { message: 'one more' });
  assert.equal(over.status, 429);
  const j = await over.json();
  assert.equal(j.code, 'demo_ai_user');
  assert.equal(j.error, QUOTA_MESSAGES.ai_user);
  assert.match(j.error, /limit/); assert.match(j.error, /今日/);
  const again = await visit(v.ip, v.cookie);
  assert.equal((await chat(again, { message: 'new session, same visitor' })).status, 429, 'a fresh session does not reset the cap');
});

test('demo mode refuses the agent lane and every owner or unlisted route', async () => {
  const v = await visit();
  const ev = await lines(await chat(v, { message: 'use the agent', model: 'claude', assess: true, oneShot: true }));
  assert.ok(ev.some((e) => e.type === 'done' && e.text === 'FAST-ANSWER'), 'answered on the Ollama lane');
  assert.ok(ev.some((e) => e.type === 'status' && /Verify/.test(e.text)), 'a Verify request is told it is not available');
  for (const [m, p] of [['POST', '/api/ask'], ['POST', '/api/login'], ['POST', '/api/register'], ['POST', '/api/setup'],
    ['GET', '/api/admin/config'], ['GET', '/api/jobs'], ['POST', '/api/upload'], ['GET', '/api/websearch'], ['POST', '/api/apps/fork'], ['POST', '/api/restore-data']]) {
    const r = await req(p, { method: m, token: v.token, ...(m === 'POST' ? { body: '{"message":"x"}' } : {}) });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal((await r.json()).error, DEMO_REFUSED);
  }
  assert.equal((await req('/api/ping', { token: OWNER_TOKEN })).status, 401, 'no account token works on a demo node');
  assert.equal(spawned(), false, 'the claude CLI was never spawned');
});

test('the per-user disk cap refuses chat and saves with a clear message', async () => {
  const v = await visit();
  fs.writeFileSync(path.join(root, `workspace-${v.j.uid}`, 'big.bin'), Buffer.alloc(DEMO.user_disk_mb * 1024 * 1024 + 1));
  const r = await chat(v, { message: 'hi' });
  assert.equal(r.status, 507);
  assert.equal((await r.json()).error, QUOTA_MESSAGES.disk_user);
  const s = await req('/api/save-data', { method: 'POST', token: v.token, ip: v.ip, body: JSON.stringify({ path: 'notes/x.json', data: {} }) });
  assert.equal(s.status, 507);
  const convos = path.join(root, `workspace-${v.j.uid}`, 'conversations');
  fs.mkdirSync(convos, { recursive: true }); fs.writeFileSync(path.join(convos, 'abcdef12.json'), JSON.stringify({ id: 'abcdef12', messages: [] }));
  const del = await fetch(`http://127.0.0.1:${port}/api/convos/abcdef12`, { method: 'DELETE', headers: { authorization: `Bearer ${v.token}` } });
  assert.equal(del.status, 200, 'a delete is allowed at the cap');
  assert.ok(!fs.existsSync(path.join(convos, '.trash')), 'and frees the space: no tombstone');
});

test('a save larger than save_max_mb is refused with a clear message, before it is read', async () => {
  const v = await visit();
  const big = JSON.stringify({ path: 'notes/x.json', data: { t: 'x'.repeat(2 * 1024 * 1024 + 10) } });
  const r = await req('/api/save-data', { method: 'POST', token: v.token, ip: v.ip, body: big });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).error, QUOTA_MESSAGES.too_big);
  const zlib = await import('node:zlib');
  const gz = await fetch(`http://127.0.0.1:${port}/api/save-data`, { method: 'POST',
    body: zlib.gzipSync(JSON.stringify({ path: 'data/notes/ok.json', data: { t: 'small' } })),
    headers: { authorization: `Bearer ${v.token}`, 'content-encoding': 'gzip', 'content-type': 'application/json' } });
  assert.equal(gz.status, 200, 'a gzipped save (as the shell sends over 1 KB) is accepted');
});

test('new visitors per network are capped per day', async () => {
  const ip = '192.0.2.77';
  for (let i = 0; i < DEMO.new_users_per_ip_per_day; i++) assert.equal((await visit(ip)).r.status, 200);
  const over = await visit(ip);
  assert.equal(over.r.status, 429);
  assert.equal(over.j.error, QUOTA_MESSAGES.new_user);
});

test('a demo node with accounts in config.json refuses to start', async () => {
  const p2 = await freePort();
  const r2 = mkWebRoot({ port: p2, extraConfig: { demo: { enabled: true } } });   // the harness's owner account
  const w2 = startWeb(r2);
  const { code } = await w2.exited;
  assert.notEqual(code, 0);
  assert.match(w2.bootLog(), /must have no users/);
  rmTemp(r2);
});

test('a reply cut off before Ollama says done is an error, never a saved success', async () => {
  const v = await visit();
  const ev = await lines(await chat(v, { message: 'CUTOFF please' }));
  assert.ok(!ev.some((e) => e.type === 'done'), JSON.stringify(ev));
  assert.ok(ev.some((e) => e.type === 'error' && /cut off/.test(e.text)));
});

test('a reply longer than reply_max_kb is stopped with a clear message', async () => {
  const v = await visit();
  const ev = await lines(await chat(v, { message: 'LONGREPLY please' }));
  assert.ok(!ev.some((e) => e.type === 'done'));
  assert.ok(ev.some((e) => e.type === 'error' && e.text.includes(QUOTA_MESSAGES.reply_long)), JSON.stringify(ev.filter((e) => e.type !== 'delta')));
});

test('a chat rename works in the demo (under the visitor lock)', async () => {
  const v = await visit();
  const first = await (await chat(v, { message: 'name me' })).text();
  const id = JSON.parse(first.split('\n')[0]).id;
  const r = await req(`/api/convos/${id}`, { method: 'PATCH', token: v.token, ip: v.ip, body: JSON.stringify({ title: 'Renamed' }) });
  assert.equal(r.status, 200, await r.text());
  assert.equal((await (await req(`/api/convos/${id}`, { token: v.token })).json()).title, 'Renamed');
  const del = await fetch(`http://127.0.0.1:${port}/api/convos/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${v.token}` } });
  assert.equal(del.status, 200, 'a delete (no body) passes the gate');
});

test('removing "demo" from config.json turns demo mode off without a restart', async () => {
  const p3 = await freePort();
  const r3 = mkWebRoot({ port: p3, extraConfig: { users: [], demo: { enabled: true } } });
  const w3 = startWeb(r3); await waitReady(p3);
  const start = () => fetch(`http://127.0.0.1:${p3}/api/demo/start`, { method: 'POST' }).then((r) => r.status);
  assert.equal(await start(), 200);
  const f = path.join(r3, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete c.demo; fs.writeFileSync(f, JSON.stringify(c, null, 2));
  await waitFor(async () => (await start()) !== 200, 'demo mode off after the config edit', { timeoutMs: 10000 });
  await stopWeb(w3); rmTemp(r3);
});

test('a kept session whose workspace a restore lost is re-seeded on its next request', async () => {
  const v = await visit();
  fs.rmSync(path.join(root, `workspace-${v.j.uid}`), { recursive: true });
  const apps = await (await req('/api/apps', { token: v.token })).json();
  assert.ok(apps.some((a) => a.name === 'notes'));
});

test("an app naming the main chat's conversation gets a fresh one, not its history", async () => {
  const v = await visit();
  const main = JSON.parse((await (await chat(v, { message: 'main chat' })).text()).split('\n')[0]).id;
  const fromApp = JSON.parse((await (await chat(v, { message: 'from app', app: 'notes', convoId: main })).text()).split('\n')[0]).id;
  assert.notEqual(fromApp, main);
});

test('a demo chat keeps the label an app sends (period summaries reopen with it)', async () => {
  const v = await visit();
  const id = JSON.parse((await (await chat(v, { message: 'summarize', app: 'notes', label: 'summary:2026-11' })).text()).split('\n')[0]).id;
  assert.equal((await (await req(`/api/convos/${id}`, { token: v.token })).json()).label, 'summary:2026-11');
});

test('sign-out ends the visit: every session revoked and the cookie expired (shared browser)', async () => {
  const v = await visit();
  const other = await visit(v.ip, v.cookie);   // a second tab of the same visitor
  const r = await req('/api/logout', { method: 'POST', token: v.token, ip: v.ip, cookie: v.cookie });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') || '', new RegExp(`^${DEMO_COOKIE}=;.*Max-Age=0`));
  for (const t of [v.token, other.token]) assert.equal((await req('/api/ping', { token: t, ip: v.ip })).status, 401);
  const fresh = await visit(v.ip);   // the browser has dropped the cookie: a new, empty visit
  assert.notEqual(fresh.j.uid, v.j.uid);
});

test('the documented passphrase setup never overwrites an existing backup key', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs/demo-node.md'), 'utf8');
  const line = doc.split('\n').find((l) => l.includes('backup-pass') && l.includes('openssl rand'));
  assert.ok(line && /\[ -e \/etc\/superelf-demo\/backup-pass \] \|\|/.test(line), line);
});
