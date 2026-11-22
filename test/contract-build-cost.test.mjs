// The two build-cost rules of superelf.md (docs/TODO.md "Build time", measured 2026-11-01: one
// 232 s build spent 54% retyping fetched data into the page). They are prose a builder session
// reads, so this pins that the prose is there, in the section the builder is told to read, and
// names the real file path and tool, not a paraphrase (R14: a rule that drifts is no rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = fs.readFileSync(path.join(ROOT, 'superelf.md'), 'utf8');
const build = md.split('## Building web apps')[1].split('\n## ')[0];

test('large data goes to data/<slug>/<name>.json by the Write tool, loaded with PAStore', () => {
  assert.match(build, /Data goes by tool, not by tokens/);
  assert.match(build, /data\/<slug>\/<name>\.json/, 'the real on-disk path save-data namespaces to');
  assert.match(build, /PAStore\.file\('<name>\.json'/, 'and the matching load call');
});

test('an existing app is changed with Edit, not a whole-file Write', () => {
  assert.match(build, /Modify an app with the Edit tool, not a whole-file Write/);
  assert.doesNotMatch(build, /Modify or delete an app = edit or remove/, 'the old wording is gone, not duplicated');
});

test('the rules live in the build steps, not in the appended system prompt (its argv cap, lib/runner.mjs APPEND_SYSTEM_PROMPT_MAX)', async () => {
  const { appContract } = await import('../lib/config.mjs');
  assert.doesNotMatch(appContract(ROOT), /Data goes by tool/);
});
