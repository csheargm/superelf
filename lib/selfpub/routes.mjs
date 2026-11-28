// /api/selfpub/<id>[/preview|/publish|/discard] · 改 superelf 的发布接口 (docs/adr/0043 §5). OWNER ONLY,
// checked here on the server: a member, guest or the demo gets 403 whatever the UI shows. GET = status
// (and "live" once the restarted node runs the released version). Nothing goes to GitHub except on
// POST /publish carrying the hash the owner's preview showed. The token is never in an answer.
import { publishOptions } from '../publish/run.mjs';
import { TOKEN_STEPS } from '../publish/routes.mjs';
import { previewSelf, startSelf, liveStatus } from './run.mjs';
import { getChange, putChange, PENDING } from './state.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock, lockOptions } from './lock.mjs';
import { discardBranch, git, repoDir, DEFAULT_SELFPUB_ROOT, MAX_FILES, MAX_DIFF_KB } from './checkout.mjs';
import { startTry, tryMinutes, wrapperPrefix } from './try.mjs';

export const SELFPUB_RE = /^\/api\/selfpub\/([a-z0-9]{4,16})(?:\/(preview|publish|discard|try|shot\/[01]))?$/;
export const shotsDir = (sroot) => path.join(sroot, 'shots');   // lib/selfpub/render.mjs writes <id>-0.png (before), <id>-1.png (after)
// A typed 发布 / publish in the same conversation is the tap (web.mjs maps it with pendingFor).
export const TYPED_PUBLISH_RE = /^\s*(发布|publish)\s*[.!。！]?\s*$/i;

export const selfpubRoot = (cfg) => cfg.selfpub_root || DEFAULT_SELFPUB_ROOT;
export function selfpubOptions(cfg, root) {
  return { ...publishOptions(cfg, root), maxFiles: Number(cfg.selfpub_max_files) || MAX_FILES, maxDiffKb: Number(cfg.selfpub_max_diff_kb) || MAX_DIFF_KB, lock: lockOptions(cfg) };
}

const json = (send, res, code, body) => send(res, code, 'application/json', JSON.stringify(body));
const coded = (e) => e && e.code && /^[A-Z_]+$/.test(e.code);

// ctx: { user, session, cfg, root, readBody, send, audit, demo, version }. Returns true when it answered.
export async function handleSelfpubRoute(req, res, p, ctx) {
  const m = p.match(SELFPUB_RE);
  if (!m) return false;
  const { user, cfg, send } = ctx;
  // apiKey: the request came with a Shortcut API key on an account with a PIN — never enough to publish.
  if (ctx.demo || !user || user.role !== 'owner' || ctx.apiKey) { json(send, res, 403, { error: '只有主人可以修改 superelf 本身 · Only the owner can change superelf itself' }); return true; }
  const [, id, action] = m, sroot = selfpubRoot(cfg), o = selfpubOptions(cfg, ctx.root);
  const change = getChange(sroot, id);
  if (!change || change.who !== user.id) { json(send, res, 404, { error: '没有这个改动 · No such change' }); return true; }
  if (req.method === 'GET' && !action) { json(send, res, 200, { tokenSet: !!o.token, state: change.state, verify: change.verify, status: liveStatus(sroot, id, typeof ctx.version === 'function' ? ctx.version() : ctx.version) }); return true; }
  if (req.method === 'GET' && action.startsWith('shot/')) return sendShot(res, send, path.join(shotsDir(sroot), `${id}-${action.slice(5)}.png`));
  if (req.method !== 'POST' || !action || action.startsWith('shot/')) { json(send, res, 405, { error: 'method' }); return true; }
  try { return await act(req, res, { ...ctx, id, action, sroot, o, change }); }
  catch (e) { if (!coded(e)) throw e; json(send, res, e.code === 'IN_FLIGHT' ? 409 : 422, { code: e.code, error: e.message }); return true; }
}

function sendShot(res, send, f) {
  let buf; try { buf = fs.readFileSync(f); } catch { json(send, res, 404, { error: '没有截图 · No screenshot' }); return true; /* never rendered, or cleaned */ }
  send(res, 200, 'image/png', buf); return true;
}

async function act(req, res, c) {
  const { send } = c;
  if (c.action === 'discard') {
    const release = acquireLock(c.sroot, lockOptions(c.cfg));
    try {   // state re-read under the lock; only THIS change's branch: a stale discard never wipes a newer change
      if (!PENDING.includes(getChange(c.sroot, c.id).state)) { json(send, res, 409, { code: 'IN_FLIGHT', error: '这个改动不能再丢弃 · This change can no longer be discarded' }); return true; }
      const dir = repoDir(c.sroot);
      if (git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === c.change.branch) discardBranch(dir);
      putChange(c.sroot, c.id, { state: 'discarded' });
    } finally { release(); }
    c.audit('self-publish', { who: c.user.id, id: c.id, state: 'discarded' }); json(send, res, 200, { state: 'discarded' }); return true;
  }
  if (c.action === 'try') return tryIt(res, c);
  if (!c.o.token) { json(send, res, 409, { code: 'TOKEN_MISSING', error: '需要 GitHub 令牌 · GitHub token needed', steps: TOKEN_STEPS }); return true; }
  if (c.action === 'preview') { json(send, res, 200, { preview: previewSelf({ root: c.sroot, id: c.id, options: c.o }) }); return true; }
  const body = await c.readBody(req);
  const { status, done } = await startSelf({ root: c.sroot, id: c.id, options: c.o, expectHash: body && typeof body.hash === 'string' ? body.hash : '', fetchFn: c.fetchFn });
  c.audit('self-publish', { who: c.user.id, id: c.id, state: status.state });
  done.then((s) => { if (s && s.state !== status.state) c.audit('self-publish', { who: c.user.id, id: c.id, state: s.state, error: s.error || '' }); },
    (e) => c.audit('self-publish', { who: c.user.id, id: c.id, state: 'failed', error: String((e && e.message) || e) }));
  json(send, res, status.state === 'failed' || status.state === 'blocked' ? 422 : 202, { status });
  return true;
}

// 试用 · Try it (docs/adr/0049): a short-lived preview token for THIS change, only while it waits to publish
// and is the branch the checkout is on with the very bytes its checks saw (else it would show another change).
function tryIt(res, c) {
  const dir = repoDir(c.sroot), notPending = (error) => (json(c.send, res, 409, { code: 'NOT_PENDING', error }), true);
  if (!PENDING.includes(c.change.state) || git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() !== c.change.branch) return notPending('这个改动不在等待发布，不能试用 · This change is not waiting to publish, so it cannot be tried');
  const minutes = tryMinutes(c.cfg);
  let tok; try { tok = startTry({ dir, change: c.change, sroot: c.sroot, sess: c.session, cfg: c.cfg, minutes }); }
  catch (e) { if (e && e.code === 'NOT_PENDING') return notPending(e.message); throw e; }   // other codes: act's catch answers 422 with the reason
  c.audit('self-publish-try', { who: c.user.id, id: c.id, minutes });
  json(c.send, res, 200, { url: `${wrapperPrefix(tok)}/`, minutes }); return true;
}
