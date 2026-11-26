// Nightly review on a throwaway node (docs/adr/0046, R6): the real web.mjs, two throwaway "remotes" (a local
// superelf fixture and a findings-only repo), a FAKE codex that keeps the real CLI's read-only rule (no
// `--sandbox read-only` = it refuses; with it, nothing it does can write), and a FAKE claude that keeps the real
// CLI's permission model and refuses a verify run that would load the reviewed repo's settings. Run now from the
// owner's Jobs: findings verified, ONE core-lane change made for superelf and left unpublished (no PR), the
// findings-only remote untouched, the briefing saved; a member cannot run it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { FAKE_PERMS_SRC } from './helpers-fake-claude-perms.mjs';
import { selfpubFixture, tgit } from './helpers-selfpub.mjs';
import { localDateStr } from '../lib/schedule.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skipIf } from './helpers-skip.mjs';
const POSIX_ONLY = skipIf(process.platform === 'win32', 'posix-only', 'the core lane and its fake CLIs are POSIX (docs/adr/0044)');

const KID = 'kid-token-nightly-abcdef';
const FAKE_CODEX = `#!/usr/bin/env node
const fs = process.getBuiltinModule('node:fs');
const a = process.argv.slice(2), i = a.indexOf('--sandbox');
if (a[0] !== 'exec' || i < 0 || a[i + 1] !== 'read-only') { process.stderr.write('fake codex: refusing, sandbox is not read-only'); process.exit(2); }
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const path = process.getBuiltinModule('node:path');   // the log sits beside fakebin/: codex gets a scrubbed env, so no env var can carry its path
  fs.appendFileSync(path.join(path.dirname(process.argv[1]), '..', 'codex.log'), JSON.stringify({ cwd: process.cwd(), argv: a, secret: process.env.NIGHTLY_FAKE_SECRET || null, home: !!process.env.HOME }) + '\\n');
  const out = a[a.indexOf('-o') + 1];
  const finding = /Repository: superelf/.test(s) ? [{ file: 'web/home.css', line: 1, severity: 'medium', claim: 'body colour is hard-coded', evidence: 'body{color:#111}' }]
    : [{ file: 'a.mjs', line: 1, severity: 'low', claim: 'a is a magic number', evidence: 'export const a = 1' }];
  fs.writeFileSync(out, JSON.stringify(finding));
});
`;
const FAKE_CLAUDE = `#!/usr/bin/env node
${FAKE_PERMS_SRC}
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const path = process.getBuiltinModule('node:path');
  const argv = process.argv.slice(2), sys = argv.join(' '), p = perms(argv), tools = [];
  let say;
  if (/git checkout of superelf/.test(sys)) {
    const f = 'web/home.css', cur = p.read(f);
    tools.push({ type: 'tool_use', name: 'Edit', input: { file_path: path.join(process.cwd(), f) } });
    say = cur !== null && p.write(f, cur + 'body{color:var(--ink)}\\n') ? 'I changed web/home.css to use the ink colour.' : 'I could not write web/home.css.';
  } else if (/Another reviewer claims/.test(s)) {
    if (!argv.includes('--setting-sources=')) say = 'UNSAFE: repo settings would load';
    else say = p.read(/web\\/home\\.css/.test(s) ? 'web/home.css' : 'a.mjs') !== null ? 'CONFIRMED\\nthe line is there' : 'REJECTED\\nno such file';
  } else say = 'ok';
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-n' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [...tools, { type: 'text', text: say }] } }) + '\\n');
  p.text(say);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: say, session_id: 'sid-n' }) + '\\n');
});
`;

let port, root, web, fx, hgBare, hgRefs, log, nrDir;
before(async () => {
  fx = selfpubFixture();
  const hw = path.join(fx.d, 'hg-work'); fs.mkdirSync(hw); tgit(hw, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(hw, 'a.mjs'), 'export const a = 1;\n'); tgit(hw, 'add', '.'); tgit(hw, 'commit', '-qm', 'hg first');
  hgBare = path.join(fx.d, 'hg.git'); tgit(fx.d, 'clone', '-q', '--bare', hw, hgBare);
  hgRefs = tgit(hgBare, 'for-each-ref').trim();
  port = await freePort();
  nrDir = path.join(fx.d, 'nightly');
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, selfpub_root: path.join(fx.d, 'src'), selfpub_clone_url: fx.bare,
    nightly_review: { enabled: true, time: '23:59', dir: nrDir, repos: [{ name: 'superelf', url: fx.bare, fix: 'selfpub' }, { name: 'Other Repo', url: hgBare }] },
    users: [{ id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
      { id: 'kid', name: 'Kid', role: 'member', token: KID, workspace: 'ws-kid' }] } });
  fs.writeFileSync(path.join(root, 'workspace', 'job-runs.json'), JSON.stringify({ 'model-check': localDateStr(new Date()), 'nightly-review': localDateStr(new Date()) }));
  const cfgPath = path.join(root, 'config.json'), cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE_CLAUDE);
  cfg.nightly_review.codex_cmd = writeFakeCli(bin, 'codex', FAKE_CODEX);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  log = path.join(root, 'codex.log');
  process.env.NIGHTLY_FAKE_SECRET = 'not-for-codex';   // web.mjs inherits it; codex must not (lib/codex.mjs codexEnv)
  web = startWeb(root);
  await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (fx) rmTemp(fx.d); if (root) rmTemp(root); });

const run = (token) => api(port, '/api/jobs/nightly-review/run', { method: 'POST', body: '{}', ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });

test('a member cannot run the nightly review', { skip: POSIX_ONLY }, async () => {
  const r = await run(KID);   // the job is not on a member's list: 404 'unknown job', not any failure (nightly review 2026-11-26)
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'unknown job');
});

test('Run now: Codex read-only, findings verified, one unpublished superelf change, the findings-only repo untouched', { skip: POSIX_ONLY }, async () => {
  const r = await run();
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  const text = JSON.stringify(j);
  assert.match(text, /Nightly review/);
  assert.match(text, /web\/home\.css:1 \[medium\] body colour is hard-coded/);
  assert.match(text, /a\.mjs:1 \[low\] a is a magic number/);
  assert.match(text, /Fix: (Ready to publish|Checks failed)/);
  assert.match(text, /Fix: none \(findings only\)/);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.argv.includes('read-only') && c.cwd.startsWith(fs.realpathSync(nrDir))));
  assert.ok(calls.every((c) => c.secret === null && c.home), 'codex runs with a scrubbed env: the node\'s other variables never reach it, HOME (its sign-in) does');
  assert.equal(tgit(hgBare, 'for-each-ref').trim(), hgRefs, 'the findings-only remote is unchanged');
  const sp = JSON.parse(fs.readFileSync(path.join(fx.d, 'src', 'state.json'), 'utf8'));
  const changes = Object.values(sp.changes);
  assert.equal(changes.length, 1); assert.equal(changes[0].who, 'owner');
  assert.ok(!changes[0].publish, 'nothing published without the owner\'s tap');
  assert.equal(tgit(fx.bare, 'branch', '--list', 'self/*').trim(), '', 'no branch reached the remote');
  const convos = fs.readdirSync(path.join(root, 'workspace', 'conversations')).map((f) => JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'conversations', f), 'utf8')));
  const c = convos.find((x) => /Nightly review fixes/.test(x.title));
  assert.ok(c && c.messages[1].selfpub && c.messages[1].selfpub.id === changes[0].id, 'the Publish button lives in an owner chat');
  const st = JSON.parse(fs.readFileSync(path.join(nrDir, 'state.json'), 'utf8'));
  assert.equal(st.repos.superelf.lastSha, tgit(fx.bare, 'rev-parse', 'main').trim());
  assert.equal(st.repos['Other Repo'].lastSha, tgit(hgBare, 'rev-parse', 'main').trim());
});
