// /api/apps/<slug>/publish · 发布接口 (docs/adr/0039 §1). OWNER ONLY, checked here on the server:
// a member (or a demo visitor) gets 403 whatever the UI shows. POST starts a publish; GET reads its
// status. The token never appears in any answer — only whether it is set.
import fs from 'node:fs';
import path from 'node:path';
import { startPublish, publishStatus, publishOptions, previewPublish } from './run.mjs';

export const PUBLISH_RE = /^\/api\/apps\/([^/]+)\/publish$/;
export const TOKEN_STEPS = [
  '在 GitHub 新建细粒度令牌，仅限公开仓库 · Create a fine-grained token on GitHub for the public repo only',
  '权限：Contents 与 Pull requests 读写 · Permissions: Contents and Pull requests, read and write',
  '粘贴到 设置 › 节点设置 › 高级 · Paste it in Settings › Node settings › Advanced',
];
const json = (send, res, code, body) => send(res, code, 'application/json', JSON.stringify(body));

// Returns true when it answered. ctx: { user, cfg, root, slugOk, ownAppDir, readBody, send, audit, demo }
// POST {preview:true} answers the confirm sheet (files + scan + hash) and sends nothing to GitHub;
// POST {hash} publishes only if the app still collects to that same snapshot.
export async function handlePublishRoute(req, res, p, ctx) {
  const m = p.match(PUBLISH_RE);
  if (!m || (req.method !== 'POST' && req.method !== 'GET')) return false;
  const { user, cfg, send } = ctx;
  if (ctx.demo || !user || user.role !== 'owner') { json(send, res, 403, { error: '仅主人可发布 · Only the owner can publish' }); return true; }
  const slug = m[1];
  if (!ctx.slugOk(slug)) { json(send, res, 400, { error: 'bad slug' }); return true; }
  const o = publishOptions(cfg, ctx.root);
  if (req.method === 'GET') { json(send, res, 200, { tokenSet: !!o.token, status: publishStatus(slug) }); return true; }
  if (!o.token) { json(send, res, 409, { code: 'TOKEN_MISSING', error: '需要 GitHub 令牌 · GitHub token needed', steps: TOKEN_STEPS }); return true; }
  const dir = ctx.ownAppDir(user, slug);
  if (!dir || !fs.existsSync(path.join(dir, 'index.html'))) { json(send, res, 404, { error: '没有这个应用 · No such app' }); return true; }
  const body = await ctx.readBody(req);
  if (body && body.preview) {
    try { json(send, res, 200, { preview: previewPublish({ appDir: dir, slug, options: o }) }); }
    catch (e) { if (!e.code || !/^[A-Z_]+$/.test(e.code)) throw e; json(send, res, 422, { code: e.code, error: e.message }); }
    return true;
  }
  try {
    const expectHash = body && typeof body.hash === 'string' ? body.hash : '';
    const { status, done } = await startPublish({ appDir: dir, slug, options: o, expectHash });
    ctx.audit('app-publish', { who: user.id, slug, state: status.state });
    // The outcome (published / failed at checks, merge or release) is logged too: Settings → Activity log.
    if (done) done.then((s) => { if (s && s.state !== status.state) ctx.audit('app-publish', { who: user.id, slug, state: s.state, error: s.error || '' }); },
      (e) => ctx.audit('app-publish', { who: user.id, slug, state: 'failed', error: String((e && e.message) || e) }));
    json(send, res, status.state === 'failed' || status.state === 'blocked' ? 422 : 202, { status });
  } catch (e) {
    if (e.code === 'IN_FLIGHT' || e.code === 'TOKEN_MISSING') { json(send, res, 409, { code: e.code, error: e.message }); return true; }
    throw e;
  }
  return true;
}
