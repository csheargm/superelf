// The WebKit CI job picks every suite with an iPhone config · WebKit 任务不漏掉 iPhone 测试
// Nightly review 2026-11-27: the share sign-in suite has its own iPhone config (the engine check)
// but the job's file selection missed it. This runs the job's own selection line and checks the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');

test('the WebKit job selects every file that has its own iPhone config', () => {
  const line = CI.split('\n').find((l) => l.trim().startsWith('files=$({ grep'));
  assert.ok(line, 'CONTROL: the selection line is in ci.yml');
  const cmd = line.trim().replace(/^files=\$\(/, '').replace(/\)$/, '');
  const picked = execFileSync('bash', ['-c', cmd], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
  const own = fs.readdirSync(path.join(REPO, 'test')).filter((f) => f.endsWith('.test.mjs') && f !== 'ci-webkit-select.test.mjs')
    .filter((f) => new RegExp(['PA_E2E_ENGINE', '===', "'webkit'"].join(' ')).test(fs.readFileSync(path.join(REPO, 'test', f), 'utf8'))).map((f) => `test/${f}`);
  assert.ok(!picked.includes('test/ci-webkit-select.test.mjs'), 'this unit test is not counted as a WebKit suite');
  assert.ok(own.includes('test/app-share-signin-e2e.test.mjs'), 'CONTROL: the share sign-in suite has an iPhone config');
  for (const f of own) assert.ok(picked.includes(f), `${f} runs in the WebKit job`);
});
