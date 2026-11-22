// App-data store（应用数据存储）— the ONE writer behind POST /api/save-data.
//
// WHY THIS MODULE EXISTS (DATA-LOSS SCAR, 2026-09-02): a handwriting note lost
// a full page of Apple Pencil strokes. /api/save-data read its body with the
// 64KB default cap, so every save of a grown notebook was rejected; the reply
// was `400 text/plain "error"`, which no client could even parse, let alone
// react to. The cap is fixed (lib/webutil.mjs BODY_LIMITS.appData) — this
// module fixes the rest of the server's half of the contract:
//   1. ATOMIC — tmp + fsync + rename (writeFileAtomic, the writeJsonFile
//      precedent). The bare fs.writeFileSync it replaces truncated the real
//      file FIRST, so a crash / SIGTERM (the ops lifecycle sends one) / ENOSPC
//      mid-write left a half-written notebook and no previous version. At 8MB
//      a write is many syscalls, so that window grows with the user's work.
//   2. VALIDATED — a payload that is not JSON text for an object or array is
//      REFUSED. Proven against the real server before this change: a 44,507-
//      byte notebook was replaced by `null` (4 bytes), by `{}` and by `""`,
//      each answered 200 {"ok":true}. `""` and `null` are now 400 bad_data.
//      `{}` stays legal (an emptied annotation map is a real user action) —
//      the backup below is what covers it.
//   3. RECOVERABLE — one rolling previous generation at <name>.bak, plus
//      restoreAppData (POST /api/restore-data). Reading a backup needs no new
//      route: GET /api/data/<path>.json.bak already serves it.
// The server never MUTATES app data: no rounding, no point thinning, no
// re-serialization of the client's bytes. The stored file is byte-for-byte
// what the app sent. Storage-shape decisions belong to the app (see the
// growth note at the bottom of this file).

import fs from 'node:fs';
import path from 'node:path';
import { safeJoin, slugOk, writeFileAtomic, BODY_LIMITS, RESERVED_DEVICE_NAMES } from './webutil.mjs';

// The ONE app-data root (R3): data/<slug>/ under a workspace. The broker's namespace is pinned to it
// (test/workspace-write-paths.test.mjs). It lived in lib/agent-origin.mjs while an app's agent had an
// allow rule there; that rule is gone (ADR 0019).
export const APP_DATA_DIR = 'data';
// <ws>/uploads/<ts>_<name>: where /api/upload writes a picture and the ONLY place the OCR queue reads
// one from (lib/note-ocr-queue.mjs uploadFile). One constant for both sides (R3).
export const UPLOADS_DIR = 'uploads';

// The transport cap IS the storage cap — one number (R3), from BODY_LIMITS.
export const APP_DATA_MAX_BYTES = BODY_LIMITS.appData;
// Report (never enforce) when a file passes a quarter of the cap: the last
// cliff was invisible because nothing measured distance to it. The save reply
// carries `warn` from here so a client CAN surface "this note is getting big".
export const APP_DATA_WARN_BYTES = Math.floor(APP_DATA_MAX_BYTES / 4);

// Backup policy（备份策略）— ONE generation, deliberately not one-per-save:
//  · A 700ms autosave means "the previous version" is 700ms old, which is
//    useless for recovery — by the time a person notices a bad note, the good
//    bytes would have been rolled out several hundred saves ago. So the .bak
//    is refreshed at most once a minute: it is always a version the user
//    actually finished writing.
//  · A catastrophic shrink must not be able to roll the good backup out after
//    that minute either, so a refresh is REFUSED when the version being
//    demoted is less than half the size of the backup it would replace. A
//    degenerate save can then be undone at any time, not only within 60s.
export const BACKUP_MIN_AGE_MS = 60_000;
export const BACKUP_KEEP_RATIO = 0.5;

export const backupPathFor = (file) => `${file}.bak`;

// THE path rule for app data (POST /api/save-data and /api/restore-data): the file in workspace `ws`
// that `rel` names, or null. Refused: an absolute path, anything not `.json` or `.md`, a `..` segment, ANY
// segment that starts with a dot, and a path through a symlink.
//   Dots: every agent run's cwd is the workspace root, and the CLI loads <ws>/.claude/settings*.json
//   (hooks) and <ws>/.mcp.json (a server command) on the next run there with no approval (measured
//   2026-10-13, ADR 0016). The CLI refuses its own agent those paths, so this route must too.
//   DECODED first: safeJoin decodes before it joins, so `%2E%2E` is `..` — judged on the raw text,
//   an app climbed out of data/<slug>/ to the owner's profile.json (R13, reproduced).
//   On disk: safeJoin's checks are on the text, so a symlink in the workspace would carry a plain
//   path into .claude/. App data never needs one, so none is followed.
//   Namespace: only data/<slug>/… — the server holds the line the broker draws (R13 round 3), so a
//   broker bug cannot reach profile.json or conversations/. `namespace: false` is for the two test
//   stand-in servers whose stand-in relay sends bare paths (test/note-save, note-load-safety).
//   Markdown (ADR 0014): a `.md` an app shares with its user and the assistant (Tasks' tasks.md), only
//   inside data/<slug>/ and only as a plain ASCII name (no '~' short name, ':' stream or device name on
//   Windows) that is not an instruction file of the CLIs superelf runs (Claude Code, Codex) or Gemini:
//   Claude Code loads a CLAUDE.md from any folder its agent reads in, and save-data must not plant one.
//   Names a CLI takes from its own config (Codex project_doc_fallback_filenames) are not covered.
export function appDataFile(ws, rel, { namespace = true } = {}) {
  if (typeof rel !== 'string' || !(rel.endsWith('.json') || isText(rel))) return null;
  let dec;
  try { dec = decodeURIComponent(rel); } catch { return null; /* a malformed escape names no file */ }
  // A backslash is refused outright: a separator on Windows, an ordinary character elsewhere, so
  // `data\notes\x.json` would pass the namespace below and land at the root (R13, reproduced).
  if (dec.includes('\\') || path.isAbsolute(dec)) return null;
  const segs = dec.split('/');
  if (segs.some((seg) => seg === '..' || seg.startsWith('.'))) return null;
  if (namespace && !(segs.length >= 3 && segs[0] === APP_DATA_DIR && slugOk(segs[1]))) return null;
  if (isText(dec) && !(namespace && textName(segs[segs.length - 1]))) return null;
  const f = safeJoin(ws, rel);
  return f && noLinkOnTheWay(ws, f) ? f : null;
}
// Every part of `f` below `ws` that exists is a plain entry: not a symlink, and (Windows) not a short
// name for a dot-name, so the path lands where its text says. Exported: web.mjs judges app folders,
// as write targets and as copy sources, with the same rule (R3).
export function noLinkOnTheWay(ws, f) {
  let p = ws;
  for (const seg of path.relative(ws, f).split(path.sep)) {
    p = path.join(p, seg);
    let name;
    try { name = fs.lstatSync(p).isSymbolicLink() ? null : realName(p); }
    catch (e) { return e.code === 'ENOENT'; /* absent from here down: nothing on disk to judge; any other error cannot be judged, so refuse */ }
    if (!name || name.startsWith('.')) return false;
  }
  return true;
}
// The on-disk name of an existing entry. Only Windows can name a dot-folder by another text (an 8.3
// short name, which realpath's native call expands); elsewhere a link is the only way, and that is
// refused above. Some Windows volumes refuse the native call (EISDIR): the JS realpath then answers,
// without the short-name expansion (unverified on Windows — no machine to run it on).
function realName(p) {
  if (process.platform !== 'win32') return path.basename(p);
  try { return path.basename(fs.realpathSync.native(p)); } catch { return path.basename(fs.realpathSync(p)); /* see above */ }
}
function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { return e.code !== 'ENOENT'; /* absent is no link; unjudgeable counts as one */ }
}

const AGENT_INSTRUCTION_FILES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agents.override.md', 'gemini.md']);
const textName = (n) => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.md$/.test(n) && !AGENT_INSTRUCTION_FILES.has(n.toLowerCase())
  && !RESERVED_DEVICE_NAMES.has(n.split('.')[0].toLowerCase());
const isText = (file) => file.endsWith('.md');   // appDataFile has already said where a .md may go

const badData = (msg) => { const e = new Error(msg); e.code = 'bad_data'; return e; };

// Accept exactly what an app legitimately stores: JSON text (what every app
// sends — JSON.stringify(...)), or an already-parsed object/array. Anything
// whose JSON value is not an object or an array (null, "", 0, true, a bare
// string) is a bug or a load race in the caller, never a notebook.
function normalize(data) {
  let text, value;
  if (typeof data === 'string') {
    text = data;
    try { value = JSON.parse(text); } catch { throw badData('data must be valid JSON text · 数据必须是合法的 JSON 文本'); }
  } else if (data && typeof data === 'object') {
    value = data;
    text = JSON.stringify(data);
  } else {
    throw badData('data must be a JSON object or array · 数据必须是 JSON 对象或数组');
  }
  if (!value || typeof value !== 'object') throw badData('data must be a JSON object or array · 数据必须是 JSON 对象或数组');
  return text;
}

// Demote the current on-disk version to <file>.bak when the policy above says
// this one is worth keeping. Returns true when the backup was refreshed.
function maybeBackup(file, now) {
  let prev;
  try { prev = fs.readFileSync(file); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; // no previous version — nothing to protect
    // EACCES / EIO / EISDIR: the previous version EXISTS and we could not read
    // it, so we cannot protect it — and the write below would destroy it with
    // no backup at all. Refuse the save instead (R5, empty-overwrite class).
    // 'bad_data' is the wrong code (the payload is fine); the route answers 500.
    throw new Error(`cannot read the existing file to back it up · 无法读取现有文件以备份 — ${path.basename(file)}: ${e.code || e.message}`, { cause: e });
  }
  if (!prev.length) return false;
  const bak = backupPathFor(file);
  let st;
  try { st = fs.statSync(bak); } catch { writeFileAtomic(bak, prev); return true; } // first backup
  if (now - st.mtimeMs < BACKUP_MIN_AGE_MS) return false;                            // too fresh to roll
  if (prev.length < st.size * BACKUP_KEEP_RATIO) return false;                       // never demote a good backup for a collapsed file
  writeFileAtomic(bak, prev);
  return true;
}

// Save one app-data file. Throws with .code='bad_data' for a refused payload
// and a contextual Error for a write failure (R5 — the route answers 500 +
// code and audits it; a failed save is never silently reported as success).
export function saveAppData(file, data, { now = Date.now() } = {}) {
  // Markdown is any string, the empty one included (an emptied list is a real user action, and the
  // backup below covers a mistaken one); anything else is a caller's bug.
  if (isText(file) && typeof data !== 'string') throw badData('data must be text · 数据必须是文本');
  const text = isText(file) ? data : normalize(data);
  const bytes = Buffer.byteLength(text);
  let prevBytes = 0;
  try { prevBytes = fs.statSync(file).size; } catch { /* first save of this file */ }
  const backedUp = maybeBackup(file, now); // writeFileAtomic creates the directory

  writeFileAtomic(file, text);
  return {
    ok: true, bytes, prevBytes, backedUp,
    limit: APP_DATA_MAX_BYTES,
    // Telemetry the client can surface, never a refusal (R14: report honestly,
    // do not quietly change what was stored).
    warn: bytes >= APP_DATA_WARN_BYTES ? 'approaching_limit' : null,
    shrank: prevBytes > 0 && bytes < prevBytes * BACKUP_KEEP_RATIO,
  };
}

// Put <file>.bak back over <file>, atomically. The backup is LEFT IN PLACE so
// a restore is repeatable (and so a mistaken restore of the wrong file cannot
// consume the only copy). A backup that does not parse is refused rather than
// written over live data.
export function restoreAppData(file) {
  const bak = backupPathFor(file);
  // The backup itself must be a plain file: appDataFile judged only `file` (R13, 2026-10-13).
  if (isLink(bak)) return { ok: false, code: 'bad_path', error: 'backup is a link · 备份是链接' };
  let buf;
  try { buf = fs.readFileSync(bak); } catch { return { ok: false, code: 'no_backup', error: 'no backup for this file · 该文件没有备份' }; }
  if (!buf.length) return { ok: false, code: 'bad_backup', error: 'backup is empty · 备份为空' };
  if (!isText(file)) {
    try { JSON.parse(buf.toString('utf8')); } catch { return { ok: false, code: 'bad_backup', error: 'backup is not valid JSON · 备份不是合法的 JSON' }; }
  }
  writeFileAtomic(file, buf);
  return { ok: true, bytes: buf.length, restoredFrom: path.basename(bak) };
}

// ── Growth discipline（增长纪律）— MEASURED, then DEFERRED (R8) ──────────────
// Measured 2026-09-02 over the live workspace, READ-ONLY, every stored
// notebook (10 files that contain strokes; `pages` arrays found at any depth,
// so the Journal's nested entry.draw and the Bible's ANN.draws[scope] count):
//
//   total 361,532 B · 25 pages · 359 strokes · 16,623 points
//   density        21.7 bytes per stroke point (round4/round2 already applied)
//   average page   14.1 KB
//   densest page   60.4 KB  (workspace/data/notes/entry-dhhcx9rk.json, 1 page,
//                            42 strokes, 2,919 points — ONE page of writing)
//   five files sat at 58–65 KB purely because 64 KB used to be the ceiling.
//
// THE NEXT CLIFF IS 16 MB, AND IT IS REACHABLE, NOT THEORETICAL:
//   16 MB ÷ 60.4 KB ≈ 271 pages of dense handwriting  (an ordinary notebook)
//   16 MB ÷ 14.1 KB ≈ 1160 pages at the live average
// Raised from 8 MB on 2026-09-12, because it WAS reached: a live journal note hit
// 6.54 MB (4 pages, 2067 strokes, 328,708 points) and the user reported losing
// handwriting. Raising it is runway, NOT the fix — see the save-cost note below,
// and note that the warning this module has always computed reached no UI until
// the same day, which is why the cliff was hit blind.
// Nothing bounds NB.pages, and every 700ms autosave re-serializes and re-POSTs
// the WHOLE notebook, so cost per save is O(entire notebook): at 135 pages the
// iPad stringifies and uploads ~8 MB every 700ms while the user writes. The
// failure probability of a save therefore RISES with the amount of unsaved
// work at risk — the worst possible shape.
//
// A CLIENT STORAGE-SHAPE CHANGE WAS TRIED AND REVERTED (2026-09-02, rounds 4
// and 5). Round 4 split a note into entry-<id>/index.json plus one file per
// page, which did bound the cost of a save. Round 5 REMOVED it, because
// adversarial verification measured three ways it lost work in ORDINARY flows:
// a flush that reported success while a write it covered was still in flight;
// a failure re-armed against the note the user had just switched TO, whose
// "retry" wrote nothing and answered ok:true; and a delete that wrote a
// new-layout tombstone for an old-layout note and stranded its handwriting.
// Two files that must agree with no transaction between them, plus a
// session-local map deciding which layout a note is in, cost more than the
// bytes they saved.
//
// SO THE SHAPE IS BACK TO ONE ATOMIC FILE PER NOTE, which is what this module
// is good at: writeFileAtomic below is tmp+rename with a rolling .bak, so a
// note is either its old version or its new one — never half of each. The 8MB
// cap and the numbers above therefore stand as the LIVE constraint, and the
// mitigation is the one the app already has: the failure is loud (save-failure
// banner + retry ladder), the shrink guard refuses the overwrite that used to
// follow it, and .bak/restoreAppData is the recovery path.
//   · The rationale lives with the writers too: "ONE ATOMIC WHOLE-NOTEBOOK
//     WRITE PER NOTE" in web/note-ui.inline.html, "ONE FILE PER NOTE" in the
//     Journal app, "ONE FILE PER CHAPTER" in the Bible app. Verification:
//     test/note-whole-file.test.mjs.
//   · Revisit ONLY with a real concurrency design (one writer owning ordering
//     across every file of a note, failure state keyed to the note) and only if
//     measured note sizes demand it — not as an optimisation.
//   · Point thinning (RDP / a distance threshold) is an APP decision at
//     capture time, never a server one — the server must not mutate app data,
//     so it is deliberately absent here.
