// Agent-facing web CLIs（联网工具）— tools/websearch.mjs (Tavily) and tools/fetchpage.mjs
// (Firecrawl), driven by failure-faithful stubs of the REAL API JSON shapes, mirrored from
// test/research.test.mjs (Tavily {query,results:[{title,url,content,score}]}; Firecrawl v2
// {success,data:{markdown}} / {success:false,error}). NEVER the real APIs — paid credits
// burn per call, and a test that needs a key is a test that stops running.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { webSearch, formatResults } from '../tools/websearch.mjs';
import { fetchPage } from '../tools/fetchpage.mjs';
import { loadToolConfig, requireKey, parseArgs, capBytes, ToolError } from '../lib/webtools.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);

const TAVILY_URL = 'https://api.tavily.com/search';
const FIRECRAWL_URL = 'https://api.firecrawl.dev/v2/scrape';
const cfg = {
  tavily_key: 'tvly-TEST-not-a-real-key', firecrawl_key: 'fc-TEST-not-a-real-key',
  research: { tavily_url: TAVILY_URL, firecrawl_url: FIRECRAWL_URL, search_timeout_ms: 500, scrape_timeout_ms: 500 },
};

const tavilyOk = (results) => ({ status: 200, ok: true, json: async () => ({ query: 'q', results, response_time: 0.4 }) });
const fcOk = (markdown) => ({ status: 200, ok: true, json: async () => ({ success: true, data: { markdown, metadata: { statusCode: 200 } } }) });
const fcFail = () => ({ status: 200, ok: true, json: async () => ({ success: false, error: 'This website is no longer supported' }) });
const httpErr = (status) => ({ status, ok: false, json: async () => ({ detail: { error: 'error' } }) });

const RESULTS = [
  { title: 'Node.js docs', url: 'https://nodejs.org/a', content: 'snippet a', score: 0.9 },
  { title: 'MDN page', url: 'https://developer.mozilla.org/b', content: 'snippet   b\nwrapped', score: 0.8 },
];

// Records every outbound call and answers per-URL, so a body/header assertion is possible.
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
const noFetch = async () => { throw new Error('network must not be touched'); };

// ── websearch ────────────────────────────────────────────────────────────────────────
test('websearch: ranked text carries title, url and a whitespace-collapsed snippet', async () => {
  const { calls, fetchImpl } = mkFetch({ [TAVILY_URL]: tavilyOk(RESULTS) });
  const out = await webSearch({ query: 'what is X?', cfg, fetchImpl });
  assert.equal(out,
    '1. Node.js docs\n   https://nodejs.org/a\n   snippet a\n\n' +
    '2. MDN page\n   https://developer.mozilla.org/b\n   snippet b wrapped');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.query, 'what is X?');
  assert.equal(calls[0].body.max_results, 5, 'default --max');
});

test('websearch: --max is passed through to Tavily, not applied after the fact', async () => {
  const { calls, fetchImpl } = mkFetch({ [TAVILY_URL]: tavilyOk(RESULTS) });
  await webSearch({ query: 'q', max: 2, cfg, fetchImpl });
  assert.equal(calls[0].body.max_results, 2);
});

test('websearch: --json emits parseable JSON with the raw fields', async () => {
  const { fetchImpl } = mkFetch({ [TAVILY_URL]: tavilyOk(RESULTS) });
  const j = JSON.parse(await webSearch({ query: 'q', json: true, cfg, fetchImpl }));
  assert.equal(j.ok, true);
  assert.equal(j.count, 2);
  assert.deepEqual(j.results[0], { title: 'Node.js docs', url: 'https://nodejs.org/a', snippet: 'snippet a' });
});

test('websearch: ZERO results is a FAILURE, not an empty success (R14)', async () => {
  const { fetchImpl } = mkFetch({ [TAVILY_URL]: tavilyOk([]) });
  await assert.rejects(() => webSearch({ query: 'zxqwv', cfg, fetchImpl }),
    (e) => e instanceof ToolError && /No results for: zxqwv · 未找到结果/.test(e.message));
});

test('websearch: a Tavily HTTP error surfaces with its status (never silent)', async () => {
  const { fetchImpl } = mkFetch({ [TAVILY_URL]: httpErr(432) });
  await assert.rejects(() => webSearch({ query: 'q', cfg, fetchImpl }), /Tavily HTTP 432/);
});

test('websearch: a long snippet is capped with an ellipsis, not dropped', () => {
  const out = formatResults([{ title: 'T', url: 'https://x/y', snippet: 'a'.repeat(900) }]);
  assert.match(out, /a{400} …$/);
});

// ── fetchpage ────────────────────────────────────────────────────────────────────────
test('fetchpage: prints the url header then the scraped markdown', async () => {
  const { calls, fetchImpl } = mkFetch({ [FIRECRAWL_URL]: fcOk('# Title\n\nbody text') });
  const out = await fetchPage({ url: 'https://example.com/docs', cfg, fetchImpl });
  assert.equal(out, '# https://example.com/docs\n\n# Title\n\nbody text');
  assert.deepEqual(calls[0].body, { url: 'https://example.com/docs', formats: ['markdown'] });
});

test('fetchpage: over --max-bytes is cut and MARKED with the real numbers (R14)', async () => {
  const { fetchImpl } = mkFetch({ [FIRECRAWL_URL]: fcOk('x'.repeat(5000)) });
  const out = await fetchPage({ url: 'https://example.com/', maxBytes: 100, cfg, fetchImpl });
  assert.match(out, /\[TRUNCATED · 已截断 — showing 100 of 5000 bytes; rerun with --max-bytes 5000 for the rest\]$/);
  assert.equal(out.split('\n\n')[1].length, 100, 'exactly the cap, no more');
});

test('fetchpage: under the cap carries NO truncation marker', async () => {
  const { fetchImpl } = mkFetch({ [FIRECRAWL_URL]: fcOk('short') });
  const out = await fetchPage({ url: 'https://example.com/', maxBytes: 100, cfg, fetchImpl });
  assert.doesNotMatch(out, /TRUNCATED/);
});

test('fetchpage: --json reports truncated/bytes/totalBytes honestly', async () => {
  const { fetchImpl } = mkFetch({ [FIRECRAWL_URL]: fcOk('y'.repeat(300)) });
  const j = JSON.parse(await fetchPage({ url: 'https://example.com/', maxBytes: 120, json: true, cfg, fetchImpl }));
  assert.deepEqual({ ok: j.ok, truncated: j.truncated, bytes: j.bytes, totalBytes: j.totalBytes },
    { ok: true, truncated: true, bytes: 120, totalBytes: 300 });
  assert.equal(j.markdown.length, 120);
});

test('fetchpage: an EMPTY page is a failure, not a blank success (R14)', async () => {
  const { fetchImpl } = mkFetch({ [FIRECRAWL_URL]: fcOk('   ') });
  await assert.rejects(() => fetchPage({ url: 'https://example.com/', cfg, fetchImpl }), /empty scrape/);
});

test('fetchpage: Firecrawl success:false surfaces the provider reason', async () => {
  const { fetchImpl } = mkFetch({ [FIRECRAWL_URL]: fcFail() });
  await assert.rejects(() => fetchPage({ url: 'https://example.com/', cfg, fetchImpl }), /no longer supported/);
});

test('fetchpage: a non-http(s) URL is refused BEFORE any network call', async () => {
  await assert.rejects(() => fetchPage({ url: 'file:///etc/passwd', cfg, fetchImpl: noFetch }), /only http\/https/);
  await assert.rejects(() => fetchPage({ url: 'not a url', cfg, fetchImpl: noFetch }), /not a URL/);
});

// ── keys, flags, byte caps ───────────────────────────────────────────────────────────
test('a missing key names the key and the file, attempts NO request, and never prints a value', async () => {
  const bare = { ...cfg, tavily_key: '', firecrawl_key: 'PASTE_YOUR_KEY' };
  for (const [fn, name] of [[() => webSearch({ query: 'q', cfg: bare, fetchImpl: noFetch }), 'tavily_key'],
    [() => fetchPage({ url: 'https://example.com/', cfg: bare, fetchImpl: noFetch }), 'firecrawl_key']]) {
    await assert.rejects(fn, (e) => {
      assert.ok(e instanceof ToolError);
      assert.match(e.message, new RegExp(`Missing ${name}`));
      assert.match(e.message, /config\.json/);
      assert.match(e.message, /缺少/, 'bilingual');
      assert.doesNotMatch(e.message, /tvly-|fc-TEST/, 'a key value must never appear');
      return true;
    });
  }
});

test('requireKey accepts a real-looking key and rejects a PASTE placeholder', () => {
  assert.equal(requireKey(cfg, 'tavily_key'), 'tvly-TEST-not-a-real-key');
  assert.throws(() => requireKey({ tavily_key: '   ' }, 'tavily_key'), /Missing tavily_key/);
});

test('parseArgs: unknown flag and non-numeric value are ERRORS, never silent defaults', () => {
  assert.throws(() => parseArgs(['--nope'], { max: 'num' }, 'usage'), /unknown flag --nope/);
  assert.throws(() => parseArgs(['--max', 'abc'], { max: 'num' }, 'usage'), /--max needs a positive number/);
  assert.throws(() => parseArgs(['--max', '0'], { max: 'num' }, 'usage'), /--max needs a positive number/);
  assert.deepEqual(parseArgs(['--max=3', '--json', 'a', 'b'], { max: 'num', json: 'bool' }, 'usage'),
    { flags: { max: 3, json: true }, positional: ['a', 'b'] });
});

test('capBytes counts BYTES and cuts on a character boundary (no mojibake)', () => {
  const cn = '中'.repeat(10); // 30 UTF-8 bytes
  assert.deepEqual(capBytes(cn, 100), { text: cn, truncated: false, bytes: 30, totalBytes: 30 });
  const cut = capBytes(cn, 8);  // 8 bytes lands mid-character
  assert.equal(cut.text, '中中');
  assert.equal(cut.bytes, 6);
  assert.equal(cut.totalBytes, 30);
  assert.equal(cut.truncated, true);
  assert.doesNotMatch(cut.text, /�/);
});

test('loadToolConfig reads config.json and inherits the ONE set of endpoints from config.mjs (R3)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-webtools-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    default_project: 'assistant', projects: { assistant: { dir: '.' } }, tavily_key: 'tvly-x',
  }));
  const c = loadToolConfig(dir);
  assert.equal(c.research.tavily_url, TAVILY_URL);
  assert.equal(c.research.firecrawl_url, FIRECRAWL_URL);
  assert.ok(c.research.search_timeout_ms > 0 && c.research.scrape_timeout_ms > 0);
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  assert.throws(() => loadToolConfig(dir), /not valid JSON/);
  fs.rmSync(path.join(dir, 'config.json'));
  assert.throws(() => loadToolConfig(dir), /config.json not found/);
  rmTemp(dir);
});

// REGRESSION: both tools once shipped with no fetchImpl default, so every real CLI run died
// with "fetchImpl is not a function" — every unit test passed because each one injected a stub.
// Injection must be an OVERRIDE of globalThis.fetch, never the only way the code works.
test('omitting fetchImpl falls back to globalThis.fetch (the real CLI path)', async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => { seen.push(url); return url === TAVILY_URL ? tavilyOk(RESULTS) : fcOk('page'); };
  try {
    assert.match(await webSearch({ query: 'q', cfg }), /Node\.js docs/);
    assert.match(await fetchPage({ url: 'https://example.com/', cfg }), /page/);
  } finally { globalThis.fetch = real; }
  assert.deepEqual(seen, [TAVILY_URL, FIRECRAWL_URL]);
});

// ── the CLIs really are CLIs: spawned, they exit NON-ZERO with a readable stderr ──────
// (No config and no network needed on these paths — argument errors are raised first.)
for (const [tool, argv, want] of [
  ['tools/websearch.mjs', [], /usage: node tools\/websearch\.mjs/],
  ['tools/websearch.mjs', ['--max', 'abc', 'q'], /--max needs a positive number/],
  ['tools/fetchpage.mjs', [], /usage: node tools\/fetchpage\.mjs/],
  ['tools/fetchpage.mjs', ['--bogus'], /unknown flag --bogus/],
]) {
  test(`${tool} ${argv.join(' ') || '(no args)'} → exit 1 + readable stderr`, async () => {
    const e = await run(process.execPath, [path.join(ROOT, tool), ...argv], { cwd: ROOT }).then(
      () => null, (err) => err);
    assert.ok(e, 'must NOT exit 0');
    assert.equal(e.code, 1);
    assert.match(e.stderr, want);
    assert.equal(e.stdout, '', 'nothing on stdout that could read as an answer');
  });
}
