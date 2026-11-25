// Stop a running chat turn · 停止正在运行的回答 (F4-3)
//
// One handle per turn: { signal, onChild, stop }. stop() aborts the signal and kills the turn's
// child process (the agent CLI) if one is running; a turn still queued never spawns (chat() checks
// `signal`). Two ways to fire it:
//   * cancelOnClose — a oneShot caller (PAChat.complete) that leaves: the connection close is the cancel;
//   * the registry  — the shell's composer Stop button: POST /api/chat/stop names (user, conversation).
// A CONVERSATION turn is never stopped by a dropped connection: the composer's pollForResult relies
// on the server finishing a turn whose stream dropped (iOS Safari drops idle streams). Only an
// explicit Stop ends one.
import { killChild } from './runner.mjs';

export function createTurnCancel() {
  const ac = new AbortController();
  let child = null;
  ac.signal.addEventListener('abort', () => { if (child) killChild(child); }, { once: true });
  // Forgotten once it exits, so a late cancel never signals a pid the OS may have reused.
  const onChild = (c) => { child = c; c.once('close', () => { if (child === c) child = null; }); if (ac.signal.aborted) killChild(c); };
  return { signal: ac.signal, onChild, stop: () => ac.abort() };
}

export function cancelOnClose(res) {
  const c = createTurnCancel();
  res.on('close', () => { if (!res.writableEnded) c.stop(); });
  return c;
}

// (user, conversation) → the running turn's handle. Keyed by user, so nobody can stop another's turn.
export function createTurnStops() {
  const running = new Map();
  const key = (userId, convoId) => `${userId}\0${convoId}`;
  // register → unregister(). Unregistering only removes THIS handle (a newer turn may have replaced it).
  function register(userId, convoId, cancel) {
    const k = key(userId, convoId);
    running.set(k, cancel);
    return () => { if (running.get(k) === cancel) running.delete(k); };
  }
  // true when a running turn was stopped; false when nothing by that id runs (idempotent, not a failure).
  function stop(userId, convoId) {
    const c = running.get(key(userId, convoId));
    if (!c) return false;
    running.delete(key(userId, convoId));
    c.stop();
    return true;
  }
  return { register, stop, size: () => running.size };
}

// What a stopped turn answers and stores (R3: web.mjs CHAT_CANCELLED and the app-edit lane share it; == PAC_CANCELLED in web/chat-ui.inline.html).
export const CANCELLED_TEXT = '已取消 · Cancelled';
