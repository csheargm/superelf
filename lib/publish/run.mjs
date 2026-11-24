// Publish one app · 发布应用 (docs/adr/0039) — the steps in order, each failure a notice.
//   start(): collect → strict privacy gate → open PR   (answered to the owner's tap)
//   finish(): poll checks → merge → cut release         (in the background; status is polled)
// One publish per slug in flight. Status lives in memory: a restart mid-publish leaves the PR open
// on GitHub, which is the safe state (nothing merged, released or deployed).
import { collectApp, PublishError } from './collect.mjs';
import { loadTermsStrict, scanFiles } from './scan.mjs';
import { makeClient, openPublishPR, checksState, mergePR, DEFAULT_REPO } from './github.mjs';
import { cutRelease } from './release.mjs';

export const POLL_MS = 30000;
export const MAX_POLLS = 120;          // one hour of CI at 30 s
const status = new Map();              // slug → { state, step, pr?, version?, error?, at }
const inFlight = new Set();

export const publishStatus = (slug) => status.get(slug) || null;
const set = (slug, s) => { status.set(slug, { ...s, at: Date.now() }); return status.get(slug); };
const fail = (slug, step, e, extra = {}) => set(slug, { state: 'failed', step, code: e.code || 'ERROR', error: e.message, ...extra });

export function publishOptions(cfg, root) {
  return { token: cfg.github_publish_token || '', api: cfg.github_api_url || undefined, repo: cfg.publish_repo || DEFAULT_REPO,
    remoteUrl: cfg.publish_remote_url || `https://github.com/${cfg.publish_repo || DEFAULT_REPO}.git`, termsRoot: root,
    pollMs: Number(cfg.publish_poll_ms) || POLL_MS, maxPolls: Number(cfg.publish_max_polls) || MAX_POLLS };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function finish(gh, slug, title, pr, o) {
  try {
    let state = 'pending';
    for (let i = 0; i < o.maxPolls && state === 'pending'; i++) { await sleep(o.pollMs); state = await checksState(gh, pr.headSha); }
    if (state !== 'success') {
      const why = state === 'failure' ? 'CI 未通过，PR 保持打开 · CI is red; the PR stays open' : 'CI 超时，PR 保持打开 · CI timed out; the PR stays open';
      return fail(slug, 'checks', new PublishError(state === 'failure' ? 'CI_RED' : 'CI_TIMEOUT', why), { pr: pr.url });
    }
    set(slug, { state: 'merging', step: 'merge', pr: pr.url });
    await mergePR(gh, pr.number, pr.headSha, `Merge: 发布 ${title} · Publish ${title}`);
    set(slug, { state: 'releasing', step: 'release', pr: pr.url });
    const rel = cutRelease({ remoteUrl: o.remoteUrl, token: o.token });
    return set(slug, { state: 'published', step: 'done', pr: pr.url, version: rel.version });
  } catch (e) { return fail(slug, status.get(slug)?.step || 'checks', e, { pr: pr.url }); }
  finally { inFlight.delete(slug); }
}

// The confirm sheet's summary: what WOULD leave, and any scan hit — nothing is sent anywhere.
export function previewPublish({ appDir, slug, options: o }) {
  const { files, refused } = collectApp(appDir, slug);
  return { files: files.map((f) => ({ path: f.path, bytes: f.content.length })), refused, hits: scanFiles(files, loadTermsStrict(o.termsRoot)) };
}

// Returns { status, done } — done resolves when the background part ends (tests await it).
export async function startPublish({ appDir, slug, title, options: o, fetchFn }) {
  if (inFlight.has(slug)) throw new PublishError('IN_FLIGHT', '正在发布中 · A publish of this app is already running');
  if (!o.token) throw new PublishError('TOKEN_MISSING', '需要 GitHub 令牌 · GitHub token needed');
  inFlight.add(slug);
  let handedOff = false;
  try {
    set(slug, { state: 'scanning', step: 'scan' });
    const { files, refused } = collectApp(appDir, slug);
    const hits = scanFiles(files, loadTermsStrict(o.termsRoot));
    if (hits.length) { const s = set(slug, { state: 'blocked', step: 'scan', code: 'SCAN_HIT', error: '隐私检查未通过 · Privacy scan found something', hits }); return { status: s, done: Promise.resolve(s) }; }
    set(slug, { state: 'opening', step: 'pr' });
    const gh = makeClient({ token: o.token, api: o.api, repo: o.repo, fetchFn });
    const pr = await openPublishPR(gh, { slug, title, files, refused });
    const s = set(slug, { state: 'checking', step: 'checks', pr: pr.url, files: files.map((f) => f.path), refused });
    handedOff = true;
    return { status: s, done: finish(gh, slug, title, pr, o) };
  } catch (e) {
    const s = fail(slug, status.get(slug)?.step || 'scan', e);
    if (e instanceof PublishError) return { status: s, done: Promise.resolve(s) };
    throw e;
  } finally { if (!handedOff) inFlight.delete(slug); }
}
