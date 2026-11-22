// lib/claude-token.mjs: the long-lived Claude token reaches the child's env from a FILE read at
// every spawn, and only then (docs/adr/0024). The value never reaches a log line. Every "unchanged"
// case has a control (R14): the same source, the file written, carries the token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeTokenSource, claudeToken, CLAUDE_TOKEN_ENV, CLAUDE_TOKEN_FILENAME, CLAUDE_TOKEN_MODE } from '../lib/claude-token.mjs';
import { claudeChildEnv } from '../lib/runner.mjs';
import { validateConfig } from '../lib/config.mjs';

const TOKEN = 'not-a-real-token';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-token-'));
const source = () => {
  const logs = [], warns = [];
  const src = createClaudeTokenSource({ log: (m) => logs.push(m), warn: (m) => warns.push(m) });
  return { src, logs, warns };
};

test('file absent → env unchanged; present → exactly the trimmed content; blank → unchanged', () => {
  const dir = tmp();
  const file = path.join(dir, CLAUDE_TOKEN_FILENAME);
  const { src, logs, warns } = source();
  src.setFile(() => file);
  assert.deepEqual(src.env(), {}, 'absent: nothing added');
  fs.writeFileSync(file, `  ${TOKEN}  \n\nsecond line ignored\n`, { mode: CLAUDE_TOKEN_MODE });
  assert.deepEqual(src.env(), { [CLAUDE_TOKEN_ENV]: TOKEN }, 'present: the trimmed first line, R14 control');
  fs.writeFileSync(file, '   \n\t\n');
  assert.deepEqual(src.env(), {}, 'blank: nothing added');
  fs.writeFileSync(file, '');
  assert.deepEqual(src.env(), {}, 'empty: nothing added');
  assert.ok(!logs.concat(warns).some((m) => m.includes(TOKEN)), 'the value never reaches a log line');
  assert.deepEqual(warns, [], 'a 600 file warns nothing');
});

test('logs present/absent at most once per change, and a loose mode once (still used)', () => {
  const dir = tmp();
  const file = path.join(dir, CLAUDE_TOKEN_FILENAME);
  const { src, logs, warns } = source();
  src.setFile(file);   // a plain path is accepted too
  src.env(); src.env(); src.env();
  assert.equal(logs.length, 1, 'absent: said once');
  assert.match(logs[0], /absent/);
  fs.writeFileSync(file, TOKEN + '\n', { mode: 0o644 });
  assert.deepEqual(src.env(), { [CLAUDE_TOKEN_ENV]: TOKEN }, 'a 644 file is still used');
  src.env();
  assert.equal(logs.length, 2, 'present: said once');
  assert.match(logs[1], /present/);
  if (process.platform !== 'win32') {
    assert.equal(warns.length, 1, 'the loose mode: warned once');
    assert.match(warns[0], /not 600/);
    assert.ok(!warns[0].includes(TOKEN));
  }
});

test('no file configured → nothing read, nothing added', () => {
  const { src, logs } = source();
  assert.deepEqual(src.env(), {});
  assert.equal(src.file(), null);
  assert.deepEqual(logs, []);
});

test('claudeChildEnv() carries the token from the module source, after the mechanism env, read at every call', () => {
  const dir = tmp();
  const file = path.join(dir, 'tok');
  claudeToken.setFile(() => file);
  try {
    const before = claudeChildEnv();
    assert.equal(before[CLAUDE_TOKEN_ENV], undefined, 'absent: the env is the mechanism env only');
    assert.equal(before.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'R14 control: the mechanism env is still there');
    fs.writeFileSync(file, TOKEN + '\n', { mode: CLAUDE_TOKEN_MODE });
    assert.equal(claudeChildEnv()[CLAUDE_TOKEN_ENV], TOKEN, 'present on the NEXT call, no restart');
    fs.rmSync(file);
    assert.equal(claudeChildEnv()[CLAUDE_TOKEN_ENV], undefined, 'removed on the next call too');
  } finally { claudeToken.setFile(() => null); }
});

test('cfg.claude_token_file: default <root>/claude-token, a relative path is under the root, an absolute one is kept', () => {
  const root = tmp();
  const base = () => ({ default_project: 'a', projects: { a: { dir: 'workspace' } }, users: [] });
  assert.equal(validateConfig(base(), root).claude_token_file, path.join(root, CLAUDE_TOKEN_FILENAME));
  assert.equal(validateConfig({ ...base(), claude_token_file: 'secrets/tok' }, root).claude_token_file, path.join(root, 'secrets', 'tok'));
  const abs = path.join(root, 'elsewhere', 'tok');
  assert.equal(validateConfig({ ...base(), claude_token_file: abs }, root).claude_token_file, abs);
  assert.equal(validateConfig({ ...base(), claude_token_file: '  ' }, root).claude_token_file, path.join(root, CLAUDE_TOKEN_FILENAME), 'blank: the default');
});
