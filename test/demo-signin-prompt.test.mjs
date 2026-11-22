// A signed-out demo visitor's AI request · 演示未登录的 AI 请求. The demo's AI gate (lib/demo-auth.mjs)
// answers 401 {code: SIGNIN_CODE, error: DEMO_SIGNIN}; the shell's ONE failure mapper (web/index.html
// RELAY-CORE, run here as served) must show that sentence — not "Signed out · 登录已过期" — and fire
// SIGNIN_EVENT, which the demo boot (lib/demo-boot.mjs) answers by opening its sign-in popover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELAY_CORE, loadRelayCore } from './helpers-shell-broker.mjs';
import { SIGNIN_CODE, DEMO_SIGNIN } from '../lib/demo-auth.mjs';
import { SIGNIN_EVENT, injectDemoBoot } from '../lib/demo-boot.mjs';

const fired = [];
const R = loadRelayCore(() => { throw new Error('no api here'); }, { dispatchEvent: (e) => fired.push(e.type) });
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('R3: the shell names the same code and event as the demo modules', () => {
  assert.ok(RELAY_CORE.includes(`DEMO_SIGNIN_CODE='${SIGNIN_CODE}'`), 'web/index.html DEMO_SIGNIN_CODE = lib/demo-auth.mjs SIGNIN_CODE');
  assert.ok(RELAY_CORE.includes(`DEMO_SIGNIN_EVENT='${SIGNIN_EVENT}'`), 'web/index.html DEMO_SIGNIN_EVENT = lib/demo-boot.mjs SIGNIN_EVENT');
});

test('a demo sign-in refusal reads "sign in to use AI" and asks the demo to open its sign-in', async () => {
  fired.length = 0;
  const f = R.relayFail(await R.relayHttpFail(reply(401, { ok: false, code: SIGNIN_CODE, error: DEMO_SIGNIN })), 0, 'message');
  assert.equal(f.code, 'unauthorized', 'apps still see the same code');
  assert.match(f.text, /^Sign in to use AI/);
  assert.doesNotMatch(f.text, /登录已过期/);
  assert.deepEqual(fired, [SIGNIN_EVENT]);
});

test('CONTROL / owner node: a plain 401 is unchanged — "Signed out", no event', async () => {
  fired.length = 0;
  const f = R.relayFail(await R.relayHttpFail(reply(401, { error: 'bad token' })), 0, 'message');
  assert.match(f.text, /Signed out · 登录已过期/);
  assert.deepEqual(fired, []);
});

test('the demo boot opens the sign-in popover on that event (signed-out branch only)', () => {
  const html = injectDemoBoot('<html><head></head><body></body></html>', {});
  assert.ok(html.includes(`addEventListener('${SIGNIN_EVENT}',function(){if(!pop)ask();})`));
});
