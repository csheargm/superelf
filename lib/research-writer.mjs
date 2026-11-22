// Research writer（研究撰写）— which model writes a summary follow-up (docs/plans/note-features.md I, ADR 0027
// addendum 2026-11-12). Owner decision 2026-11-11: summaries run on the Claude/GPT lane, not the fast lane;
// the follow-up's research synthesis, its search-question step and its one-line suggestions follow.
//
// cfg.research.writer (read at use time, never cached): 'claude' (default) | 'codex' | a chat_models id.
//   'claude'  → Claude, then Codex, then the fast lane (cfg.research.llm), each on a failure of the one before
//   'codex'   → Codex, then the fast lane
//   an id     → that chat_models lane only (an ollama id rides streamOllama; 'claude'/'codex' providers as above)
// A failed or EMPTY answer moves to the next lane (R14: empty output is failure); the lane that answered
// is recorded in `fallbacks` only when it was not the first, so the client's status line says so.
//
// The Claude lane runs with NO tools (NO_TOOLS_ARGS, lib/one-shot.mjs): its prompt carries scraped web
// text, which must not be able to drive a tool. The caller (web.mjs) builds that argv.
import { NO_TOOLS_ARGS, oneShotBaseArgs } from './one-shot.mjs';

export const WRITER_DEFAULT = 'claude';
export const WRITER_CLAUDE = 'claude', WRITER_CODEX = 'codex', WRITER_OLLAMA = 'ollama';
const LABEL = Object.freeze({ claude: 'Claude', codex: 'Codex' });

// The Claude writer's argv base: the one-shot args (thinking off) and no tools — the model-review grader's
// precedent (lib/model-review-grade.mjs graderArgs); `memberArgs` = web.mjs memberArgsOf (a member's
// --settings wins over the one-shot default, lib/one-shot.mjs). web.mjs wraps it in the user's lane args.
// One writer call may use at most 1/WRITER_LANE_SHARE of the item deadline (review 2026-11-12): a HUNG Claude call
// used to spend the whole item budget, so the item timed out before Codex or the fast lane could answer.
// Three shares = the Claude try, one fallback, and the question step, all inside the item deadline.
export const WRITER_LANE_SHARE = 3;
export const writerLaneMs = (itemMs) => (Number(itemMs) > 0 ? Math.floor(Number(itemMs) / WRITER_LANE_SHARE) : undefined);
export const writerClaudeBase = (cfg, memberArgs = []) => [...oneShotBaseArgs(cfg.claude_args || [], cfg.one_shot_args || [], memberArgs), ...NO_TOOLS_ARGS];

// The ordered lanes for this cfg. Throws on an unknown writer (said on the item's line, never guessed).
export function writerChain(cfg) {
  const ms = Array.isArray(cfg.chat_models) ? cfg.chat_models : [];
  const rc = cfg.research || {};
  const want = String(rc.writer || WRITER_DEFAULT);
  const step = (m) => (m.provider === 'ollama' ? { kind: WRITER_OLLAMA, label: m.label || m.id, model: m.model }
    : { kind: m.provider, label: LABEL[m.provider] || m.label || m.id, model: m.model || null });
  const codex = ms.find((m) => m.provider === WRITER_CODEX);
  const fast = ms.find((m) => m.id === rc.llm && m.provider === 'ollama');
  const tail = (kind) => [...(kind === WRITER_CLAUDE && codex ? [step(codex)] : []), ...(fast ? [step(fast)] : [])];
  if (want === WRITER_CLAUDE) return [{ kind: WRITER_CLAUDE, label: LABEL.claude, model: null }, ...tail(WRITER_CLAUDE)];
  if (want === WRITER_CODEX) return codex ? [step(codex), ...tail(WRITER_CODEX)] : tail(WRITER_CODEX);
  const m = ms.find((x) => x.id === want);
  if (!m || ![WRITER_CLAUDE, WRITER_CODEX, WRITER_OLLAMA].includes(m.provider)) throw new Error(`research.writer: unknown lane "${want}" · 未知的撰写通道`);
  return m.provider === WRITER_OLLAMA ? [step(m)] : writerChain({ ...cfg, research: { ...rc, writer: m.provider } });
}

// write(prompt) → the first non-empty answer down the chain. `agents.claude(prompt)` / `agents.codex(prompt, model)`
// → {ok,text}; the ollama lanes ride streamOllama. Every lane failing throws ONE error naming each (R5).
export function makeWriter({ cfg, agents = {}, streamOllama, fallbacks = new Set() }) {
  const runStep = async (s, prompt) => {
    if (s.kind === WRITER_OLLAMA) return { ok: true, text: await streamOllama({ url: cfg.ollama_url, model: s.model, messages: [{ role: 'user', content: prompt }], onDelta: () => {} }) };
    const fn = agents[s.kind];
    if (typeof fn !== 'function') return { ok: false, text: 'not available on this node · 本节点不可用' };
    return fn(prompt, s.model);
  };
  return async function write(prompt) {
    const chain = writerChain(cfg), errs = [];
    if (!chain.length) throw new Error('no writer lane configured · 未配置撰写通道');
    for (const [i, s] of chain.entries()) {
      let r;
      try { r = await runStep(s, prompt); } catch (e) { r = { ok: false, text: String((e && e.message) || e) }; }   // R5: named in errs, the next lane tried
      const text = String((r && r.text) || '').trim();
      if (r && r.ok && text) { if (i > 0) fallbacks.add(s.label); return text; }
      errs.push(s.label + ': ' + (text ? text.slice(0, 80) : 'no answer'));
    }
    throw new Error(errs.join('; '));
  };
}
