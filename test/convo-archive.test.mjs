// Conversation eviction must never destroy user-typed text.
//
// THE DEFECT (web.mjs chat(), before this suite): the turn ended with
//     if (convo.messages.length > 200) convo.messages = convo.messages.slice(-200);
// and that TRUNCATED array is what saveConvo wrote — the oldest turns were gone
// from disk, with no tombstone and no notice, behind a normal-looking reply.
// Latent only because the largest live conversation was 59 messages.
//
// WHAT IS ASSERTED HERE
//   1. The overflow is written to conversations/.archive BEFORE the live file
//      loses it, and archived ++ live reconstructs the original EXACTLY.
//   2. Under the cap: no archive, no directory, no write at all.
//   3. A failing archive write leaves the live array WHOLE (the ordering that
//      makes a half-eviction impossible) — R5, loud, never silent.
//   4. Two evictions inside one millisecond do not overwrite each other.
//   5. web.mjs really calls it: the slice(-200) is gone from the source and the
//      archive + notice are wired into the turn (source pin — the eviction path
//      itself needs 201 real model turns to reach over HTTP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needPerms } from './helpers-platform.mjs';
import { fileURLToPath } from 'node:url';
import { archiveOverflow, CONVO_MAX_MESSAGES, CONVO_ARCHIVE_DIR } from '../lib/convo-archive.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'convo-'));
const ID = 'a1b2c3d4e5f60718';
// n messages, each one identifiable, alternating user turn / reply.
const convoOf = (n) => ({
  id: ID, title: 'Long chat', updated: 1,
  messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'md' : 'me', text: `turn-${i}` })),
});
const archived = (dir) => {
  const d = path.join(dir, CONVO_ARCHIVE_DIR);
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
};

test('over the cap: the evicted head is on disk BEFORE the live array loses it, and nothing is lost', () => {
  const dir = mkDir();
  const convo = convoOf(CONVO_MAX_MESSAGES + 5);
  const original = convo.messages.map((m) => m.text);

  const r = archiveOverflow(dir, path.join(dir, `${ID}.json`), convo);

  assert.ok(r, 'an over-cap conversation must report an archive');
  assert.equal(r.count, 5, 'exactly the overflow, not the whole head');
  assert.equal(convo.messages.length, CONVO_MAX_MESSAGES, 'the live conversation is back at the cap');

  const files = archived(dir);
  assert.equal(files.length, 1, 'one archive file');
  assert.equal(r.file, `${CONVO_ARCHIVE_DIR}/${files[0]}`, 'the returned path is the file that exists — a caller can quote it to the user');
  const doc = JSON.parse(fs.readFileSync(path.join(dir, CONVO_ARCHIVE_DIR, files[0]), 'utf8'));
  assert.equal(doc.id, ID);
  assert.equal(doc.title, 'Long chat', 'the archive names the chat it came from');
  assert.match(doc.reason, new RegExp(`${CONVO_MAX_MESSAGES}`), 'the archive says WHY it exists');

  // The load-bearing assertion: archived ++ live === the original, in order.
  assert.deepEqual(
    [...doc.messages.map((m) => m.text), ...convo.messages.map((m) => m.text)],
    original,
    'every turn survives, in order — eviction moved text, it did not destroy any',
  );
  assert.deepEqual(doc.messages.map((m) => m.text), ['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4'], 'the OLDEST turns are the ones archived');
});

test('at or under the cap: nothing is archived and no directory is created', () => {
  for (const n of [0, 1, CONVO_MAX_MESSAGES - 1, CONVO_MAX_MESSAGES]) {
    const dir = mkDir();
    const convo = convoOf(n);
    assert.equal(archiveOverflow(dir, path.join(dir, `${ID}.json`), convo), null, `${n} messages must not archive`);
    assert.equal(convo.messages.length, n, 'the live conversation is untouched');
    assert.equal(fs.existsSync(path.join(dir, CONVO_ARCHIVE_DIR)), false, 'no archive directory appears for a conversation under the cap');
  }
});

// Both ways the archive can fail — the directory cannot be made, and the
// directory is fine but the FILE cannot be written. The second is the one that
// pins the ordering: mkdir succeeds, so a version that trimmed first would have
// already dropped the head by the time the write blew up.
test('a failing archive write leaves the live conversation WHOLE — never a half-eviction', { skip: needPerms }, () => {
  const cases = {
    'archive path is a file': (dir) => fs.writeFileSync(path.join(dir, CONVO_ARCHIVE_DIR), 'not a directory'),
    'archive dir is read-only': (dir) => { fs.mkdirSync(path.join(dir, CONVO_ARCHIVE_DIR)); fs.chmodSync(path.join(dir, CONVO_ARCHIVE_DIR), 0o555); },
  };
  for (const [what, breakIt] of Object.entries(cases)) {
    const dir = mkDir();
    breakIt(dir);
    const convo = convoOf(CONVO_MAX_MESSAGES + 3);
    assert.throws(() => archiveOverflow(dir, path.join(dir, `${ID}.json`), convo), /.*/, `${what}: the failure is thrown, not swallowed (R5)`);
    assert.equal(convo.messages.length, CONVO_MAX_MESSAGES + 3, `${what}: the caller still holds every message, so its save stores them all`);
    assert.equal(convo.messages[0].text, 'turn-0', `${what}: the head was not trimmed before the write succeeded`);
    try { fs.chmodSync(path.join(dir, CONVO_ARCHIVE_DIR), 0o755); } catch { /* the file case has no dir to restore */ }
  }
});

test('an invalid conversation id is refused, like saveConvo refuses it', () => {
  const dir = mkDir();
  assert.throws(() => archiveOverflow(dir, null, convoOf(CONVO_MAX_MESSAGES + 1)), /invalid id/);
  assert.throws(() => archiveOverflow(dir, path.join(dir, `${ID}.json`), { id: ID }), /messages array/);
});

test('two evictions in the same millisecond do not overwrite each other', () => {
  const dir = mkDir();
  const p = path.join(dir, `${ID}.json`);
  const now = Date.now;
  Date.now = () => 1757000000000;                     // freeze the clock: both archives want the same name
  try {
    const a = archiveOverflow(dir, p, convoOf(CONVO_MAX_MESSAGES + 2));
    const b = archiveOverflow(dir, p, convoOf(CONVO_MAX_MESSAGES + 7));
    assert.notEqual(a.file, b.file, 'the second archive gets its own name');
  } finally { Date.now = now; }
  const files = archived(dir);
  assert.equal(files.length, 2, 'both archives are on disk');
  const counts = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, CONVO_ARCHIVE_DIR, f), 'utf8')).messages.length).sort((x, y) => x - y);
  assert.deepEqual(counts, [2, 7], 'neither archive was clobbered by the other');
});

test('web.mjs wiring: the truncating slice is gone and the archive + notice are in the turn', () => {
  const src = fs.readFileSync(path.join(REPO, 'web.mjs'), 'utf8');
  assert.ok(!/convo\.messages\s*=\s*convo\.messages\.slice\(-200\)/.test(src), 'the silent truncation must not come back');
  assert.match(src, /archiveOverflow\(convosDir\(user\), convoFile\(user, convo\.id\), convo\)/, 'chat() archives through the id-validated path (R3)');
  assert.match(src, /audit\('convo-archive'/, 'an eviction leaves an audit entry');
  // The user must be TOLD. The notice rides the same NDJSON stream as every other status line.
  assert.match(src, /archived to \$\{archived\.file\}, not deleted/, 'the person is told, in the reply stream');
  // The model's context window is a SEPARATE, legitimate bound — it must survive this fix.
  assert.match(src, /convo\.messages\.slice\(-20\)/, 'the context-window slice(-20) stays');
});
