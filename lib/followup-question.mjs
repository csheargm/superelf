// Follow-up question（跟进问题）— the step before a to-do's research (docs/plans/note-features.md I,
// ADR 0027 addendum 2026-11-12). A bare to-do line ("Fasting research") is a poor search: the owner's
// report was a block about intestinal stem cells in mice for a to-do written in a Christian
// entrepreneurs' meeting. So the item goes out WITH a short context from the summary it came from
// (its headings and their first lines, capped at CONTEXT_CHARS), and the writer lane turns the two
// into ONE specific search question in the writer's likely intent.
//
// PRIVACY（隐私）: the context reaches only the writer LLM (by default the Claude lane, the one that wrote
// the summary). The SEARCH ENGINE gets the one question the writer returns, and only after
// hasPersonalCue clears it: a question that picked up a person, a relative or a contact verb falls
// back to the bare to-do line (which already passed the same guard in classifyTodo).
import { hasPersonalCue, isTodoHeading, cutWhole } from './summary-followup.mjs';

export const CONTEXT_CHARS = 400;      // the summary context the question step and the writer see, per summary
export const QUESTION_CHARS = 200;     // the search question's own cap (Tavily takes a sentence, not a page)
// ONE prompt for the question step (R3).
export const QUESTION_PROMPT = 'Turn this to-do into ONE specific web-search question for what its writer most likely wants to learn, ' +
  'judging by the notes it came from. At most 20 words. No names of people, no private details. Output only the question. · ' +
  '把这条待办改写成一个具体的网络搜索问题，贴合写下它的人最可能想了解的内容；不超过 30 字；不含人名或隐私；只输出问题。';

const strip = (l) => String(l || '').replace(/^\s*(?:#{1,6}\s*|[-*•]\s+|\d+[.)]\s+)/, '').replace(/\*\*|__|`/g, '')
  .replace(/\s?\[\d{1,3}\]/g, '').replace(/(^|\s)#[\w-]+/g, '$1').replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim();
const isHead = (l) => /^\s*#{1,6}\s/.test(l) || /^\s*\*\*[^*]{1,80}\*\*:?\s*$/.test(l);
const SKIP_HEAD_RE = /^(?:sources?|来源|references?)\b/i;

// The summary's themes: its first line (the title) and each section heading with that section's first
// line, the to-do and Sources sections left out, joined and cut at a word boundary.
export function summaryContext(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  const parts = []; let head = null, took = false;
  for (const l of lines) {
    if (isHead(l)) { head = strip(l); took = isTodoHeading(l) || SKIP_HEAD_RE.test(head); if (!took) parts.push(head); continue; }
    if (!took) { parts.push(strip(l)); took = true; if (!head) head = ''; }
  }
  return cutWhole(parts.filter(Boolean).join(' · '), CONTEXT_CHARS);
}

export const questionPrompt = (item, context) => QUESTION_PROMPT + '\n\nTo-do · 待办: ' + item + (context ? '\n\nNotes it came from · 来源笔记: ' + context : '');

// The search question for a researchable to-do: the writer's first line, unquoted and capped; the bare
// item when there is no context, the writer fails or answers nothing, or its question carries a
// personal cue. `ask(prompt)` → the writer's text (lib/research-writer.mjs). Never throws: the bare
// item is the honest fallback and `via` says which one went out.
export async function searchQuestion(item, context, ask) {
  if (!context || typeof ask !== 'function') return { question: item, via: 'item' };
  let out = '';
  try { out = String(await ask(questionPrompt(item, context)) || ''); }
  catch (e) { return { question: item, via: 'item', error: String((e && e.message) || e).slice(0, 100) }; }   // R5: carried to the caller, the bare item still researched
  const q = cutWhole(strip(out.split(/\r?\n/).find((l) => l.trim()) || '').replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, ''), QUESTION_CHARS);
  if (!q || hasPersonalCue(q)) return { question: item, via: 'item' };
  return { question: q, via: 'writer' };
}
