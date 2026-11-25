// GitHub REST client for Publish · 发布用的 GitHub 接口 (docs/adr/0039 §5–6).
// Git data API only (blobs → tree → commit → ref → PR); no local checkout for the PR itself.
// The token is sent in the Authorization header and NOWHERE else: errors carry the HTTP status and
// GitHub's message, never the request headers (test/publish-github.test.mjs pins that).
import crypto from 'node:crypto';
import { PublishError, topFile } from './collect.mjs';

export const VERSIONS_FILE = 'lib/builtin-app-versions.json';
export const DEFAULT_API = 'https://api.github.com';
export const DEFAULT_REPO = 'csheargm/superelf';

export const GITHUB_TIMEOUT_MS = 60000;
// Any form of the token a server could echo back (raw, or inside a Basic header) → ***.
export function scrubToken(s, token) {
  let out = String(s);
  if (!token) return out;
  for (const f of [token, Buffer.from(`x-access-token:${token}`).toString('base64'), Buffer.from(token).toString('base64')]) out = out.split(f).join('***');
  return out;
}

export function makeClient({ token, api = DEFAULT_API, repo = DEFAULT_REPO, fetchFn = fetch }) {
  if (!token) throw new PublishError('TOKEN_MISSING', '需要 GitHub 令牌 · GitHub token needed');
  const base = `${api.replace(/\/+$/, '')}/repos/${repo}`;
  async function call(method, p, body) {
    let res;
    try {
      res = await fetchFn(`${base}${p}`, { method, body: body ? JSON.stringify(body) : undefined,
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'superelf-publish' },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    } catch (e) { throw new PublishError('GITHUB_UNREACHABLE', `GitHub 连接失败 · GitHub unreachable: ${scrubToken(e.message, token)}`); }
    let text;
    try { text = await res.text(); } catch (e) { throw new PublishError('GITHUB_UNREACHABLE', `GitHub 读取失败 · GitHub read failed: ${scrubToken(e.message, token)}`); }
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: scrubToken(text, token).slice(0, 200) }; }   // scrub BEFORE cutting: a cut token would not match   // a non-JSON error page: keep its start as the message
    if (!res.ok) {
      const code = res.status === 401 ? 'TOKEN_REJECTED' : 'GITHUB_ERROR';
      throw new PublishError(code, scrubToken(`GitHub ${method} ${p} → ${res.status}: ${data.message || 'error'}`, token), { status: res.status });
    }
    return data;
  }
  return { call, repo };
}

const b64 = (buf) => Buffer.from(buf).toString('base64');
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The builtin-app-versions entry for this slug gains the new index.html hash (what
// tools/gen-builtin-app-versions.mjs would write), so the PR's CI does not fail on a stale list.
async function versionsFile(gh, mainSha, slug, files) {
  const idx = topFile(files, slug, 'index.html');
  const got = await gh.call('GET', `/contents/${VERSIONS_FILE}?ref=${mainSha}`);
  const all = JSON.parse(Buffer.from(got.content || '', 'base64').toString('utf8') || '{}');
  const set = new Set(all[slug] || []);
  set.add(sha256(idx.content));
  all[slug] = [...set].sort();
  const sorted = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
  return { path: VERSIONS_FILE, content: Buffer.from(JSON.stringify(sorted, null, 1) + '\n') };
}

export const branchName = (slug, now = new Date()) => `publish/${slug}-${now.toISOString().slice(0, 10).replace(/-/g, '')}`;

// Opens a PR from files (and deletes) on top of main, git data API only. Returns { number, url, headSha, branch }.
// files: [{ path, content: Buffer }]; deletes: [path] become tree entries with sha null (the GitHub way to remove).
// base: the commit the change was made on (core Publish); omitted = current main (app Publish).
export async function openChangePR(gh, { base, branch, title, message, body, files, deletes = [], extra = async () => [] }) {
  const main = base || (await gh.call('GET', '/git/ref/heads/main')).object.sha;
  const baseTree = (await gh.call('GET', `/git/commits/${main}`)).tree.sha;
  const all = [...files, ...(await extra(main))];
  const tree = [];
  for (const f of all) {
    const blob = await gh.call('POST', '/git/blobs', { content: b64(f.content), encoding: 'base64' });
    tree.push({ path: f.path, mode: f.mode || '100644', type: 'blob', sha: blob.sha });
  }
  for (const d of deletes) tree.push({ path: d, mode: '100644', type: 'blob', sha: null });
  const treeSha = (await gh.call('POST', '/git/trees', { base_tree: baseTree, tree })).sha;
  const commit = await gh.call('POST', '/git/commits', { message, tree: treeSha, parents: [main] });
  try { await gh.call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha }); }
  catch (e) { if (e.status === 422) throw new PublishError('BRANCH_EXISTS', `分支已存在 · ${branch} already exists — merge or delete it first`); throw e; }
  const pr = await gh.call('POST', '/pulls', { title, head: branch, base: 'main', body: typeof body === 'function' ? body(all) : body });
  return { number: pr.number, url: pr.html_url, headSha: commit.sha, branch };
}

// Opens an app's PR. Returns { number, url, headSha, branch }.
export async function openPublishPR(gh, { slug, title, files, refused = [], now = new Date() }) {
  const body = (all) => ['Files:', ...all.map((f) => `- ${f.path}`), '', `Privacy scan: clean (${files.length} file(s)).`,
    // Refused names are unscanned (a .env, a notes-<name>.txt): a count only; the owner sees them on the node.
    ...(refused.length ? ['', `Not published: ${refused.length} non-code file(s).`] : [])].join('\n');
  return openChangePR(gh, { branch: branchName(slug, now), title: `发布 ${title} · Publish ${title}`, body, files,
    message: `feat(apps): publish ${slug}\n\n- Published from the node (docs/adr/0039); privacy scan clean.`,
    extra: async (main) => [await versionsFile(gh, main, slug, files)] });
}

// The CI jobs that must pass, by name (.github/workflows/ci.yml `test (${{ matrix.os }})`).
export const REQUIRED_CHECKS = ['test (ubuntu-latest)', 'test (windows-latest)'];

// 'pending' | 'success' | 'failure'. Every REQUIRED name must be present, completed and 'success';
// a missing one is pending, never success (R14); other checks do not count either way.
export async function checksState(gh, sha, required = REQUIRED_CHECKS) {
  const r = await gh.call('GET', `/commits/${sha}/check-runs?per_page=100`);
  const runs = r.check_runs || [];
  const got = required.map((n) => runs.filter((c) => c.name === n));
  if (got.some((g) => !g.length || g.some((c) => c.status !== 'completed'))) return 'pending';
  return got.every((g) => g.every((c) => c.conclusion === 'success')) ? 'success' : 'failure';
}

export async function mergePR(gh, number, headSha, title) {
  try { return await gh.call('PUT', `/pulls/${number}/merge`, { merge_method: 'merge', sha: headSha, commit_title: title }); }
  catch (e) { if (e.status === 405 || e.status === 409) throw new PublishError('MERGE_REFUSED', `合并被拒绝 · Merge refused: ${e.message}`); throw e; }
}
