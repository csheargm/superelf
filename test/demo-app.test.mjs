// "Make me an app" on the public demo node (lib/demo-app.mjs), as a visitor meets it: the REAL
// web.mjs in demo mode, Ollama stubbed. The chat model answers with the marker line, the server
// asks for the page, checks it, and writes it into THAT visitor's apps/ only; the app list shows it
// and /app/<uid>/<slug>/ serves it under the sandbox CSP. Another visitor can neither see nor serve
// it. Bad output is retried once, then said plainly; a full disk refuses the build.
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
import { APP_MARKER, DEMO_APP_MESSAGES, parseIntent, parseApp, slugFrom } from '../lib/demo-app.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = [{ id: 'fast', label: 'Fast', group: 'Fast', provider: 'ollama', model: 'fake-fast' }];
const DEMO = { enabled: true, auth: { required: false }, behind_cloudflare: true, ai_calls_per_user_per_day: 50, ai_calls_per_ip_per_day: 500, new_users_per_ip_per_day: 50, user_disk_mb: 1, total_disk_gb: 5 };
const GOOD = '```json\n{"slug":"Hello World!","title":"Hello World","desc":"Says hello","icon":"👋"}\n```\n```html\n<!doctype html><html><body><h1>HELLO-DEMO</h1><script>1</script></body></html>\n```';
const FORM = GOOD.replace('<h1>', '<form><h1>');
const build = [];   // every build request body the stub saw

function reply(res, content) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true }) + '\n');
}
function startOllamaStub() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }).on('end', () => {
      const msgs = JSON.parse(b).messages;
      if (msgs[0].content.startsWith('You write ONE superelf mini-app')) {
        build.push(msgs);
        if (msgs[1].content.includes('ALWAYSBAD')) return reply(res, 'here is some code: console.log(1)');
        if (msgs[1].content.includes('FIRSTFORM') && msgs.length === 2) return reply(res, FORM);
        return reply(res, msgs[1].content.includes('Change this app') ? GOOD.replace('HELLO-DEMO', 'RED-DEMO') : GOOD);
      }
      const ask = msgs.filter((m) => m.role === 'user').pop().content;
      if (/make me an app|change my app/i.test(ask)) {
        const edit = /change my app/i.test(ask) ? (ask.match(/change my app ([a-z-]+)/) || [])[1] : '';
        return reply(res, `${APP_MARKER} ${JSON.stringify({ edit, request: ask })}`);
      }
      return reply(res, 'PLAIN-ANSWER');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

let ollama, web, root, port, ipSeq = 0;
before(async () => {
  ollama = await startOllamaStub();
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [], demo: DEMO, ollama_url: `http://127.0.0.1:${ollama.address().port}`, chat_models: MODELS } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  web = startWeb(root); await waitReady(port);
});
after(async () => { await stopWeb(web); ollama.close(); rmTemp(root); });

const req = (p, { token, ip, ...opts } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...opts, headers: {
  'content-type': 'application/json', 'cf-connecting-ip': ip || '203.0.113.9', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
async function visit() {
  const ip = `198.51.100.${++ipSeq}`;
  const j = await (await req('/api/demo/start', { method: 'POST', ip })).json();
  return { ip, token: j.token, uid: j.uid, dir: path.join(root, `workspace-${j.uid}`, 'apps') };
}
const chat = async (v, message) => (await (await req('/api/chat', { method: 'POST', token: v.token, ip: v.ip, body: JSON.stringify({ message }) })).text())
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const doneOf = (ev) => ev.find((e) => e.type === 'done');
// The build runs after the chat reply (lib/demo-build-job.mjs): wait for its job to end.
const built = (v) => waitBuilt(req, v);
const chatBuilt = async (v, message) => { const ev = await chat(v, message); return { ev, job: ev.some((e) => e.type === 'build') ? await built(v) : null }; };

test('a visitor asks for an app: it is written to their namespace, listed, and served with the sandbox CSP', async () => {
  const v = await visit();
  const { ev, job } = await chatBuilt(v, 'can you make me an app that says hello world');
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.slug, 'hello-world'); assert.equal(job.title, 'Hello World');
  assert.ok(!ev.some((e) => e.type === 'delta' && e.text.includes(APP_MARKER)), 'the marker line is never streamed');
  assert.match(doneOf(ev).text, /Building .*正在创建/);
  const page0 = fs.readFileSync(path.join(v.dir, 'hello-world', 'index.html'), 'utf8');
  assert.match(page0, /HELLO-DEMO/);
  assert.match(page0, /^<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'[^"]*connect-src 'none'">/, 'the policy is the page\'s first element (srcdoc route)');
  assert.equal(JSON.parse(fs.readFileSync(path.join(v.dir, 'hello-world', 'meta.json'), 'utf8')).title, 'Hello World');
  assert.match(build[build.length - 1][0].content, /## The four clauses[\s\S]*## App build rules/, 'the build call carries the owner agent\'s app contract');
  const apps = await (await req('/api/apps', { token: v.token })).json();
  assert.ok(apps.some((a) => a.name === 'hello-world' && a.uid === v.uid), 'in the visitor\'s app list');
  const page = await req(`/app/${v.uid}/hello-world/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /sandbox allow-scripts; default-src 'none'.*connect-src 'none'/);
  assert.match(await page.text(), /HELLO-DEMO/);
  // "change my app": the same slug is rewritten, no second app
  const r2 = await chatBuilt(v, 'change my app hello-world to say red');
  assert.equal(r2.job.edited, true, JSON.stringify(r2));
  assert.match(fs.readFileSync(path.join(v.dir, 'hello-world', 'index.html'), 'utf8'), /RED-DEMO/);
  assert.ok(!fs.existsSync(path.join(v.dir, 'hello-world-2')));
});

test('an edit naming a seeded app makes a new app; the seeded one is never overwritten', async () => {
  const v = await visit();
  const tasks = path.join(v.dir, 'tasks', 'index.html'), was = fs.readFileSync(tasks, 'utf8');
  const { job } = await chatBuilt(v, 'change my app tasks EDITSEEDED');
  assert.equal(job.edited, false, JSON.stringify(job));
  assert.equal(fs.readFileSync(tasks, 'utf8'), was);
});

test('another visitor cannot see or edit that app', async () => {
  const a = await visit(), b = await visit();
  await chatBuilt(a, 'make me an app please');
  const bApps = await (await req('/api/apps', { token: b.token })).json();
  assert.ok(!bApps.some((x) => x.name === 'hello-world'), 'not in another visitor\'s list');
  assert.equal((await req(`/app/${b.uid}/hello-world/`)).status, 404, 'not under the other visitor\'s path');
  await chatBuilt(b, 'change my app hello-world to say red');   // b has no such app: a NEW app in b's own folder
  assert.match(fs.readFileSync(path.join(a.dir, 'hello-world', 'index.html'), 'utf8'), /HELLO-DEMO/, 'a\'s app untouched');
});

test('bad model output is retried once; twice bad is a clear bilingual error, nothing written', async () => {
  const v = await visit();
  const ok = await chatBuilt(v, 'make me an app FIRSTFORM');
  assert.equal(ok.job.status, 'done', 'a <form> page is refused and the retry succeeds');
  const retry = build[build.length - 1];
  assert.match(retry[retry.length - 1].content, /refused: .*<form>/, 'the retry says why');
  const before = fs.readdirSync(v.dir).length;
  const bad = await chatBuilt(v, 'make me an app ALWAYSBAD');
  assert.equal(bad.job.status, 'failed');
  assert.equal(bad.job.error, DEMO_APP_MESSAGES.bad_output);
  assert.equal(fs.readdirSync(v.dir).length, before, 'no app written');
});

test('over the disk cap the build is refused with the quota message', async () => {   // checked before the turn, so no job starts
  const v = await visit();
  fs.writeFileSync(path.join(root, `workspace-${v.uid}`, 'big.bin'), Buffer.alloc(DEMO.user_disk_mb * 1024 * 1024 + 1));
  const r = await req('/api/chat', { method: 'POST', token: v.token, ip: v.ip, body: JSON.stringify({ message: 'make me an app' }) });
  assert.equal((await r.json()).error, QUOTA_MESSAGES.disk_user);
  assert.ok(!fs.existsSync(path.join(v.dir, 'hello-world')));
});

test('an ordinary question streams as before; the shell carries the home ask box', async () => {
  const v = await visit();
  const ev = await chat(v, 'what is 2+2');
  assert.equal(doneOf(ev).text, 'PLAIN-ANSWER');
  assert.ok(ev.some((e) => e.type === 'delta'));
  assert.ok((await (await req('/')).text()).includes('id="homeForm"'));
});

test('parsing: lenient marker, traversal-proof slugs, size cap', () => {
  assert.deepEqual(parseIntent(`${APP_MARKER} {"edit":"../x","title":" My  Timer ","request":"a timer"}`), { edit: '', title: 'My Timer', request: 'a timer' });
  assert.equal(parseIntent(`${APP_MARKER} a timer`).request, 'a timer');
  assert.equal(parseIntent('hello'), null);
  assert.equal(slugFrom('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugFrom('!!!'), 'my-app');
  assert.equal(parseApp(GOOD, 10).ok, false);
  assert.equal(parseApp(GOOD.replace('"title":"Hello World"', '"title":{"toString":1}'), 99999).meta.title, 'My app', 'odd metadata falls back, never throws');
});

test('the demo config names the model so it stops claiming to be ChatGPT', () => {
  const c = JSON.parse(fs.readFileSync(path.join(REPO, 'ops/demo/config.demo.json'), 'utf8'));
  const model = c.chat_models[0].model;   // the prompt names whatever model the chat lane really runs
  assert.ok(c.system_prompts.global.includes(`I am the superelf demo assistant running ${model.replace(':', '-')}`), c.system_prompts.global);
  assert.ok(typeof c.demo.app_model === 'string' && c.demo.app_model, 'the app-building model is set');
  assert.ok(c.demo.chat_timeout_s * 1000 >= 240_000, 'an app build (2-3 min measured) fits the call deadline');
});
