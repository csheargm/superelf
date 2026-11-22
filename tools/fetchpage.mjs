#!/usr/bin/env node
// tools/fetchpage.mjs — agent-facing page READER (Firecrawl), for the Claude agent lane.
//
// WHY: the agent's built-in web fetch is routinely 403'd by bot protection, and
// ../fetchurl.mjs only strips raw HTML (so it loses JS-rendered pages and hits the same
// blocks). Firecrawl renders the page server-side and returns clean markdown — it is the
// lane that gets through. The repo already pays for it; until now only the Research chat
// lane could reach it.
//
//   node ../tools/fetchpage.mjs https://example.com/docs [--max-bytes 40000] [--json]
//
// Prints markdown to stdout, capped, with an HONEST marker when it was cut. Any failure —
// missing key, HTTP error, timeout, or an EMPTY page — goes to stderr and exits NON-ZERO,
// so blank stdout can never read as "the page said nothing" (R14).
import { firecrawlScrape } from '../lib/research.mjs'; // the ONE Firecrawl client (R3)
import { loadToolConfig, requireKey, parseArgs, runCli, isMain, ToolError, capBytes, truncationMarker } from '../lib/webtools.mjs';

const USAGE = 'usage: node tools/fetchpage.mjs <url> [--max-bytes N] [--json]';
const DEFAULT_MAX_BYTES = 40_000;   // ~40KB: a long article, still cheap to read twice
const FLAGS = { 'max-bytes': 'num', json: 'bool' };

// Scrape and render. `fetchImpl` is the injected HTTP seam the tests drive (research.mjs
// precedent): nothing here reaches the network on its own. firecrawlScrape already treats
// empty markdown as an error, so a blank page arrives here as a throw, never as ''.
export async function fetchPage({ url, maxBytes = DEFAULT_MAX_BYTES, json = false, cfg, fetchImpl = globalThis.fetch }) {
  let u;
  try { u = new URL(url); } catch { throw new ToolError(`not a URL: ${url} · 不是合法网址。\n${USAGE}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ToolError(`only http/https URLs are allowed (got ${u.protocol}) · 仅支持 http/https。`);
  const key = requireKey(cfg, 'firecrawl_key');
  // Ask the client for everything, then cap HERE — that is the only way to know the real
  // size and report it truthfully in the marker.
  const markdown = await firecrawlScrape({
    url: u.href, key, apiUrl: cfg.research.firecrawl_url,
    capBytes: Number.MAX_SAFE_INTEGER, timeoutMs: cfg.research.scrape_timeout_ms, fetchImpl,
  });
  const cut = capBytes(markdown, maxBytes);
  if (json) return JSON.stringify({ ok: true, url: u.href, truncated: cut.truncated, bytes: cut.bytes, totalBytes: cut.totalBytes, markdown: cut.text }, null, 2);
  return `# ${u.href}\n\n` + cut.text + (cut.truncated ? truncationMarker(cut.bytes, cut.totalBytes) : '');
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2), FLAGS, USAGE);
  if (positional.length !== 1) throw new ToolError(USAGE);
  const out = await fetchPage({ url: positional[0], maxBytes: flags['max-bytes'] || DEFAULT_MAX_BYTES, json: !!flags.json, cfg: loadToolConfig() });
  process.stdout.write(out + '\n');
}

if (isMain(import.meta.url)) runCli(main);
