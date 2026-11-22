// lib/demo-quota.mjs and the demo route allow-list (lib/demo.mjs), as units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consumeSearch, trustCf, dirBytes, clientIp, demoLimit, demoOn, makeQuotaStore, consumeAiCall, checkDisk, DEMO_DEFAULTS, QUOTA_MESSAGES } from '../lib/demo-quota.mjs';
import { demoRouteAllowed, makeDemoUsers } from '../lib/demo.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-demo-'));
const DAY = 24 * 3600 * 1000;

test('client IP: cf-connecting-ip, else the socket address; a client-set x-forwarded-for never counts', () => {
  assert.equal(clientIp({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }, '10.0.0.5'), '1.1.1.1');
  assert.equal(clientIp({ 'x-forwarded-for': '2.2.2.2' }, '10.0.0.5'), '10.0.0.5');
  assert.equal(clientIp({}), 'unknown');
  assert.equal(clientIp({ 'cf-connecting-ip': '1.1.1.1' }, '10.0.0.5', false), '10.0.0.5', 'not behind Cloudflare: the header is ignored');
  assert.equal(trustCf({ demo: { enabled: true } }), false);
  assert.equal(trustCf({ demo: { enabled: true, behind_cloudflare: true } }), true);
});

test('limits come from config at use time; invalid values fall back to the defaults', () => {
  assert.equal(demoLimit({ demo: { ai_calls_per_user_per_day: 7 } }, 'ai_calls_per_user_per_day'), 7);
  assert.equal(demoLimit({ demo: { ai_calls_per_user_per_day: -1 } }, 'ai_calls_per_user_per_day'), DEMO_DEFAULTS.ai_calls_per_user_per_day);
  assert.equal(demoLimit({ demo: true }, 'total_disk_gb'), 5);
  assert.equal(demoOn({ demo: true }), true);
  assert.equal(demoOn({ demo: { enabled: true } }), true);
  assert.equal(demoOn({ demo: { enabled: 'yes' } }), false);
  assert.equal(demoOn({}), false);
  process.env.SUPERELF_DEMO = '1';
  try { assert.equal(demoOn({ demo: false }), true, 'the container env forces demo mode on'); } finally { delete process.env.SUPERELF_DEMO; }
});

test('an AI call counts against user and network both or neither, resets each UTC day, and the raw IP is never stored', () => {
  const dir = tmp(), file = path.join(dir, 'q.json'), store = makeQuotaStore(file);
  const cfg = { demo: { enabled: true, ai_calls_per_user_per_day: 5, ai_calls_per_ip_per_day: 2 } };
  const now = Date.UTC(2026, 0, 1, 12);
  assert.equal(consumeAiCall({ cfg, store, userId: 'a', ip: '9.9.9.9', now }).ok, true);
  assert.equal(consumeAiCall({ cfg, store, userId: 'b', ip: '9.9.9.9', now }).ok, true);
  const r = consumeAiCall({ cfg, store, userId: 'c', ip: '9.9.9.9', now });
  assert.equal(r.code, 'demo_ai_ip'); assert.equal(r.error, QUOTA_MESSAGES.ai_ip); assert.equal(r.status, 429);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).counts['user:c'], undefined, 'a refused call is not counted');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('9.9.9.9'), 'only a salted hash of the IP is kept');
  assert.equal(consumeAiCall({ cfg, store, userId: 'c', ip: '9.9.9.9', now: now + DAY }).ok, true, 'a new UTC day starts over');
});

test('a damaged counter file refuses instead of handing out a fresh day', () => {
  const dir = tmp(), file = path.join(dir, 'q.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => consumeAiCall({ cfg: { demo: true }, store: makeQuotaStore(file), userId: 'a', ip: 'x' }), /unreadable/);
  fs.writeFileSync(file, JSON.stringify({ salt: 's', day: new Date().toISOString().slice(0, 10), counts: 'zero' }));
  assert.throws(() => consumeAiCall({ cfg: { demo: true }, store: makeQuotaStore(file), userId: 'a', ip: 'x' }), /damaged/, "parseable but wrong: still no fresh day");
  fs.writeFileSync(file, JSON.stringify({ salt: 's', day: new Date().toISOString().slice(0, 10), counts: { 'user:a': 'many' } }));
  assert.throws(() => consumeAiCall({ cfg: { demo: true }, store: makeQuotaStore(file), userId: 'a', ip: 'x' }), /damaged/, 'a non-number counter');
  fs.writeFileSync(file, JSON.stringify({ salt: 's', counts: {} }));
  assert.throws(() => consumeAiCall({ cfg: { demo: true }, store: makeQuotaStore(file), userId: 'a', ip: 'x' }), /damaged/, 'no day');
});

test('disk: the total demo ceiling is checked before the per-user cap', () => {
  const sizes = { '/root': 6 * 1024 ** 3, '/root/ws': 1 };
  const meter = (d) => sizes[d], userBytes = meter;
  assert.equal(checkDisk({ cfg: { demo: true }, rootDir: '/root', userDir: '/root/ws', meter, userBytes }).code, 'demo_disk_total');
  sizes['/root'] = 1; sizes['/root/ws'] = 21 * 1024 ** 2;
  assert.equal(checkDisk({ cfg: { demo: true }, rootDir: '/root', userDir: '/root/ws', meter, userBytes }).code, 'demo_disk_user');
  sizes['/root/ws'] = 1;
  assert.equal(checkDisk({ cfg: { demo: true }, rootDir: '/root', userDir: '/root/ws', meter, userBytes }).ok, true);
});

test('disk: every file and folder costs at least one block, so tiny files cannot hide', () => {
  const dir = tmp();
  for (let i = 0; i < 10; i++) { fs.mkdirSync(path.join(dir, `d${i}`)); fs.writeFileSync(path.join(dir, `d${i}`, 'f'), 'x'); }
  assert.equal(dirBytes(dir), 20 * 4096);
  fs.writeFileSync(path.join(dir, 'just-over'), Buffer.alloc(4097));
  assert.equal(dirBytes(dir), 22 * 4096, '4097 bytes cost two blocks');
});

test('the demo allow-list fails closed: only listed routes pass', () => {
  assert.equal(demoRouteAllowed('POST', '/api/chat'), true);
  assert.equal(demoRouteAllowed('GET', '/api/convos/abc123'), true);
  assert.equal(demoRouteAllowed('PATCH', '/api/convos/abc123'), true);
  for (const [m, p] of [['GET', '/api/admin/users'], ['POST', '/api/jobs'], ['GET', '/api/convos/../../config'],
    ['DELETE', '/api/apps/notes'], ['POST', '/api/new-route-added-later'], ['GET', '/api/websearch'], ['GET', '/api/family-apps'], ['GET', '/api/note-search'], ['GET', '/api/note-text']]) {
    assert.equal(demoRouteAllowed(m, p), false, `${m} ${p}`);
  }
});

test('note HTML→text stays linear on malformed markup (a public save cannot stall the node)', async () => {
  const { htmlToText } = await import('../lib/note-index.mjs');
  const t0 = Date.now();
  htmlToText('<'.repeat(200_000) + '<br' + 'a'.repeat(1000));
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.equal(htmlToText('<p>one</p><b>two</b>'), '\none\ntwo');
});

test('typed-highlight scan stays linear on malformed markup too', async () => {
  const { typedHighlights } = await import('../lib/note-emphasis.mjs');
  const t0 = Date.now();
  typedHighlights('<a' + '<'.repeat(200_000));
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('a demo node keeps at most 60 audit lines per event kind per hour; a normal node keeps all', async () => {
  const { limitAudit } = await import('../lib/demo-quota.mjs');
  let n = 0; const demo = limitAudit(() => { n++; }, () => true);
  let last;
  const demo2 = limitAudit((ev, x) => { last = x; }, () => true);
  demo2('save-data-failed', { path: 'p'.repeat(10000) });
  assert.equal(last.path.length, 200, 'caller-supplied fields are cut short');
  for (let i = 0; i < 500; i++) demo('note-index-failed', {});
  assert.equal(n, 60);
  let m = 0; const normal = limitAudit(() => { m++; }, () => false);
  for (let i = 0; i < 500; i++) normal('x', {});
  assert.equal(m, 500);
});

test('a visitor store without a users map refuses instead of starting empty — on use, never at boot', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'demo-users.json'), '{"oops":1}');
  const users = makeDemoUsers(dir);   // a node with demo off boots fine
  assert.throws(() => users.get('anon-0000000000000000'), /damaged/);
});

test('Bible searches are counted per visitor per day', () => {
  const dir = tmp(), store = makeQuotaStore(path.join(dir, 'q.json'));
  const cfg = { demo: { enabled: true, searches_per_user_per_day: 2 } };
  assert.equal(consumeSearch({ cfg, store, userId: 'a', ip: '1' }).ok, true);
  assert.equal(consumeSearch({ cfg, store, userId: 'a', ip: '1' }).ok, true);
  const r = consumeSearch({ cfg, store, userId: 'a', ip: '1' });
  assert.equal(r.status, 429); assert.equal(r.error, QUOTA_MESSAGES.search);
});
