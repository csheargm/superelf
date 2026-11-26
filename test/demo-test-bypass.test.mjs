// The owner's own checks do not count toward the demo's network caps · 自测不计入演示配额 (2026-11-26).
// Automated live checks from the owner's home network used up its 10 new visitors a day.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumeVisit, consumeAiCall, isTestRequest, quotaIp, makeQuotaStore, TEST_HEADER, TEST_IP } from '../lib/demo-quota.mjs';
import { DEMO_START_PATH } from '../lib/demo.mjs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const TOKEN = 'unit-test-bypass-token-0123456789';   // a fixture, never a deployed value
const cfgWith = (demo) => ({ demo: { enabled: true, new_users_per_ip_per_day: 0, sessions_per_ip_per_day: 0, ai_calls_per_ip_per_day: 0, ...demo } });
const tmpStore = () => makeQuotaStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-bypass-')), 'q.json'));
const ipFor = (cfg, headers) => quotaIp(cfg, headers, '203.0.113.9');

const STILL_CAPPED = [
  ['no header', cfgWith({ test_bypass_token: TOKEN }), {}],
  ['wrong header', cfgWith({ test_bypass_token: TOKEN }), { [TEST_HEADER]: TOKEN + 'x' }],
  ['empty header', cfgWith({ test_bypass_token: TOKEN }), { [TEST_HEADER]: '' }],
  ['header but no config value', cfgWith({}), { [TEST_HEADER]: TOKEN }],
  ['header and an empty config value', cfgWith({ test_bypass_token: '' }), { [TEST_HEADER]: '' }],
  ['a too-short config value', cfgWith({ test_bypass_token: 'short' }), { [TEST_HEADER]: 'short' }],
  ['a non-string config value', cfgWith({ test_bypass_token: 12345 }), { [TEST_HEADER]: '12345' }],
];
for (const [name, cfg, headers] of STILL_CAPPED) {
  test(`${name}: still capped`, () => {
    assert.equal(isTestRequest(cfg, headers), false);
    const ip = ipFor(cfg, headers), store = tmpStore();
    assert.notEqual(ip, TEST_IP);
    assert.equal(consumeVisit({ cfg, store, ip, isNew: true }).status, 429);
    assert.equal(consumeAiCall({ cfg, store, userId: 'u', ip }).status, 429);
  });
}

test('the right header: visits and per-network AI calls are not counted; per-visitor and node caps still are', () => {
  const cfg = cfgWith({ test_bypass_token: TOKEN, ai_calls_per_user_per_day: 2, ai_calls_node_per_day: 3 }), store = tmpStore();
  const ip = ipFor(cfg, { [TEST_HEADER]: TOKEN });
  assert.equal(ip, TEST_IP);
  for (let i = 0; i < 5; i++) assert.equal(consumeVisit({ cfg, store, ip, isNew: true }).ok, true);
  assert.equal(consumeAiCall({ cfg, store, userId: 'u', ip }).ok, true);
  assert.equal(consumeAiCall({ cfg, store, userId: 'u', ip }).ok, true);
  assert.equal(consumeAiCall({ cfg, store, userId: 'u', ip }).status, 429, 'the per-visitor cap still holds');
  // Same store: nothing was charged to the real network the tests came from…
  const open = cfgWith({ new_users_per_ip_per_day: 1, sessions_per_ip_per_day: 1, ai_calls_per_ip_per_day: 1, ai_calls_node_per_day: 3 });
  assert.equal(consumeVisit({ cfg: open, store, ip: '203.0.113.9', isNew: true }).ok, true);
  assert.equal(consumeAiCall({ cfg: open, store, userId: 'v', ip: '203.0.113.9' }).ok, true);
  // …but the test calls did use the node-wide cap (2 test + 1 real = 3).
  assert.equal(consumeAiCall({ cfg: open, store, userId: 'w', ip: '198.51.100.7' }).status, 429);
  assert.equal(consumeAiCall({ cfg, store, userId: 'x', ip }).status, 429, 'a test call is refused once the node cap is spent');
});

// R6: the real server, first visit refused by the cap, the owner's check let through and not in the visitor stats.
let n;
after(async () => { if (n) { await stopWeb(n.web); rmTemp(n.root); } });
test('demo start: capped without the header, admitted with it, and audited as a test', async () => {
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig: { users: [], demo: { enabled: true, new_users_per_ip_per_day: 0, test_bypass_token: TOKEN } } });
  fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  n = { root, web: startWeb(root) }; await waitReady(port);
  const go = (h) => fetch(`http://127.0.0.1:${port}${DEMO_START_PATH}`, { method: 'POST', headers: h });
  assert.equal((await go({})).status, 429);
  assert.equal((await go({ [TEST_HEADER]: 'wrong-wrong-wrong-wrong-wrong' })).status, 429);
  const ok = await go({ [TEST_HEADER]: TOKEN });
  assert.equal(ok.status, 200, await ok.clone().text());
  const audit = fs.readdirSync(root, { recursive: true }).filter((f) => /audit/.test(String(f)))
    .map((f) => { try { return fs.readFileSync(path.join(root, String(f)), 'utf8'); } catch { return ''; } }).join('');   // a directory reads as '': skipped
  assert.match(audit, /demo-test-visitor/);
  assert.doesNotMatch(audit, /"demo-visitor"/);
});
