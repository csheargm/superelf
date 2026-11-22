// What a chat turn's answer IS, before web.mjs stores it — and the one log line per turn.
//
// SCAR (2026-11-12, Bible Ask AI, live): Explain turns were stored as { role:'md', text:'' } and
// the app painted "No response — try rephrasing." The node log held nothing about the turn, so
// which lane answered (DeepSeek, the first chat_models entry, measured 0.5-1 s on the same
// prompt) had to be inferred from durations. Two rules, each in ONE place (R3):
//   1. A blank answer is a FAILURE of a named lane, never a reply (R5/R14: empty is not a pass).
//   2. Every turn logs lane, model, ok, length, duration and an error code — never content.

export const EMPTY_ANSWER_WHY = 'it returned an empty answer · 返回了空回答';

// Blank = nothing a person could read. A cancelled turn is not judged here (it has its own text).
export function isBlankAnswer(r) { return !r || typeof r.text !== 'string' || !r.text.trim(); }

// The name a person sees for the lane that ran: its chooser label, else Claude (the agent lane).
export function laneName(lane) { return lane && lane.label ? String(lane.label) : 'Claude'; }

// The stored and shown sentence for a lane that answered nothing. `why` is the lane's own reason
// when it gave one (a failed run), else EMPTY_ANSWER_WHY.
export function laneFailureText(lane, why, ms) {
  const secs = Number.isFinite(ms) ? ` after ${(ms / 1000).toFixed(1)} s` : '';
  return `${laneName(lane)} gave no answer${secs}: ${why || EMPTY_ANSWER_WHY}. Ask again, or pick another model · 请重试或换一个模型`;
}

// An app's turn that a FAST lane (Ollama, no tools) left blank gets ONE retry on the Claude agent
// lane. Only from a fast lane: an agent lane that answered nothing would answer nothing again.
export function shouldFallBackToAgent({ lane, fromApp, alreadyFellBack }) {
  return !!fromApp && !alreadyFellBack && !!lane && lane.provider === 'ollama';
}

export function fallbackStatusText(lane) {
  return `${laneName(lane)} returned an empty answer — asking Claude instead · ${laneName(lane)} 无回答，改用 Claude`;
}

// ONE line per turn for the node log. Fields are ids and numbers only: no message, no answer, no
// prompt, no token — the log is read by people the conversation does not belong to.
export function chatTurnLogLine({ app, lane, ok, textLen, ms, code, fellBack }) {
  const id = lane ? lane.id : 'claude';
  const model = lane && lane.model ? lane.model : 'default';
  const safe = (v) => String(v == null ? '-' : v).replace(/[^\w.:\-/]/g, '_').slice(0, 64);
  return `[chat] app=${safe(app || 'composer')} lane=${safe(id)} model=${safe(model)} ok=${ok ? 1 : 0} len=${Number(textLen) || 0} ms=${Number(ms) || 0} code=${safe(code || '-')}${fellBack ? ' fallback=1' : ''}`;
}
