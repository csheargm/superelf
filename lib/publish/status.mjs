// Is this app already in the public repo? · 应用与公开仓库的差别 (docs/adr/0039 addendum).
// Compares the bytes Publish WOULD send (collectApp, meta sanitized) with the repo copy this node
// runs from (<root>/workspace.example/apps/<slug>/, collected the same way). Local only: no GitHub
// call. After a publish the node shows "changed" until the release is deployed to it.
import fs from 'node:fs';
import path from 'node:path';
import { collectApp } from './collect.mjs';

export const STATUS_TTL_MS = 10000;
const cache = new Map();   // key → { at, value }

// Returns { inRepo, upToDate, changedFiles } — changedFiles counts added and changed files. A file
// only in the repo copy is not counted: Publish only writes files, it never removes one, so
// counting it would leave "1 change" that no publish can clear.
export function repoStatus({ appDir, slug, root }) {
  const repoDir = path.join(root, 'workspace.example', 'apps', slug);
  const mine = collectApp(appDir, slug).files;
  if (!fs.existsSync(path.join(repoDir, 'index.html'))) return { inRepo: false, upToDate: false, changedFiles: mine.length };
  const theirs = new Map(collectApp(repoDir, slug).files.map((f) => [f.path, f.content]));
  let changed = 0;
  for (const f of mine) { const t = theirs.get(f.path); if (!t || !t.equals(f.content)) changed++; }
  return { inRepo: true, upToDate: changed === 0, changedFiles: changed };
}

// The ⋯ menu asks on every open; a short cache keeps that cheap. Errors are not cached.
export function cachedRepoStatus(args, now = Date.now()) {
  const key = `${args.appDir}\0${args.slug}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < STATUS_TTL_MS) return hit.value;
  const value = repoStatus(args);
  cache.set(key, { at: now, value });
  return value;
}
