// The composer's Stop · 停止 (F4-3): POST /api/chat/stop ends the running turn of a conversation.
//
// END TO END (R6): the real web.mjs on an ephemeral port with a FAKE `claude` that answers after
// FAKE-SLOW <ms> and records when it finished. Stop kills it: it never finishes, the stream ends at
// once and the conversation stores "已取消 · Cancelled" — not the slow answer, not an empty reply.
// CONTROL (R14): a turn nobody stopped still finishes with its answer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const fakeClaude = (log) => `#!/usr/bin/env node
import fs from 'node:fs';
const rec = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(o) + '\\n');
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const slow = /FAKE-SLOW (\\d+)/.exec(s); const tag = /(T-[\\w-]+)/.exec(s)[1];
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-' + tag }) + '\\n');
  setTimeout(() => { rec({ ev: 'finished', tag });
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ANSWERED ' + tag, session_id: 'sid-' + tag }) + '\\n'); }, slow ? Number(slow[1]) : 0);
});
`;

let port, root, web, log;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, max_concurrent: 4 } });
  log = path.join(root, 'finished.jsonl');
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', fakeClaude(log));
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root);
  await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (root) rmTemp(root); });

const finished = (tag) => { try { return fs.readFileSync(log, 'utf8').includes(`"${tag}"`); } catch { return false; } };   // no file yet = nothing finished
const auth = { authorization: `Bearer ${OWNER_TOKEN}` };

async function startTurn(message) {
  const res = await api(port, '/api/chat', { method: 'POST', headers: auth, body: JSON.stringify({ message }) });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (!buf.includes('\n')) buf += dec.decode((await reader.read()).value, { stream: true });
  const id = JSON.parse(buf.slice(0, buf.indexOf('\n'))).id;
  const rest = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
    return buf.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); })();
  return { id, rest };
}
const stop = (convoId, headers = auth) => api(port, '/api/chat/stop', { method: 'POST', headers, body: JSON.stringify({ convoId }) }).then((r) => r.json());

test('Stop ends a running conversation turn at once and stores 已取消 · Cancelled', async () => {
  const tag = `T-stop-${Date.now()}`;
  const t0 = Date.now();
  const { id, rest } = await startTurn(`think hard FAKE-SLOW 6000 ${tag}`);
  await new Promise((r) => setTimeout(r, 300));   // the fake is spawned and working
  assert.deepEqual(await stop(id), { ok: true, stopped: true });
  const events = await rest;
  assert.ok(Date.now() - t0 < 4000, 'the stream ended long before the slow answer');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done, `a done line: ${JSON.stringify(events)}`);
  assert.equal(done.text, '已取消 · Cancelled');
  const c = await (await api(port, `/api/convos/${id}`)).json();
  assert.equal(c.messages.at(-1).text, '已取消 · Cancelled');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(finished(tag), false, 'the agent process was killed, not left to finish');
  assert.deepEqual(await stop(id), { ok: true, stopped: false }, 'a second Stop finds nothing running');
});

test('CONTROL: an unstopped turn finishes with its answer; a bad convoId stops nothing', async () => {
  const tag = `T-run-${Date.now()}`;
  const { id, rest } = await startTurn(`quick FAKE-SLOW 200 ${tag}`);
  assert.deepEqual(await stop('no-such-convo'), { ok: true, stopped: false });
  const done = (await rest).find((e) => e.type === 'done');
  assert.equal(done.text, `ANSWERED ${tag}`);
  assert.ok(finished(tag));
  assert.ok(id);
});

test('Stop needs a signed-in caller', async () => {
  const r = await api(port, '/api/chat/stop', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
  assert.equal(r.status, 401);
});
