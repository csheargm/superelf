import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { resolveUsers, sanitizeHealthThresholds, effectiveHealthThresholds, emailOk, loadProfile, saveProfile } from '../lib/users.mjs';

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-u-'));
  fs.mkdirSync(path.join(root, 'workspace.example', 'memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace.example', 'CLAUDE.md'), 'template');
  return root;
}

test('legacy single-token config becomes one owner user', () => {
  const root = tmp();
  // allowed_user_ids is the removed Telegram bot's (docs/adr/0006): still on old disks, never read.
  const { users, changed } = resolveUsers({ web_token: 'abc', default_project: 'assistant', projects: { assistant: { rel: 'workspace' } }, allowed_user_ids: [42] }, root);
  assert.equal(users.length, 1);
  assert.equal(users[0].id, 'owner');
  assert.equal(users[0].token, 'abc');
  assert.ok(!('telegram_id' in users[0]), 'the old bot allowlist no longer becomes a telegram_id');
  assert.ok(changed);
});

test('multiple users each get an isolated provisioned workspace', () => {
  const root = tmp();
  const { users, byToken } = resolveUsers({ users: [
    { id: 'usera', name: 'User A', token: 't-usera' },
    { id: 'mom', name: 'Mom', token: 't-mom' },
  ] }, root);
  assert.equal(users.length, 2);
  assert.notEqual(users[0].workspace, users[1].workspace);
  assert.ok(fs.existsSync(path.join(users[1].workspace, 'CLAUDE.md'))); // provisioned from template
  assert.equal(byToken.get('t-mom').id, 'mom');
});

test('missing token is generated and flagged changed', () => {
  const root = tmp();
  const { users, changed } = resolveUsers({ users: [{ id: 'kid', name: 'Kid' }] }, root);
  assert.ok(users[0].token && users[0].token.length > 20);
  assert.ok(changed);
});

test('duplicate tokens are rejected', () => {
  const root = tmp();
  assert.throws(() => resolveUsers({ users: [{ id: 'a', token: 'same' }, { id: 'b', token: 'same' }] }, root), /unique token/);
});

test('duplicate ids and shared workspaces are rejected', () => {
  const root = tmp();
  assert.throws(() => resolveUsers({ users: [{ id: 'a', token: 't1' }, { id: 'a', token: 't2' }] }, root), /duplicate user id/);
  assert.throws(() => resolveUsers({ users: [{ id: 'a', token: 't1', workspace: 'shared' }, { id: 'b', token: 't2', workspace: 'shared' }] }, root), /share workspace/);
});

// R13-9: per-user health-threshold overrides — whitelist + effective merge.
const HT_DEFAULTS = { steps_min_daily: 5000, sleep_min_minutes: 360, weight_delta_kg_7d: 1.5 };

test('healthThresholds whitelist: known keys + finite non-negative numbers only', () => {
  const got = sanitizeHealthThresholds(
    { steps_min_daily: 7000, bogus_key: 1, sleep_min_minutes: 'six hours', weight_delta_kg_7d: -2, extra: NaN },
    HT_DEFAULTS);
  assert.deepEqual(got, { steps_min_daily: 7000 }, 'junk keys/strings/negatives/NaN all dropped');
  assert.equal(sanitizeHealthThresholds('nope', HT_DEFAULTS), null);
  assert.equal(sanitizeHealthThresholds([1, 2], HT_DEFAULTS), null);
});

test('healthThresholds overrides actually take effect over the config defaults', () => {
  const eff = effectiveHealthThresholds({ healthThresholds: { steps_min_daily: 7000 } }, HT_DEFAULTS);
  assert.deepEqual(eff, { ...HT_DEFAULTS, steps_min_daily: 7000 });
  assert.deepEqual(effectiveHealthThresholds(null, HT_DEFAULTS), HT_DEFAULTS, 'no profile -> pure defaults');
  assert.deepEqual(effectiveHealthThresholds({ healthThresholds: { steps_min_daily: 'junk' } }, HT_DEFAULTS),
    HT_DEFAULTS, 'hand-edited junk in profile.json is re-sanitized on read');
});

// ── briefing email（简报邮箱）— emailOk is THE email gate (R3): the profile
// PUT whitelist validates writes with it and lib/notify.mjs re-checks reads.
test('emailOk: accepts plain addresses, rejects junk/blank/oversize', () => {
  for (const good of ['mom@example.com', 'a.b+tag@sub.domain.co', '中@example.cn']) assert.ok(emailOk(good), good);
  for (const bad of ['', '   ', 'not-an-email', 'a@b', 'a b@c.com', 'a@b .com', null, undefined, 42, 'a@' + 'b'.repeat(250) + '.com'])
    assert.ok(!emailOk(bad), `must reject: ${String(bad)}`);
});

test('profile round-trip: briefingEmail persists and reloads via save/loadProfile', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-u-'));
  saveProfile(ws, { name: 'Mom', briefingEmail: 'mom@example.com' });
  assert.equal(loadProfile(ws).briefingEmail, 'mom@example.com');
  const prof = loadProfile(ws);
  delete prof.briefingEmail; // the PUT handler's blank-clears path
  saveProfile(ws, prof);
  assert.equal(loadProfile(ws).briefingEmail, undefined, 'blank clears — email delivery off');
});
