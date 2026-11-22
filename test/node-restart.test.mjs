// The Settings "Apply & restart · 应用并重启" button.
//
// SCAR: it swallowed the POST result. `api` is a bare fetch, so a 401 (signed out — what a
// NEW ORIGIN gives you, e.g. the first visit over the Tailscale https address) or a 403
// (member, not owner) never threw and the catch was never reached. The UI announced
// "restarting · 重启中…", polled '/', got 200 back from the server that had never gone
// down, and settled on "restarted · 已重启". A refused request read as a completed one —
// R14's vacuous success, on the one control whose whole job is to change process state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined
import { loadRelayCore } from './helpers-shell-broker.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

const FN = (() => {
  const i = SHELL.indexOf('async function doNodeRestart()');
  assert.ok(i > 0, 'doNodeRestart must stay findable');
  return codeOnly(SHELL.slice(i, SHELL.indexOf('\n}', i)));
})();

const R = loadRelayCore(async () => {});

test('the restart POST is not swallowed', () => {
  assert.equal(/try\{\s*await api\('\/api\/admin\/restart'/.test(FN), false,
    'the bare try/catch around the restart POST must stay gone — fetch does not throw on 4xx');
  assert.match(FN, /relayJson\(api\('\/api\/admin\/restart'/, 'it must go through the one mapper (R3)');
});

test('a refused restart reports the reason and does NOT claim to be restarting', () => {
  const guard = FN.slice(FN.indexOf('relayJson('), FN.indexOf("'restarting"));
  assert.match(guard, /if\(!g\.ok\)/, 'the failure must be checked before any progress message');
  assert.match(guard, /m\.textContent=g\.text/, 'and must show the rendered reason');
  assert.match(guard, /return/, 'and must stop — no polling, no "restarted" claim');
});

test('FUNCTIONAL: a 401 from that route renders a real sentence, not silence', async () => {
  const g = await R.relayJson(Promise.resolve(new Response(JSON.stringify({ error: 'bad token' }), { status: 401 })), 'request');
  assert.equal(g.ok, false, 'a 401 must be a failure, not a pass');
  assert.equal(typeof g.text, 'string');
  assert.ok(g.text.length > 0, 'the user must be told something');
  assert.match(g.text, /[一-鿿]/, 'bilingual, house style');
});

test('a successful restart still announces itself and polls for recovery', () => {
  assert.match(FN, /restarting · 重启中…/, 'the progress message survives');
  assert.match(FN, /restarted · 已重启/, 'and the recovery message');
  assert.match(FN, /still down — check the node · 未恢复，请检查节点/, 'and the timeout message');
});
