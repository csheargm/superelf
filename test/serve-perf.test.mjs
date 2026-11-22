// Every response was served RAW. The shell is 182KB and an app page with PANote inlined is 347KB,
// so opening the app on a phone over Tailscale re-downloaded a third of a megabyte every time —
// while the server itself answered in ~4ms. Two things fix that, and both are easy to lose:
// compression (65% smaller), and an ETag so a return visit revalidates instead of re-downloading
// (measured in a real browser: 182,533 bytes -> 300).
//
// The hazard to guard is the OTHER direction: the chat's NDJSON stream must never be buffered or
// compressed, or the reply stops arriving token by token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
let port, root, web;

before(async () => { port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port); });
after(async () => { if (web) await stopWeb(web); });

const get = (p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...headers } });

test('a big page is compressed when asked, and decompresses to the SAME bytes', async () => {
  // node's fetch sends `accept-encoding: gzip, deflate` on its own, so "no compression" has to be
  // asked for explicitly or this measures the default rather than the server.
  const plain = await get('/', { 'accept-encoding': 'identity' });
  const raw = Buffer.from(await plain.arrayBuffer());
  assert.equal(plain.headers.get('content-encoding'), null, 'never compressed unless the client asks');
  assert.ok(raw.length > 50000, `the shell is large enough for this to matter: ${raw.length}`);

  const zipped = await get('/', { 'accept-encoding': 'gzip' });
  assert.equal(zipped.headers.get('content-encoding'), 'gzip');
  const body = Buffer.from(await zipped.arrayBuffer());   // fetch decodes for us
  assert.deepEqual(body, raw, 'compression must be lossless — byte-identical after decoding');
});

test('the saving is real, not a rounding error', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'web', 'index.html'));
  const ratio = zlib.gzipSync(shell, { level: 6 }).length / shell.length;
  assert.ok(ratio < 0.5, `gzip must actually pay for itself, got ${(ratio * 100).toFixed(0)}%`);
});

test('tiny responses are left alone — the gzip header would cost more than it saves', async () => {
  const r = await get('/api/setup-status', { 'accept-encoding': 'gzip' });
  const body = await r.text();
  assert.ok(body.length < 1024, `precondition: this endpoint is small (${body.length})`);
  assert.equal(r.headers.get('content-encoding'), null, 'a 20-byte body must not be gzipped');
});

test('Vary is set whether or not the branch compressed — a cache must not cross the streams', async () => {
  for (const h of [{ 'accept-encoding': 'identity' }, { 'accept-encoding': 'gzip' }]) {
    const r = await get('/api/setup-status', h);
    assert.equal(r.headers.get('vary'), 'accept-encoding', 'compressible responses always Vary');
  }
});

test('a return visit revalidates to 304 with an empty body', async () => {
  const first = await get('/');
  const etag = first.headers.get('etag');
  assert.ok(etag, 'the page must carry an ETag or there is nothing to revalidate against');
  assert.equal(first.headers.get('cache-control'), 'no-cache', 'revalidate every time, but cheaply');

  const again = await get('/', { 'if-none-match': etag });
  assert.equal(again.status, 304);
  assert.equal((await again.text()).length, 0, 'a 304 must carry no body — that is the whole point');

  const stale = await get('/', { 'if-none-match': '"something-else"' });
  assert.equal(stale.status, 200, 'a stale validator must get the real page');
  assert.ok((await stale.text()).length > 50000);
});

test('the ETag tracks the CONTENT — an edited page is not served from a stale cache', () => {
  // NOT by editing web/index.html. mkWebRoot SYMLINKS web/ to the real repo directory, so a
  // test that "edits its own copy" is editing the actual source: parallel tests then read it
  // mid-edit (this broke test/shell-compose.test.mjs), and a crash before the restore would
  // leave the working tree modified. The property under test is the derivation, so test that.
  const etag = (html) => '"' + crypto.createHash('sha1').update(html).digest('base64url').slice(0, 27) + '"';
  const a = readShell(ROOT);
  assert.equal(etag(a), etag(a), 'same bytes, same validator — a return visit must revalidate to 304');
  assert.notEqual(etag(a), etag(a.replace('<body', '<body data-x="1"')), 'one changed byte changes it');
  assert.notEqual(etag(a), etag(a + ' '), 'even trailing whitespace');
  // And the server derives it the same way — one definition, not two.
  assert.match(WEB, /crypto\.createHash\('sha1'\)\.update\(html\)\.digest\('base64url'\)\.slice\(0, 27\)/,
    'the server must derive the ETag from the page bytes');
});

test('a test must never mutate the real web/ — it is symlinked, not copied', () => {
  // The trap that caused the above. Pinned so the next person does not re-learn it.
  const helpers = fs.readFileSync(path.join(ROOT, 'test', 'helpers-web.mjs'), 'utf8');
  assert.match(helpers, /symlinkSync\(path\.join\(REPO, d\)/, 'web/ and lib/ are symlinks into the repo');
  const self = fs.readFileSync(path.join(ROOT, 'test', 'serve-perf.test.mjs'), 'utf8');
  assert.ok(!/writeFileSync\(\s*(f|path\.join\(root, 'web')/.test(self),
    'this file must not write into a test root\'s web/ — that IS the repo');
});

test('the NDJSON chat stream can never be buffered or compressed', () => {
  // Structural, not behavioural: the stream writes its head directly and never reaches send(),
  // which is the only place compression happens. If someone routes it through send() one day,
  // the reply stops arriving token by token — this is the tripwire for that.
  assert.match(WEB, /const CHAT_HEAD = \{ 'content-type': 'application\/x-ndjson'/, 'the stream head is NDJSON (one constant, R3)');
  assert.match(WEB, /res\.writeHead\(200, CHAT_HEAD\)/,
    'the stream must keep writing its own head, outside send()');
  const streamStart = WEB.indexOf("'application/x-ndjson'");
  const fn = WEB.slice(WEB.lastIndexOf('async function', streamStart), streamStart);
  assert.ok(!/\bsend\(res,/.test(fn.slice(-400)), 'nothing in the stream path may hand the response to send()');
  assert.match(WEB, /const line = \(o\) => \{ if \(alive\(\)\) res\.write\(/, 'lines are written incrementally');
});

test('compression is limited to text — never a second pass over encoded bytes', () => {
  assert.match(WEB, /const COMPRESSIBLE = /, 'the allowed types are named in one place');
  const re = new Function(`return ${WEB.match(/const COMPRESSIBLE = (\/.*\/);/)[1]}`)();
  for (const t of ['text/html; charset=utf-8', 'application/json', 'image/svg+xml']) assert.ok(re.test(t), `${t} should compress`);
  for (const t of ['image/png', 'image/jpeg', 'application/octet-stream', 'video/mp4']) assert.ok(!re.test(t), `${t} must NOT be recompressed`);
  assert.match(WEB, /const already = Object\.keys\(head\)\.some\(\(k\) => k\.toLowerCase\(\) === 'content-encoding'\)/,
    'a route that already set an encoding must be left alone');
});
