// Cut the release after a publish merge · 合并后发版 (docs/adr/0039 §6, keeps ADR 0038's guarantee).
// In a throwaway clone: run THIS node's bump tool (not code fetched from the clone), commit
// "release: vX.Y.Z", push. Main moved meanwhile → re-fetch and redo, at most MAX_TRIES times.
// The token reaches git through GIT_CONFIG_* env (an http.extraHeader), never argv or a remote URL,
// so it is in no process list and no .git/config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run as bumpVersion } from '../../tools/bump-version.mjs';
import { PublishError } from './collect.mjs';

export const MAX_TRIES = 3;
export const RELEASE_IDENTITY = { name: 'csheargm', email: 'csheargm@users.noreply.github.com' };

function gitEnv(token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: RELEASE_IDENTITY.name, GIT_AUTHOR_EMAIL: RELEASE_IDENTITY.email,
    GIT_COMMITTER_NAME: RELEASE_IDENTITY.name, GIT_COMMITTER_EMAIL: RELEASE_IDENTITY.email };
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` });
  return env;
}

// Strip the token from anything git printed before it reaches a notice (R5 + never logged).
const clean = (s, token) => (token ? String(s).split(token).join('***') : String(s)).slice(0, 400);

function tryOnce(dir, g) {
  g('fetch', '-q', 'origin', 'main');
  g('reset', '-q', '--hard', 'origin/main');
  const r = bumpVersion(dir, [], (a) => g(...a));
  if (r.code) throw new PublishError('BUMP_FAILED', `版本升级失败 · Version bump failed: ${r.out}`);
  if (!g('status', '--porcelain', '--', 'package.json', 'version-notes.json').trim()) return { version: r.out.replace(/ .*/, ''), pushed: false };
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  g('commit', '-qam', `release: v${version}`);
  g('push', '-q', 'origin', 'HEAD:main');
  return { version: `v${version}`, pushed: true };
}

// remoteUrl: https URL of the public repo (a local path in tests). Returns { version, pushed, tries }.
export function cutRelease({ remoteUrl, token, tmpRoot = os.tmpdir() }) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'publish-release-'));
  const env = gitEnv(token);
  const g = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    execFileSync('git', ['clone', '-q', '--branch', 'main', remoteUrl, dir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let last;
    for (let i = 1; i <= MAX_TRIES; i++) {
      try { return { ...tryOnce(dir, g), tries: i }; }
      catch (e) {
        if (e instanceof PublishError) throw e;
        last = e;   // a refused push (main moved): fetch and redo the bump on the new tip
      }
    }
    throw new PublishError('RELEASE_PUSH_FAILED', `发版推送失败 · Release push refused ${MAX_TRIES}x: ${clean(last.stderr || last.message, token)}`);
  } catch (e) {
    if (e instanceof PublishError) throw e;
    throw new PublishError('RELEASE_FAILED', `发版失败 · Release failed: ${clean(e.stderr || e.message, token)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
