// Atomic writes and the rename that publishes them · 原子写入
//
// Split out of lib/webutil.mjs, which carries a 300-line budget (R4) and says in its own comment
// that the next thing to grow it must move out — the same reason lib/readjson.mjs exists. Nothing
// here changed in the move except the Windows rename retry it was extracted to make room for;
// webutil.mjs re-exports all three names, so every existing importer is untouched.
import path from 'node:path';
import fs from 'node:fs';

// The ONE atomic write mechanism (R3 — writeJsonFile, the app-data store and
// saveConvo all route through it): write to a same-directory tmp file, fsync
// it, then rename. A concurrent reader can never observe a half-written file
// (a torn read of pending-actions.json parsed as [] and the next save then
// wiped the whole store — the silent-wipe scar), and a crash / SIGTERM /
// ENOSPC mid-write cannot destroy the previous version, because the previous
// version is never truncated: rename() replaces it in one step or not at all.
// The tmp name carries pid + sequence so two writers never share one tmp.
// Windows fails a rename when ANY process holds the destination open — Defender scanning the
// file superelf just wrote, Windows Search indexing it, a backup agent, or a second reader. The
// handle is released microseconds later, so POSIX never sees this and Windows sees it as a burst.
// Without a retry a routine save answers 500 write_failed and the user's note looks lost.
//
// Bounded and loud: a few short waits, then the original error is rethrown with context. It never
// hides a genuine failure (ENOSPC, a read-only volume) — those codes are not retried at all, so
// they still fail on the first attempt. The wait is synchronous because the whole write path is,
// and it only ever runs AFTER a failure, never on the happy path.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;
const RENAME_WAIT_MS = 20;
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB: skip the wait, still retry */ } };

export function renameWithRetry(from, to) {
  for (let i = 1; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (i >= RENAME_ATTEMPTS || !RENAME_RETRY_CODES.has(e.code) || process.platform !== 'win32') throw e;
      sleepSync(RENAME_WAIT_MS * i);
    }
  }
}

let writeSeq = 0;
// Never write THROUGH whatever already sits at the tmp name — the name is predictable, and a symlink
// planted there carried the bytes anywhere (R13, 2026-10-13). Whatever is there is removed first
// (unlink drops a link, never its target; on Windows a DANGLING link too, which an exclusive create
// might otherwise follow — unverified there), then the open is exclusive ('wx'): one planted in
// between fails this write instead of carrying it.
function openFresh(tmp) {
  try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; /* nothing there: the usual case */ }
  return fs.openSync(tmp, 'wx');
}
export function writeFileAtomic(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${++writeSeq}.tmp`;
  let fd;
  try {
    fd = openFresh(tmp);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);           // bytes on disk BEFORE the rename publishes them
    fs.closeSync(fd); fd = undefined;
    renameWithRetry(tmp, f);
  } catch (e) {
    // Leave no tmp litter behind, then rethrow WITH context (R5) — a failed
    // save must reach the caller, which answers 500 + code to the client.
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* fd already gone */ }
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw new Error(`atomic write failed for ${path.basename(f)}: ${e.code || e.message}`, { cause: e });
  }
}

// The ONE atomic JSON writer (R3 — every state store uses it).
export function writeJsonFile(f, obj) {
  writeFileAtomic(f, JSON.stringify(obj, null, 2));
}

