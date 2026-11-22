// Web-grounded research lane（联网研究）— lib/research.mjs orchestration driven by
// failure-faithful stubs of the REAL Tavily / Firecrawl JSON shapes (mirrored from
// their API docs: Tavily {query,results:[{title,url,content,score}],response_time};
// Firecrawl v2 {success,data:{markdown,metadata}} / {success:false,error}). NEVER the
// real APIs — free-tier credits burn per call (harness-fidelity rule: the stubs keep
// the real guards, e.g. non-2xx status, success:false, empty markdown).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runResearch, checkCitations, buildResearchPrompt } from '../lib/research.mjs';

const TAVILY_URL = 'https://api.tavily.com/search';
const FIRECRAWL_URL = 'https://api.firecrawl.dev/v2/scrape';

const rc = { max_results: 5, read_top: 2, excerpt_bytes: 6000, search_timeout_ms: 500, scrape_timeout_ms: 500,
  tavily_url: TAVILY_URL, firecrawl_url: FIRECRAWL_URL, llm: 'deepseek' };
const keys = { tavily: 'tvly-TEST-not-a-real-key', firecrawl: 'fc-TEST-not-a-real-key' };

const tavilyOk = (results) => ({ status: 200, ok: true, json: async () => ({ query: 'q', results, response_time: 0.5 }) });
const fcOk = (markdown, title) => ({ status: 200, ok: true,
  json: async () => ({ success: true, data: { markdown, metadata: { title, statusCode: 200 } } }) });
const fcFail = () => ({ status: 200, ok: true, json: async () => ({ success: false, error: 'This website is no longer supported' }) });
const httpErr = (status) => ({ status, ok: false, json: async () => ({ detail: { error: 'error' } }) });

const RESULTS = [
  { title: 'Node.js docs', url: 'https://nodejs.org/a', content: 'snippet a', score: 0.9 },
  { title: 'MDN page', url: 'https://developer.mozilla.org/b', content: 'snippet b', score: 0.8 },
  { title: 'Third', url: 'https://example.com/c', content: 'snippet c', score: 0.7 },
];

// fetch stub: records every outbound call, answers per-URL from the routing table.
function mkFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: (opts.headers || {}).authorization });
    const q = routes[url];
    if (!q) throw new Error('unexpected outbound URL: ' + url);
    return Array.isArray(q) ? q.shift() : q;
  };
  return { calls, fetchImpl };
}

const mkLane = (answer) => {
  const seen = { prompts: [], deltas: [] };
  const streamOllama = async ({ messages, onDelta }) => {
    seen.prompts.push(messages);
    if (answer instanceof Error) throw answer;
    onDelta(answer); seen.deltas.push(answer);
    return answer;
  };
  return { seen, lanes: { streamOllama } };
};

const deps = (fetchImpl, lanes, extra = {}) => ({ research: rc, keys, lanes, ollamaUrl: 'http://localhost:11434', model: 'deepseek-v4.1-flash:cloud', fetchImpl, ...extra });

test('(a) happy path: search → scrape → grounded answer with [n] citations + 来源 list', async () => {
  const { calls, fetchImpl } = mkFetch({
    [TAVILY_URL]: tavilyOk(RESULTS),
    [FIRECRAWL_URL]: [fcOk('# A\ncontent a'), fcOk('# B\ncontent b')],
  });
  const { seen, lanes } = mkLane('Grounded fact [1], also [2].');
  const status = [];
  const r = await runResearch('what is X?', deps(fetchImpl, lanes, { onStatus: (t) => status.push(t) }));
  assert.equal(r.ok, true);
  assert.equal(r.grounded, true);
  assert.deepEqual(status, ['Searching · 搜索中…', 'Reading 2 sources · 阅读来源…']);
  assert.equal(calls.filter((c) => c.url === FIRECRAWL_URL).length, 2, 'read_top=2 caps scrapes');
  assert.match(r.text, /Grounded fact \[1\], also \[2\]\./);
  assert.match(r.text, /\*\*Sources · 来源\*\*/);
  assert.match(r.text, /1\. \[Node\.js docs\]\(https:\/\/nodejs\.org\/a\)/);
  assert.match(r.text, /2\. \[MDN page\]\(https:\/\/developer\.mozilla\.org\/b\)/);
  // The model saw the numbered excerpts and the cite-only-these instruction.
  const prompt = seen.prompts[0][0].content;
  assert.match(prompt, /\[1\] Node\.js docs — https:\/\/nodejs\.org\/a/);
  assert.match(prompt, /content b/);
  assert.match(prompt, /NEVER cite a number that is not/);
});

test('(a2) one scrape fails: skipped, NAMED in the sources list, numbering stays valid (R14)', async () => {
  const { fetchImpl } = mkFetch({
    [TAVILY_URL]: tavilyOk(RESULTS),
    [FIRECRAWL_URL]: [fcFail(), fcOk('# B\ncontent b')],
  });
  const { seen, lanes } = mkLane('From the readable one [1].');
  const r = await runResearch('q', deps(fetchImpl, lanes));
  assert.equal(r.ok, true);
  assert.match(r.text, /1\. \[MDN page\]/, 'surviving source renumbered to [1]');
  assert.match(r.text, /Not read \(scrape failed\) · 未能读取: Node\.js docs — This website is no longer supported/);
  assert.match(seen.prompts[0][0].content, /\[1\] MDN page/, 'prompt numbering matches the sources list');
  assert.doesNotMatch(seen.prompts[0][0].content, /Node\.js docs/, 'failed scrape excluded from excerpts');
});

test('(b) zero search results: honest 未找到网络来源 header + ungrounded prompt, no scrape call', async () => {
  const { calls, fetchImpl } = mkFetch({ [TAVILY_URL]: tavilyOk([]) });
  const { seen, lanes } = mkLane('I am not grounded, but the answer is Y.');
  const r = await runResearch('q', deps(fetchImpl, lanes));
  assert.equal(r.ok, true);
  assert.equal(r.grounded, false);
  assert.match(r.text, /^No web sources found · 未找到网络来源\n\n/);
  assert.match(seen.prompts[0][0].content, /MUST begin by stating plainly that the answer is NOT grounded/);
  assert.equal(calls.length, 1, 'no Firecrawl call without results');
});

test('(b2) ALL scrapes fail: honest 均无法读取 header, failures named, ungrounded prompt (R14)', async () => {
  const { fetchImpl } = mkFetch({
    [TAVILY_URL]: tavilyOk(RESULTS),
    [FIRECRAWL_URL]: [httpErr(402), fcFail()],
  });
  const { seen, lanes } = mkLane('Ungrounded answer.');
  const r = await runResearch('q', deps(fetchImpl, lanes));
  assert.equal(r.ok, true);
  assert.equal(r.grounded, false);
  assert.match(r.text, /^No web sources could be read · 网络来源均无法读取\n\n/);
  assert.match(r.text, /Node\.js docs — Firecrawl HTTP 402/);
  assert.match(r.text, /MDN page — This website is no longer supported/);
  assert.match(seen.prompts[0][0].content, /NOT grounded/);
});

test('(c) citation post-check strips a fabricated [9] and flags it', async () => {
  const { fetchImpl } = mkFetch({ [TAVILY_URL]: tavilyOk(RESULTS.slice(0, 1)), [FIRECRAWL_URL]: [fcOk('content a')] });
  const { lanes } = mkLane('Real [1]. Fabricated [9].');
  const r = await runResearch('q', deps(fetchImpl, lanes));
  assert.equal(r.ok, true);
  assert.match(r.text, /Real \[1\]\. Fabricated \./);
  assert.doesNotMatch(r.text.split('Note 注')[0], /\[9\]/);
  assert.match(r.text, /removed citations to nonexistent sources · 已移除不存在来源的引用: \[9\]/);
});

test('(c2) checkCitations: in-range kept, out-of-range and [0] stripped, dedup + sorted', () => {
  const { text, stripped } = checkCitations('a [1] b [2] c [0] d [12] e [12]', 2);
  assert.equal(text, 'a [1] b [2] c  d  e ');
  assert.deepEqual(stripped, [0, 12]);
});

test('(c3) zero sources: EVERY [n] is stripped — a citation can never be fabricated', () => {
  const { text, stripped } = checkCitations('claim [1] and [3]', 0);
  assert.doesNotMatch(text, /\[\d\]/);
  assert.deepEqual(stripped, [1, 3]);
});

test('(d) privacy: outbound bodies carry ONLY the question / URLs — nothing else (structural)', async () => {
  const { calls, fetchImpl } = mkFetch({
    [TAVILY_URL]: tavilyOk(RESULTS),
    [FIRECRAWL_URL]: [fcOk('a'), fcOk('b')],
  });
  const { lanes } = mkLane('ok [1]');
  const question = 'only this text may go to search';
  // Decoys riding INSIDE deps (as leaked cfg/prompt/history would): none may reach the wire.
  const decoys = ['SECRET_SYSTEM_PROMPT', 'user-history-line', 'config-value-decoy'];
  await runResearch(question, deps(fetchImpl, lanes,
    { systemPrompt: decoys[0], history: [decoys[1]], cfgDecoy: decoys[2] }));
  const tav = calls.find((c) => c.url === TAVILY_URL);
  assert.deepEqual(Object.keys(tav.body).sort(), ['max_results', 'query', 'search_depth'], 'Tavily body: fixed params + query only');
  assert.equal(tav.body.query, question);
  for (const c of calls.filter((x) => x.url === FIRECRAWL_URL)) {
    assert.deepEqual(Object.keys(c.body).sort(), ['formats', 'url'], 'Firecrawl body: url + formats only');
    assert.ok(RESULTS.some((s) => s.url === c.body.url), 'scraped URL came from the search results');
  }
  const wire = JSON.stringify(calls.map((c) => c.body));
  for (const d of decoys) assert.doesNotMatch(wire, new RegExp(d));
  assert.doesNotMatch(wire, /tvly-TEST|fc-TEST/, 'keys never in a body (headers only)');
});

test('(d2) runResearch signature is (question, deps): the question is the only caller data in scope', () => {
  assert.equal(runResearch.length, 2, 'structural contract — no convo/prompt/cfg parameters exist to leak');
});

test('search failure (HTTP 432) → explicit error text, ok:false', async () => {
  const { fetchImpl } = mkFetch({ [TAVILY_URL]: httpErr(432) });
  const { lanes } = mkLane('never called');
  const r = await runResearch('q', deps(fetchImpl, lanes));
  assert.equal(r.ok, false);
  assert.equal(r.text, 'Search failed · 搜索失败 — Tavily HTTP 432');
});

test('LLM failure → explicit error, sources still reported', async () => {
  const { fetchImpl } = mkFetch({ [TAVILY_URL]: tavilyOk(RESULTS.slice(0, 1)), [FIRECRAWL_URL]: [fcOk('a')] });
  const { lanes } = mkLane(new Error('Ollama HTTP 500'));
  const r = await runResearch('q', deps(fetchImpl, lanes));
  assert.equal(r.ok, false);
  assert.match(r.text, /Research model failed · 研究模型失败 — Ollama HTTP 500/);
  assert.equal(r.sources.length, 1);
});

test('empty LLM output is failure, not a clean result (R14)', async () => {
  const { fetchImpl } = mkFetch({ [TAVILY_URL]: tavilyOk(RESULTS.slice(0, 1)), [FIRECRAWL_URL]: [fcOk('a')] });
  const { lanes } = mkLane('   ');
  const r = await runResearch('q', deps(fetchImpl, lanes));
  assert.equal(r.ok, false);
  assert.match(r.text, /Research model returned nothing · 研究模型无输出/);
});

test('hung scrape hits the per-URL timeout; the turn still completes with the rest', async () => {
  const hang = new Promise(() => {});
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url === TAVILY_URL) return tavilyOk(RESULTS);
    return calls.filter((u) => u === FIRECRAWL_URL).length === 1 ? hang : fcOk('b content');
  };
  const { lanes } = mkLane('From [1].');
  const r = await runResearch('q', deps(fetchImpl, lanes, { research: { ...rc, scrape_timeout_ms: 30 } }));
  assert.equal(r.ok, true);
  assert.match(r.text, /Not read \(scrape failed\) · 未能读取: Node\.js docs — timeout after 30ms/);
  assert.match(r.text, /1\. \[MDN page\]/);
});

test('excerpts are capped at excerpt_bytes before reaching the model', async () => {
  const big = 'x'.repeat(20000);
  const { fetchImpl } = mkFetch({ [TAVILY_URL]: tavilyOk(RESULTS.slice(0, 1)), [FIRECRAWL_URL]: [fcOk(big)] });
  const { seen, lanes } = mkLane('ok [1]');
  await runResearch('q', deps(fetchImpl, lanes));
  assert.ok(seen.prompts[0][0].content.length < 8000, 'prompt stays near the 6KB cap');
});

test('buildResearchPrompt (grounded) numbers excerpts and repeats the question verbatim', () => {
  const p = buildResearchPrompt({ question: 'Q?', sources: [{ n: 1, title: 'T', url: 'https://u', excerpt: 'E' }] });
  assert.match(p, /\[1\] T — https:\/\/u\n\nE/);
  assert.match(p, /## Question 问题\n\nQ\?/);
});

test('buildResearchPrompt: a caller guide rides the prompt (both branches) and nothing else changes; runResearch hands it to the lane, never outbound', () => {
  const sources = [{ n: 1, title: 't', url: 'https://a.org', excerpt: 'e' }];
  const g = 'GUIDE: three bullets';
  assert.ok(buildResearchPrompt({ question: 'q', sources, guide: g }).includes('\n\n' + g + '\n\n## Question'));
  assert.ok(buildResearchPrompt({ question: 'q', sources: [], guide: g }).includes(g));
  assert.equal(buildResearchPrompt({ question: 'q', sources }), buildResearchPrompt({ question: 'q', sources, guide: '' }));
});
