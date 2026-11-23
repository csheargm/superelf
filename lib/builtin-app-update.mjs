// Built-in app updates for installed copies · 内置应用更新
// A Docker node has no git: its workspace/apps/<slug> and shared-apps/<slug> were seeded once and a
// deploy never touched them, so the owner kept an old Bible (F2-03 missing on the private node).
// The image now carries the repo's current copies under builtin-apps/ (ops/demo/Dockerfile). At start,
// an installed index.html is replaced ONLY when its sha256 is a known, unedited repo version
// (lib/builtin-app-versions.json, from tools/gen-builtin-app-versions.mjs). An unknown hash means the
// user edited the app: it is left alone and reported. Only index.html is written — never data/, never
// another file; a shelf copy's meta.json keeps every field but its `files` manifest.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic, writeJsonFile } from './atomicwrite.mjs';
import { fileManifest } from './sharedapps.mjs';

export const BUILTIN_DIR = 'builtin-apps';
export const BUILTIN_OWNER = 'workspace-apps';   // the repo's workspace/apps/*/index.html
export const BUILTIN_SHARED = 'shared-apps';     // the repo's shared-apps/*/index.html
export const VERSIONS_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), 'builtin-app-versions.json');
const PAGE = 'index.html';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const slugsIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, PAGE))).map((e) => e.name) : []);

// srcApps: the image's copies; destApps: the installed apps folder; known: { slug: [sha256…] }.
// Returns { updated, edited, current } slug lists. Throws on a filesystem error (the caller reports it).
export function updateInstalledApps(srcApps, destApps, known) {
  const out = { updated: [], edited: [], current: [] };
  for (const slug of slugsIn(srcApps)) {
    const dest = path.join(destApps, slug, PAGE);
    if (!fs.existsSync(dest) || fs.lstatSync(dest).isSymbolicLink()) continue;   // not installed (or not a plain file): never added here
    const next = fs.readFileSync(path.join(srcApps, slug, PAGE));
    const have = sha256(fs.readFileSync(dest));
    if (have === sha256(next)) { out.current.push(slug); continue; }
    if (!(known[slug] || []).includes(have)) { out.edited.push(slug); continue; }   // the user's edit wins
    writeFileAtomic(dest, next.toString('utf8'));
    const metaF = path.join(destApps, slug, 'meta.json');
    try {
      const meta = JSON.parse(fs.readFileSync(metaF, 'utf8'));
      if (meta && meta.files) writeJsonFile(metaF, { ...meta, files: fileManifest(path.join(destApps, slug)) });
    } catch { /* no meta.json, or one we cannot parse: the page is updated, its user-owned meta is left as it was */ }
    out.updated.push(slug);
  }
  return out;
}

// Start-up step: owner workspaces and the shared shelf. No builtin-apps/ (a git node) → nothing to do.
export function updateBuiltinApps({ root, ownerWorkspaces = [], sharedDir, audit }) {
  const src = path.join(root, BUILTIN_DIR);
  if (!fs.existsSync(src)) return null;
  const known = JSON.parse(fs.readFileSync(VERSIONS_FILE, 'utf8'));
  const jobs = [...ownerWorkspaces.map((w) => [BUILTIN_OWNER, path.join(w, 'apps')]), ...(sharedDir ? [[BUILTIN_SHARED, sharedDir]] : [])];
  const all = [];
  for (const [from, to] of jobs) {
    const r = updateInstalledApps(path.join(src, from), to, known);
    if (r.updated.length || r.edited.length) audit('builtin-apps-update', { dir: to, updated: r.updated, edited: r.edited });
    all.push(r);
  }
  return all;
}
