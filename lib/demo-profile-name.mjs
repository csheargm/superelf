// A signed-in demo visitor's profile name from their Google account · 用 Google 账户名作资料名字
// The Supabase access token carries user_metadata (full_name / name from Google). On sign-in the
// profile name is set from it ONLY while the profile has no name of the visitor's own (missing, empty,
// or the record placeholder) — a name they typed is never overwritten. Never the email. Plain text,
// capped to fit PUT /api/profile's 60-unit cut (web.mjs).
import { loadProfileForUpdate, saveProfile } from './users.mjs';

export const PROFILE_NAME_MAX = 60;
const CONTROL_OR_TAG = /[\u0000-\u001f\u007f<>]/g;   // control chars and angle brackets: a name is plain text

export function nameFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  for (const k of ['full_name', 'name']) {
    const v = typeof meta[k] === 'string' ? meta[k].replace(CONTROL_OR_TAG, ' ').replace(/\s+/g, ' ').trim() : '';
    if (v && !v.includes('@')) return capWhole(v);   // an email-shaped "name" is skipped
  }
  return '';
}

// Whole code points only, and at most PROFILE_NAME_MAX UTF-16 units — PUT /api/profile's .slice(0, 60)
// then never cuts it again (Settings resends the name on every save), nor splits an emoji.
function capWhole(v) {
  let out = '';
  for (const ch of v) { if (out.length + ch.length > PROFILE_NAME_MAX) break; out += ch; }
  return out.trim();
}

// → true when the name was written. A profile.json that cannot be read is left alone and the name skipped:
// the name is optional, so sign-in must not fail over it (the profile's own readers report the bad file).
export function applyAccountName(user, meta) {
  const name = nameFromMeta(meta);
  if (!name) return false;
  let prof;
  try { prof = loadProfileForUpdate(user.workspace, { name: user.name, role: user.role, about: '', prefs: '' }); }
  catch { return false; }   // unreadable profile.json: never overwritten, sign-in goes on (see above)
  const own = String(prof.name || '').trim();
  if (own && own !== user.name) return false;
  saveProfile(user.workspace, { ...prof, name });
  return true;
}
