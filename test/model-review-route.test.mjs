// The model review's web.mjs wiring (docs/adr/0017), on the real server in a throwaway root: the
// two built-ins in the owner's Jobs view (the Undo one "on demand"), none for a member, and Run now
// on both. The models are a node:http stub; claude_cmd names a file that does not exist, so the
// grader can never be the real CLI — and its failure must fail the run with nothing written.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { localDateStr } from '../lib/schedule.mjs';
import { ON_DEMAND } from '../lib/jobstatus.mjs';
import { MODEL_REVIEW_FILENAME } from '../lib/model-review-config.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const MEMBER_TOKEN = 'test-member-token-model-review-01';
// The default tests path is relative to the node root; a throwaway root has no copy, so name the repo's.
const TESTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'model-review', 'tests.json');
const MODELS = [
  { id: 'fast', label: 'Fast One', group: 'Fast', provider: 'ollama', model: 'fast-one:cloud' },
  { id: 'deep', label: 'Deep One', group: 'Deep', provider: 'ollama', model: 'deep-one:cloud' },
  { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', model: null },
];

function startOllama() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/catalog') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: ['fast-one', 'deep-one', 'brand-new'].map((name) => ({ name })) }));
    }
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      calls.push(JSON.parse(b || '{}').model);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'A plain English answer.' }, done: true }) + '\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, calls, port: srv.address().port })));
}

let port, root, web, ollama;
before(async () => {
  ollama = await startOllama();
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: {
    chat_models: MODELS,
    ollama_url: `http://127.0.0.1:${ollama.port}`,
    ollama_catalog_url: `http://127.0.0.1:${ollama.port}/catalog`,
    model_review: { tests: TESTS },
    users: [{ id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
      { id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-kid' }],
  } });
  // The server's own tick stays out of this file: both scheduled jobs are marked done today.
  const today = localDateStr(new Date());
  fs.writeFileSync(path.join(root, 'workspace', 'job-runs.json'), JSON.stringify({ 'model-check': today, 'model-review': today }));
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = path.join(root, 'no-such-claude');   // the grader can never spawn the real CLI
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root);
  await waitReady(port);
});
after(async () => {
  if (web) await stopWeb(web);
  if (ollama) ollama.srv.close();
  if (root) rmTemp(root);
});

const run = async (name, token) => {
  const r = await api(port, `/api/jobs/${name}/run`, { method: 'POST', body: '{}', ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  return { status: r.status, json: await r.json() };
};
const rows = async (token) => (await (await api(port, '/api/jobs', token ? { headers: { authorization: `Bearer ${token}` } } : {})).json());

test('the owner sees the review on its daily time and Undo "on demand"; a member sees neither and cannot run them', async () => {
  const mine = await rows();
  const review = mine.find((r) => r.name === 'model-review');
  const undo = mine.find((r) => r.name === 'model-review-undo');
  assert.equal(review.schedule, 'daily · 每日 03:00', 'model_review.time, default from lib/model-review-config.mjs');
  assert.equal(undo.schedule, ON_DEMAND);
  assert.equal(undo.nextDue, null, 'never scheduled');
  assert.equal(undo.label, '撤销模型评测 · Undo model review');
  const kid = await rows(MEMBER_TOKEN);
  assert.ok(!kid.some((r) => /^model-review/.test(r.name)));
  assert.equal((await run('model-review-undo', MEMBER_TOKEN)).status, 404);
});

test('Run now: no catalog yet says so; Undo with nothing applied says so', async () => {
  const r = await run('model-review');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.body, /No Ollama catalog recorded yet/);
  assert.deepEqual(ollama.calls, [], 'no model was asked');
  const u = await run('model-review-undo');
  assert.equal(u.status, 200);
  assert.match(u.json.body, /Nothing to undo/);
});

test('a grading failure through the real route fails the run, and nothing is written', async () => {
  assert.equal((await run('model-check')).status, 200, 'the daily check records the catalog');
  const before = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
  const r = await run('model-review');
  assert.equal(r.status, 500, JSON.stringify(r.json));
  assert.match(r.json.error, /grading "[a-z-]+" failed: Could not start/);
  assert.ok(ollama.calls.includes('brand-new:cloud'), 'R14 control: the newcomer really was asked, by its callable name');
  assert.ok(ollama.calls.includes('fast-one:cloud'), 'and the current lanes too');
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), before, 'config.json untouched');
  assert.ok(!fs.existsSync(path.join(root, MODEL_REVIEW_FILENAME)), 'no review state written');
  const row = (await rows()).find((x) => x.name === 'model-review');
  assert.equal(row.lastOutcome, 'failed', 'the Jobs view says it failed');
});
