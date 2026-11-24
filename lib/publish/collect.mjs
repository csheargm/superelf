// Collect an app's CODE for publishing · 收集应用代码 (docs/adr/0039 §2).
// Only allow-listed code kinds leave the node: never data/, never a symlink, never a path that
// resolves outside the app folder, never a file over the size cap. Anything refused is reported,
// not silently skipped, so the owner sees why a file did not go (R5).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { reservedPath } from '../../tools/privacy-scan.mjs';

export const CODE_EXTS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.png']);
export const CODE_JSON = new Set(['meta.json', 'manifest.json']);   // the only JSON that is code, not data
export const MAX_FILE_BYTES = 1 << 20;        // 1 MiB per file
export const MAX_TOTAL_BYTES = 5 << 20;       // 5 MiB per app
export const MAX_FILES = 200;
const SKIP_DIRS = new Set(['data', 'node_modules', '.git']);
// meta.json fields that describe the owner's copy, not the app: dropped from the published meta.
const LOCAL_META = ['shared', 'forkedFrom', 'gitRef', 'dataSettings'];

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

function sanitizeMeta(buf) {
  let meta;
  try { meta = JSON.parse(buf.toString('utf8')); } catch (e) { throw new PublishError('BAD_META', `meta.json 无法解析 · meta.json is not valid JSON: ${e.message}`); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new PublishError('BAD_META', 'meta.json 不是对象 · meta.json is not an object');
  // A fork is someone else's app (docs/adr/0039): the server refuses it, not only the UI.
  if (meta.forkedFrom) throw new PublishError('FORKED_APP', '复制来的应用不能发布 · A forked app cannot be published');
  for (const k of LOCAL_META) delete meta[k];
  return Buffer.from(JSON.stringify(meta, null, 2) + '\n');
}

// One hash over the exact collected bytes (paths + contents, in order): preview hands it to the
// owner's sheet and Publish refuses unless the snapshot it collects again hashes the same.
export function snapshotHash(files) {
  const h = crypto.createHash('sha256');
  for (const f of files) { h.update(`${f.path}\0${f.content.length}\0`); h.update(f.content); }
  return h.digest('hex');
}

// Returns { files: [{ path, content: Buffer }], refused: [{ file, why }] }. Throws PublishError.
export function collectApp(appDir, slug) {
  const real = fs.realpathSync(appDir);
  if (fs.lstatSync(appDir).isSymbolicLink()) throw new PublishError('LINKED_APP', '应用目录是链接 · The app folder is a link');
  if (!fs.existsSync(path.join(real, 'index.html'))) throw new PublishError('NO_INDEX', '应用没有 index.html · The app has no index.html');
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
    files.push({ path: dest, content: rel === 'meta.json' ? sanitizeMeta(raw) : raw });
  }
  return { files, refused };
}
