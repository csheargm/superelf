#!/usr/bin/env node
// tools/fetch-daily-digest.mjs
// Fetches real-time web news per topic, summarizes via Claude, saves cache.json.
// Run: node tools/fetch-daily-digest.mjs
// Cron: set up via the schedule skill to run daily (e.g. 6am).

import { execFileSync } from 'node:child_process';
import { runClaude } from '../lib/runner.mjs';
import { digestArgs } from '../lib/one-shot.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.join(ROOT, 'workspace');
const DATA_DIR = path.join(WORKSPACE, 'data/daily-digest');
const TOPICS_FILE = path.join(DATA_DIR, 'topics.json');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const SEARCH_TOOL = path.join(ROOT, 'tools/websearch.mjs');
// The model and thinking-off come from config.json fast_args (docs/adr/0008 item 4). When config
// cannot be used, the digest still runs on the pin it shipped with (thinking on) and says why: a bad
// config.json must cost the day's digest nothing.
const FALLBACK_ARGS = ['--model', 'claude-haiku-4-5-20251001'];
const CLAUDE_TIMEOUT_MS = 90000;

export const DEFAULT_TOPICS = [
  { key: 'longevity', name: '健康与长寿', icon: '🌿', query: 'longevity health nutrition sleep anti-aging science research 2026' },
  { key: 'diabetes',  name: '糖尿病管理', icon: '💙', query: 'diabetes management blood glucose HbA1c insulin sensitivity 2026' },
  { key: 'faith',     name: '圣经与信仰', icon: '✝️', query: 'Christianity Bible devotional faith spiritual growth 2026' },
  { key: 'music',     name: '音乐',       icon: '🎵', query: 'music composition music theory open source audio tools 2026' },
  { key: 'ai',        name: 'AI · 科技 · Tesla FSD', icon: '🤖', query: 'AI LLM large language model Tesla FSD full self-driving autopilot news 2026' },
  { key: 'oss',       name: '开源动态',   icon: '🔓', query: 'open source Linux Foundation CNCF cloud native GitHub trending community 2026' },
  { key: 'gosim',     name: 'GOSIM · 开源AI社区', icon: '🌐', query: 'GOSIM open source AI agentic AI MCP A2A protocol open source robotics embodied AI news 2026' },
  { key: 'aivf',      name: 'AI Vision Forum · 智能体时代', icon: '🏢', query: '"AI Vision Forum" OR "agentic OS" OR "AI-BOM" provenance OR "mobile agentic" OR "AI-native organization" OR agentic enterprise governance 2026' },
];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadTopics() {
  try { return JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8')); } catch { return DEFAULT_TOPICS; }
}

function searchTopic(topic) {
  try {
    // execFileSync with an argv ARRAY, not a shell string. On Windows this ran through cmd.exe,
    // which does not treat \" as an escape — and the shipped `aivf` topic contains embedded
    // double quotes, so the query arrived mangled. An array needs no quoting at all.
    const out = execFileSync(process.execPath, [SEARCH_TOOL, topic.query, '--max', '4', '--json'], {
      encoding: 'utf8', timeout: 20000,
    });
    return (JSON.parse(out).results || []).slice(0, 4);
  } catch (e) {
    console.error(`  [${topic.key}] search failed:`, e.message.slice(0, 120));
    return [];
  }
}

// Read at use time and read-only (docs/adr/0011): nothing written to config.json, nothing provisioned.
// The import is inside the try too, so not even a broken lib/config.mjs stops the digest.
async function claudeArgs() {
  try {
    const { loadConfig } = await import('../lib/config.mjs');
    return { args: digestArgs((await loadConfig(ROOT, { readOnly: true })).fast_args), from: 'config.json fast_args' };
  } catch (e) {
    // Not swallowed (R5): the reason goes to stderr, and the run goes on as it did before config was read.
    console.error(`config.json could not be used (${e.message}), so the digest runs on its built-in ${FALLBACK_ARGS.join(' ')}, thinking on`);
    return { args: FALLBACK_ARGS, from: 'built-in fallback' };
  }
}

// lib/runner.mjs runClaude, the one claude spawn path: the .cmd shim resolved without a shell, and on
// its Windows shell fallback the no-thinking pair dropped with one warning, as for every other run.
async function callClaude(prompt) {
  const { args, from } = await claudeArgs();
  console.log(`Summarizing with Claude: ${args.join(' ') || 'the CLI defaults'} (${from})…`);
  const r = await runClaude({ claudeCmd: 'claude', extraArgs: args, cwd: WORKSPACE, prompt, timeoutMs: CLAUDE_TIMEOUT_MS });
  if (!r.ok) throw new Error(r.timedOut ? `claude timed out after ${CLAUDE_TIMEOUT_MS / 1000} s` : r.text.slice(0, 200));
  return r.text.trim();
}

async function main() {
  const topics = loadTopics();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 1. Search all topics
  console.log(`Fetching web news for ${topics.length} topics…`);
  const searchResults = {};
  for (const topic of topics) {
    process.stdout.write(`  → ${topic.key} `);
    searchResults[topic.key] = searchTopic(topic);
    console.log(`(${searchResults[topic.key].length} results)`);
  }

  // 2. Build combined prompt
  const sections = topics.map(t => {
    const results = searchResults[t.key] || [];
    const snippets = results.length
      ? results.map((r, i) => `  [${i + 1}] ${r.title}\n      ${r.snippet.slice(0, 250)}`).join('\n')
      : '  (no search results — skip or use general knowledge)';
    return `### ${t.key} (${t.name})\n${snippets}`;
  }).join('\n\n');

  const keyLines = topics.map(t => `  "${t.key}": ["要点1","要点2","要点3"]`).join(',\n');
  const prompt = `你是用户的个人助理。以下是今日各领域的最新网络搜索结果。

请基于这些真实搜索结果，为每个领域总结3条中文要点（每条30-55字）。
用中文，专业术语保留英文。只返回纯JSON，无其他文字：

{
${keyLines}
}

今日搜索结果：

${sections}`;

  // 3. Summarize
  let digest = {};
  try {
    const raw = (await callClaude(prompt))
      .replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/\s*```$/m, '');
    digest = JSON.parse(raw);
  } catch (e) {
    console.error('Summarization failed, using titles as fallback:', e.message);
    for (const topic of topics) {
      const results = searchResults[topic.key] || [];
      digest[topic.key] = results.slice(0, 3).map(r => r.title.slice(0, 80));
    }
  }

  // 4. Build sources map (title + url per topic)
  const sources = {};
  for (const topic of topics) {
    sources[topic.key] = (searchResults[topic.key] || []).map(r => ({ title: r.title, url: r.url }));
  }

  const cache = {
    date: todayStr(),
    source: 'web',
    generatedAt: new Date().toISOString(),
    digest,
    sources,
  };

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`Done. Saved to ${CACHE_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
