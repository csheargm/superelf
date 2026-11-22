// lib/followup-question.mjs + the brief formatting in lib/summary-followup.mjs, on a reported case
// (a SYNTHETIC fixture, test/fixtures-followup-fasting.mjs): "Fasting research" from a small-business
// Entrepreneurship meeting. The question step sees the to-do AND the summary's themes; a question with a person
// falls back to the bare line; the personal guard runs FIRST; bullets are whole sentences, never cut mid-word,
// no meta sentence, and sources are ≤2 markdown links.
// R11 — searched: "summaryContext", "searchQuestion", "cutWhole", "META_RE", "SOURCE_TITLE_CHARS" — no duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryContext, searchQuestion, questionPrompt, CONTEXT_CHARS, QUESTION_PROMPT } from '../lib/followup-question.mjs';
import { buildFollowup, researchBullets, cutWhole, BULLET_CHARS, SOURCES_MAX, TODO_HEADING } from '../lib/summary-followup.mjs';
import { FASTING_SUMMARY, FASTING_TODO } from './fixtures-followup-fasting.mjs';

test('summaryContext: the title and each section\'s heading + first line, the to-do and Sources sections left out, capped whole', () => {
  const c = summaryContext(FASTING_SUMMARY);
  assert.match(c, /Small-business owners weekly meeting/); assert.match(c, /God of abundance/); assert.match(c, /Reflections/);
  assert.equal(c.includes(FASTING_TODO), false, 'the to-do itself is not its own context'); assert.equal(c.includes('Journal, Nov 10'), false, 'Sources left out');
  assert.equal(/#summary|\[1\]/.test(c), false, 'tags and refs undressed');
  const long = summaryContext('## A\n- ' + 'word '.repeat(200));
  assert.ok(long.length <= CONTEXT_CHARS); assert.match(long, /word…$/, 'cut at a word end');
});

test('searchQuestion: the writer gets the to-do + the context; its one question goes out; a person in it, an error or nothing → the bare to-do', async () => {
  let got = '';
  const q = await searchQuestion(FASTING_TODO, summaryContext(FASTING_SUMMARY), async (p) => { got = p; return '"Christian spiritual fasting: how to start a practice, types, and health safety"\nextra'; });
  assert.ok(got.startsWith(QUESTION_PROMPT) && got.includes('To-do · 待办: Fasting research') && got.includes('God of abundance'));
  assert.deepEqual(q, { question: 'Christian spiritual fasting: how to start a practice, types, and health safety', via: 'writer' });
  assert.deepEqual(await searchQuestion('X', 'ctx', async () => 'Ask my sister about X'), { question: 'X', via: 'item' });
  assert.deepEqual(await searchQuestion('X', 'ctx', async () => ''), { question: 'X', via: 'item' });
  assert.equal((await searchQuestion('X', 'ctx', async () => { throw new Error('lane down'); })).error, 'lane down');
  assert.deepEqual(await searchQuestion('X', '', async () => { throw new Error('not called'); }), { question: 'X', via: 'item' });
  assert.equal(questionPrompt('a', ''), QUESTION_PROMPT + '\n\nTo-do · 待办: a');
});

test('the personal guard still runs FIRST: a personal to-do in the same summary never reaches the question step or the search', async () => {
  const text = FASTING_SUMMARY.replace(`- ${FASTING_TODO} [1]`, `- Find out whether Pastor Lee wants to fast with us\n- ${FASTING_TODO} [1]`);
  const researched = [], suggested = [];
  const r = await buildFollowup(text, { research: async (q, ctx) => { researched.push([q, ctx]); return { ok: true, text: '- Start with one meal a week.', sources: [] }; }, suggest: async (q) => { suggested.push(q); return 'Text him.'; } });
  assert.deepEqual(researched.map((x) => x[0]), [FASTING_TODO]); assert.match(researched[0][1], /God of abundance/, 'the research lane is handed the context');
  assert.deepEqual(suggested, ['Find out whether Pastor Lee wants to fast with us']); assert.equal(r.partial, false);
});

test('brief format: ≤3 whole-sentence bullets, the meta sentence dropped, no mid-word cut, then ≤2 [title](url) links', () => {
  const answer = '- Fasting research in these sources covers benefits, metabolic/psychological effects, and risks:\n' +
    '- Start with a 12-hour overnight fast once a week and pair it with a set prayer time [1].\n' +
    '- Read "Celebration of Discipline" chapter 4 on fasting as a spiritual practice [2].\n' +
    '- Skip extended fasts if you are diabetic, pregnant or on medication, and talk to a doctor first [3].\n- A fourth line.' +
    '\n\n**Sources · 来源**\n1. [x](https://a.org/1)';
  const b = researchBullets({ text: answer, sources: [{ title: 'Fasting as a Spiritual Discipline [Guide] (2025) — a very long title for the page', url: 'https://www.desiringgod.org/fasting' },
    { title: 'Intermittent fasting: what is it?', url: 'https://www.hopkinsmedicine.org/if' }, { title: 'third', url: 'https://c.org' }, { title: 'bad', url: 'https://d.org', error: 'x' }] });
  assert.equal(b.length, 4); assert.match(b[0], /^Start with a 12-hour/); assert.equal(b.some((l) => /these sources/.test(l)), false);
  const links = [...b[3].matchAll(/\[([^\]]+)\]\((https:[^)]+)\)/g)];
  assert.equal(links.length, SOURCES_MAX); assert.equal(links[0][2], 'https://www.desiringgod.org/fasting'); assert.ok(links[0][1].length <= 48 && !/[[\]()]/.test(links[0][1]));
  const s = 'In mice, fasting boosts intestinal stem-cell regeneration and injury repair, but cancerous mutations during the regeneration window raise the risk. ' + 'More words here '.repeat(10);
  const c = cutWhole(s, BULLET_CHARS);
  assert.ok(c.length <= BULLET_CHARS); assert.ok(c.endsWith('risk.'), 'cut at the sentence end: ' + c);
  const w = cutWhole('alpha beta gamma delta', 13); assert.equal(w, 'alpha beta…', 'at a word end, never "gam"');
  assert.equal(cutWhole('短句', 10), '短句');
  assert.deepEqual(researchBullets({ text: '', sources: [{ title: 't', url: 'https://a.org' }] }), [], 'no bullets: no lonely sources line (R14 → No answer)');
});

test('the to-do heading constant the fixture uses is the lib\'s', () => { assert.ok(FASTING_SUMMARY.includes('## ' + TODO_HEADING)); });
