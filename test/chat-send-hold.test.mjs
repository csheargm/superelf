// The composer's double send · 连续发送 (web/index.html submitSend + convoIdWait)
//
// THE BUG (code reading, report section 2.4): `convoId` is set only when the server's
// {type:'convo'} line arrives. A second send typed before that went out with convoId=null and
// started a NEW conversation — every bit of context lost. Now it waits for the convo line (or for
// the first send to end), then goes to the same conversation, where the server queues it.
//
// The REAL submitSend from the shell as served, in a fake DOM: `api` is a controllable fake
// stream, timers are stubbed (never a real setTimeout here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);
const START = SHELL.indexOf('/* ── Send ── */');
const END = SHELL.indexOf("$('#f').onsubmit");
const SRC = SHELL.slice(START, END);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function load() {
  assert.ok(START > 0 && END > START && SRC.includes('async function submitSend()'), 'found the real submitSend');
  const box = { value: '' };
  const node = () => ({ className: '', innerHTML: '', textContent: '', remove() {}, querySelector: () => null });
  const sent = [];    // { body, push(line), end() } per request
  const H = { box, sent, convo: null };
  const api = async (_url, opts) => {
    const q = []; let wake = null; let ended = false;
    const enc = new TextEncoder();
    const req = { body: JSON.parse(opts.body),
      push: (o) => { q.push(enc.encode(JSON.stringify(o) + '\n')); if (wake) wake(); },
      end: () => { ended = true; if (wake) wake(); } };
    sent.push(req);
    return { ok: true, body: { getReader: () => ({ read: async () => {
      for (;;) {
        if (q.length) return { done: false, value: q.shift() };
        if (ended) return { done: true };
        await new Promise((r) => { wake = r; });
      }
    } }) } };
  };
  const env = {
    $: (s) => (s === '#box' ? box : { scrollTop: 0, scrollHeight: 0 }), add: node, addActions() {}, renderAtts() {},
    buildMessage: (m) => { box.value = ''; return m; }, api, setConvo: (id) => { H.convo = id; }, loadConvos() {}, loadApps() {},
    relayBodyBytes: (b) => b.length, took: () => '', renderMd: (t) => t, addTook() {}, restoreComposer() {},
    relayHttpFail() {}, relayText: () => '', relayNetFail() {}, pollForResult() {}, renderJobDraft() {},
    setInterval: () => 0, clearInterval() {},
  };
  const names = Object.keys(env);
  // convoId lives in the shell's scope; setConvo writes it, as the real one does.
  const factory = new Function(...names, `let convoId=null, attachments=[], lastPromptText='', SHELL_CURMODEL=null, shellVerifyOn=false;
    const realSetConvo=setConvo; setConvo=(id)=>{ convoId=id; realSetConvo(id); };
    ${SRC}
    return { submitSend, getConvo: () => convoId };`);
  return { ...H, ...factory(...names.map((n) => env[n])) };
}

test('a second send before the convo line arrives waits, then goes to the SAME conversation', async () => {
  const H = load();
  H.box.value = 'create a counter app';
  const s1 = H.submitSend();
  await flush();
  H.box.value = 'add reset, big and blue';
  const s2 = H.submitSend();
  await flush();
  assert.equal(H.sent.length, 1, 'the follow-up is held while the first send has no conversation id');
  H.sent[0].push({ type: 'convo', id: 'C1', title: 't' });
  await flush();
  assert.equal(H.sent.length, 2, 'released by the convo line — not by the end of the first turn');
  assert.equal(H.sent[1].body.convoId, 'C1', 'and it names the first send\'s conversation');
  assert.equal(H.sent[0].body.convoId, null, 'CONTROL: the first send really started without an id');
  H.sent[0].push({ type: 'done', ok: true, text: 'a' }); H.sent[0].end();
  H.sent[1].push({ type: 'convo', id: 'C1' }); H.sent[1].push({ type: 'done', ok: true, text: 'b' }); H.sent[1].end();
  await Promise.all([s1, s2]);
});

test('a first send that ends WITHOUT a convo line still releases the held send (no hang)', async () => {
  const H = load();
  H.box.value = 'one'; const s1 = H.submitSend(); await flush();
  H.box.value = 'two'; const s2 = H.submitSend(); await flush();
  assert.equal(H.sent.length, 1);
  H.sent[0].push({ type: 'error', text: 'nope' }); H.sent[0].end();
  await s1; await flush();
  assert.equal(H.sent.length, 2, 'released when the first send ended');
  assert.equal(H.sent[1].body.convoId, null, 'no id was learned, so it starts its own conversation');
  H.sent[1].end(); await s2;
});

test('CONTROL: with a known conversation, sends are never held on the client', async () => {
  const H = load();
  H.box.value = 'one'; const s1 = H.submitSend(); await flush();
  H.sent[0].push({ type: 'convo', id: 'C9' }); await flush();
  H.box.value = 'two'; const s2 = H.submitSend(); await flush();
  H.box.value = 'three'; const s3 = H.submitSend(); await flush();
  assert.equal(H.sent.length, 3, 'both follow-ups went out at once (the server queues them)');
  assert.deepEqual(H.sent.slice(1).map((r) => r.body.convoId), ['C9', 'C9']);
  for (const r of H.sent) r.end();
  await Promise.all([s1, s2, s3]);
});
