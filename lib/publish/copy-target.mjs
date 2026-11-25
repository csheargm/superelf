// Where the owner's Publish goes · 发布到哪个应用 (docs/adr/0039 addendum 2026-11-25).
// An own app goes to workspace.example/apps/<its slug>/. The owner's copy of a repo app goes back to
// THAT app's repo folder: a shelf copy (forkedFrom "<slug>", maybe renamed <slug>-mine) to the repo's
// shelf tree shared-apps/<slug>/, a copy of the owner's own app (forkedFrom {uid: owner}) to
// workspace.example/apps/<slug>/. A copy of another user's app, or of an app not in the repo, is
// refused with what to do instead.
import fs from 'node:fs';
import path from 'node:path';
import { copySource, readAppMeta, PublishError, APPS_BASE, SHELF_BASE } from './collect.mjs';

const MAKE = '可用“做个应用”做一个你自己的版本再发布 · Use Make an app to build your own version, then publish that.';
export const OTHER_USER_LINE = (zh, en = zh) => `这是${zh}的应用的副本，只能发布你自己的应用；${MAKE.split(' · ')[0]} · This is a copy of ${en}'s app; you can only publish your own apps. ${MAKE.split(' · ')[1]}`;
export const NOT_IN_REPO_LINE = `这个副本的原应用不在公开仓库里，无法发回；${MAKE.split(' · ')[0]} · The app this was copied from is not in the public repo, so the change cannot go back to it. ${MAKE.split(' · ')[1]}`;
export const OTHER_REPO_LINE = '副本只能发回默认的公开仓库；当前设置的是另一个仓库 · A copy can only go back to the default public repo; Publish is set to another repo.';
// A shelf app's repo meta fields the published meta keeps (the copy dropped them: lib/sharedapps.mjs fork).
// `files` is not kept: it would fingerprint the OLD files.
export const SHELF_KEEP = ['shared', 'sharedBy', 'version', 'gitRef', 'promotedAt', 'promotedFrom'];

const sourceTitle = (meta, slug) => String(meta.title || slug).slice(0, 80);
const metaOr = (dir) => { try { return readAppMeta(dir); } catch { return null; /* bad meta: the caller refuses or names the slug */ } };
// The repo's shelf tree on this node: a Docker node carries it under builtin-apps/ (ops/demo/Dockerfile;
// its root shared-apps/ is the LIVE shelf); a git node runs from the checkout itself.
const repoShelf = (root) => (fs.existsSync(path.join(root, 'builtin-apps')) ? path.join(root, 'builtin-apps', SHELF_BASE) : path.join(root, SHELF_BASE));

function refuseOther(ff) {
  if (!ff || typeof ff !== 'object') return new PublishError('FORK_OTHER', OTHER_USER_LINE('另一位用户', 'another user'));
  const who = String(ff.author || ff.uid || '?').slice(0, 40);
  return new PublishError('FORK_OTHER', OTHER_USER_LINE(` ${who} `, who));
}

// Returns { slug, copyOf: null } for an own app, or { slug: <source>, base, keepMeta, copyOf: { slug, title, path } }.
// Throws PublishError FORK_OTHER / FORK_NOT_IN_REPO / FORK_OTHER_REPO / BAD_META.
// defaultRepo: false when Publish (PR or release) points elsewhere — the source check reads THIS
// node's bundled repo, so a copy cannot vouch for a folder in a different one.
export function publishTarget({ appDir, slug, owner, root, defaultRepo = true }) {
  const ff = readAppMeta(appDir).forkedFrom;
  if (!ff) return { slug, copyOf: null };
  const src = copySource(ff, owner);
  if (!src) throw refuseOther(ff);
  let base = APPS_BASE, repoDir = path.join(root, APPS_BASE, src), keepMeta;
  if (typeof ff === 'string') {
    // A shelf copy: the node's shelf entry must be one the OWNER shared (positive proof, fail closed) —
    // a shelf app another account shared is their code even when a repo app has the same slug.
    // No shelf entry (unshared since): nothing proves whose it was, so it cannot go back either.
    const shelfDir = path.join(root, SHELF_BASE, src);
    if (!fs.existsSync(path.join(shelfDir, 'index.html'))) throw new PublishError('FORK_NOT_IN_REPO', NOT_IN_REPO_LINE);
    const live = metaOr(shelfDir);
    if (!live || live.sharedBy !== owner) throw refuseOther(ff);
    base = SHELF_BASE; repoDir = path.join(repoShelf(root), src);
  }
  if (!defaultRepo) throw new PublishError('FORK_OTHER_REPO', OTHER_REPO_LINE);
  if (!fs.existsSync(path.join(repoDir, 'index.html'))) throw new PublishError('FORK_NOT_IN_REPO', NOT_IN_REPO_LINE);
  // A Docker image carries only the shelf's index.html (ops/demo/Dockerfile.dockerignore): its meta then
  // comes from the node's shelf entry, seeded from the same repo copy (GPT review r3).
  const repoMeta = (fs.existsSync(path.join(repoDir, 'meta.json')) ? metaOr(repoDir) : base === SHELF_BASE && metaOr(path.join(root, SHELF_BASE, src))) || {};
  if (base === SHELF_BASE) keepMeta = Object.fromEntries(SHELF_KEEP.filter((k) => k in repoMeta).map((k) => [k, repoMeta[k]]));
  return { slug: src, base, keepMeta, repoDir, copyOf: { slug: src, title: sourceTitle(repoMeta, src), path: `${base}/${src}/` } };
}
