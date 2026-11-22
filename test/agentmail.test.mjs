// AgentMail client (lib/agentmail.mjs) — the email channel's transport.
//
// The API is stubbed at the FETCH seam the real client exposes, with the real
// API's documented JSON shapes (docs.agentmail.to): GET/POST /inboxes and
// POST /inboxes/{id}/messages/send. NEVER a real email or a real HTTP call in
// tests (harness-fidelity rule); state roots are throwaway mkdtemp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentMail } from '../lib/agentmail.mjs';
import { stubAgentMail, AM_INBOX, AM_SENT } from './helpers.mjs';

const LIST_EMPTY = { status: 200, body: { count: 0, inboxes: [] } };
const LIST_MINE = { status: 200, body: { count: 2, inboxes: [
  { ...AM_INBOX, inbox_id: 'inb_other', email: 'other@agentmail.to', client_id: 'someone-else' },
  AM_INBOX,
] } };
const CREATED = { status: 200, body: AM_INBOX };
const API_401 = { status: 401, body: { message: 'Invalid API key' } };

const readState = (root) => JSON.parse(fs.readFileSync(path.join(root, 'agentmail.json'), 'utf8'));

// ── ensureInbox: create-or-get, ONE inbox per node ───────────────────────────
test('ensureInbox: persisted state answers with ZERO HTTP calls', async () => {
  const { mail, calls } = stubAgentMail([LIST_EMPTY]); // seeded state; any HTTP call would be a bug
  const inbox = await mail.ensureInbox();
  assert.deepEqual(inbox, { inbox_id: AM_INBOX.inbox_id, email: AM_INBOX.email });
  assert.equal(calls.length, 0, 'state file is the source of truth — no network');
});

test('ensureInbox: no state → ADOPTS the inbox tagged with this node\'s client_id (no create — free tier caps at 3)', async () => {
  const { mail, calls, root } = stubAgentMail([LIST_MINE], { seedState: false });
  const inbox = await mail.ensureInbox();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/inboxes$/);
  assert.deepEqual(inbox, { inbox_id: AM_INBOX.inbox_id, email: AM_INBOX.email }, 'the client_id match, not the first inbox');
  assert.deepEqual(readState(root), inbox, 'adopted inbox re-persisted');
});

test('ensureInbox: no state, no match → creates ONE inbox with the node tag and persists id+email ONLY', async () => {
  const { mail, calls, root } = stubAgentMail([LIST_EMPTY, CREATED], { seedState: false });
  const inbox = await mail.ensureInbox();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'POST');
  assert.match(calls[1].url, /\/inboxes$/);
  assert.equal(calls[1].headers.authorization, 'Bearer TEST_KEY');
  assert.deepEqual(calls[1].data, { client_id: 'superelf-node', display_name: 'superelf 管家' },
    'username/domain omitted when unconfigured — AgentMail generates a unique address (no collision on first run)');
  assert.deepEqual(readState(root), { inbox_id: AM_INBOX.inbox_id, email: AM_INBOX.email });
  assert.ok(!JSON.stringify(readState(root)).includes('TEST_KEY'), 'the API key never reaches state');
  await mail.ensureInbox();
  assert.equal(calls.length, 2, 'second call answered from the memo — no repeat HTTP');
  assert.equal(inbox.email, AM_INBOX.email);
});

test('ensureInbox: cfg.agentmail settings shape the created address', async () => {
  const settings = { username: 'guanjia', domain: 'agentmail.to', display_name: 'X', client_id: 'node-2' };
  const { mail, calls } = stubAgentMail([LIST_EMPTY, CREATED], { seedState: false, settings });
  await mail.ensureInbox();
  assert.deepEqual(calls[1].data, { client_id: 'node-2', username: 'guanjia', domain: 'agentmail.to', display_name: 'X' });
});

// ── sendEmail: real route, real shapes; html only when the caller gives one ──
test('sendEmail: POSTs {to,subject,text} to the inbox send route — no html key when none is given', async () => {
  const { mail, calls } = stubAgentMail([{ status: 200, body: AM_SENT }]);
  const out = await mail.sendEmail({ to: 'mom@example.com', subject: '健康简报 · Weekly', text: 'Trends fine 趋势正常' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].url, new RegExp(`/inboxes/${AM_INBOX.inbox_id}/messages/send$`));
  assert.equal(calls[0].headers.authorization, 'Bearer TEST_KEY');
  assert.deepEqual(calls[0].data, { to: 'mom@example.com', subject: '健康简报 · Weekly', text: 'Trends fine 趋势正常' },
    'exactly these fields — every briefing but the model review sends plain text only, as before');
  assert.deepEqual(out, { message_id: 'msg_1', thread_id: 'thr_1' });
});

test('sendEmail: an html part goes beside the text (multipart), on the same route (docs/adr/0020)', async () => {
  const { mail, calls } = stubAgentMail([{ status: 200, body: AM_SENT }]);
  await mail.sendEmail({ to: 'mom@example.com', subject: '模型评测 · Model review', text: 'No change', html: '<table><tr><td>No change</td></tr></table>' });
  assert.deepEqual(calls[0].data, { to: 'mom@example.com', subject: '模型评测 · Model review', text: 'No change',
    html: '<table><tr><td>No change</td></tr></table>' }, 'both parts, the text as the fallback');
  assert.match(calls[0].url, /\/messages\/send$/);
});

test('sendEmail: a bad "to" address fails loud with no HTTP call', async () => {
  const { mail, calls } = stubAgentMail([{ status: 200, body: AM_SENT }]);
  await assert.rejects(() => mail.sendEmail({ to: 'not-an-address', subject: 's', text: 't' }), /bad "to"/);
  await assert.rejects(() => mail.sendEmail({ subject: 's', text: 't' }), /bad "to"/);
  assert.equal(calls.length, 0);
});

// ── failure-faithful errors (R5a / R14) ──────────────────────────────────────
test('errors carry method, path, HTTP status and the server message — NEVER the API key', async () => {
  const { mail } = stubAgentMail([API_401], { seedState: false });
  await assert.rejects(() => mail.ensureInbox(), (e) => {
    assert.match(e.message, /agentmail GET \/inboxes → HTTP 401: Invalid API key/);
    assert.ok(!e.message.includes('TEST_KEY'), 'the key must never leak into errors');
    return true;
  });
});

test('R14: a 200 with a malformed body is a FAILURE, not an inbox / not a send', async () => {
  const { mail } = stubAgentMail([LIST_EMPTY, { status: 200, body: {} }], { seedState: false });
  await assert.rejects(() => mail.ensureInbox(), /missing inbox_id/);
  const { mail: m2 } = stubAgentMail([{ status: 200, body: {} }]);
  await assert.rejects(() => m2.sendEmail({ to: 'a@b.co', subject: 's', text: 't' }), /missing message_id/);
});

test('constructor refuses to exist without a key or a state root (no half-configured client)', () => {
  assert.throws(() => new AgentMail('', { root: '/tmp' }), /no API key/);
  assert.throws(() => new AgentMail('k', {}), /no root/);
});

// ── corrupt state: re-resolve, never crash ───────────────────────────────────
test('corrupt agentmail.json → re-resolves via adopt-or-create and rewrites it', async () => {
  const { mail, calls, root } = stubAgentMail([LIST_MINE], { seedState: false });
  fs.writeFileSync(path.join(root, 'agentmail.json'), '{not json');
  const inbox = await mail.ensureInbox();
  assert.equal(calls.length, 1, 'fell through to the list-adopt path');
  assert.deepEqual(readState(root), inbox, 'state healed');
});
