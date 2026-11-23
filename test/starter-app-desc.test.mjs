// F1-9: a starter app's tile subtitle is shown to every user, so it speaks plain words —
// never a file name such as "tasks.md" (an implementation detail nobody should need to know).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['workspace.example/apps', 'workspace/apps', 'shared-apps'];
const FILE_NAME = /\b[\w-]+\.(md|json|jsonl|txt|csv|mjs|js|html)\b/i;

test('starter app descriptions never name a file', () => {
  let seen = 0;
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    for (const slug of readdirSync(root)) {
      const meta = join(root, slug, 'meta.json');
      if (!existsSync(meta)) continue;
      const { desc = '' } = JSON.parse(readFileSync(meta, 'utf8'));
      seen++;
      assert.doesNotMatch(desc, FILE_NAME, `${meta}: desc names a file: ${desc}`);
    }
  }
  assert.ok(seen > 0, 'no meta.json found — the scan must not pass vacuously');
});

test('the Tasks tile reads as plain bilingual words, 中文 first', () => {
  const { desc } = JSON.parse(readFileSync('workspace.example/apps/tasks/meta.json', 'utf8'));
  assert.match(desc, /^[一-鿿].* · .*[A-Za-z]/, desc);
});
