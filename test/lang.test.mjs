// The ONE language setting · 界面语言 (lib/ui-lang.mjs, web/lang.js): unit checks on the server
// rules and on PALang's string helpers (run in a vm, no DOM). The browser flows are test/lang-e2e.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { langOf, appIsBilingual, replyLanguageRule, turnLang, REPLY_IN, BILINGUAL_APPS } from '../lib/ui-lang.mjs';
import { REPLY_LANGUAGE_RULE, agentCapabilities } from '../lib/config.mjs';
import { SHELL_PARTS } from '../lib/shellhtml.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(REPO, 'web/lang.js'), 'utf8');

const WIN = new WeakMap(); const globalThisOf = (L) => WIN.get(L);
function palang({ language = 'en-US', stored = null, both = false, shown = null } = {}) {
  const store = new Map(stored ? [['pa_lang', stored]] : []);
  const ctx = { navigator: { language, languages: [language] }, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    document: { readyState: 'complete', documentElement: null }, addEventListener() {}, setTimeout };
  if (shown) for (const k of ['alert', 'confirm', 'prompt']) ctx[k] = (...a) => { shown.push([k, ...a]); return k === 'confirm' ? true : 'typed'; };
  ctx.window = ctx;
  const src = script.split('/*PA_LANG_BOTH*/false').join(String(both));
  vm.runInNewContext(src, ctx);
  WIN.set(ctx.PALang, ctx);
  return { L: ctx.PALang, store };
}

test('the device language is the default: zh* → 中文, anything else → English', () => {
  assert.equal(palang({ language: 'zh-CN' }).L.get(), 'zh');
  assert.equal(palang({ language: 'zh-Hant-TW' }).L.get(), 'zh');
  assert.equal(palang({ language: 'en-GB' }).L.get(), 'en');
  assert.equal(palang({ language: 'fr-FR' }).L.get(), 'en');
  assert.equal(palang({ language: 'zh-CN', stored: 'en' }).L.get(), 'en', 'a choice kept on this device wins');
});

test('native pop-ups show only the chosen language; prompt keeps its default value and every return value', () => {
  for (const [language, want] of [['en-US', 'Delete this chat?'], ['zh-CN', '删除这个对话？']]) {
    const shown = []; const { L } = palang({ language, shown });
    assert.equal(L.get(), language === 'en-US' ? 'en' : 'zh');
    assert.equal(globalThisOf(L).confirm('删除这个对话？ · Delete this chat?'), true);
    globalThisOf(L).alert('移除失败 · Remove failed');
    assert.equal(globalThisOf(L).prompt('已添加 Ada。把这个登录码交给对方 · Added Ada. Give them this sign-in code', 'abc · 码'), 'typed');
    assert.deepEqual(shown[0], ['confirm', want]);
    assert.equal(shown[1][1], language === 'en-US' ? 'Remove failed' : '移除失败');
    assert.equal(shown[2][2], 'abc · 码', 'the default value (a sign-in code) is never switched');
    globalThisOf(L).alert('plain English only'); assert.equal(shown[3][1], 'plain English only', 'CONTROL: a single-language message is untouched');
  }
});

test('t() picks the chosen side of a pair or a "中文 · English" string', () => {
  const { L } = palang({ language: 'en-US' });
  assert.equal(L.t(['主页', 'Home']), 'Home');
  assert.equal(L.t('关闭提示 · Dismiss tip'), 'Dismiss tip');
  assert.equal(L.t('  更多 · More (3) '), '  More (3) ', 'surrounding space is kept');
  assert.equal(L.t('⚠ 出错了 · Failed'), '⚠ Failed', 'a leading symbol stays');
  assert.equal(L.t('Tue · Nov 24'), 'Tue · Nov 24', 'no 中文 side: unchanged');
  assert.equal(L.t('圣经 · 和合本'), '圣经 · 和合本', 'no English side: unchanged');
  assert.equal(L.t(['', 'Only English']), 'Only English');
  assert.equal(L.t('AI answers come from cloud models. · AI 回答来自云端模型。'), 'AI answers come from cloud models.', 'English-first pair (the live demo notice)');
  assert.equal(L.t('Sign-in is not set up yet · 登录尚未配置'), 'Sign-in is not set up yet');
  assert.equal(L.t('Tue · Nov 24 · 周二'), 'Tue · Nov 24', 'English-first, several English parts');
  L.set('zh');
  assert.equal(L.t('AI answers come from cloud models. · AI 回答来自云端模型。'), 'AI 回答来自云端模型。');
  assert.equal(L.t(['主页', 'Home']), '主页');
  assert.equal(L.t('新：在这里切换语言 · New: switch the language here'), '新：在这里切换语言');
  assert.equal(L.t(['', 'Only English']), 'Only English', 'a missing side falls back to the other');
});

test('set() refuses junk, keeps the choice on the device and tells listeners', () => {
  const { L, store } = palang({ language: 'en-US' });
  const seen = []; L.on((l) => seen.push(l));
  assert.equal(L.set('fr'), false); assert.equal(L.get(), 'en');
  assert.equal(L.set('zh'), true); assert.equal(store.get('pa_lang'), 'zh');
  assert.deepEqual(seen, ['zh']);
});

test('a bilingual page shows both; no node-wide both-at-once default exists', () => {
  const b = palang({ both: true }).L;
  assert.equal(b.get(), 'both'); assert.equal(b.t(['圣经', 'Bible']), '圣经 · Bible');
  b.set('en'); assert.equal(b.get(), 'both', 'a bilingual app stays bilingual whatever is chosen');
  assert.ok(!script.includes('PA_LANG_DEFAULT'), 'the test-only both-default is gone: tests run what real nodes run');
  assert.ok(!fs.readFileSync(path.join(REPO, 'test/helpers-web.mjs'), 'utf8').includes('ui_lang_default'), 'the harness config matches a real node');
});

test('server: profile values, bilingual apps, the reply rule', () => {
  assert.equal(langOf('zh'), 'zh'); assert.equal(langOf('EN'), ''); assert.equal(langOf(undefined), '');
  assert.equal(replyLanguageRule('en'), REPLY_IN.en); assert.equal(replyLanguageRule('zh'), REPLY_IN.zh);
  assert.equal(replyLanguageRule(''), REPLY_LANGUAGE_RULE, 'no setting: follow the writer, as before');
  assert.equal(turnLang({ sent: 'en', saved: 'zh' }), 'en', "the page's word first");
  assert.equal(turnLang({ sent: undefined, saved: 'zh' }), 'zh', 'else the account');
  assert.equal(turnLang({ sent: 'both', saved: 'zh' }), '', 'a bilingual page');
  assert.equal(turnLang({ sent: 'en', saved: 'en', bilingual: true }), '', 'a bilingual app, whatever was sent');
  assert.ok(agentCapabilities('owner', null, REPLY_IN.en).startsWith(REPLY_IN.en), 'the agent lane carries the line');
  assert.ok(agentCapabilities('owner').startsWith(REPLY_LANGUAGE_RULE), 'default unchanged');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-lang-'));
  try {
    fs.mkdirSync(path.join(dir, 'study')); fs.writeFileSync(path.join(dir, 'study', 'meta.json'), '{"bilingual":true}');
    fs.mkdirSync(path.join(dir, 'tasks')); fs.writeFileSync(path.join(dir, 'tasks', 'meta.json'), '{"title":"Tasks"}');
    assert.ok(BILINGUAL_APPS.includes('bible'));
    assert.equal(appIsBilingual(dir, 'bible'), true, 'by slug: an old meta.json still counts');
    assert.equal(appIsBilingual(dir, 'study'), true, 'by meta.json');
    assert.equal(appIsBilingual(dir, 'tasks'), false);
    assert.equal(appIsBilingual(dir, '../x'), false);
    assert.equal(appIsBilingual(dir, undefined), false);
    assert.equal(appIsBilingual(dir, 'Study'), false, 'not a canonical slug (slugOk)');
    fs.mkdirSync(path.join(dir, 'linked')); fs.symlinkSync(path.join(dir, 'study', 'meta.json'), path.join(dir, 'linked', 'meta.json'));
    assert.equal(appIsBilingual(dir, 'linked'), false, 'a symlinked meta.json is not followed');
    fs.mkdirSync(path.join(dir, 'huge')); fs.writeFileSync(path.join(dir, 'huge', 'meta.json'), '{"bilingual":true,"x":"' + 'a'.repeat(70 * 1024) + '"}');
    assert.equal(appIsBilingual(dir, 'huge'), false, 'an oversized meta.json is not read');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the shell and every app page carry the SAME lang file', () => {
  assert.ok(SHELL_PARTS.some(([m, f]) => m === '/* PA_LANG_JS */' && f === 'lang.js'));
  const web = fs.readFileSync(path.join(REPO, 'web.mjs'), 'utf8');
  assert.match(web, /html\.split\(PA_LANG_MARKER\)\.join\('<script id="pa-lang-script">' \+ lj/, 'app pages get web/lang.js itself');
  assert.match(web, /\(m\) => PA_LANG_MARKER \+ m\)/, 'on every app page, ahead of its own first script');
});

test('the research job phrases its answer in the owner\'s language: the tool hands the user to the lane, the lane adds the line', async () => {
  const { makeRunner } = await import('../lib/jobs/run.mjs');
  const { buildResearchPrompt } = await import('../lib/research.mjs');
  const seen = [];
  const run = makeRunner(undefined, { research: async (q, model, user) => { seen.push([q, model, user && user.id]); return { ok: true, text: 'answer' }; } });
  await run({ id: 'u1' }, { name: 'j', plan: { kind: 'tool', tool: 'research', args: { question: 'q?' } } });
  assert.deepEqual(seen, [['q?', null, 'u1']], 'the user reaches the research lane');
  assert.ok(buildResearchPrompt({ question: 'q', sources: [], guide: REPLY_IN.en }).includes(REPLY_IN.en), 'the line rides as the guide');
  const web = fs.readFileSync(path.join(REPO, 'web.mjs'), 'utf8');
  assert.match(web, /guide: user \? userLangRule\(user\) : ''/, 'web.mjs: the job lane uses the account language');
  assert.match(web, /model: lane\.model, guide: langRule,/, 'web.mjs: the chat research lane uses the turn language');
  assert.match(web, /runCodexLane\(\{[^}]*langRule,/, 'web.mjs: the Codex lane gets the line');
});
