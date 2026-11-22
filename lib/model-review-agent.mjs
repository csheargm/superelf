// Agent lanes in the model review · 代理通道评测 (docs/adr/0017, decision 10)
//
// The chooser's Claude and GPT (Codex) lanes answer the review's TEXT tests too, timed and graded
// blind beside the Ollama models, so the owner sees the agents on the same scale. They are compared
// only: never swapped, never a group's bar, never counted as newcomers, and their calls are not
// Ollama calls (model_review.max_calls), so they are counted apart. The Vision test is skipped: the
// runners take no image.
//
// askAgentLane returns the SAME shape as lib/model-review-call.mjs askModel, so one summarize() and
// one grader serve both. `run` is injected (web.mjs: laneRunner through its agent queue):
//   claude  runClaude with the owner's claude_args and workspace; onDelta fires per streamed text
//           token, and the first non-empty one is firstTextMs — the same measure as Ollama's.
//   codex   runCodex returns only its final message (no stream), so firstTextMs = ms, the whole
//           answer. The report says so next to the number (NO_STREAM_NOTE): a number that looks
//           like the others but measures something else would be a lie (R14).
// A non-ok result, an empty answer, a thrown error or a timeout is a failure with its reason.
import { sanitizeLine } from './webutil.mjs';
import { checkAnswer } from './model-review-tests.mjs';

export const AGENT_PROVIDERS = Object.freeze(['claude', 'codex']);
export const NO_STREAM_NOTE = 'whole answer · 整段回答, Codex does not stream';
export const AGENT_TABLE_NOTE = 'Agent lanes are measured for comparison and never swapped · 代理通道仅作对比，不更换';
export const AGENT_VISION_NOTE = 'Vision not measured · 看图未测';
export const AGENT_USE = 'Agent';
const ERROR_MAX = 200;

export const isAgentLane = (l) => !!l && AGENT_PROVIDERS.includes(l.provider);
// The result key: never an Ollama model name, so the two can share one results list and one stats map.
export const agentKey = (lane) => `agent:${lane.id}`;
export const streamsText = (lane) => lane.provider !== 'codex';

// The review's messages (system pieces, then the user turn) as the runners take them.
export function splitMessages(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n');
  return { systemPrompt: system, prompt: user };
}
// Codex has no system flag: the system text goes first in the prompt, set apart.
export const codexPrompt = (systemPrompt, prompt) => (systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt);

export async function askAgentLane({ lane, messages, timeoutMs, run, now = Date.now }) {
  const t0 = now();
  const { systemPrompt, prompt } = splitMessages(messages);
  let first = null;
  const onDelta = (t) => { if (first === null && String(t ?? '').trim()) first = now(); };
  let r;
  try { r = await run({ lane, systemPrompt, prompt, timeoutMs, onDelta }); }
  catch (e) { r = { ok: false, text: String((e && e.message) || e) }; }
  const ms = now() - t0;
  const text = r && r.ok && typeof r.text === 'string' ? r.text : '';
  const error = !r ? 'no answer' : !r.ok ? sanitizeLine(r.text || 'failed', ERROR_MAX) : !text.trim() ? 'empty answer' : null;
  // No delta seen but an answer came: a runner that does not stream (Codex) — the whole answer.
  const firstTextMs = first !== null ? first - t0 : error ? null : ms;
  return { ok: !error, text, error, firstTextMs, ms };
}

// Every (lane, test) pair, one at a time (the agent queue is shared with the chats and the grader).
// Each result: { model: agent:<id>, test, ok, text, error, firstTextMs, ms, fail }, as runCalls'.
export async function runAgentCalls({ lanes, tests, timeoutMs, run, now }) {
  const out = [];
  for (const lane of lanes) {
    for (const test of tests) {
      const r = await askAgentLane({ lane, messages: test.messages, timeoutMs, run, now });
      out.push({ model: agentKey(lane), test: test.id, ...r, fail: r.error || checkAnswer(test, r.text) });
    }
  }
  return out;
}

// web.mjs's `run`: the claude and codex runners through the agent queue, in the owner's workspace,
// with claudeArgs(user): the live claude_args RESOLVED by web.mjs agentArgs for the owner's composer
// lane (test/agent-confinement.test.mjs: no lane passes cfg.*_args raw). Injected runners so a test drives fakes.
export function laneRunner({ cfg, wsDir, enqueue, runClaude, runCodex, codexCmd, claudeArgs }) {
  return ({ lane, systemPrompt, prompt, timeoutMs, onDelta, user }) => enqueue(() => (lane.provider === 'codex'
    ? runCodex({ codexCmd, prompt: codexPrompt(systemPrompt, prompt), cwd: wsDir(user), model: lane.model || undefined, timeoutMs })
    : runClaude({ claudeCmd: cfg.claude_cmd, extraArgs: claudeArgs(user), cwd: wsDir(user), prompt, systemPrompt, timeoutMs, onDelta })));
}
