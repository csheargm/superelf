// AgentMail email channel（邮件通道）— PLAN.md Phase B, v1 = DELIVERY only.
//
// Thin client for https://docs.agentmail.to (Bearer auth, JSON). Grounded
// endpoints (v0):
//   GET  /inboxes                        → { count, inboxes:[{ inbox_id, email, client_id?, ... }] }
//   POST /inboxes                        → { inbox_id, email, ... }   (username/domain optional — random when omitted)
//   POST /inboxes/{id}/messages/send     → { message_id, thread_id }
//
// Design contract:
//   - ONE inbox per superelf node. ensureInbox is create-or-get: the persisted
//     state file wins, else an existing inbox tagged with this node's client_id
//     is adopted (survives a deleted state file — free tier caps inboxes at 3,
//     so a re-create loop would exhaust it), else ONE inbox is created and
//     persisted. The inbox id lives in <root>/agentmail.json (config-adjacent
//     STATE, never hardcoded and never committed — root state files are local).
//   - sendEmail sends `text`, plus `html` ONLY when the caller passes one (the
//     send route takes both, docs.agentmail.to, checked 2026-10-21): the model
//     review's charts (docs/adr/0020). Without it the request is exactly
//     { to, subject, text }, as before. The house delivery rule (plain text
//     fallback, no emojis) is enforced upstream by lib/notify.mjs formatting;
//     this client stays a transport.
//   - Failure-faithful errors (R5a): every non-2xx throws an Error carrying
//     method, path, HTTP status and the server's message. The API key is never
//     echoed in errors, logs, or state.
//   - fetchImpl seam for tests — tests stub it
//     with the real API's JSON shapes; NEVER a real email in tests.
import path from 'node:path';
import fs from 'node:fs';
import { writeJsonFile } from './webutil.mjs';

export const AGENTMAIL_BASE = 'https://api.agentmail.to/v0';
const STATE_FILE = 'agentmail.json';

export class AgentMail {
  // key: cfg.agentmail_key. settings: cfg.agentmail (validated defaults in
  // lib/config.mjs — client_id tags this node's inbox; username/domain/
  // display_name optionally shape the address).
  constructor(key, { root, settings = {}, fetchImpl = fetch, base = AGENTMAIL_BASE } = {}) {
    if (!key) throw new Error('AgentMail: no API key');
    if (!root) throw new Error('AgentMail: no root dir for state');
    this.key = key; this.settings = settings; this.fetchImpl = fetchImpl;
    this.base = base; this.statePath = path.join(root, STATE_FILE);
    this.inbox = null; // memo of { inbox_id, email }
  }

  async call(method, apiPath, body) {
    const res = await this.fetchImpl(this.base + apiPath, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body: the status-based throw below already reports the failure honestly (R5c) */ }
    if (res.status < 200 || res.status >= 300) {
      const detail = data && (data.message || data.error) ? `: ${data.message || data.error}` : '';
      throw new Error(`agentmail ${method} ${apiPath} → HTTP ${res.status}${detail}`); // never includes the key
    }
    return data;
  }

  // The node's ONE inbox: state file → adopt by client_id → create + persist.
  async ensureInbox() {
    if (this.inbox && this.inbox.inbox_id && this.inbox.email) return this.inbox;
    const saved = this.readState();
    if (saved) { this.inbox = saved; return saved; }
    const tag = this.settings.client_id || 'superelf-node';
    const listed = await this.call('GET', '/inboxes');
    const mine = ((listed && listed.inboxes) || []).find((i) => i.client_id === tag);
    const box = mine || await this.call('POST', '/inboxes', {
      client_id: tag,
      ...(this.settings.username ? { username: this.settings.username } : {}),
      ...(this.settings.domain ? { domain: this.settings.domain } : {}),
      display_name: this.settings.display_name || 'superelf 管家',
    });
    if (!box || !box.inbox_id || !box.email) throw new Error('agentmail: inbox response missing inbox_id/email'); // R14: an empty reply is a failure, not an inbox
    this.inbox = { inbox_id: box.inbox_id, email: box.email };
    writeJsonFile(this.statePath, this.inbox); // atomic (shared helper, R3)
    return this.inbox;
  }

  readState() {
    try {
      const s = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      return s && s.inbox_id && s.email ? { inbox_id: s.inbox_id, email: s.email } : null;
    } catch { return null; } // absent/corrupt state → re-resolve via ensureInbox (adopt-or-create), which rewrites it
  }

  // Send: plain text, with an HTML part only when `html` is given. Returns { message_id, thread_id };
  // throws on any failure.
  async sendEmail({ to, subject, text, html }) {
    if (typeof to !== 'string' || !to.includes('@')) throw new Error(`agentmail sendEmail: bad "to" address`);
    const inbox = await this.ensureInbox();
    const out = await this.call('POST', `/inboxes/${encodeURIComponent(inbox.inbox_id)}/messages/send`,
      { to, subject: String(subject || ''), text: String(text || ''), ...(html ? { html: String(html) } : {}) });
    if (!out || !out.message_id) throw new Error('agentmail: send response missing message_id'); // R14: no id = not proven sent
    return { message_id: out.message_id, thread_id: out.thread_id };
  }
}
