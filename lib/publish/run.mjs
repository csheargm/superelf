// Publish one app · 发布应用 (docs/adr/0039) — the steps in order, each failure a notice.
//   start(): collect → strict privacy gate → open PR   (answered to the owner's tap)
//   finish(): poll checks → merge → cut release         (in the background; status is polled)
// One publish per slug in flight. Status lives in memory: a restart mid-publish leaves the PR open
// on GitHub, which is the safe state (nothing merged, released or deployed).
import fs from 'node:fs';
import { collectApp, snapshotHash, PublishError } from './collect.mjs';
import { loadTermsStrict, scanFiles, scanLabels } from './scan.mjs';
import { makeClient, openPublishPR, checksState, mergePR, DEFAULT_REPO } from './github.mjs';
import { cutRelease } from './release.mjs';

export const POLL_MS = 30000;
export const MAX_POLLS = 120;          // one hour of CI at 30 s
const status = new Map();              // slug → { state, step, pr?, version?, error?, at }
const inFlight = new Set();

export const publishStatus = (slug) => status.get(slug) || null;
const set = (slug, s) => { status.set(slug, { ...s, at: Date.now() }); return status.get(slug); };
const fail = (slug, step, e, extra = {}) => set(slug, { state: 'failed', step, code: e.code || 'ERROR', error: e.message, ...extra });

// The owner's term files sit on the encrypted /data, outside the image: this folder is used when it
// exists, so no live config edit is needed. publish_terms_root still overrides; a missing or empty
// term file still refuses (loadTermsStrict, fail closed).
export const DEFAULT_TERMS_ROOT = '/data/.publish-terms';
export const termsRootFor = (cfg, root, exists = fs.existsSync) =>
  cfg.publish_terms_root || (exists(DEFAULT_TERMS_ROOT) ? DEFAULT_TERMS_ROOT : root);

export function publishOptions(cfg, root, exists) {
  return { token: cfg.github_publish_token || '', api: cfg.github_api_url || undefined, repo: cfg.publish_repo || DEFAULT_REPO,
    remoteUrl: cfg.publish_remote_url || `https://github.com/${cfg.publish_repo || DEFAULT_REPO}.git`, termsRoot: termsRootFor(cfg, root, exists),
    pollMs: Number(cfg.publish_poll_ms) || POLL_MS, maxPolls: Number(cfg.publish_max_polls) || MAX_POLLS };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function finish(gh, slug, title, pr, o, key = slug) {
  try {
    let state = 'pending';
    for (let i = 0; i < o.maxPolls && state === 'pending'; i++) { await sleep(o.pollMs); state = await checksState(gh, pr.headSha); }
    if (state !== 'success') {
      const why = state === 'failure' ? 'CI 未通过，PR 保持打开 · CI is red; the PR stays open' : 'CI 超时，PR 保持打开 · CI timed out; the PR stays open';
      return fail(key, 'checks', new PublishError(state === 'failure' ? 'CI_RED' : 'CI_TIMEOUT', why), { pr: pr.url });
    }
    set(key, { state: 'merging', step: 'merge', pr: pr.url });
    await mergePR(gh, pr.number, pr.headSha, `Merge: 发布 ${title} · Publish ${title}`);
    set(key, { state: 'releasing', step: 'release', pr: pr.url });
    const rel = cutRelease({ remoteUrl: o.remoteUrl, token: o.token });
    return set(key, { state: 'published', step: 'done', pr: pr.url, version: rel.version });
  } catch (e) { return fail(key, status.get(key)?.step || 'checks', e, { pr: pr.url }); }
  finally { inFlight.delete(slug); inFlight.delete(`key:${key}`); }
}

export const destOf = (o) => `${o.repo}\0${o.api || ''}\0${o.remoteUrl || ''}`;

// The confirm sheet's summary: what WOULD leave, and any scan hit — nothing is sent anywhere.
// slug: the repo folder (a copy's source app); owner: the owner's uid, so their copy collects as it.
export function previewPublish({ appDir, slug, owner, base, keepMeta, options: o }) {
  const { files, refused } = collectApp(appDir, slug, { owner, base, keepMeta });
  return { files: files.map((f) => ({ path: f.path, bytes: f.content.length })), refused, hits: scanFiles(files, loadTermsStrict(o.termsRoot)), repo: o.repo, hash: snapshotHash(files, destOf(o)) };
}

// Returns { status, done } — done resolves when the background part ends (tests await it).
// The title comes from the COLLECTED meta.json (the bytes that were scanned, symlinks refused),
// never a second read of the folder; the slug when it has none.
const titleOf = (files, slug) => {
  const m = files.find((f) => f.path.endsWith(`/${slug}/meta.json`));
  try { return String((m && JSON.parse(m.content.toString('utf8')).title) || slug).slice(0, 80); } catch { return slug; }
};

// expectHash: the preview's snapshotHash — the owner confirmed THOSE bytes, so any change refuses.
// key: the owner's own app slug the status is read under (a copy's differs from the repo slug).
export async function startPublish({ appDir, slug, owner, base, keepMeta, key = slug, options: o, fetchFn, expectHash }) {
  // Locked by the repo folder AND the local app: one app's status never holds two publishes.
  if (inFlight.has(slug) || inFlight.has(`key:${key}`)) throw new PublishError('IN_FLIGHT', '正在发布中 · A publish of this app is already running');
  if (!o.token) throw new PublishError('TOKEN_MISSING', '需要 GitHub 令牌 · GitHub token needed');
  inFlight.add(slug); inFlight.add(`key:${key}`);
  let handedOff = false;
  try {
    set(key, { state: 'scanning', step: 'scan' });
    const { files, refused } = collectApp(appDir, slug, { owner, base, keepMeta });
    if (!expectHash || snapshotHash(files, destOf(o)) !== expectHash) throw new PublishError('SNAPSHOT_CHANGED', '应用在预览后有改动，请重新预览 · The app changed since the preview; preview again');
    const terms = loadTermsStrict(o.termsRoot), title = titleOf(files, slug);
    // Every string that goes public outside the files is scanned too: the decoded title and slug
    // (PR title, commit, merge title). Refused file names never leave (the PR body has a count).
    const hits = [...scanFiles(files, terms), ...scanLabels({ 'PR title': title, slug }, terms)];
    if (hits.length) { const s = set(key, { state: 'blocked', step: 'scan', code: 'SCAN_HIT', error: '隐私检查未通过 · Privacy scan found something', hits }); return { status: s, done: Promise.resolve(s) }; }
    set(key, { state: 'opening', step: 'pr' });
    const gh = makeClient({ token: o.token, api: o.api, repo: o.repo, fetchFn });
    const pr = await openPublishPR(gh, { slug, title, files, refused });
    const s = set(key, { state: 'checking', step: 'checks', pr: pr.url, files: files.map((f) => f.path), refused });
    handedOff = true;
    return { status: s, done: finish(gh, slug, title, pr, o, key) };
  } catch (e) {
    const s = fail(key, status.get(key)?.step || 'scan', e);
    if (e instanceof PublishError) return { status: s, done: Promise.resolve(s) };
    throw e;
  } finally { if (!handedOff) { inFlight.delete(slug); inFlight.delete(`key:${key}`); } }
}
