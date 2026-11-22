#!/usr/bin/env node
// tools/demo-model-bench.mjs — benchmark hosted Ollama models on the demo node's REAL paths.
//
//   node tools/demo-model-bench.mjs --models a,b,c [--only app|chat] [--apps water,habit] [--out /tmp/bench.json]
//
// App build: the demo app maker itself (lib/demo-app.mjs makeDemoApp: the same prompt, contract,
// postcheck, retry and Ask AI injection) on APP_REQUESTS, into a throwaway folder. Scored by
// facts a script can check: written at all, attempts, inline scripts that COMPILE (no headless
// browser in the demo image, so a syntax error is the JS error we can see), controls, saving via
// PAStore/save-data, the request's own feature, and the Ask AI hook. Chat: CHAT_PROMPTS through the
// demo chat's system prompts + SEARCH_RULE, with a real search when the model asks for one; time
// to first text and the answers are recorded — the answers are READ by a person (no model grades
// another model here, and an automatic number would claim more than it knows).
// Runs inside the demo container so OLLAMA_API_KEY stays there: it is read from the environment and
// only ever sent as the bearer header to ollama.com. Nothing here prints it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeDemoApp } from '../lib/demo-app.mjs';
import { hasAskAi } from '../lib/demo-askai.mjs';
import { SEARCH_RULE, parseSearch, ollamaWebSearch, resultsPrompt } from '../lib/demo-search.mjs';
import { appContract, REPLY_LANGUAGE_RULE } from '../lib/config.mjs';
import { askModel, mapLimit } from '../lib/model-review-call.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLLAMA = 'https://ollama.com';
const CALL_TIMEOUT_MS = 180_000, APP_MAX_BYTES = 200 * 1024, PARALLEL_MODELS = 6;

export const APP_REQUESTS = [
  { id: 'water', text: 'a water intake counter: tap to add a glass, shows today\'s date and today\'s total, resets each day', feature: /new Date|toLocaleDateString|toISOString/ },
  { id: 'todo', text: 'a todo list: add, tick off and delete tasks', feature: /checkbox|done|complete/i },
  { id: 'tip', text: 'a tip calculator: bill amount, tip percent, number of people, shows the share per person', feature: /people|person|split/i },
  { id: 'cards', text: 'flashcards: add cards with a front and back, flip a card, go to the next one', feature: /flip|front|back/i },
  { id: 'habit', text: 'a habit tracker with a check per day for each habit, and an Ask AI button to get advice on my habits', feature: /habit/i },
];
export const CHAT_PROMPTS = [
  { id: 'web', turns: ['Who won the most recent Formula 1 Grand Prix, and when was it?'], wantsSearch: true },
  { id: 'zh', turns: ['用三句话解释一下什么是复利，并举一个简单的例子。'] },
  { id: 'plan', turns: ['I have 3 hours on Saturday to clean the garage, do groceries and cook dinner for 4. Give me a time plan with the order and why.'] },
  { id: 'write', turns: ['Write a warm two-sentence thank-you note to a neighbour who watered my plants while I was away.'] },
  { id: 'follow', turns: ['Suggest three names for a small bakery.', 'Make the second one sound more French.'] },
];

const authFetch = (key) => (url, o) => fetch(url, { ...o, headers: { ...(o && o.headers), authorization: `Bearer ${key}` } });

// Inline <script> bodies that fail to compile (the marker and JSON blocks skipped).
export function scriptErrors(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/type\s*=\s*["']?(application\/json|text\/template)/i.test(m[1])) continue;
    try { new vm.Script(m[2]); } catch (e) { out.push(String(e.message).slice(0, 120)); }
  }
  return out;
}

// One app request → its facts. Never throws: a failed build is a row with its reason.
export async function benchApp({ model, request, ask, contract }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-app-'));
  let attempts = 0; const t0 = Date.now();
  const counted = async (messages) => { attempts++; return ask(messages); };
  try {
    const made = await makeDemoApp({ dir, intent: { edit: '', request: request.text }, contract, ask: counted, maxBytes: APP_MAX_BYTES, maxApps: 99 });
    const html = fs.readFileSync(path.join(dir, made.slug, 'index.html'), 'utf8');
    const errs = scriptErrors(html);
    return { model, req: request.id, ok: true, attempts, ms: Date.now() - t0, compiles: !errs.length, jsError: errs[0] || '',
      controls: /<(button|input|select|textarea)\b/i.test(html), saves: /PAStore\.file\(|save-data/.test(html),
      feature: request.feature.test(html), askAi: hasAskAi(html), kb: Math.round(Buffer.byteLength(html) / 1024) };
  } catch (e) {
    return { model, req: request.id, ok: false, attempts, ms: Date.now() - t0, error: String(e.message || e).slice(0, 160) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// A row's quality points (0-6): built, compiles, controls, saves, feature, Ask AI.
export const appPoints = (r) => (r.ok ? 1 + [r.compiles, r.controls, r.saves, r.feature, r.askAi].filter(Boolean).length : 0);

async function benchChat({ model, prompt, key, system }) {
  const messages = system.map((content) => ({ role: 'system', content }));
  const turns = [];
  for (const t of prompt.turns) {
    messages.push({ role: 'user', content: t });
    const t0 = Date.now();
    let r = await askModel({ url: OLLAMA, model, messages, timeoutMs: CALL_TIMEOUT_MS, fetchImpl: authFetch(key) });
    const query = r.ok ? parseSearch(r.text) : null;
    let searched = false;
    if (query) {
      const hits = await ollamaWebSearch({ query, key }).catch((e) => ({ error: e.message }));
      searched = Array.isArray(hits);
      const sys = searched ? resultsPrompt(query, hits) : `Search failed (${hits.error}); answer from what you know.`;
      const r2 = await askModel({ url: OLLAMA, model, messages: messages.concat([{ role: 'system', content: sys }]), timeoutMs: CALL_TIMEOUT_MS, fetchImpl: authFetch(key) });
      const elapsed = Date.now() - t0;   // the search itself included: what the visitor waits for
      r = { ...r2, firstTextMs: elapsed - r2.ms + (r2.firstTextMs ?? r2.ms), ms: elapsed };
    }
    turns.push({ ok: r.ok, error: r.error, firstTextMs: r.firstTextMs, ms: r.ms, searched, query, text: String(r.text).slice(0, 1500) });
    messages.push({ role: 'assistant', content: r.text || '' });
  }
  return { model, prompt: prompt.id, wantsSearch: !!prompt.wantsSearch, turns };
}

const median = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

// Per-model summary lines for the docs table.
export function summarize(apps, chats) {
  const models = [...new Set([...apps.map((r) => r.model), ...chats.map((r) => r.model)])];
  return models.map((m) => {
    const a = apps.filter((r) => r.model === m), c = chats.filter((r) => r.model === m);
    const t = c.flatMap((r) => r.turns);
    return { model: m, appPoints: a.reduce((s, r) => s + appPoints(r), 0), appMax: a.length * 6, appBuilt: a.filter((r) => r.ok).length,
      appRetries: a.reduce((s, r) => s + Math.max(0, r.attempts - 1), 0), appMedianS: median(a.filter((r) => r.ok).map((r) => r.ms / 1000)),
      chatOk: t.filter((x) => x.ok).length, chatTurns: t.length, chatFirstTextS: median(t.map((x) => x.firstTextMs / 1000)),
      searchedWhenNeeded: c.filter((r) => r.wantsSearch).every((r) => r.turns[0].searched) };
  });
}

// The summary as a markdown table (docs/demo-models.md and the weekly watch report).
export function summaryTable(summary) {
  const n = (x) => (x === null || x === undefined ? '—' : String(Math.round(x * 10) / 10));
  return ['| model | app points | built | retries | app median s | chat ok | chat first text s | searched when needed |',
    '|---|---|---|---|---|---|---|---|']
    .concat(summary.map((s) => `| ${s.model} | ${s.appPoints}/${s.appMax} | ${s.appBuilt} | ${s.appRetries} | ${n(s.appMedianS)} | ${s.chatOk}/${s.chatTurns} | ${n(s.chatFirstTextS)} | ${s.searchedWhenNeeded ? 'yes' : 'no'} |`))
    .join('\n');
}

export async function runBench({ models, only, key, apps: apps_ = null }) {
  const contract = appContract(ROOT);
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/demo/config.demo.json'), 'utf8'));
  const system = [cfg.system_prompts.global, REPLY_LANGUAGE_RULE, SEARCH_RULE];
  const perModel = await mapLimit(models, PARALLEL_MODELS, async (model) => {
    const ask = async (messages) => {
      const r = await askModel({ url: OLLAMA, model, messages, timeoutMs: CALL_TIMEOUT_MS, fetchImpl: authFetch(key) });
      if (!r.ok) throw new Error(r.error);
      return r.text;
    };
    const apps = [], chats = [];
    if (only !== 'chat') for (const request of APP_REQUESTS.filter((r) => !apps_ || apps_.includes(r.id))) apps.push(await benchApp({ model, request, ask, contract }));
    if (only !== 'app') for (const prompt of CHAT_PROMPTS) chats.push(await benchChat({ model, prompt, key, system }));
    process.stderr.write(`done ${model}\n`);
    return { apps, chats };
  });
  const apps = perModel.flatMap((x) => x.apps), chats = perModel.flatMap((x) => x.chats);
  return { at: new Date().toISOString(), apps, chats, summary: summarize(apps, chats) };
}

async function main() {
  const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : ''; };
  const models = arg('models').split(',').map((s) => s.trim()).filter(Boolean);
  if (!models.length) throw new Error('usage: --models a,b [--only app|chat] [--out file]');
  const key = process.env.OLLAMA_API_KEY;
  if (!key) throw new Error('OLLAMA_API_KEY is not set in this environment');
  const out = await runBench({ models, only: arg('only'), key, apps: arg('apps') ? arg('apps').split(',') : null });
  const json = JSON.stringify(out, null, 1);
  if (arg('out')) fs.writeFileSync(arg('out'), json); else process.stdout.write(json + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`bench failed: ${e.message}\n`); process.exit(1); });
}
