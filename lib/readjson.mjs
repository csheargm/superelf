// Reading a stored document（读取已存文件）— absent vs unreadable.
//
// THE ROOT SHAPE OF THE 2026-09-02 DATA LOSS, server side: a failure to READ
// was indistinguishable from "the file is not there". Every lenient
// `try { JSON.parse(read(f)) } catch { return {} }` turns an EACCES / EIO / a
// half-written file into an EMPTY document, and the next write stores that
// emptiness over the user's good data — reported to the user as 200 ok:true.
// A save telling you it SUCCEEDED at the exact moment it destroys your work is
// the worst failure shape there is, so the distinction lives in its own module
// with one parse behind it (R3):
//   readJsonState     — the primitive: WHICH of the three states you are in.
//   readJson          — lenient, for READ-ONLY callers whose absence IS a valid
//                       state (first run). NEVER read-before-write with this.
//   readJsonForUpdate — read-before-write. Absent → your fallback (a first save
//                       is normal); unreadable → THROWS, so a handler cannot
//                       overwrite a document it just failed to read.
import fs from 'node:fs';
import path from 'node:path';

export const FILE_OK = 'ok';
export const FILE_ABSENT = 'absent';
export const FILE_UNREADABLE = 'unreadable';
// The stable code the refusal travels under, all the way to the client
// (lib/webutil.mjs bodyErrorResponse maps it to a 500 carrying this string).
export const FILE_UNREADABLE_CODE = 'file_unreadable';

export function readJsonState(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    // ENOENT / ENOTDIR are the only "it is simply not there" errors. EACCES,
    // EIO, EISDIR, EMFILE… all mean the document may well exist and be fine.
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { state: FILE_ABSENT };
    return { state: FILE_UNREADABLE, error: `cannot read ${path.basename(file)}: ${e.code || e.message}` };
  }
  // An empty file is a truncation artifact (a crash between open and write),
  // never a document a caller stored — damaged, not absent.
  if (!raw.trim()) return { state: FILE_UNREADABLE, error: `${path.basename(file)} is empty` };
  try { return { state: FILE_OK, value: JSON.parse(raw) }; }
  catch { return { state: FILE_UNREADABLE, error: `${path.basename(file)} is not valid JSON` }; }
}

export function readJson(f, fallback) {
  const r = readJsonState(f);
  return r.state === FILE_OK ? r.value : fallback;
}

// `expect` (optional) rejects a document that parses but is the wrong shape —
// an array where the store is a map, say. Writing over that would destroy it
// just as surely as writing over an unparsable one, so it is the same state.
export function readJsonForUpdate(file, fallback, { expect } = {}) {
  const r = readJsonState(file);
  if (r.state === FILE_ABSENT) return fallback;
  if (r.state === FILE_OK && (!expect || expect(r.value))) return r.value;
  const why = r.state === FILE_OK ? `${path.basename(file)} has an unexpected shape` : r.error;
  const e = new Error(`refusing to overwrite a file that could not be read · 拒绝覆盖无法读取的文件 — ${why}`);
  e.code = FILE_UNREADABLE_CODE;
  throw e;
}
