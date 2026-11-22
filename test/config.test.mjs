import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { validateConfig, loadConfig } from '../lib/config.mjs';
import { writeUsers } from '../lib/users.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-'));
fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
const base = () => ({
  default_project: 'assistant',
  projects: { assistant: { dir: 'workspace' } },
});

test('valid config passes and fills defaults', () => {
  const cfg = validateConfig(base(), root);
  assert.equal(cfg.claude_cmd, 'claude');
  assert.equal(cfg.task_timeout_minutes, 30);
  assert.ok(path.isAbsolute(cfg.projects.assistant.dir));
});

test('unknown default_project rejected', () => {
  const c = base(); c.default_project = 'nope';
  assert.throws(() => validateConfig(c, root), /default_project/);
});

test('empty projects rejected', () => {
  const c = base(); c.projects = {};
  assert.throws(() => validateConfig(c, root), /projects/);
});

test('public_base_url: empty default, trailing slash normalized, invalid refuses to load', () => {
  assert.equal(validateConfig(base(), root).public_base_url, '', 'unset → empty (Host-header derivation)');
  const c = base(); c.public_base_url = 'http://mybook.tailnet.ts.net:8787/';
  assert.equal(validateConfig(c, root).public_base_url, 'http://mybook.tailnet.ts.net:8787', 'trailing slash stripped');
  const c2 = base(); c2.public_base_url = 'not a url';
  assert.throws(() => validateConfig(c2, root), /public_base_url/, 'invalid value fails loudly at boot (health_llm precedent)');
});

test('assess defaults: top Deep model + agents, haiku summarizer, timeout falls back', () => {
  const cfg = validateConfig(base(), root);
  assert.deepEqual(cfg.assess_models, ['glm', 'claude', 'gpt']); // first Deep + claude + codex ids
  assert.equal(cfg.assess_summarizer, 'haiku');
  assert.equal(cfg.assess_timeout_minutes, cfg.task_timeout_minutes);
  assert.ok(cfg.system_prompts.assess.includes('Consensus 共识'));
});

test('assess_models with an unknown id is rejected loudly, not silently skipped', () => {
  const c = base(); c.assess_models = ['glm', 'nope'];
  assert.throws(() => validateConfig(c, root), /assess_models: unknown model id "nope"/);
});

test('preapproved_action_types（预批准）: default [], inward types pass, unknown rejected', () => {
  assert.deepEqual(validateConfig(base(), root).preapproved_action_types, []);
  const c = base(); c.preapproved_action_types = ['noop', 'create-reminder'];
  assert.deepEqual(validateConfig(c, root).preapproved_action_types, ['noop', 'create-reminder']);
  const c2 = base(); c2.preapproved_action_types = ['bogus'];
  assert.throws(() => validateConfig(c2, root), /unknown action type "bogus"/);
});

test('preapproved_action_types: an outward-facing type is REFUSED at config load', () => {
  const c = base(); c.preapproved_action_types = ['send_email'];
  assert.throws(() => validateConfig(c, root), /outward-facing（对外行动）and can NEVER be pre-approved/);
});

// R13-9: the health digest lane is EXPLICIT config, not an implicit .find().
test('health_llm: defaults to the first ollama lane; explicit ids are validated', () => {
  assert.equal(validateConfig(base(), root).health_llm, 'deepseek', 'documented default: first ollama entry');
  const c2 = base(); c2.health_llm = 'kimi';
  assert.equal(validateConfig(c2, root).health_llm, 'kimi');
  const c3 = base(); c3.health_llm = 'nope';
  assert.throws(() => validateConfig(c3, root), /health_llm: unknown model id/);
  const c4 = base(); c4.health_llm = 'claude';   // agent lane — the digest speaks the ollama API only
  assert.throws(() => validateConfig(c4, root), /must be an ollama lane/);
});

// R13 review, 2026-10-12: vision_default naming Codex sent a confined turn's image to a lane that
// reads outside the workspace. Only an Ollama lane may see an image for a fast lane.
test('vision_default: an Ollama lane loads; a lane of any other provider refuses to load', () => {
  assert.equal(validateConfig(base(), root).vision_default, 'glmflash', 'documented default');
  const kimi = base(); kimi.vision_default = 'kimi';
  assert.equal(validateConfig(kimi, root).vision_default, 'kimi', 'CONTROL: another Ollama lane is accepted');
  for (const [id, provider] of [['gpt', 'codex'], ['claude', 'claude']]) {
    const c = base(); c.vision_default = id;
    assert.throws(() => validateConfig(c, root), new RegExp(`vision_default: lane "${id}" is provider "${provider}" — must be an ollama lane`));
  }
  // The research lane joins chat_models during validation; it reads no attachment, so it is refused too.
  const r = base(); r.tavily_key = 'tvly-x'; r.vision_default = 'research';
  assert.throws(() => validateConfig(r, root), /vision_default: lane "research" is provider "research"/);
  // An id not in chat_models is a node with no vision lane (test/meals-ui.test.mjs boots one), not an error.
  const none = base(); none.vision_default = 'no-vision-lane-configured';
  assert.equal(validateConfig(none, root).vision_default, 'no-vision-lane-configured');
});

test('assess overrides respected', () => {
  const c = base(); c.assess_timeout_minutes = 5; c.assess_summarizer = 'sonnet'; c.assess_models = ['kimi'];
  const cfg = validateConfig(c, root);
  assert.equal(cfg.assess_timeout_minutes, 5);
  assert.equal(cfg.assess_summarizer, 'sonnet');
  assert.deepEqual(cfg.assess_models, ['kimi']);
});

// Research lane（联网研究）visibility is config-driven: the chooser lists whatever
// chat_models holds, so key-absent → entry absent → lane hidden with NO UI code.
test('research lane: hidden without tavily_key, offered (with defaults) when set', () => {
  const off = validateConfig(base(), root);
  assert.equal(off.researchEnabled, false);
  assert.equal(off.chat_models.find((m) => m.id === 'research'), undefined, 'no key → no chooser entry');
  const c = base(); c.tavily_key = 'tvly-test-not-real';
  const on = validateConfig(c, root);
  assert.equal(on.researchEnabled, true);
  const m = on.chat_models.find((m) => m.id === 'research');
  assert.deepEqual(m, { id: 'research', label: 'Research · 联网研究', group: 'Research', provider: 'research', model: null });
  assert.equal(on.research.max_results, 5);
  assert.equal(on.research.read_top, 3);
  assert.equal(on.research.excerpt_bytes, 6000);
  assert.equal(on.research.tavily_url, 'https://api.tavily.com/search');
  assert.equal(on.research.firecrawl_url, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal(on.research.llm, 'deepseek', 'default reasoning lane: first ollama entry (health_llm precedent)');
});

test('research overrides respected; placeholder key stays hidden; llm validated', () => {
  const c = base(); c.tavily_key = 'tvly-x'; c.research = { read_top: 2, llm: 'kimi', tavily_url: 'http://127.0.0.1:9/search' };
  const cfg = validateConfig(c, root);
  assert.equal(cfg.research.read_top, 2);
  assert.equal(cfg.research.llm, 'kimi');
  assert.equal(cfg.research.tavily_url, 'http://127.0.0.1:9/search');
  assert.equal(cfg.research.max_results, 5, 'unspecified fields keep defaults');
  const c2 = base(); c2.tavily_key = 'PASTE_TAVILY_KEY';
  assert.equal(validateConfig(c2, root).researchEnabled, false, 'placeholder key = no key');
  const c3 = base(); c3.tavily_key = 'tvly-x'; c3.research = { llm: 'claude' };
  assert.throws(() => validateConfig(c3, root), /research\.llm: lane "claude" is provider "claude" — must be an ollama lane/);
  const c4 = base(); c4.tavily_key = 'tvly-x'; c4.research = { llm: 'nope' };
  assert.throws(() => validateConfig(c4, root), /research\.llm: unknown model id/);
});

// The daily brief and mail reading were removed 2026-10-11 (docs/adr/0004). An existing
// config.json still holds their keys and must keep loading — nothing may refuse to boot over
// them, and nothing may start reading them again.
test('a config.json still holding the removed brief/mail keys loads, and they are ignored', () => {
  const c = { ...base(), daily_brief_time: '07:30', calendar_ics: 'https://cal.example.com/basic.ics',
    gmail_user: 'me@example.com', gmail_app_password: 'abcd efgh ijkl mnop' };
  const plain = validateConfig(base(), root);
  const cfg = validateConfig(c, root);
  assert.equal(cfg.daily_brief_time, '07:30', 'passed through untouched, not normalised or defaulted');
  assert.equal(plain.daily_brief_time, undefined, 'and never invented when absent — the loader no longer owns it');
  for (const k of ['calendar_ics', 'gmail_user', 'gmail_app_password']) assert.equal(cfg[k], c[k], `${k} left as found`);
  // Nothing the server derives from config changes because of them.
  const without = (x) => { const o = { ...x }; for (const k of ['daily_brief_time', 'calendar_ics', 'gmail_user', 'gmail_app_password']) delete o[k]; return o; };
  assert.deepEqual(without(cfg), without(plain), 'every derived setting is identical with or without the removed keys');
});

// The Telegram bot was removed 2026-10-12 (docs/adr/0006). A node's config.json still holds its
// keys, and users[].telegram_id on the people who linked it. The REAL loader (users included)
// must load it, read none of it, and let the per-user key fall away on the next save.
const TG_LEGACY = { telegram_bot_token: '123456:NOT-A-REAL-TOKEN', allowed_user_ids: [42, '7'], owner_chat_id: 42,
  schedules: [{ name: 'brief', time: '07:30', prompt: 'p' }], deep_args: ['--model', 'x', '--dangerously-skip-permissions'] };
test('a config.json still holding the removed Telegram keys loads, nothing reads them, the next save drops telegram_id', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-tg-'));
  const file = path.join(r, 'config.json');
  const owner = { id: 'owner', name: 'Owner', role: 'owner', token: 't-owner-0123456789', workspace: 'workspace' };
  const load = async (extra, userExtra = {}) => {
    fs.writeFileSync(file, JSON.stringify({ ...base(), ...extra, users: [{ ...owner, ...userExtra }] }));
    return loadConfig(r);
  };
  // What the server derives: everything but the legacy keys themselves and the per-load handles.
  const derived = (c) => {
    const o = { ...c, sessions: undefined, userByToken: undefined, userById: undefined };
    for (const k of Object.keys(TG_LEGACY)) delete o[k];
    return JSON.stringify(o);
  };
  const plain = await load({});
  const legacy = await load(TG_LEGACY, { telegram_id: 42 });
  for (const [k, v] of Object.entries(TG_LEGACY)) assert.deepEqual(legacy[k], v, `${k} passes through as found — not normalised`);
  assert.ok(!('telegram_id' in legacy.users[0]), 'the user record does not carry telegram_id');
  assert.equal(derived(legacy), derived(plain), 'every derived setting is identical with or without the removed keys');
  // CONTROL: the comparison does see a key the server DOES read.
  assert.notEqual(derived(await load({ fast_args: ['--model', 'other'] })), derived(plain), 'a live key changes what is derived');
  // On disk: loading rewrites nothing; the next save of the users drops telegram_id and leaves
  // every top-level key (Telegram's included) exactly as it was.
  const cfg = await load(TG_LEGACY, { telegram_id: 42 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).users[0].telegram_id, 42, 'CONTROL: the old key was on disk');
  writeUsers(r, cfg.users.map((u) => ({ ...u, name: 'Renamed' })));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.users[0].name, 'Renamed', 'CONTROL: the save did write');
  assert.ok(!('telegram_id' in saved.users[0]), 'telegram_id is gone after the save');
  for (const [k, v] of Object.entries(TG_LEGACY)) assert.deepEqual(saved[k], v, `${k} is left in config.json as it was`);
});

// 2026-10-12: Ollama retired deepseek-v4-flash:0731 and qwen3.5:397b (HTTP 410). These are the
// defaults a config with no chat_models key gets — which is the live node's config.
test('default chat_models: no retired model, the deepseek id kept on its successor', () => {
  const cfg = validateConfig(base(), root);
  const models = cfg.chat_models.map((m) => m.model).filter(Boolean);
  for (const retired of ['deepseek-v4-flash:0731-cloud', 'qwen3.5:397b:cloud']) {
    assert.ok(!models.includes(retired), `${retired} answers 410 and must not be a default`);
  }
  const first = cfg.chat_models[0];
  assert.equal(first.id, 'deepseek', 'the id profiles store in appModels is stable');
  assert.equal(first.model, 'deepseek-v4.1-flash:cloud');
  assert.equal(first.label, 'DeepSeek · 中文');
  assert.deepEqual(cfg.chat_models.find((m) => m.id === 'deepseekpro'),
    { id: 'deepseekpro', label: 'DeepSeek Pro', group: 'Deep', provider: 'ollama', model: 'deepseek-v4-pro:0813-cloud' });
  assert.ok(!cfg.chat_models.some((m) => m.id === 'qwen'), 'qwen had no successor in the catalog');
  assert.equal(cfg.health_llm, 'deepseek', 'the lanes derived from "first ollama entry" follow it');
  assert.deepEqual(cfg.assess_models, ['glm', 'claude', 'gpt'], 'the Verify panel default is unchanged');
});

test('model-check config: daily time and catalog URL have defaults, a bad time refuses to load', () => {
  const cfg = validateConfig(base(), root);
  assert.equal(cfg.model_check_time, '06:00');
  assert.equal(cfg.ollama_catalog_url, 'https://ollama.com/api/tags');
  assert.equal(validateConfig({ ...base(), ollama_catalog_url: '' }, root).ollama_catalog_url, '', "'' turns the catalog off");
  assert.equal(validateConfig({ ...base(), model_check_time: '21:15' }, root).model_check_time, '21:15');
  assert.throws(() => validateConfig({ ...base(), model_check_time: '25:00' }, root), /model_check_time: not HH:MM/);
  assert.throws(() => validateConfig({ ...base(), ollama_catalog_url: 'ollama.com/api/tags' }, root), /ollama_catalog_url: not an http\(s\) URL/);
});

test('model_review config (docs/adr/0017): defaults at load, a bad value refuses to load', () => {
  const cfg = validateConfig(base(), root);
  assert.equal(cfg.model_review.time, '03:00');
  assert.equal(cfg.model_review.every_days, 7);
  assert.equal(validateConfig({ ...base(), model_review: { time: '04:10', margin: 1 } }, root).model_review.margin, 1);
  assert.throws(() => validateConfig({ ...base(), model_review: { time: '4pm' } }, root), /model_review: time: not HH:MM/);
  assert.throws(() => validateConfig({ ...base(), model_review: { max_calls: -1 } }, root), /model_review: max_calls/);
  assert.throws(() => validateConfig({ ...base(), model_review: { every: 7 } }, root), /model_review: unknown key "every"/);
  assert.equal(cfg.model_review.agent_lanes, true, 'the Claude and Codex lanes are measured by default (docs/adr/0017 decision 10)');
  assert.throws(() => validateConfig({ ...base(), model_review: { agent_lanes: 'on' } }, root), /model_review: agent_lanes must be true or false/);
});
