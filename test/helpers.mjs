// Shared test doubles — ONE module (R3): mkUser / mkAudit were copy-pasted
// byte-identical across the approval-loop suites, so a seam change fixed in one
// copy could leave another suite green against a stale contract (harness-fidelity
// rule). Import from here; never re-declare per suite.
//
// mkUser returns a throwaway mkdtemp workspace — never a live instance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const mkUser = (prefix = 'pa-', extra = {}) =>
  ({ id: 'owner', status: 'active', workspace: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), ...extra });

export const mkAudit = () => { const events = []; return { events, audit: (ev, extra) => events.push({ ev, ...extra }) }; };

// ── AgentMail (email channel, PLAN.md Phase B) ───────────────────────────────
// stubAgentMail stubs the AgentMail API at the FETCH seam the real client
// exposes (lib/agentmail.mjs `new AgentMail(key, { fetchImpl })`), replying
// with the real API's JSON shapes (docs.agentmail.to) — so the client's auth
// header, error mapping, inbox persistence, and R14 guards run for real.
// NEVER a real email or a real HTTP call in tests. `seedState` pre-writes the
// persisted inbox state so only the calls under test reach the stub.
import { AgentMail } from '../lib/agentmail.mjs';

export const AM_INBOX = { pod_id: 'pod_1', inbox_id: 'inb_test1', email: 'node-abc@agentmail.to',
  client_id: 'superelf-node', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z' };
export const AM_SENT = { message_id: 'msg_1', thread_id: 'thr_1' };

export function stubAgentMail(replies = [{ status: 200, body: AM_SENT }], { seedState = true, settings = {} } = {}) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, data: opts.body ? JSON.parse(opts.body) : null });
    const r = replies[Math.min(i++, replies.length - 1)];
    return { status: r.status, json: async () => r.body };
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-am-'));
  if (seedState) fs.writeFileSync(path.join(root, 'agentmail.json'), JSON.stringify({ inbox_id: AM_INBOX.inbox_id, email: AM_INBOX.email }));
  return { mail: new AgentMail('TEST_KEY', { root, settings, fetchImpl }), calls, root };
}
