// Summary follow-up（总结跟进）— the automatic research after a period summary (docs/plans/note-features.md I,
// ADR 0027). The summary turn ends with an `待办 · Open to-dos` section (TODO_HEADING: the prompt asks for
// it, this file looks for it); the node extracts the items, classifies each as RESEARCHABLE (a question
// about the world → lib/research.mjs, Tavily + Firecrawl) or PERSONAL (an action in the owner's own life
// → one sentence from the writer, lib/research-writer.mjs), and answers ONE brief block the client appends to the saved note.
//
// PRIVACY（隐私）: the search engine gets ONE question per researchable to-do — the writer's rewrite of the
// to-do with the summary's short context (lib/followup-question.mjs), cleared by the personal-cue guard,
// else the to-do's own line — never the summary body, the notes or the history. The context (≤ 400 chars
// of headings and first lines) reaches only the writer LLM (lib/research-writer.mjs, Claude by default,
// the lane that wrote the summary). A personal to-do is classified FIRST and never searched (ADR 0027).
// Every outcome is honest (R5/R14): a failed or timed-out item is NAMED on its own line and the block
// is marked partial; no key means the research items say so; an empty answer is a failure.

export const TODO_HEADING = '待办 · Open to-dos';          // = PADrawerSummary.TODO_HEADING (web/drawer-summary.inline.html), pinned by test
export const FOLLOWUP_HEADING = '跟进 · Follow-up';         // the block's heading in the saved note; the route answers it, the client writes it
export const RESEARCH_MAX_ITEMS = 5;                       // researchable to-dos sent to the research lane per summary
export const ITEMS_MAX = 10;                               // to-dos considered at all (the rest of a long list is dropped, said in `dropped`)
// A bullet is ONE whole sentence (~25 words); a cap cuts at a sentence or word end, never mid-word (cutWhole).
export const BULLETS_MAX = 3, BULLET_CHARS = 200, ITEM_CHARS = 160, SOURCES_MAX = 2, SOURCE_TITLE_CHARS = 48;
export const DEFAULT_ITEM_TIMEOUT_MS = 90000;               // cfg.summary_followup_item_timeout_ms (lib/config.mjs) overrides
export const FOLLOWUP_CONCURRENCY = 2;                     // items in flight at once (research and suggestion alike): bounds the lanes' load and the block's worst case
import { summaryContext, searchQuestion } from './followup-question.mjs';
import { makeWriter, writerChain } from './research-writer.mjs';

export const KIND_RESEARCH = 'research', KIND_PERSONAL = 'personal';
export const TXT = Object.freeze({
  unavailable: '本节点无法联网研究 · Research unavailable on this node',
  failed: '失败 · Failed', empty: '无回答 · No answer', capped: '未研究（上限 {n}） · Not researched (cap {n})',
  noResult: '未得结果 · No result', timedOut: '超时 · timed out after {ms}ms',   // a per-item deadline that passed (fail-closed: the line stands, the block goes on)
  sources: '来源 · Sources', noTodos: '未找到待办 · No open to-dos found',
});
// ONE prompt for a personal to-do's suggestion (R3): one sentence, the item's language.
export const SUGGEST_PROMPT = 'Give ONE practical suggestion, in one whole sentence of at most 20 words, for this personal to-do. ' +
  'Answer in the language the to-do is written in; no preamble, no list. · 针对这条个人待办给出一条实用建议，一行、不超过 30 字，用待办所用的语言回答，不要前言，不要列表。\n\nTo-do · 待办: ';

// The research synthesis's shape and reader (lib/research.mjs buildResearchPrompt `guide`), with the to-do and its notes.
export const BRIEF_GUIDE = 'Write for the person who wrote this to-do in the notes below. Answer in AT MOST 3 lines, each starting ' +
  'with "- ", each ONE whole sentence of at most 25 words, practical for them: what to do, what to read, and the one safety ' +
  'note if there is one. Cite [n]. No preamble and no sentence about the sources themselves. · 最多 3 行，每行一句完整的话（不超过 40 字），' +
  '对写下待办的人实用：做什么、读什么、一条安全提示；用 [n] 引用；不要前言，不要评论来源本身。';
export const briefGuide = (item, context) => BRIEF_GUIDE + '\n\n待办 · To-do: ' + item + (context ? '\n笔记 · Notes: ' + context : '');

const fill = (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => String(o[k] == null ? '' : o[k]));
// Cut at the last sentence end within n (when it keeps at least half), else the last word end + '…'.
// Text without spaces (中文) is cut at a character, which is a whole character. Never mid-word.
export function cutWhole(s, n) {
  s = String(s || '').trim();
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const end = Math.max(...['. ', '! ', '? ', '。', '！', '？', '; '].map((p) => head.lastIndexOf(p)));
  if (end >= n / 2) return head.slice(0, end + 1).trim();
  const w = head.slice(0, n - 1).lastIndexOf(' ');
  return (w > 0 ? head.slice(0, w) : head.slice(0, n - 1)).replace(/[\s,;:—-]+$/, '') + '…';
}
const errText = (e) => String((e && e.message) || e || 'failed').slice(0, 100);
// Markdown undressed: list markers, checkboxes, emphasis, code ticks, the summary's own [n] refs.
const clean = (line) => String(line || '').replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, '')
  .replace(/\s?\[\d{1,3}\]/g, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
const isHeading = (line) => /^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]{1,80}\*\*:?\s*$/.test(line);
// The to-do heading in either language, however the model wrote it: `## Open to-dos`, `**待办事项**`, `Open To-Dos:`.
const TODO_HEAD_RE = /(open\s+to-?\s?dos?|to-?\s?do\s*list|待办)/i;
const headingText = (line) => line.replace(/^\s*#{1,6}\s*/, '').replace(/\*\*|__/g, '').replace(/[:：]\s*$/, '').trim();
export const isTodoHeading = (line) => isHeading(line) && TODO_HEAD_RE.test(headingText(line)) && headingText(line).length <= 60;

// A placeholder the model writes when the section is empty ("None.", "**None.** No open to-dos…", "无", "暂无")
// is no to-do: researching it made the summary say None and then list one (F3-03).
const NONE_ITEM_RE = /^(?:\(?(?:none|nothing(?:\s+open)?|n\/?a|no\s+(?:open\s+)?to-?\s?dos?)\)?(?=$|[\s.。,，:：;!])|[(（]?(?:无|暂无|没有|没有待办|无待办)[)）]?(?=$|[\s.。,，:：;!！]))/i;
// The items under the to-do heading: list lines until the next heading, each undressed, capped and
// unique. A summary without the section answers []. `dropped` counts items past ITEMS_MAX.
export function extractTodos(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex(isTodoHeading);
  if (at < 0) return { items: [], dropped: 0, found: false };
  const items = [];
  for (const line of lines.slice(at + 1)) {
    if (isHeading(line)) break;
    if (!/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) continue;
    const it = cutWhole(clean(line), ITEM_CHARS);
    if (it && !NONE_ITEM_RE.test(it) && !items.includes(it)) items.push(it);
  }
  return { items: items.slice(0, ITEMS_MAX), dropped: Math.max(0, items.length - ITEMS_MAX), found: true };
}

// A question about the world goes out; an action in the owner's life stays in. A PERSONAL CUE anywhere
// wins first (PERSONAL_CUE_RE: a named person after a preposition, a relative, a contact verb — `Find
// out whether Taylor wants the sofa` is about Taylor, never a search), then a personal verb at the START
// (`Call the dentist about whether…` is a call), then a research cue, else personal: the default keeps
// a line OFF the search engine when the two readings tie. Known limit: a brand after a preposition
// (`prices for Honda`) reads as a person and stays home — the safe side (ADR 0027).
const PERSONAL_START_RE = /^(?:call|phone|ring|email|e-mail|text|message|reply|answer|pay|send|write|book|schedule|buy|order|get|clean|tidy|fix|repair|visit|meet|see|ask|tell|remind|submit|renew|cancel|pick\s+up|drop\s+off|print|sign|file|return|finish|start|prepare|bring|take|go\s+to|follow\s+up)\b/i;
const PERSONAL_START_ZH_RE = /^(?:打电话|联系|给.{0,8}?(?:发|打|回|寄)|付|交|缴|买|预约|发|写|回复|回信|清理|打扫|修|去|见|提醒|提交|续|取消|取|打印|签|完成|开始|准备|带|拿|跟进|问)/;
const PERSONAL_CUE_RE = /\b(?:call|phone|ring|email|e-mail|text|message|reply|pay|ask|tell|remind|invite|thank|apologi[sz]e|visit|meet)\b|\b(?:mom|mum|mother|dad|father|parents?|wife|husband|spouse|partner|son|daughter|kids?|children|child|brother|sister|grandm(?:a|other)|grandp(?:a|father)|aunt|uncle|cousin|niece|nephew|family|boss|landlord|doctor|dentist|pastor|teacher|coach)\b|\b(?:with|for|to|from|about|at|whether|if|when|while)\s+[A-Z][a-z]+(?:'s)?\b/;
const PERSONAL_CUE_ZH_RE = /(?:打电话|联系|问问|告诉|提醒|付款|交钱|缴费|发邮件|邀请|感谢|道歉|妈|爸|父母|妻|老婆|老公|丈夫|儿子|女儿|孩子|哥|姐|弟|妹|奶奶|爷爷|外婆|外公|阿姨|叔叔|家人|老板|房东|医生|牙医|老师|牧师|教练)/;
const RESEARCH_RE = /\b(?:research|look\s+(?:up|into)|find\s+out|figure\s+out|check\s+(?:if|whether|what|how|which|when|where)|compare|learn\s+(?:about|how)|read\s+(?:up|about)|how\s+(?:to|do|does|much|many|long|can)|what\s+(?:is|are|does|do|was)|which|whether|best|prices?|costs?|reviews?|options?|vs\.?|versus|alternatives?)\b/i;
const RESEARCH_ZH_RE = /(?:研究|查一下|查查|查找|查询|了解|比较|对比|怎么|怎样|如何|什么|哪个|哪些|哪里|是否|多少|价格|费用|推荐|评测|方案|选择)/;
export const hasPersonalCue = (s) => PERSONAL_CUE_RE.test(s) || PERSONAL_CUE_ZH_RE.test(s);
export function classifyTodo(item) {
  const s = String(item || '').trim();
  if (hasPersonalCue(s) || PERSONAL_START_RE.test(s) || PERSONAL_START_ZH_RE.test(s)) return KIND_PERSONAL;
  if (/[?？]\s*$/.test(s) || RESEARCH_RE.test(s) || RESEARCH_ZH_RE.test(s)) return KIND_RESEARCH;
  return KIND_PERSONAL;
}

function withTimeout(p, ms) {
  let t;
  const deadline = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(fill(TXT.timedOut, { ms })), { code: 'timeout' })), ms); });
  return Promise.race([p, deadline]).finally(() => clearTimeout(t));   // cleared either way: a settled race must not hold the process
}
// At most `limit` tasks in flight, results in the tasks' order; a task that settles frees its slot
// (a timed-out one too: the race rejected, the lane's own promise is no longer waited on).
async function runPool(tasks, limit) {
  const out = new Array(tasks.length); let next = 0;
  const worker = async () => { while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return out;
}
// A meta line about the sources rather than the to-do ("Fasting research in these sources covers…:"), or a lead-in ending in ':'.
const META_RE = /\b(?:these|the|provided|above)\s+(?:sources|excerpts|results|articles)\b|^(?:according to|based on|here (?:is|are))\b|[:：]$/i;
const linkTitle = (s) => cutWhole(String(s.title || '').replace(/[[\]()]/g, ' ').replace(/\s+/g, ' ').trim() || hostOf(s.url), SOURCE_TITLE_CHARS);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; /* a malformed URL names no host: the link is dropped, the bullets still stand */ } };
// A research answer → at most BULLETS_MAX whole-sentence bullets (the answer's own lines before its Sources
// block, lib/research.mjs sourcesBlock, undressed, meta lines dropped, cut whole), then ONE line of up to
// SOURCES_MAX markdown links [title](url) the note renders tappable (web/summary-followup.inline.html).
export function researchBullets(r) {
  const body = String(r.text || '').split(/\n\*\*Sources · 来源\*\*|\nNot read \(scrape failed\)|\nNote 注:/)[0];
  const lines = body.split(/\r?\n/).map(clean).filter((l) => l && !/^#/.test(l) && !META_RE.test(l));
  const links = (Array.isArray(r.sources) ? r.sources : []).filter((s) => s && /^https?:\/\//.test(String(s.url)) && !s.error && hostOf(s.url))
    .filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i).slice(0, SOURCES_MAX);
  const out = lines.slice(0, BULLETS_MAX).map((l) => cutWhole(l, BULLET_CHARS));
  if (out.length && links.length) out.push(TXT.sources + ': ' + links.map((s) => '[' + linkTitle(s) + '](' + s.url + ')').join(' · '));
  return out;
}
const oneLine = (s) => cutWhole(String(s || '').split(/\r?\n/).map(clean).filter((l) => l && !META_RE.test(l))[0] || '', BULLET_CHARS);

// One item's bullets, every failure named on the line (R5). `research` null = no keys on this node.
async function runItem(it, { research, suggest, perItemTimeoutMs, capped, context }) {
  const base = { item: it.item, kind: it.kind };
  try {
    if (it.kind === KIND_RESEARCH) {
      if (!research) return { ...base, ok: false, bullets: [TXT.unavailable] };
      if (capped) return { ...base, ok: false, bullets: [fill(TXT.capped, { n: RESEARCH_MAX_ITEMS })] };
      const r = await withTimeout(Promise.resolve(research(it.item, context)), perItemTimeoutMs);
      if (!r || r.ok === false) { const why = oneLine(r && r.text); return { ...base, ok: false, bullets: [why ? TXT.failed + ' — ' + why : TXT.failed] }; }
      const bullets = researchBullets(r);
      return bullets.length ? { ...base, ok: true, bullets } : { ...base, ok: false, bullets: [TXT.empty] };
    }
    const s = oneLine(await withTimeout(Promise.resolve(suggest(it.item, context)), perItemTimeoutMs));
    return s ? { ...base, ok: true, bullets: [s] } : { ...base, ok: false, bullets: [TXT.empty] };
  } catch (e) { return { ...base, ok: false, bullets: [(e && e.code === 'timeout' ? TXT.noResult : TXT.failed) + ' — ' + errText(e)] }; }
}
// Bullets arrive already cut whole (researchBullets, oneLine, the capped error lines); the sources line is the +1.
export const formatBlock = (results) => results.map((r) => '### ' + r.item + '\n' + r.bullets.slice(0, BULLETS_MAX + 1).map((b) => '- ' + b).join('\n')).join('\n\n');

// The block for a summary's text. `research(item, context)` → the research lane's {ok,text,sources} (null when
// unavailable); `suggest(item, context)` → the writer's text; `context` = summaryContext(text). `fallbacks`
// (a Set the writer fills) names a lane that answered after the first failed: `writerFallback` in the answer. Items run FOLLOWUP_CONCURRENCY at a time, each
// under its own deadline (worst case ⌈n/2⌉ deadlines, never a hang); the answer carries the heading the client writes, the text, per-item outcomes and `partial`.
export async function buildFollowup(text, { research = null, suggest, perItemTimeoutMs = DEFAULT_ITEM_TIMEOUT_MS, fallbacks = null } = {}) {
  const { items, dropped, found } = extractTodos(text);
  const typed = items.map((item) => ({ item, kind: classifyTodo(item) }));
  if (!typed.length) return { ok: true, heading: FOLLOWUP_HEADING, text: '', items: [], partial: false, dropped, found, researched: 0, suggested: 0 };
  let seen = 0; const context = summaryContext(text);
  const results = await runPool(typed.map((it) => { const capped = it.kind === KIND_RESEARCH && ++seen > RESEARCH_MAX_ITEMS; return () => runItem(it, { research, suggest, perItemTimeoutMs, capped, context }); }), FOLLOWUP_CONCURRENCY);
  const fell = fallbacks && fallbacks.size ? [...fallbacks].join(', ') : '';
  return { ok: true, heading: FOLLOWUP_HEADING, text: formatBlock(results), items: results.map(({ item, kind, ok }) => ({ item, kind, ok })), ...(fell ? { writerFallback: fell } : {}),
    partial: results.some((r) => !r.ok), dropped, found,
    researched: results.filter((r) => r.kind === KIND_RESEARCH && r.ok).length, suggested: results.filter((r) => r.kind === KIND_PERSONAL && r.ok).length };
}

// The node's lanes for the route (web.mjs POST /api/summary-followup), built from cfg at use time: research
// only with BOTH keys present (lib/research.mjs needs Tavily to find and Firecrawl to read) and a writer lane;
// the writer (lib/research-writer.mjs, cfg.research.writer, default Claude) writes the search question,
// the synthesis and the suggestions. `agents` = {claude(prompt), codex(prompt, model)} from web.mjs. Key
// VALUES are never read here beyond an existence check and never logged (lib/config.mjs researchEnabled).
const keyOk = (k) => !!(k && !/PASTE/.test(k));
export function followupDeps({ cfg, runResearch, streamOllama, agents = {} }) {
  const fallbacks = new Set();
  const write = makeWriter({ cfg, agents, streamOllama, fallbacks });
  let lanes = 0; try { lanes = writerChain(cfg).length; } catch { lanes = 1; /* an unknown writer: kept, so each item NAMES the config error (write throws it) */ }
  const research = keyOk(cfg.tavily_key) && keyOk(cfg.firecrawl_key) && lanes ? async (item, context) => {
    const { question } = await searchQuestion(item, context, write);
    return runResearch(question, { research: cfg.research, keys: { tavily: cfg.tavily_key, firecrawl: cfg.firecrawl_key }, guide: briefGuide(item, context),
      lanes: { streamOllama: async ({ messages }) => write(messages[messages.length - 1].content) }, ollamaUrl: cfg.ollama_url, model: null, onStatus: () => {}, onDelta: () => {} });
  } : null;
  const suggest = lanes ? (item, context) => write(SUGGEST_PROMPT + item + (context ? '\n\n笔记 · Notes: ' + context : ''))
    : async () => { throw new Error('未配置撰写通道 · no writer lane configured'); };
  return { research, suggest, fallbacks, perItemTimeoutMs: Number(cfg.summary_followup_item_timeout_ms) || DEFAULT_ITEM_TIMEOUT_MS };
}
