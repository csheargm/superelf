// Node settings（节点设置）core — lib/adminconfig.mjs. The contracts under
// test: the view is WHITELIST-ONLY (web_token / users / ports never appear),
// SECRET VALUES NEVER LEAVE THE SERVER (structural no-leak proof), writes are
// validated per field, land atomically, and blank clears. All against
// throwaway mkdtemp roots — never a live config.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FIELDS, adminConfigView, applyConfigWrite } from '../lib/adminconfig.mjs';

// telegram_bot_token (ADR 0006) and gmail_app_password (ADR 0004) are REMOVED keys an existing
// config.json still holds: never listed, never leaked, never touched by a write.
const SECRET_SENTINELS = {
  tavily_key: 'SENTINEL-tavily-4f9a', exa_key: 'SENTINEL-exa-8c21', firecrawl_key: 'SENTINEL-fire-77aa',
  agentmail_key: 'SENTINEL-agentmail-b0b0', telegram_bot_token: 'SENTINEL-tg-123456',
  gmail_app_password: 'SENTINEL-gmailapp-dd11', google_client_id: 'SENTINEL-gcid-9911', google_client_secret: 'SENTINEL-gcsec-3344',
};
const CFG = { chat_models: [
  { id: 'deepseek', provider: 'ollama', model: 'x' },
  { id: 'claude', provider: 'claude', model: null },
] };

function mkRoot(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-cfg-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    ...SECRET_SENTINELS,
    web_token: 'SENTINEL-webtoken-must-stay-file-only',
    users: [{ id: 'owner', token: 'SENTINEL-usertoken', passHash: 'scrypt$x$y' }],
    web_port: 8787,
    public_base_url: 'http://node.example:8787',
    // Keys of the removed daily brief / mail reader (2026-10-11), still present in an existing
    // install's config.json. They must be ignored, never listed and never leaked.
    gmail_user: 'me@example.com', daily_brief_time: '07:30',
    ...extra,
  }, null, 2));
  return root;
}
const readCfg = (root) => JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const view = (root) => adminConfigView(readCfg(root), CFG);

test('view is whitelist-only: web_token, users[] and ports NEVER appear', () => {
  const rows = view(mkRoot());
  const keys = rows.map((r) => r.key);
  assert.deepEqual([...keys].sort(), CONFIG_FIELDS.map((f) => f.key).sort(), 'exactly the whitelist, nothing else');
  for (const banned of ['web_token', 'users', 'web_port']) assert.ok(!keys.includes(banned), `${banned} is file-only`);
});

test('NO-LEAK (structural): secrets are write-only — no secret row carries a value, and no sentinel appears ANYWHERE in the serialized view, even when SET', () => {
  const rows = view(mkRoot());
  for (const r of rows.filter((x) => x.kind === 'secret')) {
    assert.equal(r.status, 'SET', `${r.key} is set in the fixture`);
    assert.ok(!('value' in r), `${r.key}: a secret row must not even have a value property`);
  }
  const serialized = JSON.stringify(rows);
  for (const [k, v] of Object.entries(SECRET_SENTINELS)) assert.ok(!serialized.includes(v), `${k} value leaked into the GET response`);
  assert.ok(!serialized.includes('SENTINEL-webtoken'), 'web_token never leaks');
  assert.ok(!serialized.includes('SENTINEL-usertoken'), 'user tokens never leak');
  // Non-secrets DO show their value (that is the editing surface).
  assert.equal(rows.find((r) => r.key === 'public_base_url').value, 'http://node.example:8787');
  assert.equal(rows.find((r) => r.key === 'exa_key').status, 'SET');
});

test('view statuses: empty vs SET; boot flag present on every row', () => {
  const root = mkRoot({ tavily_key: undefined });
  const raw = readCfg(root); delete raw.tavily_key; delete raw.public_base_url;
  const rows = adminConfigView(raw, CFG);
  assert.equal(rows.find((r) => r.key === 'tavily_key').status, 'empty');
  const placeholder = adminConfigView({ ...raw, agentmail_key: 'PASTE_AGENTMAIL_KEY' }, CFG);
  assert.equal(placeholder.find((r) => r.key === 'agentmail_key').status, 'empty',
    'a /PASTE/ placeholder is not a configured secret (the loader\'s agentmailEnabled semantics)');
  const gm = rows.find((r) => r.key === 'public_base_url');
  assert.equal(gm.status, 'empty');
  assert.ok(!('value' in gm), 'an empty value field carries no value');
  for (const r of rows) assert.equal(typeof r.boot, 'boolean', `${r.key} declares boot-time applicability`);
});

test('writes: unknown/excluded keys refused — the UI can never touch identity or infra', () => {
  const root = mkRoot();
  for (const k of ['web_token', 'users', 'web_port', 'made_up']) {
    assert.throws(() => applyConfigWrite(root, k, 'x', CFG), /不可编辑的配置项/);
  }
  assert.equal(readCfg(root).web_token, 'SENTINEL-webtoken-must-stay-file-only', 'file untouched by refused writes');
});

test('the daily brief\'s and mail reader\'s keys are gone: not listed, not writable — and a config.json holding them still reads', () => {
  // mkRoot's fixture still carries daily_brief_time, gmail_user and gmail_app_password, as an
  // existing install's config.json does.
  const root = mkRoot({ calendar_ics: 'https://cal.example.com/basic.ics' });
  const rows = view(root);
  const keys = rows.map((r) => r.key);
  assert.ok(!JSON.stringify(rows).includes(SECRET_SENTINELS.gmail_app_password), 'the old Gmail password never reaches the view');
  assert.ok(!JSON.stringify(rows).includes('me@example.com'), 'nor does the old Gmail address');
  for (const k of ['daily_brief_time', 'calendar_ics', 'gmail_user', 'gmail_app_password']) {
    assert.ok(!keys.includes(k), `${k} is not offered in Node settings`);
    assert.throws(() => applyConfigWrite(root, k, 'x', CFG), /Unknown or non-editable key/, `${k} cannot be written`);
  }
  assert.equal(readCfg(root).daily_brief_time, '07:30', 'the old value is left in the file, untouched');
});

test('per-field validation: count, health_llm, assess_summarizer', () => {
  const root = mkRoot();
  // (daily_brief_time, calendar_ics and gmail_user were validated here until the daily brief and
  // mail reading were removed, 2026-10-11; a numeric field takes the time field's place as the
  // trimmed-and-stored check.)
  assert.throws(() => applyConfigWrite(root, 'max_concurrent', '25', CFG), /1 到 20/);
  applyConfigWrite(root, 'max_concurrent', ' 6 ', CFG);
  assert.equal(readCfg(root).max_concurrent, 6, 'trimmed, parsed and stored');
  assert.throws(() => applyConfigWrite(root, 'health_llm', 'nope', CFG), /未知模型/);
  assert.throws(() => applyConfigWrite(root, 'health_llm', 'claude', CFG), /ollama/);
  applyConfigWrite(root, 'health_llm', 'deepseek', CFG);
  assert.equal(readCfg(root).health_llm, 'deepseek');
  assert.throws(() => applyConfigWrite(root, 'assess_summarizer', 'bad name!', CFG), /模型名无效/);
  applyConfigWrite(root, 'assess_summarizer', 'haiku', CFG);
});

test('public_base_url: http(s) origin only, trailing slash normalized, junk refused, blank clears', () => {
  const root = mkRoot();
  for (const bad of ['not a url', 'ftp://x.example', 'https://x.example/?q=1', 'https://u:p@x.example', 'https://x.example/#frag']) {
    assert.throws(() => applyConfigWrite(root, 'public_base_url', bad, CFG), /基址无效/, `refused: ${bad}`);
  }
  applyConfigWrite(root, 'public_base_url', 'http://mybook.tailnet.ts.net:8787/', CFG);
  assert.equal(readCfg(root).public_base_url, 'http://mybook.tailnet.ts.net:8787', 'stored with trailing slash stripped');
  applyConfigWrite(root, 'public_base_url', '', CFG);
  assert.ok(!('public_base_url' in readCfg(root)), 'blank clears — Host-header derivation returns');
});

test('preapproved_action_types goes through the loader gate: outward types refused, comma string normalized', () => {
  const root = mkRoot();
  assert.throws(() => applyConfigWrite(root, 'preapproved_action_types', 'send_email', CFG), /NEVER be pre-approved/, 'outward-facing type refused (lib/actions.mjs)');
  assert.throws(() => applyConfigWrite(root, 'preapproved_action_types', 'made-up-type', CFG), /unknown action type/);
  applyConfigWrite(root, 'preapproved_action_types', 'create-reminder, noop', CFG);
  assert.deepEqual(readCfg(root).preapproved_action_types, ['create-reminder', 'noop'], 'comma string → validated array');
  applyConfigWrite(root, 'preapproved_action_types', '', CFG);
  assert.ok(!('preapproved_action_types' in readCfg(root)), 'blank clears the key');
});

test('secrets: write replaces, junk refused, blank clears (key deleted), value never echoed in the result', () => {
  const root = mkRoot();
  const out = applyConfigWrite(root, 'tavily_key', 'tvly-new-key-0123456789', CFG);
  assert.deepEqual(out, { key: 'tavily_key', status: 'SET' }, 'result carries status only — never the value');
  assert.equal(readCfg(root).tavily_key, 'tvly-new-key-0123456789');
  assert.throws(() => applyConfigWrite(root, 'tavily_key', 'has spaces in it', CFG), /密钥格式无效/);
  assert.throws(() => applyConfigWrite(root, 'tavily_key', 'ab', CFG), /密钥格式无效/, 'too short');
  const cleared = applyConfigWrite(root, 'tavily_key', '', CFG);
  assert.deepEqual(cleared, { key: 'tavily_key', status: 'empty' });
  assert.ok(!('tavily_key' in readCfg(root)), 'clear DELETES the key so loaders re-apply defaults');
});

test('writes are fresh + atomic: other keys survive, file stays valid JSON, no tmp litter', () => {
  const root = mkRoot();
  applyConfigWrite(root, 'public_base_url', 'http://new.example:8787', CFG);
  const raw = readCfg(root); // throws if torn
  assert.equal(raw.web_token, 'SENTINEL-webtoken-must-stay-file-only');
  assert.equal(raw.users.length, 1, 'users[] untouched');
  assert.equal(raw.telegram_bot_token, SECRET_SENTINELS.telegram_bot_token, 'unrelated secrets untouched');
  assert.ok(!fs.readdirSync(root).some((f) => f.includes('.tmp')), 'atomic writer leaves no tmp files');
});

test('F5-12: every API-key secret sits under Advanced with a one-line bilingual purpose (中文 first)', () => {
  const rows = adminConfigView({}, CFG);
  const adv = rows.filter((r) => r.advanced);
  assert.deepEqual(adv.map((r) => r.key).sort(), CONFIG_FIELDS.filter((f) => f.kind === 'secret').map((f) => f.key).sort());
  for (const r of adv) assert.match(r.purpose, /^[^·]*[一-鿿][^·]* · [A-Za-z]/, `${r.key}: 中文 · English purpose`);
  for (const r of rows.filter((x) => !x.advanced)) assert.equal(r.purpose, undefined);
});
