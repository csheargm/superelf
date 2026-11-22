// The GPT (Codex) chat lane, in ONE place (R3): the chooser's Codex lane and the fallback a
// Claude turn takes when the node's Claude sign-in has expired (docs/adr/0024) run through the
// same function, so session resume, the retry on a dead session and the status line match.
// runCodex itself (lib/codex.mjs) is the spawn; this is the conversation's use of it.
import { CLAUDE_SIGNIN_EXPIRED, CODEX_FALLBACK_PREFIX } from './claude-auth.mjs';

export const CODEX_WORKING_STATUS = 'GPT (Codex) is working…';
export const CODEX_ALSO_FAILED = 'Codex failed too · Codex 也失败了';

// One Codex turn on `convo`: resumes convo.codexSessionId when there is one, starts fresh when that
// session is gone, and stores the session id for the next turn. Non-streaming: a status line while
// it works, then the final text. `images` are the attachment paths (-i); `prompt` is the text.
export async function runCodexLane({ convo, prompt, images = [], cwd, model, timeoutMs, runCodex, enqueue, onStatus }) {
  onStatus?.(CODEX_WORKING_STATUS);
  const runIt = (rid) => runCodex({ prompt, images, cwd, model: model || undefined, resumeId: rid, timeoutMs });
  const r = await enqueue(async () => {
    let x = await runIt(convo.codexSessionId || null);
    if (!x.ok && convo.codexSessionId) x = await runIt(null);   // session gone → fresh
    return x;
  });
  if (r.sessionId) convo.codexSessionId = r.sessionId;
  return r;
}

// The fallback for a Claude turn that failed to authenticate: the SAME prompt through the
// configured Codex lane, the reply prefixed so the user knows who answered and why. No Codex lane
// in chat_models → the sign-in line alone. Codex failing too → both errors. The result carries NO
// sessionId: the caller stores a Claude session id from its lane's result, and Codex's belongs in
// convo.codexSessionId, which runCodexLane already set.
export async function codexFallback({ chatModels, claudeError, ...lane }) {
  const codex = (chatModels || []).find((m) => m && m.provider === 'codex');
  if (!codex) return { ok: false, text: `${CLAUDE_SIGNIN_EXPIRED}\n\n${claudeError || ''}`.trim() };
  const r = await runCodexLane({ ...lane, model: codex.model });
  if (!r.ok) return { ok: false, text: `${CLAUDE_SIGNIN_EXPIRED}\n\n${CODEX_ALSO_FAILED}: ${r.text || ''}\n\nClaude: ${claudeError || ''}`.trim() };
  return { ok: true, text: `${CODEX_FALLBACK_PREFIX}\n\n${r.text}` };
}
