// Where the owner's Publish goes · 发布到哪个应用 (docs/adr/0039 addendum 2026-11-25).
// An own app goes to workspace.example/apps/<its slug>/. A copy of a repo app (a shelf copy, maybe
// renamed <slug>-mine, or a copy of the owner's own app) goes back to THAT app's folder. A copy of
// another user's app, or of an app that is not in the repo, is refused with what to do instead.
import fs from 'node:fs';
import path from 'node:path';
import { copySource, PublishError } from './collect.mjs';

export const OTHER_USER_LINE = (who) => `这是 ${who} 的应用的副本，只能发布你自己的应用；可用“做个应用”做一个你自己的版本再发布 · This is a copy of ${who}'s app; you can only publish your own apps. Use Make an app to build your own version, then publish that.`;
export const NOT_IN_REPO_LINE = '这个副本的原应用不在公开仓库里，无法发回；可用“做个应用”做一个你自己的版本再发布 · The app this was copied from is not in the public repo, so the change cannot go back to it. Use Make an app to build your own version, then publish that.';

const readMeta = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) || {}; } catch { return {}; /* no or bad meta: the folder name stands in for the title */ } };

// Returns { slug, copyOf: null } for an own app, or { slug: <source>, copyOf: { slug, title } }.
// Throws PublishError FORK_OTHER / FORK_NOT_IN_REPO for a copy that cannot go back.
export function publishTarget({ appDir, slug, owner, root }) {
  const ff = readMeta(appDir).forkedFrom;
  if (!ff) return { slug, copyOf: null };
  const src = copySource(ff, owner);
  if (!src) {
    const who = ff && typeof ff === 'object' ? String(ff.author || ff.uid || '?').slice(0, 40) : '?';
    throw new PublishError('FORK_OTHER', OTHER_USER_LINE(who));
  }
  const repoDir = path.join(root, 'workspace.example', 'apps', src);
  if (!fs.existsSync(path.join(repoDir, 'index.html'))) throw new PublishError('FORK_NOT_IN_REPO', NOT_IN_REPO_LINE);
  return { slug: src, copyOf: { slug: src, title: String(readMeta(repoDir).title || src).slice(0, 80) } };
}
