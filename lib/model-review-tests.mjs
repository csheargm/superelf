// Model review test data · 模型评测题目 (docs/adr/0017)
//
// The tests are DATA, read from the file `model_review.tests` names at every run, so an edit
// applies to the next review with no code change. This module turns that file into the exact
// messages each model is sent, and holds the deterministic format checks.
//
// The same message list goes to every model (R14). A test may name a PRODUCTION prompt instead of
// copying it, so the review tests what the apps really send and a later edit of that prompt is
// tested as it is: `system` pieces "guard" (the fast-lane honesty guard, app surface), "language"
// (REPLY_LANGUAGE_RULE), "app:<slug>" (that app's configured directive), and `prompt_ref` "meal"
// (lib/meals.mjs MEAL_PROMPT). These are the pieces web.mjs chat() sends on a fast lane.
import fs from 'node:fs';
import path from 'node:path';
import { fastLaneGuard, REPLY_LANGUAGE_RULE } from './config.mjs';
import { MEAL_PROMPT, parseMealReply } from './meals.mjs';
import { slugOk } from './webutil.mjs';   // the ONE slug shape (R3)

export const GROUPS = ['Fast', 'Deep', 'Vision'];
const CHECKS = ['text', 'json', 'meal', 'skill'];
const LANGS = ['zh', 'en'];
const PROMPT_REFS = { meal: MEAL_PROMPT };

const bad = (file, msg) => { throw new Error(`model review tests (${file}): ${msg}`); };

function systemPiece(name, appPrompts, where) {
  if (name === 'guard') return fastLaneGuard('app');
  if (name === 'language') return REPLY_LANGUAGE_RULE;
  if (name.startsWith('app:')) {
    const p = (appPrompts || {})[name.slice(4)];
    if (typeof p !== 'string' || !p.trim()) throw new Error(`${where}: no configured app directive "${name}"`);
    return p;
  }
  return name;   // literal text
}

function userMessage(t, file, where) {
  const content = t.prompt_ref ? PROMPT_REFS[t.prompt_ref] : t.prompt;
  if (typeof content !== 'string' || !content.trim()) bad(file, `${where}: needs a prompt or a known prompt_ref (${Object.keys(PROMPT_REFS).join(', ')})`);
  const msg = { role: 'user', content };
  if (t.image !== undefined) {
    if (typeof t.image !== 'string' || path.isAbsolute(t.image) || t.image.includes('..')) bad(file, `${where}: image must be a file name beside the tests file`);
    msg.images = [fs.readFileSync(path.join(path.dirname(file), t.image)).toString('base64')];
  }
  return msg;
}

function oneTest(t, file, appPrompts, seen) {
  const where = `test ${JSON.stringify(t && t.id)}`;
  if (!t || typeof t !== 'object' || !slugOk(t.id)) bad(file, `${where}: id must be a lowercase slug`);
  if (seen.has(t.id)) bad(file, `${where}: duplicate id`);
  seen.add(t.id);
  if (!GROUPS.includes(t.group)) bad(file, `${where}: group must be one of ${GROUPS.join(', ')}`);
  if (!CHECKS.includes(t.check)) bad(file, `${where}: check must be one of ${CHECKS.join(', ')}`);
  if (t.lang !== undefined && !LANGS.includes(t.lang)) bad(file, `${where}: lang must be zh or en`);
  if (t.check === 'json' && !(Array.isArray(t.keys) && t.keys.length && t.keys.every((k) => typeof k === 'string'))) bad(file, `${where}: a json check needs "keys"`);
  if (t.check === 'skill' && !(Array.isArray(t.must) && t.must.length && t.must.every((k) => typeof k === 'string' && k.trim()))) bad(file, `${where}: a skill check needs "must" (words the skill has to carry)`);
  if (typeof t.rubric !== 'string' || !t.rubric.trim()) bad(file, `${where}: needs a rubric`);
  const sys = Array.isArray(t.system) ? t.system : [];
  let system;
  try { system = sys.map((s) => ({ role: 'system', content: systemPiece(String(s), appPrompts, where) })); }
  catch (e) { bad(file, e.message); }
  const user = userMessage(t, file, where);
  return { id: t.id, group: t.group, quick: t.quick === true, check: t.check, keys: t.keys || [], must: t.must || [], lang: t.lang || null,
    rubric: t.rubric, truth: typeof t.truth === 'string' ? t.truth : '', ask: user.content, messages: [...system, user] };
}

// { rubric, tests: [{ id, group, quick, check, keys, lang, rubric, truth, ask, messages }] }.
// Throws with the file and the reason on anything malformed: a review on a broken test set is a
// failed run, never a review that quietly tested less.
export function loadReviewTests(file, { appPrompts } = {}) {
  let o;
  try { o = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { bad(file, `unreadable: ${e.message}`); }
  if (!o || typeof o.rubric !== 'string' || !Array.isArray(o.tests)) bad(file, 'needs "rubric" and a "tests" list');
  const seen = new Set();
  const tests = o.tests.map((t) => oneTest(t, file, appPrompts, seen));
  for (const g of ['Fast', 'Deep']) if (!tests.some((t) => t.group === g)) bad(file, `no ${g} test`);
  if (!tests.some((t) => t.quick)) bad(file, 'no quick test for round 1');
  return { rubric: o.rubric, tests };
}

const CJK = /[㐀-鿿豈-﫿]/g;
const LATIN = /[A-Za-z]/g;
const count = (s, re) => (s.match(re) || []).length;
// zh: at least as many Chinese characters as Latin letters. en: Chinese is under a tenth of the
// letters (a quoted term is fine, a Chinese reply is not).
function langOk(lang, s) {
  const zh = count(s, CJK), en = count(s, LATIN);
  return lang === 'zh' ? zh > 0 && zh >= en : zh * 10 < Math.max(en, 1);
}

// What our apps do before JSON.parse (lib/meals.mjs parseMealReply): trim and drop one fence.
const unfence = (s) => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

// A skill as Hermes keeps one (the box's agent/skills/<name>/SKILL.md): YAML front matter with a
// `name` slug and a `description`, then the procedure as at least SKILL_MIN_STEPS numbered or
// bulleted steps. `must` are the words of the user's correction the skill has to carry, so a model
// that writes a pretty skill and drops the rule it was asked to keep fails here, before grading.
const SKILL_MIN_STEPS = 3;
const STEP = /^\s*(?:\d+[.)]|[-*])\s+\S/gm;
function skillFail(test, s) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(unfence(s));
  if (!m) return 'not a SKILL.md: no --- front matter ---';
  if (!/^name:\s*[a-z0-9][a-z0-9-]*\s*$/m.test(m[1])) return 'front matter lacks a name slug';
  if (!/^description:\s*\S/m.test(m[1])) return 'front matter lacks a description';
  if ((m[2].match(STEP) || []).length < SKILL_MIN_STEPS) return `fewer than ${SKILL_MIN_STEPS} steps`;
  const low = s.toLowerCase();
  const dropped = test.must.filter((w) => !low.includes(w.toLowerCase()));
  return dropped.length ? `the skill dropped the rule about: ${dropped.join(', ')}` : null;
}

// null = the answer passes; otherwise the reason it fails. A failed answer is never graded: it
// scores 0, the same as no answer (R14).
export function checkAnswer(test, text) {
  const s = String(text ?? '');
  if (!s.trim()) return 'empty answer';
  if (test.check === 'meal') return parseMealReply(s) ? null : 'not the meal JSON the app parses';
  if (test.check === 'skill') { const why = skillFail(test, s); if (why) return why; }
  if (test.check === 'json') {
    let j;
    try { j = JSON.parse(unfence(s)); } catch { return 'not valid JSON'; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return 'JSON is not an object';
    const missing = test.keys.filter((k) => !(k in j));
    if (missing.length) return `JSON lacks ${missing.join(', ')}`;
  }
  if (test.lang && !langOk(test.lang, s)) return `not in ${test.lang === 'zh' ? 'Chinese' : 'English'}`;
  return null;
}
