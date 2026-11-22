// lib/research.mjs — Web-grounded research lane ("Research · 联网研究"):
// Tavily finds → Firecrawl reads → the configured fast lane reasons over ONLY the
// fetched excerpts, citing them as [n] with a Sources · 来源 list.
//
// PRIVACY CONTRACT（隐私约定）: the only data that ever leaves this module outbound is
// (1) the user's question text, to Tavily, and (2) result URLs, to Firecrawl. It is
// enforced STRUCTURALLY — runResearch(question, deps) receives the question STRING,
// never the convo history, system prompts, or cfg — and by test (research.test.mjs
// asserts the outbound request bodies byte-for-byte). API keys ride only in the
// Authorization header and are never logged or echoed.
//
// R14 semantics: zero search results, or every scrape failing, produces an HONEST
// ungrounded output that says so; failed scrapes are skipped and NAMED; citations to
// sources that were never provided are stripped and flagged (never fabricated).
//
// Deps (streamOllama, fetchImpl) are INJECTED like lib/assess.mjs lanes (R3), so tests
// drive the orchestration with failure-faithful stubs of the real Tavily/Firecrawl JSON.
//
// Planned follow-ups (NOT in v1): Exa semantic search feeding the digest job;
// offering 'research' as an optional Verify · 校验 panelist in lib/assess.mjs.

const ERR_CAP = 200; // error strings shown to the user / stored in source lists
const msg = (e) => String((e && e.message) || e).slice(0, ERR_CAP);

// Race a fetch against a deadline. The timer is CLEARED when the fetch settles (assess
// precedent — a lost timer must not hold the process); abort() also cancels the real
// request. Works even when a test's fetchImpl ignores the signal: the race still wins.
async function fetchWithTimeout(fetchImpl, url, opts, ms) {
  const ctl = new AbortController();
  let t;
  const deadline = new Promise((_, rej) => { t = setTimeout(() => { ctl.abort(); rej(new Error('timeout after ' + ms + 'ms')); }, ms); });
  try { return await Promise.race([fetchImpl(url, { ...opts, signal: ctl.signal }), deadline]); }
  finally { clearTimeout(t); }
}

// Tavily POST /search — body carries ONLY the question + fixed search params (privacy
// contract above). Returns [{title,url,snippet}]; the caller decides how many to read.
// `snippet` is Tavily's own extract: the research lane ignores it (it reads the real page
// via Firecrawl), but tools/websearch.mjs prints it, so ONE client serves both (R3).
export async function tavilySearch({ question, key, url, maxResults, timeoutMs, fetchImpl }) {
  const r = await fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ query: question, search_depth: 'basic', max_results: maxResults }),
  }, timeoutMs);
  if (!r.ok) throw new Error('Tavily HTTP ' + r.status);
  const j = await r.json();
  return (Array.isArray(j.results) ? j.results : [])
    .map((s) => ({ title: String(s.title || s.url || ''), url: String(s.url || ''), snippet: String(s.content || '') }))
    .filter((s) => s.url);
}

// Firecrawl POST /v2/scrape — body carries ONLY the result URL (privacy contract).
// Empty markdown is FAILURE, not a clean result (R14 vacuous-success guard).
export async function firecrawlScrape({ url, key, apiUrl, capBytes, timeoutMs, fetchImpl }) {
  const r = await fetchWithTimeout(fetchImpl, apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ url, formats: ['markdown'] }),
  }, timeoutMs);
  if (!r.ok) throw new Error('Firecrawl HTTP ' + r.status);
  const j = await r.json();
  if (!j.success || !j.data || !String(j.data.markdown || '').trim()) {
    throw new Error(String((j && j.error) || 'empty scrape').slice(0, ERR_CAP));
  }
  return String(j.data.markdown).slice(0, capBytes);
}

// Scrape the picked URLs in parallel, each under its own timeout. A failed scrape is
// kept — with its error — so the output can NAME it (R14); never silently dropped.
async function readSources(picks, { key, apiUrl, capBytes, timeoutMs, fetchImpl }) {
  const settled = await Promise.all(picks.map(async (s) => {
    try { return { ...s, excerpt: await firecrawlScrape({ url: s.url, key, apiUrl, capBytes, timeoutMs, fetchImpl }) }; }
    catch (e) { return { ...s, error: msg(e) }; } // R5: not swallowed — carried as a named failure into the Sources block
  }));
  return { read: settled.filter((s) => s.excerpt).map((s, i) => ({ ...s, n: i + 1 })),
    failed: settled.filter((s) => !s.excerpt) };
}

// Grounded prompt: question + numbered excerpts. The model is told to cite ONLY the
// listed numbers; with no sources it must SAY the answer is ungrounded (R14) — and
// checkCitations() enforces the number rule after the fact regardless.
// `guide` (optional): the caller's own instructions for shape and reader (the summary follow-up's brief
// bullets, lib/summary-followup.mjs BRIEF_GUIDE) — it goes to the model only, never outbound.
export function buildResearchPrompt({ question, sources, guide = '' }) {
  const g = guide ? '\n\n' + guide : '';
  if (!sources.length) {
    return 'No web sources could be retrieved for this question. You may answer from your own ' +
      'knowledge, but you MUST begin by stating plainly that the answer is NOT grounded in live web ' +
      'sources. Do not invent citations or URLs. 未能获取网络来源：如凭已有知识作答，必须先声明回答' +
      '未经网络来源验证，不得虚构引用。' + g + '\n\n## Question 问题\n\n' + question;
  }
  const body = sources.map((s) => '[' + s.n + '] ' + s.title + ' — ' + s.url + '\n\n' + s.excerpt).join('\n\n---\n\n');
  return 'Answer the question using ONLY the numbered web sources below. Cite claims with [n] ' +
    'markers matching the source numbers (1-' + sources.length + '); NEVER cite a number that is not ' +
    'listed. If the sources do not answer the question, say so plainly. Be concise. ' +
    '只根据下列编号网络来源回答，用 [n] 标注引用；不得引用列表之外的编号；来源不足以回答时请直说。' + g +
    '\n\n## Question 问题\n\n' + question + '\n\n## Sources 来源\n\n' + body;
}

// Post-check（引用校验）: strip [n] citations beyond the provided source count so a
// fabricated reference can never reach the user (R14). Returns the cleaned text plus
// the distinct numbers removed, for flagging in the Sources block.
export function checkCitations(text, sourceCount) {
  const stripped = new Set();
  const out = String(text).replace(/\[(\d{1,3})\]/g, (m, d) => {
    const n = Number(d);
    if (n >= 1 && n <= sourceCount) return m;
    stripped.add(n);
    return '';
  });
  return { text: out, stripped: [...stripped].sort((a, b) => a - b) };
}

// Sources · 来源 footer: numbered read sources (matching the [n] the model saw), failed
// scrapes NAMED with their errors (R14), and a note when fabricated citations were removed.
export function sourcesBlock({ read, failed, stripped }) {
  const parts = [];
  if (read.length) parts.push('**Sources · 来源**\n' + read.map((s) => s.n + '. [' + s.title + '](' + s.url + ')').join('\n'));
  if (failed.length) parts.push('Not read (scrape failed) · 未能读取: ' + failed.map((s) => (s.title || s.url) + ' — ' + (s.error || 'failed')).join('; '));
  if (stripped.length) parts.push('Note 注: removed citations to nonexistent sources · 已移除不存在来源的引用: ' + stripped.map((n) => '[' + n + ']').join(' '));
  return parts.length ? '\n\n' + parts.join('\n\n') : '';
}

// Orchestrate one research turn. Returns the other lanes' { ok, text } contract
// (web.mjs persists text either way); onStatus/onDelta stream progress + tokens.
// `question` is the ONLY caller data that can reach the outbound requests — see the
// privacy contract in the header.
export async function runResearch(question, deps) {
  const { research: rc, keys, lanes, ollamaUrl, model, guide = '', onStatus = () => {}, onDelta = () => {}, fetchImpl = globalThis.fetch } = deps;
  onStatus('Searching · 搜索中…');
  let found;
  try {
    found = await tavilySearch({ question, key: keys.tavily, url: rc.tavily_url, maxResults: rc.max_results, timeoutMs: rc.search_timeout_ms, fetchImpl });
  } catch (e) {
    return { ok: false, text: 'Search failed · 搜索失败 — ' + msg(e), grounded: false, sources: [] }; // R5: surfaced as the turn's error text
  }
  const picks = found.slice(0, rc.read_top);
  let read = [], failed = [];
  if (picks.length) {
    onStatus('Reading ' + picks.length + ' sources · 阅读来源…');
    ({ read, failed } = await readSources(picks, { key: keys.firecrawl, apiUrl: rc.firecrawl_url, capBytes: rc.excerpt_bytes, timeoutMs: rc.scrape_timeout_ms, fetchImpl }));
  }
  const grounded = read.length > 0;
  // Honest header BEFORE the answer streams (R14): no results, or nothing readable.
  const head = grounded ? '' : (found.length
    ? 'No web sources could be read · 网络来源均无法读取\n\n'
    : 'No web sources found · 未找到网络来源\n\n');
  if (head) onDelta(head);
  let answer;
  try {
    answer = await lanes.streamOllama({ url: ollamaUrl, model,
      messages: [{ role: 'user', content: buildResearchPrompt({ question, sources: read, guide }) }], onDelta });
  } catch (e) {
    return { ok: false, text: head + 'Research model failed · 研究模型失败 — ' + msg(e), grounded, sources: [...read, ...failed] };
  }
  if (!String(answer || '').trim()) return { ok: false, text: head + 'Research model returned nothing · 研究模型无输出', grounded, sources: [...read, ...failed] }; // R14: empty output is failure
  const { text: checked, stripped } = checkCitations(answer, read.length);
  const tail = sourcesBlock({ read, failed, stripped });
  if (tail) onDelta(tail);
  return { ok: true, text: head + checked + tail, grounded, sources: [...read, ...failed] };
}
