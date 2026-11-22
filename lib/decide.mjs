// Single-writer decision core（单一写入者）for pending-action state.
//
// EXACTLY ONE process (web.mjs) mutates pending-actions.json. Every mutation —
// approve/deny from the app, the expiry sweep, the limbo sweep, and the
// tick's proposal stores — runs through withUserLock, a per-user promise queue,
// so a load-modify-save can never interleave with another — the TOCTOU family
// (double execution, deny-then-approve, torn writes) dies here. Nothing outside
// web.mjs may mutate it: anything else must go through the web routes.
import { loadActions, approveAction, denyAction } from './autonomy.mjs';
import { executeAction, expireStaleActions, sweepStrandedApprovals } from './actions.mjs';

const queues = new Map(); // userId → tail of that user's serialized mutations

// Serialize fn behind every earlier mutation for this user. The caller gets
// fn's own promise (including its rejection); the stored tail swallows the
// rejection only to keep the chain alive for the NEXT caller (R5: nothing is
// hidden — the failure already reached the caller that owns it).
export function withUserLock(userId, fn) {
  const tail = queues.get(userId) || Promise.resolve();
  const run = tail.then(fn, fn);
  queues.set(userId, run.then(() => {}, () => {}));
  return run;
}

// One serialized decision: sweep first (a stale proposal must expire and a
// stranded approval must close before anything is decidable), then apply the
// verb. Returns null (unknown id), or { decided, wasPending } — wasPending
// false = a replay/double-tap that changed nothing and re-executed nothing.
export function decideAction(user, id, verb, { execute = executeAction, audit = () => {}, now = Date.now() } = {}) {
  return withUserLock(user.id, async () => {
    expireStaleActions(user, now);
    sweepStrandedApprovals(user, now, audit);
    const cur = loadActions(user).find((a) => a.id === id);
    if (!cur) return null;
    const wasPending = cur.status === 'pending';
    const decided = verb === 'deny' ? denyAction(user, id, now)
      : await approveAction(user, id, { execute, now });
    if (wasPending) {
      audit(`action-${decided.status}`, { who: user.id, action: id, type: decided.type,
        ...(decided.error ? { error: decided.error } : {}) });
    }
    return { decided, wasPending };
  });
}
