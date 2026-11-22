import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { needPerms } from './helpers-platform.mjs';
import { safeJoin, slugOk, tokenOk, sanitizeLine } from '../lib/webutil.mjs';

const base = path.resolve('/tmp/pa-base');

test('safeJoin allows normal relative paths', () => {
  assert.equal(safeJoin(base, 'tasks.md'), path.join(base, 'tasks.md'));
  assert.equal(safeJoin(base, 'memory/MEMORY.md'), path.join(base, 'memory/MEMORY.md'));
});

test('safeJoin blocks traversal, absolute, encoded and null-byte paths', () => {
  assert.equal(safeJoin(base, '../secrets'), null);
  assert.equal(safeJoin(base, 'a/../../x'), null);
  assert.equal(safeJoin(base, '/etc/passwd'), null);
  assert.equal(safeJoin(base, '%2e%2e/config.json'), null);
  assert.equal(safeJoin(base, 'a%00.html'), null);
  assert.equal(safeJoin(base, ''), null);
});

test('slug validation', () => {
  assert.ok(slugOk('weekly-steps'));
  assert.ok(slugOk('bible2'));
  assert.ok(!slugOk('Bad Name'));
  assert.ok(!slugOk('../x'));
  assert.ok(!slugOk('-lead'));
  assert.ok(!slugOk('a'.repeat(41)));
});

test('token compare is strict', () => {
  assert.ok(tokenOk('abc123', 'abc123'));
  assert.ok(!tokenOk('abc124', 'abc123'));
  assert.ok(!tokenOk('', ''));
  assert.ok(!tokenOk(null, 'abc'));
  assert.ok(!tokenOk('ab', 'abc'));
});

import { dataContentType, writeJsonFile, readJson } from '../lib/webutil.mjs';
import fs from 'node:fs';
import os from 'node:os';

test('writeJsonFile: atomic tmp+rename — target is valid JSON, no tmp litter, dirs auto-created', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-wj-'));
  const f = path.join(d, 'deep', 'store.json');
  writeJsonFile(f, { a: 1 });
  writeJsonFile(f, { a: 2, b: [1, 2] });
  assert.deepEqual(readJson(f, null), { a: 2, b: [1, 2] });
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['store.json'], 'no .tmp files left behind');
});

test('dataContentType never returns executable html/svg', () => {
  assert.equal(dataContentType('.html'), 'text/plain; charset=utf-8');
  assert.equal(dataContentType('.svg'), 'text/plain; charset=utf-8');
  assert.equal(dataContentType('.json'), 'application/json');
});

test('safeJoin rejects a symlink escaping the base', () => {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sj-'));
  const secret = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-secret-'));
  fs.writeFileSync(path.join(secret, 'k'), 'x');
  fs.symlinkSync(path.join(secret, 'k'), path.join(b, 'link'));
  assert.equal(safeJoin(b, 'link'), null);
  fs.writeFileSync(path.join(b, 'real.md'), 'ok');
  assert.ok(safeJoin(b, 'real.md'));
});

test('sanitizeLine: CR/LF/TAB flatten to one space; C0+C1, DEL and bidi controls are stripped', () => {
  assert.equal(sanitizeLine('a\r\nb\rc\nd\te', 80), 'a b c d e');
  assert.equal(sanitizeLine('x\u0000y\u001b[31mz\u007f\u0085w', 80), 'xy[31mzw', 'NUL/ESC/DEL/C1 removed, printable text kept');
  assert.equal(sanitizeLine('rtl\u202e\u200f\u2066spoof\u2069', 80), 'rtlspoof', 'bidi/format overrides removed');
  assert.equal(sanitizeLine('  a   b  ', 80), 'a b', 'whitespace collapsed + trimmed');
});

test('sanitizeLine: hard length cap with ellipsis; non-strings never crash', () => {
  assert.equal(sanitizeLine('x'.repeat(80), 60), 'x'.repeat(59) + '\u2026');
  assert.equal(sanitizeLine('short', 60), 'short');
  assert.equal(sanitizeLine(null, 10), '');
  assert.equal(sanitizeLine(undefined, 10), '');
  assert.equal(sanitizeLine(42, 10), '42');
});

// ── readBody: overflow drain + overall deadline（请求体读取）──────────────────
// Stub socket (an EventEmitter with destroy/resume markers) drives the real
// readBody; mock timers make the deadline observable without real waiting.
// The contract under test: overflow rejects BUT keeps draining so the 413 can
// reach the client; the ONE overall deadline destroys a slow-drip (hostile)
// connection; a completed read clears the deadline so a later tick can never
// destroy a socket serving the response.
import { EventEmitter } from 'node:events';
import { readBody, BODY_TOO_LARGE, BODY_READ_TIMEOUT_MS } from '../lib/webutil.mjs';

class StubReq extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.resumed = false; }
  destroy() { this.destroyed = true; }
  resume() { this.resumed = true; }
}
const rejection = (p) => p.then(() => null, (e) => e);

test('readBody: normal JSON resolves; deadline cleared — no destroy after completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req = new StubReq();
  const p = readBody(req, 100);
  req.emit('data', Buffer.from('{"a":1}'));
  req.emit('end');
  assert.deepEqual(await p, { a: 1 });
  t.mock.timers.tick(BODY_READ_TIMEOUT_MS + 1);
  assert.equal(req.destroyed, false, 'a finished read must never be destroyed by a stale timer');
});

test('readBody: overflow rejects BODY_TOO_LARGE but DRAINS (no destroy) so the 413 reaches the client', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req = new StubReq();
  const p = readBody(req, 10);
  req.emit('data', Buffer.alloc(11));
  const err = await rejection(p);
  assert.equal(err.message, BODY_TOO_LARGE);
  assert.equal(req.destroyed, false, 'socket kept — destroy() would reset the connection before the 413');
  assert.equal(req.resumed, true, 'rest of the body is drained, not buffered');
  req.emit('end'); // client finishes uploading within the deadline
  t.mock.timers.tick(BODY_READ_TIMEOUT_MS + 1);
  assert.equal(req.destroyed, false, 'well-behaved oversized client: never destroyed');
});

test('readBody: hostile slow-drip after overflow is destroyed at the overall deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req = new StubReq();
  const p = readBody(req, 10);
  req.emit('data', Buffer.alloc(11));
  await rejection(p); // 413 path taken; drain begins, client never sends 'end'
  t.mock.timers.tick(BODY_READ_TIMEOUT_MS + 1);
  assert.equal(req.destroyed, true, 'the drain cannot be held open forever');
});

test('readBody: a body that never completes rejects at the deadline and is destroyed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req = new StubReq();
  const p = readBody(req, 1000);
  req.emit('data', Buffer.from('{"slow":'));
  t.mock.timers.tick(BODY_READ_TIMEOUT_MS + 1);
  const err = await rejection(p);
  assert.equal(err.message, 'body read timeout');
  assert.equal(req.destroyed, true);
});

test('readBody: bad JSON and empty body contracts unchanged by the move', async () => {
  const bad = new StubReq();
  const pBad = readBody(bad, 100);
  bad.emit('data', Buffer.from('{nope'));
  bad.emit('end');
  assert.equal((await rejection(pBad)).message, 'bad JSON');
  const empty = new StubReq();
  const pEmpty = readBody(empty, 100);
  empty.emit('end');
  assert.deepEqual(await pEmpty, {}, 'no body → {}');
});

// ── No default cap · one error mapping · strict base64 · atomic write ────────
// The 2026-09-02 data-loss scar, at the utility level: a route that inherits a
// cap it never chose, a failure the client cannot parse, a decoder that
// truncates silently, and a write that truncates the previous version first.
import {
  BODY_LIMITS, bodyErrorResponse, decodeBase64Strict, writeFileAtomic,
  BODY_BAD_JSON, BODY_READ_TIMEOUT, CODE_TOO_LARGE, humanBytes,
} from '../lib/webutil.mjs';
import { readJsonState, readJsonForUpdate, FILE_OK, FILE_ABSENT, FILE_UNREADABLE, FILE_UNREADABLE_CODE } from '../lib/readjson.mjs';
import { rmTemp } from './helpers-tmp.mjs';   // TODO(R4 seam): this file is over budget; split by test group (one describe per file)

test('readBody: a missing or nonsense limit fails LOUDLY — there is no default any more', async () => {
  for (const bad of [undefined, null, 0, -1, 1.5, '64000']) {
    const err = await rejection(readBody(new StubReq(), bad));
    assert.match(err.message, /explicit byte limit is required/, `refused limit: ${bad}`);
  }
});

test('BODY_LIMITS: every route cap is a positive integer, and the JSON caps are ordered by payload', () => {
  const vals = Object.values(BODY_LIMITS);
  assert.ok(vals.every((v) => Number.isInteger(v) && v > 0));
  // Raised 8 -> 16 MB on 2026-09-12 after a live note reached 6.54 MB and the user lost
  // handwriting at the cliff. The number is pinned here deliberately: it is a storage decision
  // with a cost (every 700ms autosave re-POSTs the WHOLE notebook), not a knob to drift upward.
  assert.equal(BODY_LIMITS.appData, 16 * 1024 * 1024, 'app data: whole notebooks (see lib/appdata.mjs)');
  assert.ok(BODY_LIMITS.auth < BODY_LIMITS.chat && BODY_LIMITS.chat < BODY_LIMITS.appData, 'caps ordered by payload, not by habit');
});

test('bodyErrorResponse: every failure is parseable JSON with a stable code', () => {
  const over = Object.assign(new Error(BODY_TOO_LARGE), { limit: 1234 });
  const big = bodyErrorResponse(over);
  assert.equal(big.status, 413, 'oversize is 413 — a 400 tells retry logic the payload is permanently unsendable');
  assert.deepEqual(JSON.parse(big.body), {
    ok: false, type: 'error', code: CODE_TOO_LARGE, limit: 1234,
    // The sentence names the limit, so a client that renders only `error` is still honest.
    error: 'Too large · 内容过大 — limit 1 KB', text: 'Too large · 内容过大 — limit 1 KB',
  });
  assert.equal(CODE_TOO_LARGE, 'too-large', 'the ONE size-rejection code every route and every client uses (R3)');
  const bad = bodyErrorResponse(new Error(BODY_BAD_JSON));
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.body).code, 'bad_json');
  assert.equal(bodyErrorResponse(new Error(BODY_READ_TIMEOUT)).status, 408);
  assert.equal(JSON.parse(bodyErrorResponse(new Error('anything else')).body).code, 'server_error');
  for (const e of [new Error(BODY_TOO_LARGE), new Error('boom'), {}]) {
    assert.doesNotThrow(() => JSON.parse(bodyErrorResponse(e).body), 'the app broker calls r.json() on every one of these');
  }
  // DEFECT V4 (2026-09-02 round 2): /api/chat streams application/x-ndjson and every chat
  // reader in the tree parses `while (buf.indexOf('\n') >= 0)`. Without the trailing newline
  // the 413 was never parsed, nothing threw, and the composer hung on "…" forever. Both
  // properties are asserted here because both are load-bearing for that reader.
  for (const e of [over, new Error(BODY_BAD_JSON), new Error(BODY_READ_TIMEOUT), new Error('boom')]) {
    const body = bodyErrorResponse(e).body;
    assert.ok(body.endsWith('\n'), 'NDJSON-readable: an error line ends the line');
    assert.equal(JSON.parse(body).type, 'error', 'and carries the terminal event type both readers already handle');
    assert.ok(JSON.parse(body).text, 'with human text in the field those readers render');
  }
});

test('humanBytes: the ONE limit-to-sentence formatter (R3) — the number a user is shown', () => {
  assert.equal(humanBytes(1024 * 1024), '1 MB');
  assert.equal(humanBytes(8 * 1024 * 1024), '8 MB');
  assert.equal(humanBytes(20 * 1024 * 1024), '20 MB');
  assert.equal(humanBytes(1536 * 1024), '1.5 MB', 'below 10MB keeps one decimal — 1.5MB must not read as "1 MB"');
  assert.equal(humanBytes(64 * 1024), '64 KB');
  assert.equal(humanBytes(0), '0 B');
  assert.equal(humanBytes(null), '0 B', 'a missing limit never renders as "NaN MB"');
});

test('decodeBase64Strict: the QUJD= scar — a corrupt payload decodes to null, never to a short buffer', () => {
  const bytes = Buffer.from('abcdefghijkl');
  const b64 = bytes.toString('base64');
  assert.deepEqual(decodeBase64Strict(b64), bytes);
  assert.deepEqual(decodeBase64Strict(`data:image/jpeg;base64,${b64}`), bytes, 'data: prefix tolerated');
  assert.deepEqual(decodeBase64Strict(`${b64.slice(0, 4)}\n ${b64.slice(4)}`), bytes, 'whitespace tolerated');
  assert.equal(Buffer.from(b64.slice(0, 4) + '=' + b64.slice(4), 'base64').length < bytes.length, true,
    "Node's own decoder really does truncate at an interior '=' (the scar being guarded)");
  assert.equal(decodeBase64Strict(b64.slice(0, 4) + '=' + b64.slice(4)), null, 'strict decode refuses it instead');
  for (const bad of ['', 'abc', 'a!b=', null, undefined, 42, {}]) assert.equal(decodeBase64Strict(bad), null, `refused: ${JSON.stringify(bad)}`);
});

test('writeFileAtomic: a failed write cannot destroy the previous version, and leaves no tmp litter', { skip: needPerms }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-atomic-'));
  const f = path.join(d, 'state.json');
  writeFileAtomic(f, '{"v":1}');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"v":1}');
  fs.chmodSync(d, 0o500);
  assert.throws(() => writeFileAtomic(f, '{"v":2}'), /atomic write failed for state\.json/, 'rethrown with context (R5)');
  fs.chmodSync(d, 0o700);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"v":1}', 'previous bytes intact — never truncated first');
  assert.deepEqual(fs.readdirSync(d), ['state.json']);
  rmTemp(d);
});

// ── Absent vs unreadable（不存在 vs 读不出来）─────────────────────────────────
// THE ROOT SHAPE OF THE 2026-09-02 DATA LOSS on the server side. Every store in
// the tree read itself with `try { JSON.parse(read(f)) } catch { return {} }`,
// so a permission error, an I/O error or a half-written file became an EMPTY
// document — and the very next write stored that emptiness over the user's data
// and answered ok:true. These three states are what makes that impossible.
test('readJsonState: absent, ok and unreadable are three DIFFERENT answers', { skip: needPerms }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-read-'));
  assert.equal(readJsonState(path.join(d, 'nope.json')).state, FILE_ABSENT, 'a first run is not a failure');
  const ok = path.join(d, 'ok.json');
  fs.writeFileSync(ok, '{"a":1}');
  assert.deepEqual(readJsonState(ok), { state: FILE_OK, value: { a: 1 } });
  const torn = path.join(d, 'torn.json');
  fs.writeFileSync(torn, '{"a":1');                 // killed between open and the closing brace
  assert.equal(readJsonState(torn).state, FILE_UNREADABLE);
  const empty = path.join(d, 'empty.json');
  fs.writeFileSync(empty, '');                       // truncate-then-crash: 0 bytes is damage, NOT "absent"
  assert.equal(readJsonState(empty).state, FILE_UNREADABLE, 'an empty file is a truncation artifact, never a stored document');
  const locked = path.join(d, 'locked.json');
  fs.writeFileSync(locked, '{"a":1}');
  fs.chmodSync(locked, 0o000);
  assert.equal(readJsonState(locked).state, FILE_UNREADABLE, 'EACCES means the document may be perfectly fine — never treat it as gone');
  fs.chmodSync(locked, 0o600);
  rmTemp(d);
});

test('readJsonForUpdate: absent → fallback, unreadable → THROWS so a handler cannot overwrite it', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-upd-'));
  assert.deepEqual(readJsonForUpdate(path.join(d, 'new.json'), { seed: true }), { seed: true }, 'a first save is normal');
  const torn = path.join(d, 'torn.json');
  fs.writeFileSync(torn, 'not json at all');
  let err = null;
  try { readJsonForUpdate(torn, {}); } catch (e) { err = e; }
  assert.ok(err, 'a damaged file must THROW, never quietly hand back an empty document');
  assert.equal(err.code, FILE_UNREADABLE_CODE);
  assert.match(err.message, /refusing to overwrite/);
  assert.match(err.message, /拒绝覆盖/, 'bilingual — this reaches a person');
  assert.equal(fs.readFileSync(torn, 'utf8'), 'not json at all', 'and the damaged bytes are still there to repair');
  // A file that PARSES but is the wrong shape would be destroyed just as surely.
  const wrong = path.join(d, 'wrong.json');
  fs.writeFileSync(wrong, '[1,2,3]');
  assert.throws(() => readJsonForUpdate(wrong, {}, { expect: (v) => v && !Array.isArray(v) }), { code: FILE_UNREADABLE_CODE });
  assert.deepEqual(readJsonForUpdate(wrong, {}, { expect: Array.isArray }), [1, 2, 3], 'the same file is fine where an array IS the shape');
  // The lenient reader still exists for read-only callers, and still lies — deliberately.
  assert.deepEqual(readJson(torn, { fallback: true }), { fallback: true }, 'readJson is for display, never for read-before-write');
  rmTemp(d);
});

test('bodyErrorResponse maps a refused overwrite to a machine-readable 500 (R3: one mapping, every route)', () => {
  const e = Object.assign(new Error('refusing to overwrite a file that could not be read · 拒绝覆盖无法读取的文件 — x.json is empty'), { code: FILE_UNREADABLE_CODE });
  const r = bodyErrorResponse(e);
  assert.equal(r.status, 500);
  const j = JSON.parse(r.body);
  assert.equal(j.code, FILE_UNREADABLE_CODE);
  assert.equal(j.ok, false);
  assert.match(j.text, /拒绝覆盖/, 'the client can show the user WHY nothing was saved');
});
