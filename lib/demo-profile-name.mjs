// A signed-in demo visitor's profile name from their Google account · 用 Google 账户名作资料名字
// The Supabase access token carries user_metadata (full_name / name from Google). On sign-in the
// profile name is set from it ONLY while the profile has no name of the visitor's own (missing, empty,
// or the record placeholder) — a name they typed is never overwritten. Never the email. Plain text,
// capped by code point like PUT /api/profile (web.mjs).
import { loadProfileForUpdate, saveProfile } from './users.mjs';

export const PROFILE_NAME_MAX = 60;
const CONTROL_OR_TAG = /[\u0000-\u001f\u007f<>]/g;   // control chars and angle brackets: a name is plain text

export function nameFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  for (const k of ['full_name', 'name']) {
    const v = typeof meta[k] === 'string' ? meta[k].replace(CONTROL_OR_TAG, ' ').replace(/\s+/g, ' ').trim() : '';
    if (v && !v.includes('@')) return [...v].slice(0, PROFILE_NAME_MAX).join('').trim();   // an email-shaped "name" is skipped
  }
  return '';
}

// → true when the name was written. A profile.json that cannot be read throws (never overwritten).
export function applyAccountName(user, meta) {
  const name = nameFromMeta(meta);
  if (!name) return false;
  const prof = loadProfileForUpdate(user.workspace, { name: user.name, role: user.role, about: '', prefs: '' });
  const own = String(prof.name || '').trim();
  if (own && own !== user.name) return false;
  saveProfile(user.workspace, { ...prof, name });
  return true;
}
