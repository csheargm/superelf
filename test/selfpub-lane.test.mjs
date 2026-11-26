// 改 superelf 的通道 · The core-change lane (docs/adr/0043 §3): argv pins, the server-side role gate,
// the file-tool backstop. The CLI's own enforcement of these rules is measured by hand (ADR 0044).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coreJailArgs, SKIP_PERMISSIONS } from '../lib/agent-origin.mjs';
import { coreLaneAllowed, lanePathProblems, claimedNotChanged, claimsNote } from '../lib/selfpub/lane.mjs';
import { skipIf } from './helpers-skip.mjs';

const REPO = '/data/superelf-src/repo';

test('coreJailArgs: no bypass, no Bash, file tools only, Edit only in the checkout, .git/.github denied, no --add-dir/--settings/MCP', () => {
  const a = coreJailArgs([SKIP_PERMISSIONS, '--add-dir', '/data/superelf', '--settings', '{}', '--mcp-config', 'x.json', '--tools', 'Bash', '--model', 'opus'], REPO);
  const s = a.join(' ');
  assert.ok(!a.includes(SKIP_PERMISSIONS));
  assert.ok(!a.includes('--add-dir') && !s.includes('/data/superelf ') && !a.includes('--settings') && !a.includes('--mcp-config'));
  assert.deepEqual(a.slice(a.indexOf('--tools'), a.indexOf('--tools') + 2), ['--tools', 'Read,Glob,Grep,Edit,Write']);
  assert.equal(a.filter((x) => x === '--tools').length, 1);
  assert.ok(a.includes('Bash'), 'Bash is in the deny list');
  assert.ok(a.includes(`Edit(/${REPO}/**)`));
  assert.ok(a.includes(`Edit(/${REPO}/.git/**)`) && a.includes(`Edit(/${REPO}/.github/**)`));
  assert.ok(a.includes('--strict-mcp-config') && a.includes('--setting-sources='));
  assert.deepEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2), ['--permission-mode', 'default']);
  assert.ok(a.includes('--model') && a.includes('opus'), 'other operator args survive');
});

test('only the owner from the composer gets the lane; members, guests, apps and the demo never', () => {
  const owner = { id: 'o', role: 'owner' }, member = { id: 'm', role: 'member' }, guest = { id: 'g', role: 'guest' };
  assert.equal(coreLaneAllowed(owner, { fromApp: false }), true);
  assert.equal(coreLaneAllowed(owner, { fromApp: true }), false);
  assert.equal(coreLaneAllowed(owner, { fromApp: false }, { demo: true }), false);
  assert.equal(coreLaneAllowed(member, { fromApp: false }), false);
  assert.equal(coreLaneAllowed(guest, { fromApp: false }), false);
  assert.equal(coreLaneAllowed(null, { fromApp: false }), false);
});

test('backstop: any file tool call outside the checkout or on a dot-path is a problem, even a denied one', () => {
  const calls = [
    { name: 'Edit', input: { file_path: `${REPO}/lib/x.mjs` } },
    { name: 'Write', input: { file_path: '/data/superelf/web/x.js' } },
    { name: 'Write', input: { file_path: `${REPO}/../superelf/config.json` } },
    { name: 'Write', input: { file_path: `${REPO}/.git/hooks/pre-commit` } },
    { name: 'Edit', input: { file_path: 'web/home.css' } },
    { name: 'Read', input: { file_path: '/etc/passwd' } },
  ];
  assert.deepEqual(lanePathProblems(REPO, calls), ['/data/superelf/web/x.js', `${REPO}/../superelf/config.json`, `${REPO}/.git/hooks/pre-commit`, '/etc/passwd'], 'reads outside count too');
});

test('backstop: a path through a symlink in the checkout that leads outside is a problem', { skip: skipIf(process.platform === 'win32', 'posix-only', 'POSIX symlinks, hooks and exec bits') }, () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-link-')));
  try {
    const repo = path.join(d, 'repo'), out = path.join(d, 'outside');
    fs.mkdirSync(path.join(repo, 'web'), { recursive: true }); fs.mkdirSync(out);
    fs.symlinkSync(out, path.join(repo, 'web', 'escape'));
    const calls = [{ name: 'Write', input: { file_path: path.join(repo, 'web', 'escape', 'new.js') } }, { name: 'Write', input: { file_path: path.join(repo, 'web', 'ok.css') } }];
    assert.deepEqual(lanePathProblems(repo, calls), [path.join(repo, 'web', 'escape', 'new.js')]);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('claimedNotChanged: a path the reply names but the diff lacks is caught; named-and-changed is fine (2026-11-26)', () => {
  const changed = ['web/home-v2.css', 'web/home-v2.js', 'web/index.html'].map((p) => ({ path: p, kind: 'write' }));
  const owner = 'Changes: web/index.html new <p class="home-ver" id="hVer"> after the app grid; web/home-v2.js new syncVer() called from render(); web/home-v2.css small muted centred style for .home-ver.';
  assert.deepEqual(claimedNotChanged(owner, changed), [], 'the owner\'s real reply matches its 3-file diff');
  assert.deepEqual(claimedNotChanged(`${owner} Also web/settings.js and web.mjs, and \`lib/x.mjs\`.`, changed), ['lib/x.mjs', 'web.mjs', 'web/settings.js']);
  assert.deepEqual(claimedNotChanged('I bumped package.json and version-notes.json.', changed), ['package.json', 'version-notes.json'], 'root files too (GPT review)');
  assert.deepEqual(claimedNotChanged('no paths here; a URL https://x.test/web/a.js is not a repo path? it is ignored', changed), []);
  assert.match(claimsNote(['web/settings.js']), /^回复说改了 web\/settings\.js，但改动里没有，不能发布 · The reply names web\/settings\.js/);
});
