// Per-app version history · 应用版本记录 (docs/adr/0040-change-this-app.md).
//
// 改这个应用 · Change this app edits a LIVE app while its user is using it, so every change must be
// undoable at once. Before an edit turn the app folder is copied to <versions>/<slug>/<stamp>-edit;
// 撤销 · Undo puts the newest such copy back and keeps what it replaced as <stamp>-undo, so an undo is
// itself recoverable. Copies, never renames: the live app stays in place while the agent works.
//
// stamp / copyNoLinks / refuseLinkedSource moved here from lib/sharedapps.mjs (R3): the shelf's
// archive and this history are the same mechanism, so they share one copy and one clock.
import fs from 'node:fs';
import path from 'node:path';
import { slugOk } from './webutil.mjs';

// Millisecond resolution ALONE is not unique: promote-then-rollback, or two rollbacks in a row,
// land in the same millisecond and archive() renames onto an existing directory — which fails
// with ENOTEMPTY and aborts the operation half-done. Measured: 3 failures in 6 runs of
// test/sharedapps.test.mjs before the counter was added. A per-process counter makes the name
// unique without depending on the clock's resolution.
let _stampN = 0;
// Zero-padded so names sort by time as strings: '-10' would sort before '-9' (newest-first lists).
export const stamp = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${String((_stampN += 1)).padStart(6, '0')}`;

// App dirs are agent-writable; a symlink inside one could point at private files.
// Strip links when copying so nothing outside the app dir ever travels with it.
// A source that IS a link would be copied as that link, and copyNoLinks' walk would then delete links
// inside the folder it points at (R13, 2026-10-13). Refused before anything is touched — by promote
// too, BEFORE it archives the live shelf copy. `code` lets a route tell this refusal from a failure.
export const LINKED_SOURCE = 'linked_source';
export function refuseLinkedSource(src) {
  if (fs.lstatSync(src).isSymbolicLink()) throw Object.assign(new Error('an app folder that is a link is not copied · 链接形式的应用目录不予复制'), { code: LINKED_SOURCE });
}
export function copyNoLinks(src, dst) {
  refuseLinkedSource(src);
  fs.cpSync(src, dst, { recursive: true, dereference: false });
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) fs.rmSync(p, { force: true });
      else if (e.isDirectory()) walk(p);
    }
  })(dst);
}


export const EDIT_WHY = 'edit';
export const UNDO_WHY = 'undo';
// Kept per app; older copies are pruned on each new snapshot. An app is small (one page), so 20 copies
// are cheap, and a day of edits by one person rarely passes it.
export const VERSIONS_KEPT = 20;

// The history folder and the app's folder in it must be real folders: a link there would send the
// copies (and the pruning) somewhere else (GPT review 2026-11-24).
const notLink = (p) => { try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error('a linked version folder is refused · 版本目录不能是链接'); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
const slugDir = (root, slug) => {
  if (!slugOk(slug)) throw new Error('bad slug');
  notLink(root); notLink(path.join(root, slug));
  return path.join(root, slug);
};

// Newest first; dot-names (a copy in progress) are not versions.
export function listVersions(root, slug) {
  const d = slugDir(root, slug);
  try { return fs.readdirSync(d).filter((n) => !n.startsWith('.')).sort().reverse(); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

// Copy the live app to a new version; returns its name. The copy is written under a dot-name and
// renamed into place, so a crash mid-copy never leaves a half version that undo would restore.
export function snapshotApp(appDir, root, slug, why, { prune = true } = {}) {
  const d = slugDir(root, slug);
  fs.mkdirSync(d, { recursive: true });
  const name = `${stamp()}-${why}`;
  const tmp = path.join(d, '.' + name);
  copyNoLinks(appDir, tmp);
  fs.renameSync(tmp, path.join(d, name));
  if (prune) pruneVersions(root, slug);
  return name;
}
// Oldest copies past VERSIONS_KEPT go. Called once the outcome is known, so a turn that changed nothing
// never costs an undo point (GPT review 2026-11-24).
export function pruneVersions(root, slug) {
  const d = slugDir(root, slug);
  for (const old of listVersions(root, slug).slice(VERSIONS_KEPT)) fs.rmSync(path.join(d, old), { recursive: true, force: true });
}

// Replace the live app with a version (the version stays). Built beside the live folder and swapped
// in, so the app is never missing for longer than two renames.
export function restoreVersion(appDir, root, slug, name) {
  const src = path.join(slugDir(root, slug), name);
  if (!name || name.includes('/') || name.startsWith('.') || !fs.existsSync(src)) throw new Error('no such version');
  const next = appDir + '.restoring', old = appDir + '.replaced';
  fs.rmSync(next, { recursive: true, force: true }); fs.rmSync(old, { recursive: true, force: true });
  copyNoLinks(src, next);
  if (fs.existsSync(appDir)) fs.renameSync(appDir, old);
  try { fs.renameSync(next, appDir); }
  catch (e) { if (!fs.existsSync(appDir) && fs.existsSync(old)) fs.renameSync(old, appDir); throw e; }   // never leave the app missing
  fs.rmSync(old, { recursive: true, force: true });
}

export function dropVersion(root, slug, name) {
  if (!name || name.includes('/') || name.startsWith('.')) return;
  fs.rmSync(path.join(slugDir(root, slug), name), { recursive: true, force: true });
}

// 撤销 · Undo: the newest pre-edit copy goes back live. What it replaces is kept as an 'undo' copy;
// the restored copy is dropped, so the next undo walks one edit further back. null = nothing to undo.
export function undoLastEdit(appDir, root, slug) {
  const prev = listVersions(root, slug).find((n) => n.endsWith('-' + EDIT_WHY));
  if (!prev) return null;
  snapshotApp(appDir, root, slug, UNDO_WHY, { prune: false });
  restoreVersion(appDir, root, slug, prev);
  dropVersion(root, slug, prev);
  pruneVersions(root, slug);   // after the restored copy is gone: 20 kept edits give 20 undos
  return prev;
}

// path → "size:mtimeMs" for every file in an app folder: did this turn change anything?
export function treeStamp(dir) {
  const out = {};
  const walk = (rel) => {
    let ents;
    try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else { const st = fs.lstatSync(path.join(dir, r)); out[r] = `${st.size}:${st.mtimeMs}`; }
    }
  };
  walk('');
  return out;
}
export const sameTree = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
