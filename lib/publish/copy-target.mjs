// Where the owner's Publish goes · 发布到哪个应用 (docs/adr/0039 addendum 2026-11-25).
// An own app goes to workspace.example/apps/<its slug>/. A copy of a repo app (a shelf copy, maybe
// renamed <slug>-mine, or a copy of the owner's own app) goes back to THAT app's folder. A copy of
// another user's app, or of an app that is not in the repo, is refused with what to do instead.
import fs from 'node:fs';
import path from 'node:path';
import { copySource, readAppMeta, PublishError } from './collect.mjs';

export const OTHER_USER_LINE = (who) => `这是 ${who} 的应用的副本，只能发布你自己的应用；可用“做个应用”做一个你自己的版本再发布 · This is a copy of ${who}'s app; you can only publish your own apps. Use Make an app to build your own version, then publish that.`;
export const NOT_IN_REPO_LINE = '这个副本的原应用不在公开仓库里，无法发回；可用“做个应用”做一个你自己的版本再发布 · The app this was copied from is not in the public repo, so the change cannot go back to it. Use Make an app to build your own version, then publish that.';

export const OTHER_REPO_LINE = '副本只能发回默认的公开仓库；当前设置的是另一个仓库 · A copy can only go back to the default public repo; Publish is set to another repo.';
const sourceTitle = (dir, slug) => { try { return String(readAppMeta(dir).title || slug).slice(0, 80); } catch { return slug; /* a bad repo meta: the slug names it */ } };
// The node's shelf entry for this slug (<root>/shared-apps/<src>): a shelf app another account
// shared is THEIR code even when a repo app has the same slug (GPT review, copy-back).
function sharedByOther(root, src, owner) {
  let m; try { m = readAppMeta(path.join(root, 'shared-apps', src)); } catch { return true; /* unreadable: cannot prove it is the owner's, refuse */ }
  return !!m.sharedBy && m.sharedBy !== owner;
}

// Returns { slug, copyOf: null } for an own app, or { slug: <source>, copyOf: { slug, title } }.
// Throws PublishError FORK_OTHER / FORK_NOT_IN_REPO for a copy that cannot go back.
// defaultRepo: false when Publish is set to another repo — the source check below reads this node's
// bundled repo, so a copy cannot vouch for a folder in a different one.
export function publishTarget({ appDir, slug, owner, root, defaultRepo = true }) {
  const ff = readAppMeta(appDir).forkedFrom;
  if (!ff) return { slug, copyOf: null };
  const src = copySource(ff, owner);
  if (!src || (typeof ff === 'string' && sharedByOther(root, src, owner))) {
    const who = ff && typeof ff === 'object' ? String(ff.author || ff.uid || '?').slice(0, 40) : '另一位用户 another user';
    throw new PublishError('FORK_OTHER', OTHER_USER_LINE(who));
  }
  if (!defaultRepo) throw new PublishError('FORK_OTHER_REPO', OTHER_REPO_LINE);
  const repoDir = path.join(root, 'workspace.example', 'apps', src);
  if (!fs.existsSync(path.join(repoDir, 'index.html'))) throw new PublishError('FORK_NOT_IN_REPO', NOT_IN_REPO_LINE);
  return { slug: src, copyOf: { slug: src, title: sourceTitle(repoDir, src) } };
}
