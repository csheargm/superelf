// 夜间审查的 superelf 修复 · The nightly review's superelf fix (docs/adr/0046) through the core lane
// (lib/selfpub, ADR 0044) and NOTHING else: the jailed agent edits the checkout, the server checks it,
// and the change waits for the owner's tap. It is saved as an ordinary owner conversation, so its
// 发布 · Publish button is under the reply exactly as if the owner had typed "改 superelf：…".
import { getChange } from '../selfpub/state.mjs';
import { liveStatus } from '../selfpub/run.mjs';

// deps: { owner, runTurn(request, convoId) → { ok, text, selfpub }, saveConvo(owner, convo), newId(), now() }
export async function startSelfpubFix({ request, title }, { owner, runTurn, saveConvo, newId, now = Date.now }) {
  if (!owner) throw new Error('no node owner');
  const convo = { id: newId(), title, sessionId: null, messages: [{ role: 'me', text: request }], updated: now() };
  saveConvo(owner, convo);
  const sp = await runTurn(request, convo.id);
  const keep = sp.selfpub ? { id: sp.selfpub.id, ready: !!sp.selfpub.ready, shots: sp.selfpub.shots || 0 } : null;
  convo.messages.push({ role: 'md', text: sp.text, by: 'superelf', ...(keep ? { selfpub: keep } : {}) });
  convo.updated = now();
  saveConvo(owner, convo);
  const head = String(sp.text || '').split('\n')[0].slice(0, 200);
  if (!keep) return { id: null, state: 'not-started', text: `not started: ${head}` };
  return { id: keep.id, state: keep.ready ? 'ready' : 'checks-failed', title, text: keep.ready
    ? `Ready to publish. Open the chat "${title}" in superelf and tap 发布 · Publish (nothing is published until you do).`
    : `Checks failed: ${head}. The chat "${title}" holds the change.` };
}

// A fix from an earlier night, in one line. final: it will not change any more (stop reporting it).
export function selfpubFixStatus(sroot, id, version) {
  const c = getChange(sroot, id);
  if (!c) return { text: `change ${id} is gone`, final: true };
  const p = liveStatus(sroot, id, version) || {};
  if (p.state === 'live') return { text: `Live ${p.version}`, final: true, live: true };
  if (c.state === 'discarded' || c.state === 'superseded') return { text: `change ${id} ${c.state}`, final: true };
  if (p.state) return { text: `publish ${p.state}${p.version ? ` ${p.version}` : ''}${p.error ? ` (${p.error})` : ''}`, final: false };
  return { text: c.state === 'ready' ? 'still waiting for your Publish tap' : `change ${c.state}`, final: false, waiting: c.state === 'ready' };
}
