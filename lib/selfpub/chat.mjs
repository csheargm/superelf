// 改 superelf 在主聊天里 · The core-change lane wired into the owner's main chat (docs/adr/0044, phase 2).
// web.mjs chatTurn calls in here for the OWNER's composer turns only (never an app, a member, a guest or
// the demo; runCoreChange checks again on the server). Three ways in:
//   1. typed "改 superelf：…" / "change superelf: …" → the core lane at once;
//   2. the main agent answered with the one marker line (MAIN_CHAT_RULE) → the core lane with its request;
//   3. a typed 发布 / publish while this conversation has a change ready → open its publish preview
//      (the same sheet the 发布 · Publish button opens; nothing leaves before the sheet's own Publish).
// The reply's first lines are the server's template (lib/selfpub/verify.mjs), then the model's summary.
import { runCoreChange } from './lane.mjs';
import { pendingFor } from './state.mjs';
import { TYPED_PUBLISH_RE, selfpubRoot, shotsDir } from './routes.mjs';
import { makeRenderer } from './render.mjs';

export const CORE_PREFIX_RE = /^\s*(?:改\s*superelf|change\s+superelf)\s*[:：]\s*([\s\S]+)$/i;
export const MARKER = 'PA_CHANGE_SUPERELF:';
const MARKER_RE = /^\s*PA_CHANGE_SUPERELF:[ \t]*([^\n]+?)\s*$/;   // the WHOLE reply, one line: a quoted marker inside other text never runs (GPT review)
export const MAX_REQUEST = 1000;

// The owner composer's agent is told this (lib/agent-origin.mjs ownerCoreRule): it never edits the
// served code (read-only on the node, and denied in its args); it hands the request to the core lane.
export const MAIN_CHAT_RULE = [
  '改 superelf 本身 · Changing superelf itself: if the owner asks to change superelf ITSELF (its Home, menus,',
  'chat, settings, look or behaviour — not one of their apps and not their data), do not edit any file and do',
  `not describe a fix. Answer with exactly one line: ${MARKER} <the request in the owner's words>.`,
  'The server then makes the change in its own checkout, checks it and offers 发布 · Publish.',
].join('\n');

export const coreRequestOf = (message) => { const m = CORE_PREFIX_RE.exec(String(message || '')); return m ? m[1].trim().slice(0, MAX_REQUEST) : ''; };
export const markerRequest = (reply) => { const m = MARKER_RE.exec(String(reply || '')); return m ? m[1].trim().slice(0, MAX_REQUEST) : ''; };

// The owner's composer, not an edit turn, not the demo: the only place any of this applies.
export const ownerComposer = ({ user, origin, edit, demo }) => !demo && !edit && !!user && user.role === 'owner' && !origin.fromApp;

// Anyone else typing "改 superelf：…" (a member, a guest, the demo) gets this plainly; no model runs.
export const OWNER_ONLY_TEXT = '只有节点主人可以修改 superelf 本身 · Only the node\'s owner can change superelf itself';
export const refuseCore = ({ origin, edit, message }) => (!origin.fromApp && !edit && coreRequestOf(message) ? { ok: false, text: OWNER_ONLY_TEXT } : null);

const OPEN_TEXT = '打开发布预览：看过改动的文件后，在预览里点 发布 · Publish。现在还没有发送任何东西 · Opening the publish preview: check the files, then tap 发布 · Publish in it. Nothing has been sent yet.';

// A typed 发布 / publish: the newest ready change of THIS conversation, or null (then the turn is an ordinary one).
export function typedPublish({ cfg, user, convoId, message }) {
  if (!TYPED_PUBLISH_RE.test(String(message || ''))) return null;
  const c = pendingFor(selfpubRoot(cfg), { who: user.id, convo: convoId || '' });
  return c ? { text: OPEN_TEXT, selfpub: { id: c.id, ready: true, open: true } } : null;
}

// Runs the core lane and returns what the conversation stores: { ok, text, selfpub }. line() streams
// status lines; the 'selfpub' event (id, ready, shots) is what puts 发布 · Publish under the reply.
export async function coreChatTurn({ user, origin, demo, request, convoId, cfg, runAgent, render, cloneUrl, line }) {
  line({ type: 'status', text: '正在修改 superelf 的代码副本（不是正在运行的节点） · Changing superelf in its own checkout (not the running node)', keep: true });
  try {
    const r = await runCoreChange({ user, origin, demo, message: request, convo: convoId, cfg, root: selfpubRoot(cfg), cloneUrl, runAgent, render });
    const text = [r.headline, r.reply ? `\n${r.reply.trim()}` : ''].filter(Boolean).join('\n');
    const selfpub = r.id ? { id: r.id, ready: !!r.ready, shots: (r.shots || []).length } : null;
    if (selfpub) line({ type: 'selfpub', ...selfpub });
    return { ok: true, text, selfpub };
  } catch (e) {
    if (!e || (!e.code && !e.status)) throw e;
    return { ok: false, text: `未改动 superelf · superelf was not changed: ${String(e.message || e)}` };
  }
}

// web.mjs hands in its runner and queue; the agent is the jailed Claude CLI in the checkout. Every tool
// call it made is handed back, even a denied one, so lib/selfpub/lane.mjs can check where it reached.
export function coreDeps({ cfg, enqueue, runClaude, demo, user, origin, request, convoId, line }) {
  const runAgent = async ({ cwd, args, prompt, message }) => {
    const toolCalls = [];
    const r = await enqueue(() => runClaude({ claudeCmd: cfg.claude_cmd, extraArgs: args, cwd, prompt: message, systemPrompt: prompt, timeoutMs: cfg.task_timeout_minutes * 60000,
      onTool: (n, b, input) => { toolCalls.push({ name: n, input }); line({ type: 'status', text: `${n}${b ? ` — ${b}` : ''}` }); } }));
    if (!r.ok) throw Object.assign(new Error(String(r.text || '').slice(0, 300) || 'agent failed'), { code: 'AGENT_FAILED' });
    return { reply: r.text || '', toolCalls };
  };
  return { user, origin, demo, request, convoId, cfg, runAgent, line, cloneUrl: cfg.selfpub_clone_url || undefined,
    render: makeRenderer({ shotsDir: shotsDir(selfpubRoot(cfg)) }) };
}

// A core-lane turn's answer, stored with its change id so 发布 · Publish is under it again on reopen.
// A typed publish's 'open' is a one-time event, never stored (a reopen must not pop the sheet).
export function endCore({ convo, sp, startedAt, line, res, save }) {
  const keep = sp.selfpub && !sp.selfpub.open ? { id: sp.selfpub.id, ready: sp.selfpub.ready, shots: sp.selfpub.shots || 0 } : null;
  convo.messages.push({ role: 'md', text: sp.text, ...(sp.ok === false ? {} : { ms: Date.now() - startedAt }), by: 'superelf', ...(keep ? { selfpub: keep } : {}) });
  convo.updated = Date.now(); save();
  if (sp.selfpub && sp.selfpub.open) line({ type: 'selfpub', ...sp.selfpub });
  line({ type: 'done', ok: sp.ok !== false, text: sp.text, by: 'superelf' });
  res.end();
}
