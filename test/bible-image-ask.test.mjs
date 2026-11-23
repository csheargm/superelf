// Owner 2026-11-15: a selected picture's ⋯ menu in a Bible note offers Ask AI, as the Journal's does.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const SRC = fs.readFileSync(new URL('../workspace/apps/bible/index.html', import.meta.url), 'utf8');
const code = SRC.slice(SRC.indexOf('const IMAGE_ASK_PROMPT'), SRC.indexOf('async function askAI(opts){'));

function run({ split = false, attachOk = true, sendOk = true } = {}) {
  const log = [];
  const chat = (name) => ({ open: async (k) => log.push(name + ' open ' + k), attach: (a) => { log.push(name + ' attach ' + a.path); return attachOk; },
    send: async (t) => { log.push(name + ' send ' + t.slice(0, 40)); return sendOk ? undefined : false; } });
  const ctx = { aiChat: chat('full'), railChat: chat('rail'), splitOn: () => split, scopeKey: () => 'k1', scopeRef: () => 'Romans 6:15',
    rail: { open: () => log.push('rail open'), expand: (s) => log.push('expand ' + s) }, annNotice: (t) => log.push('notice ' + t), NOTES_LIST_KEY: 'n', bookIdx: 44, chapter: 6 };
  vm.runInNewContext(code.replace('const IMAGE_ASK_PROMPT', 'var IMAGE_ASK_PROMPT') + ';this.ask=askAboutImage;', ctx);
  return { ask: ctx.ask, log };
}
test('the note pad is given onAskImage, so the picture menu shows Ask AI', () => {
  assert.match(SRC, /const NOTE_OPTS=\{\n  onAskImage:\(im\)=>askAboutImage\(im\),/);
});
test('full-screen: opens the verse chat, attaches the picture by path, sends the prompt with the reference', async () => {
  const r = run(); await r.ask({ path: 'uploads/p.jpg' });
  assert.deepEqual(r.log, ['full open k1', 'full attach uploads/p.jpg', 'full send Read this picture from my notes on Roman']);
});
test('split view: the rail chat is opened and used', async () => {
  const r = run({ split: true }); await r.ask({ path: 'uploads/p.jpg' });
  assert.deepEqual(r.log.slice(0, 4), ['rail open', 'expand chat', 'rail open k1', 'rail attach uploads/p.jpg']);
});
test('a refused attach or a busy chat says so (R5)', async () => {
  let r = run({ attachOk: false }); await r.ask({ path: 'x' }); assert.match(r.log.at(-1), /^notice 无法附加图片 · Could not attach/);
  r = run({ sendOk: false }); await r.ask({ path: 'x' }); assert.match(r.log.at(-1), /^notice 正在回答中 · Still answering/);
});
test('GPT 2026-11-15: the prompt reference is taken before the open await', async () => {
  const log = []; let ref = 'Romans 6:15', key = 'k1';
  const chat = { open: async () => { ref = 'Romans 7:1'; log.push('open'); }, attach: () => true, send: async (t) => { log.push(t); } };
  const ctx = { aiChat: chat, railChat: chat, splitOn: () => false, scopeKey: () => key, scopeRef: () => ref, rail: {}, annNotice: () => {}, NOTES_LIST_KEY: 'n', bookIdx: 44, chapter: 6 };
  vm.runInNewContext(code.replace('const IMAGE_ASK_PROMPT', 'var IMAGE_ASK_PROMPT') + ';this.ask=askAboutImage;', ctx);
  await ctx.ask({ path: 'p' }); assert.match(log[1], /Romans 6:15/);
});
test('GPT round 6: an open superseded by a verse change does not send the picture', async () => {
  const log = []; let key = 'k1';
  const chat = { open: async () => { key = 'k2'; }, attach: () => { log.push('attach'); return true; }, send: async () => { log.push('send'); } };
  const ctx = { aiChat: chat, railChat: chat, splitOn: () => false, scopeKey: () => key, scopeRef: () => 'Romans 6:15', rail: {}, annNotice: (t) => log.push('notice ' + t), NOTES_LIST_KEY: 'n', bookIdx: 44, chapter: 6 };
  vm.runInNewContext(code.replace('const IMAGE_ASK_PROMPT', 'var IMAGE_ASK_PROMPT') + ';this.ask=askAboutImage;', ctx);
  await ctx.ask({ path: 'p' }); assert.deepEqual(log, ['notice 选择已改变 · Selection changed — 请重新提问 · ask again']);
});
test('GPT round 7: a chat open superseded from the drawer (open() → false) does not send', async () => {
  const log = [];
  const chat = { open: async () => false, attach: () => { log.push('attach'); return true; }, send: async () => { log.push('send'); } };
  const ctx = { aiChat: chat, railChat: chat, splitOn: () => false, scopeKey: () => 'k1', scopeRef: () => 'Romans 6:15', rail: {}, annNotice: (t) => log.push('notice'), NOTES_LIST_KEY: 'n', bookIdx: 44, chapter: 6 };
  vm.runInNewContext(code.replace('const IMAGE_ASK_PROMPT', 'var IMAGE_ASK_PROMPT') + ';this.ask=askAboutImage;', ctx);
  await ctx.ask({ path: 'p' }); assert.deepEqual(log, ['notice']);
});
test('GPT round 11: askAI takes the passage before the open and stops if the selection moved', () => {
  for (const p of ['../workspace/apps/bible/index.html', '../workspace.example/apps/bible/index.html']) {
    const S = fs.readFileSync(new URL(p, import.meta.url), 'utf8');
    const body = S.slice(S.indexOf('async function askAI(opts){'), S.indexOf('\n}\n', S.indexOf('async function askAI(opts){')));
    assert.match(body, /const k=scopeKey\(\), ref=scopeRef\(\), b0=bookIdx, c0=chapter, moved=/, p); assert.match(body, /\n  const msg=/, p);
    assert.doesNotMatch(body, /\(scopeRef\(\)\)\)/, p);
    for (const l of body.split('\n').filter((x) => /await [a-zA-Z]*Chat\.open\(k\)/.test(x))) assert.match(l, /===false\|\|moved\(\)\) return;/, p);
  }
});
test('GPT round 14: the same verse number in another chapter during the open stops the picture ask', async () => {
  const log = [];
  const ctx = { splitOn: () => false, scopeKey: () => 'v4', scopeRef: () => 'Romans 6:4', rail: {}, annNotice: () => log.push('notice'), NOTES_LIST_KEY: 'n', bookIdx: 44, chapter: 6 };
  const chat = { open: async () => { ctx.chapter = 7; }, attach: () => { log.push('attach'); return true; }, send: async () => { log.push('send'); } };
  ctx.aiChat = chat; ctx.railChat = chat;
  vm.runInNewContext(code.replace('const IMAGE_ASK_PROMPT', 'var IMAGE_ASK_PROMPT') + ';this.ask=askAboutImage;', ctx);
  await ctx.ask({ path: 'p' }); assert.deepEqual(log, ['notice']);
});
