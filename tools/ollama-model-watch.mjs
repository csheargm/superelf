#!/usr/bin/env node
// tools/ollama-model-watch.mjs — notice new hosted Ollama models and bench them. REPORTS ONLY.
//
//   node tools/ollama-model-watch.mjs --known /data/model-watch/known.json --report-dir /data/model-watch
//
// Diffs ollama.com/api/tags against the recorded list (the --known file; first run seeds it from
// ops/demo/ollama-models.json in the repo), runs tools/demo-model-bench.mjs on the NEW names only,
// and writes model-watch-<date>.md beside it. It never edits config.demo.json and never switches a
// model: the owner reads the report and decides (docs/demo-models.md). Run weekly by
// ops/demo/superelf-demo-model-watch.timer, inside the demo container so the key stays there.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonFile } from '../lib/atomicwrite.mjs';
import { runBench, summaryTable } from './demo-model-bench.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CATALOG_URL = 'https://ollama.com/api/tags';
const SEED = path.join(ROOT, 'ops/demo/ollama-models.json');
const FETCH_TIMEOUT_MS = 30_000;
const MAX_NEW_PER_RUN = 8;   // the call budget: at most this many models benched per week, the rest wait

export const diffModels = (known, catalog) => ({ added: catalog.filter((m) => !known.includes(m)), removed: known.filter((m) => !catalog.includes(m)) });

export async function fetchCatalog(url = CATALOG_URL, fetchImpl = fetch) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`catalog ${url}: HTTP ${r.status}`);
  const names = ((await r.json()).models || []).map((m) => m && (m.name || m.model)).filter((s) => typeof s === 'string' && s);
  if (!names.length) throw new Error('catalog listed no models');   // an empty list is a failure, never "nothing new" (R14)
  return [...new Set(names)].sort();
}

export function reportText({ date, added, removed, summary, error }) {
  const lines = [`# Ollama model watch · 模型观察 — ${date}`, '',
    `New · 新增: ${added.length ? added.join(', ') : 'none · 无'}`, `Gone · 下架: ${removed.length ? removed.join(', ') : 'none · 无'}`, ''];
  if (error) lines.push(`Bench failed · 评测失败: ${error}`, '');
  if (summary && summary.length) lines.push(summaryTable(summary), '');
  lines.push('Report only: no model was switched. To adopt one, edit ops/demo/config.demo.json (chat_models / demo.app_model) and redeploy · 仅报告，未自动切换模型。');
  return lines.join('\n') + '\n';
}

const failFile = (knownFile) => knownFile.replace(/\.json$/, '') + '-failures.json';
const readFails = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } };
const readKnown = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return JSON.parse(fs.readFileSync(SEED, 'utf8')); throw e; }
};

// One watch run → the report path. `bench` is injected for tests.
export async function watch({ knownFile, reportDir, key, catalog, bench = runBench, now = new Date() }) {
  const names = catalog || await fetchCatalog();
  const { added, removed } = diffModels(readKnown(knownFile), names);
  let summary = null, error = '';
  // Models that failed twice go to the back, so a few dead names never starve the rest.
  const fails = readFails(failFile(knownFile));
  const batch = [...added].sort((a, b) => (fails[a] || 0) - (fails[b] || 0)).slice(0, MAX_NEW_PER_RUN);
  if (batch.length) {
    try { summary = (await bench({ models: batch, key })).summary; }
    catch (e) { error = String(e.message || e).slice(0, 300); }
  }
  // Recorded as seen: the old names still listed, plus a new one only when it answered at least
  // once. A model whose every call failed (or that waited for the budget) stays new for next week.
  const answered = new Set((summary || []).filter((s) => s.appBuilt + s.chatOk > 0).map((s) => s.model));
  const seen = names.filter((m) => !added.includes(m) || answered.has(m));
  if (!error) for (const m of batch) if (!answered.has(m)) fails[m] = (fails[m] || 0) + 1;
  writeJsonFile(failFile(knownFile), fails);
  const date = now.toISOString().slice(0, 10);
  fs.mkdirSync(reportDir, { recursive: true });
  const file = path.join(reportDir, `model-watch-${date}.md`);
  fs.writeFileSync(file, reportText({ date, added, removed, summary, error }));
  writeJsonFile(knownFile, seen);
  return file;
}

async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const reportDir = arg('report-dir', '/data/model-watch');
  const file = await watch({ knownFile: arg('known', path.join(reportDir, 'known.json')), reportDir, key: process.env.OLLAMA_API_KEY });
  process.stdout.write(`report: ${file}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stderr.write(`model watch failed: ${e.message}\n`); process.exit(1); });
}
