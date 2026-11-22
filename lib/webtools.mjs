// lib/webtools.mjs — shared plumbing for the agent-facing web CLIs
// (tools/websearch.mjs, tools/fetchpage.mjs).
//
// The Claude agent lane's own web fetch is routinely 403'd by bot protection, so the
// agent shells out to those two CLIs instead. They speak to the SAME paid services the
// Research · 联网研究 chat lane uses — and they do NOT re-implement the API calls: the
// ONE Tavily client and the ONE Firecrawl client stay in lib/research.mjs (R3). This
// module only resolves config + keys, parses flags, and caps output.
//
// KEY HANDLING: existence checks only (the cfg.researchEnabled precedent in config.mjs).
// A key VALUE is never printed, logged, or echoed — not even redacted, not on error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './config.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Errors we OWN and can show verbatim to the agent (already bilingual, already safe).
// Anything else is stringified with its message only — never a stack, never a request body.
export class ToolError extends Error {}

// Where each key is documented, so the error can name the exact fix.
const KEY_HELP = {
  tavily_key: { svc: 'Tavily', where: 'https://app.tavily.com — Dashboard → API Keys' },
  firecrawl_key: { svc: 'Firecrawl', where: 'https://firecrawl.dev — Dashboard → API Keys' },
};

// config.json + the SAME defaults the web app runs on: validateConfig fills cfg.research
// (tavily_url, firecrawl_url, timeouts, caps), so those endpoints exist in exactly one
// place (lib/config.mjs). Deliberately NOT loadConfig(): that provisions workspaces,
// rewrites users and opens a session store — side effects a read-only CLI must not have.
export function loadToolConfig(root = ROOT) {
  const p = path.join(root, 'config.json');
  if (!fs.existsSync(p)) {
    throw new ToolError(`config.json not found at ${p} — copy config.example.json to config.json first. ` +
      '未找到 config.json：请先由 config.example.json 复制生成。');
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new ToolError(`config.json is not valid JSON: ${e.message} · config.json 不是合法 JSON。`); }
  return validateConfig(raw, root);
}

// Returns the key, or throws naming WHICH key, WHERE the file is and WHERE to get one.
// The value itself never reaches the message (see KEY HANDLING above).
export function requireKey(cfg, name, root = ROOT) {
  const v = cfg[name];
  if (typeof v === 'string' && v.trim() && !/PASTE/.test(v)) return v;
  const h = KEY_HELP[name] || { svc: name, where: 'the provider dashboard' };
  throw new ToolError(
    `Missing ${name} — add "${name}": "<your ${h.svc} API key>" to ${path.join(root, 'config.json')}. ` +
    `Get one at ${h.where}. ` +
    `缺少 ${name}：请在 ${path.join(root, 'config.json')} 中填入 ${h.svc} 密钥（获取地址见上）后重试。`);
}

// Minimal flag parser. `spec` maps a flag name to 'num' | 'bool'; everything else is
// positional. An unknown flag or a bad number is an ERROR, never a silent default —
// a typo'd --max must not quietly return 5 results and look like a success (R14).
export function parseArgs(argv, spec, usage) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    const kind = spec[name];
    if (!kind) throw new ToolError(`unknown flag --${name}\n${usage}`);
    if (kind === 'bool') { flags[name] = true; continue; }
    const raw = inline !== undefined ? inline : argv[++i];
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new ToolError(`--${name} needs a positive number (got "${raw ?? ''}")\n${usage}`);
    flags[name] = n;
  }
  return { flags, positional };
}

// Cap text to `max` UTF-8 BYTES, cutting on a character boundary (a split multi-byte
// sequence decodes to a trailing U+FFFD, which is dropped). Reports the REAL total so
// the marker can be honest about how much was withheld.
export function capBytes(text, max) {
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length <= max) return { text: String(text), truncated: false, bytes: buf.length, totalBytes: buf.length };
  const cut = buf.subarray(0, max).toString('utf8').replace(/�$/, '');
  return { text: cut, truncated: true, bytes: Buffer.byteLength(cut, 'utf8'), totalBytes: buf.length };
}

// The ONE truncation marker for these CLIs (R3). It states the real numbers so the agent
// knows it is reading a prefix and can raise --max-bytes instead of assuming it saw it all.
export const truncationMarker = (shown, total) =>
  `\n\n[TRUNCATED · 已截断 — showing ${shown} of ${total} bytes; rerun with --max-bytes ${total} for the rest]`;

// True when this module URL is the script node was told to run (so a CLI can export its
// guts for tests without executing main() on import).
export const isMain = (metaUrl) =>
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);

// Run a CLI main(): print our own errors readably, exit NON-ZERO on any failure so the
// agent's Bash call reports failure instead of reading an empty stdout as an empty answer.
export async function runCli(main) {
  try {
    await main();
  } catch (e) {
    process.stderr.write((e instanceof ToolError ? e.message : String((e && e.message) || e)) + '\n');
    process.exitCode = 1;
  }
}
