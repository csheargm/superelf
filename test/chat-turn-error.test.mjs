// A chat or ask turn that THREW is shown to a person: Node's bare "fetch failed" (a model server
// that is down or not set up) is not a sentence anyone can act on (overnight 2026-11-22, F2-02:
// Bible Ask AI with no model showed "⚠ fetch failed"). turnErrorText says which model, in 中文
// first, and what to do; any other error keeps its own message.
// R11 — searched: "fetch failed", "ECONNREFUSED", "could not be reached", "laneFailureText" — none shared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { turnErrorText } from '../lib/chat-outcome.mjs';
import { ROOT } from './helpers-app.mjs';

const netErr = (code) => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('connect'), { code }); return e; };

test('a network failure names the model and the next step, 中文 first, no "fetch failed"', () => {
  for (const e of [netErr('ECONNREFUSED'), netErr('ENOTFOUND'), new TypeError('fetch failed')]) {
    const t = turnErrorText({ label: 'Ollama · qwen' }, e);
    assert.doesNotMatch(t, /fetch failed/);
    assert.match(t, /^Ollama · qwen 暂时无法连接，请稍后再试或换一个模型 · Ollama · qwen could not be reached — try again later, or pick another model$/);
  }
  assert.match(turnErrorText(null, netErr('ECONNREFUSED')), /^Claude 暂时无法连接/, 'no lane = the agent lane, Claude');
});

test('any other error keeps its own message (already a sentence, e.g. a damaged chat file)', () => {
  assert.equal(turnErrorText(null, new Error('this conversation could not be read · 无法读取该对话')), 'this conversation could not be read · 无法读取该对话');
  assert.equal(turnErrorText(null, 'plain'), 'plain');
});

test('every turn catch that shows an error uses it (web.mjs chat + ask, demo chat + ask)', () => {
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(web, /line\(\{ type: 'error', text: turnErrorText\(chosen, e\) \}\)/);
  assert.match(web, /JSON\.stringify\(\{ ok: false, text: turnErrorText\(null, e\) \}\)/);
  for (const f of ['lib/demo-routes.mjs', 'lib/demo-ask.mjs']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /turnErrorText\(lane, e\)/, f);
  }
});
