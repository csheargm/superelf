// Demo usage counts and the admin summary · 演示使用统计与管理汇总 (lib/demo-usage.mjs, lib/demo-admin.mjs, ADR 0045).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDemoUsage, openedApp, retentionDays, USAGE_DIR, USAGE_RETENTION_DAYS, netOf } from '../lib/demo-usage.mjs';
import { makeQuotaStore, TEST_IP, hashIp } from '../lib/demo-quota.mjs';
import { adminEmails, adminOf, buildSummary } from '../lib/demo-admin.mjs';
import { makeDemoUsers } from '../lib/demo.mjs';

const DAY = 86_400_000, T0 = Date.UTC(2026, 10, 26, 12);
const U1 = 'sb-0123456789abcdef', U2 = 'anon-fedcba9876543210';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'demo-usage-'));
// A visitor's app on disk: only real apps are counted per app.
const withApp = (root, id, slug) => { const d = path.join(root, `workspace-${id}`, 'apps', slug); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'index.html'), '<p>x'); return root; };
const readDay = (root, day) => JSON.parse(fs.readFileSync(path.join(root, USAGE_DIR, `${day}.json`), 'utf8'));

test('track: counts per visitor and app, kind by kind; a bad slug or kind counts nothing per app', () => {
  const root = withApp(tmp(), U1, 'notes'), u = makeDemoUsage({ root, cfg: {} });
  u.track(U1, { kind: 'open', app: 'notes', now: T0 });
  u.track(U1, { kind: 'ai', app: 'notes', now: T0 + 1 });
  u.track(U1, { kind: 'ai', now: T0 + 2 });
  u.track(U1, { kind: 'build', app: '../x', now: T0 + 3 });
  u.track(U1, { kind: 'ai', app: 'constructor', now: T0 + 3 });
  u.track(U1, { kind: 'ai', app: 'made-up', now: T0 + 3 });
  u.track(U1, { kind: 'steal', app: 'notes', now: T0 + 4 });
  u.track('not-an-id', { kind: 'open', app: 'notes', now: T0 });
  const v = readDay(root, '2026-11-26');
  assert.deepEqual(v.users[U1].apps, { notes: { open: 1, ai: 1, build: 0, edit: 0 } });
  assert.equal(v.users[U1].ai, 4, 'a made-up or inherited app name still counts the AI call, never as an app');
  assert.equal(v.users[U1].last, T0 + 3);
  assert.deepEqual(Object.keys(v.users), [U1]);
});

test('no content and no IP is ever stored: only counts, ids, slugs and an 8-hex network', () => {
  const root = tmp(), u = makeDemoUsage({ root, cfg: {} });
  u.track(U1, { kind: 'ai', app: 'notes', ip: '203.0.113.7', message: 'SECRET-TEXT', now: T0 });
  u.visit({ salt: () => 's', ip: '203.0.113.7', isNew: true, now: T0 });
  const raw = fs.readFileSync(path.join(root, USAGE_DIR, '2026-11-26.json'), 'utf8');
  assert.ok(!raw.includes('SECRET') && !raw.includes('203.0.113'), raw);
  assert.ok(!raw.includes(hashIp('s', '203.0.113.7')), 'never the full hash');
  assert.deepEqual(readDay(root, '2026-11-26').nets, { [netOf('s', '203.0.113.7')]: { visits: 1, new: 1 } });
});

test('the owner\'s test requests (TEST_IP) are never counted', () => {
  const root = tmp(), u = makeDemoUsage({ root, cfg: {} });
  u.track(U1, { kind: 'ai', app: 'notes', ip: TEST_IP, now: T0 });
  u.visit({ salt: () => { throw new Error('never read for a test request'); }, ip: TEST_IP, isNew: true, now: T0 });
  assert.ok(!fs.existsSync(path.join(root, USAGE_DIR, '2026-11-26.json')));
});

test('retention: the first write of a day deletes rollups older than the configured days', () => {
  const root = tmp(), cfg = { demo: { usage_retention_days: 3 } };
  const u = makeDemoUsage({ root, cfg });
  for (let i = 0; i < 6; i++) makeDemoUsage({ root, cfg: { demo: { usage_retention_days: 365 } } }).track(U1, { kind: 'ai', now: T0 - i * DAY });
  u.track(U1, { kind: 'ai', now: T0 });
  const left = fs.readdirSync(path.join(root, USAGE_DIR)).sort();
  assert.deepEqual(left, ['2026-11-24.json', '2026-11-25.json', '2026-11-26.json'], 'exactly 3 days, today included');
  assert.equal(retentionDays({}), USAGE_RETENTION_DAYS);
  assert.equal(retentionDays({ demo: { usage_retention_days: 0 } }), USAGE_RETENTION_DAYS);
});

test('dropUser removes the visitor from every kept day; others stay', () => {
  const root = tmp(), u = makeDemoUsage({ root, cfg: {} });
  u.track(U1, { kind: 'ai', now: T0 - DAY }); u.track(U1, { kind: 'ai', now: T0 }); u.track(U2, { kind: 'ai', now: T0 });
  fs.writeFileSync(path.join(root, USAGE_DIR, '2026-11-20.json'), `{"users":{"${U1}"`);   // a torn day may hold them
  u.dropUser(U1);
  assert.ok(!fs.existsSync(path.join(root, USAGE_DIR, '2026-11-20.json')), 'an unreadable day is removed whole');
  assert.ok(!readDay(root, '2026-11-25').users[U1]);
  assert.deepEqual(Object.keys(readDay(root, '2026-11-26').users), [U2]);
});

test('open: counted once a minute per visitor and app, only for an app that exists', () => {
  const root = withApp(tmp(), U1, 'notes'), u = makeDemoUsage({ root, cfg: {} });
  u.track(U1, { kind: 'open', app: 'notes', now: T0 });
  u.track(U1, { kind: 'open', app: 'notes', now: T0 + 1000 });
  u.track(U1, { kind: 'open', app: 'ghost', now: T0 });
  u.track(U1, { kind: 'open', app: 'notes', now: T0 + 61_000 });
  const v = readDay(root, '2026-11-26');
  assert.equal(v.users[U1].apps.notes.open, 2);
  assert.deepEqual(Object.keys(v.users[U1].apps), ['notes']);
});

test('openedApp: the app page itself only, a visitor id and a valid slug', () => {
  assert.deepEqual(openedApp(`/app/${U1}/notes/`), { uid: U1, slug: 'notes' });
  assert.deepEqual(openedApp(`/app/${U1}/notes/index.html`), { uid: U1, slug: 'notes' });
  assert.equal(openedApp(`/app/${U1}/notes/app.js`), null);
  assert.equal(openedApp('/app/shared/notes/'), null);
  assert.equal(openedApp(`/app/${U1}/..%2f/`), null);
});

test('dropNet clears ONLY that network\'s session/new rows for today', () => {
  const root = tmp(), file = path.join(root, 'q.json'), s = makeQuotaStore(file);
  const salt = s.salt(T0), a = hashIp(salt, '1.1.1.1'), b = hashIp(salt, '2.2.2.2');
  s.consume([[`session:${a}`, 99], [`new:${a}`, 99], [`ip:${a}`, 99], [`session:${b}`, 99], [`user:${U1}`, 99]], T0);
  assert.equal(s.dropNet(a.slice(0, 8), T0), 0, 'a short prefix names nothing: only the exact hash');
  assert.equal(s.dropNet(a, T0), 2);
  assert.deepEqual(Object.keys(s.today(T0).counts).sort(), [`ip:${a}`, `session:${b}`, `user:${U1}`].sort());
  assert.equal(s.dropNet('zz', T0), 0);
  assert.equal(s.dropNet(a, T0), 0, 'nothing left: nothing written');
});

test('adminEmails / adminOf: only a verified token whose email is listed; anonymous and members refused', async () => {
  const cfg = { demo: { admin_emails: [' Owner@Example.org ', 42, 'nope'] } };
  assert.deepEqual([...adminEmails(cfg)], ['owner@example.org']);
  const gate = (v) => ({ verify: async () => v, issuedAfterOut: () => true });
  const req = (t) => ({ headers: t ? { 'x-demo-auth': t } : {} });
  const otp = [{ method: 'otp', timestamp: 1 }];
  assert.ok((await adminOf(gate({ ok: true, sub: 's', email: 'OWNER@example.org', amr: otp, iat: 1 }), cfg, req('t'))).startsWith('sb-'));
  assert.ok((await adminOf(gate({ ok: true, sub: 's', email: 'owner@example.org', amr: ['oauth'] }), cfg, req('t'))).startsWith('sb-'));
  assert.equal(await adminOf(gate({ ok: true, sub: 's', email: 'owner@example.org', amr: [{ method: 'password' }], meta: { email_verified: true } }), cfg, req('t')), '', 'a password session does not prove the email; user_metadata never counts');
  assert.equal(await adminOf(gate({ ok: true, sub: 's', email: 'owner@example.org' }), cfg, req('t')), '', 'no amr: refused');
  assert.equal(await adminOf(gate({ ok: true, sub: 's', email: 'owner@example.org' }), cfg, req('')), '', 'anonymous');
  assert.equal(await adminOf(gate({ ok: true, sub: 's', email: 'member@example.org' }), cfg, req('t')), '', 'a member');
  assert.equal(await adminOf(gate({ ok: false, code: 'bad' }), cfg, req('t')), '', 'a bad token');
  assert.equal(await adminOf({ verify: async () => { throw new Error('down'); } }, cfg, req('t')), '', 'Supabase down');
  assert.equal(await adminOf(gate({ ok: true, sub: 's', email: 'owner@example.org' }), {}, req('t')), '', 'no list: nobody');
});

test('buildSummary: people, apps, today\'s blocked networks and the trend from the rollups', () => {
  const root = withApp(tmp(), U1, 'notes'), usage = makeDemoUsage({ root, cfg: {} }), store = makeQuotaStore(path.join(root, 'q.json'));
  const users = makeDemoUsers(root);
  users.ensure(U1, T0 - DAY); users.profile(U1, { email: 'a@example.org', name: 'Ann' }, T0);
  usage.track(U1, { kind: 'open', app: 'notes', now: T0 - DAY }); usage.track(U1, { kind: 'ai', app: 'notes', now: T0 });
  usage.visit({ salt: () => 'x', ip: '1.1.1.1', isNew: true, now: T0 });
  const h = hashIp(store.salt(T0), '9.9.9.9');
  store.consume([[`session:${h}`, 99], [`user:${U1}`, 99]], T0);
  const cfg = { demo: { sessions_per_ip_per_day: 1 } };
  const s = buildSummary({ cfg, root, users, store, usage, days: 14, now: T0 });
  assert.equal(s.trend.length, 14);
  assert.deepEqual(s.trend.at(-1), { day: '2026-11-26', visits: 1, new: 1, people: 1, ai: 1, builds: 0 });
  const p = s.people.find((x) => x.id === U1);
  assert.equal(p.email, 'a@example.org'); assert.equal(p.name, 'Ann'); assert.equal(p.aiToday, 1); assert.equal(p.ai, 1);
  assert.deepEqual(p.apps.notes, { open: 1, ai: 1, build: 0, edit: 0 });
  assert.deepEqual(s.apps.map((a) => [a.slug, a.people, a.open]), [['notes', [U1], 1]]);
  assert.deepEqual(s.today.nets, [{ id: h, net: h.slice(0, 8), visits: 1, new: 0, blocked: true }]);
  users.forget(U1);
  assert.equal(users.all().find((x) => x.id === U1).email, '');
});
