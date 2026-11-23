// Chat → job. "every morning tell me the pollen" is an instruction to set something up;
// "what's the pollen today" is a question. Getting this wrong is asymmetric: hijacking an
// ordinary question with a job card is far worse than missing one, which the user rephrases.
// So the bar is deliberately high, and deterministic — asking a model on every chat turn
// would cost a call per message and could answer differently tomorrow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeJob } from '../lib/jobs/intent.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a recurring instruction is a job', () => {
  for (const s of ['every morning tell me the pollen', 'daily give me tech news',
    'remind me every Sunday at 8pm to call mom', 'each evening send me a summary',
    '每天早上告诉我花粉指数', '每周日提醒我', 'nightly report the queue depth']) {
    assert.equal(looksLikeJob(s).job, true, s);
  }
});

test('a question is NOT a job, however it mentions time', () => {
  for (const s of ['what is the pollen today', 'give me tech news', 'remind me to call mom',
    'summarise this document', 'what should I do today', '今天花粉指数是多少',
    'how do I create a job?', 'what time does the pollen job run every day',
    'is it going to rain tonight', 'why did the job fail']) {
    assert.equal(looksLikeJob(s).job, false, s);
  }
});

test('asking for one outright counts — but asking ABOUT one does not', () => {
  assert.equal(looksLikeJob('create a job that checks the news daily').job, true);
  assert.equal(looksLikeJob('can you create a job that checks news daily').job, true);
  assert.equal(looksLikeJob('建个任务每天检查新闻').job, true);
  // The distinction: how/what/why open an enquiry, "can you…" opens a request.
  assert.equal(looksLikeJob('how do I create a job?').job, false);
  assert.equal(looksLikeJob('what is a job in this system').job, false);
});

test('a cadence we cannot build is not offered as a job', () => {
  // Offering a card that then fails validation is worse than staying quiet: the same parser
  // the resolver uses (lib/jobs/when.mjs) decides, so the two can never disagree (R3).
  for (const s of ['every 30 minutes check the queue', 'weekdays at 9am send me a summary']) {
    assert.equal(looksLikeJob(s).job, false, s);
  }
  // These two DO name a recurrence and an action, so they reach the cadence check itself —
  // which is the guard being tested. Without it a card would be offered for a schedule the
  // store then refuses.
  for (const s of ['every day tell me the news, weekdays only', 'every morning check it, every 30 minutes']) {
    const r = looksLikeJob(s);
    assert.equal(r.job, false, s);
    assert.match(r.why, /not supported/i, `${s} — expected the cadence reason, got: ${r.why}`);
  }
});

test('nothing absurd gets through', () => {
  assert.equal(looksLikeJob('').job, false);
  assert.equal(looksLikeJob(null).job, false);
  // Must contain a verb too, or it would be rejected for having no action rather than for
  // being an essay — and the length guard would never be exercised.
  assert.equal(looksLikeJob('every day tell me things '.repeat(30)).job, false, 'an essay is not an instruction');
  assert.match(looksLikeJob('every day tell me things '.repeat(30)).why, /short instruction/);
  assert.equal(looksLikeJob('every day tell me things').job, true, 'the same sentence once IS an instruction');
  assert.equal(looksLikeJob({}).job, false);
});

test('every answer carries a reason — a silent no is unexplainable', () => {
  for (const s of ['every morning tell me the pollen', 'what is the pollen today', '']) {
    assert.ok(looksLikeJob(s).why, `no reason for: ${JSON.stringify(s)}`);
  }
});

test('main chat offers the draft; an APP chat never does', () => {
  const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  // origin.fromApp rather than `app`: it is also true when the relay header is present and the
  // slug forged empty (lib/agent-origin.mjs; driven over HTTP in test/app-agent-confinement.test.mjs).
  assert.match(WEB, /if \(!origin\.fromApp && looksLikeJob\(message\)\.job\)/,
    'a job appearing out of an app\'s own chat would be a surprise');
  assert.match(WEB, /line\(\{ type: 'job-draft'/, 'the draft is streamed to the client');
  // Offered, never created: the person presses Create.
  assert.ok(!/job-draft[\s\S]{0,400}saveJob\(/.test(WEB), 'chat must not create the job itself');
  // A resolver failure must not turn an ordinary message into an error.
  assert.match(WEB, /Could not resolve it — fall through and answer the message normally/);
});

test('the shell shows it as a card with an explicit Create', () => {
  const SHELL = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(SHELL, /function renderJobDraft/);
  assert.match(SHELL, /data-mkjob/, 'there is a Create button');
  assert.match(SHELL, /data-nojob/, 'and a way to decline');
  assert.match(SHELL, /已创建（暂停中），请在设置 › 任务中开启 · Created, paused/, 'and it says the job is NOT armed yet');
});
