// Nightly review (docs/adr/0046), units on throwaway local git repos: settings, the range picked by the last
// reviewed commit, skip on no commits, a failed/empty/garbage Codex reply = REVIEW FAILED with the state
// NOT advanced, the email text, and a findings-only repo never written to (its remote is unchanged).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nightlySetting, ENV_KEY, urlOk } from '../lib/nightly-review/config.mjs';
import { syncRepo, pickRange, diffChunks, EMPTY_TREE, NO_PUSH_URL } from '../lib/nightly-review/repo.mjs';
import { parseFindings, parseVerdict, fixRequest } from '../lib/nightly-review/prompt.mjs';
import { emailBody, emailSubject } from '../lib/nightly-review/email.mjs';
import { runNightlyReview, readState } from '../lib/nightly-review/job.mjs';
import { VERIFY_ARGS } from '../lib/nightly-review/wire.mjs';
import { tgit } from './helpers-selfpub.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-')));
function remote(d, name = 'r') {
  const work = path.join(d, `${name}-work`); fs.mkdirSync(work);
  tgit(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'a.mjs'), 'export const a = 1;\n');
  tgit(work, 'add', '.'); tgit(work, 'commit', '-qm', 'first');
  const bare = path.join(d, `${name}.git`); tgit(d, 'clone', '-q', '--bare', work, bare); tgit(work, 'remote', 'add', 'origin', bare);
  const commit = (f, text, msg) => { fs.writeFileSync(path.join(work, f), text); tgit(work, 'add', '.'); tgit(work, 'commit', '-qm', msg); tgit(work, 'push', '-q', 'origin', 'main'); return tgit(work, 'rev-parse', 'HEAD').trim(); };
  return { work, bare, commit, head: () => tgit(bare, 'rev-parse', 'main').trim() };
}
const cfgFor = (dir, repos, extra = {}) => ({ nightly_review: { enabled: true, dir, repos, ...extra } });

test('settings: off with none; env is the fallback; config wins; bad values throw', () => {
  assert.equal(nightlySetting({}, {}).enabled, false);
  const env = { [ENV_KEY]: JSON.stringify({ enabled: true, repos: [{ name: 'superelf', url: 'https://github.com/o/r.git', fix: 'selfpub' }] }) };
  assert.equal(nightlySetting({}, env).repos[0].fix, 'selfpub');
  assert.equal(nightlySetting({ nightly_review: { enabled: false } }, env).enabled, false);
  assert.throws(() => nightlySetting({}, { [ENV_KEY]: '{bad' }), /not JSON/);
  assert.throws(() => nightlySetting({ nightly_review: { enabled: true, time: '25:00' } }, {}), /time/);
  for (const u of ['ext::sh -c x', 'git@github.com:o/r.git', 'https://h/../x', 'file:///etc', '-uhttps://x/y']) assert.equal(urlOk(u), false, u);
  assert.throws(() => nightlySetting({ nightly_review: { enabled: true, repos: [{ name: 'x', url: 'ssh://h/r' }] } }, {}), /url/);
  assert.throws(() => nightlySetting({ nightly_review: { enabled: true, repos: [{ name: 'x', url: '/a', fix: 'push' }] } }, {}), /fix/);
});

test('range: by the last reviewed commit; same tip = nothing; first run = time window; rewritten history = window', () => {
  const d = tmp();
  try {
    const r = remote(d);
    const first = r.head();
    const c2 = r.commit('b.mjs', 'export const b = 2;\n', 'second');
    const c3 = r.commit('c.mjs', 'export const c = 3;\n', 'third');
    const dir = path.join(d, 'clone');
    const tip = syncRepo({ dir, url: r.bare, branch: 'main' });
    assert.equal(tip, c3);
    assert.equal(tgit(dir, 'remote', 'get-url', '--push', 'origin').trim(), NO_PUSH_URL);
    assert.deepEqual(pickRange(dir, { tip, lastSha: c2, now: Date.now(), windowMs: 864e5 }).commits, [c3]);
    assert.deepEqual(pickRange(dir, { tip, lastSha: c3, now: Date.now(), windowMs: 864e5 }).commits, []);
    const all = pickRange(dir, { tip, lastSha: undefined, now: Date.now(), windowMs: 864e5 });
    assert.deepEqual(all.commits, [c3, c2, first]); assert.equal(all.base, EMPTY_TREE);
    assert.deepEqual(pickRange(dir, { tip, lastSha: undefined, now: Date.now() + 3 * 864e5, windowMs: 864e5 }).commits, []);
    const gone = pickRange(dir, { tip, lastSha: 'f'.repeat(40), now: Date.now(), windowMs: 864e5 });
    assert.match(gone.note, /rewritten/); assert.equal(gone.commits.length, 3);
    const chunks = diffChunks(dir, { base: c2, tip, capBytes: 1 << 20 });
    assert.equal(chunks.length, 1); assert.deepEqual(chunks[0].files, ['c.mjs']);
    const small = diffChunks(dir, { base: first, tip, capBytes: 120 });
    assert.ok(small.length >= 2, 'split on file boundaries'); assert.ok(small.flatMap((c) => c.cut).length >= 1, 'an over-cap file is named as cut');
  } finally { rmTemp(d); }
});

test('parse: [] is valid; empty, prose and items without a claim are failures; verdicts are strict', () => {
  assert.deepEqual(parseFindings('[]'), []);
  assert.equal(parseFindings('```json\n[{"file":"a.mjs","line":3,"severity":"high","claim":"x leaks","evidence":"y"}]\n```')[0].line, 3);
  for (const bad of ['', '   ', 'Looks good to me!', '[{"file":"a"}]', '{"a":1}', '[{"claim":"x"']) assert.throws(() => parseFindings(bad), undefined, bad);
  assert.equal(parseVerdict('CONFIRMED\nreal').verdict, 'confirmed');
  assert.equal(parseVerdict('**REJECTED**\nno').verdict, 'rejected');
  assert.equal(parseVerdict('I think it is confirmed').verdict, 'unverified');
  assert.ok(fixRequest([{ file: 'a.mjs', line: 1, severity: 'high', claim: 'c', reason: 'r' }], '2026-01-02').includes('a.mjs:1'));
});

test('verify args: read-only file tools, no repo settings (its hooks never run), = forms', () => {
  assert.ok(VERIFY_ARGS.includes('--setting-sources='));
  assert.ok(VERIFY_ARGS.includes('--tools=Read,Grep,Glob'));
  assert.ok(!VERIFY_ARGS.some((a) => /dangerously|bypass/i.test(a)));
});

test('email: plain text, no emojis, failures and skips said plainly', () => {
  const projects = [
    { name: 'superelf', status: 'reviewed', base: 'a'.repeat(40), tip: 'b'.repeat(40), commits: ['x', 'y'], cut: [], note: '',
      confirmed: [{ file: 'lib/x.mjs', line: 4, severity: 'high', claim: 'token logged' }], rejected: [{ file: 'y', line: null, claim: 'z', reason: 'guarded' }], unverified: [],
      fix: 'Ready to publish.', prevFix: 'Live v5.30.0' },
    { name: 'Other Repo', status: 'failed', base: '', tip: '', commits: [], why: 'codex: timed out' },
    { name: 'other', status: 'skipped', base: '', tip: '', commits: [] },
  ];
  const body = emailBody(projects, '2026-11-26');
  assert.match(body, /Range: aaaaaaa\.\.bbbbbbb \(2 commits\)/);
  assert.match(body, /- lib\/x\.mjs:4 \[high\] token logged/);
  assert.match(body, /REVIEW FAILED: codex: timed out/);
  assert.match(body, /No new commits: other/);
  assert.match(body, /Previous fix: Live v5\.30\.0/);
  assert.doesNotMatch(body, /\p{Extended_Pictographic}/u);
  assert.equal(emailSubject(projects, '2026-11-26'), 'Nightly review 2026-11-26: 1 confirmed, 1 failed');
});

const FINDING = '[{"file":"a.mjs","line":1,"severity":"high","claim":"a is wrong","evidence":"a = 1"}]';
function deps(cfg, { codex, verify, startFix } = {}) {
  const calls = { codex: [], verify: [], fix: [] };
  return { calls, d: { cfg, env: {}, now: Date.now, audit: () => {},
    codex: async (a) => { calls.codex.push(a); return codex ? codex(a) : { ok: true, text: FINDING }; },
    verify: async (a) => { calls.verify.push(a); return verify ? verify(a) : { ok: true, text: 'CONFIRMED\nseen in a.mjs' }; },
    startFix: async (a) => { calls.fix.push(a); return startFix ? startFix(a) : { id: 'abcd1234', text: 'Ready to publish.' }; } } };
}

test('run: reviews, verifies, fixes only the selfpub repo; the findings-only repo is never written; next night with no commits = no briefing', async () => {
  const d = tmp();
  try {
    const se = remote(d, 'se'), hg = remote(d, 'hg');
    const hgBefore = tgit(hg.bare, 'for-each-ref').trim();
    const dir = path.join(d, 'nr');
    const cfg = cfgFor(dir, [{ name: 'superelf', url: se.bare, fix: 'selfpub' }, { name: 'Other Repo', url: hg.bare }]);
    const { d: dd, calls } = deps(cfg);
    const out = await runNightlyReview(dd);
    assert.match(out.subject, /2 confirmed/);
    assert.match(out.body, /Fix: Ready to publish\./);
    assert.match(out.body, /Fix: none \(findings only\)/);
    assert.equal(calls.fix.length, 1, 'only superelf asks for a fix');
    assert.ok(calls.codex.every((c) => c.cwd.startsWith(dir)));
    assert.equal(tgit(hg.bare, 'for-each-ref').trim(), hgBefore, 'the findings-only remote is untouched');
    const st = readState(dir);
    assert.equal(st.repos.superelf.lastSha, se.head()); assert.equal(st.repos.superelf.fixId, 'abcd1234');
    assert.equal(await runNightlyReview(dd), null, 'no new commits and no fix news: no briefing');
    assert.match((await runNightlyReview(dd, { manual: true })).body, /No new commits: superelf, Other Repo/);
  } finally { rmTemp(d); }
});

test('run: a failed, empty or garbage Codex reply is REVIEW FAILED and the range is tried again', async () => {
  const d = tmp();
  try {
    const se = remote(d, 'se');
    const dir = path.join(d, 'nr');
    const cfg = cfgFor(dir, [{ name: 'superelf', url: se.bare, fix: 'selfpub' }]);
    for (const reply of [{ ok: false, text: 'Codex produced no output' }, { ok: true, text: '' }, { ok: true, text: 'All good!' }]) {
      const { d: dd, calls } = deps(cfg, { codex: () => reply });
      const out = await runNightlyReview(dd);
      assert.match(out.body, /REVIEW FAILED: /, JSON.stringify(reply));
      assert.match(out.subject, /0 confirmed, 1 failed/);
      assert.equal(calls.fix.length, 0);
      assert.equal((readState(dir).repos.superelf || {}).lastSha, undefined, 'not marked reviewed');
    }
    const { d: ok } = deps(cfg, { codex: () => ({ ok: true, text: '[]' }) });
    assert.match((await runNightlyReview(ok)).body, /Confirmed \(0\):\n- none/);
    assert.equal(readState(dir).repos.superelf.lastSha, se.head());
  } finally { rmTemp(d); }
});

test('run: a review that changes the clone is not trusted; the deadline fails closed', async () => {
  const d = tmp();
  try {
    const se = remote(d, 'se');
    const dir = path.join(d, 'nr');
    const cfg = cfgFor(dir, [{ name: 'superelf', url: se.bare }]);
    const { d: w } = deps(cfg, { codex: ({ cwd }) => { fs.writeFileSync(path.join(cwd, 'planted.txt'), 'x'); return { ok: true, text: '[]' }; } });
    assert.match((await runNightlyReview(w)).body, /changed files in the read-only clone/);
    const late = deps(cfgFor(dir, [{ name: 'superelf', url: se.bare }], { deadline_min: 0.5 })).d;
    assert.match((await runNightlyReview(late)).body, /deadline/);
    assert.equal((readState(dir).repos.superelf || {}).lastSha, undefined);
  } finally { rmTemp(d); }
});

test('GPT review r1: a crashed Codex run, an error text quoting [], an aged-out failed first range, a fix not started', async () => {
  const d = tmp();
  try {
    const se = remote(d, 'se');
    const dir = path.join(d, 'nr');
    const cfg = cfgFor(dir, [{ name: 'superelf', url: se.bare, fix: 'selfpub' }]);
    for (const reply of [{ ok: true, text: '[]', code: 1, signal: null }, { ok: true, text: '[]', code: null, signal: 'SIGTERM' }, { ok: true, text: 'Error: expected [] got nothing' }]) {
      const { d: dd } = deps(cfg, { codex: () => reply });
      assert.match((await runNightlyReview(dd)).body, /REVIEW FAILED/, JSON.stringify(reply));
    }
    assert.ok(readState(dir).repos.superelf.retryBase, 'the failed first range is remembered');
    const later = deps(cfg, { codex: () => ({ ok: true, text: '[]', code: 0, signal: null }) }).d;
    later.now = () => Date.now() + 3 * 864e5;   // the window alone would now find nothing
    assert.match((await runNightlyReview(later)).body, /Range: 4b825dc\.\.\w{7} \(1 commit\)/);
    assert.equal(readState(dir).repos.superelf.retryBase, undefined);
    se.commit('b.mjs', 'export const b = 2;\n', 'second');
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    st.repos.superelf.fixId = 'open1234'; fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(st));
    const busy = deps(cfg, { startFix: () => ({ id: null, text: 'not started: another change is in progress' }) });
    busy.d.fixStatus = () => ({ text: 'still waiting for your Publish tap', final: false });
    const out = await runNightlyReview(busy.d);
    assert.match(out.body, /Fix: not started: another change/); assert.match(out.body, /Previous fix: still waiting/);
    assert.equal(readState(dir).repos.superelf.fixId, 'open1234', 'the open fix is still tracked');
  } finally { rmTemp(d); }
});
