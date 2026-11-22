// The agent lanes in the model review (docs/adr/0017 decision 10): one call shape for both runners,
// Claude timed at its first streamed text, Codex at its whole answer (said so), every failure a
// failure with its reason (R14), nothing measured when agent_lanes is off. Pure, with fake runners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askAgentLane, runAgentCalls, laneRunner, splitMessages, codexPrompt, agentKey, isAgentLane, NO_STREAM_NOTE } from '../lib/model-review-agent.mjs';
import { modelReviewSetting } from '../lib/model-review-config.mjs';

const CLAUDE = { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', model: null };
const GPT = { id: 'gpt', label: 'GPT (Codex)', group: 'Agent', provider: 'codex', model: null };
const MSGS = [{ role: 'system', content: 'guard' }, { role: 'system', content: 'language' }, { role: 'user', content: 'Say hi.' }];
const TEST = { id: 't1', group: 'Fast', check: 'text', keys: [], lang: 'en', messages: MSGS };
// A clock the fakes advance by hand: no sleeps, no jitter.
const clock = () => { let t = 1000; return { now: () => t, tick: (ms) => { t += ms; } }; };

test('messages become the runners\' system prompt and prompt; Codex gets the system text first in its prompt', () => {
  assert.deepEqual(splitMessages(MSGS), { systemPrompt: 'guard\n\nlanguage', prompt: 'Say hi.' });
  assert.equal(codexPrompt('guard', 'Say hi.'), 'guard\n\nSay hi.');
  assert.equal(codexPrompt('', 'Say hi.'), 'Say hi.');
  assert.equal(agentKey(CLAUDE), 'agent:claude', 'never an Ollama model name');
  assert.ok(isAgentLane(CLAUDE) && isAgentLane(GPT) && !isAgentLane({ provider: 'ollama' }) && !isAgentLane(null));
});

test('claude: firstTextMs is the first NON-EMPTY streamed delta, ms the whole answer', async () => {
  const c = clock();
  const run = async ({ onDelta }) => { c.tick(10); onDelta(''); c.tick(30); onDelta('Hi'); c.tick(60); onDelta(' there'); return { ok: true, text: 'Hi there' }; };
  const r = await askAgentLane({ lane: CLAUDE, messages: MSGS, timeoutMs: 1000, run, now: c.now });
  assert.deepEqual(r, { ok: true, text: 'Hi there', error: null, firstTextMs: 40, ms: 100 });
});

test('codex: no stream, so firstTextMs equals ms (the whole answer), and the report note says so', async () => {
  const c = clock();
  const r = await askAgentLane({ lane: GPT, messages: MSGS, timeoutMs: 1000, run: async () => { c.tick(250); return { ok: true, text: 'Hi' }; }, now: c.now });
  assert.deepEqual(r, { ok: true, text: 'Hi', error: null, firstTextMs: 250, ms: 250 });
  assert.equal(NO_STREAM_NOTE, 'whole answer · 整段回答, Codex does not stream');
});

test('a non-ok result, an empty answer, a thrown error or a timeout is a failure with its reason, never a pass', async () => {
  const ask = (run) => askAgentLane({ lane: CLAUDE, messages: MSGS, timeoutMs: 1000, run });
  const notOk = await ask(async () => ({ ok: false, text: 'Could not start "claude": ENOENT' }));
  assert.equal(notOk.ok, false); assert.match(notOk.error, /Could not start "claude": ENOENT/); assert.equal(notOk.text, '');
  const empty = await ask(async () => ({ ok: true, text: '  \n' }));
  assert.deepEqual([empty.ok, empty.error], [false, 'empty answer']);
  const thrown = await ask(async () => { throw new Error('queue closed'); });
  assert.deepEqual([thrown.ok, thrown.error], [false, 'queue closed']);
  const timedOut = await ask(async () => ({ ok: false, timedOut: true, text: 'Task timed out after 2 min and was stopped.' }));
  assert.deepEqual([timedOut.ok, timedOut.error.startsWith('Task timed out')], [false, true]);
  const nothing = await ask(async () => null);
  assert.deepEqual([nothing.ok, nothing.error], [false, 'no answer']);
  const long = await ask(async () => ({ ok: false, text: 'x'.repeat(500) }));
  assert.ok(long.error.length <= 200, 'the reason is capped like askModel\'s');
});

test('runAgentCalls: one row per (lane, text test) with the format check applied; no lane, no call', async () => {
  const seen = [];
  const run = async ({ lane, prompt }) => { seen.push(`${lane.id}:${prompt}`); return { ok: true, text: lane.id === 'gpt' ? '{"a":1}' : 'Hello' }; };
  const rows = await runAgentCalls({ lanes: [CLAUDE, GPT], tests: [TEST, { ...TEST, id: 't2', check: 'json', keys: ['a'], lang: null }], timeoutMs: 10, run });
  assert.deepEqual(rows.map((r) => [r.model, r.test, r.fail]), [['agent:claude', 't1', null], ['agent:claude', 't2', 'not valid JSON'], ['agent:gpt', 't1', null], ['agent:gpt', 't2', null]]);
  assert.deepEqual(seen, ['claude:Say hi.', 'claude:Say hi.', 'gpt:Say hi.', 'gpt:Say hi.'], 'one at a time, in order');
  assert.deepEqual(await runAgentCalls({ lanes: [], tests: [TEST], timeoutMs: 10, run: async () => { throw new Error('must not run'); } }), []);
});

test('laneRunner: claude gets the RESOLVED claude args per user, the workspace, the system prompt and onDelta; codex gets the joined prompt; both through the queue', async () => {
  const cfg = { claude_cmd: '/x/claude', claude_args: ['--model', 'sonnet'] };
  const got = {}; let queued = 0;
  const run = laneRunner({ cfg, wsDir: (u) => `/ws/${u.id}`, enqueue: async (fn) => { queued += 1; return fn(); }, codexCmd: '/x/codex', claudeArgs: (u) => [...cfg.claude_args, '--for', u.id],
    runClaude: async (a) => { got.claude = a; return { ok: true, text: 'c' }; }, runCodex: async (a) => { got.codex = a; return { ok: true, text: 'g' }; } });
  const onDelta = () => {};
  await run({ lane: CLAUDE, systemPrompt: 'S', prompt: 'P', timeoutMs: 5, onDelta, user: { id: 'owner' } });
  assert.deepEqual(got.claude, { claudeCmd: '/x/claude', extraArgs: ['--model', 'sonnet', '--for', 'owner'], cwd: '/ws/owner', prompt: 'P', systemPrompt: 'S', timeoutMs: 5, onDelta });
  await run({ lane: { ...GPT, model: 'o3' }, systemPrompt: 'S', prompt: 'P', timeoutMs: 5, onDelta, user: { id: 'owner' } });
  assert.deepEqual(got.codex, { codexCmd: '/x/codex', prompt: 'S\n\nP', cwd: '/ws/owner', model: 'o3', timeoutMs: 5 });
  assert.equal(queued, 2);
});

test('setting agent_lanes: default true, false accepted, anything else refuses to load', () => {
  assert.equal(modelReviewSetting({}).agent_lanes, true);
  assert.equal(modelReviewSetting({ model_review: { agent_lanes: false } }).agent_lanes, false);
  assert.throws(() => modelReviewSetting({ model_review: { agent_lanes: 'yes' } }), /agent_lanes must be true or false, got "yes"/);
  assert.throws(() => modelReviewSetting({ model_review: { agent_lanes: 1 } }), /agent_lanes must be true or false/);
});
