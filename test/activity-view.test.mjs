// lib/activity-view.mjs — the owner's Activity log keeps security events, failures and app changes only.
// CONTROL (R14): routine rows (sign-in OK, job ran, built-in app updates) are fed in and must NOT come out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activityKind, activityRows, changeDiff, refuseStaleUndo, ACTIVITY_MAX } from '../lib/activity-view.mjs';
import { snapshotApp, undoLastEdit, EDIT_WHY } from '../lib/app-versions.mjs';
import { recordRequest, listHistory } from '../lib/app-history.mjs';
import { VERSIONS_DIR } from '../lib/app-edit.mjs';
import { rmTemp } from './helpers-tmp.mjs';

test('activityKind: security, failure, app — and routine is dropped', () => {
  const k = (r) => activityKind(r);
  assert.equal(k({ ev: 'login', ok: false }), 'security');
  assert.equal(k({ ev: 'login', ok: true }), null);
  for (const ev of ['create', 'delete', 'approve', 'password-reset', 'set-pin', 'token-rotate']) assert.equal(k({ ev }), 'security', ev);
  for (const ev of ['job-failed', 'job-retries-exhausted', 'node-health-failed', 'builtin-apps-update-failed', 'job-state-error']) assert.equal(k({ ev }), 'failure', ev);
  assert.equal(k({ ev: 'app-publish', state: 'failed' }), 'failure');
  assert.equal(k({ ev: 'app-edit', changed: true, applied: false }), 'failure');
  assert.equal(k({ ev: 'app-edit', changed: true, applied: true }), 'app');
  assert.equal(k({ ev: 'app-edit-undo', undone: true }), 'app');
  for (const ev of ['share', 'unshare', 'fork', 'rollback', 'app-update']) assert.equal(k({ ev }), 'app', ev);
  for (const r of [{ ev: 'builtin-apps-update' }, { ev: 'job-run' }, { ev: 'websearch' }, { ev: 'app-edit', changed: false }, { ev: 'app-edit-undo', undone: false }, { ev: 'chat-cancelled' }, { ev: 'reminder-sent' }])
    assert.equal(k(r), null, JSON.stringify(r));
});

test('activityRows: newest first, capped, routine gone', () => {
  const rows = [];
  for (let i = 0; i < ACTIVITY_MAX + 20; i++) rows.push({ ev: 'job-failed', job: 'j' + i }, { ev: 'builtin-apps-update' });
  const out = activityRows(rows, () => []);
  assert.equal(out.length, ACTIVITY_MAX);
  assert.equal(out[0].job, 'j' + (ACTIVITY_MAX + 19), 'newest first');
  assert.ok(out.every((r) => r.kind === 'failure'));
});

function fixture() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-act-'));
  const app = path.join(ws, 'apps', 'notes'), root = path.join(ws, VERSIONS_DIR);
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<p>one</p>\n');
  const v1 = snapshotApp(app, root, 'notes', EDIT_WHY);
  recordRequest(root, 'notes', v1, { request: 'make it two', who: 'owner' });
  fs.writeFileSync(path.join(app, 'index.html'), '<p>two</p>\n');
  const v2 = snapshotApp(app, root, 'notes', EDIT_WHY);
  recordRequest(root, 'notes', v2, { request: 'make it three', who: 'owner' });
  fs.writeFileSync(path.join(app, 'index.html'), '<p>three</p>\n');
  return { ws, app, root, v1, v2 };
}

test('app-edit rows carry the request; Undo only on the newest; diff = that change alone', () => {
  const f = fixture();
  try {
    const hist = (slug) => listHistory(f.root, slug);
    const audit = [{ ev: 'app-edit', app: 'notes', applied: true, changed: true, version: f.v1, who: 'owner' },
      { ev: 'app-edit', app: 'notes', applied: true, changed: true, version: f.v2, who: 'owner' },
      { ev: 'app-edit', app: 'notes', applied: true, changed: true, version: 'gone-edit', who: 'owner' }];
    const [gone, newest, older] = activityRows(audit, hist);
    assert.equal(gone.canDiff, undefined, 'pruned version: no buttons');
    assert.deepEqual([newest.request, newest.canUndo, newest.canDiff], ['make it three', true, true]);
    assert.deepEqual([older.request, older.canUndo, older.canDiff], ['make it two', false, true]);
    const d1 = changeDiff(f.ws, 'notes', f.v1);
    assert.match(d1, /- <p>one<\/p>/); assert.match(d1, /\+ <p>two<\/p>/); assert.doesNotMatch(d1, /three/);
    assert.match(changeDiff(f.ws, 'notes', f.v2), /\+ <p>three<\/p>/);
    assert.throws(() => changeDiff(f.ws, 'notes', '../x'), /no longer kept/);
    assert.throws(() => changeDiff(f.ws, '../etc', f.v1), /no such app/);
    // Stale undo from an older row is refused; the newest passes.
    assert.throws(() => refuseStaleUndo(f.ws, 'notes', f.v1), (e) => e.status === 409);
    refuseStaleUndo(f.ws, 'notes', f.v2); refuseStaleUndo(f.ws, 'notes', null);
    // After undoing the newest change: the earlier change is undoable, and its diff is that change alone.
    undoLastEdit(f.app, f.root, 'notes');
    const after = activityRows(audit.slice(0, 2), hist);
    assert.deepEqual(after.map((r) => !!r.canUndo), [false, true]);
    const d = changeDiff(f.ws, 'notes', f.v1);
    assert.match(d, /\+ <p>two<\/p>/); assert.doesNotMatch(d, /three/);
  } finally { rmTemp(f.ws); }
});

test('a critical failure within a week is kept past the row cap', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const rows = [{ at: '2026-11-23T00:00:00Z', ev: 'node-health-failed', ok: false }, { at: '2026-11-01T00:00:00Z', ev: 'job-retries-exhausted', job: 'old' }];
  for (let i = 0; i < ACTIVITY_MAX + 5; i++) rows.push({ at: '2026-11-24T00:00:00Z', ev: 'job-failed', job: 'j' });
  rows.unshift(rows.pop());
  const out = activityRows(rows, () => [], ACTIVITY_MAX, now);
  assert.equal(out.length, ACTIVITY_MAX + 1);
  assert.ok(out.some((r) => r.ev === 'node-health-failed' && r.crit));
  assert.ok(!out.some((r) => r.job === 'old'), 'an old critical row is not pinned past the cap');
});
