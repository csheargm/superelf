// Compressed app-data writes（压缩写入）— the shell gzips, the server inflates, and the size cap
// is applied to what it INFLATES TO.
//
// WHY THE SECURITY HALF DOMINATES THIS FILE: accepting `content-encoding: gzip` on a route that
// writes files hands an attacker a multiplier. DEFLATE's ratio against repetitive input is around
// 1000:1, so ~600KB — comfortably inside every wire limit — inflates to ~600MB. A cap checked
// AFTER inflating is not a mitigation; it is the attack succeeding and then being reported. So
// the cap is enforced DURING inflation (lib/gzipbody.mjs), and the tests below prove it by
// counting the bytes the decompressor was allowed to hand over, not by trusting a status code.
//
// FIDELITY: no part of this is re-implemented. The server is a real node:http server using the
// repo's own readBody + BODY_LIMITS + saveAppData + bodyErrorResponse (test/helpers-app.mjs), and
// the client is the shell's OWN relayGzipBody, extracted from web/index.html and executed —
// including in a scope where CompressionStream does not exist, which is how the fallback is
// proved rather than assumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { BODY_LIMITS, CODE_TOO_LARGE } from '../lib/webutil.mjs';
import { createCappedGunzip, GZIP_OVER_LIMIT_CODE, GZIP_ENCODING } from '../lib/gzipbody.mjs';
import { startHarness } from './helpers-app.mjs';
import { loadRelayCore } from './helpers-shell-broker.mjs';

const CAP = BODY_LIMITS.appData;
const NOTE = 'entry-gz.json';

// ── The shell's own compressed-write path, extracted (helpers-shell-broker.mjs loadRelayCore) ──
// `env` lets a test run it with the capability MISSING or BROKEN — the two states a real iPad can
// be in — instead of asserting that a branch nobody executed would have worked. relayGzipBody sizes
// the body with RELAY-CORE's own relayBodyBytes, not a retyped one.
function shellGzip({ noCompressionStream = false, breakCompress = false } = {}) {
  const core = loadRelayCore(async () => {}, {
    CompressionStream: noCompressionStream ? undefined
      : (breakCompress ? class { constructor() { throw new Error('compression unavailable'); } } : CompressionStream),
  });
  const src = String(core.relayGzipBody);   // the function that runs below, as the shell wrote it
  assert.match(src, /typeof CompressionStream==='undefined'/, 'it is a capability check, not a version check');
  assert.match(src, /catch\(_\)\{ return \{headers:plain,body:text\}; \}/, 'and a throw falls back to the uncompressed request');
  return core;
}

test('R3: the shell and the server name the SAME encoding token', () => {
  assert.equal(shellGzip().RELAY_GZIP, GZIP_ENCODING, 'web/index.html RELAY_GZIP === lib/gzipbody.mjs GZIP_ENCODING');
});

// ── Fixtures at the density measured on live data (lib/appdata.mjs: 21.7 bytes/point) ────────
let pid = 0;
const stroke = (n, seed) => ({ c: '#141414', w: 0.004 + (seed % 5) / 1000,
  p: Array.from({ length: n }, (_, i) => [Math.round((0.11 + ((i * 7 + seed) % 800) / 1000) * 10000) / 10000, Math.round((0.2 + ((i * 13 + seed) % 900) / 1000) * 10000) / 10000, 0.5]) });
// The densest page measured on the live workspace: 42 strokes, 2919 points, 60.4KB.
const densePage = (seed) => ({ id: 'p' + (++pid), created: 1, updated: 2,
  strokes: Array.from({ length: 42 }, (_, i) => stroke(70, seed * 100 + i)), pageHtml: '', images: [] });
const denseNotebook = (pages = 10) => ({ v: 2, id: 'nb-dense', created: 1, updated: 2, template: 'ruled', bgColor: '#fdfdfb',
  pages: Array.from({ length: pages }, (_, i) => densePage(i)) });

const post = (port, headers, body) => fetch(`http://127.0.0.1:${port}/api/save-data`, { method: 'POST', headers, body });
const withHarness = async (fn) => { const h = await startHarness('notes'); try { await fn(h); } finally { await h.stop(); } };

// ═══ CONTROLS (R14) ══════════════════════════════════════════════════════════════════════════

test('control: the fixture is a REALISTIC stroke-heavy notebook, not a compressible toy', () => {
  const nb = denseNotebook(10);
  const text = JSON.stringify(nb);
  const points = nb.pages.reduce((a, p) => a + p.strokes.reduce((b, s) => b + s.p.length, 0), 0);
  const density = text.length / points;
  assert.ok(points > 25000, `enough points to be a real notebook: ${points}`);
  assert.ok(density > 15 && density < 30, `density ${density.toFixed(1)} B/point matches the 21.7 measured on live data`);
  assert.ok(text.length > 500 * 1024, `and a realistic size: ${(text.length / 1024).toFixed(0)}KB`);
});

test('control: an UNCOMPRESSED client still works unchanged (backward compatible)', async () => {
  await withHarness(async (h) => {
    const nb = denseNotebook(2);
    const r = await post(h.port, { 'content-type': 'application/json' }, JSON.stringify({ path: `data/notes/${NOTE}`, data: nb }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(h.file(NOTE), 'utf8')), nb);
  });
});

// ═══ ROUND TRIP + THE MEASURED RATIO ═════════════════════════════════════════════════════════

test('a gzipped write round-trips BYTE-IDENTICALLY through the real server', async (t) => {
  await withHarness(async (h) => {
    const { relayGzipBody } = shellGzip();
    const nb = denseNotebook(10);
    const body = JSON.stringify({ path: `data/notes/${NOTE}`, data: nb });
    const packed = await relayGzipBody(body);
    assert.equal(packed.headers['content-encoding'], GZIP_ENCODING, 'the shell really compressed it');

    const plainBytes = new TextEncoder().encode(body).length;
    const gzBytes = packed.body.byteLength;
    const ratio = plainBytes / gzBytes;
    t.diagnostic(`stroke-heavy notebook: ${(plainBytes / 1024).toFixed(0)}KB → ${(gzBytes / 1024).toFixed(0)}KB gzip (${ratio.toFixed(1)}x, ${(100 - (gzBytes / plainBytes) * 100).toFixed(1)}% smaller)`);
    assert.ok(ratio > 2, `compression must actually pay for itself, got ${ratio.toFixed(2)}x`);

    const r = await post(h.port, packed.headers, Buffer.from(packed.body));
    assert.equal(r.status, 200);
    // BYTE-identical: the server never re-serializes what an app sent (lib/appdata.mjs).
    assert.equal(fs.readFileSync(h.file(NOTE), 'utf8'), JSON.stringify(nb));
  });
});

test('a small write is sent uncompressed — below the threshold gzip costs more than it saves', async () => {
  const { relayGzipBody, RELAY_GZIP_MIN_BYTES } = shellGzip();
  const small = JSON.stringify({ path: 'x.json', data: { v: 2, pages: [] } });
  assert.ok(small.length < RELAY_GZIP_MIN_BYTES);
  const packed = await relayGzipBody(small);
  assert.equal(packed.headers['content-encoding'], undefined, 'no encoding header');
  assert.equal(packed.body, small, 'the exact string, untouched');
});

test('no CompressionStream (older iPadOS / WebView) → the uncompressed request, and it still saves', async () => {
  await withHarness(async (h) => {
    for (const env of [{ noCompressionStream: true }, { breakCompress: true }]) {
      const { relayGzipBody } = shellGzip(env);
      const nb = denseNotebook(1);
      const body = JSON.stringify({ path: `data/notes/${NOTE}`, data: nb });
      const packed = await relayGzipBody(body);
      assert.equal(packed.headers['content-encoding'], undefined, `${JSON.stringify(env)}: falls back to plain`);
      assert.equal(packed.body, body, 'byte-identical to what it would have sent before this change');
      const r = await post(h.port, packed.headers, packed.body);
      assert.equal(r.status, 200, 'and the save still lands');
      assert.deepEqual(JSON.parse(fs.readFileSync(h.file(NOTE), 'utf8')), nb);
    }
  });
});

// ═══ THE ZIP BOMB ════════════════════════════════════════════════════════════════════════════

// Built by STREAMING into gzip so the test itself never holds the inflated payload — the same
// discipline the server is being tested for. Valid JSON on the inside, so a server that failed to
// cap would happily parse it and try to write the whole thing to disk: the failure mode is real,
// not a parse error standing in for a size check.
function zipBomb(inflatedMB) {
  const gz = zlib.createGzip();
  const out = [];
  gz.on('data', (c) => out.push(c));
  const megabyte = Buffer.alloc(1024 * 1024, 0x41);          // 1MB of 'A'
  gz.write(Buffer.from('{"path":"data/notes/bomb.json","data":"'));
  for (let i = 0; i < inflatedMB; i++) gz.write(megabyte);
  gz.write(Buffer.from('"}'));
  return new Promise((res) => { gz.end(); gz.on('end', () => res(Buffer.concat(out))); gz.resume(); });
}

test('zip bomb: a few hundred KB that inflates to 512MB is refused — and never buffered', async (t) => {
  const bomb = await zipBomb(512);
  t.diagnostic(`bomb: ${(bomb.length / 1024).toFixed(0)}KB compressed → 512MB inflated (${Math.round((512 * 1024 * 1024) / bomb.length)}:1)`);
  assert.ok(bomb.length < CAP, 'it passes the WIRE cap — which is exactly why the wire cap is not the defence');

  // 1. The decompressor itself: how many bytes was the caller ever handed? This is the property,
  //    measured directly. A status code alone would not distinguish "capped during" from
  //    "inflated 512MB into memory, then refused".
  let delivered = 0;
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  await new Promise((res) => {
    const gz = createCappedGunzip(CAP, (c) => { delivered += c.length; });
    gz.on('error', (e) => { assert.equal(e.code, GZIP_OVER_LIMIT_CODE, 'refused as a size rejection, not a corrupt body'); res(); });
    gz.on('end', () => { assert.fail('DEFECT: the bomb inflated to completion'); });
    gz.end(bomb);
  });
  const grew = process.memoryUsage().rss - rss0;
  assert.ok(delivered <= CAP, `nothing past the cap was ever handed over: ${delivered} <= ${CAP}`);
  assert.ok(Date.now() - t0 < 5000, 'and it aborted early rather than inflating 512MB');
  assert.ok(grew < 64 * 1024 * 1024, `resident memory barely moved: ${(grew / 1024 / 1024).toFixed(1)}MB (512MB would have been the alternative)`);

  // 2. End to end through the real route: 413 with the real limit, nothing written.
  await withHarness(async (h) => {
    const r = await post(h.port, { 'content-type': 'application/json', 'content-encoding': GZIP_ENCODING }, bomb);
    assert.equal(r.status, 413, 'the same refusal an honestly oversized notebook earns');
    const j = await r.json();
    assert.equal(j.code, CODE_TOO_LARGE);
    assert.equal(j.limit, CAP, 'and it names the cap, so a client knows retrying will not help');
    assert.equal(fs.existsSync(h.file('bomb.json')), false, 'nothing reached the disk');
    assert.equal(h.state.puts.length, 0, 'the route body never even parsed');
  });
});

test('an honestly oversized gzipped notebook is refused the same way (the cap is on the CONTENT)', async () => {
  await withHarness(async (h) => {
    // Real-shaped, incompressible-ish payload just over the cap once inflated.
    const filler = Array.from({ length: 40 }, (_, i) => stroke(4000, i * 977));
    let big = { path: `data/notes/${NOTE}`, data: { v: 2, id: 'nb', pages: [{ id: 'p0', strokes: filler, pageHtml: '', images: [] }] } };
    let text = JSON.stringify(big);
    while (text.length <= CAP) { big.data.pages.push({ id: 'p' + big.data.pages.length, strokes: filler, pageHtml: '', images: [] }); text = JSON.stringify(big); }
    const packed = zlib.gzipSync(Buffer.from(text));
    assert.ok(text.length > CAP && packed.length < CAP, 'compressed under the wire cap, inflated over it');
    const r = await post(h.port, { 'content-type': 'application/json', 'content-encoding': GZIP_ENCODING }, packed);
    assert.equal(r.status, 413);
    assert.equal((await r.json()).code, CODE_TOO_LARGE);
    assert.equal(fs.existsSync(h.file(NOTE)), false);
  });
});

test('a refused gzipped save tells the user its UNCOMPRESSED size, as the shell does', async () => {
  // The shell's save-data hands reply() relayBodyBytes(body), the size before gzip: that is what the
  // cap counts. The test relay runs the shell's whole broker (helpers-shell-broker.mjs).
  await withHarness(async (h) => {
    const r = await h.relay({ kind: 'save-data', path: NOTE, data: { pad: 'x'.repeat(CAP) } });
    assert.deepEqual(h.state.encodings, [GZIP_ENCODING], 'the request crossed the wire gzipped');
    assert.equal(r.code, 'too-large');
    assert.match(r.text, /^Note too large · 笔记过大 \(max [\d.]+ MB\) — [\d.]+ MB sent · 已发送\./,
      'MBs, not the few KB that crossed the wire');
  });
});

test('a notebook that fits is still accepted when gzip makes it LOOK small (no false refusal)', async () => {
  await withHarness(async (h) => {
    const nb = denseNotebook(40);                             // ~2.5MB of JSON — big, but legal
    const text = JSON.stringify({ path: `data/notes/${NOTE}`, data: nb });
    assert.ok(text.length < CAP);
    const r = await post(h.port, { 'content-type': 'application/json', 'content-encoding': GZIP_ENCODING }, zlib.gzipSync(Buffer.from(text)));
    assert.equal(r.status, 200, 'the cap refuses what is too big, not everything that arrives compressed');
    assert.deepEqual(JSON.parse(fs.readFileSync(h.file(NOTE), 'utf8')), nb);
  });
});

// ═══ MALFORMED AND UNSUPPORTED ENCODINGS ═════════════════════════════════════════════════════

test('a malformed gzip body is a 400 bad_encoding — never a silent partial write', async () => {
  await withHarness(async (h) => {
    const junk = Buffer.concat([zlib.gzipSync(Buffer.from('{"path":"data/notes/x.json","data":{}}')).subarray(0, 20), Buffer.from('not gzip at all')]);
    const r = await post(h.port, { 'content-type': 'application/json', 'content-encoding': GZIP_ENCODING }, junk);
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.code, 'bad_encoding');
    assert.notEqual(j.code, CODE_TOO_LARGE, 'a client must not react by splitting its payload — the headers are the problem');
    assert.equal(fs.existsSync(h.file('x.json')), false);
  });
});

test('an encoding we do not implement is refused by name, not treated as plain bytes', async () => {
  await withHarness(async (h) => {
    const r = await post(h.port, { 'content-type': 'application/json', 'content-encoding': 'br' }, JSON.stringify({ path: 'data/notes/x.json', data: {} }));
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.code, 'bad_encoding');
    assert.match(j.error, /unsupported content-encoding/);
  });
});

test('content-encoding: identity is plain (the header is not a trap)', async () => {
  await withHarness(async (h) => {
    const nb = denseNotebook(1);
    const r = await post(h.port, { 'content-type': 'application/json', 'content-encoding': 'identity' }, JSON.stringify({ path: `data/notes/${NOTE}`, data: nb }));
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(h.file(NOTE), 'utf8')), nb);
  });
});

// ═══ MUTATION — the cap must be enforced DURING inflation, not after ══════════════════════════

test('MUTATION: capping after inflation instead of during it buffers the whole bomb', async () => {
  const bomb = await zipBomb(64);                             // 64MB is enough to make the point without a slow test
  // The "check afterwards" implementation, written out so the difference is visible: it collects
  // everything zlib produces and only then compares. It answers the same refusal — after having
  // held 64MB (512MB in the test above) it was supposed to refuse.
  const after = await new Promise((res) => {
    const chunks = []; let n = 0;
    const gz = zlib.createGunzip();
    gz.on('data', (c) => { chunks.push(c); n += c.length; });
    gz.on('end', () => res({ n, refused: n > CAP }));
    gz.end(bomb);
  });
  assert.equal(after.refused, true, 'it does eventually say no…');
  assert.ok(after.n > CAP * 4, `…having first inflated ${(after.n / 1024 / 1024).toFixed(0)}MB into memory — DEFECT`);

  let delivered = 0;
  await new Promise((res) => {
    const gz = createCappedGunzip(CAP, (c) => { delivered += c.length; });
    gz.on('error', () => res());
    gz.end(bomb);
  });
  assert.ok(delivered <= CAP, `the shipped one stopped at ${(delivered / 1024 / 1024).toFixed(1)}MB`);
  assert.ok(delivered < after.n, 'strictly less than the after-the-fact version ever held');
});
