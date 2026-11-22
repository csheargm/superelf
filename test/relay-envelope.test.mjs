// The seam between a route and the app that consumes it · 中继与应用之间的接缝
//
// SCAR: the brokered web search worked, the app called it correctly, and the app still told the
// user 'No results found for "Tokyo" — try a different spelling'. Neither end was wrong. The
// RELAY was: it passed as='json', key='results', which wraps the whole response body under a
// second `results` key. /api/websearch answers an ENVELOPE — {ok:true, results:[…]} — so the app
// received results:{ok:true, results:[…]}, a non-array, and its (correct) array check reported
// no results and blamed the user's spelling for a wiring fault.
//
// My route tests passed throughout: they called the route directly over HTTP and never crossed
// this seam. So these tests RUN the shipped relayCall rather than matching its text.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);

// The shipped relayCall, lifted out and run against a stub `api`. Its helpers are stubbed to
// throw if reached, so a test can never pass by silently taking a failure path.
function relayCallFrom(shell) {
  const m = /async function relayCall\(url,opt,as,key\)\{[\s\S]*?\n\}/.exec(shell);
  assert.ok(m, 'relayCall must be findable');
  const src = `${m[0]}\nreturn relayCall;`;
  return (body) => {
    const api = async () => ({ ok: true, json: async () => body, text: async () => JSON.stringify(body) });
    const boom = (w) => () => { throw new Error('unexpected path: ' + w); };
    // eslint-disable-next-line no-new-func
    return new Function('api', 'relayNetFail', 'relayHttpFail', src)(api, boom('netFail'), boom('httpFail'));
  };
}
const make = relayCallFrom(SHELL);
const ENVELOPE = { ok: true, results: [{ title: 'Tokyo weather', url: 'https://e.com/1', snippet: 'Rain' }] };

test("CONTROL: 'json' really does nest the body — the bug was real, not theoretical", async () => {
  // If this control ever stops nesting, the assertion below is pinning nothing.
  const relayCall = make(ENVELOPE);
  const out = await relayCall('/api/websearch?q=tokyo', undefined, 'json', 'results');
  assert.equal(Array.isArray(out.results), false, 'the app would receive an object where it wants an array');
  assert.deepEqual(out.results, ENVELOPE, 'because the WHOLE envelope landed under results');
});

test("'raw' hands the app exactly what the route answered", async () => {
  const relayCall = make(ENVELOPE);
  const out = await relayCall('/api/websearch?q=tokyo', undefined, 'raw');
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.results), 'results is an ARRAY — what every app checks for');
  assert.equal(out.results[0].title, 'Tokyo weather');
});

test('a server failure keeps its code through the relay', async () => {
  // An app has to tell "found nothing" apart from "search is broken"; a code-less failure would
  // leave it guessing, which is how "try a different spelling" gets printed for a 502.
  const relayCall = make({ ok: false, code: 'search-failed', error: 'No results for: asdfgh' });
  const out = await relayCall('/api/websearch?q=asdfgh', undefined, 'raw');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'search-failed');
  assert.match(out.error, /No results/);
});

test('the websearch relay uses raw, because its route answers an envelope', () => {
  const branch = /\} else if\(m\.kind==='websearch'\)\{[\s\S]*?\n    \}/.exec(SHELL);
  assert.ok(branch, 'the websearch branch must be findable');
  assert.match(branch[0], /undefined,'raw'\)\)/, "relayed raw");
  assert.ok(!/'json','results'/.test(branch[0]), 'and never re-wrapped under a second results key');
});

test('every relay of an {ok,…} envelope route uses raw', () => {
  // The general rule, so the next route to answer an envelope does not repeat this. /api/ask is
  // the other one and was already raw — it is the precedent this should have followed.
  const askBranch = /\} else if\(m\.kind==='ask'\)\{[\s\S]*?\n    \}/.exec(SHELL);
  assert.ok(askBranch, 'the ask branch must be findable');
  assert.match(askBranch[0], /,'raw'\)/, 'ask relays its {ok,text} envelope raw');
});
