// The public repo carries no person and no machine · 公开仓库不含个人与机器信息
// tools/privacy-scan.mjs over every tracked file. Private terms load only where the overlay put them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRepo, scanText, scanPush, readTerms, termMatcher, TERM_FILES, ROOT } from '../tools/privacy-scan.mjs';

test('no tracked file trips the privacy scan', () => {
  const hits = scanRepo().map((h) => `${h.file}:${h.line} ${h.rule}`);
  assert.deepEqual(hits, [], 'move personal data to the private overlay (docs/repos.md), or use a generic example');
});

test('CONTROL: each rule fires on its own kind and not on placeholders', () => {
  // Assembled at runtime: written out, this file would be its own first offender.
  const rules = (s, t) => scanText('x', s, t).map((h) => h.rule);
  assert.deepEqual(rules(['me', 'gmail.com'].join('@')), ['email address']);
  assert.deepEqual(rules('you@example.com 1234+x@users.noreply.github.com'), []);
  assert.deepEqual(rules(['box', 'tail9f3a2c', 'ts', 'net'].join('.')), ['tailscale hostname']);
  assert.deepEqual(rules('https://<node>.<tailnet>.ts.net and mybook.tailnet.ts.net'), []);
  assert.deepEqual(rules(['8', '8', '4', '4'].join('.')), ['public IPv4 address']);
  assert.deepEqual(rules('127.0.0.1 10.1.2.3 192.168.0.9 v1.2.3 100.64.0.0/10'), []);
  assert.deepEqual(rules(['8', '8', '4', '0/24'].join('.')), ['public IPv4 address'], 'a CIDR is still an address');
  assert.deepEqual(rules(['BOX', 'TAIL9F3A2C', 'TS', 'NET'].join('.')), ['tailscale hostname'], 'case-insensitive');
  assert.deepEqual(rules(['tskey', 'auth', 'kAbCdEf12345'].join('-')), ['key-shaped string']);
  assert.deepEqual(rules(['sk', 'proj', 'AbCdEfGhIjKlMnOpQrStUv'].join('-')), ['key-shaped string']);
  assert.deepEqual(rules('zip ' + '95' + '123', ['re:\\b95\\d{3}\\b']), ['term #1'], 're: terms are regexes');
  assert.deepEqual(rules(['sk', 'ant', 'api03abcdefghijk'].join('-')), ['key-shaped string']);
  assert.deepEqual(rules('Pat went to Springfield', ['Springfield']), ['term #1']);
  assert.ok(!termMatcher('John').test('Johnson said') && termMatcher('中文').test('是中文'), 'whole words for ASCII, substring otherwise');
});

test('the private term files can never be committed', () => {
  for (const f of TERM_FILES) {
    let ignored = true;
    try { execFileSync('git', ['check-ignore', '-q', '--no-index', f], { cwd: ROOT }); } catch { ignored = false; }
    assert.ok(ignored, `${f} must be git-ignored, or the detector becomes the leak`);
  }
  const tracked = execFileSync('git', ['ls-files', ...TERM_FILES], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(tracked, '', 'and neither is tracked (check-ignore alone passes a force-added file)');
  assert.ok(Array.isArray(readTerms()));
});

test('the pre-push scan reads every outgoing commit, not the checked-out tree', () => {
  // A leak added then removed in a later commit is clean in the tree but still in the push.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privscan-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n'); g('add', '.'); g('commit', '-qm', 'one');
  fs.writeFileSync(path.join(dir, 'a.txt'), `mail ${['me', 'gmail.com'].join('@')}\n`); g('commit', '-qam', 'two');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n'); g('commit', '-qam', 'three');
  const head = g('rev-parse', 'HEAD').trim();
  const zero = '0'.repeat(40);
  const hits = scanPush(`refs/heads/main ${head} refs/heads/main ${zero}\n`, dir, []);
  assert.deepEqual(hits.map((h) => h.rule), ['email address']);
  assert.deepEqual(scanRepo(dir, []), [], 'CONTROL: the tree itself is clean');
  // A force-added overlay path and a term in the commit message are caught too.
  fs.mkdirSync(path.join(dir, 'ops', 'private'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ops', 'private', 'x.sh'), 'echo\n'); g('add', '.'); g('commit', '-qm', 'for Zebulonia');
  const h2 = g('rev-parse', 'HEAD').trim();
  const rules = scanPush(`refs/heads/main ${h2} refs/heads/main ${head}\n`, dir, ['Zebulonia']).map((h) => h.rule).sort();
  assert.deepEqual(rules, ['reserved overlay path', 'term #1']);
  assert.ok(scanRepo(dir, []).some((h) => h.rule === 'reserved overlay path'), 'the tree scan rejects it as well');
  fs.rmSync(dir, { recursive: true, force: true });
});
