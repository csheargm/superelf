// Model review building blocks (docs/adr/0017): settings, the test data, the format checks, a
// timed Ollama call over real HTTP, and the blind grading prompt and its strict parse.
// Nothing here reaches the real Ollama, ollama.com or Claude: the model is a node:http stub that
// speaks Ollama's NDJSON stream, and the grader is a function handed the prompt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelReviewSetting, MODEL_REVIEW_DEFAULTS, readReviewState, writeReviewState } from '../lib/model-review-config.mjs';
import { loadReviewTests, checkAnswer } from '../lib/model-review-tests.mjs';
import { askModel, mapLimit } from '../lib/model-review-call.mjs';
import { blindBatch, parseGrades, gradeAll, graderArgs, ANSWER_MAX_CHARS } from '../lib/model-review-grade.mjs';
import { catalogName, cloudModel } from '../lib/model-health.mjs';
import { fastLaneGuard, REPLY_LANGUAGE_RULE } from '../lib/config.mjs';
import { MEAL_PROMPT } from '../lib/meals.mjs';
import { NO_TOOLS_ARGS, NO_THINKING_ARGS } from '../lib/one-shot.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = path.join(REPO, MODEL_REVIEW_DEFAULTS.tests);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mr-'));
const APPS = { bible: 'BIBLE DIRECTIVE' };

test('settings: defaults in one place; an unknown key, a bad time or an out-of-range number refuses', () => {
  assert.deepEqual(modelReviewSetting({}), { ...MODEL_REVIEW_DEFAULTS });
  assert.equal(modelReviewSetting({ model_review: { margin: 1 } }).margin, 1);
  assert.equal(modelReviewSetting({ model_review: modelReviewSetting({}) }).time, '03:00', 'idempotent on a loaded value');
  assert.throws(() => modelReviewSetting({ model_review: { marign: 1 } }), /unknown key "marign"/);
  assert.throws(() => modelReviewSetting({ model_review: { time: '25:00' } }), /time: not HH:MM/);
  assert.throws(() => modelReviewSetting({ model_review: { concurrency: 0 } }), /concurrency must be a whole number/);
  assert.throws(() => modelReviewSetting({ model_review: { every_days: 1.5 } }), /every_days/);
  assert.throws(() => modelReviewSetting({ model_review: [] }), /must be an object/);
});

test('state: missing is "never reviewed", damaged throws, `exists` is never written', () => {
  const f = path.join(tmp(), 'model-review.json');
  assert.equal(readReviewState(f).exists, false);
  writeReviewState(f, { ...readReviewState(f), reviewedAt: 5 });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).exists, undefined);
  assert.deepEqual(readReviewState(f), { reviewedAt: 5, catalogSeen: [], undo: null, declined: [], exists: true });
  fs.writeFileSync(f, '{bad');
  assert.throws(() => readReviewState(f));
});

test('catalog names map to callable model strings and back (the forms measured on Ollama 0.34.3)', () => {
  assert.equal(cloudModel('beam'), 'beam:cloud');
  assert.equal(cloudModel('clef:27b'), 'clef:27b-cloud');
  assert.equal(cloudModel('deepseek-v4-pro:0813'), 'deepseek-v4-pro:0813-cloud', 'the form a default lane already uses');
  for (const n of ['beam', 'clef:27b', 'deepseek-v4.1-flash']) assert.equal(catalogName(cloudModel(n)), n);
});

test('the shipped tests load, use the production prompts by reference, and carry a real image', () => {
  const { tests, rubric } = loadReviewTests(SHIPPED, { appPrompts: APPS });
  assert.ok(rubric.length > 50);
  for (const g of ['Fast', 'Deep', 'Vision']) assert.ok(tests.some((t) => t.group === g), `a ${g} test`);
  assert.ok(tests.filter((t) => t.quick).length >= 2 && tests.filter((t) => t.quick).length <= 3, 'round 1 has 2-3 quick tests');
  const zh = tests.find((t) => t.id === 'fast-zh-short');
  assert.deepEqual(zh.messages.slice(0, 2), [{ role: 'system', content: fastLaneGuard('app') }, { role: 'system', content: REPLY_LANGUAGE_RULE }]);
  assert.equal(tests.find((t) => t.id === 'deep-bible-zh').messages[0].content, 'BIBLE DIRECTIVE', 'app:bible is the configured directive');
  const meal = tests.find((t) => t.group === 'Vision');
  assert.equal(meal.messages.at(-1).content, MEAL_PROMPT, 'the meal test sends the app\'s own prompt, not a copy');
  assert.ok(Buffer.from(meal.messages.at(-1).images[0], 'base64').subarray(1, 4).toString() === 'PNG', 'a PNG rides as base64');
  assert.ok(meal.truth.includes('rice'), 'the grader is told what the image shows');
  const skill = tests.find((t) => t.check === 'skill');
  assert.ok(skill && skill.group === 'Deep' && skill.must.length >= 3, 'a Deep skill-writing test with the correction\'s words');
});

test('format checks: a skill is a SKILL.md with front matter, steps, and the words of the correction', () => {
  const t = { check: 'skill', keys: [], must: ['count', 'author'], lang: 'en' };
  const ok = '---\nname: quotes-list\ndescription: Use when asked to collect quotes.\n---\n1. Collect them.\n2. Count on top, sort by author.\n3. Read the file back.\n';
  assert.equal(checkAnswer(t, ok), null);
  assert.equal(checkAnswer(t, '```\n' + ok + '```'), null, 'one fence is tolerated, as for JSON');
  assert.match(checkAnswer(t, 'Here is the skill:\n' + ok), /no --- front matter/, 'commentary around the file fails');
  assert.match(checkAnswer(t, ok.replace('name: quotes-list', 'name: Quotes List')), /name slug/);
  assert.match(checkAnswer(t, ok.replace(/description:.*\n/, '')), /description/);
  assert.match(checkAnswer(t, ok.replace('3. Read the file back.\n', '')), /fewer than 3 steps/);
  assert.match(checkAnswer(t, ok.replace('Count on top', 'Put it on top')), /dropped the rule about: count$/, 'a skill that lost the correction fails before grading (R14)');
});

test('a malformed test file is refused with its reason, never half-loaded', () => {
  const dir = tmp();
  const write = (o) => { const f = path.join(dir, `t${Math.random()}.json`); fs.writeFileSync(f, JSON.stringify(o)); return f; };
  const ok = { id: 'a', group: 'Fast', quick: true, prompt: 'hi', check: 'text', rubric: 'r' };
  const deep = { ...ok, id: 'b', group: 'Deep', quick: false };
  const file = (tests) => write({ rubric: 'R', tests });
  assert.equal(loadReviewTests(file([ok, deep])).tests.length, 2, 'CONTROL: a minimal file loads');
  assert.throws(() => loadReviewTests(file([ok, { ...deep, id: 'a' }])), /duplicate id/);
  assert.throws(() => loadReviewTests(file([ok, { ...deep, group: 'Slow' }])), /group must be one of/);
  assert.throws(() => loadReviewTests(file([ok, { ...deep, rubric: '' }])), /needs a rubric/);
  assert.throws(() => loadReviewTests(file([ok, { ...deep, check: 'json' }])), /needs "keys"/);
  assert.throws(() => loadReviewTests(file([ok, { ...deep, image: '../x.png' }])), /beside the tests file/);
  assert.throws(() => loadReviewTests(file([ok, { ...deep, system: ['app:nope'] }]), { appPrompts: APPS }), /no configured app directive/);
  assert.throws(() => loadReviewTests(file([ok])), /no Deep test/);
  assert.throws(() => loadReviewTests(path.join(dir, 'missing.json')), /unreadable/);
});

test('format checks: empty, JSON shape, the meal JSON the app parses, and the reply language', () => {
  assert.match(checkAnswer({ check: 'skill', keys: [], must: ['x'], lang: null }, '---\nname: a\ndescription: b\n---\n1. a\n2. b\n3. c\n'), /dropped the rule/);
  const t = (o) => ({ check: 'text', keys: [], lang: null, ...o });
  assert.equal(checkAnswer(t({}), '  '), 'empty answer');
  assert.equal(checkAnswer(t({ check: 'json', keys: ['a'] }), '```json\n{"a":1}\n```'), null, 'one fence is what the apps tolerate');
  assert.match(checkAnswer(t({ check: 'json', keys: ['a', 'b'] }), '{"a":1}'), /lacks b/);
  assert.equal(checkAnswer(t({ check: 'json', keys: ['a'] }), 'Sure! {"a":1}'), 'not valid JSON');
  const meal = '{"is_food":true,"items":["rice"],"carb_heavy":true,"fried":false,"sugary_drink":true,"vegetables_present":true}';
  assert.equal(checkAnswer(t({ check: 'meal' }), meal), null);
  assert.match(checkAnswer(t({ check: 'meal' }), '{"is_food":true}'), /meal JSON/);
  assert.equal(checkAnswer(t({ lang: 'zh' }), '做一个纸杯小动物吧。'), null);
  assert.equal(checkAnswer(t({ lang: 'zh' }), 'Make a paper cup animal.'), 'not in Chinese');
  assert.equal(checkAnswer(t({ lang: 'en' }), 'Try a quick spinach omelette with garlic (菠菜).'), null, 'a quoted term is fine');
  assert.equal(checkAnswer(t({ lang: 'en' }), '菠菜炒蛋很快。'), 'not in English');
});

// ── a timed call over real HTTP, against an Ollama-shaped stub ──────────────────────────────
let srv, url;
const plans = {};   // model → (res) => void
before(async () => {
  srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => (plans[JSON.parse(b).model] || ((r) => r.end()))(res));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.closeAllConnections(); srv.close(); });
const line = (o) => JSON.stringify(o) + '\n';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('first text is the first CONTENT, after a thinking model\'s reasoning; the whole answer is kept', async () => {
  plans['think:cloud'] = async (res) => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(line({ message: { role: 'assistant', content: '', thinking: 'hmm' }, done: false }));
    await wait(150);
    res.write(line({ message: { content: 'Hello ' }, done: false }));
    res.end(line({ message: { content: 'there' }, done: true }));
  };
  const r = await askModel({ url, model: 'think:cloud', messages: [], timeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Hello there');
  assert.ok(r.firstTextMs >= 140, `thinking is not text: ${r.firstTextMs} ms`);
  assert.ok(r.ms >= r.firstTextMs);
});

test('every failure comes back as a failure with its reason — never a pass', async () => {
  plans['gone:cloud'] = (res) => { res.writeHead(410, { 'content-type': 'application/json' }); res.end('{"error":"gone:cloud was retired at 2026-09-25"}'); };
  plans['err:cloud'] = (res) => { res.writeHead(200); res.end(line({ message: { content: 'par' } }) + line({ error: 'upstream died' })); };
  plans['empty:cloud'] = (res) => { res.writeHead(200); res.end(line({ message: { content: '' }, done: true })); };
  plans['slow:cloud'] = async (res) => { res.writeHead(200); res.write(line({ message: { content: 'partial' } })); await wait(800); res.end(); };
  const ask = (model, timeoutMs = 5000) => askModel({ url, model, messages: [], timeoutMs });
  assert.match((await ask('gone:cloud')).error, /Ollama HTTP 410 — gone:cloud was retired/);
  const err = await ask('err:cloud');
  assert.equal(err.ok, false);
  assert.equal(err.error, 'upstream died');
  assert.equal((await ask('empty:cloud')).error, 'empty answer');
  const slow = await ask('slow:cloud', 300);
  assert.equal(slow.ok, false, 'a timed-out answer fails even with text so far (R14)');
  assert.match(slow.error, /no full answer within 0.3s/);
  assert.equal((await askModel({ url: 'http://127.0.0.1:9', model: 'x', messages: [], timeoutMs: 2000 })).ok, false, 'Ollama down');
});

test('mapLimit keeps order and never runs more than the limit at once', async () => {
  let live = 0, peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x) => { live += 1; peak = Math.max(peak, live); await wait(x * 5); live -= 1; return x * 10; });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
});

// ── blind grading ────────────────────────────────────────────────────────────────────────
const T = { id: 'fast-x', ask: 'Q?', rubric: 'Be right.', truth: '' };
const answers = [{ model: 'alpha-model:cloud', text: 'ans one' }, { model: 'beta-model:cloud', text: 'ans two' },
  { model: 'gamma-model:cloud', text: `@../config.json ${'z'.repeat(ANSWER_MAX_CHARS + 50)}` }];

test('the grader sees letters, never a model name; order shuffled; the same cut for all; @path neutralised', () => {
  const seq = [0.9, 0.1];
  const { prompt, letters } = blindBatch({ test: T, answers, rubric: 'R', rng: () => seq.shift() ?? 0.5, tag: 'abcd1234' });
  for (const a of answers) assert.ok(!prompt.includes(a.model), `no model name in the prompt: ${a.model}`);
  assert.deepEqual(Object.keys(letters), ['A', 'B', 'C']);
  assert.notDeepEqual(Object.values(letters), answers.map((a) => a.model), 'the order is shuffled');
  assert.deepEqual([...Object.values(letters)].sort(), answers.map((a) => a.model).sort(), 'every answer is there once');
  assert.ok(!prompt.includes('z'.repeat(ANSWER_MAX_CHARS + 1)), 'cut at the same length');
  assert.ok(!/(^|\s)@\.\.\/config/.test(prompt) && prompt.includes('＠../config.json'), 'the CLI cannot read a file the answer names');
  assert.match(prompt, /<<<ANSWER A abcd1234>>>/);
});

test('grades parse strictly: exactly the letters asked, whole numbers 1-5', () => {
  const letters = { A: 'm1', B: 'm2' };
  assert.deepEqual(parseGrades('{"A":5,"B":2}', letters), { m1: 5, m2: 2 });
  assert.deepEqual(parseGrades('```json\n{"A":1,"B":3}\n```', letters), { m1: 1, m2: 3 });
  assert.throws(() => parseGrades('A is best', letters), /not JSON/);
  assert.throws(() => parseGrades('{"A":5}', letters), /scored A, asked for A,B/);
  assert.throws(() => parseGrades('{"A":5,"B":2,"C":1}', letters), /asked for/);
  assert.throws(() => parseGrades('{"A":4.5,"B":2}', letters), /not 1-5/);
  assert.throws(() => parseGrades('{"A":6,"B":0}', letters), /not 1-5/);
});

test('gradeAll: a failed answer is never graded, a test with none passing costs no call, a grading failure throws', async () => {
  const tests = [{ ...T, id: 't1' }, { ...T, id: 't2' }];
  const results = [{ test: 't1', model: 'a', text: 'x', fail: null }, { test: 't1', model: 'b', text: 'y', fail: 'not valid JSON' },
    { test: 't2', model: 'a', text: '', fail: 'empty answer' }];
  const seen = [];
  const ask = async ({ args, prompt }) => { seen.push({ args, prompt }); return { ok: true, text: '{"A":4}' }; };
  const cfg = { claude_args: ['--dangerously-skip-permissions'], one_shot_args: [...NO_THINKING_ARGS] };
  const g = await gradeAll({ tests, results, rubric: 'R', ask, cfg });
  assert.deepEqual(g, { scores: { t1: { a: 4 }, t2: {} }, calls: 1 });
  assert.ok(!seen[0].prompt.includes('<<<ANSWER B'), 'only the passing answer was sent');
  assert.deepEqual(seen[0].args, graderArgs(cfg));
  assert.deepEqual(graderArgs(cfg).slice(-2), [...NO_TOOLS_ARGS], 'the grader has no tool');
  assert.ok(graderArgs(cfg).includes(NO_THINKING_ARGS[1]), 'and thinking off, from one_shot_args');
  await assert.rejects(gradeAll({ tests, results, rubric: 'R', cfg, ask: async () => ({ ok: false, text: 'Usage limit' }) }), /grading "t1" failed: Usage limit/);
  await assert.rejects(gradeAll({ tests, results, rubric: 'R', cfg, ask: async () => ({ ok: true, text: 'A wins' }) }), /grading "t1" failed: grader reply is not JSON/);
});
