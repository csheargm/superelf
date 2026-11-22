// The demo chat's search step (lib/demo-search.mjs has the why). Runs after the first model reply:
// a reply that is the search marker becomes search → answer; any other reply passes through.
// Every refusal or failure is SAID in a status line and the model still answers, flagged as
// possibly out of date — never a silent empty answer.
import { parseSearch, ollamaWebSearch, resultsPrompt, sourcesFooter, OLLAMA_SEARCH_URL } from './demo-search.mjs';
import { consumeWebSearch, consumeAiCall } from './demo-quota.mjs';

const NO_SEARCH = (why) => `Web search is not available for this question (${why}). Answer from what you `
  + 'already know, say plainly that it may be out of date, and do not output the search marker.';
export const SEARCHING = 'Searching the web · 正在联网搜索…';

// The search endpoint receives the bearer key, so only Ollama's own (or the node's configured
// Ollama, which already gets the key) may be named in config.
export function searchUrlOf(cfg) {
  const u = cfg.demo && typeof cfg.demo.web_search_url === 'string' ? cfg.demo.web_search_url : '';
  if (!u) return OLLAMA_SEARCH_URL;
  const ok = [new URL(OLLAMA_SEARCH_URL).origin, cfg.ollama_url && new URL(cfg.ollama_url).origin].filter(Boolean);
  let origin = ''; try { origin = new URL(u).origin; } catch { origin = ''; /* not a URL: refused below */ }
  if (!ok.includes(origin)) throw new Error('demo.web_search_url must be on ollama.com or ollama_url · 搜索地址必须是 Ollama 的');
  return u;
}

async function results(d, user, ip, query, line, signal) {
  const q = consumeWebSearch({ cfg: d.cfg, store: d.store, userId: user.id, ip });
  if (!q.ok) { line({ type: 'status', text: q.error }); return { sys: NO_SEARCH('daily search limit reached'), hits: null }; }
  line({ type: 'status', text: SEARCHING });
  try {
    const hits = await ollamaWebSearch({ query, url: searchUrlOf(d.cfg), signal });
    d.audit('demo-websearch', { who: user.id, chars: query.length, hits: hits.length });   // shape only, never the query
    return { sys: resultsPrompt(query, hits), hits };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 200);
    line({ type: 'status', text: `⚠ ${why}` });   // said, and the answer below is flagged as unsearched
    return { sys: NO_SEARCH(why), hits: null };
  }
}

// `answer(messages)` streams one model reply and returns its text. Returns {text, searched}.
// The answer's AI call is counted BEFORE the search, so a visitor's last slot never buys a search
// that cannot be answered; `signal` (the visitor leaving) stops the search too.
export async function searchTurn({ d, user, text, history, line, ip, answer, signal }) {
  const query = parseSearch(text);
  if (!query) return { text, searched: false };
  const ai = consumeAiCall({ cfg: d.cfg, store: d.store, userId: user.id, ip });
  if (!ai.ok) throw new Error(ai.error);
  const { sys, hits } = await results(d, user, ip, query, line, signal);
  if (signal && signal.aborted) throw new Error('the visitor left · 访客已离开');   // no answer call for nobody
  // A marker line in the answer (steered by a result) is dropped, so a later turn never sees one.
  let out = String(await answer(history.concat([{ role: 'system', content: sys }]))).replace(/^\s*\[\[superelf-[a-z]+\]\][^\n]*\n?/, '');
  if (hits) { const f = sourcesFooter(hits); line({ type: 'delta', text: f }); out += f; }
  return { text: out, searched: true };
}
