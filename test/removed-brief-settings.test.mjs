// The daily brief and mail reading were removed 2026-10-11 (docs/adr/0004). An install that ran
// them still has their settings on disk: config.json keys (daily_brief_time, calendar_ics,
// gmail_user, gmail_app_password) and per-person profile fields (calendarIcs, mailVips,
// mailMuted, mailKeywords). The user flow pinned here (R6), against the REAL server booted with
// exactly that leftover data: it starts, no settings surface offers the removed controls, nothing
// leaks the old Gmail password, the leftover data is left as it was — never served, never
// written, never deleted — and no user has a daily-brief job while the weekly 健康简报 still runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_CFG = { daily_brief_time: '07:30', calendar_ics: 'https://cal.example.com/basic.ics',
  gmail_user: 'me@example.com', gmail_app_password: 'LEGACY-gmail-app-password-7a7a' };
const REMOVED_CFG_KEYS = Object.keys(LEGACY_CFG);
const LEGACY_PROFILE = { name: 'Owner', about: 'notes about me', calendarIcs: 'https://cal.example.com/me.ics',
  mailVips: ['boss@work.example'], mailMuted: ['ads@x.example'], mailKeywords: ['invoice'] };
const REMOVED_PROFILE_FIELDS = ['calendarIcs', 'mailVips', 'mailMuted', 'mailKeywords'];

let port, root, web;
const MEMBER_TOKEN = 'test-member-token-0123456789abcd';
const profileFile = () => path.join(root, 'workspace', 'profile.json');
before(async () => {
  port = await freePort();
  // The owner has the legacy profile; the member has none, like someone who never set those.
  root = mkWebRoot({ port, extraConfig: { ...LEGACY_CFG, users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-kid' },
  ] } });
  fs.writeFileSync(profileFile(), JSON.stringify(LEGACY_PROFILE, null, 2));
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });
const J = (p, opt) => api(port, p, opt);
const asKid = (p, opt = {}) => api(port, p, { ...opt, headers: { authorization: `Bearer ${MEMBER_TOKEN}`, ...(opt.headers || {}) } });

test('a config.json still holding the removed keys boots, and Node settings neither lists nor leaks them', async () => {
  const res = await J('/api/admin/config');
  assert.equal(res.status, 200, 'the server is up and answering with the legacy config');
  const rows = await res.json();
  const keys = rows.map((r) => r.key);
  assert.ok(keys.includes('public_base_url'), 'CONTROL: the view lists the settings that remain');
  for (const k of REMOVED_CFG_KEYS) assert.ok(!keys.includes(k), `${k} is not offered`);
  const body = JSON.stringify(rows);
  assert.ok(!body.includes(LEGACY_CFG.gmail_app_password), 'the old Gmail password never leaves the server');
  assert.ok(!body.includes(LEGACY_CFG.gmail_user), 'nor the old Gmail address');
  for (const k of REMOVED_CFG_KEYS) {
    const put = await J('/api/admin/config', { method: 'PUT', body: JSON.stringify({ key: k, value: 'x' }) });
    assert.equal(put.status, 400, `${k} cannot be written`);
    assert.match((await put.json()).error, /Unknown or non-editable key/);
  }
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  for (const [k, v] of Object.entries(LEGACY_CFG)) assert.equal(onDisk[k], v, `${k} is left in config.json as it was`);
});

test('the profile no longer serves or accepts the calendar and mail fields — and leaves the old values alone', async () => {
  // The removed code DEFAULTED these on every GET (calendarIcs:'' and three []), so every profile
  // carried them. Now a profile that never had them gets none.
  const kid = await (await asKid('/api/profile')).json();
  assert.equal(kid.name, 'Kid', 'CONTROL: the member\'s own profile');
  for (const f of REMOVED_PROFILE_FIELDS) assert.ok(!(f in kid), `${f} is not served as a setting`);
  // A profile that DOES hold them is echoed as stored (GET has always passed the stored profile
  // through) — the values are the person's own data, shown back unchanged and never acted on.
  const me = await (await J('/api/profile')).json();
  assert.equal(me.name, 'Owner', 'CONTROL: this is the legacy profile');
  for (const f of REMOVED_PROFILE_FIELDS) assert.deepEqual(me[f], LEGACY_PROFILE[f], `${f} is passed through as stored, not normalised`);
  const put = await J('/api/profile', { method: 'PUT', body: JSON.stringify({ about: 'updated',
    calendarIcs: 'https://evil.example/x.ics', mailVips: ['new@x.example'], mailMuted: [], mailKeywords: ['k'] }) });
  assert.equal(put.status, 200, 'a save from an old cached client still succeeds');
  const saved = JSON.parse(fs.readFileSync(profileFile(), 'utf8'));
  assert.equal(saved.about, 'updated', 'CONTROL: the save did write');
  for (const f of REMOVED_PROFILE_FIELDS) {
    assert.deepEqual(saved[f], LEGACY_PROFILE[f], `${f}: the client's value was ignored and the old one left untouched`);
  }
});

test('the Settings dialog no longer carries the calendar or mail controls', () => {
  const shell = readShell(ROOT);
  assert.ok(shell.includes('id="pBriefEmail"'), 'CONTROL: this is the composed settings dialog');
  for (const gone of ['id="pCalIcs"', 'id="pCalWrap"', 'id="mailPrefWrap"', 'id="pMailVips"', 'id="pMailMuted"',
    'id="pMailKeywords"', "'calendar-ics'", "'mail-prefs'", 'calendarIcs', 'mailVips', 'Gmail auto-forward']) {
    assert.ok(!shell.includes(gone), `the shell must not carry ${gone}`);
  }
  assert.ok(shell.includes('id="agentMailWrap"'), 'the AgentMail sending address stays — it is how briefings are emailed');
});

// ── The daily brief is gone (2026-10-11, docs/adr/0004) ─────────────────────────────────────
// GET /api/jobs, Run now and the scheduler tick all resolve a user's jobs through the ONE
// function jobsForUser — so what the view lists for each user is exactly what the tick can run.
test('no daily-brief job exists for ANY user, and the tick has nothing by that name to run', async () => {
  const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(WEB, /await jobsTick\(\{ users: cfg\.users, jobs: jobsForUser,/, 'the tick runs exactly what jobsForUser returns');
  for (const [who, call] of [['owner', J], ['member', asKid]]) {
    const rows = await (await call('/api/jobs')).json();
    assert.ok(Array.isArray(rows) && rows.some((r) => r.label), `${who}: the view answers, with labels`);
    assert.ok(!rows.find((r) => r.name === 'daily-brief'), `${who}: no daily-brief row`);
    assert.ok(!rows.some((r) => /每日一报|Daily Brief/.test(r.label || '')), `${who}: nor anything titled like it`);
    assert.equal((await call('/api/jobs/daily-brief/run', { method: 'POST' })).status, 404, `${who}: Run now has nothing to run`);
  }
  // State an existing install still carries — a job-prefs override and a job-runs mark for the
  // old job — is inert: it neither resurrects the row nor breaks the view.
  fs.writeFileSync(path.join(root, 'workspace-kid', 'job-prefs.json'), JSON.stringify({ 'daily-brief': { enabled: false } }));
  fs.writeFileSync(path.join(root, 'workspace-kid', 'job-runs.json'), JSON.stringify({ 'daily-brief': '2026-10-10' }));
  const kid = await (await asKid('/api/jobs')).json();
  assert.ok(!kid.find((r) => r.name === 'daily-brief'), 'stale state does not bring it back');
  assert.ok(kid.find((r) => r.name === 'health-brief'), 'and the weekly brief is still listed');
});

test('the weekly 健康简报 still runs, for every member, with its schedule unchanged', async () => {
  for (const [who, call] of [['owner', J], ['member', asKid]]) {
    const row = (await (await call('/api/jobs')).json()).find((r) => r.name === 'health-brief');
    assert.ok(row, `${who}: listed`);
    assert.equal(row.paused, false, `${who}: armed`);
    assert.ok(row.nextDue, `${who}: with a next run`);
    const r = await (await call('/api/jobs/health-brief/run', { method: 'POST' })).json();
    assert.equal(r.ok, true, `${who}: ${JSON.stringify(r)}`);
    assert.match(r.body, /健康简报 · Weekly Health Brief/, `${who}: and it produced the weekly brief`);
    const feed = await (await call('/api/briefings')).json();
    assert.ok((Array.isArray(feed) ? feed : feed.briefings || []).some((b) => b.id === r.briefing),
      `${who}: and it landed in the Briefings feed`);
  }
  const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(WEB, /'health-brief': \{\s*\n\s*name: 'health-brief', title: '健康简报 · Weekly Health Brief', type: 'digest',\s*\n\s*schedule: \{ day: 0, time: '20:00' \}/,
    'Sunday 20:00, as before');
});
