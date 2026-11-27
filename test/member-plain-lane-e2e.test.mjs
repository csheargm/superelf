// Members answer on a plain chat model; agent lanes are the owner's opt-in (F4-2, R6).
// The real web.mjs with a fake Ollama and a fake `claude`: a new member's turn (no lane named, as the
// main chat sends it) and an explicit Claude pick both answer on Ollama and say so; /api/models hides
// Claude and GPT from them. CONTROL (R14): the owner's turn still reaches the agent, and once the owner
// ticks "AI 工具 · Agent tools" for the member (real browser, Settings) the member's turn does too.
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { PLAIN_LANE_STATUS } from '../lib/member-lanes.mjs';

const FAKE_CLAUDE = `#!/usr/bin/env node
let s=''; process.stdin.on('data',(d)=>s+=d).on('end',()=>{
  process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'sid'})+'\\n');
  process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'FROM AGENT',session_id:'sid'})+'\\n'); });
`;
let port, root, web, browser, ollama;
before(async () => {
  port = await freePort();
  ollama = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end(JSON.stringify({ message: { content: 'FROM OLLAMA' }, done: true }) + '\n')); });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  root = mkWebRoot({ port, extraConfig: { ollama_url: `http://127.0.0.1:${ollama.address().port}`, task_timeout_minutes: 1,
    users: [{ id: 'owner', username: 'mom', name: 'Mom', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json'); const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE_CLAUDE); fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); ollama?.close(); if (root) rmTemp(root); });

const base = () => `http://127.0.0.1:${port}`;
const login = async (u, p) => (await (await fetch(`${base()}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const call = (tok, p, opt = {}) => fetch(`${base()}${p}`, { ...opt, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` } });
async function turn(tok, body) {
  const txt = await (await call(tok, '/api/chat', { method: 'POST', body: JSON.stringify(body) })).text();
  return txt.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
const answer = (ev) => ev.find((e) => e.type === 'done').text;

let mom, mara;
test('a new member answers on a plain model and is told so; the owner still reaches the agent', async () => {
  mom = await login('mom', 'owner-pass-123');
  assert.equal((await call(mom, '/api/admin/users', { method: 'POST', body: JSON.stringify({ id: 'mara', name: 'Mara', password: 'mara-first-pass-1' }) })).status, 200);
  mara = await login('mara', 'mara-first-pass-1');
  const ids = (await (await call(mara, '/api/models')).json()).map((m) => m.id);
  assert.ok(!ids.includes('claude') && !ids.includes('gpt'), `member chooser: ${ids}`);
  assert.ok(ids.includes('deepseek'));
  assert.ok((await (await call(mom, '/api/models')).json()).some((m) => m.id === 'claude'), 'CONTROL: the owner sees Claude');
  const ev = await turn(mara, { message: 'hello' });
  assert.equal(answer(ev), 'FROM OLLAMA');
  assert.ok(ev.some((e) => e.type === 'status' && e.text.startsWith(PLAIN_LANE_STATUS)), JSON.stringify(ev));
  assert.equal(answer(await turn(mara, { message: 'use claude', model: 'claude' })), 'FROM OLLAMA', 'an explicit agent pick is moved too');
  assert.equal(answer(await turn(mom, { message: 'hello' })), 'FROM AGENT', 'CONTROL: the owner\'s default is the agent');
  assert.equal((await (await call(mom, '/api/admin/users')).json()).find((u) => u.id === 'mara').agent, false);
});

test('the owner ticks "AI 工具 · Agent tools" in Settings; the member then reaches the agent, and it persists', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`${base()}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'mom'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  await page.click('#hmore'); await page.click('#settings');
  const box = page.locator('#family [data-agent="mara"]');
  await box.waitFor();
  assert.match(await page.locator('#family label:has([data-agent="mara"])').textContent(), /AI 工具/);
  assert.equal(await page.locator('#family [data-agent="owner"]').count(), 0, 'no toggle on the owner');
  await box.check();
  await page.waitForFunction(async () => (await (await api('/api/admin/users')).json()).find((u) => u.id === 'mara').agent === true);
  await ctx.close();
  assert.equal(answer(await turn(mara, { message: 'hello again' })), 'FROM AGENT');
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).users.find((u) => u.id === 'mara');
  assert.equal(saved.agent, true, 'kept in config.json');
});
