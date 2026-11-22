// The owner's apps are tracked; their data must never follow · 应用进库，数据不进
//
// workspace/ is a person's private directory and is gitignored wholesale. ONE exception now exists:
// workspace/apps/<slug>/{index.html,meta.json}, because those 21 apps are DEV WORK — ~670KB of
// code that existed on exactly one disk, with no history and no second copy.
//
// The separation that makes this safe is already in the architecture: an app's data is namespaced
// by the broker to workspace/data/<slug>/ (~64MB), and conversations, journal.json, health.json,
// memory and uploads are siblings of apps/, not inside it. So tracking apps/ tracks the code and
// none of the contents.
//
// What this file defends is that the exception STAYS narrow. The .gitignore rule is an allowlist —
// only those two filenames are un-ignored — but a rule is only as good as the next person's edit,
// and the cost of getting it wrong is a family's private data in a git history, which is the one
// mistake you cannot take back by deleting a file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = () => execFileSync('git', ['ls-files', '--', 'workspace', 'workspace-'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);

test('only an app index.html or meta.json is ever tracked under a workspace', () => {
  const bad = tracked().filter((f) => !/^workspace\/apps\/[^/]+\/(index\.html|meta\.json)$/.test(f));
  assert.deepEqual(bad, [], 'these are tracked but are not app code — a workspace holds private data');
});

test("no member's workspace is tracked at all", () => {
  // workspace-<id>/ belongs to that person. A child's app is likelier to be personal than the
  // owner's, and it is not this repo's call to publish it.
  assert.deepEqual(tracked().filter((f) => f.startsWith('workspace-')), []);
});

test('the data directories stay ignored — checked against git, not against the rule text', () => {
  // Asserting the .gitignore LINES would pass on a file that reads correctly and behaves wrongly.
  // Ask git what it would actually do.
  for (const p of ['workspace/data/notes/entry.json', 'workspace/journal.json', 'workspace/health.json',
    'workspace/conversations/c.json', 'workspace/memory/MEMORY.md', 'workspace/uploads/a.png',
    'workspace/profile.json', 'workspace/apps/x/.DS_Store', 'workspace/apps/x/data.json',
    'workspace-bob/apps/y/index.html']) {
    let ignored = true;
    try { execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT }); }
    catch { ignored = false; }
    assert.ok(ignored, `${p} is NOT ignored — a workspace path that git would accept`);
  }
  // CONTROL: the allowlist really does let an app through, so the above is not passing because
  // everything is ignored.
  let appIgnored = true;
  try { execFileSync('git', ['check-ignore', '-q', '--no-index', 'workspace/apps/x/index.html'], { cwd: ROOT }); }
  catch { appIgnored = false; }
  assert.equal(appIgnored, false, 'an app index.html must be trackable, or this suite proves nothing');
});

test('a tracked app is code, not a dumping ground', () => {
  // A quiet way for data to arrive in git is an app that grows large: a base64 blob, an inlined
  // dataset, a pasted export. Size is a blunt proxy, but it is the one that catches that.
  const MAX_KB = 400;
  const fat = tracked()
    .map((f) => [f, fs.statSync(path.join(ROOT, f)).size])
    .filter(([, n]) => n > MAX_KB * 1024)
    .map(([f, n]) => `${f} (${Math.round(n / 1024)}KB)`);
  assert.deepEqual(fat, [], `tracked app files over ${MAX_KB}KB — check nothing was inlined that should be runtime data`);
});
