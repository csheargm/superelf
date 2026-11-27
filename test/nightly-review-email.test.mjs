// 早晨邮件 · The nightly review email (docs/adr/0046): answer first, plain words, details below the divider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderEmail, digestView, DIVIDER, TOP_MAX, H } from '../lib/nightly-review/digest.mjs';
import { parsePlain, plainPrompt } from '../lib/nightly-review/prompt.mjs';
import { projects1126, CONFIRMED_1126 } from './fixtures/nightly-review-1126.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPLY = fs.readFileSync(path.join(here, 'fixtures', 'nightly-review-1126-plain.json'), 'utf8');
const plain1126 = () => ({ items: parsePlain(REPLY, CONFIRMED_1126.length) });
const above = (body) => body.split(DIVIDER)[0];
const reviewed = (confirmed, extra = {}) => ({ name: 'superelf', status: 'reviewed', base: 'a'.repeat(40), tip: 'b'.repeat(40), commits: ['x'],
  cut: [], note: '', confirmed, rejected: [], unverified: [], ...extra });
const f = (severity, claim, file = 'lib/x.mjs') => ({ file, line: 4, severity, claim, reason: 'seen' });

test('all clear: subject and verdict say so', () => {
  const out = renderEmail([reviewed([]), { name: 'b', status: 'skipped', commits: [] }], { date: '2026-11-26' });
  assert.equal(out.subject, 'Nightly review: all clear');
  assert.match(out.body.split('\n')[0], /^Nothing needs you: no problems in the new code of superelf\.$/);
  assert.doesNotMatch(out.body, new RegExp(H.needs));
});

test('fix ready: needs you names the Publish tap and links the node', () => {
  const out = renderEmail([reviewed([f('medium', 'x broken')], { fix: 'Ready', fixState: 'ready', fixTitle: '夜间审查修复 2026-11-26 · Nightly review fixes' })],
    { date: '2026-11-26', baseUrl: 'https://node.example' });
  assert.equal(out.subject, 'Nightly review: 1 needs you, 1 found');
  assert.match(out.body, /1\. Fixes for 1 problem in superelf are ready\.\n {3}Action: Open the chat "夜间审查修复 2026-11-26 · Nightly review fixes" in superelf and tap 发布 · Publish\. https:\/\/node\.example\//);
  assert.match(out.html, /href="https:\/\/node\.example\/"/);
  assert.match(above(out.body), /x broken → fix ready, waiting for your Publish tap\./);
});

test('earlier fix went live; all failed; mixed', () => {
  const live = renderEmail([{ name: 'superelf', status: 'skipped', commits: [], prevFix: 'Live v6.1.0', prevFixLive: true }], { date: 'd' });
  assert.equal(live.subject, 'Nightly review: fix live');
  const bad = renderEmail([{ name: 'superelf', status: 'failed', commits: [], why: 'codex: timed out' }], { date: 'd' });
  assert.equal(bad.subject, 'Nightly review FAILED for superelf');
  assert.match(bad.body, /没能审查 · Could not review\n- superelf: it ran out of time\. It tries again tonight\./);
  const out = renderEmail(projects1126(), { date: '2026-11-26', plain: plain1126() });
  assert.equal(out.subject, 'Nightly review: 2 need you, 12 found, Other Repo failed');
  assert.match(out.body.split('\n')[0], /^2 things need you: found 12 problems in superelf \(none serious\); Other Repo could not be reviewed\.$/);
  assert.match(above(out.body), /Other Repo is not being reviewed: the branch "main" does not exist/);
  assert.match(above(out.body), /another superelf change was still open/);
});

test('ordering: high first, then the model rank; every medium+ shown, low only counted', () => {
  const conf = [f('low', 'L1'), f('medium', 'M1'), f('medium', 'M2'), f('high', 'H1'), f('medium', 'M3'), f('medium', 'M4'), f('medium', 'M5'), f('low', 'L2')];
  const plain = { items: conf.map((x, i) => ({ impact: `plain ${x.claim}`, severity: x.severity, rank: 10 - i })) };
  const v = digestView([reviewed(conf)], { date: 'd', plain });
  assert.deepEqual(v.found.map((x) => x.impact), ['plain H1', 'plain M5', 'plain M4', 'plain M3', 'plain M2', 'plain M1']);
  assert.ok(v.found.length > TOP_MAX, 'medium+ is never hidden behind a count');
  assert.equal(v.lowCount, 2);
  const out = renderEmail([reviewed(conf)], { date: 'd', plain });
  assert.match(above(out.body), /plain M1 →/); assert.doesNotMatch(out.body, /\d+ more/);
  assert.match(above(out.body), /- And 2 minor \(low risk\): see the technical details\./);
  assert.match(out.html, /plain M1/);
  assert.match(digestView([reviewed(conf)], { date: 'd', plain }).details, /L1/);
  assert.equal(v.needs[0].text, 'superelf: plain H1', 'a serious finding with no ready fix needs the owner');
});

test('plain-words pass: strict parse; on failure the technical text is used, nothing dropped', () => {
  assert.throws(() => parsePlain('All good', 1)); assert.throws(() => parsePlain('[]', 1));
  assert.throws(() => parsePlain('[{"n":1,"impact":"a"},{"n":1,"impact":"b"}]', 2), /repeated/);
  assert.throws(() => parsePlain('[{"n":1,"impact":""}]', 1), /no impact/);
  assert.match(plainPrompt([f('low', 'c')]), /does not code/);
  const out = renderEmail(projects1126(), { date: '2026-11-26', plain: { error: 'expected 12 items' } });
  assert.match(above(out.body), /An interrupted re-share can leave an existing link/);
  assert.match(out.body, /Plain-words pass failed .*expected 12 items/);
  assert.equal(digestView(projects1126(), { date: 'd', plain: { error: 'x' } }).total, 12);
});

test('details below the divider only; no emojis; html escapes and matches the text', () => {
  const ps = projects1126();
  ps[0].confirmed[0].claim = '<script>x</script>';
  const out = renderEmail(ps, { date: '2026-11-26', plain: plain1126() });
  const top = above(out.body);
  assert.doesNotMatch(top, /lib\/|\.mjs|:\d+ \[|1b24905|Range:/, 'no files, lines or ranges above the divider');
  assert.match(out.body.split(DIVIDER)[1], /lib\/app-share\.mjs:143 \[medium\]/);
  assert.match(out.body.split(DIVIDER)[1], /Range: 1b24905\.\.0686770 \(140 commits\)/);
  for (const t of [out.body, out.html, out.subject]) assert.doesNotMatch(t, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(out.html, /<script>|<style|<img|src=/);
  assert.match(out.html, /&lt;script&gt;/);
  assert.ok(out.html.indexOf(H.needs) < out.html.indexOf(H.found) && out.html.indexOf(H.found) < out.html.indexOf(H.details));
});

test('not handed to a fix: action says they will not come back and how to fix them', () => {
  const out = renderEmail([reviewed([f('medium', 'x')], { fix: 'Fix in progress elsewhere', fixState: 'not-started' })], { date: 'd' });
  assert.match(above(out.body), /Action: These will not come back by themselves\. Publish or discard the open superelf change, then ask superelf to "fix last night's review findings"\./);
  assert.match(out.html, /will not come back by themselves/);
});

test('findings left unverified by the verify limit get a short line', () => {
  const unverified = [1, 2, 3].map(() => ({ ...f('medium', 'u'), reason: 'not verified: over max_verify (20)' }))
    .concat({ ...f('low', 'v'), reason: 'verifier failed: x' });
  const out = renderEmail([reviewed([f('medium', 'x')], { unverified })], { date: 'd' });
  assert.match(above(out.body), /- 3 not checked \(verify limit\)\./);
  assert.match(out.html, /3 not checked \(verify limit\)/);
  assert.match(above(out.body), /- 1 not checked \(the check failed\)\./, 'a failed verifier is said too (GPT r1, R14)');
  assert.match(out.html, /1 not checked \(the check failed\)/);
  const none = renderEmail([reviewed([], { unverified })], { date: 'd' });
  assert.match(above(none.body), /3 not checked \(verify limit\)/);
  assert.doesNotMatch(renderEmail([reviewed([f('medium', 'x')])], { date: 'd' }).body, /not checked/);
});

// Nightly review 2026-11-27 (R14): every candidate unverified is NOT a clean night.
test('all findings unverified: "review incomplete", never "no problems" or "all clear"', () => {
  const out = renderEmail([reviewed([], { unverified: [f('medium', 'maybe broken'), { ...f('low', 'x'), reason: 'verifier failed: timeout' }] })], { date: '2026-11-27' });
  assert.equal(out.subject, 'Nightly review: superelf review incomplete');
  assert.match(out.body.split('\n')[0], /review incomplete for superelf: 2 findings could not be verified/);
  assert.doesNotMatch(out.body.split('\n')[0], /no problems|All clear/i);
});
