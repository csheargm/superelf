// Owner alerts · 需要处理 (lib/node-alerts.mjs, docs/adr/0041): alert state, the fixed action list,
// the request file, rate limit, snooze, and the route's owner-only gate on the REAL web.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { healthAlerts, jobAlerts, alertsView, requestAction, resetActionGaps, snooze, NODE_ACTIONS, NODE_HEALTH_FILE, ACTIONS_DIR, ACTION_GAP_MS, SNOOZE_MAX_MS } from '../lib/node-alerts.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ALL = { ok: false, at: '2026-11-24T03:00:00Z', actions: [...NODE_ACTIONS], problems: [{ kind: 'disk', box: 'private', pct: 91 }, { kind: 'claude' }] };
function node(health = ALL) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));
  if (health) fs.writeFileSync(path.join(dir, NODE_HEALTH_FILE), JSON.stringify(health));
  return { dir, cfg: { auditFile: path.join(dir, 'audit.log') } };
}
const req = (dir, a) => path.join(dir, ACTIONS_DIR, 'req', a);

test('health file → alerts; ok, missing or junk → none; unknown kinds and boxes are dropped or folded', () => {
  assert.deepEqual(healthAlerts(ALL).map((a) => a.id), ['disk:private', 'claude']);
  assert.equal(healthAlerts(ALL)[0].pct, 91);
  assert.deepEqual(healthAlerts({ ok: true, problems: ALL.problems }), []);
  assert.deepEqual(healthAlerts(null), []);
  assert.deepEqual(healthAlerts({ ok: false, problems: [{ kind: 'rm -rf' }, { kind: 'disk', box: '../x', pct: 99 }] }).map((a) => a.id), ['disk:other']);
});

test('a job alert stands only while its LATEST outcome is "failed every retry", the owner\'s own, within a week', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const ex = (job, at, who = 'owner') => ({ ev: 'job-retries-exhausted', who, job, at });
  assert.deepEqual(jobAlerts([ex('brief', '2026-11-24T06:00:00Z')], 'owner', now).map((a) => a.id), ['job:brief']);
  assert.deepEqual(jobAlerts([ex('brief', '2026-11-24T06:00:00Z'), { ev: 'job-run', who: 'owner', job: 'brief', at: '2026-11-24T07:00:00Z' }], 'owner', now), [], 'cleared by the next good run');
  assert.deepEqual(jobAlerts([ex('brief', '2026-11-24T06:00:00Z', 'kid')], 'owner', now), [], 'a member\'s job is not the owner\'s alert');
  assert.deepEqual(jobAlerts([ex('brief', '2026-11-10T06:00:00Z')], 'owner', now), [], 'older than a week');
});

test('the view clears itself when the next check passes', () => {
  const n = node();
  assert.equal(alertsView(n.cfg, 'owner').alerts.length, 2);
  fs.writeFileSync(path.join(n.dir, NODE_HEALTH_FILE), JSON.stringify({ ok: true, actions: ALL.actions, problems: [] }));
  assert.deepEqual(alertsView(n.cfg, 'owner').alerts, []);
  rmTemp(n.dir);
});

test('actions: allow-list only, an empty file with a fixed name, pending blocks a second one, rate limit', () => {
  resetActionGaps();
  const n = node(), now = Date.now();
  for (const bad of ['../../etc/passwd', 'cleanup-disk/../x', 'cleanup-disk;reboot', '', 'CLEANUP-DISK'])
    assert.throws(() => requestAction(n.cfg, bad, now), (e) => e.code === 400, bad);
  requestAction(n.cfg, 'cleanup-disk', now);
  assert.equal(fs.readFileSync(req(n.dir, 'cleanup-disk'), 'utf8'), '', 'no argument passes through');
  assert.deepEqual(fs.readdirSync(path.join(n.dir, ACTIONS_DIR, 'req')), ['cleanup-disk']);
  assert.deepEqual(alertsView(n.cfg, 'owner').pending, ['cleanup-disk']);
  assert.throws(() => requestAction(n.cfg, 'recheck', now), (e) => e.code === 409, 'one at a time');
  fs.unlinkSync(req(n.dir, 'cleanup-disk'));   // the host took it
  assert.throws(() => requestAction(n.cfg, 'cleanup-disk', now + 1000), (e) => e.code === 429);
  requestAction(n.cfg, 'cleanup-disk', now + ACTION_GAP_MS + 1);
  rmTemp(n.dir);
});

test('fail closed: no host helper listed → refused; a linked action folder → refused, nothing written through it', () => {
  resetActionGaps();
  const none = node({ ok: false, problems: [{ kind: 'claude' }] });
  assert.throws(() => requestAction(none.cfg, 'rebuild-node'), (e) => e.code === 409);
  assert.deepEqual(alertsView(none.cfg, 'owner').actions, []);
  const n = node(), elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'));
  fs.symlinkSync(elsewhere, path.join(n.dir, ACTIONS_DIR));
  assert.throws(() => requestAction(n.cfg, 'recheck'), (e) => e.code === 500);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  for (const d of [none.dir, n.dir, elsewhere]) rmTemp(d);
});

test('snooze: hides the alert, at most a day, bad ids refused', () => {
  const n = node(), now = Date.now();
  snooze(n.cfg, 'claude', new Date(now + 10 * SNOOZE_MAX_MS).toISOString(), now);
  const v = alertsView(n.cfg, 'owner', now + 1000);
  assert.equal(v.alerts.find((a) => a.id === 'claude').snoozed, true);
  assert.equal(alertsView(n.cfg, 'owner', now + SNOOZE_MAX_MS + 1).alerts.find((a) => a.id === 'claude').snoozed, false, 'capped at a day');
  assert.throws(() => snooze(n.cfg, '../x', ''), (e) => e.code === 400);
  rmTemp(n.dir);
});

let port, root, web;
const MEMBER = 'test-member-token-0123456789abcdef';
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'kid', name: 'Kid', role: 'member', token: MEMBER, workspace: 'workspace-kid' }] } });
  fs.writeFileSync(path.join(root, NODE_HEALTH_FILE), JSON.stringify(ALL));
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (root) rmTemp(root); });
const call = (tok, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: body ? 'POST' : 'GET',
  headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

test('route: the owner reads alerts and asks for a fixed action; a member gets 403 and writes nothing', async () => {
  const r = await call(OWNER_TOKEN, '/api/admin/alerts');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).alerts.map((a) => a.id), ['disk:private', 'claude']);
  for (const [p, b] of [['/api/admin/alerts'], ['/api/admin/alerts/action', { action: 'recheck' }], ['/api/admin/alerts/snooze', { id: 'claude' }]])
    assert.equal((await call(MEMBER, p, b)).status, 403, p);
  assert.equal(fs.existsSync(path.join(root, ACTIONS_DIR)), false, 'the member wrote nothing');
  assert.equal((await call(OWNER_TOKEN, '/api/admin/alerts/action', { action: '../../x' })).status, 400);
  assert.equal((await call(OWNER_TOKEN, '/api/admin/alerts/action', { action: 'recheck' })).status, 202);
  assert.ok(fs.existsSync(req(root, 'recheck')));
  assert.equal((await call(OWNER_TOKEN, '/api/admin/alerts/action', { action: 'recheck' })).status, 409);
});
