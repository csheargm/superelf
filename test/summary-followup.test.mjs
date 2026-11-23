// lib/summary-followup.mjs + POST /api/summary-followup (ADR 0027, docs/plans/note-features.md I): the
// Open to-dos of a summary → one brief block. The extractor on EN and 中文 summaries however the model
// dressed the heading; the classifier; buildFollowup with a fake research lane and a fake fast lane
// (format caps enforced: ≤3 whole-sentence bullets, ≤2 source links, the research cap, a
// timed-out and a failed item NAMED and `partial`, no keys → unavailable, no to-dos → empty); then the
// route over the REAL web.mjs with ONE node:http stub standing in for Ollama, Tavily and Firecrawl —
// the stub records what reached the search engine, which must be the to-do line and nothing else.
// R11 — searched: "Open to-dos", "待办", "Follow-up ·", "summary_followup", "classifyTodo", "No result ·", "FOLLOWUP_CONCURRENCY" — no duplicates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';
import { extractTodos, classifyTodo, hasPersonalCue, buildFollowup, researchBullets, formatBlock, followupDeps, isTodoHeading, TODO_HEADING, FOLLOWUP_HEADING,
  RESEARCH_MAX_ITEMS, ITEMS_MAX, BULLETS_MAX, BULLET_CHARS, FOLLOWUP_CONCURRENCY, KIND_RESEARCH, KIND_PERSONAL, TXT, SUGGEST_PROMPT, BRIEF_GUIDE } from '../lib/summary-followup.mjs';
import { QUESTION_PROMPT } from '../lib/followup-question.mjs';

const EN = `## Reflections\n- A wet week on the roof [1]\n\n## ${TODO_HEADING}\n- Call the landlord about the gutter [1]\n- **Find out** whether solar tiles work on a flat roof [2]\n- [ ] Pay the November rent\n- Compare e-bike prices under $1500\n- Call the landlord about the gutter [1]\n\n## Sources\n- nothing`;
const ZH = `## 反思\n- 屋顶漏水 [1]\n\n**待办事项：**\n1. 给房东打电话说明雨槽问题 [1]\n2. 了解平屋顶能否装太阳能瓦 [2]\n3. 交十一月房租\n\n其他说明`;

test('extractTodos: the list under the to-do heading, EN (`## 待办 · Open to-dos`) and 中文 (`**待办事项：**`), undressed, [n] dropped, unique; nothing without the heading', () => {
  const en = extractTodos(EN);
  assert.equal(en.found, true);
  assert.deepEqual(en.items, ['Call the landlord about the gutter', 'Find out whether solar tiles work on a flat roof', 'Pay the November rent', 'Compare e-bike prices under $1500'], 'bold and checkbox undressed, the duplicate once, the Sources section not read');
  const zh = extractTodos(ZH);
  assert.deepEqual(zh.items, ['给房东打电话说明雨槽问题', '了解平屋顶能否装太阳能瓦', '交十一月房租'], 'numbered list under a bold 中文 heading; the paragraph after it is not an item');
  assert.deepEqual(extractTodos('## Reflections\n- nothing open'), { items: [], dropped: 0, found: false });
  assert.deepEqual(extractTodos(''), { items: [], dropped: 0, found: false });
  for (const h of ['## Open To-Dos', '### Open todos:', '**待办 · Open to-dos**', '## 待办', '# Todo list']) assert.equal(isTodoHeading(h), true, h);
  for (const h of ['- Open to-dos are many', '## Reflections', 'Open to-dos', '## ' + 'x'.repeat(70) + ' 待办']) assert.equal(isTodoHeading(h), false, h);
  const long = `## ${TODO_HEADING}\n` + Array.from({ length: ITEMS_MAX + 3 }, (_, i) => `- item ${i}`).join('\n');
  const l = extractTodos(long); assert.equal(l.items.length, ITEMS_MAX); assert.equal(l.dropped, 3, 'past the cap: counted, not silently gone');
});

test('classifyTodo: a personal verb at the start stays home, a question about the world goes out, a tie stays home', () => {
  for (const s of ['Call the landlord about whether the gutter is covered', 'Pay the November rent', 'Email Taylor the photos', '给房东打电话说明雨槽问题', '交十一月房租', '预约牙医', 'Buy milk', 'Water the plants']) assert.equal(classifyTodo(s), KIND_PERSONAL, s);
  for (const s of ['Find out whether solar tiles work on a flat roof', 'Compare e-bike prices under $1500', 'How much does a roof inspection cost?', 'Best way to store onions?', '了解平屋顶能否装太阳能瓦', '比较几款电动自行车的价格', 'Which laptop for a 10 year old', 'Is the 2026 Civic hybrid worth it?']) assert.equal(classifyTodo(s), KIND_RESEARCH, s);
  assert.equal(classifyTodo(''), KIND_PERSONAL);
});

test('personal-cue guard: a named person, a relative or a contact verb ANYWHERE keeps a to-do off the search engine, whatever research cue it also carries', async () => {
  const personal = ['Find out whether Taylor wants the sofa', 'Check if mom needs a ride on Friday', 'Research what to get for Dad', 'Compare quotes and ask Tom which is best',
    'How much do I owe the landlord?', 'Look up the dentist and pay the bill', 'Which gift for my daughter', 'Best time to email Mr. Lee about the lease', '了解妈妈想要什么礼物', '查一下怎么给房东发邮件', '比较价格后问问老公'];
  for (const s of personal) { assert.equal(hasPersonalCue(s), true, s); assert.equal(classifyTodo(s), KIND_PERSONAL, s); }
  for (const s of ['Find out whether solar tiles work on a flat roof', 'Is the 2026 Civic hybrid worth it?', 'Which laptop for a 10 year old', '了解平屋顶能否装太阳能瓦']) assert.equal(hasPersonalCue(s), false, s);
  // Through buildFollowup: the research lane is never reached for them — the suggestion path is.
  const text = `## ${TODO_HEADING}\n- Find out whether Taylor wants the sofa\n- 了解妈妈想要什么礼物`;
  const suggested = [];
  const r = await buildFollowup(text, { research: (q) => { throw new Error('research must not see: ' + q); }, suggest: async (q) => { suggested.push(q); return 'one line'; }, perItemTimeoutMs: 1000 });
  assert.deepEqual(suggested, ['Find out whether Taylor wants the sofa', '了解妈妈想要什么礼物']); assert.equal(r.partial, false); assert.equal(r.researched, 0); assert.equal(r.suggested, 2);
});

test('concurrency: at most FOLLOWUP_CONCURRENCY (2) items in flight, results in item order; a timed-out item frees its slot and says "No result" — the block never hangs', async () => {
  assert.equal(FOLLOWUP_CONCURRENCY, 2);
  const text = `## ${TODO_HEADING}\n` + Array.from({ length: 5 }, (_, i) => `- Find out thing ${i}`).join('\n');
  const pending = []; let inFlight = 0, peak = 0;
  const research = (q) => new Promise((res) => { inFlight++; peak = Math.max(peak, inFlight); pending.push(() => { inFlight--; res({ ok: true, text: 'A ' + q, sources: [] }); }); });
  const p = buildFollowup(text, { research, suggest: async () => 'x', perItemTimeoutMs: 5000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.length, 2, 'two started, the third waits');
  pending[1](); await new Promise((r) => setImmediate(r));   // the second finishes first: the third starts, order of results is still the items'
  assert.equal(pending.length, 3);
  while (pending.length) pending.shift()(), await new Promise((r) => setImmediate(r));
  const r = await p;
  assert.equal(peak, 2); assert.deepEqual(r.items.map((i) => i.item), Array.from({ length: 5 }, (_, i) => `Find out thing ${i}`));
  assert.equal(r.text.split('\n\n')[1], '### Find out thing 1\n- A Find out thing 1');
  // Fail-closed: a lane that never answers holds its slot only until its deadline; the other items still run and the block arrives.
  const never = () => new Promise(() => {});
  const t0 = Date.now();
  const t = await buildFollowup(`## ${TODO_HEADING}\n- Find out A\n- Find out B\n- Find out C`, { research: (q) => (q === 'Find out A' ? never() : Promise.resolve({ ok: true, text: 'ok ' + q, sources: [] })), suggest: async () => 'x', perItemTimeoutMs: 30 });
  assert.ok(Date.now() - t0 < 2000, 'bounded by the deadline, not by the hung lane');
  assert.equal(t.partial, true); assert.deepEqual(t.items.map((i) => i.ok), [false, true, true]);
  assert.equal(t.text.split('\n\n')[0], `### Find out A\n- ${TXT.noResult} — 超时 · timed out after 30ms`);
});

const research = (items = {}) => (q) => (items[q] ? items[q]() : Promise.resolve({ ok: true, text: 'Answer for ' + q + ' [1]\nSecond line\nThird line\nFourth line', sources: [{ url: 'https://www.example.com/a' }, { url: 'https://b.org/x', error: 'boom' }, { url: 'https://c.net/' }] }));
const suggest = (items = {}) => (q) => (items[q] ? items[q]() : Promise.resolve('Do it on Monday morning.\nA second line nobody asked for'));

test('buildFollowup: one heading per item, ≤3 whole-sentence bullets then ≤2 source links, one line per personal item, the research cap, failures and timeouts NAMED and partial', async () => {
  const calls = { research: [], suggest: [] };
  const r = await buildFollowup(EN, { research: (q) => { calls.research.push(q); return research()(q); }, suggest: (q) => { calls.suggest.push(q); return suggest()(q); }, perItemTimeoutMs: 1000 });
  assert.equal(r.ok, true); assert.equal(r.heading, FOLLOWUP_HEADING); assert.equal(r.partial, false); assert.equal(r.found, true);
  assert.deepEqual(calls.research, ['Find out whether solar tiles work on a flat roof', 'Compare e-bike prices under $1500'], 'ONLY the researchable items reach the research lane, as their own line');
  assert.deepEqual(calls.suggest, ['Call the landlord about the gutter', 'Pay the November rent']);
  assert.deepEqual(r.items.map((i) => [i.kind, i.ok]), [[KIND_PERSONAL, true], [KIND_RESEARCH, true], [KIND_PERSONAL, true], [KIND_RESEARCH, true]]);
  assert.equal(r.researched, 2); assert.equal(r.suggested, 2);
  assert.equal(r.text, ['### Call the landlord about the gutter\n- Do it on Monday morning.',
    '### Find out whether solar tiles work on a flat roof\n- Answer for Find out whether solar tiles work on a flat roof\n- Second line\n- Third line\n- 来源 · Sources: [example.com](https://www.example.com/a) · [c.net](https://c.net/)',
    '### Pay the November rent\n- Do it on Monday morning.',
    '### Compare e-bike prices under $1500\n- Answer for Compare e-bike prices under $1500\n- Second line\n- Third line\n- 来源 · Sources: [example.com](https://www.example.com/a) · [c.net](https://c.net/)'].join('\n\n'),
  'three answer lines + one sources line of links; the [1] dropped; a failed source is not linked; an untitled source is titled by its host');
  // Caps: a 300-char line with no word break is cut to BULLET_CHARS; a long research block never exceeds 3 bullets.
  const longLine = 'x'.repeat(300);
  const b = researchBullets({ ok: true, text: `${longLine}\n${longLine}\n${longLine}\n${longLine}\n\n**来源 · Sources**\n1. [a](https://a.com)`, sources: [] });
  assert.equal(b.length, BULLETS_MAX); for (const l of b) assert.equal(l.length, BULLET_CHARS); assert.equal(b[0].endsWith('…'), true);
  assert.equal(formatBlock([{ item: 'i', bullets: ['a', 'b', 'c', 'd', 'e'] }]).split('\n').length, 5, 'formatBlock keeps 3 bullets + the sources line whatever it is handed');
  // Failures: a timed-out research item, a rejected one, an ok:false one, an empty suggestion — each on its own line, the block partial.
  const slow = () => new Promise((res) => setTimeout(() => res({ ok: true, text: 'late' }), 200));
  const text = `## ${TODO_HEADING}\n- Find out A\n- Find out B\n- Find out C\n- Pay D\n- Pay E`;
  const p = await buildFollowup(text, { research: research({ 'Find out A': slow, 'Find out B': () => Promise.reject(new Error('Tavily HTTP 500')), 'Find out C': () => Promise.resolve({ ok: false, text: 'Search failed · 搜索失败 — x' }) }),
    suggest: suggest({ 'Pay D': () => Promise.resolve('   \n'), 'Pay E': () => Promise.reject(new Error('Ollama HTTP 410')) }), perItemTimeoutMs: 20 });
  assert.equal(p.partial, true); assert.deepEqual(p.items.map((i) => i.ok), [false, false, false, false, false]);
  assert.equal(p.text, `### Find out A\n- ${TXT.noResult} — 超时 · timed out after 20ms\n\n### Find out B\n- ${TXT.failed} — Tavily HTTP 500\n\n### Find out C\n- ${TXT.failed} — Search failed · 搜索失败 — x\n\n### Pay D\n- ${TXT.empty}\n\n### Pay E\n- ${TXT.failed} — Ollama HTTP 410`);
  // The research cap: the sixth researchable item is not sent and says so; no keys: every researchable item says so, the personal ones still run.
  const many = `## ${TODO_HEADING}\n` + Array.from({ length: RESEARCH_MAX_ITEMS + 1 }, (_, i) => `- Find out thing ${i}`).join('\n') + '\n- Pay the rent';
  const c = { research: [] };
  const m = await buildFollowup(many, { research: (q) => { c.research.push(q); return research()(q); }, suggest: suggest(), perItemTimeoutMs: 1000 });
  assert.equal(c.research.length, RESEARCH_MAX_ITEMS); assert.equal(m.partial, true);
  assert.match(m.text, new RegExp(`### Find out thing ${RESEARCH_MAX_ITEMS}\\n- 未研究（上限 ${RESEARCH_MAX_ITEMS}） · Not researched \\(cap ${RESEARCH_MAX_ITEMS}\\)`));
  const none = await buildFollowup(EN, { research: null, suggest: suggest(), perItemTimeoutMs: 1000 });
  assert.equal(none.partial, true); assert.equal(none.researched, 0); assert.equal(none.suggested, 2);
  assert.match(none.text, new RegExp(`### Find out whether solar tiles work on a flat roof\\n- ${TXT.unavailable.replace(/[()]/g, '\\$&')}`));
  // CONTROL: no to-dos → an empty block, nothing called.
  const e = await buildFollowup('## Reflections\n- all done', { research: () => { throw new Error('must not be called'); }, suggest: () => { throw new Error('must not be called'); } });
  assert.deepEqual([e.ok, e.text, e.items, e.partial, e.found], [true, '', [], false, false]);
});

test('followupDeps: research only with BOTH keys and a writer lane; the writer (default Claude) writes the search question from the to-do + its notes, the synthesis under the brief guide, and the suggestion; per-item deadline from cfg', async () => {
  const calls = [];
  const streamOllama = async (o) => { calls.push(['fast', o.model, o.messages[0].content]); return 'fast line'; };
  const agents = { claude: async (p) => { calls.push(['claude', p]); return { ok: true, text: p.startsWith(QUESTION_PROMPT) ? '"Do solar tiles work on a flat roof?"' : 'claude line' }; } };
  const runResearch = async (q, deps) => { calls.push(['research', q, deps]); return { ok: true, text: await deps.lanes.streamOllama({ messages: [{ role: 'user', content: 'SYNTH' }] }), sources: [] }; };
  const base = { chat_models: [{ id: 'fast', provider: 'ollama', model: 'fast:cloud' }], research: { llm: 'fast', tavily_url: 'u' }, ollama_url: 'http://o', summary_followup_item_timeout_ms: 1234 };
  const d0 = followupDeps({ cfg: { ...base, tavily_key: 'tv', firecrawl_key: 'PASTE_ME' }, runResearch, streamOllama, agents });
  assert.equal(d0.research, null, 'a placeholder Firecrawl key is no key'); assert.equal(d0.perItemTimeoutMs, 1234);
  assert.equal(followupDeps({ cfg: { ...base, tavily_key: 'tv' }, runResearch, streamOllama, agents }).research, null, 'Tavily alone finds but cannot read');
  const d = followupDeps({ cfg: { ...base, tavily_key: 'tv', firecrawl_key: 'fc' }, runResearch, streamOllama, agents });
  const r = await d.research('Find out about solar tiles', 'Roof repairs · a wet week');
  assert.equal(r.text, 'claude line');
  assert.equal(calls[0][0], 'claude'); assert.ok(calls[0][1].includes('Find out about solar tiles') && calls[0][1].includes('Roof repairs · a wet week'), 'the question step sees the to-do AND its notes');
  assert.equal(calls[1][1], 'Do solar tiles work on a flat roof?', 'the search engine gets the writer\'s one question, unquoted');
  assert.deepEqual(calls[1][2].keys, { tavily: 'tv', firecrawl: 'fc' }); assert.ok(calls[1][2].guide.startsWith(BRIEF_GUIDE) && calls[1][2].guide.includes('Find out about solar tiles'));
  assert.deepEqual(calls[2], ['claude', 'SYNTH'], 'the synthesis rides the writer (Claude), not the fast lane');
  assert.equal(await d.suggest('Pay the rent', 'ctx'), 'claude line'); assert.ok(calls[3][1].startsWith(SUGGEST_PROMPT + 'Pay the rent'));
  assert.equal(calls.some((c) => c[0] === 'fast'), false, 'the fast lane never ran: Claude answered'); assert.equal(d.fallbacks.size, 0);
  // A question that picked up a person goes back to the bare to-do (the personal guard on the way out too).
  const leaky = followupDeps({ cfg: { ...base, tavily_key: 'tv', firecrawl_key: 'fc' }, runResearch, streamOllama, agents: { claude: async (p) => ({ ok: true, text: p.startsWith(QUESTION_PROMPT) ? 'Should I ask Taylor about solar?' : 'x' }) } });
  calls.length = 0; await leaky.research('Find out about solar tiles', 'ctx'); assert.equal(calls[0][1], 'Find out about solar tiles');
  // No writer lane at all: research off and the suggestion says so.
  const noLane = followupDeps({ cfg: { chat_models: [], research: { writer: 'codex' }, tavily_key: 'tv', firecrawl_key: 'fc' }, runResearch, streamOllama });
  assert.equal(noLane.research, null); await assert.rejects(noLane.suggest('x'), /no writer lane/);
});

test('followupDeps: Claude failing (sign-in) falls back to Codex, then the fast lane; the lane that answered is named in writerFallback and on nothing else', async () => {
  const text = `## Week\n- a wet week\n\n## ${TODO_HEADING}\n- Pay the rent\n- Water the plants`;
  const cfg = { chat_models: [{ id: 'fast', label: 'Fast', provider: 'ollama', model: 'f' }, { id: 'gpt', provider: 'codex', model: 'gpt-x' }], research: { llm: 'fast' } };
  const order = [];
  const agents = { claude: async () => { order.push('claude'); return { ok: false, text: 'Claude sign-in on the Mac node has expired' }; },
    codex: async (p, model) => { order.push('codex:' + model); return { ok: true, text: 'Water them on Sunday.' }; } };
  const d = followupDeps({ cfg, runResearch: null, streamOllama: async () => { order.push('fast'); return 'never'; }, agents });
  const r = await buildFollowup(text, d);
  assert.equal(r.partial, false); assert.equal(r.writerFallback, 'Codex'); assert.equal(order.includes('fast'), false);
  assert.deepEqual(order.sort(), ['claude', 'claude', 'codex:gpt-x', 'codex:gpt-x'], 'each item: Claude first, then Codex (two items run at once)');
  const d2 = followupDeps({ cfg, runResearch: null, streamOllama: async () => 'Fast says water.', agents: { claude: agents.claude, codex: async () => ({ ok: true, text: '  ' }) } });
  const r2 = await buildFollowup(text, d2);
  assert.equal(r2.writerFallback, 'Fast', 'an EMPTY Codex answer is a failure too (R14)'); assert.match(r2.text, /- Fast says water\./);
  const ok = await buildFollowup(text, followupDeps({ cfg, runResearch: null, streamOllama: async () => 'x', agents: { claude: async () => ({ ok: true, text: 'Fine.' }) } }));
  assert.equal('writerFallback' in ok, false, 'no fallback, nothing said');
});

// ── The route, over the real web.mjs: ONE stub speaks Ollama's /api/chat NDJSON, Tavily's /search and Firecrawl's /v2/scrape ──
let port, root, web, stub, stubPort; const seen = [];
function startStub() {
  return new Promise((res) => {
    stub = http.createServer((req, rs) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const j = b ? JSON.parse(b) : {}; seen.push({ path: req.url, body: j });
      if (req.url === '/api/chat') { rs.writeHead(200, { 'content-type': 'application/x-ndjson' }); const last = j.messages[j.messages.length - 1].content;
        const text = last.startsWith(SUGGEST_PROMPT) ? 'Ask for a written quote first.' : last.startsWith(QUESTION_PROMPT) ? (last.includes('e-bike') ? 'Best e-bikes under $1500 in 2026?' : 'Do solar tiles work on a flat roof?')
          : 'Flat roofs take solar tiles with a tilt frame [1]. Check the warranty.';
        rs.end(JSON.stringify({ message: { content: text } }) + '\n' + JSON.stringify({ done: true }) + '\n'); return; }
      if (req.url === '/search') { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ results: [{ title: 'Solar on flat roofs', url: 'https://www.solar.example/flat', content: 's' }] })); return; }
      if (req.url === '/v2/scrape') { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ success: true, data: { markdown: 'Flat roofs can take solar tiles on a tilt frame.' } })); return; }
      rs.writeHead(404); rs.end();
    }); });
    stub.listen(0, '127.0.0.1', () => { stubPort = stub.address().port; res(); });
  });
}
before(async () => {
  await startStub();
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { ollama_url: `http://127.0.0.1:${stubPort}`, tavily_key: 'tv-test', firecrawl_key: 'fc-test', summary_followup_item_timeout_ms: 5000,
    research: { writer: 'deepseek', tavily_url: `http://127.0.0.1:${stubPort}/search`, firecrawl_url: `http://127.0.0.1:${stubPort}/v2/scrape` } } });
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (stub) stub.close(); });

test('POST /api/summary-followup over the real web.mjs (writer = a stub fast lane): the to-dos researched and suggested; the search engine got ONE writer question per research to-do, never the summary body', async () => {
  const r = await api(port, '/api/summary-followup', { method: 'POST', body: JSON.stringify({ text: EN }) });
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.ok, true); assert.equal(j.heading, FOLLOWUP_HEADING); assert.equal(j.partial, false, JSON.stringify(j));
  assert.deepEqual(j.items.map((i) => [i.item, i.kind, i.ok]), [['Call the landlord about the gutter', KIND_PERSONAL, true], ['Find out whether solar tiles work on a flat roof', KIND_RESEARCH, true], ['Pay the November rent', KIND_PERSONAL, true], ['Compare e-bike prices under $1500', KIND_RESEARCH, true]]);
  assert.match(j.text, /### Find out whether solar tiles work on a flat roof\n- Flat roofs take solar tiles with a tilt frame\. Check the warranty\.\n- 来源 · Sources: \[Solar on flat roofs\]\(https:\/\/www\.solar\.example\/flat\)/, 'the writer\'s answer, [1] dropped, the source as a link');
  assert.match(j.text, /### Call the landlord about the gutter\n- Ask for a written quote first\./);
  const searches = seen.filter((s) => s.path === '/search').map((s) => s.body.query);
  assert.deepEqual(searches.sort(), ['Best e-bikes under $1500 in 2026?', 'Do solar tiles work on a flat roof?'], 'the search engine saw the writer\'s one question per research to-do');
  assert.ok(seen.some((s) => s.path === '/api/chat' && s.body.messages[0].content.startsWith(QUESTION_PROMPT) && s.body.messages[0].content.includes('A wet week on the roof')), 'the question step saw the summary\'s context');
  for (const s of seen.filter((x) => x.path !== '/api/chat')) { const body = JSON.stringify(s.body); assert.equal(body.includes('wet week'), false, 'the summary body never leaves: ' + s.path); assert.equal(body.includes('Reflections'), false, s.path); }
  const bad = await api(port, '/api/summary-followup', { method: 'POST', body: JSON.stringify({ text: '   ' }) });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).code, 'missing_fields');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/summary-followup`, { method: 'POST', body: '{"text":"x"}' })).status, 401, 'no bearer');
});
