// 应用对话不再假装已修改 · the user flow on the server (R6): an app's chat on a no-write lane, asked for a
// feature by a model that then says "Done — added", never leaves that claim standing — on the owner's
// node (fast lane; the owner also gets the Change-this-app offer) and on the demo (app chat and main chat).
// A FAKE Ollama answers; it records the system lines so the rule is proven sent, not only defined.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { APP_CHAT_NO_CHANGE_RULE, NO_CHANGE_NOTE, CHANGE_APP_LABEL, CHANGE_PATHS } from '../lib/app-chat-honesty.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = [{ id: 'fast', label: 'Fast', group: 'Fast', provider: 'ollama', model: 'fake-fast' }];
const DEMO = { enabled: true, auth: { required: false }, behind_cloudflare: true, ai_calls_per_user_per_day: 50, ai_calls_per_ip_per_day: 500, new_users_per_ip_per_day: 50, user_disk_mb: 1, total_disk_gb: 5 };
const LIE = 'Done — the Calendar Planner now has a Day / Week / Month / Year view switcher at the top.';
const ASK = 'can you allow user to select day, week, month and year view?';
const seen = [];   // the system lines of every chat call the stub answered
function startOllamaStub() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }).on('end', () => {
      const msgs = JSON.parse(b).messages;
      seen.push(msgs.filter((m) => m.role === 'system').map((m) => m.content));
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: LIE }, done: true }) + '\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const lines = async (r) => (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

let ollama, owner, demo;
async function node(extra) {
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig: { ollama_url: `http://127.0.0.1:${ollama.address().port}`, chat_models: MODELS, ...extra } });
  return { port, root, web: startWeb(root) };
}
before(async () => {
  ollama = await startOllamaStub();
  owner = await node({ default_chat_model: 'fast' });
  const app = path.join(owner.root, 'workspace', 'apps', 'calendar-planner'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><html><body><h1>Calendar Planner</h1></body></html>');
  demo = await node({ users: [], demo: DEMO });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(demo.root, 'workspace.example'), { recursive: true });
  await waitReady(owner.port); await waitReady(demo.port);
});
after(async () => { for (const n of [owner, demo]) if (n) { await stopWeb(n.web); rmTemp(n.root); } ollama.close(); });

const ownerChat = (body) => fetch(`http://127.0.0.1:${owner.port}/api/chat`, { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}`, [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE }, body: JSON.stringify(body) });

test('owner node, an app\'s chat on the fast lane: rule sent, "Done" corrected, the offer carries the earlier request', async () => {
  seen.length = 0;
  const ev1 = await lines(await ownerChat({ message: ASK, app: 'calendar-planner', model: 'fast' }));
  const convo = ev1.find((e) => e.type === 'convo').id;
  assert.ok(seen[0].some((s) => s.includes(APP_CHAT_NO_CHANGE_RULE) && s.includes(CHANGE_PATHS.owner)), 'the rule and the owner\'s real way were sent');
  const ev = await lines(await ownerChat({ message: 'yes', app: 'calendar-planner', model: 'fast', convoId: convo }));
  const done = ev.find((e) => e.type === 'done');
  assert.ok(done.text.endsWith(NO_CHANGE_NOTE), done.text);
  const offer = ev.find((e) => e.type === 'app-change');
  assert.equal(offer.label, CHANGE_APP_LABEL);
  assert.equal(offer.request, ASK, '"yes" offers the request it agreed to');
  const stored = JSON.parse(fs.readFileSync(path.join(owner.root, 'workspace', 'conversations', `${convo}.json`), 'utf8'));
  assert.ok(stored.messages.at(-1).text.endsWith(NO_CHANGE_NOTE), 'a reload shows the note too');
});

async function visit() {
  const r = await fetch(`http://127.0.0.1:${demo.port}/api/demo/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.77' } });
  return (await r.json()).token;
}
const demoChat = (token, body) => fetch(`http://127.0.0.1:${demo.port}/api/chat`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.77', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test('demo guest, an app\'s chat: the demo\'s real way is sent, the claim is corrected, no owner button', async () => {
  const token = await visit();
  seen.length = 0;
  const ev = await lines(await demoChat(token, { message: ASK, app: 'calendar-planner' }));
  assert.ok(seen[0].some((s) => s.includes(APP_CHAT_NO_CHANGE_RULE) && s.includes(CHANGE_PATHS.demo)));
  assert.ok(ev.find((e) => e.type === 'done').text.endsWith(NO_CHANGE_NOTE));
  assert.equal(ev.find((e) => e.type === 'app-change'), undefined, 'a guest has no Change-this-app panel');
});

test('demo guest, main chat: a claim with no build marker is corrected too', async () => {
  const token = await visit();
  const ev = await lines(await demoChat(token, { message: 'add a week view to my calendar planner' }));
  assert.ok(ev.find((e) => e.type === 'done').text.endsWith(NO_CHANGE_NOTE));
});
