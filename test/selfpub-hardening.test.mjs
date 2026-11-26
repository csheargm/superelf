// GPT review fixes for core Publish (docs/adr/0043): token scrubbing, the verifier's pass rule, stale
// locks, and git calls that read no outside config. Each pins a defect the review found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubToken, makeClient } from '../lib/publish/github.mjs';
import { gitEnv, clean } from '../lib/publish/release.mjs';
import { runTests } from '../lib/selfpub/verify.mjs';
import { acquireLock, scrubbedEnv, deniedPath, treeHash, discardBranch } from '../lib/selfpub/checkout.mjs';
import { selfpubFixture, tgit } from './helpers-selfpub.mjs';
import { ensureCheckout } from '../lib/selfpub/checkout.mjs';
import { skipIf } from './helpers-skip.mjs';

const TOKEN = ['ghp', 'fakeTokenForTests123'].join('_');   // built at run time: a key-shaped literal would trip the repo's own privacy scan
const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

test('a GitHub error that echoes the token (raw or Basic) never carries it', async () => {
  const fetchFn = async () => new Response(JSON.stringify({ message: `bad header Bearer ${TOKEN} / Basic ${basic}` }), { status: 500 });
  const gh = makeClient({ token: TOKEN, api: 'http://x', repo: 'a/b', fetchFn });
  const e = await gh.call('GET', '/x').catch((err) => err);
  assert.doesNotMatch(e.message, new RegExp(`${TOKEN}|${basic}`));
  assert.equal(clean(`fatal: ${basic}`, TOKEN), 'fatal: ***');
  assert.equal(scrubToken('none', ''), 'none');
});

test('release and checkout git read no global/system config and inherit no GIT_* var', () => {
  process.env.GIT_SSH_COMMAND = 'evil'; process.env.GIT_CONFIG_PARAMETERS = "'url.x.insteadOf'='https://'";
  try {
    for (const env of [gitEnv(TOKEN), scrubbedEnv()]) {
      assert.equal(env.GIT_SSH_COMMAND, undefined); assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
      assert.equal(env.GIT_CONFIG_NOSYSTEM, '1'); assert.ok(env.GIT_CONFIG_GLOBAL);
    }
    const g = gitEnv(TOKEN);
    assert.equal(g.GIT_CONFIG_KEY_0, 'core.hooksPath'); assert.equal(g.GIT_CONFIG_KEY_1, 'http.extraHeader');
  } finally { delete process.env.GIT_SSH_COMMAND; delete process.env.GIT_CONFIG_PARAMETERS; }
});

test('verifier: all skipped, or a non-zero exit after a passing summary, is a failure (R14)', async () => {
  const fake = (out, err = null) => (cmd, args, o, cb) => cb(err, out, '');
  const skipped = await runTests('/tmp', ['test/a.test.mjs'], { exec: fake('# tests 1\n# pass 0\n# fail 0\n# skipped 1\n') });
  assert.equal(skipped.ok, false);
  const exited = await runTests('/tmp', ['test/a.test.mjs'], { exec: fake('# tests 1\n# pass 1\n# fail 0\n', Object.assign(new Error('x'), { code: 1 })) });
  assert.equal(exited.ok, false);
  const good = await runTests('/tmp', ['test/a.test.mjs'], { exec: fake('# tests 1\n# pass 1\n# fail 0\n') });
  assert.equal(good.ok, true);
});

test('the node runs only node --test over trusted tests (no sandbox, no agent-named runner)', async () => {
  let seen;
  await runTests('/tmp', ['test/a.test.mjs'], { sandbox: ['runner', '--no-net'], exec: (cmd, args, o, cb) => { seen = [cmd, ...args]; cb(null, '# tests 1\n# pass 1\n# fail 0\n', ''); } });
  assert.deepEqual(seen.slice(0, 2), [process.execPath, '--test'], 'an old selfpub_test_sandbox option is ignored');
});

test('a lock left by a dead process is reclaimed; a live one still refuses', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'selfpub-lock-'));
  try {
    fs.writeFileSync(path.join(d, '.lock'), '999999');
    const rel = acquireLock(d);
    assert.throws(() => acquireLock(d), { code: 'IN_FLIGHT' });
    rel();
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('package.json, its lockfile and .npmrc are never published (they set the CI command)', () => {
  for (const p of ['package.json', 'package-lock.json', '.npmrc', 'web/.npmrc']) assert.ok(deniedPath(p), p);
  assert.ok(!deniedPath('web/package.css'));
});

test('round 2: a truncated TAP summary (no # fail) is not a pass; a lowercase git_* var is dropped too', async () => {
  const r = await runTests('/tmp', ['test/a.test.mjs'], { exec: (c, a, o, cb) => cb(null, '# tests 1\n# pass 1\n', '') });
  assert.equal(r.ok, false);
  process.env.git_config_parameters = 'x';
  try { assert.equal(scrubbedEnv().git_config_parameters, undefined); assert.equal(gitEnv('').git_config_parameters, undefined); }
  finally { delete process.env.git_config_parameters; }
});

test('round 2: a non-JSON error page cut at 200 chars never shows part of the token', async () => {
  const fetchFn = async () => new Response('x'.repeat(190) + TOKEN, { status: 502 });
  const e = await makeClient({ token: TOKEN, api: 'http://x', repo: 'a/b', fetchFn }).call('GET', '/x').catch((err) => err);
  assert.doesNotMatch(e.message, /ghp_/);
});

test('round 3: the tree hash sees an executable bit; discard removes ignored leftovers', { skip: skipIf(process.platform === 'win32', 'posix-only', 'POSIX symlinks, hooks and exec bits') }, () => {
  const fx = selfpubFixture();
  try {
    const dir = ensureCheckout({ root: fx.root, cloneUrl: fx.bare });
    const f = path.join(dir, 'web', 'home.css');
    fs.writeFileSync(f, 'a\n'); const h1 = treeHash(dir); fs.chmodSync(f, 0o755);
    assert.notEqual(treeHash(dir), h1);
    fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), 'junk/\n'); fs.mkdirSync(path.join(dir, 'junk')); fs.writeFileSync(path.join(dir, 'junk', 'x.js'), '1');
    discardBranch(dir);
    assert.ok(!fs.existsSync(path.join(dir, 'junk')));
    assert.equal(tgit(dir, 'status', '--porcelain').trim(), '');
  } finally { fs.rmSync(fx.d, { recursive: true, force: true }); }
});
