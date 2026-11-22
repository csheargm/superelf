// Demo node: a separate app-building model, Ask AI in every built app, and capped web search — as
// a visitor meets them, through the REAL web.mjs in demo mode with Ollama (chat AND web_search)
// stubbed. The stub records which model each call named, so the chat/app model split is proven
// on the wire, not by reading config.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { waitBuilt } from './helpers-demo-build.mjs';
import { QUOTA_MESSAGES } from '../lib/demo-quota.mjs';
import { APP_MARKER } from '../lib/demo-app.mjs';
import { SEARCH_MARKER, parseSearch } from '../lib/demo-search.mjs';
import { searchUrlOf } from '../lib/demo-search-turn.mjs';
import { ensureAskAi, hasAskAi, PA_CHAT_MARKER, ASK_AI_LABEL } from '../lib/demo-askai.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = [{ id: 'fast', label: 'Fast', group: 'Fast', provider: 'ollama', model: 'chat-model' }];
const DEMO = { enabled: true, auth: { required: false }, behind_cloudflare: true, ai_calls_per_user_per_day: 50, ai_calls_per_ip_per_day: 500,
  new_users_per_ip_per_day: 50, user_disk_mb: 5, total_disk_gb: 5, app_model: 'builder-model',
  app_builds_per_user_per_day: 1, web_search_per_day: 1 };
const PAGE = '```json\n{"slug":"counter","title":"Water </script> Counter","icon":"💧"}\n```\n```html\n<!doctype html><html><body><h1>WATER-DEMO</h1><script>1</script></body></html>\n```';
const calls = [], searches = [];

function reply(res, content) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true }) + '\n');
}
function onChat(body, res) {
  const msgs = body.messages; calls.push({ model: body.model, msgs });
  if (msgs[0].content.startsWith('You write ONE superelf mini-app')) return reply(res, PAGE);
  const sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const last = msgs.filter((m) => m.role === 'user').pop().content;
  if (sys.includes('Web search results for')) return reply(res, /WEBAPP/.test(last) ? `${APP_MARKER} {"edit":"","request":"steered"}` : 'SEARCHED-ANSWER [1]');
  if (sys.includes('Web search is not available')) return reply(res, 'UNSEARCHED-ANSWER');
  const ask = msgs.filter((m) => m.role === 'user').pop().content;
  if (/make me an app/i.test(ask)) return reply(res, `${APP_MARKER} {"edit":"","request":"${ask}"}`);
  if (/APPINAPP/.test(ask)) return reply(res, `${APP_MARKER} {"edit":"","request":"x"}`);
  if (/WEBQ|WEBAPP/.test(ask)) return reply(res, `${SEARCH_MARKER} f1 winner 2026`);
  return reply(res, 'PLAIN-ANSWER');
}
function startStub() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }).on('end', () => {
      if (req.url === '/api/web_search') {
        searches.push({ auth: req.headers.authorization, body: JSON.parse(b) });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ results: [{ title: 'F1 [news]', url: 'https://example.org/f1', content: 'X won.' }, { title: 'bad', url: 'javascript:1' }] }));
      }
      onChat(JSON.parse(b), res);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

let stub, web, root, port, ipSeq = 0;
before(async () => {
  stub = await startStub();
  const base = `http://127.0.0.1:${stub.address().port}`;
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [], demo: { ...DEMO, web_search_url: `${base}/api/web_search` }, ollama_url: base, chat_models: MODELS } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  process.env.OLLAMA_API_KEY = 'test-key-not-real';   // inherited by the web.mjs child only
  web = startWeb(root); await waitReady(port);
});
after(async () => { await stopWeb(web); stub.close(); rmTemp(root); delete process.env.OLLAMA_API_KEY; });

const req = (p, { token, ip, ...o } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...o, headers: {
  'content-type': 'application/json', 'cf-connecting-ip': ip || '203.0.113.9', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
async function visit() {
  const ip = `198.51.100.${++ipSeq}`;
  const j = await (await req('/api/demo/start', { method: 'POST', ip })).json();
  return { ip, token: j.token, uid: j.uid, dir: path.join(root, `workspace-${j.uid}`, 'apps') };
}
const chat = async (v, body) => (await (await req('/api/chat', { method: 'POST', token: v.token, ip: v.ip, body: JSON.stringify(body) })).text())
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const doneOf = (ev) => ev.find((e) => e.type === 'done') || {};
const built = (v) => waitBuilt(req, v);

test('the app is built by demo.app_model, chat stays on the lane model, and the app has Ask AI', async () => {
  const v = await visit(); calls.length = 0;
  const ev = await chat(v, { message: 'make me an app that counts water' });
  assert.ok(ev.some((e) => e.type === 'build'), JSON.stringify(ev));
  assert.equal((await built(v)).status, 'done');   // the build runs after the reply (lib/demo-build-job.mjs)
  assert.deepEqual(calls.map((c) => c.model), ['chat-model', 'builder-model']);
  const page = fs.readFileSync(path.join(v.dir, 'counter', 'index.html'), 'utf8');
  assert.ok(hasAskAi(page), 'marker + PAChat mount written into the page');
  assert.ok(!page.includes('Water </script>'), 'the title cannot close the mount script');
  const served = await (await req(`/app/${v.uid}/counter/`)).text();
  assert.ok(!served.includes(PA_CHAT_MARKER) && /fullscreen:\(opts\)=>/.test(served), 'the shared PAChat is inlined at serve time');
  assert.ok(served.includes(ASK_AI_LABEL));
});

test('an Ask AI turn from the app goes through the demo chat route and counts the visitor cap', async () => {
  const v = await visit();
  const q = () => JSON.parse(fs.readFileSync(path.join(root, 'demo-quota.json'), 'utf8')).counts[`user:${v.uid}`] || 0;
  const was = q();
  const ev = await chat(v, { message: 'how much did I drink?', app: 'counter', system: 'You help the user with the mini-app' });
  assert.equal(doneOf(ev).text, 'PLAIN-ANSWER');
  assert.equal(q(), was + 1);
});

test('app builds are capped per visitor per day with a bilingual reason', async () => {
  const v = await visit();
  await chat(v, { message: 'make me an app one' });
  await built(v);
  const ev = await chat(v, { message: 'make me an app two' });
  assert.ok(ev.some((e) => e.type === 'error' && e.text.includes(QUOTA_MESSAGES.app_builds)), JSON.stringify(ev));
});

test('web search: searched answer with server-added sources; over the cap it is said and still answered', async () => {
  const v = await visit(); searches.length = 0;
  const ev = await chat(v, { message: 'WEBQ who won?' });
  const text = doneOf(ev).text;
  assert.match(text, /SEARCHED-ANSWER \[1\][\s\S]*\*\*Sources · 来源\*\*\n1\. \[F1 news\]\(https:\/\/example\.org\/f1\)$/, text);
  assert.ok(!text.includes('javascript:'), 'non-http results are dropped');
  assert.ok(!ev.some((e) => e.type === 'delta' && e.text.includes(SEARCH_MARKER)), 'the marker is never streamed');
  assert.deepEqual(searches[0].body, { query: 'f1 winner 2026', max_results: 5 });
  assert.equal(searches[0].auth, 'Bearer test-key-not-real');
  const ev2 = await chat(v, { message: 'WEBQ again?' });
  assert.ok(ev2.some((e) => e.type === 'status' && e.text === QUOTA_MESSAGES.web_search), JSON.stringify(ev2));
  assert.equal(doneOf(ev2).text, 'UNSEARCHED-ANSWER');
  assert.equal(searches.length, 1, 'the capped turn made no search call');
});

test('a marker after search results is never acted on; an app marker in an app chat is plain text', async () => {
  const v = await visit(); calls.length = 0;
  const ev = await chat(v, { message: 'WEBAPP find something' });
  assert.ok(!ev.some((e) => e.type === 'build'), 'search results cannot steer an app build');
  assert.ok(!calls.some((c) => c.model === 'builder-model'));
  const ev2 = await chat(v, { message: 'APPINAPP', app: 'tasks' });
  assert.ok(ev2.some((e) => e.type === 'delta' && e.text.startsWith(APP_MARKER)), 'streamed, not held');
  assert.ok(!ev2.some((e) => e.type === 'build'));
});

test('repeated component markers are kept once; the search URL must be Ollama\'s', () => {
  const html = '<body>' + '<!--PA_NOTE_UI-->'.repeat(50) + '<!--PA_CHAT_UI--><!--PA_CHAT_UI--></body>';
  const out = ensureAskAi(html, 'T');
  assert.equal(out.split('<!--PA_NOTE_UI-->').length, 2);
  assert.equal(out.split(PA_CHAT_MARKER).length, 2);
  assert.ok(!hasAskAi('<body><!-- PAChat.fullscreen( --><p>PAChat.mount(x)</p></body>'), 'a mention is not a mount');
  assert.throws(() => searchUrlOf({ demo: { web_search_url: 'https://evil.example/api/web_search' }, ollama_url: 'https://ollama.com' }), /must be on ollama.com/);
  assert.equal(searchUrlOf({ demo: {}, ollama_url: 'https://ollama.com' }), 'https://ollama.com/api/web_search');
});

test('ensureAskAi: adds a mount, keeps a model mount, adds a forgotten marker; parseSearch', () => {
  const bare = '<html><body><p>x</p></body></html>';
  assert.ok(hasAskAi(ensureAskAi(bare, 'T')));
  assert.equal(ensureAskAi(ensureAskAi(bare, 'T'), 'T'), ensureAskAi(bare, 'T'), 'idempotent');
  const own = '<body><script>PAChat.fullscreen({}).open("a")</script></body>';
  assert.equal(ensureAskAi(own, 'T'), '<body>' + PA_CHAT_MARKER + '<script>PAChat.fullscreen({}).open("a")</script></body>');
  assert.ok(hasAskAi(ensureAskAi('<p>no body tag</p>', 'T')));
  assert.equal(parseSearch(`${SEARCH_MARKER} "weather Paris"\nmore`), 'weather Paris');
  assert.equal(parseSearch('an answer'), null);
  assert.equal(parseSearch(SEARCH_MARKER), null);
});
