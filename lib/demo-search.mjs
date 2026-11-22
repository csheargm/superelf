// Web search for the demo chat · 演示版联网搜索 — Ollama's hosted web_search, capped per visitor.
//
// Same shape as the app maker (lib/demo-app.mjs): the chat turn carries SEARCH_RULE, so a question
// that needs current facts is answered with ONE marker line (SEARCH_MARKER + the query) instead of
// a guess. The server then counts the search (consumeWebSearch), calls ollama.com/api/web_search
// with the container's OLLAMA_API_KEY (from the environment only; never in config, a prompt or a
// reply), and asks the model again with the results. The sources list is appended by the SERVER,
// so every searched answer names where it came from, whatever the model writes.
// Owner nodes are untouched: their web search is the Tavily route in web.mjs.
export const SEARCH_MARKER = '[[superelf-search]]';
export const OLLAMA_SEARCH_URL = 'https://ollama.com/api/web_search';
const RESULTS = 5;               // Ollama's default; its maximum is 10
const QUERY_MAX = 300;
const SNIPPET_MAX = 1200;        // chars of each result's content handed to the model
const SEARCH_TIMEOUT_MS = 20_000;

export const SEARCH_RULE = 'You CAN search the web: the server does it. If answering well needs current '
  + 'or fast-changing facts (news, prices, weather, sports, releases, today\'s events, anything after your '
  + `training), reply with ONLY this one line and nothing else: ${SEARCH_MARKER} <a short search query>. `
  + 'Otherwise answer normally.';

// The marker line → the query, or null for an ordinary answer.
export function parseSearch(text) {
  const s = String(text || '').trim();
  if (!s.startsWith(SEARCH_MARKER)) return null;
  const q = s.slice(SEARCH_MARKER.length).split('\n')[0].replace(/^[\s:"']+|[\s"']+$/g, '').slice(0, QUERY_MAX);
  return q || null;
}

// One search. Throws with a bilingual reason on a missing key, an HTTP error, a timeout or ZERO
// results: an empty list must never reach the model looking like a successful search (R14).
export async function ollamaWebSearch({ query, url = OLLAMA_SEARCH_URL, key = process.env.OLLAMA_API_KEY, fetchImpl = globalThis.fetch, signal }) {
  if (!key) throw new Error('web search is not configured on this node · 本节点未配置联网搜索');
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]) : AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const r = await fetchImpl(url, { method: 'POST', signal: sig,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: RESULTS }) });
  if (!r.ok) throw new Error(`web search failed · 联网搜索失败 (HTTP ${r.status})`);
  const j = await r.json();
  const results = (Array.isArray(j && j.results) ? j.results : [])
    .filter((x) => x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url))
    .map((x) => ({ title: String(x.title || x.url).replace(/\s+/g, ' ').trim().slice(0, 200), url: x.url, content: String(x.content || '').slice(0, SNIPPET_MAX) }));
  if (!results.length) throw new Error(`no web results for · 未找到网络结果: ${query}`);
  return results;
}

// The system message that hands the results to the model for the answer.
export const resultsPrompt = (query, results) => `Web search results for "${query}" (fetched just now). `
  + 'Answer the visitor\'s last message from these results, citing them as [1], [2]…; say so if they do '
  + 'not answer it. Do not output the search marker again.\n\n'
  + results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`).join('\n\n');

// The server's sources footer (markdown links; titles cannot break out of the link text).
export const sourcesFooter = (results) => '\n\n**Sources · 来源**\n'
  + results.map((r, i) => `${i + 1}. [${r.title.replace(/[[\]]/g, '')}](${r.url.replace(/[()\s]/g, encodeURIComponent)})`).join('\n');
