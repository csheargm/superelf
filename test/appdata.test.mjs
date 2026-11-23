// App-data store unit tests（应用数据存储单元测试）— the storage half of the
// 2026-09-02 handwriting data-loss scar. HARNESS FIDELITY (standing rule): no
// in-memory Map stands in for the filesystem here — the harness that once
// "verified" stroke saving used a Map with no size cap, which is exactly why
// the incident shipped. These tests write to a throwaway tmp dir and read the
// real bytes back. The HTTP half (real server, real caps) is
// test/save-data-routes.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { needPerms } from './helpers-platform.mjs';
import {
  saveAppData, restoreAppData, backupPathFor,
  APP_DATA_MAX_BYTES, APP_DATA_WARN_BYTES, BACKUP_MIN_AGE_MS,
} from '../lib/appdata.mjs';
import { BODY_LIMITS } from '../lib/webutil.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-appdata-'));
const read = (f) => fs.readFileSync(f, 'utf8');
const notebook = (pages) => JSON.stringify({ v: 2, pages: Array.from({ length: pages }, (_, i) => ({ id: `p${i}`, strokes: [{ c: '#141414', w: 0.002, p: [[0.1, 0.2, 0.5]] }] })) });

test('the transport cap and the storage cap are ONE number (R3)', () => {
  assert.equal(APP_DATA_MAX_BYTES, BODY_LIMITS.appData, 'a body that fits the route must always fit the store');
  assert.equal(APP_DATA_WARN_BYTES, Math.floor(APP_DATA_MAX_BYTES / 4));
});

test('valid JSON text is stored byte-for-byte — the server never rewrites app data', () => {
  const d = mkdir(); const f = path.join(d, 'sub', 'note.json');
  const text = notebook(3);
  const r = saveAppData(f, text);
  assert.equal(r.ok, true);
  assert.equal(read(f), text, 'stored bytes are exactly what the app sent (no re-serialization, no rounding)');
  assert.equal(r.bytes, Buffer.byteLength(text));
  assert.equal(r.prevBytes, 0);
  assert.equal(r.backedUp, false, 'nothing to back up on a first save');
  rmTemp(d);
});

test('a degenerate payload is REFUSED and the previous version survives (the proven 200-ok:true wipe)', () => {
  const d = mkdir(); const f = path.join(d, 'note.json');
  const good = notebook(2);
  saveAppData(f, good);
  // Each of these replaced a real 44,507-byte notebook on the pre-fix server
  // and was answered 200 {"ok":true}.
  for (const bad of [null, undefined, '', 'null', '{oops', 42, true, '"a string"', '123']) {
    assert.throws(() => saveAppData(f, bad), (e) => e.code === 'bad_data', `refused: ${JSON.stringify(bad)}`);
    assert.equal(read(f), good, 'the notebook on disk is untouched by a refused save');
  }
  rmTemp(d);
});

test('an object or array payload is accepted (apps store both)', () => {
  const d = mkdir();
  const f1 = path.join(d, 'a.json'); saveAppData(f1, { v: 1, notes: {} });
  const f2 = path.join(d, 'b.json'); saveAppData(f2, '[]');       // the diabetes app stores an array
  const f3 = path.join(d, 'c.json'); saveAppData(f3, '{}');       // an emptied annotation map is a real user action
  assert.equal(read(f1), '{"v":1,"notes":{}}');
  assert.equal(read(f2), '[]');
  assert.equal(read(f3), '{}');
  rmTemp(d);
});

test('a write that fails mid-way leaves the previous version intact and reports the failure (never ok:true)', { skip: needPerms }, () => {
  const d = mkdir(); const f = path.join(d, 'note.json');
  const good = notebook(4);
  saveAppData(f, good);
  const before = fs.readFileSync(f);
  fs.chmodSync(d, 0o500); // no new files in this directory: tmp write fails, exactly like ENOSPC/EACCES mid-save
  assert.throws(() => saveAppData(f, notebook(9)), /atomic write failed/, 'the failure is thrown, with context (R5)');
  fs.chmodSync(d, 0o700);
  assert.deepEqual(fs.readFileSync(f), before, 'previous notebook byte-identical — truncate-then-write could not have promised this');
  assert.equal(fs.readdirSync(d).filter((n) => n.endsWith('.tmp')).length, 0, 'no tmp litter left behind');
  rmTemp(d);
});

test('backup: one rolling generation, refreshed at most once a minute', () => {
  const d = mkdir(); const f = path.join(d, 'note.json'); const bak = backupPathFor(f);
  const t0 = Date.now();
  const v1 = notebook(1), v2 = notebook(2), v3 = notebook(3);
  saveAppData(f, v1, { now: t0 });
  assert.equal(fs.existsSync(bak), false, 'no backup before there is a previous version');
  const r2 = saveAppData(f, v2, { now: t0 + 100 });
  assert.equal(r2.backedUp, true, 'first previous version is kept');
  assert.equal(read(bak), v1);
  const r3 = saveAppData(f, v3, { now: t0 + 700 });                       // the 700ms autosave case
  assert.equal(r3.backedUp, false, 'a 700ms-old backup is useless for recovery — not refreshed');
  assert.equal(read(bak), v1, 'the version the user actually finished is still the one kept');
  const r4 = saveAppData(f, notebook(4), { now: t0 + BACKUP_MIN_AGE_MS + 1000 });
  assert.equal(r4.backedUp, true, 'past the cooldown the backup rolls forward');
  assert.equal(read(bak), v3);
  rmTemp(d);
});

test('a tombstone ({deleted:true}) removes the backup, so a deleted note leaves no text on disk; any other payload keeps it (F3-12)', () => {
  const d = mkdir(); const f = path.join(d, 'entry-1.json'); const bak = backupPathFor(f);
  const t0 = Date.now();
  saveAppData(f, notebook(1), { now: t0 }); saveAppData(f, notebook(2), { now: t0 + 100 });
  assert.equal(fs.existsSync(bak), true, 'CONTROL: the previous version is backed up');
  const r = saveAppData(f, JSON.stringify({ v: 1, deleted: true }), { now: t0 + BACKUP_MIN_AGE_MS + 1000 });
  assert.equal(r.ok, true); assert.equal(r.backedUp, false);
  assert.equal(fs.existsSync(bak), false, 'the deleted text is gone from the .bak');
  assert.deepEqual(JSON.parse(read(f)), { v: 1, deleted: true });
  const g = path.join(d, 'other.json');
  saveAppData(g, notebook(1), { now: t0 }); saveAppData(g, JSON.stringify({ deleted: true, pages: [] }), { now: t0 + 100 });
  assert.equal(fs.existsSync(backupPathFor(g)), true, 'deleted:true beside real data is data, not a tombstone: backed up');
  rmTemp(d);
});

test('backup: a collapsed file can never roll the good backup out, even after the cooldown', () => {
  const d = mkdir(); const f = path.join(d, 'note.json'); const bak = backupPathFor(f);
  const t0 = Date.now();
  const big = notebook(40);
  saveAppData(f, big, { now: t0 });
  saveAppData(f, notebook(41), { now: t0 + 100 });        // backup := big
  assert.equal(read(bak), big);
  const collapsed = saveAppData(f, '{}', { now: t0 + 200 });
  assert.equal(collapsed.shrank, true, 'the collapse is REPORTED, not silently accepted as normal');
  // Hours later the app is still saving the collapsed file; the good bytes must survive.
  const later = saveAppData(f, '{}', { now: t0 + 10 * BACKUP_MIN_AGE_MS });
  assert.equal(later.backedUp, false, 'refusing to demote a good backup for a collapsed file');
  assert.equal(read(bak), big, 'the recoverable version is still the real notebook');
  rmTemp(d);
});

test('restore: puts the backup back, keeps it, and refuses a backup that is missing or corrupt', () => {
  const d = mkdir(); const f = path.join(d, 'note.json'); const bak = backupPathFor(f);
  assert.deepEqual(restoreAppData(f).code, 'no_backup');
  const t0 = Date.now();
  const v1 = notebook(5);
  saveAppData(f, v1, { now: t0 });
  saveAppData(f, '{}', { now: t0 + 100 });                 // the accident: notebook replaced by an empty object
  assert.equal(read(f), '{}');
  const r = restoreAppData(f);
  assert.equal(r.ok, true);
  assert.equal(read(f), v1, 'the handwriting is back');
  assert.equal(fs.existsSync(bak), true, 'the backup is kept — a restore is repeatable');
  assert.equal(restoreAppData(f).ok, true, 'and idempotent');
  fs.writeFileSync(bak, '{truncated');
  const bad = restoreAppData(f);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_backup');
  assert.equal(read(f), v1, 'a corrupt backup is never written over live data');
  rmTemp(d);
});

test('size telemetry: a file past a quarter of the cap reports approaching_limit', () => {
  const d = mkdir(); const f = path.join(d, 'note.json');
  const small = saveAppData(f, notebook(1));
  assert.equal(small.warn, null);
  const filler = 'x'.repeat(APP_DATA_WARN_BYTES);
  const big = saveAppData(f, JSON.stringify({ v: 2, pages: [], pad: filler }));
  assert.equal(big.warn, 'approaching_limit', 'distance to the cap is MEASURED and reported — the last cliff was invisible');
  assert.equal(big.limit, APP_DATA_MAX_BYTES);
  rmTemp(d);
});

// Markdown an app shares with its user and the assistant (Tasks' tasks.md, ADR 0014). Where it may go is
// appDataFile's rule (test/workspace-write-paths.test.mjs); here, that it is stored as sent.
test('a markdown file is stored exactly as sent, backed up and restorable; a payload that is not text is refused', () => {
  const d = mkdir(); const f = path.join(d, 'data', 'tasks', 'tasks.md');
  const md = '## Today\n- [ ] Call Mom\n- [x] Pay rent\n';
  assert.equal(saveAppData(f, md).ok, true);
  assert.equal(read(f), md, 'not JSON-encoded, not trimmed');
  assert.equal(saveAppData(f, '').ok, true, 'an emptied list is a real user action; the backup covers a mistake');
  assert.equal(read(f), '');
  assert.equal(read(backupPathFor(f)), md, 'the list before it is the backup');
  for (const bad of [null, undefined, 0, { a: 1 }, ['x']]) {
    assert.throws(() => saveAppData(f, bad), (e) => e.code === 'bad_data', `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(read(f), '', 'a refused payload changes nothing');
  assert.equal(restoreAppData(f).ok, true, 'a markdown backup is not refused for not being JSON');
  assert.equal(read(f), md);
  rmTemp(d);
});
