// The ONE language setting · 界面语言 (lib/ui-lang.mjs, web/lang.inline.html): unit checks on the server
// rules and on PALang's string helpers (run in a vm, no DOM). The browser flows are test/lang-e2e.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { langOf, appIsBilingual, replyLanguageRule, turnLang, withLangDefault, REPLY_IN, BILINGUAL_APPS } from '../lib/ui-lang.mjs';
import { REPLY_LANGUAGE_RULE, agentCapabilities } from '../lib/config.mjs';
import { SHELL_PARTS } from '../lib/shellhtml.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(REPO, 'web/lang.inline.html'), 'utf8');
const script = SRC.slice(SRC.indexOf('<script id="pa-lang-script">') + 28, SRC.lastIndexOf('</script>'));

function palang({ language = 'en-US', stored = null, both = false, dflt = '' } = {}) {
  const store = new Map(stored ? [['pa_lang', stored]] : []);
  const ctx = { navigator: { language, languages: [language] }, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    document: { readyState: 'complete', documentElement: null }, addEventListener() {}, setTimeout };
  ctx.window = ctx;
  const src = withLangDefault(script.split('/*PA_LANG_BOTH*/false').join(String(both)), { ui_lang_default: dflt });
  vm.runInNewContext(src, ctx);
  return { L: ctx.PALang, store };
}

test('the device language is the default: zh* → 中文, anything else → English', () => {
  assert.equal(palang({ language: 'zh-CN' }).L.get(), 'zh');
  assert.equal(palang({ language: 'zh-Hant-TW' }).L.get(), 'zh');
  assert.equal(palang({ language: 'en-GB' }).L.get(), 'en');
  assert.equal(palang({ language: 'fr-FR' }).L.get(), 'en');
  assert.equal(palang({ language: 'zh-CN', stored: 'en' }).L.get(), 'en', 'a choice kept on this device wins');
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
  L.set('zh');
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

test('a bilingual page and a both-default node show both until a choice', () => {
  const b = palang({ both: true }).L;
  assert.equal(b.get(), 'both'); assert.equal(b.t(['圣经', 'Bible']), '圣经 · Bible');
  b.set('en'); assert.equal(b.get(), 'both', 'a bilingual app stays bilingual whatever is chosen');
  const d = palang({ dflt: 'both' }).L;
  assert.equal(d.get(), 'both'); d.set('en'); assert.equal(d.get(), 'en', 'the first choice ends the both-default');
  assert.equal(palang({ dflt: 'both', stored: 'zh' }).L.get(), 'zh');
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
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the shell and every app page carry the SAME lang file', () => {
  assert.ok(SHELL_PARTS.some(([m, f]) => m === '<!--PA_LANG_UI-->' && f === 'lang.inline.html'));
  const web = fs.readFileSync(path.join(REPO, 'web.mjs'), 'utf8');
  assert.match(web, /marker: PA_LANG_MARKER, file: 'lang\.inline\.html'/);
  assert.match(web, /\(m\) => PA_LANG_MARKER \+ PA_TWO_TAP_MARKER/, 'on every app page, first');
});
