// test/assess.test.mjs — R14 logic of the Multi-LLM assessment orchestrator (lib/assess.mjs),
// driven with INJECTED fake lanes that replicate the REAL lanes' failure shapes
// (test-harness fidelity): runClaude/runCodex RESOLVE ok:false on timeout/error
// (lib/runner.mjs, lib/codex.mjs), while streamOllama THROWS (web.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAssessment, callPanelModel, pickPanel, ollamaMessages, agentPrompt, buildSummaryPrompt, inconclusiveSummary, ANSWER_CAP } from '../lib/assess.mjs';

const CHAT_MODELS = [
  { id: 'deepseek', label: 'DeepSeek · 中文', group: 'Fast', provider: 'ollama', model: 'deepseek-cloud' },
  { id: 'glm', label: 'GLM', group: 'Deep', provider: 'ollama', model: 'glm-cloud' },
  { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', model: null },
  { id: 'gpt', label: 'GPT (Codex)', group: 'Agent', provider: 'codex', model: null },
];
const mkCfg = (over = {}) => ({
  chat_models: CHAT_MODELS, assess_models: ['glm', 'claude', 'gpt'], assess_summarizer: 'haiku',
  assess_timeout_minutes: 0.002, claude_cmd: 'claude', claude_args: ['--flag'], ollama_url: 'http://o',
  system_prompts: { global: 'GUARD', apps: {}, assess: 'ASSESS-PROMPT' }, ...over,
});

// Fake lanes. Handlers may return values, promises that hang, throw, or resolve ok:false —
// mirroring exactly what the real lanes do. The summarizer is distinguished the way the real
// call is: its extraArgs carry --model <assess_summarizer>.
function mkLanes({ ollama, claude, codex, summarizer } = {}) {
  const calls = { ollama: [], claude: [], codex: [], summarizer: [], enqueued: 0 };
  const lanes = {
    enqueue: (fn) => { calls.enqueued++; return fn(); },
    streamOllama: async (o) => { calls.ollama.push(o); return ollama ? ollama(o) : 'ollama answer'; },
    runClaude: async (o) => {
      const isSum = (o.extraArgs || []).includes('haiku');
      calls[isSum ? 'summarizer' : 'claude'].push(o);
      if (isSum) return summarizer ? summarizer(o) : { ok: true, text: 'SUMMARY: consensus vs discrepancies' };
      return claude ? claude(o) : { ok: true, text: 'claude answer' };
    },
    runCodex: async (o) => { calls.codex.push(o); return codex ? codex(o) : { ok: true, text: 'codex answer' }; },
    // The owner's own chat, as web.mjs binds it: args pass through, Codex allowed. The confined
    // shape is exercised by the tests at the end of this file.
    agentArgs: (base) => base, codexAllowed: true,
  };
  return { calls, lanes };
}

const run = async ({ cfg = mkCfg(), fakes = {}, fastModelId = 'deepseek', convoMessages, question = 'Q?' } = {}) => {
  const states = [];
  const { calls, lanes } = mkLanes(fakes);
  await runAssessment({ cfg, question, convoMessages: convoMessages || [{ role: 'me', text: 'Q?' }],
    prompts: { global: 'GUARD', app: '中文 directive' }, fastModelId, cwd: '/tmp-x',
    lanes, persist: async (a) => states.push(JSON.parse(JSON.stringify(a))) });
  return { states, calls };
};
const last = (states) => states[states.length - 1];

test('happy path: pending then done with summary, all models ok, answers persisted', async () => {
  const { states, calls } = await run();
  assert.equal(states.length, 2);
  assert.equal(states[0].state, 'pending');
  assert.deepEqual(states[0].models.map((m) => m.id), ['glm', 'claude', 'gpt']);
  const fin = last(states);
  assert.equal(fin.state, 'done');
  assert.equal(fin.summary, 'SUMMARY: consensus vs discrepancies');
  assert.deepEqual(fin.models.map((m) => m.ok), [true, true, true]);
  assert.ok(fin.models.every((m) => typeof m.ms === 'number'));
  assert.deepEqual(Object.keys(fin.answers).sort(), ['claude', 'glm', 'gpt']);
  assert.equal(calls.summarizer.length, 1);
  const sp = calls.summarizer[0];
  assert.deepEqual(sp.extraArgs, ['--flag', '--model', 'haiku']); // fast haiku-class tier pinned via the CLI --model flag
  assert.ok(sp.prompt.startsWith('ASSESS-PROMPT'));
  assert.ok(sp.prompt.includes('## Answer from GLM'));
  assert.ok(sp.prompt.includes('(none — all panel models responded)'));
  assert.ok(sp.prompt.includes('中文 directive'));
});

test('duplicate model is skipped, noted in state, and NAMED to the summarizer', async () => {
  const { states, calls } = await run({ fastModelId: 'glm' });
  const fin = last(states);
  assert.deepEqual(fin.models.map((m) => m.id), ['claude', 'gpt']);
  assert.deepEqual(fin.skipped, [{ id: 'glm', label: 'GLM' }]);
  assert.equal(calls.ollama.length, 0); // GLM really not re-run
  assert.ok(calls.summarizer[0].prompt.includes('## Skipped'));
  assert.ok(calls.summarizer[0].prompt.includes('- GLM'));
});

test('R14 timeout: a hanging model is ok:false, excluded from answers, NAMED absent', async () => {
  const { states, calls } = await run({ fakes: { ollama: () => new Promise(() => {}) } }); // never settles, like a stalled stream
  const fin = last(states);
  assert.equal(fin.state, 'done');
  const glm = fin.models.find((m) => m.id === 'glm');
  assert.equal(glm.ok, false);
  assert.match(glm.error, /timeout/);
  assert.ok(!('glm' in fin.answers));
  assert.ok(calls.summarizer[0].prompt.includes('- GLM: timeout'));
  assert.ok(!calls.summarizer[0].prompt.includes('## Answer from GLM')); // partial/absent output never reaches the summarizer
});

test('R14 thrown lane error (streamOllama throws) becomes ok:false with the reason', async () => {
  const { states } = await run({ fakes: { ollama: () => { throw new Error('Ollama HTTP 500'); } } });
  const glm = last(states).models.find((m) => m.id === 'glm');
  assert.equal(glm.ok, false);
  assert.equal(glm.error, 'Ollama HTTP 500');
});

test('R14 empty output is failure, not agreement', async () => {
  const { states, calls } = await run({ fakes: { claude: () => ({ ok: true, text: '   \n ' }) } });
  const cl = last(states).models.find((m) => m.id === 'claude');
  assert.equal(cl.ok, false);
  assert.equal(cl.error, 'empty response');
  assert.ok(!('claude' in last(states).answers));
  assert.ok(calls.summarizer[0].prompt.includes('- Claude: empty response'));
});

test('R14 resolved-ok:false lane (runClaude timeout shape) is named absent', async () => {
  const { states } = await run({ fakes: { claude: () => ({ ok: false, text: 'Task timed out after 1 min and was stopped.', sessionId: null }) } });
  const cl = last(states).models.find((m) => m.id === 'claude');
  assert.equal(cl.ok, false);
  assert.match(cl.error, /timed out/);
});

test('R14 fewer than two responders → explicit inconclusive, summarizer NOT called', async () => {
  const { states, calls } = await run({ fakes: {
    claude: () => ({ ok: false, text: 'boom' }),
    codex: () => ({ ok: false, text: 'Codex produced no output' }) } });
  const fin = last(states);
  assert.equal(fin.state, 'done');
  assert.match(fin.summary, /inconclusive/);
  assert.match(fin.summary, /校验无法定论/);
  assert.ok(fin.summary.includes('Claude (boom)'));
  assert.ok(fin.summary.includes('GPT (Codex)'));
  assert.equal(calls.summarizer.length, 0); // no model call could invent consensus
});

test('R14 all panel models fail → state error, never a vacuous pass', async () => {
  const { states, calls } = await run({ fakes: {
    ollama: () => { throw new Error('down'); },
    claude: () => ({ ok: false, text: 'x' }),
    codex: () => ({ ok: false, text: 'y' }) } });
  const fin = last(states);
  assert.equal(fin.state, 'error');
  assert.match(fin.error, /no panel model responded/);
  assert.equal(calls.summarizer.length, 0);
});

test('summarizer failure → explicit state error with reason (answers still persisted)', async () => {
  const { states } = await run({ fakes: { summarizer: () => ({ ok: false, text: 'CLI exploded' }) } });
  const fin = last(states);
  assert.equal(fin.state, 'error');
  assert.match(fin.error, /summarizer failed/);
  assert.match(fin.error, /CLI exploded/);
  assert.equal(Object.keys(fin.answers).length, 3); // auditable even when the summary failed
});

test('summarizer EMPTY output → state error (vacuous-success guard)', async () => {
  const { states } = await run({ fakes: { summarizer: () => ({ ok: true, text: '  ' }) } });
  assert.equal(last(states).state, 'error');
  assert.match(last(states).error, /empty summarizer output/);
});

test('answers are capped at ANSWER_CAP', async () => {
  const { states } = await run({ fakes: { ollama: () => 'x'.repeat(ANSWER_CAP * 3) } });
  assert.equal(last(states).answers.glm.length, ANSWER_CAP);
});

test('empty panel (everything skipped) → single explicit error state', async () => {
  const { states } = await run({ cfg: mkCfg({ assess_models: ['glm'] }), fastModelId: 'glm' });
  assert.equal(states.length, 1);
  assert.equal(states[0].state, 'error');
  assert.match(states[0].error, /no panel models/);
});

test('orchestrator crash still reaches a terminal persisted error (R5)', async () => {
  const states = [];
  let first = true;
  const { lanes } = mkLanes();
  await runAssessment({ cfg: mkCfg(), question: 'Q?', convoMessages: [{ role: 'me', text: 'Q?' }],
    prompts: { global: 'G', app: null }, fastModelId: 'deepseek', cwd: '/tmp-x', lanes,
    persist: async (a) => { if (first) { first = false; throw new Error('disk full'); } states.push(a); } });
  assert.equal(states.length, 1);
  assert.equal(states[0].state, 'error');
  assert.match(states[0].error, /disk full/);
});

test('pickPanel: unknown configured id is ignored defensively', () => {
  const { panel, skipped } = pickPanel(mkCfg({ assess_models: ['glm', 'ghost', 'claude'] }), 'claude');
  assert.deepEqual(panel.map((m) => m.id), ['glm']);
  assert.deepEqual(skipped.map((x) => x.id), ['claude']);
});

test('ollamaMessages: system prompts + role mapping, empties dropped, no fast answer', () => {
  const msgs = ollamaMessages({ global: 'G', app: 'A' }, [
    { role: 'me', text: 'q1' }, { role: 'md', text: 'a1' }, { role: 'me', text: '' }, { role: 'me', text: 'q2' }]);
  assert.deepEqual(msgs, [
    { role: 'system', content: 'G' }, { role: 'system', content: 'A' },
    { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }]);
});

test('agentPrompt: directive + transcript + question, one-shot', () => {
  const p = agentPrompt({ global: 'G', app: '用中文' }, [
    { role: 'me', text: 'q1' }, { role: 'md', text: 'a1' }, { role: 'me', text: 'q2' }], 'q2');
  assert.ok(p.includes('Directive for your reply: 用中文'));
  assert.ok(p.includes('User: q1'));
  assert.ok(p.includes('Assistant: a1'));
  assert.ok(p.endsWith('Answer this question:\n\nq2'));
  assert.ok(!p.includes('Assistant: q2')); // the question is never presented as an answer
});

test('callPanelModel never rejects and reports elapsed ms', async () => {
  const { lanes } = mkLanes({ codex: () => { throw new Error('spawn ENOENT'); } });
  const v = await callPanelModel({ m: CHAT_MODELS[3], cfg: mkCfg(), lanes, prompts: { global: 'G', app: null },
    convoMessages: [{ role: 'me', text: 'Q' }], question: 'Q', cwd: '/tmp-x', timeoutMs: 100 });
  assert.equal(v.ok, false);
  assert.match(v.error, /ENOENT/);
  assert.equal(typeof v.ms, 'number');
});

test('buildSummaryPrompt separates responders from absentees', () => {
  const p = buildSummaryPrompt({ sysPrompt: 'S', question: 'Q',
    results: [{ id: 'glm', label: 'GLM', ok: true }, { id: 'gpt', label: 'GPT (Codex)', ok: false, error: 'timeout' }],
    answers: { glm: 'GA' }, skipped: [], appDirective: null });
  assert.ok(p.includes('## Answer from GLM\n\nGA'));
  assert.ok(p.includes('- GPT (Codex): timeout'));
  assert.ok(!p.includes('## Answer from GPT'));
});

test('inconclusiveSummary names responders, absentees and skips', () => {
  const s = inconclusiveSummary(
    [{ id: 'glm', label: 'GLM', ok: true }, { id: 'claude', label: 'Claude', ok: false, error: 'timeout' }],
    [{ id: 'gpt', label: 'GPT (Codex)' }]);
  assert.match(s, /inconclusive/);
  assert.ok(s.includes('GLM'));
  assert.ok(s.includes('Claude (timeout)'));
  assert.ok(s.includes('GPT (Codex)'));
  assert.ok(s.includes('未经核实'));
});

// ── Confinement: the panel is an agent lane, and resolves through the caller's agentArgs ──
// The panel used to read cfg.claude_args RAW, so Verify ran with --dangerously-skip-permissions
// for an app or a member. Here the resolver is a stand-in stripping function (the bypass struck, a
// mode added — not the whole confined lane, which is lib/agent-origin.mjs laneArgs), so a raw read
// would leave the flag in.
const CONFINE = (base) => [...base.filter((a) => a !== '--dangerously-skip-permissions'), '--permission-mode', 'acceptEdits'];

test('CONFINED panel: every Claude call (panel AND summarizer) goes through the injected resolver', async () => {
  const cfg = mkCfg({ claude_args: ['--dangerously-skip-permissions'], assess_models: ['glm', 'claude', 'gpt'] });
  const { calls, lanes } = mkLanes();
  lanes.agentArgs = CONFINE; lanes.codexAllowed = false;
  const states = [];
  await runAssessment({ cfg, question: 'Q?', convoMessages: [{ role: 'me', text: 'Q?' }], prompts: { global: 'G', app: null },
    fastModelId: 'deepseek', cwd: '/tmp-x', lanes, persist: async (a) => states.push(JSON.parse(JSON.stringify(a))) });
  // Control (R14): the Claude lanes really ran, so "no flag" is not "no call".
  assert.equal(calls.claude.length, 1, 'the panel Claude call ran');
  assert.equal(calls.summarizer.length, 1, 'the summarizer ran (glm + claude responded)');
  for (const c of [...calls.claude, ...calls.summarizer]) {
    assert.ok(!c.extraArgs.includes('--dangerously-skip-permissions'), `unconfined panel call: ${c.extraArgs}`);
    assert.ok(c.extraArgs.includes('acceptEdits'), 'and the member mode is applied');
  }
  assert.deepEqual(calls.summarizer[0].extraArgs, ['--model', 'haiku', '--permission-mode', 'acceptEdits']);
  assert.equal(calls.codex.length, 0, 'Codex is never spawned for a confined turn');
  const gpt = last(states).models.find((m) => m.id === 'gpt');
  assert.equal(gpt.ok, false);
  assert.match(gpt.error, /not run for this request/, 'and the panel SAYS why it is absent');
});

test('no resolver injected = no Claude call at all (fails closed, never raw cfg.claude_args)', async () => {
  const { calls, lanes } = mkLanes();
  delete lanes.agentArgs;
  const v = await callPanelModel({ m: CHAT_MODELS[2], cfg: mkCfg(), lanes, prompts: { global: 'G', app: null },
    convoMessages: [{ role: 'me', text: 'Q' }], question: 'Q', cwd: '/tmp-x', timeoutMs: 100 });
  assert.equal(v.ok, false);
  assert.match(v.error, /no agent-lane resolver/);
  assert.equal(calls.claude.length, 0);
});

test('codexAllowed must be exactly true — absent means Codex is not run', async () => {
  const { calls, lanes } = mkLanes();
  delete lanes.codexAllowed;
  const v = await callPanelModel({ m: CHAT_MODELS[3], cfg: mkCfg(), lanes, prompts: { global: 'G', app: null },
    convoMessages: [{ role: 'me', text: 'Q' }], question: 'Q', cwd: '/tmp-x', timeoutMs: 100 });
  assert.equal(v.ok, false);
  assert.equal(calls.codex.length, 0);
});
