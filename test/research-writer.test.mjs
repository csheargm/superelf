// lib/research-writer.mjs — which lane writes a summary follow-up (ADR 0027 addendum 2026-11-12). The chain per
// cfg.research.writer value, read at use time; makeWriter's fallback order and its R14 rule (empty = failure);
// the Claude argv carries NO tools (its prompt holds scraped web text).
// R11 — searched: "research.writer", "writerChain", "WRITER_DEFAULT", "fallbacks" — no duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { writerChain, makeWriter, writerClaudeBase, WRITER_DEFAULT } from '../lib/research-writer.mjs';
import { NO_TOOLS_ARGS } from '../lib/one-shot.mjs';

const MS = [{ id: 'fast', label: 'Fast', provider: 'ollama', model: 'f:cloud' }, { id: 'kimi', label: 'Kimi', provider: 'ollama', model: 'k:cloud' },
  { id: 'claude', provider: 'claude', model: null }, { id: 'gpt', provider: 'codex', model: 'gpt-x' }, { id: 'research', provider: 'research' }];
const cfg = (writer, ms = MS) => ({ chat_models: ms, research: { llm: 'fast', ...(writer === undefined ? {} : { writer }) }, ollama_url: 'http://o' });
const kinds = (c) => writerChain(c).map((s) => s.kind + ':' + (s.model || ''));

test('writerChain: default Claude → Codex → fast; codex → Codex → fast; an ollama id alone; a claude/codex id as its provider; unknown throws', () => {
  assert.equal(WRITER_DEFAULT, 'claude');
  assert.deepEqual(kinds(cfg(undefined)), ['claude:', 'codex:gpt-x', 'ollama:f:cloud']);
  assert.deepEqual(kinds(cfg('codex')), ['codex:gpt-x', 'ollama:f:cloud']);
  assert.deepEqual(kinds(cfg('kimi')), ['ollama:k:cloud']);
  assert.deepEqual(kinds(cfg('gpt')), ['codex:gpt-x', 'ollama:f:cloud']);
  assert.deepEqual(kinds(cfg('claude', MS.filter((m) => m.provider !== 'codex'))), ['claude:', 'ollama:f:cloud'], 'no Codex lane: skipped');
  assert.throws(() => writerChain(cfg('nope')), /unknown lane "nope"/); assert.throws(() => writerChain(cfg('research')), /unknown lane/);
});

test('makeWriter: the first non-empty answer wins; a failure, a throw or an EMPTY answer moves on; the lane that answered after a failure is recorded; all failing names each', async () => {
  const c = cfg(undefined), seen = [];
  const fb = new Set();
  const w = makeWriter({ cfg: c, fallbacks: fb, agents: { claude: async () => { seen.push('claude'); return { ok: true, text: 'Claude answer.' }; } }, streamOllama: async () => { throw new Error('unused'); } });
  assert.equal(await w('p'), 'Claude answer.'); assert.equal(fb.size, 0);
  const fb2 = new Set();
  const w2 = makeWriter({ cfg: c, fallbacks: fb2, agents: { claude: async () => { throw new Error('spawn ENOENT'); }, codex: async () => ({ ok: true, text: ' \n' }) },
    streamOllama: async (o) => { seen.push(o.model + '|' + o.messages[0].content); return 'Fast answer.'; } });
  assert.equal(await w2('the prompt'), 'Fast answer.'); assert.deepEqual([...fb2], ['Fast']); assert.equal(seen.at(-1), 'f:cloud|the prompt');
  const w3 = makeWriter({ cfg: c, agents: { claude: async () => ({ ok: false, text: 'sign-in expired' }) }, streamOllama: async () => '' });
  await assert.rejects(w3('p'), /Claude: sign-in expired; Codex: not available on this node[^;]*; Fast: no answer/);
  // Read at use time: the same writer follows a cfg edit on its next call.
  const live = cfg(undefined); const w4 = makeWriter({ cfg: live, agents: { claude: async () => ({ ok: true, text: 'C' }) }, streamOllama: async () => 'K' });
  assert.equal(await w4('p'), 'C'); live.research.writer = 'kimi'; assert.equal(await w4('p'), 'K');
});

test('writerClaudeBase: thinking off and NO tools, a member --settings wins over the one-shot default', () => {
  const a = writerClaudeBase({ claude_args: ['--model', 'sonnet'], one_shot_args: ['--settings', '{"alwaysThinkingEnabled":false}'] });
  assert.deepEqual(a.slice(-2), [...NO_TOOLS_ARGS]); assert.ok(a.includes('--settings') && a.includes('sonnet'));
  const m = writerClaudeBase({ claude_args: [], one_shot_args: ['--settings', '{"alwaysThinkingEnabled":false}'] }, ['--settings', '{"x":1}']);
  assert.equal(m.includes('{"alwaysThinkingEnabled":false}'), false, 'the default --settings yields to the member\'s');
});

test('a writer lane gets a third of the item deadline, so a hung Claude call still leaves time for a fallback (review 2026-11-12)', async () => {
  const { writerLaneMs, WRITER_LANE_SHARE, makeWriter } = await import('../lib/research-writer.mjs');
  assert.equal(WRITER_LANE_SHARE, 3);
  assert.equal(writerLaneMs(90000), 30000);
  assert.equal(writerLaneMs(undefined), undefined, 'no item deadline: no lane cap invented');
  assert.ok(writerLaneMs(90000) * 2 < 90000, 'the Claude try plus one fallback fit inside the item deadline');
  // A Claude call that times out at its lane share is a failure like any other: the chain moves on.
  const fallbacks = new Set();
  const write = makeWriter({ cfg: { research: { writer: 'claude' }, chat_models: [{ id: 'gpt', provider: 'codex', label: 'GPT' }] }, fallbacks,
    agents: { claude: async () => { const e = new Error('timed out after 30000ms'); e.code = 'timeout'; throw e; }, codex: async () => ({ ok: true, text: 'Codex answer.' }) } });
  assert.equal(await write('q'), 'Codex answer.');
  assert.equal(fallbacks.size, 1, 'the fallback is recorded for the status line');
});

test('the follow-up route caps each writer call at the lane share, not the whole item deadline', () => {
  const WEB = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
  assert.match(WEB, /fuMs = writerLaneMs\(cfg\.summary_followup_item_timeout_ms\);/);
  assert.ok(!/fuMs = Number\(cfg\.summary_followup_item_timeout_ms\)/.test(WEB), 'CONTROL: the whole item deadline is never one call\'s timeout');
});
