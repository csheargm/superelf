import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { slugOk, writeFileAtomic } from './webutil.mjs';
// stamp, copyNoLinks and refuseLinkedSource live in lib/app-versions.mjs, shared with the per-app
// version history of 改这个应用 · Change this app (ADR 0040, R3). Re-exported for existing callers.
import { stamp, copyNoLinks, refuseLinkedSource, LINKED_SOURCE } from './app-versions.mjs';
export { copyNoLinks, refuseLinkedSource, LINKED_SOURCE };


// Owner-curated shared apps: one blessed copy per slug under <shared>/<slug>,
// with every superseded version archived under <shared>/.versions/<slug>/.
// Single-writer by construction — only promote/rollback/unshare mutate <shared>.

function archive(shared, slug, why) {
  const live = path.join(shared, slug);
  if (!fs.existsSync(live)) return;
  const dir = path.join(shared, '.versions', slug, `${stamp()}-${why}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(live, dir);
}

export function versionsOf(shared, slug) {
  const d = path.join(shared, '.versions', slug);
  if (!slugOk(slug) || !fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((n) => !n.startsWith('.')).sort().reverse();
}

// Every file in a promoted app, by sha1. The old fingerprint was sha1(index.html) alone, so a
// multi-file app was invisible to both "is there an update" and "did the user edit this".
export function fileManifest(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'meta.json') continue;   // meta carries the manifest itself
      // '/' ALWAYS, never path.join: this string is a manifest KEY, not a filesystem path.
      // path.join yields 'sub\\file.js' on Windows and 'sub/file.js' elsewhere, so the same app
      // would fingerprint differently per OS and every nested file would read as changed.
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out[r] = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, ...r.split('/')))).digest('hex').slice(0, 12);
    }
  };
  walk('');
  return out;
}

// A promote is a RELEASE, and it now says so on the copy itself. It used to write only
// `sharedBy`, which left three things broken downstream: the shelf copy kept whatever `shared`
// flag the source happened to have (bible's said FALSE, and listShared forced it true at read
// time to hide that); there was no version or gitRef, so /changelog had nothing to diff and the
// update check had nothing to compare; and there was no per-file fingerprint, so a multi-file app
// could not be told apart from its own fork. `gitRef` is passed in rather than shelled out for,
// so this module stays free of git.
export function promote(shared, slug, srcAppDir, byUser, opts = {}) {
  if (!slugOk(slug)) throw new Error('bad slug');
  if (!fs.existsSync(path.join(srcAppDir, 'index.html'))) throw new Error('app has no index.html');
  refuseLinkedSource(srcAppDir);                           // before the archive empties the shelf entry
  archive(shared, slug, 'replaced');                       // the undo, before anything is written
  const dst = path.join(shared, slug);
  copyNoLinks(srcAppDir, dst);
  const meta = path.join(dst, 'meta.json');
  let m = {}; try { m = JSON.parse(fs.readFileSync(meta, 'utf8')) || {}; } catch { /* optional */ }
  m.shared = true;                                          // it is ON the shelf; saying otherwise was a lie
  m.sharedBy = byUser;
  m.version = typeof m.version === 'string' && m.version.trim() ? m.version.trim() : '1.0.0';
  if (opts.gitRef) m.gitRef = opts.gitRef;
  m.promotedAt = new Date().toISOString();
  m.promotedFrom = { uid: byUser, slug };
  m.files = fileManifest(dst);
  delete m.forkedFrom;                                      // a shelf copy is an origin, not a fork
  writeFileAtomic(meta, JSON.stringify(m, null, 2) + '\n');
  return m;
}

export function rollback(shared, slug) {
  const prev = versionsOf(shared, slug)[0];
  if (!prev) throw new Error('no previous version');
  const prevDir = path.join(shared, '.versions', slug, prev);
  archive(shared, slug, 'rolled-back'); // current is archived too — rollback is reversible
  fs.renameSync(prevDir, path.join(shared, slug));
  return prev;
}

export function unshare(shared, slug) {
  if (!slugOk(slug)) throw new Error('bad slug');
  archive(shared, slug, 'unshared'); // archived, never destroyed
}

export function listShared(shared) {
  if (!fs.existsSync(shared)) return [];
  return fs.readdirSync(shared, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && slugOk(d.name) && fs.existsSync(path.join(shared, d.name, 'index.html')))
    .map((d) => {
      let m = {}; try { m = JSON.parse(fs.readFileSync(path.join(shared, d.name, 'meta.json'), 'utf8')) || {}; } catch { /* optional */ }
      return { name: d.name, title: String(m.title || d.name), desc: String(m.desc || ''), sharedBy: m.sharedBy || '', shared: true, versions: versionsOf(shared, d.name).length };
    });
}

// Fork a shared app into a user's own workspace for private editing.
// fork's own refusals carry FORK_REFUSED, so the route answers them 400 and any other failure 500.
export const FORK_REFUSED = 'fork_refused';
const refused = (msg) => Object.assign(new Error(msg), { code: FORK_REFUSED });
export function fork(shared, slug, userAppsDir) {
  if (!slugOk(slug)) throw refused('bad slug');
  const src = path.join(shared, slug);
  if (!fs.existsSync(path.join(src, 'index.html'))) throw refused('not found');
  let dst = path.join(userAppsDir, slug);
  if (fs.existsSync(dst)) dst = path.join(userAppsDir, `${slug}-mine`);
  if (fs.existsSync(dst)) throw refused('you already have a copy');
  fs.mkdirSync(userAppsDir, { recursive: true });
  copyNoLinks(src, dst);
  const meta = path.join(dst, 'meta.json');
  let m = {}; try { m = JSON.parse(fs.readFileSync(meta, 'utf8')) || {}; } catch { /* optional */ }
  delete m.sharedBy; m.forkedFrom = slug;
  writeFileAtomic(meta, JSON.stringify(m, null, 2));
  return path.basename(dst);
}
