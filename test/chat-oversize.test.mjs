// DEFECT V4 (2026-09-02, round 2) — an oversize /api/chat is STRUCTURALLY INVISIBLE.
//
// WHAT WAS PROVEN BROKEN, and is regressed here
//   The server answered a too-large chat body with `413 application/json {...}` and NO
//   trailing newline. /api/chat streams application/x-ndjson, and every chat reader in the
//   tree consumes it as `while (buf.indexOf('\n') >= 0)`. So the error line was never
//   parsed, the reader ended, nothing threw, the catch that says "connection lost" never
//   ran — and the composer, already cleared, sat on "…" forever. The user's message was
//   gone and no surface anywhere said why. Same class as the notebook freeze, on the route
//   people touch most.
//
// WHAT THIS FILE ASSERTS, and at which layer
//   1. HTTP (real server, real caps, throwaway root): /api/chat and /api/upload answer the
//      SAME 413 shape as /api/save-data — {ok:false, code:'too-large', limit, …} — and the
//      body is NDJSON-readable.
//   2. The reader itself: the verbatim line loop both chat readers use, run over the real
//      413 bytes, now yields one terminal error event. The CONTROL (R14) is the old body
//      with the newline removed: the same loop yields ZERO events and never throws — if
//      that control ever passes, this test is measuring nothing and says so.
//   3. The component (web/chat-ui.inline.html): its REAL size helpers, extracted and run,
//      turn that event into the bilingual "Message too large · 消息过长" with the limit.
//   4. R3 across the language boundary: an inline browser component cannot import
//      lib/webutil.mjs, so the constants it copies are pinned against BODY_LIMITS /
//      CODE_TOO_LARGE here. Drift fails the suite.
//
// HONEST LIMIT (R14): PAChat's send() needs a live DOM, so its ORDER — refuse before the
// composer is cleared — is checked as a source-order pin, not a DOM run. Building a fake
// DOM for a component this size would be exactly the lenient mock that caused the incident,
// so the pin is deliberately labelled for what it is.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';
import { BODY_LIMITS, CODE_TOO_LARGE, humanBytes } from '../lib/webutil.mjs';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPONENT = fs.readFileSync(path.join(ROOT, 'web', 'chat-ui.inline.html'), 'utf8');

// ── The component's REAL size helpers, extracted and executed ────────────────
// Same technique as test/note-save.test.mjs: slice the DOM-free block out of the shipped
// file and run it. If the block moves or is renamed the extraction fails loudly rather
// than silently testing nothing.
function loadSizeHelpers() {
  const from = COMPONENT.indexOf('  const PAC_LIMITS=');
  const to = COMPONENT.indexOf('\n  const esc=s=>');
  assert.ok(from > 0 && to > from, 'the size helpers must stay a DOM-free block above const esc=');
  const src = COMPONENT.slice(from, to);
  assert.match(src, /pacChatBytes/, 'the extraction really found the helpers, not an empty slice');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn {PAC_LIMITS,PAC_TOO_LARGE,PAC_ENVELOPE_BYTES,pacBytes,pacHuman,pacChatBytes,pacTooLargeText,pacTooLargeLimit};`)();
}
const C = loadSizeHelpers();

// The line loop both chat readers use, over a real Response. Returns the events it parsed
// and whether it threw — the two things that decide if a failure is visible or invisible.
async function ndjsonEvents(res) {
  const rd = res.body.getReader(); const dec = new TextDecoder();
  let buf = ''; const events = []; let threw = null;
  try {
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const t = buf.slice(0, i); buf = buf.slice(i + 1); if (!t.trim()) continue;
        let j; try { j = JSON.parse(t); } catch { continue; }
        events.push(j);
      }
    }
  } catch (e) { threw = e; }
  return { events, threw, unparsed: buf };
}

let port, root, web;
before(async () => { port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port); });
after(async () => { await stopWeb(web); rmTemp(root); });

test('harness fidelity: the real server really does refuse an oversize chat body (nothing here is a stub)', async () => {
  const small = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify({ message: '' }) });
  assert.notEqual(small.status, 413, 'an ordinary body is NOT refused — the cap is a cap, not a wall');
  const big = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify({ message: 'x'.repeat(BODY_LIMITS.chat) }) });
  assert.equal(big.status, 413, 'and a body past BODY_LIMITS.chat is');
});

test('/api/chat oversize: the 413 carries the SAME machine-readable shape as every other route', async () => {
  const r = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify({ message: 'x'.repeat(BODY_LIMITS.chat) }) });
  assert.equal(r.status, 413);
  assert.equal(r.headers.get('content-type'), 'application/json');
  const raw = await r.text();
  const j = JSON.parse(raw);
  assert.equal(j.ok, false);
  assert.equal(j.code, CODE_TOO_LARGE, 'one code for every route — the client reacts once (R3)');
  assert.equal(j.limit, BODY_LIMITS.chat, 'with the number the client can measure itself against');
  assert.equal(j.type, 'error', 'and the terminal event type an NDJSON reader already handles');
  assert.match(j.error, /Too large · 内容过大/, 'bilingual');
  assert.match(j.error, new RegExp(humanBytes(BODY_LIMITS.chat)), 'and it names the limit in words');
  assert.ok(raw.endsWith('\n'), 'NDJSON-readable: without this the reader below parses nothing');
});

test('the chat NDJSON reader now SEES the 413 — and the old body proves the control is not vacuous', async () => {
  const r = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify({ message: 'x'.repeat(BODY_LIMITS.chat) }) });
  const got = await ndjsonEvents(r);
  assert.equal(got.threw, null, 'the loop does not throw — which is exactly why a catch could never rescue this');
  assert.equal(got.events.length, 1, 'and it parses the refusal instead of ending silently');
  assert.equal(got.events[0].code, CODE_TOO_LARGE);
  assert.equal(got.events[0].type, 'error');
  assert.equal(got.unparsed, '', 'nothing is left stranded in the buffer');
  // CONTROL (R14): the SAME loop over the SAME bytes with the newline removed — the body
  // that shipped during the incident. If this ever parses an event, the fix above is not
  // what makes the failure visible and this test is measuring nothing.
  const oldBody = JSON.stringify(got.events[0]); // no trailing newline
  const fake = new Response(oldBody, { headers: { 'content-type': 'application/json' } });
  const control = await ndjsonEvents(fake);
  assert.equal(control.events.length, 0, 'CONTROL: the pre-fix body parses to nothing…');
  assert.equal(control.threw, null, '…and never throws — a permanent "…" with no error path');
  assert.equal(control.unparsed, oldBody, 'the error sat in the buffer, unread, forever');
});

test('/api/upload oversize: the attachment route answers the same 413 shape, with ITS limit', async () => {
  const r = await api(port, '/api/upload', { method: 'POST', body: JSON.stringify({ name: 'big.bin', data: 'A'.repeat(BODY_LIMITS.upload) }) });
  assert.equal(r.status, 413);
  const j = await r.json();
  assert.equal(j.code, CODE_TOO_LARGE);
  assert.equal(j.limit, BODY_LIMITS.upload, 'the upload cap, not the chat cap — each route states its own');
  assert.equal(fs.existsSync(path.join(root, 'workspace', 'uploads')), false, 'nothing was written for a refused upload');
});

// ── R3 across the language boundary ─────────────────────────────────────────
test('R3: the numbers and the code inside chat-ui.inline.html are the server\'s own', () => {
  assert.equal(C.PAC_LIMITS.chat, BODY_LIMITS.chat, 'PAC_LIMITS.chat must equal BODY_LIMITS.chat — a stale copy refuses the wrong messages');
  assert.equal(C.PAC_LIMITS.upload, BODY_LIMITS.upload);
  assert.equal(C.PAC_TOO_LARGE, CODE_TOO_LARGE, 'the component reads the code the server sends');
  assert.equal(C.pacHuman(BODY_LIMITS.chat), humanBytes(BODY_LIMITS.chat), 'and renders the limit the same way the server does');
  assert.equal(C.pacHuman(BODY_LIMITS.upload), humanBytes(BODY_LIMITS.upload));
});

test('R3: the bilingual heading a user reads is the SAME sentence in the shell and in the component', () => {
  // The shell (web/index.html) and this sandboxed component are separate execution
  // contexts — the iframe has an opaque origin and cannot read the shell's constants — so
  // the wording exists twice by necessity. Pinned on the STRING, not the constant name, so
  // it survives a rename in either file but fails the moment the wording drifts apart.
  const shell = readShell(ROOT);
  for (const heading of ['Message too large · 消息过长', 'File too large · 文件过大']) {
    assert.ok(shell.includes(heading), `the shell says: ${heading}`);
  }
  assert.ok(C.pacTooLargeText('Message', 1, 2).startsWith('Message too large · 消息过长'), 'and so does the component');
  assert.ok(C.pacTooLargeText('File', 1, 2).startsWith('File too large · 文件过大'));
});

test('the component measures UTF-8 BYTES, not characters — 中文 is 3 bytes and the cap is in bytes', () => {
  assert.equal(C.pacBytes('abc'), 3);
  assert.equal(C.pacBytes('恩典'), 6, 'character counting would under-count this by 3× and send an oversize body anyway');
  assert.equal(C.pacBytes(null), 0);
  const zh = '恩'.repeat(200000);                    // 600,000 bytes but only 200,000 characters
  assert.ok(zh.length < BODY_LIMITS.chat, 'the character count alone is under the cap…');
  assert.ok(C.pacChatBytes(zh, null, [], undefined, undefined) < BODY_LIMITS.chat);
  const zh2 = '恩'.repeat(400000);                   // 1.2 MB of UTF-8
  assert.ok(zh2.length < BODY_LIMITS.chat, '…and so is this one…');
  assert.ok(C.pacChatBytes(zh2, null, [], undefined, undefined) > BODY_LIMITS.chat, '…but the real body is over, and the component knows it');
});

test('the pre-flight counts the WHOLE payload — an app\'s context prefix is what pushes it over', () => {
  // The real shape: a short question, and an app (Bible/notes) prefixing a whole chapter.
  const question = 'What does this mean? 这是什么意思？';
  assert.ok(C.pacChatBytes(question, null, [], 'John 3', 'reply in Chinese') < BODY_LIMITS.chat, 'the question alone is nowhere near the cap');
  const withContext = 'Context:\n' + 'x'.repeat(BODY_LIMITS.chat) + '\nQuestion: ' + question;
  assert.ok(C.pacChatBytes(withContext, null, [], 'John 3', 'reply in Chinese') > BODY_LIMITS.chat,
    'the payload the user never sees is the one that breaks the cap — measuring the typed text alone would miss it');
  // The envelope the shell adds is reserved for, so the refusal happens on OUR side of the
  // wire (explainable) rather than the server's (silent, pre-fix).
  assert.ok(C.PAC_ENVELOPE_BYTES > 0);
  assert.ok(C.pacChatBytes('', null, [], undefined, undefined) >= C.PAC_ENVELOPE_BYTES);
});

test('the notice is bilingual, names BOTH sizes, and reads the code — never the prose', () => {
  const msg = C.pacTooLargeText('Message', 1_500_000, BODY_LIMITS.chat);
  assert.match(msg, /Message too large · 消息过长/, 'the exact bilingual heading the task names');
  assert.match(msg, /1\.4 MB/, 'how big it actually is');
  assert.match(msg, new RegExp(`max ${humanBytes(BODY_LIMITS.chat)}`), 'and how big it may be');
  assert.match(msg, /Shorten it|请缩短/, 'plus what to do about it');
  const file = C.pacTooLargeText('File', 30 * 1024 * 1024, BODY_LIMITS.upload);
  assert.match(file, /File too large · 文件过大/, 'the attachment surface reuses the same sentence with a file heading (R3)');
  // Detection: the machine-readable code first, the 413 status as a fallback, and NEVER a
  // prose match — a reworded or translated message must not silently become a success.
  assert.equal(C.pacTooLargeLimit({ ok: false, code: CODE_TOO_LARGE, limit: 4242 }), 4242);
  assert.equal(C.pacTooLargeLimit({ ok: false, status: 413, limit: 99 }), 99, 'a relay that forwards only the status still works');
  assert.equal(C.pacTooLargeLimit({ ok: true, path: 'uploads/x' }), null, 'a success is never mistaken for a refusal');
  assert.equal(C.pacTooLargeLimit({ ok: false, code: 'server-error' }), null, 'and a different failure is not dressed up as a size problem');
  assert.equal(C.pacTooLargeLimit(null), null);
});

// ── Source-order pins (labelled: not a DOM run) ─────────────────────────────
test('send() refuses BEFORE it clears the composer — the incident cleared it and then failed', () => {
  // `send(text` not `send(text){`: the signature gained a host-options argument (summary images) and
  // the pin must follow the function, not its arity.
  const body = COMPONENT.slice(COMPONENT.indexOf('    async function send(text'), COMPONENT.indexOf('    function autosize()'));
  assert.ok(body.length > 200, 'found the real send()');
  const preflight = body.indexOf('if(bytes>PAC_LIMITS.chat)');
  const clear = body.indexOf("el.inp.value=''");
  assert.ok(preflight > 0, 'the pre-flight check exists');
  assert.ok(clear > 0 && preflight < clear, 'and runs before the composer is emptied, so a refused message is still there to edit');
  assert.ok(body.indexOf('atts=[]') > preflight, 'the attachment chips survive a refusal too');
  // Intent: the refusal STOPS the send. Which return value it carries is not the contract —
  // this pinned the literal `return;` and broke when send() started resolving false so a
  // programmatic caller could tell a refusal from a delivery. Same behaviour, false alarm.
  assert.match(body.slice(preflight, clear), /return\s*(?:false\s*)?;/, 'and the refusal really stops the send');
  // The lie this replaces: any failure fell through to "No response — try rephrasing."
  assert.match(body, /if\(failure\)/, 'a recorded failure is rendered as a failure…');
  const noResp = body.lastIndexOf("thinking.textContent='No response — try rephrasing.'"); // the statement, not the comment that explains it
  assert.ok(noResp > body.indexOf('else if(failure)'), '…and "try rephrasing" is now only the last, genuinely-empty case');
});

test('the attachment picker surfaces the server\'s reason instead of "upload failed"', () => {
  const onchange = COMPONENT.slice(COMPONENT.indexOf('el.file.onchange='), COMPONENT.indexOf('if(opts.placeholder)'));
  assert.ok(onchange.length > 200, 'found the real picker');
  // 2026-09-11 (PAPhoto): read + pre-flight + upload + failure sentence moved OUT of this
  // handler into the shared photo component — they were one of four divergent copies. The
  // properties this test has always been about did not change owner:
  //   · the pre-flight still runs against PAChat.limits, which IS the PAC_LIMITS pinned to
  //     BODY_LIMITS above (test/photo-component.test.mjs executes and MUTATES that guard);
  //   · the server's reason still reaches the user, now as the outcome's own `text`.
  // What is pinned HERE is that the picker kept no second copy of either (R1/R3).
  assert.match(onchange, /PAPhoto\.upload\(/, 'the upload goes through the ONE shared photo path');
  assert.equal(/new FileReader\(/.test(onchange), false, 'and the picker no longer carries its own reader');
  assert.equal(/PAC_LIMITS/.test(onchange), false, 'nor its own pre-flight against a second copy of the cap');
  assert.match(onchange, /up\.text/, 'the reason that path produced is what the user reads');
  assert.equal(/Photo upload failed — try again\./.test(onchange), false, 'the generic message that hid every reason is gone');
});
