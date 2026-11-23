// Shell-side speech recognition (kinds speech-start / speech-stop), used by the voice
// todo app. iOS Safari blocks webkitSpeechRecognition inside a sandboxed iframe, so the
// SHELL owns the recognizer and streams results down to the app.
//
// This kind is the only one that answers MORE THAN ONCE for a single request id, and that
// is exactly what made it drift out of the R3 contract: it grew its own postMessage helper
// and answered failures with bare SpeechRecognition tokens ('no-speech'), bypassing the one
// failure mapper every other kind goes through. Two regressions are pinned here:
//   1. failures must be coded and rendered — not raw tokens (R3/R5)
//   2. the "not supported" reply must carry done:true, or the app's waiter never settles
//      and the user is told "timeout" 15s later instead of the real reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined
import { loadRelayCore } from './helpers-shell-broker.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

// The speech branch only, so a pin here cannot be satisfied by some other kind's code.
const SPEECH = (() => {
  const from = SHELL.indexOf("m.kind==='speech-start'");
  const to = SHELL.indexOf("} else reply({ok:false,code:'bad-request',error:'unknown'});");
  assert.ok(from > 0 && to > from, 'the speech branches must stay findable in the broker');
  return codeOnly(SHELL.slice(from, to));
})();

function extractFn(src, name, deps = {}) {
  const m = src.match(new RegExp(`(async )?function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} must stay a named top-level function`);
  const keys = Object.keys(deps);
  return new Function(...keys, `${m[0]}; return ${name};`)(...keys.map((k) => deps[k]));
}
// The REAL mapper, run — not a retyped copy (same seam as test/broker-relay.test.mjs).
const { relayFail } = loadRelayCore(async () => {});
const speechReason = extractFn(SHELL, 'speechReason');

test('R3: the speech branch has no postMessage helper of its own — every reply goes through reply()', () => {
  assert.equal(/postMessage/.test(SPEECH), false,
    'a second postMessage helper here is a second mapping; use the broker-wide reply()');
  assert.equal(/const send=/.test(SPEECH), false, 'the duplicate send() must stay deleted');
  assert.ok(SPEECH.includes('reply({ok:true,ev:\'result\''), 'streamed results answer through reply()');
});

test('R3: every speech failure reply leads with a code', () => {
  const failures = [...SPEECH.matchAll(/\{ok:false,(.{0,24})/g)].map((m) => m[1]);
  assert.ok(failures.length >= 2, 'both the unsupported and the recognition-error replies must be present');
  for (const f of failures) assert.match(f, /^code:/, `a speech failure without a code: {ok:false,${f}…`);
});

test('REGRESSION: the "not supported" reply carries done:true so the app settles at once', () => {
  // Without it the app's paSpeechStart waiter (which resolves only on done) hangs until its
  // own 15s timeout and reports "timeout" — hiding the real reason from the user.
  const m = SPEECH.match(/if\(!SR\) return reply\(\{[^}]*\}\)/);
  assert.ok(m, 'the unsupported branch must stay one reply()');
  assert.match(m[0], /done:true/, 'the unsupported reply must terminate the stream');
  assert.match(m[0], /code:'unsupported'/);
});

test('REGRESSION: a recognition error is rendered, never a bare SpeechRecognition token', () => {
  assert.equal(/error:e\.error/.test(SPEECH), false, 'the raw token must not reach the app');
  assert.match(SPEECH, /speechReason\(e&&e\.error,/, 'the shell authors the reason');
});

test('speechReason renders every common failure bilingually, and never returns a bare token', () => {
  const cases = ['not-allowed', 'service-not-allowed', 'no-speech', 'audio-capture', 'network', 'aborted'];
  for (const c of cases) {
    const s = speechReason(c, true);
    assert.notEqual(s, c, `${c} must not be echoed raw`);
    assert.match(s, /[一-鿿]/, `${c} must carry the 中文 half`);
    assert.match(s, /·/, `${c} must use the house EN · 中文 form`);
  }
});

test('speechReason still names an unknown token rather than swallowing it', () => {
  const s = speechReason('some-new-webkit-code', true);
  assert.match(s, /语音识别失败 · Speech failed/);
  assert.match(s, /some-new-webkit-code/, 'an unrecognised token is still reported, not hidden');
  assert.match(speechReason(undefined, true), /语音识别失败 · Speech failed/);
  assert.equal(/\(\)/.test(speechReason(undefined, true)), false, 'no empty parens when there is no token');
});

test('FUNCTIONAL: run the real mapper — a speech failure reaches the app with a rendered sentence', () => {
  for (const f of [
    { ok: false, code: 'unsupported', done: true, error: '不支持语音识别 · Speech not supported' },
    { ok: false, code: 'speech-error', done: true, error: speechReason('not-allowed', true) },
  ]) {
    const out = relayFail(f, 0, 'content');
    assert.equal(typeof out.text, 'string', 'the mapper must render a sentence');
    assert.ok(out.text.length > 0);
    assert.match(out.text, /[一-鿿]/, 'the rendered sentence stays bilingual');
    assert.equal(out.done, true, 'the terminal flag survives the mapper');
  }
});

test('FUNCTIONAL: a streamed interim result is left untouched by the mapper', () => {
  // ok:true replies must pass through unchanged — the transcript must not be rewritten.
  const out = relayFail({ ok: true, ev: 'result', text: 'buy milk', isFinal: false }, 0, 'content');
  assert.deepEqual(out, { ok: true, ev: 'result', text: 'buy milk', isFinal: false });
});

test('the recognizer is released on both terminal paths, so the next tap starts clean', () => {
  const ends = [...SPEECH.matchAll(/window\._paRec=null/g)];
  assert.ok(ends.length >= 3, 'onerror, onend and the restart path must all clear the handle');
});

// ── The consuming side ──
// The shell renders a reason; the app has to SHOW it. The voice todo app is the owner's
// live instance (gitignored personal data), so this pins it only when present — same
// guard as test/actions-ui.test.mjs's live-instance parity check.
test('live-instance: the voice todo app surfaces the failure the shell rendered', () => {
  const live = path.join(ROOT, 'workspace', 'apps', 'todo-voice', 'index.html');
  if (!fs.existsSync(live)) return; // fresh checkout has no instance — correct to skip
  const app = fs.readFileSync(live, 'utf8');
  // A speech failure RESOLVES the waiter (it is the terminal reply), so a bare
  // `await paSpeechStart(...)` with only a catch shows the user nothing at all.
  assert.match(app, /const end=await paSpeechStart\(/, 'the terminal reply must be captured');
  assert.match(app, /if\(end&&end\.ok===false\) setStatus\(end\.text/,
    'the rendered sentence must reach the user, not be dropped on the floor (R5)');
  assert.equal(/if\(e\.message!=='timeout'\) setStatus/.test(app), false,
    'a swallowed timeout is the same dead-mic symptom — it must say something');
});

test('an insecure origin is named as such — not as a permission the user could grant', () => {
  // http://<lan-ip>:8787 blocks the speech API outright and shows NO prompt, yet reports
  // the same 'not-allowed' token as a denied permission. Telling the user to allow the
  // microphone there is advice they cannot act on; the fix is the https:// address.
  const insecure = speechReason('not-allowed', false);
  assert.match(insecure, /https:\/\//, 'it must name the actual remedy');
  assert.equal(/browser settings/.test(insecure), false, 'settings advice is wrong when no prompt can appear');
  const secure = speechReason('not-allowed', true);
  assert.match(secure, /browser settings/, 'a denied permission is not re-prompted — settings is the remedy');
  assert.notEqual(insecure, secure, 'the two causes must not share one sentence');
  for (const s of [insecure, secure]) assert.match(s, /[一-鿿]/, 'both stay bilingual');
});

test('the call site passes the real secure-context flag', () => {
  assert.match(SPEECH, /speechReason\(e&&e\.error,window\.isSecureContext\)/);
});
