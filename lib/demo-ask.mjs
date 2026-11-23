// An app's one-shot AI question on the demo · 演示中应用的一次性 AI 提问
// The shell broker's 'ask' kind posts /api/ask; on an owner node that runs the agent (web.mjs). A
// demo has no agent, so the same request is answered by the demo's Ollama lane, under the same
// sign-in gate, per-visitor lock and daily AI caps as a chat turn, and may web-search the same way
// (lib/demo-search-turn.mjs). Nothing is saved: an ask has no conversation (ADR 0019).
// Answers 200 {ok, text} like web.mjs, so apps read it the same on both.
import { consumeAiCall, demoLimit } from './demo-quota.mjs';
import { REPLY_LANGUAGE_RULE } from './config.mjs';
import { turnErrorText } from './chat-outcome.mjs';
import { SEARCH_RULE } from './demo-search.mjs';
import { searchTurn } from './demo-search-turn.mjs';

export const DEMO_ASK_PATH = '/api/ask';

// x: { d, json, ipOf, pickLane, disk, callModel, noLane } from lib/demo-routes.mjs (its lock wraps this).
export function makeDemoAsk(x) {
  return async function ask(req, res, user) {
    const b = (await x.d.readBody(req, x.d.BODY_LIMITS.chat)) || {};
    if (typeof b.message !== 'string' || !b.message.trim()) return x.json(res, 400, { error: 'empty message' });
    const lane = x.pickLane();
    if (!lane) return x.json(res, 503, { ok: false, code: 'demo_no_lane', error: x.noLane });
    const full = x.disk(user);
    if (!full.ok) return x.json(res, full.status, full);
    const q = consumeAiCall({ cfg: x.d.cfg, store: x.d.store, userId: user.id, ip: x.ipOf(req) });
    if (!q.ok) return x.json(res, q.status, q);
    const kb = demoLimit(x.d.cfg, 'reply_max_kb');
    const history = [REPLY_LANGUAGE_RULE, SEARCH_RULE].map((c) => ({ role: 'system', content: c })).concat([{ role: 'user', content: b.message }]);
    const ac = new AbortController(); res.on('close', () => ac.abort());
    try {
      const first = await x.callModel(res, lane, history, null, kb);
      const s = await searchTurn({ d: x.d, user, text: first, history, line: () => {}, ip: x.ipOf(req), signal: ac.signal,
        answer: (msgs) => x.callModel(res, lane, msgs, null, kb) });
      x.json(res, 200, { ok: true, text: s.text });
    } catch (e) {
      x.json(res, 200, { ok: false, text: `⚠ ${turnErrorText(lane, e).slice(0, 300)}` });   // web.mjs answers a failed ask the same way
    }
  };
}
