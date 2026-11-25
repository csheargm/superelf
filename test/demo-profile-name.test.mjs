// The Google account name → demo profile name · Google 账户名写入演示资料名字 (lib/demo-profile-name.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nameFromMeta, applyAccountName, PROFILE_NAME_MAX } from '../lib/demo-profile-name.mjs';
import { loadProfile, saveProfile } from '../lib/users.mjs';

test('nameFromMeta: full_name first, then name, trimmed', () => {
  assert.equal(nameFromMeta({ full_name: '  Ada Lovelace ', name: 'Ada' }), 'Ada Lovelace');
  assert.equal(nameFromMeta({ name: '李明' }), '李明');
});
test('nameFromMeta: missing, empty, non-string and email-shaped give empty', () => {
  for (const m of [null, undefined, {}, { full_name: '   ' }, { full_name: 42 }, { name: 'a@b.com' }, 'str']) assert.equal(nameFromMeta(m), '');
});
test('nameFromMeta: very long fits the 60-unit profile cut and never splits an emoji', () => {
  const n = nameFromMeta({ full_name: '😀'.repeat(200) });
  assert.equal(n.length, PROFILE_NAME_MAX);
  assert.equal(n.slice(0, 60), n);   // PUT /api/profile's own cut changes nothing
  assert.equal(nameFromMeta({ full_name: 'a' + '😀'.repeat(40) }), 'a' + '😀'.repeat(29));
});
test('nameFromMeta: HTML and control chars become plain text', () => {
  const n = nameFromMeta({ full_name: '<img src=x onerror=alert(1)>Bob\u0000\n' });
  assert.ok(!/[<>\u0000\n]/.test(n), n);
  assert.match(n, /Bob$/);
});

const ws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-gname-'));
const user = (w) => ({ id: 'sb-1', name: 'Member · 会员', role: 'member', workspace: w });

test('applyAccountName: sets the name on a new or placeholder profile', () => {
  const w = ws();
  try {
    assert.equal(applyAccountName(user(w), { full_name: 'Ada' }), true);
    assert.equal(loadProfile(w).name, 'Ada');
    const w2 = ws(); saveProfile(w2, { name: 'Member · 会员', prefs: 'x' });
    assert.equal(applyAccountName(user(w2), { name: 'Bo' }), true);
    assert.deepEqual(loadProfile(w2), { name: 'Bo', prefs: 'x' });
    fs.rmSync(w2, { recursive: true, force: true });
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});
test('applyAccountName: never overwrites a typed name; no metadata writes nothing', () => {
  const w = ws();
  try {
    saveProfile(w, { name: 'My Own' });
    assert.equal(applyAccountName(user(w), { full_name: 'Google Name' }), false);
    assert.equal(loadProfile(w).name, 'My Own');
    const w2 = ws();
    assert.equal(applyAccountName(user(w2), {}), false);
    assert.equal(loadProfile(w2), null);
    fs.rmSync(w2, { recursive: true, force: true });
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});
test('applyAccountName: an unreadable profile.json is left alone and does not throw', () => {
  const w = ws();
  try {
    fs.writeFileSync(path.join(w, 'profile.json'), '{not json');
    assert.equal(applyAccountName(user(w), { full_name: 'Ada' }), false);
    assert.equal(fs.readFileSync(path.join(w, 'profile.json'), 'utf8'), '{not json');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});
