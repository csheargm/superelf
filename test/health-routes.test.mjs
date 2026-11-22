// HTTP-level integration tests for the health routes (R6, PLAN.md "Health
// review leftovers"): the REAL web.mjs answering real HTTP — auth, v1 + v2
// ingest, the payload cap actually DELIVERING its 413 (the readBody drain
// contract end-to-end), the GET /api/health read-back contract, the
// /api/health/setup URL derivation with and without cfg.public_base_url, and
// the meals ingest auth gate. Unit suites prove the pieces; this proves the
// user flow: what the iPhone Shortcut and the profile page actually hit.
// Throwaway roots + ephemeral ports only (test/helpers-web.mjs) — never the
// live node, never port 8787.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { MAX_BODY_BYTES } from '../lib/health.mjs';
import { CODE_TOO_LARGE } from '../lib/webutil.mjs';
import { localDateStr } from '../lib/schedule.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const PUBLIC_BASE = 'http://mybook.tailnet.ts.net:8443';
let portA, portB, rootA, rootB, webA, webB;

before(async () => {
  [portA, portB] = [await freePort(), await freePort()];
  rootA = mkWebRoot({ port: portA });                                            // Host-header derivation
  rootB = mkWebRoot({ port: portB, extraConfig: { public_base_url: PUBLIC_BASE } }); // configured base wins
  webA = startWeb(rootA); webB = startWeb(rootB);
  await waitReady(portA); await waitReady(portB);
});
after(async () => {
  await stopWeb(webA); await stopWeb(webB);
  for (const r of [rootA, rootB]) rmTemp(r);
});

test('auth: health + meals ingest and health reads all refuse a missing or wrong token', async () => {
  for (const [method, p, body] of [
    ['POST', '/api/health/ingest', '{"steps":1}'],
    ['POST', '/api/meals/ingest', '{"photo":"x"}'],
    ['GET', '/api/health', undefined],
    ['GET', '/api/health/setup', undefined],
  ]) {
    const bare = await fetch(`http://127.0.0.1:${portA}${p}`, { method, body });
    assert.equal(bare.status, 401, `${p}: no token → 401`);
    const wrong = await fetch(`http://127.0.0.1:${portA}${p}`, { method, body, headers: { authorization: 'Bearer wrong-token-000000000000000000' } });
    assert.equal(wrong.status, 401, `${p}: wrong token → 401`);
  }
});

test('v1 ingest → GET /api/health read-back contract (the Shortcut flow)', async () => {
  const r = await api(portA, '/api/health/ingest', { method: 'POST', body: JSON.stringify({ date: '2026-08-01', steps: 1234, weight: 70.5 }) });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.ok, true);
  assert.equal(out.date, '2026-08-01');
  const read = await api(portA, '/api/health?days=120');
  assert.equal(read.status, 200);
  const rows = await read.json();
  assert.ok(Array.isArray(rows), 'contract: an array of day rows');
  const row = rows.find((x) => x.date === '2026-08-01');
  assert.ok(row, 'ingested day present');
  assert.equal(row.steps, 1234);
  assert.equal(row.weight, 70.5);
});

test('v2 ingest: samples stored, byte-identical retry counted as duplicates (idempotent upload)', async () => {
  const payload = { schema: 'health.v2', source: 'test-shortcut', metrics: [
    { metric: 'steps', unit: 'count', samples: [
      { ts: '2026-08-02T10:00:00Z', value: 500 }, { ts: '2026-08-02T12:00:00Z', value: 700 }] },
  ] };
  const first = await (await api(portA, '/api/health/ingest', { method: 'POST', body: JSON.stringify(payload) })).json();
  assert.equal(first.ok, true);
  assert.equal(first.added, 2);
  const retry = await (await api(portA, '/api/health/ingest', { method: 'POST', body: JSON.stringify(payload) })).json();
  assert.equal(retry.added, 0, 'retried upload adds nothing');
  assert.equal(retry.duplicates, 2, 'both samples recognized');
  const day = localDateStr(new Date('2026-08-02T12:00:00Z')); // same bucketing the server applies
  const rows = await (await api(portA, '/api/health?days=120')).json();
  assert.equal(rows.find((x) => x.date === day)?.steps, 1200, 'rollup sums the day');
});

// The silent-drop fix, at the layer the caller actually sees. A partial store
// used to come back as `200 ok:true` with the loss visible nowhere, so a phone
// (or the health app about to be built on this path) read a truncated backfill
// as a complete one. Both halves are checked in ONE flow so the CONTROL is real
// (R14): the same server, the same route, one payload clean and one partial.
test('partial store → 207 ok:false with stored/dropped; a clean one still → 200 ok:true', async () => {
  const clean = await api(portA, '/api/health/ingest', { method: 'POST', body: JSON.stringify({
    schema: 'health.v2', source: 'drop-test', metrics: [
      { metric: 'steps', unit: 'count', samples: [{ ts: '2026-08-05T10:00:00Z', value: 300 }] }] }) });
  assert.equal(clean.status, 200, 'CONTROL: nothing dropped is still a plain 200');
  const cj = await clean.json();
  assert.equal(cj.ok, true);
  assert.equal(cj.dropped, 0);
  assert.equal(cj.stored, 1);

  const partial = await api(portA, '/api/health/ingest', { method: 'POST', body: JSON.stringify({
    schema: 'health.v2', source: 'drop-test', metrics: [
      { metric: 'steps', unit: 'count', samples: [{ ts: '2026-08-06T10:00:00Z', value: 400 }] },
      { metric: 'glucose', unit: 'mg/dL', samples: [{ ts: '2026-08-06T11:00:00Z', value: 5 }, { ts: '2026-08-06T12:00:00Z', value: 6 }] }] }) });
  assert.equal(partial.status, 207, 'a partial write must not answer with a 2xx anyone reads as clean');
  const pj = await partial.json();
  assert.equal(pj.ok, false, 'ok means "everything you sent is on disk" — nothing weaker');
  assert.equal(pj.stored, 1);
  assert.equal(pj.dropped, 2, 'the caller is told HOW MUCH it lost');
  assert.equal(pj.rejected.find((x) => x.metric === 'glucose').samples, 2);
  // The good metric really did land — partial means partial, not "refused".
  const rows = await (await api(portA, '/api/health?days=120')).json();
  assert.equal(rows.find((x) => x.date === '2026-08-06')?.steps, 400);
});

test('v2 with only unknown metrics → 400, nothing stored, rejects named', async () => {
  const r = await api(portA, '/api/health/ingest', { method: 'POST',
    body: JSON.stringify({ schema: 'health.v2', metrics: [{ metric: 'glucose', samples: [{ ts: '2026-08-02T10:00:00Z', value: 5 }] }] }) });
  assert.equal(r.status, 400, 'nothing usable → honest 400');
  const out = await r.json();
  assert.equal(out.ok, false);
  assert.ok(out.rejected.some((x) => x.metric === 'glucose'), 'the rejected metric is named');
});

test('payload cap: an oversized body gets the documented 413 DELIVERED (drain, not a socket reset)', async () => {
  const body = JSON.stringify({ schema: 'health.v2', pad: 'x'.repeat(MAX_BODY_BYTES) });
  assert.ok(body.length > MAX_BODY_BYTES, 'test payload really exceeds the cap');
  const r = await api(portA, '/api/health/ingest', { method: 'POST', body }); // throws on connection reset — the regression this guards
  assert.equal(r.status, 413);
  // Shape is the ONE body-error mapping (lib/webutil.mjs bodyErrorResponse):
  // machine-readable `code` + the limit that was exceeded, so a client can say
  // "too large" instead of guessing (the 2026-09-02 data-loss scar).
  // ONE shape for a size rejection on EVERY route (R3): the same `code` and the
  // same `limit` field the app-data and chat routes answer, so a client reacts
  // generically instead of learning each route's prose.
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.code, CODE_TOO_LARGE);
  assert.equal(j.limit, MAX_BODY_BYTES);
  assert.match(j.error, /内容过大/, 'bilingual, and it names the limit');
});

test('malformed JSON → 400, not a hang or a 500', async () => {
  const r = await api(portA, '/api/health/ingest', { method: 'POST', body: '{not json' });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.code, 'bad_json', 'parseable JSON error, never text/plain "error"');
});

test('setup WITHOUT public_base_url: ingest URL derives from the request Host header', async () => {
  const r = await api(portA, '/api/health/setup');
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.ok, true);
  assert.equal(out.url, `http://127.0.0.1:${portA}/api/health/ingest`, 'Host-derived base (the pre-fix behavior, kept as the default)');
  assert.equal(out.token, OWNER_TOKEN, 'the caller\'s own credential, never someone else\'s');
  // The QR was REMOVED (it encoded JSON containing a url, so iOS Camera offered to open it
  // and the unauthenticated GET answered "bad token"). Absence is now the contract.
  assert.ok(!('qr' in out), 'the setup reply must not carry a QR any more');
});

test('setup WITH public_base_url: the configured base WINS over Host (the localhost-QR scar)', async () => {
  const r = await api(portB, '/api/health/setup');
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.url, `${PUBLIC_BASE}/api/health/ingest`,
    'request arrived via 127.0.0.1 yet the QR encodes the reachable configured base');
  assert.equal(out.token, OWNER_TOKEN);
});
