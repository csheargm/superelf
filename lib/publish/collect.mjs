// Collect an app's CODE for publishing · 收集应用代码 (docs/adr/0039 §2).
// Only allow-listed code kinds leave the node: never data/, never a symlink, never a path that
// resolves outside the app folder, never a file over the size cap. Anything refused is reported,
// not silently skipped, so the owner sees why a file did not go (R5).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { reservedPath } from '../../tools/privacy-scan.mjs';
import { slugOk } from '../webutil.mjs';

export const CODE_EXTS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.png']);
export const CODE_JSON = new Set(['meta.json', 'manifest.json']);   // the only JSON that is code, not data
export const MAX_FILE_BYTES = 1 << 20;        // 1 MiB per file
export const MAX_TOTAL_BYTES = 5 << 20;       // 5 MiB per app
export const MAX_FILES = 200;
const SKIP_DIRS = new Set(['data', 'node_modules', '.git']);
// meta.json fields that describe the owner's copy, not the app: dropped from the published meta.
// The shelf's own fields (lib/sharedapps.mjs promote) too: promotedFrom names an account, and files
// fingerprints every file of the shelf copy, data/ included (GPT review, copy-back).
const LOCAL_META = ['shared', 'forkedFrom', 'gitRef', 'dataSettings', 'sharedBy', 'promotedAt', 'promotedFrom', 'files'];

export const PublishError = class extends Error { constructor(code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra); } };

const isCode = (name) => CODE_JSON.has(name) || CODE_EXTS.has(path.extname(name).toLowerCase());

function walk(appDir, rel, out, refused) {
  for (const e of fs.readdirSync(path.join(appDir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) { refused.push({ file: r, why: 'symlink' }); continue; }
    if (e.isDirectory()) { if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue; walk(appDir, r, out, refused); continue; }
    if (!e.isFile()) { refused.push({ file: r, why: 'not a regular file' }); continue; }
    if (e.name.startsWith('.') || !isCode(e.name) || (e.name.endsWith('.json') && rel)) { refused.push({ file: r, why: 'not a code file' }); continue; }
    out.push(r);
  }
}

function sanitizeMeta(buf, slug, owner) {
  let meta;
  try { meta = JSON.parse(buf.toString('utf8')); } catch (e) { throw new PublishError('BAD_META', `meta.json 无法解析 · meta.json is not valid JSON: ${e.message}`); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new PublishError('BAD_META', 'meta.json 不是对象 · meta.json is not an object');
  refuseForkMeta(meta, slug, owner);   // again, on the very bytes that are hashed
  for (const k of LOCAL_META) delete meta[k];
  return Buffer.from(JSON.stringify(meta, null, 2) + '\n');
}

// The repo app a copy came from, or null. forkedFrom is a string (a shelf copy, lib/sharedapps.mjs
// fork — its local slug may carry '-mine') or an object (a copy of a user's app, web.mjs): only the
// owner's OWN app counts (uid === owner); another user's app is not theirs to publish.
export function copySource(ff, owner) {
  const s = typeof ff === 'string' ? ff : (ff && typeof ff === 'object' && owner && ff.uid === owner ? ff.slug : null);
  return typeof s === 'string' && slugOk(s) ? s : null;
}
// A copy publishes only as the app it came from (slug = its source) and only for the owner.
function refuseForkMeta(meta, slug, owner) {
  if (!meta || typeof meta !== 'object' || !meta.forkedFrom) return;
  if (!owner || copySource(meta.forkedFrom, owner) !== slug) throw new PublishError('FORKED_APP', '复制来的应用不能发布 · A forked app cannot be published');
}

// A fork is someone else's app (docs/adr/0039): the server refuses it, not only the UI. Checked
// BEFORE any file exclusion, and fail closed: a meta.json that is a link, oversize or unreadable
// cannot prove the app is not a fork, so it refuses rather than being skipped.
// The app's meta.json, read fail closed: {} when there is none; a link, a non-file, an oversize or
// unparsable one throws BAD_META (it is never read in full or opened as a FIFO).
export function readAppMeta(dir) {
  const f = path.join(dir, 'meta.json');
  let st;
  try { st = fs.lstatSync(f); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new PublishError('BAD_META', 'meta.json 不是普通小文件 · meta.json is not a plain, small file');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { throw new PublishError('BAD_META', `meta.json 无法解析 · meta.json is not valid JSON: ${e.message}`); }
}
function refuseFork(real, slug, owner) { refuseForkMeta(readAppMeta(real), slug, owner); }

// One hash over the exact collected bytes (paths + contents, in order): preview hands it to the
// owner's sheet and Publish refuses unless the snapshot it collects again hashes the same.
// dest (repo, API host, release remote) is bound in too: a config change after the preview cannot redirect it.
export function snapshotHash(files, dest = '') {
  const h = crypto.createHash('sha256');
  h.update(`${dest}\0`);
  for (const f of files) { h.update(`${f.path}\0${f.content.length}\0`); h.update(f.content); }
  return h.digest('hex');
}

// Returns { files: [{ path, content: Buffer }], refused: [{ file, why }] }. Throws PublishError.
// slug: the repo folder it goes to. owner (the owner's uid): a copy of a repo app is collected
// as that app (lib/publish/copy-target.mjs); without it every copy is refused.
export function collectApp(appDir, slug, { owner } = {}) {
  const real = fs.realpathSync(appDir);
  if (fs.lstatSync(appDir).isSymbolicLink()) throw new PublishError('LINKED_APP', '应用目录是链接 · The app folder is a link');
  if (!fs.existsSync(path.join(real, 'index.html'))) throw new PublishError('NO_INDEX', '应用没有 index.html · The app has no index.html');
  refuseFork(real, slug, owner);
  const names = [], refused = [];
  walk(real, '', names, refused);
  if (names.length > MAX_FILES) throw new PublishError('TOO_MANY', `文件过多 · Too many files (${names.length} > ${MAX_FILES})`);
  let total = 0;
  const files = [];
  for (const rel of names.sort()) {
    const abs = path.resolve(real, rel);
    if (rel.split('/').includes('..') || !abs.startsWith(real + path.sep)) { refused.push({ file: rel, why: 'outside the app' }); continue; }
    const st = fs.lstatSync(abs);
    if (st.size > MAX_FILE_BYTES) { refused.push({ file: rel, why: `over ${MAX_FILE_BYTES} bytes` }); continue; }
    total += st.size;
    if (total > MAX_TOTAL_BYTES) throw new PublishError('TOO_BIG', `应用过大 · The app is over ${MAX_TOTAL_BYTES} bytes`);
    const dest = `workspace.example/apps/${slug}/${rel}`;
    if (reservedPath(dest)) { refused.push({ file: rel, why: 'reserved path' }); continue; }
    const raw = fs.readFileSync(abs);
    files.push({ path: dest, content: rel === 'meta.json' ? sanitizeMeta(raw, slug, owner) : raw });
  }
  return { files, refused };
}
