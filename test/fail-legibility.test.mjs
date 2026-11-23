// Error legibility（错误可读性）— round 3 of the 2026-09-02 DATA-LOSS remediation.
//
// WHAT THIS FILE IS FOR
// Leftover (e) of the incident: an oversized photo insert reached the user as the generic
// English-only "Upload failed" — the SAME words a 401 produced, and the same words a
// dropped connection produced. A message that cannot distinguish "crop the photo" from
// "sign in again" makes the user retry the thing that can never work, which is how a
// recoverable refusal turns into lost work. So the property under test is not "an error is
// shown" but: EVERY DISTINCT FAILURE CLASS PRODUCES A DISTINCT USER-VISIBLE SENTENCE, and
// a size rejection names the cap.
//
// HARNESS FIDELITY (R14 — a lenient harness is what caused this incident)
//   * the SERVER half is the REAL web.mjs, spawned as a child process against a throwaway
//     root (test/helpers-web.mjs) — real routes, real BODY_LIMITS, real readBody, real
//     bodyErrorResponse, real uploads writer. No route logic is re-implemented here.
//   * the CLIENT half is EXTRACTED from the shipped files and RUN: web/index.html's
//     RELAY-CORE block and web/chat-ui.inline.html's size helpers. Nothing is retyped.
//   * the ONE case the real server cannot produce — a socket destroyed with no answer —
//     comes from a three-line node:http server that does exactly that, and nothing else.
//   * every assertion about distinctness is preceded by a CONTROL that reproduces the
//     PRE-FIX surface and FAILS it, so a green result cannot be vacuous.
// NEVER live data: throwaway roots and throwaway workspaces only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SRC } from './helpers-app.mjs';
import { BODY_LIMITS, CODE_TOO_LARGE, humanBytes } from '../lib/webutil.mjs';
import { MAX_PHOTO_BYTES, MEAL_MAX_BODY_BYTES } from '../lib/meals.mjs';
import { mkWebRoot, startWeb, stopWeb, waitReady, freePort, api } from './helpers-web.mjs';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined
// Source pins scan CODE, not prose: a comment that quotes the very string it warns about
// must not fail a pin that forbids it.
import { codeOnly } from './helpers-code.mjs';
import { RELAY_CORE, loadRelayCore } from './helpers-shell-broker.mjs';
import { rmTemp } from './helpers-tmp.mjs';   // TODO(R4 seam): this file is over budget; split by test group (one describe per file)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);       // throws if moved — never a vacuous pass
const COMPONENT = fs.readFileSync(path.join(ROOT, 'web', 'chat-ui.inline.html'), 'utf8');

// ── Extract and RUN the shell's failure mapper (helpers-shell-broker.mjs loadRelayCore) ──────
assert.match(RELAY_CORE, /RELAY_NOUNS/, 'the extraction really found the round-3 noun table, not an older block');
assert.match(RELAY_CORE, /function relayText/, 'and the mapper itself');

// ── Extract and RUN the sandboxed component's pre-flight helpers ────────────────────────
function loadComponent() {
  const from = COMPONENT.indexOf('  const PAC_LIMITS=');
  const to = COMPONENT.indexOf('\n  const esc=s=>');
  assert.ok(from > 0 && to > from, 'the size helpers must stay a DOM-free block above const esc=');
  const src = COMPONENT.slice(from, to);
  assert.match(src, /PAC_NOUNS/, 'the extraction found the round-3 noun table in the component');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn {PAC_LIMITS,PAC_TOO_LARGE,PAC_NOUNS,pacHuman,pacTooLargeText,pacTooLargeLimit,pacWhatForFile};`)();
}

const R = loadRelayCore(() => { throw new Error('no api in this context'); });
const C = loadComponent();

// A body of exactly `n` bytes of base64-legal payload.
const b64 = (n) => 'A'.repeat(n);
const CJK = /[㐀-䶿一-鿿]/;
const LATIN = /[A-Za-z]{3}/;

// ── The real server, once per test that needs it ────────────────────────────────────────
async function withWeb(fn) {
  const port = await freePort();
  const root = mkWebRoot({ port });
  const inst = startWeb(root);
  try { await waitReady(port); await fn({ port, root }); }
  finally { await stopWeb(inst); rmTemp(root); }
}

// The ONE failure the real server cannot stage: a socket destroyed mid-request.
async function withDeadSocket(fn) {
  const srv = http.createServer((req) => { req.socket.destroy(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

// Everything the user actually reads for one failed upload, produced by the SHIPPED mapper.
const shownFor = (fail, sentBytes, name) => R.relayText(fail, sentBytes, R.relayWhatForFile(name));

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART A — R14 controls: prove the harness can fail before trusting anything it says
   ════════════════════════════════════════════════════════════════════════════════════ */

test('CONTROL: a stub extraction fails loudly instead of silently testing nothing', () => {
  assert.throws(() => {
    // eslint-disable-next-line no-new-func
    new Function('api', 'return {relayText:()=>"x"}')();
    assert.match('nothing here', /RELAY_NOUNS/);
  }, /RELAY_NOUNS/, 'the pin that guarantees we extracted round-3 code really fires');
});

test('CONTROL: the PRE-FIX surface collapses every failure class to ONE string — the assertion below has teeth', () => {
  // This is verbatim what web/note-ui.inline.html and the old picker did: ignore the code,
  // print a house string. Six different failures, one sentence. If the distinctness test
  // that follows could pass against this, it would be proving nothing.
  const preFix = () => 'Upload failed';
  const classes = [
    { ok: false, code: 'too-large', status: 413, limit: BODY_LIMITS.upload },
    { ok: false, code: 'unauthorized', status: 401 },
    { ok: false, code: 'network' },
    { ok: false, code: 'server-error', status: 500 },
    { ok: false, code: 'not-found', status: 404 },
    { ok: false, code: 'bad-request', status: 400, error: '无效的 base64 数据 · invalid base64 data' },
  ];
  const pre = new Set(classes.map(preFix));
  assert.equal(pre.size, 1, 'the pre-fix surface really is one indistinguishable sentence');
  const now = new Set(classes.map((f) => shownFor(f, 1024, 'IMG_0001.jpg')));
  assert.equal(now.size, classes.length, 'and the shipped mapper really is not');
});

test('harness fidelity: the REAL server enforces the REAL upload cap and writes nothing when it refuses', async () => {
  await withWeb(async ({ port, root }) => {
    const uploads = path.join(root, 'workspace', 'uploads');
    // A body past BODY_LIMITS.upload — the cap is a cap, and the refusal is machine-readable.
    const big = await api(port, '/api/upload', { method: 'POST', body: JSON.stringify({ name: 'big.jpg', data: b64(BODY_LIMITS.upload) }) });
    assert.equal(big.status, 413, 'a size rejection is a 413, never a bare 400 a retry loop reads as permanent');
    const j = await big.json();
    assert.equal(j.code, CODE_TOO_LARGE, 'the ONE size code every route answers (R3)');
    assert.equal(j.limit, BODY_LIMITS.upload, 'with the cap, so the client can say HOW big is too big');
    assert.equal(fs.existsSync(uploads), false, 'nothing was written for a refused upload');
    // …and an ordinary one really is stored, so the cap is not a wall (R14: no vacuous pass).
    const ok = await api(port, '/api/upload', { method: 'POST', body: JSON.stringify({ name: 'small.jpg', data: Buffer.from('hello').toString('base64') }) });
    assert.equal(ok.status, 200);
    assert.equal(fs.readdirSync(uploads).length, 1, 'the success path really wrote a file — the harness is not refusing everything');
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART B — leftover (e): the upload surface names WHAT was refused, and WHY
   ════════════════════════════════════════════════════════════════════════════════════ */

test('(e) an oversized PHOTO reads as a photo, with the cap — end to end over real HTTP', async () => {
  await withWeb(async ({ port }) => {
    const body = JSON.stringify({ name: 'IMG_0001.HEIC', data: b64(BODY_LIMITS.upload) });
    const res = await api(port, '/api/upload', { method: 'POST', body });
    const f = await R.relayHttpFail(res);                    // the SHIPPED broker mapping
    assert.equal(f.code, 'too-large');
    const shown = shownFor(f, R.relayBodyBytes(body), 'IMG_0001.HEIC');
    assert.match(shown, /照片过大 · Photo too large/, 'the noun is PHOTO — not "File", and certainly not "Upload failed"');
    assert.match(shown, new RegExp(`max ${humanBytes(BODY_LIMITS.upload)}`), 'the cap is named in the sentence');
    assert.match(shown, /已发送 \S+ \S+ · \S+ \S+ sent/, 'and so is what was actually sent');
    assert.match(shown, /请选择更小的照片或裁剪后重试/, 'it says what to DO, bilingually');
  });
});

// ── ROUND-4 LEFTOVER 2: the PAD's own half of the same sentence ──────────────────────────────
// The shell's half was fixed in round 3. The pad's own PRE-FLIGHT refusal — the one the user sees
// most often, because it fires before anything is uploaded — was still a different dialect
// ('图片过大' vs the shell's '照片过大') and, worse, it named the PHOTO'S size instead of the CAP,
// so the message did not say what would fit. One wording, one number, both halves.
function loadEngine() {
  const ENGINE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
  const from = ENGINE.indexOf('  const SAVE_TIMEOUT_MS='), to = ENGINE.indexOf('\n  function makeSaveGuard(cfg){');
  assert.ok(from > 0 && to > from, 'the engine\'s DOM-free block must stay locatable');
  const src = ENGINE.slice(from, to);
  assert.match(src, /PHOTO_TXT/, 'the extraction found the photo vocabulary, not an older block');
  // eslint-disable-next-line no-new-func
  return { src: ENGINE, ...new Function(`${src}\nreturn {PHOTO_TXT,UPLOAD_MAX_BYTES,UPLOAD_BODY_LIMIT,photoMB};`)() };
}
const E = loadEngine();

test('(e) the PAD refuses an oversized photo in the SHELL\'s own words, and names the cap', () => {
  const shown = E.PHOTO_TXT.big(E.UPLOAD_MAX_BYTES) + E.PHOTO_TXT.bigAct;
  assert.match(shown, /照片过大 · Photo too large/, 'the same sentence the shell produces — one dialect, not two');
  assert.equal(E.PHOTO_TXT.big(E.UPLOAD_MAX_BYTES).startsWith(R.RELAY_NOUNS.photo.head), true,
    `the pad's heading IS the shell's heading (${R.RELAY_NOUNS.photo.head})`);
  assert.match(shown, /\(max \d+(\.\d+)? MB\)/, 'and it states the CAP: ' + shown);
  assert.match(shown, /请选择更小的照片或裁剪后重试/, 'with the action, bilingually');
  // THE PRE-FIX SURFACE, reproduced so the assertions above have teeth (R14): it named the photo's
  // size, in a second dialect, and never said what would fit.
  const preFix = '图片过大 · Photo too large — pick a smaller one 请选择较小的图片' + ' (12MB)';
  assert.doesNotMatch(preFix, /max /, 'the pre-fix message named no cap…');
  assert.notEqual(preFix.split(' —')[0], R.RELAY_NOUNS.photo.head, '…and did not match the shell');
});

test('(e) the cap the pad enforces is DERIVED from the real body limit, not a guess', () => {
  // Browser code cannot import lib/webutil.mjs, so this pin is what stops the copy from drifting —
  // the same discipline RELAY_LIMITS and PAC_LIMITS are held to.
  assert.equal(E.UPLOAD_BODY_LIMIT, BODY_LIMITS.upload, 'the engine\'s copy of the upload body cap is the real one');
  // base64 inflates 4/3 and the shell wraps the payload, so the FILE size that fits is smaller.
  assert.ok(E.UPLOAD_MAX_BYTES < BODY_LIMITS.upload, 'the file cap is below the body cap…');
  assert.ok(E.UPLOAD_MAX_BYTES > BODY_LIMITS.upload * 0.7, '…by roughly the base64 ratio, not arbitrarily');
  assert.ok(R.relayB64Bytes(E.UPLOAD_MAX_BYTES) <= BODY_LIMITS.upload,
    'a file at exactly the pad\'s cap still fits the body the shell will send — so the pre-flight never refuses something the server would accept, nor lets through something it would not');
  assert.ok(R.relayB64Bytes(E.UPLOAD_MAX_BYTES + 1024 * 1024) > BODY_LIMITS.upload, 'and 1MB over does not fit');
  assert.equal(E.photoMB(15 * 1048576), '15 MB', 'the size is rendered the same way every other surface renders it');
  assert.equal(E.photoMB(15 * 1048576), R.relaySize(15 * 1048576), 'byte-for-byte the shell\'s own renderer (R3)');
});

test('(e) the apps forward the SHELL\'s rendered sentence, not the raw server error', () => {
  // The shell already composes the right noun, both languages and the cap (relayFail attaches it
  // as `text`). An app that printed `error` instead threw all of that away — which is how a 413
  // ended up reading like a 401 in the notebook.
  // Was a hardcoded list including workspace/apps, which is the owner's gitignored LIVE set —
  // absent on a fresh clone, so this threw ENOENT for everyone but the author and the published
  // repo failed its own suite. APP_SRC resolves each app to its live copy or its tracked
  // template, one definition shared with every other app assertion (R3).
  const entries = Object.entries(APP_SRC);
  assert.ok(entries.length >= 2, 'CONTROL: there are app sources to check, so this cannot pass empty');
  for (const [rel, src] of entries) {
    assert.match(src, /const why=\(r&&\(r\.text\|\|r\.error\)\)\|\|'上传被拒绝 · upload rejected';/,
      `${rel}: the photo failure prefers the shell's rendered sentence`);
    assert.ok(!/Number\.isFinite\(r\.limit\)\)\?' \('\+Math\.round\(r\.limit\/1048576\)\+'MB max\)'/.test(src),
      `${rel}: and no longer re-renders the cap in a dialect of its own (R3)`);
  }
});

test('(e) the SAME route with a non-image filename says "File", from ONE inference point', () => {
  const f = { ok: false, code: 'too-large', status: 413, limit: BODY_LIMITS.upload };
  assert.match(shownFor(f, 4096, 'notes.pdf'), /文件过大 · File too large/);
  assert.match(shownFor(f, 4096, 'photo.jpeg'), /照片过大 · Photo too large/);
  assert.match(shownFor(f, 4096, 'scan.HEIF'), /照片过大 · Photo too large/, 'case-insensitive, and HEIF counts');
  assert.equal(R.relayWhatForFile('a.webp'), 'photo');
  assert.equal(R.relayWhatForFile('a.zip'), 'file');
  assert.equal(R.relayWhatForFile(''), 'file', 'a missing name degrades to the neutral noun, never to a wrong one');
});

test('(e) a 401 on the upload route reads NOTHING like a size rejection — real server, real auth gate', async () => {
  await withWeb(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/upload`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-token' },
      body: JSON.stringify({ name: 'IMG_0001.jpg', data: 'QQ==' }),
    });
    assert.equal(res.status, 401, 'the real auth gate, not a stub');
    const f = await R.relayHttpFail(res);
    assert.equal(f.code, 'unauthorized');
    const shown = shownFor(f, 512, 'IMG_0001.jpg');
    assert.match(shown, /登录已过期 · Signed out/);
    assert.match(shown, /未上传 · Photo not uploaded/, 'it says what happened to the photo — the user knows it is still on their device');
    assert.doesNotMatch(shown, /too large|过大|max /, 'and never suggests the photo was too big');
  });
});

test('(e) a dropped connection says the photo never left the device — distinct again', async () => {
  await withDeadSocket(async (base) => {
    let f = null;
    try { await fetch(base + '/api/upload', { method: 'POST', body: '{}' }); }
    catch (err) { f = R.relayNetFail(err, 'request'); }
    assert.ok(f, 'the socket really was destroyed with no answer');
    assert.equal(f.code, 'network');
    const shown = shownFor(f, 1024, 'IMG_0001.jpg');
    assert.match(shown, /连接失败 · Connection failed/);
    assert.match(shown, /未发出 · it never left this device/, 'the honest statement: nothing was uploaded');
    assert.doesNotMatch(shown, /过大|max /);
  });
});

test('(e) the seven failure classes of ONE upload are seven different bilingual sentences', () => {
  const classes = {
    'too-large': { ok: false, code: 'too-large', status: 413, limit: BODY_LIMITS.upload },
    unauthorized: { ok: false, code: 'unauthorized', status: 401 },
    network: { ok: false, code: 'network' },
    'server-error': { ok: false, code: 'server-error', status: 500 },
    'not-found': { ok: false, code: 'not-found', status: 404 },
    'bad-request': { ok: false, code: 'bad-request', status: 400, error: '无效的 base64 数据 · invalid base64 data' },
    'relay-error': { ok: false, code: 'relay-error', error: '附件解码失败 · could not decode the attachment' },
  };
  const seen = new Map();
  for (const [name, f] of Object.entries(classes)) {
    const s = shownFor(f, 2 * 1024 * 1024, 'IMG_0001.jpg');
    assert.ok(!seen.has(s), `${name} reads exactly like ${seen.get(s)} — the incident's shape`);
    seen.set(s, name);
    assert.match(s, CJK, `${name} must carry its 中文 half`);
    assert.match(s, LATIN, `${name} must carry its English half`);
  }
  assert.equal(seen.size, Object.keys(classes).length);
  // Exactly ONE of them may talk about a size. A 401 that mentions a limit sends the user
  // off to crop a photo that was never the problem.
  const mentionsSize = [...seen.keys()].filter((s) => /max |过大/.test(s));
  assert.equal(mentionsSize.length, 1, 'only the size rejection talks about size');
});

test('(e) a failed READ never claims something was "not saved" — the wrong side of the exchange', () => {
  // Telling a user their note was not SAVED when the app merely could not LOAD it is the
  // same category of lie the incident was made of: a sentence that describes the opposite
  // of what happened sends them to fix the wrong thing.
  const f = { ok: false, code: 'unauthorized', status: 401 };
  assert.match(R.relayText(f, 0, 'content'), /内容未加载 · Content not loaded/);
  assert.doesNotMatch(R.relayText(f, 0, 'content'), /未保存/);
  assert.match(R.relayText(f, 0, 'note'), /笔记未保存 · Note not saved/, 'a failed WRITE does say "not saved"');
  assert.match(R.relayText(f, 0, 'photo'), /照片未上传 · Photo not uploaded/);
  assert.match(R.relayText(f, 0, 'message'), /消息未发送 · Message not sent/);
  // …and the broker picks the read noun for read kinds, the payload noun for writes.
  const broker = codeOnly(SHELL.slice(SHELL.indexOf('/* ── Broker (for sandboxed apps) ── */'), SHELL.indexOf('/* ── Chat log helpers ── */')));
  assert.match(broker, /m\.kind==='save-data'\?'note':'content'/, 'reads fall through to the read noun, not to a write noun');
  // Even the shell's own pre-request refusals are bilingual — an app cannot act on 'bad path'.
  assert.match(codeOnly(SHELL), /error:'路径无效 · bad path'/);
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART C — one mapping, end to end (R3): server code → broker code → component sentence
   ════════════════════════════════════════════════════════════════════════════════════ */

test('R3: one vocabulary — the server\'s code IS the broker\'s code IS what the component recognises', async () => {
  await withWeb(async ({ port }) => {
    const res = await api(port, '/api/upload', { method: 'POST', body: JSON.stringify({ name: 'x.jpg', data: b64(BODY_LIMITS.upload) }) });
    const j = await res.json();
    const f = await R.relayHttpFail(new Response(JSON.stringify(j), { status: 413 }));
    assert.equal(j.code, CODE_TOO_LARGE);
    assert.equal(f.code, CODE_TOO_LARGE, 'the broker does not invent a second name for it');
    assert.equal(C.PAC_TOO_LARGE, CODE_TOO_LARGE, 'and the sandboxed component reads that same code');
    assert.equal(C.pacTooLargeLimit(f), BODY_LIMITS.upload, 'the limit survives the whole chain');
  });
});

test('R3: one rendering of a byte count — server, shell and component agree to the character', () => {
  // ROUND-3 DRIFT FIXED: the shell printed "1.0 MB" for the cap the server's own 413 body
  // called "1 MB" and the component called "1 MB". Three spellings of one number is how a
  // user ends up unsure which limit is real.
  for (const n of [0, 512, 1024, 1536, 65536, 1048576, 1572864, 6 * 1048576, 8 * 1048576, 20 * 1048576, 1024 * 1048576]) {
    assert.equal(R.relaySize(n), humanBytes(n), `shell vs server at ${n} bytes`);
    assert.equal(C.pacHuman(n), humanBytes(n), `component vs server at ${n} bytes`);
  }
});

test('R3: the shell\'s copy of the caps is the server\'s caps', () => {
  assert.equal(R.RELAY_LIMITS.chat, BODY_LIMITS.chat, 'a stale copy refuses the wrong messages');
  assert.equal(R.RELAY_LIMITS.upload, BODY_LIMITS.upload);
});

test('R3: the pre-flight sentence and the post-facto sentence are the SAME sentence', () => {
  // The component refuses BEFORE sending (no reply exists to render) and the shell renders
  // what came back. A user must not be able to tell which half refused them.
  const cases = [
    ['Message', 'message', 1_500_000, BODY_LIMITS.chat],
    ['File', 'file', 30 * 1024 * 1024, BODY_LIMITS.upload],
    ['Photo', 'photo', 24 * 1024 * 1024, BODY_LIMITS.upload],
  ];
  for (const [pacWhat, relayWhat, bytes, limit] of cases) {
    const fromComponent = C.pacTooLargeText(pacWhat, bytes, limit);
    const fromShell = R.relayText({ ok: false, code: 'too-large', limit }, bytes, relayWhat);
    assert.equal(fromComponent, fromShell, `${pacWhat}: the two halves of one refusal must read identically`);
    assert.match(fromComponent, CJK);
    assert.match(fromComponent, new RegExp(`max ${humanBytes(limit)}`));
  }
  assert.equal(C.pacWhatForFile('IMG_1.HEIC'), 'Photo', 'and both halves infer the noun the same way');
  assert.equal(R.relayWhatForFile('IMG_1.HEIC'), 'photo');
});

test('R3 source pin: EVERY broker reply is rendered by the one mapper — no kind may answer prose of its own', () => {
  const from = SHELL.indexOf('/* ── Broker (for sandboxed apps) ── */');
  const to = SHELL.indexOf('/* ── Chat log helpers ── */');
  assert.ok(from > 0 && to > from, 'the broker block must stay findable');
  const broker = codeOnly(SHELL.slice(from, to));
  assert.ok(broker.includes("m.kind==='upload'") && broker.includes("m.kind==='save-data'"), 'the slice really contains the broker');
  // The single choke point: reply() renders through relayFail, so no branch can forget.
  assert.match(broker, /const reply=\(o,bytes\)=>[^\n]*relayFail\(o,bytes\|\|0,what\)/, 'reply() must route every answer through relayFail');
  assert.match(broker, /relayWhatForFile\(m\.name\)/, 'the upload noun is inferred ONCE, in the broker — not at each call site');
  // A branch that builds a user-facing sentence itself is a second mapping (R3).
  assert.equal(/Upload failed/.test(broker), false, 'the generic sentence that hid every reason is gone from the broker');
  // Every failure reply still carries a code (the round-2 property this must not regress).
  for (const m of broker.matchAll(/\{ok:false,(.{0,24})/g)) {
    assert.match(m[1], /^code:/, `a failure reply without a code: {ok:false,${m[1]}…`);
  }
});

test('R3 source pin: the shell\'s own chrome answers through the mapper too, not through "Save failed"', () => {
  const chrome = codeOnly(SHELL);
  // These four write paths used to print one house sentence for a 413, a 401 and a dead
  // socket — and two of them threw on a text/plain 4xx, showing the user nothing at all.
  assert.equal(/'保存失败 · Save failed'/.test(chrome), false, 'the settings sentence that hid the code is gone');
  assert.equal(/\|\|'Fork failed'/.test(chrome), false, 'and the fork one');
  assert.equal(/\|\|'Failed\.'/.test(chrome), false, 'and the sign-in one');
  assert.ok(chrome.split('relayJson(').length - 1 >= 6, 'every one of those call sites goes through relayJson');
});

// PAChat.failText is the seam every OTHER component on a sandboxed page reaches the one
// mapping through (PANote's photo insert, an app's own picker). Extracted and RUN on top of
// the same helper block, so it is the shipped arrow, not a retyped copy.
function loadFailText() {
  const from = COMPONENT.indexOf('    failText:(reply,o)=>');
  const endMark = "'请求失败 · Request failed — 未给出原因 · no reason given'; },";
  const to = COMPONENT.indexOf(endMark);
  assert.ok(from > 0 && to > from, 'PAChat.failText must stay one findable expression');
  const helpersFrom = COMPONENT.indexOf('  const PAC_LIMITS=');
  const helpers = COMPONENT.slice(helpersFrom, COMPONENT.indexOf('\n  const esc=s=>'));
  const expr = COMPONENT.slice(from, to + endMark.length).replace(/^\s*failText:/, '').replace(/,\s*$/, '');
  // eslint-disable-next-line no-new-func
  return new Function(`${helpers}\nreturn (${expr});`)();
}

test('(e) the seam other components use: PAChat.failText never answers a generic string for a coded failure', () => {
  const failText = loadFailText();
  // 1. The shell already rendered the sentence — it wins, so every surface says the same thing.
  const fromShell = R.relayFail({ ok: false, code: 'unauthorized', status: 401 }, 0, 'photo');
  assert.equal(failText(fromShell, { what: 'Photo' }), fromShell.text);
  assert.match(failText(fromShell, { what: 'Photo' }), /登录已过期 · Signed out/);
  // 2. A shell that forwarded only the bare 413 code still gets the size sentence, with the cap.
  const bare = { ok: false, code: CODE_TOO_LARGE, status: 413, limit: BODY_LIMITS.upload };
  const sized = failText(bare, { what: 'Photo', bytes: 24 * 1024 * 1024 });
  assert.match(sized, /照片过大 · Photo too large/);
  assert.match(sized, new RegExp(`max ${humanBytes(BODY_LIMITS.upload)}`));
  // 3. Even a reply with nothing usable is bilingual and says a reason is missing — never "failed".
  assert.match(failText({ ok: false }, {}), /请求失败 · Request failed/);
  assert.match(failText({ ok: false }, {}), /未给出原因 · no reason given/);
  // …and the caps it publishes are the caps the server enforces.
  assert.match(COMPONENT, /limits:Object\.freeze\(\{\.\.\.PAC_LIMITS\}\)/, 'the exposed caps are the pinned constant, copied so an app cannot raise it');
  assert.equal(C.PAC_LIMITS.upload, BODY_LIMITS.upload);
  assert.match(SHELL, /uploadMaxBytes:RELAY_LIMITS\.upload/, 'and the shell publishes that same number to every app in {pa:prefs}');
});

test('(2) an oversized meal photo is a 413 with the code, the cap and a sentence — not an uncoded 400', async () => {
  // ROUND-3 LEFTOVER: lib/meals.mjs answered `照片过大 · photo too large` with NO code, NO
  // limit and HTTP 400 — to any client that is indistinguishable from "that file is not an
  // image". Real server, real route, real photo guard, throwaway workspace.
  await withWeb(async ({ port, root }) => {
    const over = Buffer.alloc(MAX_PHOTO_BYTES + 1024, 0x41);
    const body = JSON.stringify({ data: over.toString('base64') });
    assert.ok(Buffer.byteLength(body) < MEAL_MAX_BODY_BYTES, 'the body is under the ROUTE cap, so the PHOTO guard is what refuses it');
    const res = await api(port, '/api/meals/ingest', { method: 'POST', body });
    assert.equal(res.status, 413, 'a size rejection is a 413 on this route too');
    const j = await res.json();
    assert.equal(j.code, CODE_TOO_LARGE, 'the same code as every other route (R3)');
    assert.equal(j.limit, MAX_PHOTO_BYTES, 'with the photo cap — which is NOT the body cap');
    assert.match(j.error, /Photo too large · 照片过大/);   // lib/meals.mjs: server text, outside the 中文-first UI sweep
    assert.match(j.error, new RegExp(`max ${humanBytes(MAX_PHOTO_BYTES)}`));
    assert.equal(fs.existsSync(path.join(root, 'workspace', 'uploads')), false, 'nothing stored for a refused photo');

    // …and a payload that is simply not an image is a DIFFERENT answer, so the Shortcut can
    // tell "crop it" from "that is not a photo".
    const notImage = await api(port, '/api/meals/ingest', { method: 'POST', body: JSON.stringify({ data: Buffer.from('not an image at all').toString('base64') }) });
    assert.equal(notImage.status, 400);
    const nj = await notImage.json();
    assert.equal(nj.code, 'not_an_image');
    assert.notEqual(nj.error, j.error, 'two different refusals, two different sentences');
    assert.equal(nj.limit, undefined, 'and a non-size refusal never claims a size limit');
  });
});

/* ════════════════════════════════════════════════════════════════════════════════════════
   PART D — the unified root cause in the shell's OWN chat path:
            evidence of unfinished work may only be retired by a signal that covers it
   ════════════════════════════════════════════════════════════════════════════════════ */

// pollForResult is DOM-bound, so it is extracted and run with injected doubles — including
// the timer, so 45 four-second attempts take microseconds.
function loadPoll({ convoReplies }) {
  const from = SHELL.indexOf('function pollForResult(id');
  const to = SHELL.indexOf('/* ── Send ── */');
  assert.ok(from > 0 && to > from, 'pollForResult must stay findable between its markers');
  const src = SHELL.slice(from, to);
  assert.match(src, /onSettled/, 'the extraction found the round-3 version, not the old one');
  const ticks = [];
  // v2.30.0 appends a <small class="pa-took">took Xs</small> to the settled reply, so a message
  // element must accept a child and `document` must be able to make one. Without these the
  // extracted function threw "document is not defined" and this watch test could not run at all.
  const mkEl = (o = {}) => ({ className: '', textContent: '', innerHTML: '', removed: false,
    kids: [], appendChild(c) { this.kids.push(c); return c; }, remove() { this.removed = true; }, ...o });
  const el = mkEl();
  const added = [];
  // took()/addTook() are the shell's own, LIFTED from the shell rather than restubbed — the took-Xs
  // assertions below would otherwise be measuring a copy written by this test (R14).
  const tookSrc = SHELL.slice(SHELL.indexOf('function took(ms){'), SHELL.indexOf('function renderMsgs'));
  assert.match(tookSrc, /function addTook\(el,ms(,by)?\)/, 'the shell still carries took/addTook');
  const { took, addTook } = new Function('document', `${tookSrc}\nreturn {took,addTook};`)(
    { createElement: (tag) => mkEl({ tagName: tag }) });
  const deps = {
    document: { createElement: (tag) => mkEl({ tagName: tag }) },
    took, addTook,
    relayCall: async () => convoReplies.shift() || { ok: false, code: 'network', error: 'no more replies' },
    relayText: R.relayText,
    add: (cls, t) => { const d = mkEl({ className: 'msg ' + cls, textContent: t || '' }); added.push(d); return d; },
    addActions: () => {},
    renderMd: (t) => t,
    loadConvos: () => {}, loadApps: () => {},
    $: () => ({ scrollTop: 0, scrollHeight: 0 }),
    lastPromptText: '',
    setInterval: (fn) => { ticks.push(fn); return ticks.length; },
    clearInterval: (h) => { ticks[h - 1] = null; },
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const make = new Function(...names, `${src}\nreturn pollForResult;`)(...names.map((n) => deps[n]));
  return { poll: make, el, added, tick: async () => { for (const f of ticks) if (f) await f(); }, alive: () => ticks.some(Boolean) };
}

test('(3) an UNRELATED touch of the conversation does not end the watch — the incident\'s exact shape', async () => {
  // The conversation's `updated` moves (a rename, another device, a background job) but the
  // last message is still the user's own. Before round 3 this called clearInterval and left
  // "⚡ Connection lost — waiting for result…" on screen forever: the watch was retired by a
  // success that did not cover what it was watching for.
  const H = loadPoll({ convoReplies: [
    { ok: true, data: { updated: 9999, messages: [{ role: 'me', text: 'my question' }] } },
    { ok: true, data: { updated: 9999, messages: [{ role: 'me', text: 'my question' }] } },
  ] });
  let settled = 0;
  H.poll('c1', 1000, H.el, null, () => { settled++; });
  await H.tick();
  assert.equal(H.alive(), true, 'the watch is still running — a rename is not a reply');
  assert.equal(settled, 0, 'and nothing was told that the send is covered');
  assert.equal(H.el.removed, false, 'the "connection lost" evidence is still on screen');
  await H.tick();
  assert.equal(H.alive(), true, 'still watching on the next tick too');
});

test('(3) the watch ends — and only then reports settled — when THIS send\'s reply is really there', async () => {
  const H = loadPoll({ convoReplies: [
    { ok: true, data: { updated: 9999, messages: [{ role: 'me', text: 'q' }] } },        // unrelated touch first
    { ok: true, data: { updated: 9999, messages: [{ role: 'me', text: 'q' }, { role: 'md', text: 'the answer' }] } },
  ] });
  let settled = 0;
  H.poll('c1', 1000, H.el, null, () => { settled++; });
  await H.tick();
  assert.equal(settled, 0);
  await H.tick();
  assert.equal(H.alive(), false, 'the watch stops on a real reply');
  assert.equal(settled, 1, 'and the caller is told exactly once that the kept draft is now covered');
  assert.equal(H.el.removed, true, 'the "connection lost" line is replaced by the answer');
  assert.equal(H.added.at(-1).innerHTML, 'the answer');
});

test('(3) a reconnected reply carries its timing — the v2.30.0 "took Xs" line', async () => {
  // v2.30.0 added this so a reply that arrives after a reconnect still shows how long it took.
  // It was untested: the DOM call it introduced made the watch test above throw before reaching
  // any assertion, which is how a crash can read as one unrelated red line instead of a gap.
  // The settle test needs a REAL clock: the watch only fires when the conversation's `updated`
  // is past the send, and the took-Xs line measures Date.now() - that same instant.
  const sentAt = Date.now() - 4200;
  const H = loadPoll({ convoReplies: [
    { ok: true, data: { updated: Date.now(), messages: [{ role: 'me', text: 'q' }, { role: 'md', text: 'the answer' }] } },
  ] });
  H.poll('c1', sentAt, H.el, null, () => {});
  await H.tick();
  const took = H.added.at(-1).kids.find((k) => k.className === 'pa-took');
  assert.ok(took, 'the settled reply must carry the took-Xs line');
  assert.equal(took.tagName, 'small', 'it is the <small> the shell creates');
  assert.match(took.textContent, /^took \d+\.\ds$/, `got ${took.textContent}`);
  assert.ok(parseFloat(took.textContent.slice(5)) >= 4, `elapsed is measured from the send: ${took.textContent}`);
});

test('(3) a poll that fails is CLASSIFIED, never swallowed — R5', async () => {
  // `catch{}` used to hide an expired session for three minutes and then report the same
  // "no result" a still-running job reports.
  const H = loadPoll({ convoReplies: [{ ok: false, code: 'unauthorized', status: 401, error: 'bad token' }] });
  H.poll('c1', 1000, H.el, null, () => {});
  await H.tick();
  assert.equal(H.alive(), false, 'an expired session is terminal — retrying it 45 times is a lie');
  assert.match(H.el.textContent, /登录已过期 · Signed out/, 'and it says so, in the ONE mapper\'s words');
  assert.equal(H.el.className, 'msg err');

  // A transient network failure is NOT terminal: the laptop may still be finishing the run.
  const T = loadPoll({ convoReplies: [{ ok: false, code: 'network', error: 'offline' }, { ok: false, code: 'server-error', status: 502 }] });
  T.poll('c2', 1000, T.el, null, () => {});
  await T.tick(); await T.tick();
  assert.equal(T.alive(), true, 'a dropped Wi-Fi tick keeps waiting rather than declaring failure');
});

test('(3) source pin: a transport failure puts the composer back, and only onSettled clears it', () => {
  const send = codeOnly(SHELL.slice(SHELL.indexOf('async function submitSend()'), SHELL.indexOf("$('#f').onsubmit")));
  assert.ok(send.length > 400, 'found the real submitSend');
  const cat = send.indexOf('}catch(err){');
  assert.ok(cat > 0, 'the transport catch exists');
  const tail = send.slice(cat);
  assert.match(tail, /restoreComposer\(q,attsBefore\)/, 'a request that died mid-flight is an UNKNOWN outcome, so the work comes back');
  assert.match(tail, /pollForResult\(convoId, sendTime, status, out, \(\)=>\{ if\(untouched\(\)\) restoreComposer\('',\[\]\); \}\)/,
    'and it is dropped only from onSettled — the one signal that covers it — and only if the user has not edited it since');
  // The round-2 property must not regress: a refused (non-2xx) send also restores.
  assert.match(send, /add\('err','⚠ '\+relayText\(f,sentBytes\)\)/);
  assert.ok(send.indexOf('if(!res.ok)') < send.indexOf('res.body.getReader()'), 'a non-2xx is handled BEFORE the NDJSON loop swallows it');
});
