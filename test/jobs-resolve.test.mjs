// Resolver（意图解析）— a sentence becomes a job. Offline: the model is injected, so these
// tests never call one and never depend on what a model happens to say today.
//
// The rule being enforced is the user's: best effort, and ASK only when a guess would make
// the job wrong. The two failure modes it must not have are a job that silently does nothing,
// and a job built on an invented fact (a postcode, a URL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenFrom, timeIn, dayIn, DEFAULT_TIME, UNSUPPORTED, MULTI_DAY } from '../lib/jobs/when.mjs';
import { resolvePrompt, buildResolvePrompt, parseResolveReply, missingInputs } from '../lib/jobs/resolve.mjs';
import { manifests, runnableTools } from '../lib/jobs/tools.mjs';

const tools = manifests(), runnable = runnableTools();
const says = (o) => async () => (typeof o === 'string' ? o : JSON.stringify(o));
const POLLEN = { title: '花粉预警 · Pollen', tool: 'pollen', args: { zip: '12345' }, missing: [] };

/* ── when: deterministic, no model ── */
test('the clock is read, not guessed', () => {
  for (const [s, want] of [['at 7am', '07:00'], ['9:45pm nightly', '21:45'], ['07:30', '07:30'],
    ['12am', '00:00'], ['12pm', '12:00'], ['at 6', '06:00'], ['每天早上7点', '07:00'],
    ['每天下午3点', '15:00'], ['每周日晚上9点', '21:00'], ['中午12点', '12:00']]) {
    assert.equal(timeIn(s), want, s);
  }
  assert.equal(timeIn('tell me about pollen'), null, 'no time said = no time invented');
});

test('晚上9点 is 21:00 — the marker carries the AM/PM the digit does not', () => {
  // Reading it as 09:00 would fire the job twelve hours early, every day, silently.
  assert.equal(timeIn('晚上9点'), '21:00');
  assert.equal(timeIn('下午3点'), '15:00');
  assert.equal(timeIn('早上7点'), '07:00');
  assert.equal(timeIn('上午9点'), '09:00');
});

test('a weekday is only used when one is actually named', () => {
  assert.equal(dayIn('every Sunday at 8pm'), 0);
  assert.equal(dayIn('每周三'), 3);
  assert.equal(dayIn('every morning'), undefined, 'daily must not become weekly — that is one seventh as often');
  assert.deepEqual(whenFrom('every morning check the news'), { schedule: { time: DEFAULT_TIME } });
  assert.deepEqual(whenFrom('every Sunday at 8pm'), { schedule: { time: '20:00', day: 0 } });
});

test('a schedule we cannot express is REPORTED, never rounded to something else', () => {
  for (const s of ['every 30m check the queue', 'in 2h remind me', 'hourly']) {
    assert.match(whenFrom(s).unsupported || '', /intervals|one-shot/i, s);
  }
  // Mon-Fri is five days; the schedule holds one day or none. Treating it as daily would run
  // the job at the weekend too.
  for (const s of ['weekdays at 9am', 'Mon-Fri at 08:00', '工作日早上9点', 'weekends']) {
    assert.match(whenFrom(s).unsupported || '', /several named days/i, s);
  }
  assert.ok(UNSUPPORTED.test('every 15 minutes') && MULTI_DAY.test('weekdays'));
});

test('silence about time is not an error — it is daily', () => {
  assert.deepEqual(whenFrom('alert me if pollen is high'), {}, 'nothing said');
  assert.equal(whenFrom('alert me if pollen is high').unsupported, undefined);
});

/* ── resolve ── */
test('a sentence becomes a complete, PAUSED job', async () => {
  const r = await resolvePrompt('alert me if the pollen count is high today',
    { ask: says(POLLEN), tools, runnable, profile: { postcode: '12345' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.job.plan.tool, 'pollen');
  assert.deepEqual(r.job.plan.args, { zip: '12345' });
  assert.equal(r.job.enabled, false, 'ALWAYS paused — nothing may message anyone before review');
  assert.equal(r.job.deliver, 'own-message', 'its own message by default');
  assert.equal(r.job.author, 'chat');
  assert.equal(r.job.prompt, 'alert me if the pollen count is high today', 'the sentence is kept as the source of truth');
  assert.equal(r.usedDefaultTime, true, 'and it says the time was a default, not something you asked for');
});

test('the deterministic schedule wins — the model is not asked about time', async () => {
  const r = await resolvePrompt('every Sunday at 8pm tell me the pollen',
    { ask: says({ ...POLLEN, schedule: { time: '03:00' } }), tools, runnable });   // model tries to set 03:00
  assert.deepEqual(r.job.schedule, { time: '20:00', day: 0 }, "the sentence decides the clock, not the model's guess");
});

test('it ASKS only for an input it genuinely cannot infer — and names it', async () => {
  const r = await resolvePrompt('alert me if pollen is high',
    { ask: says({ title: 'P', tool: 'pollen', args: {}, missing: ['zip'] }), tools, runnable, profile: {} });
  assert.equal(r.ok, false);
  assert.deepEqual(r.ask.map((a) => a.input), ['zip']);
  assert.match(r.ask[0].describe, /postcode/i, 'the question carries the manifest description, not a bare field name');
  assert.ok(r.draft && r.draft.tool === 'pollen', 'and a draft comes back so the form is not left empty');
});

test('the MANIFEST decides what is missing, not the model', async () => {
  // A model that forgets to list a required input would otherwise produce a job that fails on
  // its first run — a "working" job that never works.
  const r = await resolvePrompt('pollen please',
    { ask: says({ title: 'P', tool: 'pollen', args: {}, missing: [] }), tools, runnable });
  assert.equal(r.ok, false);
  assert.deepEqual(r.ask.map((a) => a.input), ['zip'], 'caught despite missing:[]');
  assert.deepEqual(missingInputs(tools.pollen, {}), ['zip']);
  assert.deepEqual(missingInputs(tools.pollen, { zip: '1' }), []);
  // and a field the model invents is not turned into a question
  const r2 = await resolvePrompt('x', { ask: says({ title: 'P', tool: 'pollen', args: { zip: '1' }, missing: ['unicorn'] }), tools, runnable });
  assert.equal(r2.ok, true, 'an unknown "missing" field is ignored, not asked about');
});

test('an unusable answer FAILS loudly — never a job that quietly does nothing', async () => {
  const bad = [
    ['no JSON', says('I think you want pollen.'), /did not answer with JSON/],
    ['truncated', says('{"tool":"pollen"'), /truncated/],
    ['not parseable', says('{tool: pollen}'), /did not parse/],
    ['unknown tool', says({ title: 'x', tool: 'telepathy', args: {} }), /no tool for that yet/],
    ['a tool that is catalogued but NOT runnable', says({ title: 'x', tool: 'calendar', args: {} }), /no tool for that yet/],
  ];
  for (const [why, ask, re] of bad) {
    const r = await resolvePrompt('do a thing', { ask, tools, runnable });
    assert.equal(r.ok, false, why);
    assert.match(r.error, re, why);
  }
  const boom = await resolvePrompt('x', { ask: async () => { throw new Error('offline'); }, tools, runnable });
  assert.match(boom.error, /could not reach the model.*offline/i, 'a model outage is reported, not swallowed');
  assert.match((await resolvePrompt('', { ask: says(POLLEN), tools, runnable })).error, /say what the job should do/);
  assert.match((await resolvePrompt('x', { ask: says(POLLEN), tools, runnable: [] })).error, /no runnable tools/);
});

test('JSON is taken from a balanced object, even wrapped in prose or a fence', () => {
  const wrapped = 'Sure! ```json\n{"tool":"pollen","args":{"note":"a } brace in a string"}}\n``` hope that helps';
  const p = parseResolveReply(wrapped);
  assert.equal(p.ok, true);
  assert.equal(p.value.args.note, 'a } brace in a string', 'a brace inside a string must not end the object');
});

test('the model is told what it may use, and told not to invent facts', () => {
  const q = buildResolvePrompt('watch the news', { tools, runnable, profile: { postcode: '12345' } });
  assert.match(q, /pollen:/); assert.match(q, /research:/);
  assert.ok(!q.includes('calendar:'), 'a non-runnable tool must not be offered');
  assert.match(q, /postcode: 12345/, 'what we know is supplied, so it does not have to ask');
  assert.match(q, /Never invent a postcode, address, URL or credential/);
  assert.match(q, /ONLY a JSON object/);
  assert.doesNotMatch(buildResolvePrompt('x', { tools, runnable, profile: {} }), /postcode:/, 'nothing known = nothing claimed');
});

test('whatever the model returns is shaped by the STORE, not returned raw', async () => {
  // validateJob is the authority on what a job IS. Its output is what comes back, so the
  // editor can never be handed a job that saveJob would then refuse.
  const r = await resolvePrompt('x', { ask: says({ title: 'P', tool: 'pollen', args: { zip: '1' } }), tools, runnable });
  assert.equal(r.ok, true);
  assert.equal(r.job.source, 'file', 'only validateJob adds `source` — proof the store shaped this');
  assert.equal(r.job.name, r.job.id, 'and gave it the `name` the scheduler keys on');

  // A title the model left empty degrades to the tool name rather than failing: a job called
  // "pollen" is poor, a resolver that refuses the whole request over a blank title is worse.
  const blank = await resolvePrompt('x', { ask: says({ title: '', tool: 'pollen', args: { zip: '1' } }), tools, runnable });
  assert.equal(blank.ok, true);
  assert.equal(blank.job.title, 'pollen');

  // But an id that could never be a filename is sanitised, never passed through.
  const wild = await resolvePrompt('x', { ask: says({ id: '../../etc/passwd', title: 'Pollen Alert!', tool: 'pollen', args: { zip: '1' } }), tools, runnable });
  assert.equal(wild.ok, true);
  assert.match(wild.job.id, /^[a-z0-9][a-z0-9-]*$/, `traversal must not survive: ${wild.job.id}`);
});
