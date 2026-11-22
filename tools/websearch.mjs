#!/usr/bin/env node
// tools/websearch.mjs — agent-facing web SEARCH (Tavily), for the Claude agent lane.
//
// WHY: the agent's built-in web tools get 403'd by bot protection. Tavily is an
// agent-grade search API the repo already pays for; until now it was reachable only
// from the Research chat lane. This exposes it to the agent as a Bash command.
//
//   node ../tools/websearch.mjs "who won the 2026 F1 opener" [--max 5] [--json]
//
// Prints ranked results (title, url, snippet) to stdout. Any failure — missing key,
// HTTP error, timeout, or ZERO results — goes to stderr and exits NON-ZERO, so an
// empty stdout can never be mistaken for a successful empty answer (R14).
import { tavilySearch } from '../lib/research.mjs'; // the ONE Tavily client (R3)
import { loadToolConfig, requireKey, parseArgs, runCli, isMain, ToolError, capBytes } from '../lib/webtools.mjs';

const USAGE = 'usage: node tools/websearch.mjs "<query>" [--max N] [--json]';
const DEFAULT_MAX = 5;
const SNIPPET_BYTES = 400;   // per result, so a 5-result page stays glanceable
const FLAGS = { max: 'num', json: 'bool' };

// Compact ranked text — one blank-line-separated block per hit. Snippets are capped so
// the whole listing stays small enough to read repeatedly without eating the context.
export function formatResults(results) {
  return results.map((r, i) => {
    const snip = capBytes(String(r.snippet || '').replace(/\s+/g, ' ').trim(), SNIPPET_BYTES);
    return `${i + 1}. ${r.title}\n   ${r.url}` + (snip.text ? `\n   ${snip.text}${snip.truncated ? ' …' : ''}` : '');
  }).join('\n\n');
}

// Search and render. `fetchImpl` is the injected HTTP seam the tests drive (research.mjs
// precedent): nothing here reaches the network on its own.
export async function webSearch({ query, max = DEFAULT_MAX, json = false, cfg, fetchImpl = globalThis.fetch }) {
  const key = requireKey(cfg, 'tavily_key');
  const results = await tavilySearch({
    question: query, key, url: cfg.research.tavily_url,
    maxResults: max, timeoutMs: cfg.research.search_timeout_ms, fetchImpl,
  });
  // R14: zero hits is NOT a clean result. Fail loudly rather than print nothing.
  if (!results.length) throw new ToolError(`No results for: ${query} · 未找到结果。Try different terms.`);
  return json
    ? JSON.stringify({ ok: true, query, count: results.length, results }, null, 2)
    : formatResults(results);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2), FLAGS, USAGE);
  const query = positional.join(' ').trim();
  if (!query) throw new ToolError(USAGE);
  const out = await webSearch({ query, max: flags.max || DEFAULT_MAX, json: !!flags.json, cfg: loadToolConfig() });
  process.stdout.write(out + '\n');
}

if (isMain(import.meta.url)) runCli(main);
