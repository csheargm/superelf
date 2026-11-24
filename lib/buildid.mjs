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

// A deployed folder with no .git (the VM nodes: a `git archive` copy) names its commit in REVISION,
// written by the deploy. Without it the build id never changed there, so open pages never saw an
// update and had to be refreshed by hand. A full or short hex sha on the first line, else null.
// The image build writes it (ops/demo/Dockerfile, build arg REVISION — a missing arg fails the
// build), so every container start's copy replaces the node folder's file; a file left from an
// older deploy showed "ca28633" on current code and PAUpdate never fired.
// Line 2 is the commit date (YYYY-MM-DD): "5.0.0" never moves, so the footer shows the date too.
export const REVISION_FILE = 'REVISION';
const revisionLines = (root) => {
  try { return fs.readFileSync(path.join(root, REVISION_FILE), 'utf8').split('\n').map((l) => l.trim()); }
  catch { return []; }   // no file: a git checkout, or a copy deployed without one — the id simply has no git half
};
export function readRevision(root) {
  const v = revisionLines(root)[0] || '';
  return /^[0-9a-f]{7,40}$/.test(v) ? v : null;
}
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function readRevisionDate(root) {
  const v = revisionLines(root)[1] || '';
  return DATE_RE.test(v) ? v : null;
}
// The footer's short date: "2026-11-23" → "11-23"; anything else → ''.
export const shortDate = (d) => (DATE_RE.test(d || '') ? d.slice(5) : '');

// head(): the full HEAD sha or null (web.mjs's existing gitHead — one git invocation, R3).
// date(sha): that commit's YYYY-MM-DD or null; asked only when the sha changes (id.date()).
export function makeBuildId(root, head, now = () => Date.now(), date = () => null) {
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
  let dateOf = null, dateVal = '';
  id.date = () => { const h = cachedHead(); if (h !== dateOf) { dateOf = h; dateVal = h ? shortDate(date(h)) : ''; } return dateVal; };
  return id;
}
