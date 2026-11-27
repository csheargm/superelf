// lib/lane-codex.mjs: the one Codex lane function and the sign-in fallback built on it, with a
// fake runCodex. What is pinned: session resume and the fresh retry, the prefix on a fallback
// answer, both errors when Codex fails too, the sign-in line alone with no Codex lane, and that a
// fallback result never carries a session id (web.mjs would store it as the CLAUDE session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCodexLane, codexFallback, withLangRule, CODEX_WORKING_STATUS, CODEX_ALSO_FAILED } from '../lib/lane-codex.mjs';
import { REPLY_IN } from '../lib/ui-lang.mjs';
import { CLAUDE_SIGNIN_EXPIRED, CODEX_FALLBACK_PREFIX } from '../lib/claude-auth.mjs';
import { REAL_401_REVOKED } from './helpers-claude-auth.mjs';

const enqueue = (fn) => fn();
const LANES = [{ id: 'claude', provider: 'claude', model: null }, { id: 'gpt', provider: 'codex', model: 'gpt-test' }];

test('runCodexLane: resumes the conversation\'s Codex session, retries fresh when it is gone, stores the new id', async () => {
  const calls = [];
  const runCodex = async (o) => { calls.push(o); return o.resumeId === 'old' ? { ok: false, text: 'gone' } : { ok: true, text: 'A', sessionId: 'new' }; };
  const convo = { codexSessionId: 'old', sessionId: 'claude-sid' };
  const status = [];
  const r = await runCodexLane({ convo, prompt: 'hi', images: ['/i.png'], cwd: '/w', model: 'gpt-test', timeoutMs: 5, runCodex, enqueue, onStatus: (t) => status.push(t) });
  assert.deepEqual(r, { ok: true, text: 'A', sessionId: 'new' });
  assert.deepEqual(calls.map((c) => c.resumeId), ['old', null]);
  assert.deepEqual(calls[0], { prompt: 'hi', images: ['/i.png'], cwd: '/w', model: 'gpt-test', resumeId: 'old', timeoutMs: 5 });
  assert.equal(convo.codexSessionId, 'new');
  assert.deepEqual(status, [CODEX_WORKING_STATUS]);
});

test('codexFallback: the same prompt through the Codex lane, the reply prefixed, no session id returned', async () => {
  const calls = [];
  const runCodex = async (o) => { calls.push(o); return { ok: true, text: 'GPT says hi', sessionId: 'c1' }; };
  const convo = { codexSessionId: null, sessionId: null };
  const r = await codexFallback({ chatModels: LANES, claudeError: REAL_401_REVOKED, convo, prompt: 'the same prompt', cwd: '/w', timeoutMs: 5, runCodex, enqueue });
  assert.deepEqual(r, { ok: true, text: `${CODEX_FALLBACK_PREFIX}\n\nGPT says hi` });
  assert.equal(calls[0].prompt, 'the same prompt');
  assert.equal(calls[0].model, 'gpt-test', 'the configured Codex lane\'s model');
  assert.equal(convo.codexSessionId, 'c1', 'Codex\'s session is the conversation\'s Codex session');
  assert.equal(convo.sessionId, null);
});

test('codexFallback: Codex failing too surfaces both errors; no Codex lane surfaces the sign-in line', async () => {
  const convo = { codexSessionId: null };
  const r = await codexFallback({ chatModels: LANES, claudeError: REAL_401_REVOKED, convo, prompt: 'p', cwd: '/w', timeoutMs: 5, enqueue,
    runCodex: async () => ({ ok: false, text: 'Codex produced no output' }) });
  assert.equal(r.ok, false);
  assert.ok(r.text.startsWith(CLAUDE_SIGNIN_EXPIRED));
  assert.match(r.text, new RegExp(`${CODEX_ALSO_FAILED}: Codex produced no output`));
  assert.match(r.text, /401 OAuth access token has been revoked/);
  let ran = 0;
  const none = await codexFallback({ chatModels: [LANES[0]], claudeError: REAL_401_REVOKED, convo, prompt: 'p', cwd: '/w', timeoutMs: 5, enqueue, runCodex: async () => { ran++; } });
  assert.equal(ran, 0, 'R14 control: nothing spawned without a lane');
  assert.equal(none.ok, false);
  assert.ok(none.text.startsWith(CLAUDE_SIGNIN_EXPIRED));
  assert.ok(!none.text.includes(CODEX_FALLBACK_PREFIX));
});

test('the reply-language line leads every Codex prompt (no system channel), fresh and resumed, and through the fallback', async () => {
  const calls = [];
  const runCodex = async (o) => { calls.push(o); return { ok: true, text: 'A', sessionId: 's' }; };
  await runCodexLane({ convo: { codexSessionId: 'old' }, prompt: 'hi', cwd: '/w', timeoutMs: 5, runCodex, enqueue, langRule: REPLY_IN.en });
  assert.equal(calls[0].prompt, `${REPLY_IN.en}\n\nhi`, 'a resumed session too: the choice may have changed since');
  await codexFallback({ chatModels: LANES, claudeError: 'x', convo: {}, prompt: 'yo', cwd: '/w', timeoutMs: 5, runCodex, enqueue, langRule: REPLY_IN.zh });
  assert.equal(calls[1].prompt, `${REPLY_IN.zh}\n\nyo`);
  assert.equal(withLangRule('', 'plain'), 'plain', 'no line: the prompt unchanged (CONTROL)');
});
