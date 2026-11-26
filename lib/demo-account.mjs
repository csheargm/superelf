// Delete my account · 删除账户 (demo, signed-in visitors only). Removes that visitor's whole demo
// workspace (apps, chats, app data), their per-visitor quota rows, usage counts, kept email and name, sessions and token bindings. The
// shared scripturetolife.org (Supabase) account is NOT touched — the client's confirm text says so.
// The visitor record stays with its sign-out time, so tokens issued before the delete cannot
// bring the account straight back; a fresh sign-in later starts an empty workspace.
import fs from 'node:fs';

export const DEMO_DELETE_BUSY = 'Still saving or answering — try deleting again in a moment · 仍在保存或回复，请稍后再删除';
export const DEMO_DELETE_SIGNED_ONLY = 'Only a signed-in account can be deleted · 只有已登录的账户可以删除';

// `writing(id)`: a chat turn or save of that visitor in flight (lib/demo-routes.mjs locks). Refused
// then, so no in-flight write can recreate the folder; once sessions are revoked no new one starts.
export function makeDeleteAccount(d, gate, writing) {
  return function deleteAccount(req, res, json) {
    const user = d.userFor(req);   // a live, signed-in node session (web.mjs userFor checks the binding)
    if (!user) return json(res, 401, { error: 'bad token' });
    if (!user.signedIn) return json(res, 403, { ok: false, code: 'demo_not_member', error: DEMO_DELETE_SIGNED_ONLY });
    if (writing(user.id)) return json(res, 409, { ok: false, code: 'demo_busy', error: DEMO_DELETE_BUSY });
    // Data first, sessions last: if removal throws, the visitor is still signed in and can retry.
    if (d.usage) d.usage.dropUser(user.id);   // every kept day of their app counts (lib/demo-usage.mjs); first: it may throw (retryable) before anything is gone
    fs.rmSync(user.workspace, { recursive: true, force: true });
    d.store.dropUser(user.id);
    d.users.forget(user.id);   // the sign-in email and name the demo admin saw
    d.cfg.sessions.destroyUser(user.id);
    gate.drop(user.id);   // also records the sign-out time (tokens issued before it are refused)
    d.audit('demo-member-deleted', { who: user.id });
    return json(res, 200, { ok: true });
  };
}
