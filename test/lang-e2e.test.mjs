// The ONE language setting · 界面语言, in a real browser (R6) on a throwaway node: the device language is the
// default; the ☰ drawer's 中 / EN switch flips the home, the drawer, the first-use tips and an open app LIVE;
// the choice survives a reload and reaches a fresh device through the account; the Bible app stays bilingual;
// the AI turn carries the language line. PA_E2E_ENGINE=webkit runs it in iPhone Safari's engine (390 wide).
// No Playwright: FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, waitFor, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { REPLY_IN } from '../lib/ui-lang.mjs';
import { REPLY_LANGUAGE_RULE } from '../lib/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = [{ id: 'deepseek', label: 'DeepSeek', group: 'Fast', provider: 'ollama', model: 'fake-fast' }];
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };
let port, root, web, browser, ollama;
const systems = [];   // every fast-lane turn's system messages, as the stub model received them

function startOllamaStub() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }).on('end', () => {
      try { systems.push(JSON.parse(b).messages.filter((m) => m.role === 'system').map((m) => m.content)); } catch { /* a non-chat probe: nothing to record */ }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'OK' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

before(async () => {
  ollama = await startOllamaStub();
  port = await freePort();
  // ui_lang_default '': the real product default (the device decides), not the harness's both-at-once.
  root = mkWebRoot({ port, extraConfig: { ui_lang_default: '', ollama_url: `http://127.0.0.1:${ollama.address().port}`, chat_models: MODELS, task_timeout_minutes: 1 } });
  fs.cpSync(path.join(REPO, 'workspace.example', 'apps'), path.join(root, 'workspace', 'apps'), { recursive: true });
  web = startWeb(root); await waitReady(port);
  if (skip) return;
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (ollama) ollama.close(); if (root) rmTemp(root); });

const profile = async (body) => (await fetch(`http://127.0.0.1:${port}/api/profile`, { method: body ? 'PUT' : 'GET',
  headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();

async function open(locale, opts = {}) {
  const sess = (await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER_TOKEN }) })).json()).token;
  const c = await browser.newContext({ ...PHONE, locale, ...opts });
  await c.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* sandboxed frame */ } }, sess);
  const page = await c.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#hStart .st');
  return { c, page };
}
const lang = (page) => page.evaluate(() => document.documentElement.dataset.paLang);
const shown = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.trim() : null; }, sel);
async function openDrawer(page) { await page.evaluate(() => openDrawer()); await page.waitForSelector('#drawer.open'); await page.waitForTimeout(250); }

test('the device language is the default: 中文 device → 中文 only, English device → English only', { skip, timeout: 90000 }, async () => {
  await profile({ lang: '' });
  for (const [locale, want, home, myApps] of [['zh-CN', 'zh', '主页', '我的应用'], ['en-US', 'en', 'Home', 'My Apps']]) {
    const { c, page } = await open(locale);
    try {
      assert.equal(await lang(page), want, locale);
      assert.equal(await page.getAttribute('#goHome', 'title'), home, `${locale}: a title attribute shows one language`);
      await openDrawer(page);
      assert.equal(await shown(page, '#goHome'), home, `${locale}: the drawer's Home`);
      assert.equal(await shown(page, '#secApps .dsec-l'), myApps, `${locale}: a <b>中文</b><span class=en> pair shows one side`);
      assert.doesNotMatch(await shown(page, '#hStart'), want === 'en' ? /[一-鿿]/ : /Journal|Tasks/, `${locale}: the home tiles`);
      assert.ok(!(await shown(page, '#hHello')).includes(' · '), `${locale}: the greeting is one language`);
    } finally { await c.close(); }
  }
});

test('the drawer switch flips home, drawer, tips and an open app live; persists across reload and via the account', { skip, timeout: 120000 }, async () => {
  await profile({ lang: '' });
  const { c, page } = await open('en-US');
  try {
    // Every other shell tip already seen on the account, so the switch's own tip is the one that shows.
    const others = await page.evaluate(() => window.PATips.registered().map((r) => r.id).filter((id) => id !== 'tip:lang-switch'));
    await profile({ tipsSeen: [] }); await profile({ tipsSeen: others });
    await page.reload(); await page.waitForSelector('#hStart .st');
    await openDrawer(page);
    const tip = page.locator('.pat-tip[data-tip="tip:lang-switch"]');
    await tip.waitFor({ state: 'attached', timeout: 8000 });   // the switch's first-use tip must show (ADR 0030)
    assert.equal((await tip.innerText()).replace('✕', '').trim(), 'New: switch the language here', 'the new tip, in English only');
    // The 390 phone: the switch is a full tap target inside the drawer.
    const box = await page.locator('#langSw').boundingBox(); assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
    await page.evaluate(() => PALangSwitch.choose('zh'));   // the tip sits on the switch; the tap path is below
    assert.equal(await lang(page), 'zh');
    assert.equal(await shown(page, '#goHome'), '主页', 'drawer, no reload');
    assert.equal(await shown(page, '#secApps .dsec-l'), '我的应用');
    assert.equal((await tip.innerText()).replace('✕', '').trim(), '新：在这里切换语言', 'the tip on screen flips too');
    await page.locator('.pat-tip .pat-x').click();
    await page.click('#langSw [data-l="en"]'); assert.equal(await lang(page), 'en', 'a tap on EN');
    await page.click('#langSw'); assert.equal(await lang(page), 'zh', 'a tap on the switch toggles');
    assert.match(await shown(page, '#hStart'), /[一-鿿]/, 'home tiles');
    assert.doesNotMatch(await shown(page, '#hStart'), /Journal|Tasks|Bible\b/);
    await waitFor(async () => (await profile()).lang === 'zh', 'saved on the account');
    // An open app follows at once: Tasks (bilingual chrome from the shared components), then back to English.
    await page.evaluate(() => closeDrawer());
    await page.evaluate(() => openApp(UID, 'tasks', 'Tasks'));
    const fr = page.frameLocator('#fr');
    await waitFor(() => fr.locator('html').getAttribute('data-pa-lang').then((v) => v === 'zh').catch(() => false), 'the app frame is 中文');
    await page.evaluate(() => PALangSwitch.choose('en'));
    await waitFor(() => fr.locator('html').getAttribute('data-pa-lang').then((v) => v === 'en').catch(() => false), 'the app frame flips live');
    const frameText = await fr.locator('body').evaluate((b) => [...b.querySelectorAll('[title],[aria-label],[placeholder]')].map((e) => e.getAttribute('title') || e.getAttribute('aria-label') || e.getAttribute('placeholder')).join('\n'));
    assert.doesNotMatch(frameText, /[一-鿿][^\n]* · [A-Za-z]/, 'no "中文 · English" label left in the app');
    await page.evaluate(() => PALangSwitch.choose('zh'));
    await waitFor(async () => (await profile()).lang === 'zh', 'saved again');
    await page.reload(); await page.waitForSelector('#hStart .st');
    assert.equal(await lang(page), 'zh', 'kept across a reload');
  } finally { await c.close(); }
  // A fresh device (no local copy) whose language is English: the account's 中文 wins.
  const fresh = await open('en-US');
  try { await waitFor(async () => (await lang(fresh.page)) === 'zh', 'the account choice reaches a new device'); assert.equal(await shown(fresh.page, '#goHome') !== null, true); }
  finally { await fresh.c.close(); }
});

test('the Bible app stays bilingual whatever is chosen', { skip, timeout: 90000 }, async () => {
  await profile({ lang: 'en' });
  const { c, page } = await open('en-US');
  try {
    assert.equal(await lang(page), 'en');
    await page.evaluate(() => openApp(UID, 'bible', 'Bible'));
    const fr = page.frameLocator('#fr');
    await waitFor(() => fr.locator('html').getAttribute('data-pa-lang').then((v) => v === 'both').catch(() => false), 'Bible is bilingual');
    await page.evaluate(() => PALangSwitch.choose('zh'));
    await page.waitForTimeout(300);
    assert.equal(await fr.locator('html').getAttribute('data-pa-lang'), 'both', 'still both after a switch');
  } finally { await c.close(); }
});

test('the AI turn carries the language line; a bilingual app keeps following the writer', { skip, timeout: 90000 }, async () => {
  await profile({ lang: 'en' });
  const { c, page } = await open('zh-CN');
  try {
    await waitFor(async () => (await lang(page)) === 'en', 'the account says English');
    const n = systems.length;
    await page.fill('#box', '你好'); await page.keyboard.press('Enter');
    await waitFor(() => systems.length > n, 'the fast lane was called');
    assert.ok(systems[n].includes(REPLY_IN.en), 'English chosen: the English line rides, even for a 中文 message');
    assert.ok(!systems[n].includes(REPLY_LANGUAGE_RULE));
  } finally { await c.close(); }
  const m = systems.length;
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'John 3:16', app: 'bible', lang: 'en', model: 'deepseek' }) });
  await r.text();
  await waitFor(() => systems.length > m, 'the Bible turn ran');
  assert.ok(systems[m].includes(REPLY_LANGUAGE_RULE) && !systems[m].includes(REPLY_IN.en), 'Bible: the follow-the-writer rule, not the setting');
});

test('the account refuses a junk language loudly and "" goes back to the device', async () => {
  const bad = await fetch(`http://127.0.0.1:${port}/api/profile`, { method: 'PUT', headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ lang: 'fr' }) });
  assert.equal(bad.status, 400);
  await profile({ lang: 'zh' }); assert.equal((await profile()).lang, 'zh');
  await profile({ lang: '' }); assert.equal((await profile()).lang, '');
});
