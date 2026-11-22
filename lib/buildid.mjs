// Which code is on screen（正在运行哪一版代码）.
//
// The Settings version line read "v3.8.0" before AND after the Pencil fixes, so nobody holding the
// iPad could tell which code it was running. A build id names it in two halves:
//   · the short git HEAD — what was deployed;
//   · "note <blob>" — the git BLOB id of web/note-ui.inline.html, i.e. what PANote actually is.
//     Exact even with uncommitted edits, and checkable by anyone with
//     `git hash-object web/note-ui.inline.html`.
// The same string is shown in the shell (appVersion in web.mjs) and stamped into every app page
// at BUILD_MARKER, which the Pencil recorder (web/pencil-log.inline.html) writes into its log header.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BUILD_MARKER = '%%PA_BUILD_ID%%';
export const HEAD_TTL_MS = 10_000;      // the shell page asks on every load; git runs at most this often
export const GIT_SHORT = 7;
export const NOTE_SHORT = 8;

// git's own object id for a file's bytes: sha1("blob <len>\0" + bytes).
export const blobId = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// head(): the full HEAD sha or null (web.mjs's existing gitHead — one git invocation, R3).
export function makeBuildId(root, head, now = () => Date.now()) {
  const noteFile = path.join(root, 'web', 'note-ui.inline.html');
  let sha = null, shaAt = -Infinity, noteKey = '', note = '';
  // The TTL'd HEAD, shared: lib/version-auto.mjs keys its cache on it (one git invocation, R3).
  const cachedHead = () => { if (now() - shaAt >= HEAD_TTL_MS) { sha = head(); shaAt = now(); } return sha; };
  const id = () => {
    sha = cachedHead();
    try {
      const st = fs.statSync(noteFile), key = `${st.mtimeMs}:${st.size}`;
      if (key !== noteKey) { note = blobId(fs.readFileSync(noteFile)).slice(0, NOTE_SHORT); noteKey = key; }
    } catch { note = ''; noteKey = ''; }   // no PANote on disk: name what we can (the git half); a version line must never fail the page
    return [sha ? sha.slice(0, GIT_SHORT) : '', note ? `note ${note}` : ''].filter(Boolean).join(' · ');
  };
  id.head = cachedHead;
  return id;
}
