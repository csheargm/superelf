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

test('F1-4: error lines are 中文 first and carry no HTTP status code', async () => {
  for (const [status, body] of [[400, { error: '用户名无效 · bad username' }], [429, { error: '稍后再试 · slow down' }], [500, {}], [503, {}]]) {
    const g = await R.relayJson(reply(status, body), 'request');
    assert.doesNotMatch(g.text, /\(\d{3}\)|\b[45]\d\d\b/, `${status}: no HTTP code in "${g.text}"`);
    assert.match(g.text, /^[^A-Za-z]*[㐀-鿿]/, `${status}: 中文 first in "${g.text}"`);
  }
});

// A placeholder wider than a phone's input is cut mid-word (390 px screen ≈ 30 Latin chars, CJK counts double).
const PHONE_PLACEHOLDER_UNITS = 30;
const widthUnits = (s) => [...s].reduce((n, c) => n + (/[㐀-鿿（）]/.test(c) ? 2 : 1), 0);
const placeholderOf = (id) => (SHELL.match(new RegExp(`id="${id}"[^>]*placeholder="([^"]*)"`)) || [])[1];

test('F5-13: setup placeholders fit a phone and are 中文 first; the code hint is its own line', () => {
  for (const id of ['sUser', 'sName', 'sPin', 'sCode']) {
    const ph = placeholderOf(id);
    assert.ok(ph, `${id} has a placeholder`);
    assert.ok(widthUnits(ph) <= PHONE_PLACEHOLDER_UNITS, `${id} "${ph}" fits a phone`);
    assert.match(ph, /^[㐀-鿿]/, `${id} "${ph}" is 中文 first`);
  }
  const setup = SHELL.slice(SHELL.indexOf('<dialog id="setup"'), SHELL.indexOf('<dialog id="login"'));
  assert.match(setup, /setup-code/, 'where to find the setup code is still said, outside the placeholder');
});

test('F1-5: the access-token field opens above Sign in and names no config key', () => {
  const login = SHELL.slice(SHELL.indexOf('<dialog id="login"'), SHELL.indexOf('</dialog>', SHELL.indexOf('<dialog id="login"')));
  assert.ok(login.indexOf('id="ltok"') < login.indexOf('id="loginBtn"'), 'token field sits above the Sign in button');
  const ph = placeholderOf('ltok');
  assert.doesNotMatch(ph, /config|web_token/, `no file/key jargon in "${ph}"`);
  assert.match(ph, /^[㐀-鿿]/, `"${ph}" is 中文 first`);
});
