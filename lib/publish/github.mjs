// GitHub REST client for Publish · 发布用的 GitHub 接口 (docs/adr/0039 §5–6).
// Git data API only (blobs → tree → commit → ref → PR); no local checkout for the PR itself.
// The token is sent in the Authorization header and NOWHERE else: errors carry the HTTP status and
// GitHub's message, never the request headers (test/publish-github.test.mjs pins that).
import crypto from 'node:crypto';
import { PublishError } from './collect.mjs';

export const VERSIONS_FILE = 'lib/builtin-app-versions.json';
export const DEFAULT_API = 'https://api.github.com';
export const DEFAULT_REPO = 'csheargm/superelf';

export function makeClient({ token, api = DEFAULT_API, repo = DEFAULT_REPO, fetchFn = fetch }) {
  if (!token) throw new PublishError('TOKEN_MISSING', '需要 GitHub 令牌 · GitHub token needed');
  const base = `${api.replace(/\/+$/, '')}/repos/${repo}`;
  async function call(method, p, body) {
    let res;
    try {
      res = await fetchFn(`${base}${p}`, { method, body: body ? JSON.stringify(body) : undefined,
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'superelf-publish' } });
    } catch (e) { throw new PublishError('GITHUB_UNREACHABLE', `GitHub 连接失败 · GitHub unreachable: ${e.message}`); }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }   // a non-JSON error page: keep its start as the message
    if (!res.ok) {
      const code = res.status === 401 ? 'TOKEN_REJECTED' : 'GITHUB_ERROR';
      throw new PublishError(code, `GitHub ${method} ${p} → ${res.status}: ${data.message || 'error'}`, { status: res.status });
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
  const idx = files.find((f) => f.path.endsWith(`/apps/${slug}/index.html`));
  const got = await gh.call('GET', `/contents/${VERSIONS_FILE}?ref=${mainSha}`);
  const all = JSON.parse(Buffer.from(got.content || '', 'base64').toString('utf8') || '{}');
  const set = new Set(all[slug] || []);
  set.add(sha256(idx.content));
  all[slug] = [...set].sort();
  const sorted = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
  return { path: VERSIONS_FILE, content: Buffer.from(JSON.stringify(sorted, null, 1) + '\n') };
}

export const branchName = (slug, now = new Date()) => `publish/${slug}-${now.toISOString().slice(0, 10).replace(/-/g, '')}`;

// Opens the PR. Returns { number, url, headSha, branch }.
export async function openPublishPR(gh, { slug, title, files, refused = [], now = new Date() }) {
  const main = (await gh.call('GET', '/git/ref/heads/main')).object.sha;
  const baseTree = (await gh.call('GET', `/git/commits/${main}`)).tree.sha;
  const all = [...files, await versionsFile(gh, main, slug, files)];
  const tree = [];
  for (const f of all) {
    const blob = await gh.call('POST', '/git/blobs', { content: b64(f.content), encoding: 'base64' });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const treeSha = (await gh.call('POST', '/git/trees', { base_tree: baseTree, tree })).sha;
  const prTitle = `发布 ${title} · Publish ${title}`;
  const commit = await gh.call('POST', '/git/commits', { message: `feat(apps): publish ${slug}\n\n- Published from the node (docs/adr/0039); privacy scan clean.`, tree: treeSha, parents: [main] });
  const branch = branchName(slug, now);
  try { await gh.call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha }); }
  catch (e) { if (e.status === 422) throw new PublishError('BRANCH_EXISTS', `今天已发布过 · ${branch} already exists — merge or delete it first`); throw e; }
  const body = ['Files:', ...all.map((f) => `- ${f.path}`), '', `Privacy scan: clean (${files.length} file(s)).`,
    ...(refused.length ? ['', 'Not published:', ...refused.map((r) => `- ${r.file} (${r.why})`)] : [])].join('\n');
  const pr = await gh.call('POST', '/pulls', { title: prTitle, head: branch, base: 'main', body });
  return { number: pr.number, url: pr.html_url, headSha: commit.sha, branch };
}

// 'pending' | 'success' | 'failure'. No checks yet counts as pending, never success (R14).
export async function checksState(gh, sha) {
  const r = await gh.call('GET', `/commits/${sha}/check-runs?per_page=100`);
  const runs = r.check_runs || [];
  if (!runs.length || runs.some((c) => c.status !== 'completed')) return 'pending';
  return runs.every((c) => ['success', 'skipped', 'neutral'].includes(c.conclusion)) ? 'success' : 'failure';
}

export async function mergePR(gh, number, headSha, title) {
  try { return await gh.call('PUT', `/pulls/${number}/merge`, { merge_method: 'merge', sha: headSha, commit_title: title }); }
  catch (e) { if (e.status === 405 || e.status === 409) throw new PublishError('MERGE_REFUSED', `合并被拒绝 · Merge refused: ${e.message}`); throw e; }
}
