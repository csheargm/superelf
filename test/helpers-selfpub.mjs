// A throwaway superelf "public repo" for the core-change tests: a bare remote with package.json,
// version-notes.json, a web page and one passing privacy test; privacy term files; and doMerge, what a
// real GitHub merge does to main (so cutRelease has something to release). Never the real repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
export const tgit = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// web: true copies the repo's real web/ in, so the render check (lib/selfpub/render.mjs) has a real shell to draw.
export function selfpubFixture({ web = false } = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selfpub-')));
  const work = path.join(d, 'work'); fs.mkdirSync(path.join(work, 'web'), { recursive: true }); fs.mkdirSync(path.join(work, 'test'));
  tgit(work, 'init', '-q', '-b', 'main');
  if (web) fs.cpSync(path.join(REPO, 'web'), path.join(work, 'web'), { recursive: true });
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ version: '5.0.0' }, null, 2) + '\n');
  fs.writeFileSync(path.join(work, 'version-notes.json'), JSON.stringify({ 'v5.0.0': { date: '2026-10-12', features: [], fixes: [] } }, null, 2) + '\n');
  fs.writeFileSync(path.join(work, 'web', 'home.css'), 'body{color:#111}\n');
  // Fails when web/home.css says BOOM: a data-only change that breaks a trusted test (tests run in the checkout).
  fs.writeFileSync(path.join(work, 'test', 'public-privacy.test.mjs'), "import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('ok', () => { if (fs.readFileSync('web/home.css', 'utf8').includes('BOOM')) throw new Error('boom'); });\n");
  tgit(work, 'add', '.'); tgit(work, 'commit', '-qm', 'base'); tgit(work, 'tag', 'v5.0.0');
  const bare = path.join(d, 'remote.git'); tgit(d, 'clone', '-q', '--bare', work, bare); tgit(work, 'remote', 'add', 'origin', bare);
  const terms = path.join(d, 'terms'); fs.mkdirSync(path.join(terms, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(terms, 'privacy-terms.txt'), 'Zorblax\n'); fs.writeFileSync(path.join(terms, 'workspace', 'identity-denylist.txt'), 'Quux Town\n');
  const doMerge = (pr) => {
    tgit(work, 'fetch', '-q', 'origin'); tgit(work, 'checkout', '-q', '-B', 'main', 'origin/main');
    tgit(work, 'checkout', '-qb', 'selfbranch'); fs.appendFileSync(path.join(work, 'web', 'home.css'), '/* merged */\n');
    tgit(work, 'commit', '-qam', 'feat(self): change'); tgit(work, 'checkout', '-q', 'main');
    tgit(work, 'merge', '-q', '--no-ff', 'selfbranch', '-m', pr.mergeTitle); tgit(work, 'push', '-q', 'origin', 'main'); tgit(work, 'branch', '-qD', 'selfbranch');
  };
  return { d, root: path.join(d, 'src'), bare, terms, work, doMerge };
}
