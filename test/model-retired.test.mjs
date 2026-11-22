// DEFECT — A RETIRED OLLAMA MODEL FAILED EVERY TURN, AND NOTHING ON THE NODE KNEW.
//
// WHAT WAS PROVEN BROKEN (measured 2026-10-12, Ollama 0.34.3)
//   Ollama retired deepseek-v4-flash:0731 (the Fast default most apps open on) and qwen3.5:397b on
//   2026-09-25. /api/chat answers 410 {"error":"… was retired at 2026-09-25 …"}. web.mjs streamOllama
//   threw `Ollama HTTP 410` and dropped the body, so the user saw a bare status and no reason, on
//   every turn, for as long as the lane stayed configured. An id dropped from chat_models went to
//   the Claude agent lane without a word.
//
// WHAT THIS FILE ASSERTS, end to end over real HTTP
//   The real web.mjs in a throwaway root, a real node:http Ollama stub answering each model with
//   the status and body the real server sent, and the scheduled job run through its real route:
//   1. a 410 reaches the user as the server's own reason, in both languages;
//   2. the lane is then off the chooser, and a turn still naming it (a stale tab, a stored
//      appModels id) falls back to the default with a status line — as does an id the config
//      no longer has at all;
//   3. the `model-check` job finds a lane gone, says so once, notices it come back, lists new
//      catalog models, follows a config reload, survives a damaged record, and runs for ONE owner;
//   4. a profile that still stores an id the config dropped can still save new choices (R13 B1).
// R14: the control runs first — the stub must really be reached, or every assertion below proves
// only that nothing was reachable. claude_cmd points at a file that does not exist, so a turn that
// wrongly falls to the agent lane fails visibly and can never spawn the real CLI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { localDateStr } from '../lib/schedule.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const MODELS = [
  { id: 'fast', label: 'Fast One', group: 'Fast', provider: 'ollama', model: 'fast-one:cloud' },
  { id: 'old', label: 'Old Model', group: 'Fast', provider: 'ollama', model: 'old-model:0731-cloud' },
  { id: 'deep', label: 'Deep One', group: 'Deep', provider: 'ollama', model: 'deep-one:cloud' },
  { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', model: null },
];
// The bodies the real Ollama sent (2026-10-12), with the model names swapped.
const RETIRED = { status: 410, body: '{"error":"old-model:0731 was retired at 2026-09-25 00:00:00 -0700 PDT (ref: de874b70-18cb-466d-8627-09a750d0937d)"}' };
const NOT_FOUND = { status: 404, body: '{"error": "model \'deep-one\' not found"}' };
const MEMBER_TOKEN = 'test-member-token-model-check-0001';
const OWNER2_TOKEN = 'test-owner2-token-model-check-001';

// A real Ollama stand-in: per-model answers, the real NDJSON stream for a 200, and a catalog.
function startOllama() {
  const answers = {};          // model → { status, body }; absent = 200 + a streamed answer
  const calls = [];
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/catalog') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: ['fast-one', 'deep-one', 'brand-new-model', 'another-new'].map((name) => ({ name })) }));
    }
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      calls.push(body);
      const a = answers[body.model];
      if (a) { res.writeHead(a.status, { 'content-type': 'application/json' }); return res.end(a.body); }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: `ANSWERED-BY:${body.model}` }, done: true }) + '\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, calls, answers, port: srv.address().port })));
}

let port, root, web, ollama;
before(async () => {
  ollama = await startOllama();
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: {
    chat_models: MODELS,
    ollama_url: `http://127.0.0.1:${ollama.port}`,
    ollama_catalog_url: `http://127.0.0.1:${ollama.port}/catalog`,
    model_check_time: '05:30',
    users: [
      { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
      { id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-kid' },
      { id: 'owner2', name: 'Owner Two', role: 'owner', token: OWNER2_TOKEN, workspace: 'workspace-owner2' },
    ],
  } });
  // The server's own scheduler fires a due job on its 60 s tick. Marking model-check done today
  // keeps that tick out of this file, so only the Run-now calls below change the record. Run now
  // ignores the mark — a person asked.
  // model-review too (docs/adr/0017): it reads the catalog this file's stub serves.
  fs.writeFileSync(path.join(root, 'workspace', 'job-runs.json'), JSON.stringify({ 'model-check': localDateStr(new Date()), 'model-review': localDateStr(new Date()) }));
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = path.join(root, 'no-such-claude');   // a wrong fall to the agent lane fails, never spawns the real CLI
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root);
  await waitReady(port);
});
after(async () => {
  if (web) await stopWeb(web);
  if (ollama) ollama.srv.close();
  if (root) rmTemp(root);
});

async function chat(body) {
  const before = ollama.calls.length;
  const res = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(res.status, 200, `chat should stream, got ${res.status}`);
  const events = (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    statuses: events.filter((e) => e.type === 'status').map((e) => e.text),
    error: events.find((e) => e.type === 'error'),
    done: events.find((e) => e.type === 'done'),
    models: ollama.calls.slice(before).map((c) => c.model),
  };
}
const offered = async () => (await (await api(port, '/api/models')).json()).map((m) => m.id);
const auditEvents = (ev) => fs.readFileSync(path.join(root, 'audit.log'), 'utf8').split('\n')
  .filter((l) => l.includes(`"${ev}"`)).map((l) => JSON.parse(l));
const profileFile = () => path.join(root, 'workspace', 'profile.json');
const runCheck = async (token) => {
  const r = await api(port, '/api/jobs/model-check/run', { method: 'POST', body: '{}', ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  return { status: r.status, json: await r.json() };
};

test('R14 control: a served lane really reaches the Ollama stub, and every lane is offered', async () => {
  const r = await chat({ message: 'hello', model: 'fast' });
  assert.deepEqual(r.models, ['fast-one:cloud'], 'the stub was reached over HTTP with the lane\'s model');
  assert.equal(r.done.text, 'ANSWERED-BY:fast-one:cloud');
  assert.deepEqual(await offered(), ['fast', 'old', 'deep', 'claude']);
});

test('a 410 from Ollama reaches the user as the server\'s reason, in both languages', async () => {
  ollama.answers['old-model:0731-cloud'] = RETIRED;
  const r = await chat({ message: 'hello', model: 'old', app: 'bible' });
  assert.deepEqual(r.models, ['old-model:0731-cloud'], 'the turn really asked the retired model');
  assert.ok(r.error, 'the turn ends in a failure, not an empty answer');
  assert.match(r.error.text, /Ollama HTTP 410/, 'the status is still named');
  assert.match(r.error.text, /was retired at 2026-09-25/, `and so is the server's reason — got: ${r.error.text}`);
  assert.match(r.error.text, /已被 Ollama 停用/, 'with a Chinese line');
  const seen = auditEvents('model-gone');
  assert.equal(seen.length, 1, 'the sighting is audited once');
  assert.equal(seen[0].model, 'old-model:0731-cloud');
  assert.equal(seen[0].status, 410);
});

test('once seen gone, the lane leaves the chooser and a turn still naming it falls back, saying so', async () => {
  assert.deepEqual(await offered(), ['fast', 'deep', 'claude'], 'the chooser no longer offers the retired lane');
  // A stale tab, or an app whose profile.appModels still stores the id, keeps sending it.
  const r = await chat({ message: 'hello again', model: 'old', app: 'bible' });
  assert.deepEqual(r.models, ['fast-one:cloud'], 'the default — the first lane still served — answered');
  assert.equal(r.error, undefined, 'not a failure on every turn');
  assert.ok(r.statuses.some((s) => /Old Model is retired 2026-09-25 — using Fast One/.test(s) && /改用 Fast One/.test(s)),
    `the move is stated: ${JSON.stringify(r.statuses)}`);
});

test('a stored model id this config no longer has falls back to the default, not silently to the agent', async () => {
  // e.g. `qwen`, stored in appModels before the config dropped it.
  const r = await chat({ message: 'hi', model: 'qwen', app: 'bible' });
  assert.deepEqual(r.models, ['fast-one:cloud'], 'the default fast lane answered');
  assert.ok(r.statuses.some((s) => /"qwen" is no longer offered — using Fast One/.test(s)), `stated: ${JSON.stringify(r.statuses)}`);
  assert.equal(r.done && r.done.ok, true);
});

test('a profile still storing a dropped id can save new choices; a NEW unknown id is still refused', async () => {
  // The shell sends the WHOLE appModels map on every pick. One stale entry used to refuse the
  // map, so after a config dropped `qwen`, no app could remember any choice again.
  const prof = fs.existsSync(profileFile()) ? JSON.parse(fs.readFileSync(profileFile(), 'utf8')) : {};
  fs.writeFileSync(profileFile(), JSON.stringify({ ...prof, appModels: { bible: 'qwen' } }, null, 2));
  const put = (appModels) => api(port, '/api/profile', { method: 'PUT', body: JSON.stringify({ appModels }) });
  const ok = await put({ bible: 'qwen', notes: 'fast' });
  assert.equal(ok.status, 200, `the new pick is saved beside the stale one: ${await ok.clone().text()}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(profileFile(), 'utf8')).appModels, { bible: 'qwen', notes: 'fast' });
  const bad = await put({ bible: 'qwen', notes: 'gpt-9' });
  assert.equal(bad.status, 400, 'an id this node never offered is still refused loudly');
  assert.match((await bad.json()).error, /Unknown model · 未知模型: gpt-9/);
  const moved = await put({ bible: 'qwen-2' });
  assert.equal(moved.status, 400, 'changing an entry TO an unknown id is a new store, and refused');
});

test('the scheduled model-check job: finds a lane gone, briefs it, records new catalog models without briefing them', async () => {
  ollama.answers['deep-one:cloud'] = NOT_FOUND;
  const r = await runCheck();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const body = r.json.body || '';
  assert.match(body, /Deep One \(deep-one:cloud\) — HTTP 404: model 'deep-one' not found/, body);
  assert.match(body, /Old Model \(old-model:0731-cloud\) — HTTP 410: old-model:0731 was retired/,
    'the lane a chat turn found first is still briefed — the turn must not silence the owner\'s report');
  assert.ok(!/brand-new-model|another-new|New on Ollama/.test(body),
    `new catalog models are the weekly model review's to report, with scores (docs/adr/0017): ${body}`);
  assert.deepEqual(await offered(), ['fast', 'claude'], 'both gone lanes are off the chooser');
  const mh = await import('../lib/model-health.mjs').catch(() => null);
  assert.ok(mh, 'lib/model-health.mjs exists');
  const rec = JSON.parse(fs.readFileSync(path.join(root, mh.MODEL_HEALTH_FILENAME), 'utf8'));
  assert.deepEqual(Object.keys(rec.gone).sort(), ['deep-one:cloud', 'old-model:0731-cloud'], 'the record is node-wide, at the root');
  assert.deepEqual(rec.catalog, ['another-new', 'brand-new-model', 'deep-one', 'fast-one'], 'the arrivals are recorded for the review');
});

test('a quiet re-run says nothing new, and does not claim every lane answers', async () => {
  const r = await runCheck();
  assert.equal(r.status, 200);
  assert.match(r.json.body, /No change · 无变化 — 1 of 3 Ollama lanes answer/, r.json.body);
  assert.match(r.json.body, /Still gone · 仍不可用: Old Model, Deep One/);
});

test('a lane that answers again is briefed and offered again', async () => {
  delete ollama.answers['deep-one:cloud'];
  const r = await runCheck();
  assert.match(r.json.body, /Answering again · 已恢复:\n- Deep One \(deep-one:cloud\)/, r.json.body);
  assert.ok(!/brand-new-model|another-new/.test(r.json.body), 'catalog models are never briefed here (docs/adr/0017)');
  assert.deepEqual(await offered(), ['fast', 'deep', 'claude']);
});

test('the job is on the owner\'s schedule from config, and only ONE owner, never a member, gets it', async () => {
  const rows = await (await api(port, '/api/jobs')).json();
  const row = rows.find((x) => x.name === 'model-check');
  assert.ok(row, 'the owner sees the job');
  assert.match(row.schedule, /05:30/, `the time comes from config model_check_time: ${row.schedule}`);
  assert.ok(row.nextDue, 'and the scheduler has a next run for it');
  const kidRows = await (await api(port, '/api/jobs', { headers: { authorization: `Bearer ${MEMBER_TOKEN}` } })).json();
  assert.ok(Array.isArray(kidRows), 'the member view loads');
  assert.ok(!kidRows.some((x) => x.name === 'model-check'), 'a member has no model-check');
  assert.equal((await runCheck(MEMBER_TOKEN)).status, 404, 'and cannot run it');
  const o2 = await (await api(port, '/api/jobs', { headers: { authorization: `Bearer ${OWNER2_TOKEN}` } })).json();
  assert.ok(!o2.some((x) => x.name === 'model-check'), 'a second owner does not run it too — one probe set, one briefing');
  assert.equal((await runCheck(OWNER2_TOKEN)).status, 404);
});

test('a config reload moves the job to the new time, with no restart', async () => {
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, model_check_time: '04:45' }, null, 2));
  const r = await api(port, '/api/admin/reload-config', { method: 'POST', body: '{}' });
  assert.equal(r.status, 200, await r.clone().text());
  const row = (await (await api(port, '/api/jobs')).json()).find((x) => x.name === 'model-check');
  assert.match(row.schedule, /04:45/, `the job reads the reloaded config: ${row.schedule}`);
});

test('a damaged record: the chooser offers every lane, says why in the audit log, and Run now rebuilds it', async () => {
  const mh = await import('../lib/model-health.mjs').catch(() => null);
  assert.ok(mh, 'lib/model-health.mjs exists');
  ollama.answers['deep-one:cloud'] = NOT_FOUND;
  await runCheck();                                              // deep is gone again…
  assert.ok(!(await offered()).includes('deep'), 'R14 control: the record really hides a lane');
  fs.writeFileSync(path.join(root, mh.MODEL_HEALTH_FILENAME), '{not json');
  assert.deepEqual(await offered(), ['fast', 'old', 'deep', 'claude'], 'nothing known — the pre-check behaviour, not a broken chooser');
  await offered(); await chat({ message: 'still fine?', model: 'fast' });
  assert.equal(auditEvents('model-health-error').length, 1,
    'the damage is in the audit log once — not one entry per chat turn and per chooser load');
  const r = await runCheck();
  assert.match(r.json.body, /model-health\.json was unreadable and has been rebuilt/, r.json.body);
  assert.deepEqual(await offered(), ['fast', 'claude'], 'the rebuilt record hides the gone lanes again');
});
