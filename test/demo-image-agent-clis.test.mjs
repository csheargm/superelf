// The image's optional agent CLIs (ops/demo/Dockerfile AGENT_CLIS): only a build that asks for them
// gets Claude Code / Codex. The public demo never does — it stays Ollama-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('AGENT_CLIS defaults to empty and the install is skipped when empty', () => {
  const d = read('ops/demo/Dockerfile');
  assert.match(d, /^ARG AGENT_CLIS=$/m);
  assert.match(d, /if \[ -n "\$AGENT_CLIS" \]; then/);
});

test('the demo compose never passes AGENT_CLIS', () => {
  assert.doesNotMatch(read('ops/demo/docker-compose.yml'), /AGENT_CLIS/);
});
