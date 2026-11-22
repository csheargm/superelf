// The model review on a node that calls ollama.com directly (ollama_url https://ollama.com: the VM
// and demo nodes, docs/demo-node.md) · 直连 ollama.com 的节点上的模型评测 (docs/adr/0017 amendment)
// The fake fetch mirrors the real server's two guards: no key → 401, a ':cloud' / '-cloud' name →
// "model not found". A review run must call bare names only, with the key, not re-test the
// configured lanes as newcomers, and write the picked newcomer into chat_models with its bare name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, configPath } from '../lib/config.mjs';
import { modelReviewJobs } from '../lib/model-review.mjs';
import { loadReviewTests } from '../lib/model-review-tests.mjs';
import { MODEL_REVIEW_FILENAME } from '../lib/model-review-config.mjs';
import { MODEL_HEALTH_FILENAME, isDirectCloud, laneModel, catalogName } from '../lib/model-health.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOUD = 'https://ollama.com', LOCAL = 'http://localhost:11434';
const KEY = { authorization: 'Bearer test-ollama-key' };

test('isDirectCloud: ollama.com and its subdomains only; a daemon, a lookalike or no URL is not', () => {
  for (const u of [CLOUD, 'https://ollama.com/', 'https://api.ollama.com']) assert.equal(isDirectCloud(u), true, u);
  for (const u of [LOCAL, 'http://127.0.0.1:11434', 'https://notollama.com', 'https://ollama.com.evil.test', '', undefined, 'x']) assert.equal(isDirectCloud(u), false, String(u));
});

test('laneModel: bare to ollama.com, suffixed to a local daemon (unchanged)', () => {
  assert.equal(laneModel('beam', CLOUD), 'beam');
  assert.equal(laneModel('gpt-oss:120b', CLOUD), 'gpt-oss:120b');
  assert.equal(laneModel('beam', LOCAL), 'beam:cloud');
  assert.equal(laneModel('gpt-oss:120b', LOCAL), 'gpt-oss:120b-cloud');
  assert.equal(laneModel('beam'), 'beam:cloud', 'no URL = the local default');
});

test('catalogName: on ollama.com "x" and "x:cloud" are the same catalog model; locally a bare name is local', () => {
  assert.equal(catalogName('gpt-oss:120b', CLOUD), 'gpt-oss:120b');
  assert.equal(catalogName('gpt-oss:120b-cloud', CLOUD), 'gpt-oss:120b');
  assert.equal(catalogName('beam:cloud', CLOUD), 'beam');
  assert.equal(catalogName('qwen3:8b', LOCAL), null);
  assert.equal(catalogName('qwen3:8b'), null);
  assert.equal(catalogName('beam:cloud', LOCAL), 'beam');
});

// ── a whole review run against a fake ollama.com ───────────────────────────────────────────
const SHIPPED = loadReviewTests(path.join(REPO, 'model-review', 'tests.json'), { appPrompts: { bible: 'BIBLE' } }).tests;
const Q = { 'fast-a': [4, 3], 'fast-b': [3, 3], 'fast-c': [2, 2], 'deep-a': [3, 4], 'deep-b': [3, 4], 'deep-c': [3, 3], star: [5, 2] };
const testOf = (messages) => SHIPPED.find((t) => t.ask === messages.at(-1).content);
function answerFor(model, t) {
  const mark = `[q=${Q[model][t.group === 'Deep' ? 1 : 0]}]`;
  if (t.check === 'meal') return JSON.stringify({ is_food: true, items: [`rice ${mark}`], carb_heavy: true, fried: false, sugary_drink: true, vegetables_present: true });
  if (t.check === 'skill') return `---\nname: quotes-list\ndescription: Use when asked for quotes ${mark}\n---\n` + t.must.map((w, i) => `${i + 1}. Keep the ${w} rule.`).join('\n') + '\n';
  if (t.check === 'json') return JSON.stringify(Object.fromEntries(t.keys.map((k) => [k, k === 'items' ? ['a', 'b', 'c', 'd', 'e'] : `v ${mark}`])));
  return t.lang === 'zh' ? `这是一个简短的回答 ${mark}` : `A short answer ${mark}`;
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fakeOllamaCom(calls) {
  return async (url, opts) => {
    assert.equal(url, `${CLOUD}/api/chat`);
    const body = JSON.parse(opts.body);
    calls.push({ model: body.model, auth: opts.headers.authorization });
    if (opts.headers.authorization !== KEY.authorization) return json(401, { error: 'unauthorized' });
    if (/[:-]cloud$/.test(body.model) || !Q[body.model]) return json(404, { error: `model '${body.model}' not found` });
    const delay = /^(fast|deep)-/.test(body.model) ? 40 : 5;   // the newcomer is faster: this test is about names, not speed
    await new Promise((r) => setTimeout(r, delay));
    return new Response(JSON.stringify({ message: { role: 'assistant', content: answerFor(body.model, testOf(body.messages)) }, done: true }) + '\n',
      { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
  };
}
// The grader, in process: each answer scored by its hidden [q=N] mark.
async function grade({ prompt }) {
  const tag = (/<<<ANSWER [A-Z] ([0-9a-f]+)>>>/.exec(prompt) || [])[1];
  const re = new RegExp(`<<<ANSWER ([A-Z]) ${tag}>>>\\n([\\s\\S]*?)\\n<<<END \\1 ${tag}>>>`, 'g');
  const out = {}; let m;
  while ((m = re.exec(prompt))) { const q = /\[q=(\d)\]/.exec(m[2]); out[m[1]] = q ? Number(q[1]) : 1; }
  return { ok: true, text: JSON.stringify(out) };
}

test('a review on an ollama.com node calls bare names with the key and writes chat_models with bare names', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mrcloud-'));
  try {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    const lane = (id, group, model) => ({ id, label: id.toUpperCase(), group, provider: 'ollama', model });
    const LANES = [lane('fast1', 'Fast', 'fast-a'), lane('fast2', 'Fast', 'fast-b'), lane('fast3', 'Fast', 'fast-c'),
      lane('deep1', 'Deep', 'deep-a'), lane('deep2', 'Deep', 'deep-b'), lane('deep3', 'Deep', 'deep-c')];
    fs.writeFileSync(configPath(root), JSON.stringify({ default_project: 'assistant', projects: { assistant: { dir: 'workspace' } },
      web_token: 'test-web-token-abcdefgh', chat_models: LANES, ollama_url: CLOUD,
      users: [{ id: 'owner', name: 'Owner', role: 'owner', token: 'test-owner-token-mr-0123456789', workspace: 'workspace' }],
      model_review: { concurrency: 4, call_timeout_s: 10, agent_lanes: false, tests: path.join(REPO, 'model-review', 'tests.json') } }, null, 2));
    const catalog = ['fast-a', 'fast-b', 'fast-c', 'deep-a', 'deep-b', 'deep-c', 'star'];
    fs.writeFileSync(path.join(root, MODEL_HEALTH_FILENAME), JSON.stringify({ checked: 1, gone: {}, catalog, unknown: [], catalogError: null }));
    // Not the first review, so the run applies its change (a first review only reports).
    fs.writeFileSync(path.join(root, MODEL_REVIEW_FILENAME), JSON.stringify({ reviewedAt: 1, catalogSeen: catalog, undo: null, declined: [] }));
    const cfg = await loadConfig(root, { readOnly: true });
    const calls = [];
    const jobs = modelReviewJobs({ cfg, root, healthFile: () => path.join(root, MODEL_HEALTH_FILENAME), ask: grade,
      auth: () => KEY, fetchImpl: fakeOllamaCom(calls) });
    const out = await jobs['model-review'].run(cfg.users[0], { manual: true });
    assert.ok(out && out.body, 'a briefing');
    assert.deepEqual(calls.filter((c) => /[:-]cloud$/.test(c.model)), [], 'no suffixed name reached ollama.com');
    assert.ok(calls.every((c) => c.auth === KEY.authorization), 'every call carries the key');
    assert.deepEqual([...new Set(calls.map((c) => c.model))].sort(), [...catalog].sort(), 'each lane once, the newcomer once — no lane re-tested as a newcomer');
    const written = JSON.parse(fs.readFileSync(configPath(root), 'utf8')).chat_models;
    const models = written.filter((l) => l.provider === 'ollama').map((l) => l.model);
    assert.ok(models.includes('star'), `star joined Fast with its bare name: ${JSON.stringify(models)}`);
    assert.deepEqual(models.filter((m) => /[:-]cloud$/.test(m)), [], 'no suffixed name written');
  } finally { rmTemp(tmp); }
});
