// The model review as the owner meets it (docs/adr/0017), through the REAL scheduler core
// (lib/jobruns.mjs jobsTick), the real job store (lib/autonomy.mjs runJob), the real config loader
// and watcher, and the real claude and codex runners (lib/runner.mjs, lib/codex.mjs) driving a FAKE
// claude CLI (the grader, and the Claude agent lane) and a FAKE codex CLI (the GPT agent lane).
// The models are a node:http stub speaking Ollama's NDJSON stream; nothing reaches the real Ollama,
// ollama.com, Claude, Codex or email. Each answer carries a hidden quality mark [q=N], and the fake
// grader scores by it, so the expected changes are known in advance.
//   day 1  first review: reports what it WOULD change, changes nothing; the agent lanes are in the
//          table, compared only (docs/adr/0017 decision 10)
//   day 2  not due: no briefing
//   day 3  a new catalog model: due; both groups change; a pinned and a default lane are kept
//          an edit since → Undo refuses; Undo then restores; the undone models are not retried
//   then   a grading failure, and Ollama down: each fails the run and writes nothing
// Day 1 also sends the briefing through the real notifier to a stubbed AgentMail: one email, the
// charts as its HTML part and the briefing text as its plain-text part (docs/adr/0020).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobsTick } from '../lib/jobruns.mjs';
import { applyJobPrefs, builtinsFor } from '../lib/jobs/prefs.mjs';
import { nodeOwnerId } from '../lib/owner.mjs';
import { runJob } from '../lib/autonomy.mjs';
import { loadConfig, configPath } from '../lib/config.mjs';
import { watchConfig } from '../lib/config-watch.mjs';
import { runClaude } from '../lib/runner.mjs';
import { runCodex } from '../lib/codex.mjs';
import { laneRunner, NO_STREAM_NOTE, AGENT_TABLE_NOTE } from '../lib/model-review-agent.mjs';
import { modelReviewJobs } from '../lib/model-review.mjs';
import { loadReviewTests } from '../lib/model-review-tests.mjs';
import { MODEL_REVIEW_FILENAME } from '../lib/model-review-config.mjs';
import { MODEL_HEALTH_FILENAME } from '../lib/model-health.mjs';
import { writeFakeReviewClis } from './helpers-model-review.mjs';
import { stubAgentMail, AM_SENT } from './helpers.mjs';
import { notifyBriefingEmail } from '../lib/notify.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mrflow-'));
const root = path.join(tmp, 'root');
const lane = (id, group, model) => ({ id, label: id.toUpperCase(), group, provider: 'ollama', model });
const LANES = [lane('fast1', 'Fast', 'fast-a:cloud'), lane('fast2', 'Fast', 'fast-b:cloud'), lane('fast3', 'Fast', 'fast-c:cloud'),
  lane('deep1', 'Deep', 'deep-a:cloud'), lane('deep2', 'Deep', 'deep-b:cloud'), lane('deep3', 'Deep', 'deep-c:cloud'),
  { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', model: null }, { id: 'gpt', label: 'GPT', group: 'Agent', provider: 'codex', model: null }];
// Quality per group of tests; star is a Fast model, nova a Deep one. broken answers 400 (measured
// for a decision model on 2026-10-17); sloppy breaks the JSON our apps parse.
const Q = { 'fast-a:cloud': [4, 3], 'fast-b:cloud': [3, 3], 'fast-c:cloud': [2, 2], 'deep-a:cloud': [3, 4], 'deep-b:cloud': [3, 4],
  'deep-c:cloud': [3, 3], 'star:cloud': [5, 2], 'nova:cloud': [2, 5], 'sloppy:cloud': [5, 5], 'agent:claude': [5, 5], 'agent:gpt': [4, 4] };
const DECISION = { status: 400, body: '{"error":"broken:7b is a decision model and only supports /v1/systemone"}' };
// Newcomers answer faster than the lanes, by a margin no timer jitter can flip: the slowdown guard
// compares seconds to first text, and this file is about who replaces whom, not about speed.
const delayOf = (model) => (/^(fast|deep)-/.test(model) ? 40 : 5);

const SHIPPED = loadReviewTests(path.join(REPO, 'model-review', 'tests.json'), { appPrompts: { bible: 'BIBLE' } }).tests;
const testOf = (messages) => SHIPPED.find((t) => t.ask === messages.at(-1).content);
function answerFor(model, t) {
  const q = Q[model][t.group === 'Deep' ? 1 : 0], mark = `[q=${q}]`;
  if (t.check === 'meal') return JSON.stringify({ is_food: true, items: [`rice ${mark}`], carb_heavy: true, fried: false, sugary_drink: true, vegetables_present: true });
  if (t.check === 'skill') return `---\nname: quotes-list\ndescription: Use when asked for quotes ${mark}\n---\n` + t.must.map((w, i) => `${i + 1}. Keep the ${w} rule.`).join('\n') + '\n';
  if (t.check === 'json') return (model === 'sloppy:cloud' ? 'Sure! ' : '') + JSON.stringify(Object.fromEntries(t.keys.map((k) => [k, k === 'items' ? ['a', 'b', 'c', 'd', 'e'] : `v ${mark}`])));
  return t.lang === 'zh' ? `这是一个简短的回答 ${mark}` : `A short answer ${mark}`;
}

let ollama, calls = [], gate = null;   // gate: a promise every answer waits on (holds a review mid-run)
function startOllama() {
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', async () => {
      const body = JSON.parse(b);
      calls.push(body);
      if (body.model === 'broken:7b-cloud') { res.writeHead(DECISION.status, { 'content-type': 'application/json' }); return res.end(DECISION.body); }
      if (!Q[body.model]) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(`{"error":"model '${body.model}' not found"}`); }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: '', thinking: '…' }, done: false }) + '\n');
      await gate;
      await new Promise((r) => setTimeout(r, delayOf(body.model)));
      res.end(JSON.stringify({ message: { role: 'assistant', content: answerFor(body.model, testOf(body.messages)) }, done: true }) + '\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// The agent lanes' answers by the test's ask, for the fake claude (streamed) and codex (final message
// only) CLIs the real runners launch, beside the fake grader: test/helpers-model-review.mjs.
const AGENT_ANSWERS = path.join(tmp, 'agent-answers.json');
fs.writeFileSync(AGENT_ANSWERS, JSON.stringify(SHIPPED.filter((t) => t.group !== 'Vision').map((t) => ({ ask: t.ask, claude: answerFor('agent:claude', t), codex: answerFor('agent:gpt', t) }))));
const GRADER_LOG = path.join(tmp, 'grader.jsonl'), GRADER_MODE = path.join(tmp, 'grader-mode');
fs.mkdirSync(path.join(tmp, 'bin'));
const { claude: FAKE_CLAUDE, codex: FAKE_CODEX } = writeFakeReviewClis({ dir: path.join(tmp, 'bin'), log: GRADER_LOG, mode: GRADER_MODE, answers: AGENT_ANSWERS });

let cfg, jobs, users;
const healthFile = path.join(root, MODEL_HEALTH_FILENAME), stateFile = path.join(root, MODEL_REVIEW_FILENAME);
const CATALOG = ['fast-a', 'fast-b', 'fast-c', 'deep-a', 'deep-b', 'deep-c', 'star', 'broken:7b', 'sloppy'];
const setCatalog = (names) => fs.writeFileSync(healthFile, JSON.stringify({ checked: 1, gone: {}, catalog: names, unknown: [], catalogError: null }));
const readCfgFile = () => fs.readFileSync(configPath(root), 'utf8');
const day = (d) => new Date(2026, 9, d, 3, 30);
let clock = day(20).getTime();
const briefings = [];

before(async () => {
  ollama = await startOllama();
  for (const w of ['workspace', 'workspace-kid', 'workspace/jobs']) fs.mkdirSync(path.join(root, w), { recursive: true });
  // A job the owner wrote that pins deep3: the review must never remove that lane.
  fs.writeFileSync(path.join(root, 'workspace/jobs/weekly-digest.json'), JSON.stringify({ id: 'weekly-digest', title: 'Digest',
    schedule: { time: '06:30' }, plan: { kind: 'tool', tool: 'research', args: { question: 'x' } }, model: 'deep3' }));
  fs.writeFileSync(configPath(root), JSON.stringify({ default_project: 'assistant', projects: { assistant: { dir: 'workspace' } },
    web_token: 'test-web-token-abcdefgh', claude_cmd: FAKE_CLAUDE, chat_models: LANES, ollama_url: `http://127.0.0.1:${ollama.address().port}`,
    users: [{ id: 'owner', name: 'Owner', role: 'owner', token: 'test-owner-token-mr-0123456789', workspace: 'workspace' },
      { id: 'kid', name: 'Kid', role: 'member', token: 'test-member-token-mr-012345678', workspace: 'workspace-kid' }],
    model_review: { concurrency: 4, call_timeout_s: 10, tests: path.join(REPO, 'model-review', 'tests.json') }, kept_for_the_owner: { untouched: [1, 2, 3] } }, null, 2));
  setCatalog(CATALOG);
  cfg = await loadConfig(root, { readOnly: true });
  users = cfg.users;
  const built = modelReviewJobs({ cfg, root, healthFile: () => healthFile, userDirs: () => users.map((u) => u.workspace), now: () => clock,
    ask: ({ args, prompt, user, timeoutMs }) => runClaude({ claudeCmd: cfg.claude_cmd, extraArgs: args, cwd: user.workspace, prompt, timeoutMs }),
    runLane: laneRunner({ cfg, wsDir: (u) => u.workspace, enqueue: (fn) => fn(), runClaude, runCodex, codexCmd: FAKE_CODEX, claudeArgs: () => cfg.claude_args }) });
  jobs = (u) => applyJobPrefs(builtinsFor(built, u.id === nodeOwnerId(users)), {});
});
after(() => { ollama.closeAllConnections(); ollama.close(); rmTemp(tmp); });

// One scheduler tick at `when`, as web.mjs runs it: due jobs only, the briefing stored by runJob.
async function tick(when) {
  clock = when.getTime();
  const audit = [];
  await jobsTick({ users, jobs, now: when, audit: (ev, f) => audit.push({ ev, ...f }),
    runJobFor: async (u, job) => { const out = await runJob(u, job, { run: () => job.run(u, { manual: false }) }); if (out.briefing) briefings.push({ who: u.id, ...out.briefing }); return out; } });
  return audit;
}
const runNow = async (name) => jobs(users[0])[name].run(users[0], { manual: true });
const graderRuns = () => fs.readFileSync(GRADER_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('day 1: the first review on a node reports what it would change, and changes nothing', async () => {
  const before = readCfgFile();
  const audit = await tick(day(20));
  assert.deepEqual(audit.filter((a) => a.ev === 'job-failed'), [], JSON.stringify(audit));
  assert.deepEqual(briefings.map((b) => `${b.who}:${b.job}`), ['owner:model-review'], 'one review, for the node owner only');
  const body = briefings[0].body;
  assert.match(body, /^\*\*First review: report only, nothing changed/, 'the answer leads');
  assert.match(body, /Would change · 将更换:\n- Fast: FAST3 \(fast-c:cloud\) -> star \(star:cloud\)/, body);
  assert.match(body, /- 2 failed the quick round · 2 个在快速轮中失败: .*broken:7b \(fast-zh-short: Ollama HTTP 400 — broken:7b is a decision model/);
  assert.match(body, /sloppy \(fast-json-list: not valid JSON\)/);
  assert.equal(readCfgFile(), before, 'config.json untouched');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).reviewedAt, day(20).getTime());
});

test('day 1, agent lanes: Claude and GPT are in the table with their scores, Codex says whole answer, and neither is a change', () => {
  const body = briefings[0].body;
  assert.match(body, /\| Claude \| Agent \| 5\.0 \| 5\.0 \| — \| \d+\.\d \| 0\/9 \|/, body);
  assert.match(body, new RegExp(`\\| GPT \\| Agent \\| 4\\.0 \\| 4\\.0 \\| — \\| \\d+\\.\\d \\(${NO_STREAM_NOTE.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}\\) \\| 0\\/9 \\|`), body);
  assert.ok(body.includes(`${AGENT_TABLE_NOTE}; GPT: first word = ${NO_STREAM_NOTE}; Vision not measured · 看图未测.`), body);
  assert.match(body, /Cost · 成本: \d+ Ollama calls, 18 agent calls, \d+ Claude grading calls/, '2 lanes x 9 text tests, apart from the Ollama budget');
  assert.ok(!/(->|\+) (Claude|GPT)/.test(body), 'no change names an agent lane');
  const laneRuns = graderRuns().filter((r) => !r.stdin.includes('<<<ANSWER'));
  assert.equal(laneRuns.length, 9, 'the Claude lane answered the 9 text tests, not the picture');
  for (const r of laneRuns) {
    assert.ok(r.argv.includes('--append-system-prompt'), 'the system pieces reach the claude CLI as its system prompt');
    assert.ok(!r.argv.includes('--tools='), 'measured as the chat lane runs, with its tools');
  }
  assert.ok(graderRuns().some((r) => r.stdin.includes('<<<ANSWER') && /\[q=5\]/.test(r.stdin)), 'an agent answer was graded blind in the same batch');
  assert.match(briefings[0].html, /Claude<br><span[^>]*>agent, compared only · 代理，仅作对比<\/span>/, 'the speed chart draws the agent lane, tagged');
});

test('day 1, emailed: one email with the charts as HTML and the briefing text as the plain-text part', async () => {
  const b = briefings[0];
  assert.match(b.html, /^<!doctype html>/, 'the stored briefing carries the email\'s HTML part');
  const { mail, calls: sent } = stubAgentMail([{ status: 200, body: AM_SENT }]);
  const out = await notifyBriefingEmail({ mail, email: 'owner@example.com', user: users[0], briefing: b, audit: () => {} });
  assert.deepEqual(out, { sent: true });
  assert.equal(sent.length, 1, 'one email');
  const { subject, text, html } = sent[0].data;
  assert.equal(subject, '模型评测 · Model review');
  assert.match(text, /^First review: report only, nothing changed/, 'plain-text fallback, verdict first');
  assert.match(html, /First review: report only, nothing changed/);
  assert.match(html, /Fast tasks \(5\) · 快速任务 — quality 0-5, higher is better/);
  assert.match(html, /Speed · 速度 — seconds to the first word, shorter is better/);
  assert.match(html, /star<br><span[^>]*>new, picked for Fast · 新，入选 Fast<\/span>/, 'the newcomer it would pick is marked');
  assert.ok(!/<script|<svg|<img|<style|https?:\/\//i.test(html), 'Gmail-safe');
});

test('R14: every model got the same messages per test, and the grader saw no model name, no tool, thinking off', () => {
  const byTest = {};
  for (const c of calls) { const t = testOf(c.messages).id; (byTest[t] ||= new Set()).add(JSON.stringify(c.messages)); }
  for (const [t, set] of Object.entries(byTest)) assert.equal(set.size, 1, `${t}: identical prompts for every model`);
  for (const r of graderRuns().filter((x) => !x.stdin.includes('<<<ANSWER'))) {
    const t = SHIPPED.find((x) => x.ask === r.stdin);
    assert.ok(t, 'the Claude lane got the same user message as the Ollama models');
    const sent = calls.find((c) => testOf(c.messages).id === t.id).messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    assert.equal(r.argv[r.argv.indexOf('--append-system-prompt') + 1], sent, 'and the same system pieces the Ollama models got');
  }
  assert.ok(calls.some((c) => c.model === 'fast-a:cloud' && testOf(c.messages).id === 'deep-reasoning'), 'current lanes ran round 2 too');
  const runs = graderRuns().filter((r) => r.stdin.includes('<<<ANSWER'));   // the Claude lane's own answers share the log
  assert.ok(runs.length >= SHIPPED.length - 1, `one grading call per test: ${runs.length}`);
  for (const r of runs) {
    for (const m of Object.keys(Q)) assert.ok(!r.stdin.includes(m), `no model name reaches the grader: ${m}`);
    assert.ok(r.argv.includes('--tools=') && r.argv.includes('--strict-mcp-config'), 'no tool');
    assert.equal(r.argv[r.argv.indexOf('--settings') + 1], '{"alwaysThinkingEnabled":false}', 'thinking off');
  }
  assert.ok(runs.some((r) => /<<<ANSWER [A-Z] [0-9a-f]+>>>\n[^<]*\[q=4\]/.test(r.stdin)), 'a current lane graded in the same batch');
});

test('Undo with nothing applied says so; day 2 is not due and stays quiet', async () => {
  assert.match((await runNow('model-review-undo')).body, /Nothing to undo/);
  const n = briefings.length;
  const audit = await tick(day(21));
  assert.equal(briefings.length, n, 'no briefing on a day that is not due');
  assert.equal(audit.find((a) => a.ev === 'job-run' && a.job === 'model-review').skipped, true);
});

test('day 3: a new catalog model makes it due; both groups change, keeping the default and the pinned lanes', async () => {
  let reloads = 0;
  const unwatch = watchConfig(configPath(root), async () => { const fresh = await loadConfig(root, { readOnly: true }); delete fresh.users; Object.assign(cfg, fresh); reloads += 1; }, { intervalMs: 50 });
  setCatalog([...CATALOG, 'nova']);
  await tick(day(22));
  const body = briefings.at(-1).body;
  assert.match(body, /^\*\*Changed: 2 new models in your chooser/, body);
  const raw = JSON.parse(readCfgFile());
  assert.deepEqual(raw.chat_models.map((l) => l.id), ['fast1', 'fast2', 'star', 'deep1', 'nova', 'deep3', 'claude', 'gpt'],
    'fast3 and deep2 replaced in place; fast1 (the default) and deep3 (pinned by a job) kept; Claude and Codex untouched');
  assert.deepEqual(raw.kept_for_the_owner, { untouched: [1, 2, 3] }, 'every other key kept');
  assert.equal(raw.users.length, 2);
  assert.match(body, /\| Model · 模型 \| Use · 用途 \| Fast \| Deep \| Vision · 看图 \|/);
  assert.match(body, /Cost · 成本: \d+ Ollama calls, \d+ agent calls, \d+ Claude grading calls/);
  assert.match(body, /Undo · 撤销: Your profile > Jobs/);
  const deadline = Date.now() + 5000;
  while (!reloads && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  unwatch();
  assert.ok(reloads >= 1, 'the config watcher reloaded the written file');
  assert.ok(cfg.chat_models.some((l) => l.id === 'nova'), 'and the live config now offers it, with no restart');
});

// Regression: a second review or an Undo overlapping a long review read model-review.json at its
// start and wrote it at its end, so the slower run put back a stale record and Undo was lost.
test('while a review runs, Run now again and Undo are refused, a scheduled turn stays quiet, and the undo record survives', async () => {
  const cfgBefore = readCfgFile(), undoBefore = JSON.parse(fs.readFileSync(stateFile, 'utf8')).undo;
  assert.ok(undoBefore, 'day 3 left an undo record');
  let open;
  gate = new Promise((r) => { open = r; });
  const n = calls.length;
  const first = runNow('model-review');
  try {
    while (calls.length === n) await new Promise((r) => setTimeout(r, 10));   // the review is mid-run
    await assert.rejects(runNow('model-review'), /a model review is already running; nothing done/);
    await assert.rejects(runNow('model-review-undo'), /a model review is already running; nothing done.* · 模型评测正在进行/);
    const nb = briefings.length;
    const audit = await tick(day(29));
    assert.deepEqual(audit.filter((a) => a.ev === 'job-failed'), [], JSON.stringify(audit));
    assert.equal(audit.find((a) => a.ev === 'job-run' && a.job === 'model-review').skipped, true, 'the scheduled turn yields to the run in progress');
    assert.equal(briefings.length, nb);
  } finally { open(); gate = null; }   // a failed assertion must not leave the review held for the next tests
  assert.match((await first).body, /^\*\*No change: your current models are still the best fit/);
  assert.equal(readCfgFile(), cfgBefore, 'neither the refused review nor the refused Undo touched config.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).undo, undoBefore, 'the undo record is still there for Undo');
});

test('Undo refuses over an edit made since, then restores the list and never retries what it took back', async () => {
  const applied = readCfgFile();
  const edited = JSON.parse(applied);
  edited.chat_models[0].label = 'Mine now';
  fs.writeFileSync(configPath(root), JSON.stringify(edited, null, 2));
  await assert.rejects(runNow('model-review-undo'), /edited after the review changed it/);
  assert.equal(JSON.parse(readCfgFile()).chat_models[0].label, 'Mine now', 'the owner\'s edit is kept');
  fs.writeFileSync(configPath(root), applied);
  assert.match((await runNow('model-review-undo')).body, /Undone · 已撤销/);
  assert.deepEqual(JSON.parse(readCfgFile()).chat_models, LANES, 'back to the list from before the review');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).declined.sort(), ['nova:cloud', 'star:cloud']);
  Object.assign(cfg, await loadConfig(root, { readOnly: true }), { users });
  const again = (await runNow('model-review')).body;
  assert.match(again, /^\*\*No change: your current models are still the best fit/, again);
  assert.match(again, /Not tried again \(taken back by Undo\) · 已撤销，不再推荐: star, nova|nova, star/);
});

test('a grading failure, or Ollama down, fails the run and writes nothing', async () => {
  const cfgBefore = readCfgFile(), stateBefore = fs.readFileSync(stateFile, 'utf8');
  fs.writeFileSync(GRADER_MODE, 'garbage');
  await assert.rejects(runNow('model-review'), /grading "[a-z-]+" failed: grader reply is not JSON/);
  fs.rmSync(GRADER_MODE);
  const url = cfg.ollama_url;
  cfg.ollama_url = 'http://127.0.0.1:9';
  await assert.rejects(runNow('model-review'), /no model answered at http:\/\/127\.0\.0\.1:9/);
  cfg.ollama_url = url;
  assert.equal(readCfgFile(), cfgBefore);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore);
});

test('agent_lanes: false measures no agent lane: no agent call, no agent row, cost says 0', async () => {
  const runsBefore = graderRuns().length;
  cfg.model_review = { ...cfg.model_review, agent_lanes: false };
  try {
    const body = (await runNow('model-review')).body;
    assert.match(body, /^\*\*No change: your current models are still the best fit/, body);
    assert.ok(!/\| (Claude|GPT) \| Agent \|/.test(body), 'no agent row');
    assert.ok(!body.includes(AGENT_TABLE_NOTE));
    assert.match(body, /, 0 agent calls, /);
    assert.equal(graderRuns().slice(runsBefore).filter((r) => !r.stdin.includes('<<<ANSWER')).length, 0, 'the claude CLI answered no review test');
  } finally { delete cfg.model_review.agent_lanes; }
});
