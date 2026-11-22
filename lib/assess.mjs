// lib/assess.mjs — Multi-LLM assessment ("Verify · 校验"): fan the user's question out to
// a panel of models, then have a fast summarizer compare the answers (consensus 共识 vs
// discrepancies 分歧). Design: docs/design/multi-llm-assessment.md. The lanes
// (streamOllama / runClaude / runCodex / enqueue) are INJECTED so tests can drive the
// orchestration with fakes that replicate the real failure shapes (runClaude RESOLVES
// ok:false on timeout, streamOllama THROWS). R14 is the heart of this module: a model
// that errors, times out, or returns empty text is ok:false, excluded from the
// summarizer's inputs, and NAMED as absent; fewer than two responders is an explicit
// "inconclusive", never invented consensus; a failed summarizer is an explicit error.

// CONFINEMENT (2026-10-11). The panel's Claude calls used to take cfg.claude_args RAW — the
// owner's --dangerously-skip-permissions — for EVERY account, so ticking Verify in an app or as a
// member ran the panel unconfined. Lanes now carry the caller's resolver: `lanes.agentArgs(base)`
// (web.mjs agentArgs, bound to the user and the request's origin) and `lanes.codexAllowed`
// (false for a confined turn — Codex's read-only sandbox still reads outside the workspace, see
// web.mjs PA_CHAT_LANE). Both fail CLOSED: no resolver → no Claude call, not a raw one.
const NO_RESOLVER = 'no agent-lane resolver injected · 未注入智能体通道解析器';
const CODEX_CONFINED = 'GPT (Codex) is not run for this request: it can read outside the workspace · 此请求不运行 GPT（可读取工作区外的文件）';
const resolveArgs = (lanes, base) => (typeof lanes.agentArgs === 'function' ? lanes.agentArgs(base) : null);

export const ANSWER_CAP = 8000;      // ~8KB per stored panel answer — auditable, convo file stays small
const AGENT_GRACE_MS = 15000;        // agent lanes self-kill at timeoutMs; the outer race only catches a wedged lane
const TIMEOUT = Symbol('assess-timeout');

// Race a lane against a deadline. The timer is CLEARED when the lane settles (a lost
// timer must not hold the process for up to 30 min per call); if the deadline wins, the
// caller gets TIMEOUT and the lane is left to self-terminate (agents kill their child at
// their own timeoutMs). Rejections pass through so callers' try/catch sees real errors.
const withTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => res(TIMEOUT), ms);
  Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

// Panel = cfg.assess_models minus the model that just answered the fast lane (its answer
// is already on screen; running it again would double-count one opinion). Skips are
// recorded so the participation line can NAME them — never silently dropped (R14).
export function pickPanel(cfg, fastModelId) {
  const byId = new Map((cfg.chat_models || []).map((m) => [m.id, m]));
  const panel = [], skipped = [];
  for (const id of cfg.assess_models || []) {
    const m = byId.get(id);
    if (!m) continue;                // ids are validated at config load; defensive only
    if (id === fastModelId) skipped.push({ id: m.id, label: m.label });
    else panel.push(m);
  }
  return { panel, skipped };
}

// `prompts` arrive already capped (web.mjs resolveSystemPrompts, OVERRIDABLE_PROMPT_MAX), so no
// function here cuts them again — a second cap is a second number that can drift (R3).
// The panel sees the SAME recent history slice the fast lane got — but NEVER the fast
// lane's own answer (R14: the treatment must not leak into the independent panel).
// The caller passes convoMessages already ending at the user's question.
export function ollamaMessages(prompts, convoMessages) {
  const sys = [prompts.global, prompts.app]
    .filter(Boolean).map((c) => ({ role: 'system', content: c }));
  return [...sys, ...convoMessages
    .map((m) => ({ role: m.role === 'md' ? 'assistant' : 'user', content: String(m.text || '') }))
    .filter((m) => m.content)];
}

// One-shot agent prompt (stateless — no resume id): the app's directive + a plain
// transcript of the same history slice + the question, so an app's language rule holds.
export function agentPrompt(prompts, convoMessages, question) {
  const past = convoMessages.slice(0, -1).filter((m) => String(m.text || '').trim())
    .map((m) => (m.role === 'md' ? 'Assistant' : 'User') + ': ' + String(m.text).trim()).join('\n\n');
  return [prompts.app ? 'Directive for your reply: ' + prompts.app : null,
    past ? 'Conversation so far:\n\n' + past : null,
    'Answer this question:\n\n' + question].filter(Boolean).join('\n\n---\n\n');
}

// Ask ONE panel model, one-shot, under a hard timeout. Never throws; always settles to a
// verdict { id, label, ok, ms, text? | error? }. Empty/whitespace output is ok:false —
// empty output is failure, not agreement (R14).
export async function callPanelModel({ m, cfg, lanes, prompts, convoMessages, question, cwd, timeoutMs, now = Date.now }) {
  const t0 = now();
  const v = (ok, text, error) => ({ id: m.id, label: m.label, ok, ms: now() - t0, ...(ok ? { text } : { error }) });
  try {
    let r;
    if (m.provider === 'ollama') {
      const text = await withTimeout(lanes.streamOllama({
        url: cfg.ollama_url, model: m.model, messages: ollamaMessages(prompts, convoMessages), onDelta: () => {} }), timeoutMs);
      r = text === TIMEOUT ? TIMEOUT : { ok: true, text };
    } else if (m.provider === 'codex') {
      if (lanes.codexAllowed !== true) return v(false, null, CODEX_CONFINED);
      r = await withTimeout(lanes.enqueue(() => lanes.runCodex({
        prompt: agentPrompt(prompts, convoMessages, question), cwd, model: m.model || undefined, timeoutMs })), timeoutMs + AGENT_GRACE_MS);
    } else {
      const extraArgs = resolveArgs(lanes, m.model ? [...cfg.claude_args, '--model', m.model] : cfg.claude_args);
      if (!extraArgs) return v(false, null, NO_RESOLVER);
      r = await withTimeout(lanes.enqueue(() => lanes.runClaude({
        claudeCmd: cfg.claude_cmd, extraArgs, cwd, prompt: agentPrompt(prompts, convoMessages, question),
        timeoutMs })), timeoutMs + AGENT_GRACE_MS);
    }
    if (r === TIMEOUT) return v(false, null, 'timeout after ' + Math.round(timeoutMs / 60000) + ' min');
    if (!r || r.ok === false) return v(false, null, String((r && r.text) || 'model call failed').slice(0, 300));
    if (!String(r.text || '').trim()) return v(false, null, 'empty response');
    return v(true, String(r.text));
  } catch (e) {
    // R5: not swallowed — converted to an ok:false verdict that IS surfaced (the model is
    // named as absent in the persisted status and in the summary's participation line).
    return v(false, null, String((e && e.message) || e).slice(0, 300));
  }
}

// The summarizer sees ONLY responders' capped answers and an explicit absentee list —
// never a timed-out model's partial output (R14).
export function buildSummaryPrompt({ sysPrompt, question, results, answers, skipped, appDirective }) {
  const absent = results.filter((r) => !r.ok);
  let s = sysPrompt + '\n\n## Question\n\n' + question + '\n';
  for (const r of results) if (r.ok) s += '\n## Answer from ' + r.label + '\n\n' + (answers[r.id] || '') + '\n';
  s += '\n## Models that failed to respond\n\n' +
    (absent.length ? absent.map((r) => '- ' + r.label + ': ' + (r.error || 'failed')).join('\n') : '(none — all panel models responded)') + '\n';
  if (skipped.length) s += '\n## Skipped (already the user\'s current chat model; its answer is shown separately)\n\n' +
    skipped.map((x) => '- ' + x.label).join('\n') + '\n';
  if (appDirective) s += '\n## Language/style directive for your summary\n\n' + appDirective + '\n';
  return s;
}

// Deterministic (no model call): with fewer than two responders there is nothing to
// cross-check — say so explicitly instead of inventing consensus (R14).
export function inconclusiveSummary(results, skipped) {
  const ok = results.filter((r) => r.ok), absent = results.filter((r) => !r.ok);
  const failed = absent.map((r) => r.label + ' (' + (r.error || 'failed') + ')').join(', ');
  return '**Cross-check inconclusive · 校验无法定论** — only ' + ok.length + ' of ' + results.length +
    ' panel models responded 仅 ' + ok.length + '/' + results.length + ' 个模型响应 (need at least two 需至少两个). ' +
    'Responded 已响应: ' + (ok.length ? ok.map((r) => r.label).join(', ') : 'none 无') + '. ' +
    'Failed 未响应: ' + (failed || 'none 无') + '.' +
    (skipped.length ? ' Skipped (current model) 跳过（当前模型）: ' + skipped.map((x) => x.label).join(', ') + '.' : '') +
    ' A single answer cannot be cross-checked — treat it as unverified. 单一回答无法交叉验证，请视为未经核实。';
}

// One summarizer call on the FAST tier: runClaude pins models via the CLI's --model flag
// (the cfg.fast_args precedent), so cfg.assess_summarizer ('haiku') rides the same flag.
async function summarize({ cfg, lanes, cwd, question, results, answers, skipped, appDirective, timeoutMs }) {
  const prompt = buildSummaryPrompt({ sysPrompt: cfg.system_prompts.assess, question, results, answers, skipped, appDirective });
  const extraArgs = resolveArgs(lanes, [...cfg.claude_args, '--model', cfg.assess_summarizer]);
  if (!extraArgs) return { ok: false, error: NO_RESOLVER };
  try {
    const r = await withTimeout(lanes.enqueue(() => lanes.runClaude({
      claudeCmd: cfg.claude_cmd, extraArgs,
      cwd, prompt, timeoutMs })), timeoutMs + AGENT_GRACE_MS);
    if (r === TIMEOUT) return { ok: false, error: 'timeout' };
    if (!r || r.ok === false) return { ok: false, error: String((r && r.text) || 'summarizer call failed').slice(0, 300) };
    if (!String(r.text || '').trim()) return { ok: false, error: 'empty summarizer output' }; // vacuous success guard (R14)
    return { ok: true, text: String(r.text) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 300) }; // R5: becomes state:'error' upstream — explicit in the deep view, never blank
  }
}

// Fire-and-forget orchestration (the caller does NOT await it). `persist` re-attaches the
// FULL assess object to the convo turn each time — once as pending, once terminal (the UI
// shows a plain "Verifying · 校验中" chip, so no per-settle progress writes are needed).
// Persisted shape: { state, started, updated, timeoutMinutes, models:[{id,label,ok,ms,error?}],
// skipped:[{id,label}], answers:{id:cappedText}, summary?, error? }.
export async function runAssessment({ cfg, question, convoMessages, prompts, fastModelId, cwd, lanes, persist, now = Date.now }) {
  const { panel, skipped } = pickPanel(cfg, fastModelId);
  const base = { state: 'pending', started: now(), updated: now(), timeoutMinutes: cfg.assess_timeout_minutes,
    models: panel.map((m) => ({ id: m.id, label: m.label })), skipped };
  try {
    if (!panel.length) return void await persist({ ...base, state: 'error', error: 'no panel models to run (all skipped or unconfigured) · 无可用校验模型' });
    await persist(base);
    const timeoutMs = cfg.assess_timeout_minutes * 60000;
    const results = await Promise.all(panel.map((m) => callPanelModel({ m, cfg, lanes, prompts, convoMessages, question, cwd, timeoutMs, now })));
    const answers = {};
    for (const r of results) if (r.ok) answers[r.id] = r.text.slice(0, ANSWER_CAP);
    const fin = { ...base, updated: now(), answers,
      models: results.map(({ id, label, ok, ms, error }) => (error === undefined ? { id, label, ok, ms } : { id, label, ok, ms, error })) };
    const okCount = results.filter((r) => r.ok).length;
    if (okCount === 0) return void await persist({ ...fin, state: 'error', error: 'no panel model responded · 无校验模型响应' });
    if (okCount < 2) return void await persist({ ...fin, state: 'done', summary: inconclusiveSummary(results, skipped) });
    const sum = await summarize({ cfg, lanes, cwd, question, results, answers, skipped, appDirective: prompts.app, timeoutMs });
    if (!sum.ok) return void await persist({ ...fin, updated: now(), state: 'error', error: 'summarizer failed · 汇总失败 — ' + sum.error });
    await persist({ ...fin, updated: now(), state: 'done', summary: sum.text });
  } catch (e) {
    // R5/R14: the orchestrator's own crash must still reach a terminal, user-visible state.
    try { await persist({ ...base, updated: now(), state: 'error', error: String((e && e.message) || e).slice(0, 300) }); }
    catch (e2) { console.error('[assess] persist failed after crash:', e2); } // last resort: persistence itself broke — nothing is left to attach an error to; the client's poll deadline surfaces the absence
  }
}
