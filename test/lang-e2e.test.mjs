// The ONE language setting · 界面语言, in a real browser (R6) on a throwaway node: the device language is the
// default; the home ⋯ menu's language row flips the home, the drawer, the first-use tips and an open app LIVE;
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
  root = mkWebRoot({ port, extraConfig: { ollama_url: `http://127.0.0.1:${ollama.address().port}`, chat_models: MODELS, task_timeout_minutes: 1 } });
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
async function openMore(page) { if (await page.locator('#hmenu').isHidden()) await page.click('#hmore'); await page.waitForSelector('#hmenu:not([hidden]) #langSw'); }
const row = (page) => shown(page, '#langSw .hm-l');
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

test('the ⋯ menu language row flips home, drawer, menu, tips and an open app live; persists across reload and via the account', { skip, timeout: 120000 }, async () => {
  await profile({ lang: '' });
  const { c, page } = await open('en-US');
  try {
    // Every other shell tip already seen on the account, so the row's own tip is the one that shows.
    const others = await page.evaluate(() => window.PATips.registered().map((r) => r.id).filter((id) => id !== 'tip:lang-switch'));
    await profile({ tipsSeen: [] }); await profile({ tipsSeen: others });
    await page.reload(); await page.waitForSelector('#hStart .st');
    assert.equal(await page.locator('#drawer #langSw, .dlang').count(), 0, 'one control: no drawer-foot switch');
    const tip = page.locator('.pat-tip[data-tip="tip:lang-switch"]');
    await tip.waitFor({ state: 'attached', timeout: 8000 });   // the row's first-use tip, on the ⋯ button (ADR 0030)
    assert.equal((await tip.innerText()).replace('✕', '').trim(), 'New: switch the language in ⋯', 'the new tip, in English only');
    await page.evaluate(() => PALangSwitch.choose('zh'));
    assert.equal((await tip.innerText()).replace('✕', '').trim(), '新：在 ⋯ 里切换语言', 'the tip on screen flips too');
    await page.evaluate(() => PALangSwitch.choose('en'));
    await page.locator('.pat-tip .pat-x').click();
    await openMore(page);
    // The row sits right after Text size and names the OTHER language; a full tap target on the 390 phone.
    assert.equal(await page.evaluate(() => document.querySelector('#hmenu .aa').nextElementSibling.id), 'langSw', 'right after Text size');
    assert.equal(await row(page), '中文', 'English mode: the row offers 中文');
    assert.equal(await shown(page, '#reload .hm-l'), 'Refresh', 'menu rows in English');
    const box = await page.locator('#langSw').boundingBox(); assert.ok(box.height >= 40 && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
    await page.click('#langSw'); assert.equal(await lang(page), 'zh', 'a real tap switches');
    assert.ok(await page.locator('#hmenu').isVisible(), 'the menu stays open');
    assert.equal(await row(page), 'English', '中文 mode: the row offers English');
    assert.equal(await shown(page, '#reload .hm-l'), '刷新', 'menu rows flip live');
    assert.equal(await shown(page, '#settings .hm-l'), '设置');
    assert.equal(await page.getAttribute('#langSw', 'aria-label'), '语言');
    await page.click('#langSw'); assert.equal(await lang(page), 'en', 'a tap flips back');
    await page.click('#langSw'); assert.equal(await lang(page), 'zh');
    await openDrawer(page);
    assert.equal(await shown(page, '#goHome'), '主页', 'drawer, no reload');
    assert.equal(await shown(page, '#secApps .dsec-l'), '我的应用');
    await page.evaluate(() => closeDrawer());
    assert.match(await shown(page, '#hStart'), /[一-鿿]/, 'home tiles');
    assert.doesNotMatch(await shown(page, '#hStart'), /Journal|Tasks|Bible\b/);
    await waitFor(async () => (await profile()).lang === 'zh', 'saved on the account');
    // An open app follows at once: Tasks (bilingual chrome from the shared components), then back to English.
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
    await openMore(page); assert.equal(await row(page), 'English', 'the row after a reload');
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

test('GPT review fixes: control attributes, the 中文 date, a note text layer, ordered saves, sign-out', { skip, timeout: 120000 }, async () => {
  await profile({ lang: 'zh' });
  const { c, page } = await open('en-US');
  try {
    await waitFor(async () => (await lang(page)) === 'zh', 'the account says 中文');
    const phs = await page.evaluate(() => [...document.querySelectorAll('input[placeholder],textarea[placeholder]')].map((e) => e.placeholder).filter((v) => / · /.test(v) && /[一-鿿]/.test(v) && /[A-Za-z]/.test(v)));
    assert.deepEqual(phs, [], 'no "中文 · English" placeholder left on an input: ' + JSON.stringify(phs));
    assert.equal(await page.getAttribute('#csInp', 'placeholder'), '搜索对话', 'the drawer search placeholder');
    const date = await page.evaluate(() => { const e = document.querySelector('#hHello .en'); return e ? getComputedStyle(e).display !== 'none' && e.innerText.trim() : false; });
    assert.ok(date && /[一-鿿]/.test(date), '中文 mode: the 中文 date line is visible, not hidden as English: ' + date);
    // A text layer outside the T tool (contenteditable=false) holds what the person wrote: never switched.
    const kept = await page.evaluate(async () => { const d = document.createElement('div'); d.className = 'pan-textlayer'; d.contentEditable = 'false';
      d.textContent = '我的笔记 · My note'; document.body.append(d); await new Promise((r) => setTimeout(r, 50)); const v = d.textContent; d.remove(); return v; });
    assert.equal(kept, '我的笔记 · My note', 'note text is the person\'s, untouched');
    // Two quick choices: the account ends on the LAST one even when the first PUT is slow.
    await page.route('**/api/profile', async (route) => { const b = route.request().postData() || ''; if (route.request().method() === 'PUT' && b.includes('"en"')) await new Promise((r) => setTimeout(r, 600)); await route.continue(); });
    await page.evaluate(() => { PALangSwitch.choose('en'); PALangSwitch.choose('zh'); });
    await page.waitForTimeout(1200);
    assert.equal((await profile()).lang, 'zh', 'saves run in tap order');
    await page.unroute('**/api/profile');
    // Sign-out leaves no language behind for the next account on this browser.
    await Promise.all([page.waitForEvent('load'), page.evaluate(() => { logout(); })]);
    assert.equal(await page.evaluate(() => localStorage.getItem('pa_lang')), null, 'sign-out clears the device copy');
  } finally { await c.close(); }
  // An account with no choice yet adopts the one made on this device (before sign-in).
  await profile({ lang: '' });
  const pre = await open('en-US');
  try {
    await pre.page.evaluate(() => { localStorage.setItem('pa_lang', 'zh'); }); await pre.page.reload(); await pre.page.waitForSelector('#hStart .st');
    await waitFor(async () => (await profile()).lang === 'zh', 'the device choice reaches the account');
  } finally { await pre.c.close(); }
});

test('the account refuses a junk language loudly and "" goes back to the device', async () => {
  const bad = await fetch(`http://127.0.0.1:${port}/api/profile`, { method: 'PUT', headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ lang: 'fr' }) });
  assert.equal(bad.status, 400);
  await profile({ lang: 'zh' }); assert.equal((await profile()).lang, 'zh');
  await profile({ lang: '' }); assert.equal((await profile()).lang, '');
});

test('the ⋯ language row fits and is tappable on the iPad (820×1180) and the desktop (1280)', { skip, timeout: 90000 }, async () => {
  const sess = (await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER_TOKEN }) })).json()).token;
  for (const [width, height, hasTouch] of [[820, 1180, true], [1280, 800, false]]) {
    await profile({ lang: 'en' });   // a known start: the tap below must change it
    const c = await browser.newContext({ viewport: { width, height }, hasTouch, locale: 'en-US' });
    try {
      await c.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* sandboxed frame */ } }, sess);
      const page = await c.newPage(); await page.goto(`http://127.0.0.1:${port}/`); await page.waitForSelector('#hStart .st');
      await page.evaluate(() => document.querySelectorAll('.pat-tip .pat-x').forEach((x) => x.click()));
      await openMore(page);
      const m = await page.evaluate(() => { const sw = document.getElementById('langSw'), b = sw.getBoundingClientRect();
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return { b: { x: b.x, y: b.y, w: b.width, h: b.height }, inView: b.y >= 0 && b.y + b.height <= innerHeight && b.x >= 0 && b.x + b.width <= innerWidth, hit: !!hit && sw.contains(hit) }; });
      assert.ok(m.inView && m.hit && m.b.h >= 40, `${width}: ${JSON.stringify(m)}`);
      assert.equal(await row(page), '中文', `${width}: offers 中文`);
      await page.click('#langSw'); assert.equal(await lang(page), 'zh', `${width}: a real tap switches`);
      assert.equal(await shown(page, '#reload .hm-l'), '刷新', `${width}: the menu flips`);
      await waitFor(async () => (await profile()).lang === 'zh', 'saved');
      await page.reload(); await page.waitForSelector('#hStart .st');
      assert.equal(await lang(page), 'zh', `${width}: kept across a reload`);
    } finally { await c.close(); }
  }
});
