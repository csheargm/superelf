// Background app builds on the demo node (lib/demo-build-job.mjs), as a visitor meets them: the REAL
// web.mjs in demo mode, Ollama stubbed, the build call HELD until the test lets it answer. The chat
// turn answers at once; the visitor chats on, reloads, and later sees the app done in the list and
// in the chat. One build at a time (a refused second one costs no cap). A node restart mid-build
// leaves the job failed, never stuck "building".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { jobOf, waitBuilt } from './helpers-demo-build.mjs';
import { APP_MARKER } from '../lib/demo-app.mjs';
import { BUILD_MESSAGES, appLink } from '../lib/demo-build-job.mjs';
import { DEMO_BUILD_TIP } from '../lib/demo-build-ui.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = [{ id: 'fast', label: 'Fast', group: 'Fast', provider: 'ollama', model: 'fake-fast' }];
const DEMO = { enabled: true, auth: { required: false }, behind_cloudflare: true, ai_calls_per_user_per_day: 50, ai_calls_per_ip_per_day: 500, new_users_per_ip_per_day: 50, user_disk_mb: 1, total_disk_gb: 5 };
const GOOD = '```json\n{"slug":"hello-world","title":"Hello World","desc":"Says hello","icon":"👋"}\n```\n```html\n<!doctype html><html><body><h1>HELLO-DEMO</h1><script>1</script></body></html>\n```';
const held = [], heldChat = [];   // build calls waiting for the test: each is a function that answers it

function reply(res, content) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true }) + '\n');
}
function startOllamaStub() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }).on('end', () => {
      const msgs = JSON.parse(b).messages;
      if (msgs[0].content.startsWith('You write ONE superelf mini-app')) return held.push(() => reply(res, GOOD));
      const ask = msgs.filter((m) => m.role === 'user').pop().content;
      if (ask.includes('SLOWCHAT')) return heldChat.push(() => reply(res, 'SLOW-ANSWER'));
      if (/make me an app/i.test(ask)) return reply(res, `${APP_MARKER} ${JSON.stringify({ edit: '', title: 'Hello World', request: ask })}`);
      return reply(res, 'PLAIN-ANSWER');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const releaseAll = () => { while (held.length) held.shift()(); while (heldChat.length) heldChat.shift()(); };

let ollama, web, root, port, ipSeq = 0;
before(async () => {
  ollama = await startOllamaStub();
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [], demo: DEMO, ollama_url: `http://127.0.0.1:${ollama.address().port}`, chat_models: MODELS } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  web = startWeb(root); await waitReady(port);
});
after(async () => { releaseAll(); await stopWeb(web); ollama.close(); rmTemp(root); });

const req = (p, { token, ip, ...opts } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...opts, headers: {
  'content-type': 'application/json', 'cf-connecting-ip': ip || '203.0.113.9', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
async function visit() {
  const ip = `198.51.100.${++ipSeq}`;
  const j = await (await req('/api/demo/start', { method: 'POST', ip })).json();
  return { ip, token: j.token, uid: j.uid, dir: path.join(root, `workspace-${j.uid}`, 'apps') };
}
const chat = async (v, message, convoId) => (await (await req('/api/chat', { method: 'POST', token: v.token, ip: v.ip, body: JSON.stringify({ message, convoId }) })).text())
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const buildsCharged = (v) => JSON.parse(fs.readFileSync(path.join(root, 'demo-quota.json'), 'utf8')).counts[`build:${v.uid}`] || 0;
const convo = async (v, id) => (await (await req(`/api/convos/${id}`, { token: v.token })).json()).messages;

test('a build runs behind the chat: answered at once, the visitor chats and reloads, then sees it done', async () => {
  const v = await visit();
  const ev = await chat(v, 'make me an app that says hello');
  const id = ev.find((e) => e.type === 'convo').id;
  assert.match(ev.find((e) => e.type === 'done').text, /^Building \*\*Hello World\*\*….*正在创建「Hello World」/, JSON.stringify(ev));
  await waitFor(() => held.length === 1, 'the build call');   // the reply came while the build is still held
  assert.equal((await jobOf(req, v)).status, 'building');
  assert.equal(buildsCharged(v), 1);
  // a second build while one runs: refused, and the build cap is NOT charged
  const two = await chat(v, 'make me an app again', id);
  assert.equal(two.find((e) => e.type === 'error').text, `⚠ ${BUILD_MESSAGES.busy}`);
  assert.equal(buildsCharged(v), 1);
  // switch away: an ordinary turn; "reload": the shell carries the indicator, the job is still there
  assert.equal((await chat(v, 'what is 2+2')).find((e) => e.type === 'done').text, 'PLAIN-ANSWER');
  const shell = await (await req('/')).text();
  assert.ok(shell.includes(JSON.stringify(DEMO_BUILD_TIP)) && shell.includes("'/api/demo/build'"), 'indicator and its first-use tip');
  assert.equal((await jobOf(req, v)).status, 'building');
  releaseAll();
  const job = await waitBuilt(req, v);
  assert.equal(job.status, 'done'); assert.equal(job.slug, 'hello-world');
  assert.ok((await (await req('/api/apps', { token: v.token })).json()).some((a) => a.name === 'hello-world' && a.uid === v.uid));
  const last = (await convo(v, id)).pop();
  assert.match(last.text, /^Done · 完成 — created \*\*Hello World\*\*.*\[Open · 打开\]\(http:\/\/127\.0\.0\.1:\d+\/#app=hello-world\)$/, last.text);
});

test('a restart mid-build leaves the job failed, said in the chat, and the next build may start', async () => {
  const v = await visit();
  const ev = await chat(v, 'make me an app that says hello');
  const id = ev.find((e) => e.type === 'convo').id;
  await waitFor(() => held.length === 1, 'the build call');
  await stopWeb(web);
  releaseAll();   // the stopped node's call: answered into nothing
  web = startWeb(root); await waitReady(port);
  const job = await jobOf(req, v);
  assert.equal(job.status, 'failed'); assert.equal(job.error, BUILD_MESSAGES.interrupted);
  const last = (await convo(v, id)).pop();
  assert.ok(last.failed && last.text.includes(BUILD_MESSAGES.interrupted), JSON.stringify(last));
  assert.ok(!fs.existsSync(path.join(v.dir, 'hello-world')), 'nothing half-written');
  await chat(v, 'make me an app once more', id);
  await waitFor(() => held.length === 1, 'the new build call');
  releaseAll();
  assert.equal((await waitBuilt(req, v)).status, 'done');
});

test('a build that ends while a turn streams in the same chat: the job ends only after it, with its note', async () => {
  const v = await visit();
  const id = (await chat(v, 'make me an app that says hello')).find((e) => e.type === 'convo').id;
  await waitFor(() => held.length === 1, 'the build call');
  const slow = chat(v, 'SLOWCHAT please', id);
  await waitFor(() => heldChat.length === 1, 'the slow turn');
  held.shift()();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await jobOf(req, v)).status, 'building', 'not shown ended before its note can be written');
  heldChat.shift()();
  await slow;
  await waitBuilt(req, v);
  const texts = (await convo(v, id)).map((m) => m.text);
  assert.ok(texts.includes('SLOW-ANSWER'), JSON.stringify(texts));
  assert.match(texts[texts.length - 1], /^Done · 完成/, JSON.stringify(texts));
});

test('the open link: the host the visitor used, http only for a local node; an odd host stays relative', () => {
  assert.equal(appLink({ host: 'try.superelf.app' }, 'a'), 'https://try.superelf.app/#app=a');
  assert.equal(appLink({ host: 'localhost:8080' }, 'a'), 'http://localhost:8080/#app=a');
  assert.equal(appLink({ host: 'evil.example/"><x' }, 'a'), '/#app=a');
});
