// 外壳的组成清单 · The shell's parts list, as DATA (web/shell-parts.json), not code.
//
// WHY. The self-publish render check and the 试用 · Try it preview assemble a COPY's shell (an unpublished
// core change) with this node's trusted builder (lib/shellhtml.mjs). When the list lived in code, the builder
// used the NODE's list, so a change that added a part (a new web/skin.js) was never drawn: the check
// photographed a page the change would not produce. As data inside web/, the copy's own list travels with
// the copy — and the node only ever READS it (docs/adr/0049).
//
// The file is agent-writable in a copy, so it is validated as plain data before use: an array of
// { marker, file, why? }, names only. A file is one name under web/ (no slash, no '..', no dot first) with
// an allow-listed extension; a marker is one of the two comment shapes index.html uses. Anything else
// throws (R5): the render check then reports a broken page instead of reading outside web/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PARTS_FILE = 'shell-parts.json';
export const MAX_SHELL_PARTS = 200;   // ~6x today's list: room to grow, still a bound on a copy's file
export const MAX_PARTS_BYTES = 64 * 1024;
export const PART_FILE_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(js|css|html)$/;
export const PART_MARKER_RE = /^(\/\* PA_[A-Z0-9_]+ \*\/|<!--PA_[A-Z0-9_]+-->)$/;
const NODE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// data (parsed JSON) → [[marker, file], ...], or throws naming the first bad entry.
export function validateShellParts(data) {
  if (!Array.isArray(data)) throw new Error(`web/${PARTS_FILE} must be an array`);
  if (data.length > MAX_SHELL_PARTS) throw new Error(`web/${PARTS_FILE} has ${data.length} parts (max ${MAX_SHELL_PARTS})`);
  const seen = new Set();
  return data.map((e, i) => {
    const keys = e && typeof e === 'object' && !Array.isArray(e) ? Object.keys(e) : null;
    if (!keys || keys.some((k) => !['marker', 'file', 'why'].includes(k))) throw new Error(`web/${PARTS_FILE} entry ${i}: only marker, file, why`);
    const { marker, file, why = '' } = e;
    if (typeof marker !== 'string' || !PART_MARKER_RE.test(marker)) throw new Error(`web/${PARTS_FILE} entry ${i}: bad marker`);
    if (typeof file !== 'string' || !PART_FILE_RE.test(file)) throw new Error(`web/${PARTS_FILE} entry ${i}: bad file name`);
    if (typeof why !== 'string') throw new Error(`web/${PARTS_FILE} entry ${i}: why must be text`);
    if (seen.has(marker) || seen.has(file)) throw new Error(`web/${PARTS_FILE} entry ${i}: ${file} or its marker is listed twice`);
    seen.add(marker); seen.add(file);
    return [marker, file];
  });
}

// The list a tree at `root` ships. A tree without the file (a copy cut before it existed) uses this
// node's own list: the same list it was built with. Any other read or parse error throws.
export function readShellParts(root) {
  let raw;
  try { raw = fs.readFileSync(path.join(root, 'web', PARTS_FILE), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT' && path.resolve(root) !== NODE_ROOT) return readShellParts(NODE_ROOT); throw e; }
  if (Buffer.byteLength(raw) > MAX_PARTS_BYTES) throw new Error(`web/${PARTS_FILE} is over ${MAX_PARTS_BYTES} bytes`);
  return validateShellParts(JSON.parse(raw));
}

export const nodeShellParts = () => readShellParts(NODE_ROOT);
