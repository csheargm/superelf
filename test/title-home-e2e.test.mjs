// Header title = Home（标题回主页）+ desktop chat clearance（桌面聊天不被挡）— owner desktop Chrome 2026-11-25 (v5.27.1):
// "clicking top left 管家 should go to home page"; the title drew "Ada’  s 管家" with a gap after the curly
// apostrophe; and the 'Claude ▾' / '校验 · Verify' chips sat on the last reply's copy/speak/retry buttons and its
// 'took …' line. Real flow with a FAKE `claude` agent: two real turns, then
//   1) the title goes Home by mouse, Enter and tap — from a chat, from an open app and from settings — and Back works;
//   2) the apostrophe's glyph sits flush between the name and the 's' (glyph positions measured, not font-size);
//   3) after scrolling to the end the last reply's action buttons and meta line are the element hit at their centres,
//      and the last message ends above the composer, at 1000 / 1280 / 1680 wide and iPad (820x1180 touch).
// Known limits: Chromium on macOS fonts here; the owner's Windows fallback font is not installed in CI, so (2) pins the
// mechanism (the name part never takes a CJK font) plus a geometric check in the fonts this machine has.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { composerClearance, clearanceFailures, SHELL_CLEAR_SEL, coveredActions } from './helpers-phone-check.mjs';

const SHOTS = process.env.PA_SHOTS || '';
const LONG = 'I could not find a sentencing date. ' + 'None of the coverage I read gives one, so it may not be set yet. '.repeat(14);
const FAKE = `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-1' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: ${JSON.stringify(LONG)}, session_id: 'sid-1' }) + '\\n');
});
`;
const SIZES = [['1000', { viewport: { width: 1000, height: 800 } }], ['1280', { viewport: { width: 1280, height: 800 } }],
  ['1680', { viewport: { width: 1680, height: 1000 } }], ['iPad', { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true }]];

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, users: [{ id: 'owner', name: 'Ada', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json'); const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE); fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const app = path.join(root, 'workspace', 'apps', 'demo'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><meta charset="utf-8"><h1>Demo</h1>');
  fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Demo' }));
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

async function signIn(ctxOpts) {
  const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`); await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]') && document.querySelector('#dot.ok'));
  await page.evaluate(() => document.querySelectorAll('.pat-tip').forEach((t) => t.remove()));
  // The owner's node offers models, so the chips row ('Claude ▾' + '校验 · Verify') shows; the bare test node has none.
  await page.evaluate(() => { CHAT_MODELS = [{ id: 'claude', label: 'Claude' }, { id: 'gpt', label: 'GPT' }]; syncShellModel(); });
  return { ctx, page, errors };
}
async function ask(page, q) {
  const n = await page.locator('#log .mab').count();
  await page.fill('#box', q); await page.press('#box', 'Enter');
  await page.waitForFunction((k) => document.querySelectorAll('#log .mab').length > k + 2 && /took/.test(document.querySelector('#log').textContent), n, { timeout: 20000 });
}
const atHome = (page) => page.evaluate(() => document.body.classList.contains('home-on') && !document.querySelector('#log').children.length && getComputedStyle(document.querySelector('#frame')).display === 'none');

test('the header title is a Home control: mouse, Enter, tap; from a chat, an app and settings; Back works', { skip, timeout: 120000 }, async () => {
  const { ctx, page, errors } = await signIn({ viewport: { width: 1000, height: 800 }, hasTouch: true });
  try {
    const t = page.locator('#hTitle');
    assert.equal(await t.getAttribute('aria-label'), '回到主页');
    assert.equal(await t.evaluate((e) => getComputedStyle(e).cursor), 'pointer');
    await page.waitForFunction(() => document.body.classList.contains('home-on'), null, { timeout: 5000 }).catch(() => {});
    assert.ok(await atHome(page), 'starts at Home');
    await ask(page, 'when is the sentencing');
    assert.ok(!(await atHome(page)), 'CONTROL: a conversation is open');
    await t.click(); await page.waitForFunction(() => document.body.classList.contains('home-on'));
    assert.ok(await atHome(page), 'mouse click from a chat goes Home');
    await ask(page, 'a second chat');
    await t.focus(); await page.keyboard.press('Enter'); await page.waitForFunction(() => document.body.classList.contains('home-on'));
    assert.ok(await atHome(page), 'Enter from a chat goes Home');
    await page.evaluate(() => openApp('owner', 'demo', 'Demo')); await page.waitForFunction(() => getComputedStyle(document.querySelector('#frame')).display !== 'none');
    await page.evaluate(() => document.querySelector('#hTitle').click());   // the shell header is inert behind an app; its own bar's Home is the visible way, but a click must still go Home
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#frame')).display === 'none');
    assert.ok(await atHome(page), 'from an open app');
    // History as the other Home controls (v5.22.8): the app's entry is stepped off, so Back never lands on the closed app.
    await page.waitForFunction(() => !(history.state && history.state.paApp));
    await page.click('#hmore'); await page.click('#settings'); await page.waitForSelector('dialog[open]');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await ask(page, 'again');
    await page.click('#hmore'); await page.click('#settings'); await page.waitForSelector('dialog[open]');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await t.click(); await page.waitForFunction(() => document.body.classList.contains('home-on'));
    assert.ok(await atHome(page), 'from settings (closed) back to Home');
    await ask(page, 'once more');
    await t.tap(); await page.waitForFunction(() => document.body.classList.contains('home-on'));
    assert.ok(await atHome(page), 'a tap from a chat goes Home');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'title-home-after.png') });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('the apostrophe in "<name>’s 管家" sits flush: no gap wider than a space either side', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await signIn({ viewport: { width: 1000, height: 800 } });
  try {
    const m = await page.evaluate(() => {
      const h = document.querySelector('header h1'); const txt = h.textContent; const i = txt.indexOf('’');
      const node = [...h.querySelectorAll('*'), h].flatMap((e) => [...e.childNodes]).find((n) => n.nodeType === 3 && n.data.includes('’'));
      const j = node.data.indexOf('’'); const r = (a, b) => { const x = document.createRange(); x.setStart(node, a); x.setEnd(node, b); return x.getBoundingClientRect(); };
      const sp = document.createElement('span'); sp.textContent = 'n n'; h.append(sp); const sw = (() => { const x = document.createRange(); x.setStart(sp.firstChild, 1); x.setEnd(sp.firstChild, 2); return x.getBoundingClientRect().width; })(); sp.remove();
      const ap = r(j, j + 1), sL = r(j + 1, j + 2), prev = r(j - 1, j);
      return { txt, i, apW: ap.width, before: ap.left - prev.right, after: sL.left - ap.right, fs: parseFloat(getComputedStyle(h).fontSize), space: sw,
        nameFont: getComputedStyle(node.parentElement).fontFamily };
    });
    assert.equal(m.txt.replace(/\s+/g, ' '), 'Ada’s 管家');
    assert.ok(m.apW < m.fs * 0.45, `apostrophe glyph is ${m.apW.toFixed(1)}px at ${m.fs}px font (a full-width CJK glyph is ~1em)`);
    assert.ok(Math.abs(m.before) < 1 && Math.abs(m.after) < 1, `no gap around the apostrophe: ${m.before}/${m.after}`);
    // The mechanism: the name part's stack lists Latin fonts (Segoe UI for Windows) before any CJK font (YaHei drew ’ full-width).
    const fams = m.nameFont.split(',').map((f) => f.trim().replace(/"/g, ''));
    const cjk = fams.findIndex((f) => /PingFang|Hiragino|Noto Sans SC|YaHei/i.test(f));
    assert.ok(fams.indexOf('Segoe UI') >= 0 && (cjk < 0 || fams.indexOf('Segoe UI') < cjk), 'Latin before CJK for the name: ' + m.nameFont);
    if (SHOTS) await page.locator('header').screenshot({ path: path.join(SHOTS, 'title-apostrophe.png') });
  } finally { await ctx.close(); }
});

for (const [label, opts] of SIZES) test(`${label}: the last reply's actions and meta line are never under the chips row or composer`, { skip, timeout: 90000 }, async () => {
  const { ctx, page } = await signIn(opts);
  try {
    await ask(page, 'when is the sentencing'); await ask(page, 'and the date');
    assert.ok(await page.evaluate(() => getComputedStyle(document.querySelector('#shellModel')).display !== 'none'), 'CONTROL: the chips row shows');
    await page.waitForTimeout(400);
    const c = await page.evaluate(composerClearance, SHELL_CLEAR_SEL);
    const bad = clearanceFailures(label, c);
    const cov = await page.evaluate(coveredActions, '#log');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `chat-end-${label}.png`) });
    assert.ok(cov.checked >= 4, `CONTROL: last reply's action buttons + meta measured (${cov.checked})`);
    assert.deepEqual([...bad, ...cov.covered], []);
  } finally { await ctx.close(); }
});
