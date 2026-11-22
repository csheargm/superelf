// One turn at a time per conversation · 同一对话按顺序执行
//
// THE BUG (measured 2026-11-13, scenario A of the back-to-back report): a follow-up sent into a
// conversation whose turn was still running started its own `claude -p` AT ONCE. It had no
// session to resume (the id is saved only when a run finishes), each turn kept its own copy of
// the conversation, and the last to finish saved over the other — the follow-up's message and
// reply vanished and the first run overwrote the app the follow-up had just fixed.
//
// So chat() takes this lock per (user, conversation) BEFORE it reads the conversation: a second
// turn waits for the first, then loads the fresh state (both messages, the newest sessionId).
// Different conversations hold different keys and still run in parallel. The lock is a promise
// chain, so it is released by the holder's finally — an error or a cancel never deadlocks it.

export const QUEUED_TURN_TEXT = 'Queued after the running turn · 排队等待上一轮';

export function createConvoLocks() {
  const tails = new Map();   // key → promise that settles when the last queued holder releases
  // acquire(key) → { busy, ready, release }. `busy`: another turn holds or waits for this key.
  // Await `ready` before touching the conversation; call release() exactly once (extra calls are no-ops).
  function acquire(key) {
    const prev = tails.get(key);
    let open;
    const mine = new Promise((r) => { open = r; });
    const tail = (prev || Promise.resolve()).then(() => mine);
    tails.set(key, tail);
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      open();
      if (tails.get(key) === tail) tails.delete(key);   // nobody queued behind: forget the key
    };
    return { busy: !!prev, ready: prev || Promise.resolve(), release };
  }
  return { acquire, size: () => tails.size };
}

// Run one chat turn under its conversation's lock. `convoId` is the id the request named ('' for
// a new conversation); `onQueued()` runs only when the turn really has to wait. `turn(hold)` gets
// hold(id) to lock the id of a conversation it creates — no one else knows that id yet, so it
// never waits, but a follow-up naming it while this turn runs will queue behind it.
export async function withConvoTurn(locks, { userId, convoId, onQueued }, turn) {
  const held = [];
  const hold = (id) => { const l = locks.acquire(`${userId}\0${id}`); held.push(l); return l; };
  try {
    if (convoId) {
      const l = hold(convoId);
      if (l.busy) onQueued();
      await l.ready;
    }
    return await turn(hold);
  } finally { for (const l of held) l.release(); }
}
