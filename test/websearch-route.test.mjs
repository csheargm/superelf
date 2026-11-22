// Web search for apps · 应用联网搜索 — brokered by the SERVER, over real HTTP.
//
// SCAR: a family member opened a weather app, and the model answered "I need permission to run
// the websearch tool". Nobody could grant it. Four things stacked up: workspace.example/CLAUDE.md
// told every user to run `node ../tools/websearch.mjs`; a non-owner's agent has the permission
// bypass stripped (agentArgs), so Bash is unapprovable in a headless `-p` lane and ../tools is
// outside the workspace anyway; /api/ask carried no system prompt, so nothing could tell the
// model there is no approver; and the app rendered the refusal as a forecast because it arrived
// with ok:true.
//
// The sandbox was RIGHT — the capability was missing. These tests pin the route that supplies it
// without loosening the sandbox by one flag. The upstream is a local stub, so the suite never
// spends a Tavily credit and never depends on the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';

const MEMBER_TOKEN = 'test-member-token-0123456789abcd';
let port, root, web, tavily, tavilyPort;
let lastBody = null, reply = null;

before(async () => {
  // A stand-in Tavily. `reply` is swapped per test so one upstream can play every outcome.
  tavily = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      lastBody = JSON.parse(b || '{}');
      const r = reply || { status: 200, body: { results: [] } };
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise((r) => tavily.listen(0, '127.0.0.1', r));
  tavilyPort = tavily.address().port;

  port = await freePort();
  root = mkWebRoot({ port, extraConfig: {
    tavily_key: 'test-tavily-key',
    research: { tavily_url: `http://127.0.0.1:${tavilyPort}/search`, search_timeout_ms: 5000 },
    users: [
      { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
      { id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-kid' },
    ],
  } });
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (tavily) tavily.close(); });

const HITS = { results: [
  { title: 'Palo Alto weather', url: 'https://example.com/a', content: 'Sunny, 24C' },
  { title: 'Bay Area forecast', url: 'https://example.com/b', content: 'Clear tonight' },
] };
const get = (q, tok = OWNER_TOKEN) => api(port, `/api/websearch?${q}`, { headers: { authorization: 'Bearer ' + tok } });

test('CONTROL: a search really returns hits — the refusals below are not vacuous', async () => {
  reply = { status: 200, body: HITS };
  const r = await get('q=palo+alto+weather');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.results.length, 2);
  assert.deepEqual(j.results[0], { title: 'Palo Alto weather', url: 'https://example.com/a', snippet: 'Sunny, 24C' });
});

test('A MEMBER can search — that is the entire point', async () => {
  // The member's own agent still cannot run Bash and still cannot read a path outside its
  // workspace. The capability arrives without touching either of those.
  reply = { status: 200, body: HITS };
  const j = await (await get('q=weather', MEMBER_TOKEN)).json();
  assert.equal(j.ok, true);
  assert.equal(j.results.length, 2);
});

test('signed out is refused', async () => {
  // A RAW fetch, not the api() helper — that helper injects the owner's bearer token, so a
  // "signed out" assertion written with it is signed IN and proves nothing. Every search costs
  // money, so an unauthenticated one must never reach Tavily at all.
  const r = await fetch(`http://127.0.0.1:${port}/api/websearch?q=weather`);
  assert.equal(r.status, 401);
});

test('ZERO results is a failure, never an empty success', async () => {
  // The exact shape R14 warns about: an app that got {ok:true, results:[]} would render "no
  // weather" as though it had looked and found nothing worth saying.
  reply = { status: 200, body: { results: [] } };
  const r = await get('q=nothing+matches+this');
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.code, 'search-failed');
  assert.match(j.error, /No results/, 'and it says so in a sentence an app can show');
});

test('an upstream failure is reported, not swallowed', async () => {
  reply = { status: 500, body: { error: 'boom' } };
  const j = await (await get('q=weather')).json();
  assert.equal(j.ok, false);
  assert.equal(j.code, 'search-failed');
  assert.match(j.error, /Tavily HTTP 500/);
});

test('the query is bounded and the result count is capped', async () => {
  assert.equal((await get('q=')).status, 400, 'an empty query is rejected before any spend');
  assert.equal((await get('q=' + 'x'.repeat(401))).status, 400, 'and an absurd one is too');
  reply = { status: 200, body: HITS };
  await get('q=weather&max=999');
  assert.equal(lastBody.max_results, 10, 'a caller cannot raise the cap — every search costs money');
  await get('q=weather&max=0');
  assert.equal(lastBody.max_results, 1, 'nor drop below one');
  await get('q=weather');
  assert.equal(lastBody.max_results, 5, 'and the default is modest');
});

test('the Tavily key never leaves the server', async () => {
  reply = { status: 200, body: HITS };
  const j = await (await get('q=weather')).json();
  assert.ok(!JSON.stringify(j).includes('test-tavily-key'), 'not in the response');
  // tools/ lives OUTSIDE every workspace on purpose: a script a member could edit would run
  // server-side with this key.
  assert.equal(fs.existsSync(`${root}/workspace-kid/tools`), false, 'and not reachable inside a member workspace');
});

test('the audit records the SHAPE of a search, never the query', async () => {
  // A quota or abuse question has to stay answerable without keeping what the family searched for.
  reply = { status: 200, body: HITS };
  await get('q=something+private+to+me');
  const log = fs.readFileSync(`${root}/audit.log`, 'utf8');
  assert.match(log, /"ev":"websearch"/, 'the search is recorded');
  assert.ok(!log.includes('something private to me'), 'but the query itself is not');
  assert.match(log, /"hits":2/, 'the shape is, which is what a quota question needs');
});
