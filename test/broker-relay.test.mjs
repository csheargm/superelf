// The shell broker's failure mapping — the harness for the SECOND half of the
// 2026-09-02 DATA-LOSS scar: every READ failure looked exactly like "the file does not
// exist".
//
// WHY THIS FILE EXISTS AND WHY IT LOOKS LIKE THIS
// web/index.html used to answer an app `{ok:false,error:'not found'}` for a 401 (expired
// session / restarted server), for a 500, and for every fetch rejection. An app reads
// "absent" as "a new empty note" and its next save writes that empty note over the user's
// good data. Nothing tested it, because the only tests were source greps.
// So this harness does NOT mock the shell and does not mock the server:
//   * the mapper is EXTRACTED from web/index.html between its RELAY-CORE markers and RUN
//     (the same technique test/note-save.test.mjs uses for the note engine);
//   * it runs against a real node:http server answering the shapes production really
//     answers — web.mjs's sendFile 404/500 are text/plain, its auth gate is 401 JSON, and
//     every oversize body is rejected by the REPO'S OWN readBody + BODY_LIMITS through the
//     REPO'S OWN bodyErrorResponse, never a hand-written 413.
// R14: a lenient harness is what caused the incident, so the first two tests prove the
// harness can fail — if the extraction stops finding real code, or the server stops
// enforcing the real cap, the suite says so instead of going green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBody, bodyErrorResponse, BODY_LIMITS, BODY_TOO_LARGE, CODE_TOO_LARGE, humanBytes } from '../lib/webutil.mjs';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined
// Source pins below scan CODE, not prose: a comment that quotes the very shape it warns
// about ("this used to answer {ok:false,…}") must not fail the pin that forbids it.
import { codeOnly } from './helpers-code.mjs';
import { RELAY_CORE, loadRelayCore } from './helpers-shell-broker.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT); // throws if moved — never a vacuous pass

// ── The DOM-free relay core, extracted from the shell and RUN (helpers-shell-broker.mjs loadRelayCore) ──
// A DOM reference here would mean the block cannot be the single mapping every kind
// shares (and could not be tested at all) — pin it.
assert.ok(!/\bdocument\b|\$\('#|\bwindow\./.test(RELAY_CORE), 'the relay core must stay DOM-free');

// ── A real server answering the shapes web.mjs really answers ──
// /found        200 text/plain           — a file that is there
// /missing      404 text/plain 'not found'  (web.mjs sendFile, ENOENT)
// /unauth       401 application/json {"error":"bad token"}  (web.mjs:651)
// /boom         500 text/plain 'error'      (web.mjs sendFile, non-ENOENT read error)
// /refused      400 application/json        (a route rejecting the request)
// /truncated    200 application/json but cut off mid-object
// /dead         connection destroyed with no answer at all (Wi-Fi→cellular handoff)
// /api/save-data  the REAL readBody(BODY_LIMITS.appData) + REAL bodyErrorResponse
// /api/chat       the REAL readBody(BODY_LIMITS.chat)  + REAL bodyErrorResponse
function startServer() {
  const state = { saved: null };
  const srv = http.createServer(async (req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    const u = req.url.split('?')[0];
    try {
      if (u === '/found') return send(200, 'text/plain', 'the notebook bytes');
      if (u === '/missing') return send(404, 'text/plain', 'not found');
      if (u === '/unauth') return send(401, 'application/json', '{"error":"bad token"}');
      if (u === '/forbidden') return send(403, 'application/json', '{"error":"forbidden"}');
      if (u === '/boom') return send(500, 'text/plain', 'error');
      if (u === '/refused') return send(400, 'application/json', '{"ok":false,"error":"bad path","code":"bad_path"}');
      if (u === '/json') return send(200, 'application/json', '{"convos":[{"id":"c1"}],"ok":true}');
      if (u === '/truncated') return send(200, 'application/json', '{"ok":true,"pages":[{"id"');
      if (u === '/ask-failed') return send(200, 'application/json', '{"ok":false,"text":"the agent crashed"}');
      if (u === '/dead') { req.socket.destroy(); return; }
      if (u === '/api/save-data') {
        const b = await readBody(req, BODY_LIMITS.appData);          // REAL reader, REAL cap
        state.saved = b;
        // web.mjs answers the size telemetry verbatim on success — the app must receive it.
        return send(200, 'application/json', JSON.stringify({ ok: true, bytes: 164, prevBytes: 47076, shrank: true }));
      }
      if (u === '/api/chat') {
        await readBody(req, BODY_LIMITS.chat);                        // REAL reader, REAL cap
        // The success shape is NDJSON, one JSON object per line.
        return send(200, 'application/x-ndjson', '{"type":"done","text":"hi"}\n');
      }
      return send(404, 'text/plain', 'not found');
    } catch (e) {
      // web.mjs's one catch-all: the REAL failure → HTTP answer mapping (413 + limit).
      if (!res.headersSent) { const r = bodyErrorResponse(e); send(r.status, 'application/json', r.body); }
      else if (!res.writableEnded) res.end();
    }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port })));
}

async function withServer(fn) {
  const s = await startServer();
  const base = `http://127.0.0.1:${s.port}`;
  const R = loadRelayCore((p, opt) => fetch(base + p, opt));
  try { await fn({ ...s, base, R }); } finally { s.srv.close(); }
}

const oversize = (limit) => 'x'.repeat(limit + 1024);

// ── R14 controls: prove the harness can fail before trusting anything it says ────────────

test('harness fidelity: the server answers the REAL production shapes and enforces the REAL caps', async () => {
  await withServer(async ({ base }) => {
    // The 404/500 bodies are text/plain — a mapper that assumes JSON would throw on them.
    const miss = await fetch(base + '/missing');
    assert.equal(miss.status, 404);
    assert.equal(miss.headers.get('content-type'), 'text/plain');
    const boom = await fetch(base + '/boom');
    assert.equal(boom.status, 500);
    assert.equal(await boom.text(), 'error');
    // The oversize rejection is produced by the repo's own readBody + bodyErrorResponse,
    // so this harness can never be laxer than production.
    const big = await fetch(base + '/api/save-data', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'entry-a.json', data: oversize(BODY_LIMITS.appData) }),
    });
    assert.equal(big.status, 413);
    // Byte-identical to what the repo's OWN mapper produces — the harness cannot invent a
    // tidier 413 than production sends (the wording is the server team's to change; the
    // shape this shell depends on is `limit`, pinned below).
    const oracle = bodyErrorResponse(Object.assign(new Error(BODY_TOO_LARGE), { limit: BODY_LIMITS.appData }));
    assert.equal(await big.text(), oracle.body);
    assert.equal(JSON.parse(oracle.body).limit, BODY_LIMITS.appData, 'a 413 MUST carry the cap it enforced, or no client can say what to cut');
    // …and a dead socket really rejects, rather than resolving to some empty response.
    await assert.rejects(() => fetch(base + '/dead'), 'a destroyed connection must reject the fetch');
  });
});

test('harness fidelity: the extracted relay core is real code from web/index.html, not a stub', async () => {
  await withServer(async ({ R }) => {
    assert.equal(typeof R.relayCall, 'function');
    assert.equal(typeof R.relayHttpFail, 'function');
    assert.equal(R.RELAY_NOT_FOUND, 'not found', 'the legacy error string stays pinned in ONE place (R3)');
    assert.match(R.RELAY_TOO_LARGE_MSG, /消息过长 · Message too large/, 'bilingual');
    assert.equal(R.relayBodyBytes('中文'), 6, 'sizes are UTF-8 BYTES — what the caps count — not characters');
  });
});

// ── The defect itself: five different failures must produce five different codes ────────

test('READ failures are distinguishable: 404 / 401 / 403 / 500 / 400 / dead socket each map to their OWN code', async () => {
  await withServer(async ({ R }) => {
    const miss = await R.relayCall('/missing', undefined, 'text', 'text');
    const auth = await R.relayCall('/unauth', undefined, 'text', 'text');
    const forb = await R.relayCall('/forbidden', undefined, 'text', 'text');
    const boom = await R.relayCall('/boom', undefined, 'text', 'text');
    const bad = await R.relayCall('/refused', undefined, 'text', 'text');
    const dead = await R.relayCall('/dead', undefined, 'text', 'text');

    assert.deepEqual(miss, { ok: false, code: 'not-found', status: 404, error: 'not found' });
    assert.equal(auth.code, 'unauthorized'); assert.equal(auth.status, 401);
    assert.equal(forb.code, 'unauthorized'); assert.equal(forb.status, 403);
    assert.equal(boom.code, 'server-error'); assert.equal(boom.status, 500);
    assert.equal(bad.code, 'bad-request'); assert.equal(bad.status, 400);
    assert.equal(dead.code, 'network');
    assert.match(dead.error, /网络不可达 · network unreachable/);
    assert.equal(dead.status, undefined, 'a request that never reached the server has no status to report');

    // THE property that stops the data loss: exactly ONE of these means "there is nothing
    // there". Before this change all six answered {ok:false,error:'not found'}.
    const all = [miss, auth, forb, boom, bad, dead];
    assert.ok(all.every((x) => x.ok === false), 'every one of them is a failure');
    assert.equal(all.filter((x) => x.code === 'not-found').length, 1, 'ONLY the 404 may say not-found');
    assert.equal(new Set(all.map((x) => x.code)).size, 5, '404/401+403/500/400/dead → five distinct codes');
    // Every failure carries a reason a human can read (R5) — none is a bare {ok:false}.
    assert.ok(all.every((x) => typeof x.error === 'string' && x.error.length > 0));
  });
});

test('a file that IS there still reads back verbatim — the mapper did not break the success path', async () => {
  await withServer(async ({ R }) => {
    assert.deepEqual(await R.relayCall('/found', undefined, 'text', 'text'), { ok: true, text: 'the notebook bytes' });
    assert.deepEqual(await R.relayCall('/json', undefined, 'json', 'data'), { ok: true, data: { convos: [{ id: 'c1' }], ok: true } });
    assert.deepEqual(await R.relayCall('/json', undefined, 'raw'), { convos: [{ id: 'c1' }], ok: true });
    assert.deepEqual(await R.relayCall('/found', undefined, 'none'), { ok: true });
  });
});

test('a 2xx whose body will not parse is a SERVER error, never "not found"', async () => {
  await withServer(async ({ R }) => {
    const g = await R.relayCall('/truncated', undefined, 'json', 'data');
    assert.equal(g.ok, false);
    assert.equal(g.code, 'server-error', 'a malformed answer must not be read as an absent file');
    assert.equal(g.status, 200);
  });
});

test('a 200 {ok:false} from /api/ask is relayed verbatim AND given a code — no code-less failure reaches an app', async () => {
  await withServer(async ({ R }) => {
    const g = await R.relayCall('/ask-failed', undefined, 'raw');
    assert.equal(g.ok, false);
    assert.equal(g.text, 'the agent crashed', 'the server\'s own payload survives');
    assert.equal(g.code, 'server-error');
  });
});

// ── The WRITE path: 413 carries the cap that rejected it ────────────────────────────────

test('save relay: an oversize notebook maps to code "too-large" WITH the real limit — not a generic failure', async () => {
  await withServer(async ({ R, state }) => {
    const body = JSON.stringify({ path: 'entry-a.json', data: oversize(BODY_LIMITS.appData) });
    const g = await R.relayCall('/api/save-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body }, 'raw');
    assert.equal(g.ok, false);
    assert.equal(g.code, 'too-large', 'retrying can never help — the app must be able to tell this from "server down"');
    assert.equal(g.status, 413);
    assert.equal(g.limit, BODY_LIMITS.appData, 'the cap travels with the rejection');
    assert.equal(state.saved, null, 'nothing was written');
    // The distinguishing property again, on the write side: a 500 and a 413 are NOT the
    // same outcome — one is worth retrying, the other never is.
    const down = await R.relayCall('/boom', { method: 'POST' }, 'raw');
    assert.equal(down.code, 'server-error');
    assert.notEqual(down.code, g.code);
  });
});

test('save relay: a successful write relays the server\'s size telemetry verbatim (bytes/prevBytes/shrank)', async () => {
  await withServer(async ({ R }) => {
    const body = JSON.stringify({ path: 'entry-a.json', data: JSON.stringify({ v: 2, pages: [] }) });
    const g = await R.relayCall('/api/save-data', { method: 'POST', headers: { 'content-type': 'application/json' }, body }, 'raw');
    assert.deepEqual(g, { ok: true, bytes: 164, prevBytes: 47076, shrank: true },
      'shrank/bytes must reach the app — a mapper that rebuilt {ok:true} would drop the only honest shrink report there is');
  });
});

// ── V4: the shell's own chat, where an oversize send used to be structurally invisible ──

// The shell's streaming loop, verbatim in behaviour: split on '\n', parse each line, skip
// what will not parse. Returns what the loop would actually have shown the user.
async function ndjsonLoop(res) {
  const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; const events = [];
  let threw = false;
  try {
    for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { const t = buf.slice(0, i); buf = buf.slice(i + 1); if (!t.trim()) continue; try { events.push(JSON.parse(t)); } catch { /* the loop's own skip */ } } }
  } catch { threw = true; }
  return { events, threw, unparsed: buf };
}

test('chat: an oversize 413 is now NDJSON-readable (server side), and a 401 still is NOT — which is why res.ok must be checked', async () => {
  await withServer(async ({ base }) => {
    // (a) The oversize case, as the server answers it TODAY: lib/webutil.mjs terminates the
    //     error body with '\n' and tags it type:'error', so the loop does parse it.
    const big = await fetch(base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: oversize(BODY_LIMITS.chat) }),
    });
    assert.equal(big.status, 413);
    const a = await ndjsonLoop(big);
    assert.equal(a.events.length, 1, 'the 413 arrives as one NDJSON line');
    assert.equal(a.events[0].type, 'error');
    assert.equal(a.events[0].limit, BODY_LIMITS.chat);

    // (b) The case that is STILL structurally invisible without a res.ok check: web.mjs's
    //     auth gate (web.mjs:692) answers 401 {"error":"bad token"} — plain JSON, no
    //     trailing newline, no `type`. The loop parses nothing, nothing throws, so the
    //     catch that says "connection lost" never runs and the '…' pill stays forever.
    //     Same for any proxy/gateway error page in front of the server.
    const auth = await fetch(base + '/unauth');
    const b = await ndjsonLoop(auth);
    assert.equal(b.events.length, 0, 'no line is ever parsed');
    assert.equal(b.threw, false, 'and nothing throws — the failure is silent');
    assert.ok(b.unparsed.length > 0, 'the error body was received and silently discarded');
    assert.equal(auth.ok, false, 'the ONE signal that is always present: res.ok');
  });
});

test('chat 413: the shell maps it to a bilingual "消息过长 · Message too large" WITH the limit and the real size', async () => {
  await withServer(async ({ base, R }) => {
    const body = JSON.stringify({ message: oversize(BODY_LIMITS.chat) });
    const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.ok, false, 'the check the shell now performs BEFORE reading the stream');
    const f = await R.relayHttpFail(res);
    assert.equal(f.code, 'too-large');
    assert.equal(f.code, CODE_TOO_LARGE, 'ONE vocabulary across the boundary: the code an app sees is the code the server sends (R3)');
    assert.equal(f.limit, BODY_LIMITS.chat);
    const shown = R.relayText(f, R.relayBodyBytes(body));
    assert.match(shown, /Message too large/, 'English half');
    assert.match(shown, /消息过长/, '中文 half');
    // ROUND 3: the cap is written the way the SERVER writes it (humanBytes → "1 MB"). The
    // shell used to print "1.0 MB" for the same number the 413 body called "1 MB", so the
    // two halves of one refusal disagreed about the limit in front of the user.
    assert.match(shown, new RegExp(`max ${humanBytes(BODY_LIMITS.chat)}`), 'the cap is named, so the user knows what to cut');
    assert.match(shown, /1 MB sent/, 'and so is what was actually sent');
    assert.match(shown, /请缩短内容或删除附件后重发/, 'it says what to DO next, bilingually');
    // A 413 must not read like a crash, and a crash must not read like a size problem.
    const down = R.relayText({ ok: false, code: 'server-error', status: 500 });
    assert.doesNotMatch(down, /too large|过长/);
    assert.match(down, /服务器错误/);
    const off = R.relayText({ ok: false, code: 'network' });
    assert.match(off, /未发出 · it never left this device/, 'a network failure says the message was NOT sent');
  });
});

test('the upload surface reuses the SAME mapper with a file-shaped heading (R3: one mapping, two headings)', async () => {
  await withServer(async ({ R }) => {
    const shown = R.relayText({ ok: false, code: 'too-large', limit: BODY_LIMITS.upload }, 1024, R.RELAY_TOO_LARGE_FILE);
    assert.match(shown, /文件过大 · File too large/);
    assert.match(shown, new RegExp(`max ${humanBytes(BODY_LIMITS.upload)}`));
  });
});

// ── R3 audit: EVERY broker kind must go through the one mapper ──────────────────────────
// The broker itself needs a DOM (postMessage, the iframe), so its wiring is pinned in the
// source. These assertions are what stop a new kind from re-introducing the conflation.

test('R3: no broker kind maps HTTP statuses itself — the old "r.ok ? … : {ok:false}" conflation is gone', () => {
  const from = SHELL.indexOf("/* ── Broker (for sandboxed apps) ── */");
  const to = SHELL.indexOf("/* ── Chat log helpers ── */");
  assert.ok(from > 0 && to > from, 'the broker block must stay findable');
  const broker = codeOnly(SHELL.slice(from, to));
  assert.ok(broker.includes("m.kind==='data'") && broker.includes("m.kind==='save-data'"), 'the slice really contains the broker');
  // The exact shape that made a 401 look like an absent file.
  assert.ok(!broker.includes("{ok:false,error:'not found'}"), 'no kind may answer a bare "not found" again');
  // A kind that tests r.ok itself is a kind that is NOT using the shared mapper.
  const adhoc = [...broker.matchAll(/\br\.ok\s*\?/g)];
  assert.equal(adhoc.length, 0, `every kind must answer through relayCall/relayHttpFail (found ${adhoc.length} ad-hoc r.ok mappings)`);
  assert.equal([...broker.matchAll(/reply\(\{ok:false\}\)/g)].length, 0, 'no bare {ok:false} — a failure without a code is unreadable to an app (R5)');
  // Every failure reply in the broker carries a code.
  for (const m of broker.matchAll(/\{ok:false,(.{0,24})/g)) {
    assert.match(m[1], /^code:/, `a failure reply without a code: {ok:false,${m[1]}…`);
  }
  // The catch-all cannot be a silent swallow, and cannot claim absence.
  assert.match(broker, /code:'relay-error'/, 'the catch-all answers relay-error, never not-found (R5)');
});

test('R6 wiring: the shell chat checks res.ok BEFORE reading the stream, and puts the refused message back', () => {
  const send = codeOnly(SHELL.slice(SHELL.indexOf('async function submitSend()'), SHELL.indexOf("$('#f').onsubmit")));
  const okCheck = send.indexOf('if(!res.ok)');
  const reader = send.indexOf('res.body.getReader()');
  assert.ok(okCheck > 0 && reader > okCheck, 'a non-2xx must be handled BEFORE the NDJSON loop swallows it');
  assert.match(send, /status\.remove\(\);\s*userEl\.remove\(\);/, 'the "…" pill and the echoed bubble are removed');
  assert.match(send, /add\('err','⚠ '\+relayText\(f,sentBytes\)\)/, 'the message lands in the chat UI\'s error position (.msg.err), like a stream error event');
  assert.match(send, /restoreComposer\(q,attsBefore\)/, 'the typed text and its attachments come back');
  // …and the app-facing chat relay does the same (V4 secondary).
  const relay = codeOnly(SHELL.slice(SHELL.indexOf("} else if(m.kind==='chat'){"), SHELL.indexOf("} else if(m.kind==='convo'){")));
  assert.ok(relay.indexOf('if(!res.ok) return fail(') > 0 && relay.indexOf('if(!res.ok) return fail(') < relay.indexOf('getReader()'));
  assert.match(relay, /type:'delta'/, 'PAChat only renders convo/status/delta/done — the failure arrives as text it actually paints');
});
