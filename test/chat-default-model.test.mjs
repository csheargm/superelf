// PAChat opts.defaultModel — which lane an app starts on.
//
// PAC_CURMODEL always landed on PAC_MODELS[0] ('deepseek'), so every app opened on the same
// fast lane regardless of what it is for. A research app whose answers are judged best from
// Claude had no way to say so, and the user had to re-pick the lane on every load.
//
// The rule under test is EXTRACTED from web/chat-ui.inline.html and RUN — not retyped — so a
// change to the shipped line changes what these assertions see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT = fs.readFileSync(path.join(ROOT, 'web/chat-ui.inline.html'), 'utf8');

// The one shipped line that resolves the starting lane.
const RESOLVE = (() => {
  const m = CHAT.match(/if\(!PAC_CURMODEL&&PAC_MODELS\[0\]\) PAC_CURMODEL=[^\n]*;/);
  assert.ok(m, 'the model-resolution line must stay findable in the shipped component');
  return m[0];
})();
const resolve = (models, want, cur = null) =>
  new Function('PAC_MODELS', 'PAC_WANTMODEL', 'PAC_CURMODEL', `${RESOLVE}\nreturn PAC_CURMODEL;`)(models, want, cur);

const MODELS = [
  { id: 'deepseek', label: 'DeepSeek · 中文', group: 'Fast' },
  { id: 'glm', label: 'GLM', group: 'Deep' },
  { id: 'claude', label: 'Claude', group: 'Agent' },
  { id: 'gpt', label: 'GPT (Codex)', group: 'Agent' },
];

test('an app that asks for a lane gets it', () => {
  assert.equal(resolve(MODELS, 'claude'), 'claude');
  assert.equal(resolve(MODELS, 'gpt'), 'gpt');
});

test('no preference keeps the previous behaviour — the first model', () => {
  assert.equal(resolve(MODELS, null), 'deepseek');
  assert.equal(resolve(MODELS, undefined), 'deepseek');
});

test('an unknown id falls back to a real lane instead of being sent to the server', () => {
  // R14: a typo'd default must not become a turn with a lane the server does not know.
  assert.equal(resolve(MODELS, 'claud'), 'deepseek');
  assert.equal(resolve(MODELS, 'sonnet'), 'deepseek', 'a CLI tier name is not a chat_models id');
  assert.equal(resolve(MODELS, ''), 'deepseek');
});

test("a lane the user already picked is never overridden by the app's default", () => {
  assert.equal(resolve(MODELS, 'claude', 'glm'), 'glm', 'the human choice wins');
  assert.equal(resolve(MODELS, 'gpt', 'deepseek'), 'deepseek');
});

test('no models offered yet leaves the lane unset rather than inventing one', () => {
  assert.equal(resolve([], 'claude'), null);
});

test('Chat() records the host preference, and only before a lane is chosen', () => {
  const m = CHAT.match(/if\(opts&&opts\.defaultModel&&!PAC_CURMODEL\) PAC_WANTMODEL=String\(opts\.defaultModel\);/);
  assert.ok(m, 'Chat(host,opts) must record opts.defaultModel');
});

test('the shipped component still validates against the served list', () => {
  assert.match(RESOLVE, /PAC_MODELS\.some\(x=>x\.id===PAC_WANTMODEL\)/,
    'the preference must be checked against what the server actually offers');
});
