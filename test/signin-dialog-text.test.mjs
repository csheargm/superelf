// Sign-in and first-run setup dialogs: what a newcomer reads (overnight QA 2026-11-22).
// The relay mapper is the REAL RELAY-CORE block from web/index.html; the dialog pins read the shell AS SERVED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL, loadRelayCore } from './helpers-shell-broker.mjs';

const R = loadRelayCore(() => { throw new Error('no api in this context'); });
const reply = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const WRONG_CODE = '初始化码错误 · Wrong setup code';

test('F1-1: a wrong setup code shows the server reason, not "Signed out"', async () => {
  const setupCall = SHELL.slice(SHELL.indexOf('async function doSetup'), SHELL.indexOf('async function ensureToken'));
  const what = (setupCall.match(/fetch\('\/api\/setup'[\s\S]*?\),'(\w+)'\)/) || [])[1];
  assert.ok(what, 'doSetup names its relay noun');
  const g = await R.relayJson(reply(403, { error: WRONG_CODE }), what);
  assert.equal(g.ok, false);
  assert.match(g.text, /初始化码错误/, 'the server reason is shown');
  assert.doesNotMatch(g.text, /Signed out|登录已过期/, 'a setup attempt is not an expired session');
});
