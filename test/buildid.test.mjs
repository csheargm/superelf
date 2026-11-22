// Which code is on screen — lib/buildid.mjs, and the two places web.mjs shows it: the shell's
// version line (appVersion → <!--APP_VERSION-->) and every app page (BUILD_MARKER, read by the
// Pencil recorder's log header). The scar: Settings read "v3.8.0" before and after the Pencil
// fixes, so a report from the iPad could not say which code produced it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { blobId, makeBuildId, BUILD_MARKER, HEAD_TTL_MS, GIT_SHORT, NOTE_SHORT, readRevision, REVISION_FILE } from '../lib/buildid.mjs';
import { ROOT } from './helpers-panote-routing.mjs';

const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const tmpRoot = (content) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-buildid-'));
  fs.mkdirSync(path.join(d, 'web'));
  if (content != null) fs.writeFileSync(path.join(d, 'web', 'note-ui.inline.html'), content);
  return d;
};

test('the note half is git\'s own blob id — anyone can check it with `git hash-object`', () => {
  const file = path.join(ROOT, 'web', 'note-ui.inline.html');
  let git;
  try { git = execFileSync('git', ['hash-object', file], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { git = null; }
  const ours = blobId(fs.readFileSync(file));
  if (git) assert.equal(ours, git);
  assert.equal(blobId(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a', 'the well-known blob id of "hello\\n"');
});

test('the id reads "<short HEAD> · note <short blob>"', () => {
  const d = tmpRoot('<script>PANote</script>');
  const id = makeBuildId(d, () => SHA)();
  assert.equal(id, `${SHA.slice(0, GIT_SHORT)} · note ${blobId(Buffer.from('<script>PANote</script>')).slice(0, NOTE_SHORT)}`);
});

test('a PANote edit changes the id at once, even with no commit; git runs at most once per HEAD_TTL_MS', () => {
  const d = tmpRoot('v1');
  let clock = 0, heads = 0;
  const id = makeBuildId(d, () => { heads++; return SHA; }, () => clock);
  const a = id();
  fs.writeFileSync(path.join(d, 'web', 'note-ui.inline.html'), 'v2 — a longer body so the size differs');
  const b = id();
  assert.notEqual(a, b, 'the edited PANote is a different build');
  for (let i = 0; i < 20; i++) id();
  assert.equal(heads, 1, 'the shell page does not spawn git on every load');
  clock += HEAD_TTL_MS;
  id();
  assert.equal(heads, 2, 'and it notices a new HEAD after the TTL');
});

test('no git, or no PANote on disk: the id names what it can and never throws', () => {
  assert.match(makeBuildId(tmpRoot('x'), () => null)(), /^note [0-9a-f]{8}$/);
  assert.equal(makeBuildId(tmpRoot(null), () => SHA)(), SHA.slice(0, GIT_SHORT));
  assert.equal(makeBuildId(tmpRoot(null), () => null)(), '');
});

test('web.mjs shows it in the shell version line and stamps it into every app page', () => {
  assert.match(WEB, /import \{ makeBuildId, BUILD_MARKER, readRevision \} from '\.\/lib\/buildid\.mjs';/);
  assert.match(WEB, /const buildId = makeBuildId\(ROOT, gitHead\);/, 'one git invocation, the existing gitHead (R3)');
  assert.match(WEB, /const appVersion = \(\) => \{ try \{ const b = buildId\(\); return 'v' \+ [^\n]*\+ \(b \? ' · ' \+ b : ''\); \}/);
  const loop = WEB.indexOf('html = html.split(c.marker).join(snippet);');
  const stamp = WEB.indexOf('html = html.split(BUILD_MARKER).join(buildId());');
  assert.ok(loop > 0 && stamp > loop, 'stamped AFTER the components are inlined — the marker lives in one of them');
});

test('the Pencil recorder is a registered component after note-ui, and the ONLY carrier of the marker', () => {
  const list = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('];', WEB.indexOf('const PA_COMPONENTS = [')));
  assert.ok(list.indexOf("'note-ui.inline.html'") < list.indexOf("'pencil-log.inline.html'"), 'after note-ui, which carries its marker');
  const note = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
  assert.equal(note.split('<!--PA_PENCIL_LOG_UI-->').length, 2, 'note-ui carries the recorder marker once');
  const carriers = fs.readdirSync(path.join(ROOT, 'web')).filter((f) => fs.readFileSync(path.join(ROOT, 'web', f), 'utf8').includes(BUILD_MARKER));
  assert.deepEqual(carriers, ['pencil-log.inline.html']);
});

test('id.head() is the same TTL\'d HEAD the id uses — one git invocation shared with version-auto (R3)', () => {
  let clock = 0, heads = 0;
  const id = makeBuildId(tmpRoot('x'), () => { heads++; return SHA; }, () => clock);
  assert.equal(id.head(), SHA);
  id(); id.head(); id();
  assert.equal(heads, 1, 'id() and head() share the cached sha');
  clock += HEAD_TTL_MS;
  assert.equal(id.head(), SHA);
  assert.equal(heads, 2, 'and both notice a new HEAD after the TTL');
  assert.match(WEB, /const plusN = \(\) => \{ const n = autoSince\(ROOT, buildId\.head\(\)\)\.n;/, 'appVersion\'s +N reads the SAME HEAD');
  assert.match(WEB, /appNotesJson\(ROOT, undefined, buildId\.head\(\)\)/, 'and so does the Release Notes sheet');
});

test('a folder with no .git takes its commit from REVISION, so the build id changes on every deploy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-rev-'));
  assert.equal(readRevision(root), null, 'no file: no git half');
  fs.writeFileSync(path.join(root, REVISION_FILE), 'abc1234def5678abc1234def5678abc1234def56\n');
  assert.equal(readRevision(root), 'abc1234def5678abc1234def5678abc1234def56');
  const a = makeBuildId(root, () => readRevision(root), () => 0)();
  fs.writeFileSync(path.join(root, REVISION_FILE), 'fedcba9876543210fedcba9876543210fedcba98\n');
  const b = makeBuildId(root, () => readRevision(root), () => 0)();
  assert.equal(a, 'abc1234');
  assert.notEqual(a, b, 'a new deploy is a new build id (the update signal)');
  fs.writeFileSync(path.join(root, REVISION_FILE), 'not a sha; rm -rf /\n');
  assert.equal(readRevision(root), null, 'only a hex sha is believed');
});

test('web.mjs falls back to REVISION when git has no answer; the image lets the file in', () => {
  const web = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
  assert.match(web, /catch \{ return readRevision\(ROOT\); \}/);
  assert.match(fs.readFileSync(new URL('../ops/demo/Dockerfile.dockerignore', import.meta.url), 'utf8'), /^!REVISION$/m);
});
