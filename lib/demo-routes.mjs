// The demo node's own routes and gates · 演示节点路由 (lib/demo.mjs has the rules). web.mjs hands
// every request here first when demo mode is on; `handle` answers true when it sent the reply.
// The chat route is a SEPARATE, Ollama-only handler — not web.mjs chat() with a flag — so no
// code path in demo mode can reach the Claude/Codex agent lanes, the job resolver, Verify, or
// the agent fallback: the lane is chosen from provider 'ollama' entries only, or refused.
import { makeDeleteAccount } from './demo-account.mjs';
import { DEMO_DELETE_PATH, DEMO_REFUSED, DEMO_START_PATH, DEMO_COOKIE, demoRouteAllowed, readCookie, demoCookie } from './demo.mjs';
import { clientIp, trustCf, checkDisk, consumeAiCall, consumeVisit, consumeSearch, consumeAppBuild, demoLimit, QUOTA_MESSAGES } from './demo-quota.mjs';
import { makeBuildJobs, buildingText, appLink, BUILD_JOB_PATH } from './demo-build-job.mjs';
import fs from 'node:fs';
import { slugOk, BODY_READ_TIMEOUT_MS } from './webutil.mjs';
import { FILE_OK, FILE_UNREADABLE } from './readjson.mjs';
import { REPLY_LANGUAGE_RULE } from './config.mjs';
import { turnErrorText } from './chat-outcome.mjs';
import { convoReachable, convoTag } from './agent-origin.mjs';
import { APP_MARKER, appIntentRule, parseIntent, ownApps } from './demo-app.mjs';
import { SEARCH_MARKER, SEARCH_RULE } from './demo-search.mjs';
import { searchTurn } from './demo-search-turn.mjs';
import { AUTH_HEADER, SIGNIN_CODE, DEMO_SIGNIN_BAD, DEMO_SIGNIN_DOWN, sbUserId, makeSigninGate } from './demo-auth.mjs';
import path from 'node:path';
import { addMissingStarterApps } from './demo-starter-apps.mjs';
import { makeDemoAsk, DEMO_ASK_PATH } from './demo-ask.mjs';
import { WAITLIST_PATH, WAITLIST_BODY_LIMIT, addToWaitlist } from './demo-waitlist.mjs';

const JSON_TYPE = 'application/json';
const bearerOf = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const HISTORY_TURNS = 20;
const SESSIONS_PER_VISITOR = 3;
export const DEMO_NO_LANE = 'No demo chat model is configured · 演示未配置聊天模型';
export const DEMO_BUSY = 'Your previous reply is still coming — one at a time in the demo · 上一条回复尚未完成，演示版一次一条';
export const DEMO_HAS_ACCOUNTS = 'This demo node is misconfigured (it has accounts) · 演示节点配置有误（存在账户）';
export const DEMO_NO_VERIFY = 'Verify is not available in the demo — one model answers · 演示版不提供校验，由单一模型回答';
export const DEMO_FULL = 'The demo is busy right now — please try again in a minute · 演示当前繁忙，请稍后再试';
export const DEMO_SAVE_BUSY = 'Still saving your last change — try again in a moment · 上一次保存尚未完成，请稍后再试';
// Writes that grow a visitor's folder: refused once a disk cap is reached (web.mjs then writes).
const DISK_GATED = new Set(['POST /api/save-data', 'PUT /api/profile']);

export function makeDemoRoutes(d) {
  const json = (res, code, obj, extra) => d.send(res, code, JSON_TYPE, JSON.stringify(obj), extra);
  const disk = (user) => checkDisk({ cfg: d.cfg, rootDir: d.root, userDir: user && user.workspace, meter: d.meter });
  const ipOf = (req) => clientIp(req.headers, req.socket && req.socket.remoteAddress, trustCf(d.cfg));
  const gate = d.gate || makeSigninGate({ cfg: d.cfg, verifier: d.verifier });   // web.mjs passes its own: userFor checks it too
  // A returning visitor gets starter apps added since their workspace was seeded (lib/demo-starter-apps.mjs).
  function offerStarters(user) {
    if (!disk(user).ok) return;   // over a cap: no new files; offered again on a later visit
    try { const added = addMissingStarterApps(path.join(d.root, 'workspace.example'), user.workspace); if (added.length) d.audit('demo-starters', { who: user.id, added }); }
    catch (e) { d.audit('demo-starters-failed', { who: user.id, error: e.message }); /* the visit still starts: the starters are offered again next visit */ }
  }
  let inflight = 0, chatting = 0;   // gated writes and chat turns in flight on the whole node
  const busy = new Set();      // visitors with a chat turn streaming
  const renaming = new Set();  // visitors with a rename in flight: a chat turn waits for it, as it waits for the turn
  const deleteAccount = makeDeleteAccount(d, gate, (id) => busy.has(id) || saving.has(id) || renaming.has(id) || jobs.running(id));   // a build writes into the workspace
  const saving = new Set();    // visitors with a gated write in flight (a save may run beside a chat: an app binds the new chat id mid-reply)

  // A signed-in visitor (Supabase token in AUTH_HEADER): verified, then their own `sb-` workspace.
  // The same visitor's live session (Bearer) is kept and the fresh token rebound — a refresh every
  // hour must not mint sessions. A bad token is a 401 the browser answers by signing out.
  async function startSigned(req, res, token) {
    let v;
    try { v = await gate.verify(token); }
    catch { return json(res, 503, { ok: false, code: 'demo_signin_down', error: DEMO_SIGNIN_DOWN }); }   // Supabase unreachable: said, not a sign-out
    if (!v.ok || !gate.issuedAfterOut(sbUserId(v.sub), v.iat)) return json(res, 401, { ok: false, code: SIGNIN_CODE, error: DEMO_SIGNIN_BAD });
    const id = sbUserId(v.sub), current = d.userFor(req), bearer = bearerOf(req);
    if (current && current.id === id) {
      gate.bind(bearer, id, token, v.exp);
      offerStarters(current);
      return json(res, 200, { ok: true, token: bearer, uid: id, name: current.name, role: current.role, demo: true }, { 'cache-control': 'no-store' });
    }
    const known = d.users.get(id), full = disk(null);
    if (!known && !full.ok) return json(res, full.status, full);
    if (full.ok) {
      const q = consumeVisit({ cfg: d.cfg, store: d.store, ip: ipOf(req), isNew: !known });
      if (!q.ok) return json(res, q.status, q);
    }
    const { user, isNew } = d.users.ensure(id);
    if (isNew || !fs.existsSync(user.workspace)) d.provisionWorkspace(user);
    else offerStarters(user);
    if (isNew) d.audit('demo-member', { who: id });
    d.cfg.sessions.trimUser(id, SESSIONS_PER_VISITOR - 1);
    const session = d.cfg.sessions.create(id, Date.now());
    gate.bind(session, id, token, v.exp);
    return json(res, 200, { ok: true, token: session, uid: id, name: user.name, role: user.role, demo: true }, { 'cache-control': 'no-store' });
  }

  async function start(req, res) {
    const sbToken = String(req.headers[AUTH_HEADER] || '');
    if (sbToken) return startSigned(req, res, sbToken);
    const cookie = readCookie(req.headers.cookie, DEMO_COOKIE);
    let user = d.users.fromCookie(cookie);
    // Once the node is full, only a returning visitor (valid cookie) may start a session — so they
    // can delete chats and free space — and then without counting it: their only write is the
    // trimmed session list (at most SESSIONS_PER_VISITOR each). New visitors are refused.
    const full = disk(null);
    if (!user && !full.ok) return json(res, full.status, full);
    if (full.ok) {
      const q = consumeVisit({ cfg: d.cfg, store: d.store, ip: ipOf(req), isNew: !user });
      if (!q.ok) return json(res, q.status, q);
    }
    let value = cookie;
    if (user && !fs.existsSync(user.workspace)) d.provisionWorkspace(user);   // a restore that lacks this visitor's folder: re-seed
    else if (user) offerStarters(user);
    if (!user) {
      ({ user, cookie: value } = d.users.create());
      d.provisionWorkspace(user);
      d.audit('demo-visitor', { who: user.id });
    }
    d.cfg.sessions.trimUser(user.id, SESSIONS_PER_VISITOR - 1);   // a few live sessions per visitor (tabs renewing at once), never a growing pile
    const token = d.cfg.sessions.create(user.id, Date.now());
    return json(res, 200, { ok: true, token, uid: user.id, name: user.name, role: user.role, demo: true },
      { 'set-cookie': demoCookie(value), 'cache-control': 'no-store' });
  }

  const ollamaLanes = () => (d.cfg.chat_models || []).filter((m) => m && m.provider === 'ollama');
  function pickLane(model) {
    const lanes = ollamaLanes();
    return lanes.find((m) => m.id === model) || lanes[0] || null;
  }

  function openConvo(user, convoId, message, app, label) {
    const prior = typeof convoId === 'string' && convoId ? d.loadConvoState(user, convoId) : null;
    if (prior && prior.state === FILE_UNREADABLE) throw new Error(`this conversation could not be read · 无法读取该对话 (${prior.error})`);
    // A chat belongs to the surface that started it (lib/agent-origin.mjs): a stale binding to the
    // main chat or another app's gets a fresh chat, as in web.mjs chat().
    const origin = { fromApp: !!app, app };
    if (prior && prior.state === FILE_OK && convoReachable(prior.value, origin)) return prior.value;
    return { id: d.newId(), title: message.trim().slice(0, 48), sessionId: null, messages: [], updated: Date.now(), app: convoTag(origin), label: typeof label === 'string' && label ? label.slice(0, 200) : undefined };   // label: as web.mjs chat() keeps it (period summaries)
  }

  async function chat(req, res, user, run = chatLocked) {
    const refused = await gate.check(user, bearerOf(req));   // AI needs a verified sign-in (lib/demo-auth.mjs), checked every turn
    if (refused) return json(res, refused.status, refused.body);
    // The lock comes BEFORE the body is read: one visitor holds at most one chat body in memory.
    if (busy.has(user.id) || renaming.has(user.id)) return json(res, 409, { ok: false, code: 'demo_busy', error: DEMO_BUSY });
    if (chatting + jobs.count() >= demoLimit(d.cfg, 'parallel_chats')) return json(res, 503, { ok: false, code: 'demo_busy', error: DEMO_FULL });   // node-wide
    busy.add(user.id); chatting++;
    try { await run(req, res, user); } finally { busy.delete(user.id); chatting--; jobs.flush(user); }   // a build note held back for this turn
  }

  async function chatLocked(req, res, user) {
    const b = (await d.readBody(req, d.BODY_LIMITS.chat)) || {};
    const message = b.message;
    if (typeof message !== 'string' || !message.trim()) return json(res, 400, { error: 'empty message' });
    const lane = pickLane(b.model);
    if (!lane) return json(res, 503, { ok: false, code: 'demo_no_lane', error: DEMO_NO_LANE });
    const full = disk(user);
    if (!full.ok) return json(res, full.status, full);
    const q = consumeAiCall({ cfg: d.cfg, store: d.store, userId: user.id, ip: ipOf(req) });
    if (!q.ok) return json(res, q.status, q);   // not audited: a refused visitor must not grow the log
    await turn(req, res, user, b, message, lane);
  }

  async function turn(req, res, user, b, message, lane) {
    const app = typeof b.app === 'string' && slugOk(b.app) ? b.app : '';
    const convo = openConvo(user, b.convoId, message, app, b.label);
    convo.messages.push({ role: 'me', text: message });
    convo.updated = Date.now();
    d.saveConvo(user, convo);
    res.writeHead(200, d.chatHead); res.flushHeaders?.();
    const line = (o) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + '\n'); };
    line({ type: 'convo', id: convo.id, title: convo.title });
    if (b.assess) line({ type: 'status', text: DEMO_NO_VERIFY });   // said, never silently skipped
    const prompts = d.resolveSystemPrompts(user, app || null, b.system);
    const appsDir = path.join(user.workspace, 'apps');
    const intentRule = app ? null : appIntentRule(ownApps(appsDir));   // main chat only: an app's own chat stays that app's
    const history = [prompts.global, prompts.app, REPLY_LANGUAGE_RULE, SEARCH_RULE, intentRule].filter(Boolean).map((c) => ({ role: 'system', content: c }))
      .concat(convo.messages.slice(-HISTORY_TURNS).filter((m) => !m.failed && m.text)
        .map((m) => ({ role: m.role === 'md' ? 'assistant' : 'user', content: String(m.text) })));
    try {
      const markers = intentRule ? [APP_MARKER, SEARCH_MARKER] : [SEARCH_MARKER];   // an app's own chat builds no apps
      const first = await streamTurn(res, lane, history, line, markers);
      const s = await searchTurn({ d, user, text: first, history, line, ip: ipOf(req), signal: closeSignal(res), answer: (msgs) => streamTurn(res, lane, msgs, line, []) });
      let text = s.text;
      const intent = intentRule && !s.searched ? parseIntent(text) : null;   // a marker only on the first reply, never steered by search results
      if (intent) {
        const no = jobs.refusal(user);   // before the cap is charged: a refused build costs nothing
        if (no) throw new Error(no);
        const qb = consumeAppBuild({ cfg: d.cfg, store: d.store, userId: user.id, ip: ipOf(req) });
        if (!qb.ok) throw new Error(qb.error);
        const job = jobs.start({ user, intent, lane, ip: ipOf(req), convoId: convo.id, link: (slug) => appLink(req.headers, slug) });   // runs on after this reply (lib/demo-build-job.mjs)
        text = buildingText(job.title);
        line({ type: 'build', job });
      }
      convo.messages.push({ role: 'md', text, model: lane.id });
      convo.updated = Date.now();
      d.saveConvo(user, convo);   // saved BEFORE done: a reply the client shows is one a reload finds
      line({ type: 'done', ok: true, text });
    } catch (e) {
      const text = `⚠ ${turnErrorText(lane, e).slice(0, 300)}`;
      line({ type: 'error', text });
      convo.messages.push({ role: 'md', text, failed: true });
      convo.updated = Date.now();
      try { d.saveConvo(user, convo); } catch (err) { line({ type: 'error', text: `not saved · 未保存: ${err.message}` }); }
    }
    res.end();
  }

  // One model call under the demo's deadline and reply cap; the visitor leaving ends it. `onDelta`
  // null = a build call (nothing streamed). Returns the whole text; an empty one is an error.
  // `res` null = a background build (lib/demo-build-job.mjs): no visitor to leave, the deadline still holds.
  async function callModel(res, lane, messages, onDelta, maxKb) {
    const ac = new AbortController();
    if (res) res.on('close', () => ac.abort());
    if (res && res.destroyed) ac.abort();   // closed before this call began: 'close' will not fire again
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(Math.ceil(demoLimit(d.cfg, 'chat_timeout_s') * 1000))]);
    const max = maxKb * 1024; let got = 0;
    const text = await d.streamOllama({ url: d.cfg.ollama_url, model: lane.model, messages, signal, requireDone: true,
      onDelta: (t) => { got += Buffer.byteLength(t); if (got > max) ac.abort(new Error(QUOTA_MESSAGES.reply_long)); else if (onDelta) onDelta(t); } });
    if (got > max) throw new Error(QUOTA_MESSAGES.reply_long);   // the abort may land after the stream already ended
    if (!text.trim()) throw new Error('the model returned no text · 模型没有返回内容');
    return text;
  }

  const jobs = makeBuildJobs({ d, disk, callModel, isBusy: (id) => busy.has(id) || renaming.has(id) });
  const ask = makeDemoAsk({ d, json, ipOf, pickLane: () => pickLane(), disk, callModel, noLane: DEMO_NO_LANE });
  const closeSignal = (res) => { const ac = new AbortController(); res.on('close', () => ac.abort()); return ac.signal; };
  // The chat reply, streamed — except a reply that starts with one of `markers` (the ones this
  // surface acts on): that line is held back (the visitor sees a status, never the marker or code).
  // A held prefix that never became a marker is flushed at the end, so no text goes missing.
  async function streamTurn(res, lane, history, line, markers) {
    let held = '', decided = !markers.length, isMarker = false;
    const text = await callModel(res, lane, history, (t) => {
      if (decided) { if (!isMarker) line({ type: 'delta', text: t }); return; }
      held += t; const s = held.trimStart();
      if (markers.some((m) => s.length < m.length && m.startsWith(s))) return;
      decided = true; isMarker = markers.some((m) => s.startsWith(m));
      if (!isMarker) line({ type: 'delta', text: held });
    }, demoLimit(d.cfg, 'reply_max_kb'));
    if (!decided && held) line({ type: 'delta', text: held });
    return text;
  }

  return async function handle(req, res, p) {
    // A demo node has NO accounts. Restored or hand-added ones would bring their apps, jobs and
    // reminders onto a public node, so it refuses everything until they are removed.
    if ((d.cfg.users || []).length) { json(res, 503, { ok: false, code: 'demo_has_accounts', error: DEMO_HAS_ACCOUNTS }); return true; }
    if (!demoRouteAllowed(req.method, p)) { json(res, 403, { ok: false, code: 'demo_refused', error: DEMO_REFUSED }); return true; }
    if (req.method === 'GET' && p === '/api/setup-status') { json(res, 200, { needsSetup: false }); return true; }
    if (req.method === 'GET' && p === '/api/bible-search') {
      const user = d.userFor(req);
      if (!user) { json(res, 401, { error: 'bad token' }); return true; }
      const full = disk(null); if (!full.ok) { json(res, full.status, full); return true; }   // counting writes too
      const q = consumeSearch({ cfg: d.cfg, store: d.store, userId: user.id, ip: ipOf(req) });
      if (!q.ok) { json(res, q.status, q); return true; }
      return false;   // within the caps: web.mjs searches
    }
    if (req.method === 'GET' && p === '/api/models') {   // only the lanes a demo turn can really use, so the chooser never names Claude
      if (!d.userFor(req)) { json(res, 401, { error: 'bad token' }); return true; }
      json(res, 200, ollamaLanes().map((m) => ({ id: m.id, label: m.label, group: m.group || '', provider: 'ollama', vision: false }))); return true;
    }
    if (req.method === 'GET' && p === BUILD_JOB_PATH) {   // the visitor's app build, if any: the shell's indicator
      const user = d.userFor(req);
      if (!user) { json(res, 401, { error: 'bad token' }); return true; }
      json(res, 200, { ok: true, job: jobs.read(user) }, { 'cache-control': 'no-store' }); return true;
    }
    if (req.method === 'POST' && p === DEMO_START_PATH) { await start(req, res); return true; }
    if (req.method === 'POST' && p === WAITLIST_PATH) {   // no session needed: the front page links straight here (?join=1)
      const body = await d.readBody(req, WAITLIST_BODY_LIMIT);
      const r = addToWaitlist({ cfg: d.cfg, root: d.root, store: d.store, ip: ipOf(req), body });
      json(res, r.status, r.body, { 'cache-control': 'no-store' }); return true;
    }
    // Sign-out ends the VISIT, not just this token: every session of the visitor is revoked and the
    // cookie expired, so the next person on a shared browser starts a fresh, empty visit.
    if (req.method === 'POST' && p === DEMO_DELETE_PATH) { deleteAccount(req, res, json); return true; }
    if (req.method === 'POST' && p === '/api/logout') {
      // By the session itself, not userFor: a member whose sign-in expired must still be able to sign out.
      const uid = d.cfg.sessions.resolve(bearerOf(req), Date.now());
      const user = uid ? d.users.get(uid) : null;
      if (user) { d.cfg.sessions.destroyUser(user.id); gate.drop(user.id); }
      json(res, 200, { ok: true }, { 'set-cookie': `${DEMO_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, 'cache-control': 'no-store' });
      return true;
    }
    // A rename rewrites the whole chat: under the locks, never beside a turn. A delete is never
    // refused (an app would unbind a chat that still exists), so it takes no lock at all.
    const convoEdit = req.method === 'PATCH' && p.startsWith('/api/convos/');
    const gated = DISK_GATED.has(`${req.method} ${p}`) || convoEdit;
    const isAsk = req.method === 'POST' && p === DEMO_ASK_PATH;
    if (!gated && !isAsk && !(req.method === 'POST' && p === '/api/chat')) return false;
    const user = d.userFor(req);
    if (!user) { json(res, 401, { error: 'bad token' }); return true; }
    if (!gated) { await chat(req, res, user, isAsk ? ask : chatLocked); return true; }   // an app's ask: the chat's gate, lock and caps
    // A declared, small body only (save_max_mb, as sent: the shell gzips saves over 1 KB, and
    // readBody still caps the unpacked body at BODY_LIMITS); a body with no length is refused.
    const len = Number(req.headers['content-length']);
    if (!Number.isFinite(len) || len > demoLimit(d.cfg, 'save_max_mb') * 1024 * 1024) {
      json(res, 413, { ok: false, code: 'demo_too_big', error: QUOTA_MESSAGES.too_big }); return true;
    }
    const rename = convoEdit;
    if (saving.has(user.id) || (rename && busy.has(user.id))) { json(res, 409, { ok: false, code: 'demo_busy', error: DEMO_SAVE_BUSY }); return true; }
    if (inflight >= demoLimit(d.cfg, 'parallel_saves')) { json(res, 503, { ok: false, code: 'demo_busy', error: DEMO_SAVE_BUSY }); return true; }   // node-wide: bounds buffered bodies
    const full = disk(user);
    if (!full.ok) { json(res, full.status, full); return true; }
    saving.add(user.id); inflight++; if (rename) renaming.add(user.id);
    const done = () => { saving.delete(user.id); renaming.delete(user.id); inflight--; jobs.flush(user); };
    // Released when the reply is sent. A caller that hangs up first may still have a body being
    // unpacked and written, so then the lock is held until readBody's own deadline has passed.
    res.on('close', () => { if (res.writableFinished) done(); else setTimeout(done, BODY_READ_TIMEOUT_MS).unref(); });
    return false;   // under the caps: web.mjs's own handler writes it
  };
}
