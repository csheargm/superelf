// The new look · 全新外观 (R6): one palette for the shell AND every app, inline SVG icons instead of emoji
// buttons, one "Aa" text-size control, home tiles with a coloured icon and the live number leading, and
// chats in the drawer grouped by day with 5 recent + 更多 · More. Unit checks on the pure helpers, then a
// real browser on a throwaway node. Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { SHELL } from './helpers-app.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // a file URL path, not .pathname (/D:/… on Windows)
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(read('web/icons.js') + read('web/home-look.js') + ';this.PAIcons=PAIcons;this.PAHomeLook=PAHomeLook;', ctx);
const { PAIcons, PAHomeLook } = ctx;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NOW = new Date(2026, 10, 24, 9, 30);   // Tue 24 Nov 2026, 09:30 local
const DAY = 864e5;

test('greeting and date are 中文 first, English beside', () => {
  assert.deepEqual([...PAHomeLook.greeting(NOW)], ['早安', 'Good morning']);
  assert.deepEqual([...PAHomeLook.greeting(new Date(2026, 10, 24, 14))], ['午安', 'Good afternoon']);
  assert.deepEqual([...PAHomeLook.dateLine(NOW)], ['2026年11月24日 周二', 'Tue, Nov 24, 2026'], 'with the year, 中文 first');
  const sub = PAHomeLook.headerSub([{ name: 'bible', face: { value: '创 12' } }], esc, NOW);
  assert.match(sub, /今日读经 <b>创 12<\/b>/, "today's reading comes from the Bible tile's face");
  assert.doesNotMatch(PAHomeLook.headerSub([{ name: 'tasks', face: { value: '3' } }], esc, NOW), /今日读经/, 'CONTROL: no Bible face, no reading line');
});

test('chats group by day; 5 recent then 更多 · More with the hidden count', () => {
  const list = Array.from({ length: 8 }, (_, i) => ({ id: 'c' + i, title: 'chat ' + i, updated: NOW.getTime() - [0, 0.1, 1, 1.1, 3, 6, 9, 12][i] * DAY }));
  const g = PAHomeLook.chatGroups(list.slice().reverse(), NOW, PAHomeLook.RECENT);
  assert.equal(g.groups.reduce((n, x) => n + x.items.length, 0), 5);
  assert.equal(g.hidden, 3);
  assert.deepEqual([...g.groups.map((x) => x.label)], ['今天 · Today', '昨天 · Yesterday', '11月21日 · Sat']);
  assert.equal(g.groups[0].items[0].id, 'c0', 'newest first, whatever order the list came in');
  const html = PAHomeLook.convosHtml(list, 'c1', false, esc, NOW);
  assert.equal((html.match(/class="convo/g) || []).length, 4, 'closed-up: only today + yesterday (4 of them)');
  assert.match(html, /data-more-chats>更多 · More \(4\)</);
  assert.match(html, /class="convo active" data-id="c1"/);
  assert.match(html, /data-menu="c0"[^>]*><svg class="pi"/, 'the ⋯ is an icon, still carrying data-menu');
  const all = PAHomeLook.convosHtml(list, null, true, esc, NOW);
  assert.equal((all.match(/class="convo/g) || []).length, 8, 'expanded: every chat');
  assert.doesNotMatch(all, /data-more-chats/);
  assert.match(PAHomeLook.convosHtml([], null, false, esc, NOW), /还没有对话 · No chats yet/);
  assert.match(PAHomeLook.convosHtml([{ id: 'x', title: '<b>', updated: NOW.getTime() }], null, false, esc, NOW), /&lt;b&gt;/, 'titles are escaped');
});

test('every app gets a coloured icon; known apps by name, others a stable colour', () => {
  assert.equal(PAIcons.appIcon({ name: 'bible', title: 'Bible 圣经' }).icon, 'book');
  assert.equal(PAIcons.appIcon({ name: 'notes', title: 'Journal 手写' }).icon, 'pen');
  assert.equal(PAIcons.appIcon({ name: 'club7', title: '7th Grade Club' }).icon, 'flag');
  const odd = { name: 'zzq', title: 'Zzq' };
  assert.equal(PAIcons.appIcon(odd).icon, 'spark');
  assert.deepEqual({ ...PAIcons.appIcon(odd) }, { ...PAIcons.appIcon({ ...odd }) }, 'same app, same colour every time');
  assert.match(PAIcons.tileIcon({ name: 'tasks' }), /^<span class="app-ic" style="--c:#[0-9a-f]{6}"><svg class="pi"/);
});

test('the shell carries the one palette and no emoji buttons in its header, drawer head or composer', () => {
  assert.ok(SHELL.includes(read('web/theme-tokens.css')), 'theme tokens inlined');
  assert.ok(SHELL.includes(read('web/shell-look.css')), 'shell look inlined');
  const header = SHELL.slice(SHELL.indexOf('<header>'), SHELL.indexOf('</header>'));
  const dhead = SHELL.slice(SHELL.indexOf('<div class="dhead">'), SHELL.indexOf('</div>', SHELL.indexOf('<div class="dhead">')));
  const form = SHELL.slice(SHELL.indexOf('<div id="frow">'), SHELL.indexOf('</form>', SHELL.indexOf('<div id="frow">')));
  for (const [where, s] of [['header', header], ['drawer head', dhead], ['composer', form]]) {
    assert.doesNotMatch(s, /[☰🔍⚙↺⋯✕]|\p{Extended_Pictographic}/u, `${where}: icons, not emoji`);
  }
  assert.equal((header.match(/class="ibtn aa-btn"/g) || []).length, 1, 'one Aa control in the header');
  assert.doesNotMatch(read('web/theme-tokens.css'), /#0f6355|#57c2ac/, 'the old green accent is gone');
});

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port });
  const apps = path.join(root, 'workspace', 'apps');
  fs.cpSync(path.join(REPO, 'workspace.example', 'apps', 'tasks'), path.join(apps, 'tasks'), { recursive: true });
  const convos = path.join(root, 'workspace', 'conversations'); fs.mkdirSync(convos, { recursive: true });
  for (let i = 0; i < 8; i++) {
    const id = 'seedchat' + i;
    fs.writeFileSync(path.join(convos, id + '.json'), JSON.stringify({ id, title: 'Chat ' + i, messages: [], updated: Date.now() - i * 3600e3 }));
  }
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

test('USER FLOW: tiles with icons, drawer 5 + More, one Aa, and the app page wears the same palette', { skip, timeout: 60000 }, async () => {
  const sess = (await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER_TOKEN }) })).json()).token;
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await ctxB.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* sandboxed frame: no storage there */ } }, sess);
  const page = await ctxB.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('#hStart .ecard svg');   // one app: it leads Start here, the dock is empty
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(0, 0, 0)', 'dark: true black');
    // Aa: the pair is hidden until the one control is tapped
    assert.equal(await page.isVisible('header .fs-up'), false);
    await page.click('#hmore'); await page.click('header .aa-btn');
    assert.equal(await page.isVisible('header .fs-up'), true);
    const fs = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs')) || 1);
    const before = await fs();
    await page.click('header .fs-up');
    await page.waitForFunction((b) => (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs')) || 1) > b, before);
    assert.ok((await fs()) > before, 'A+ makes the text larger');
    assert.equal(await page.getAttribute('header .aa-btn', 'aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('header .fs-up'), false, 'Escape closes it');
    assert.equal(await page.getAttribute('header .aa-btn', 'aria-expanded'), 'false');
    await page.click('#hmore'); await page.click('header .aa-btn');
    await page.mouse.click(200, 400);
    assert.equal(await page.isVisible('header .fs-up'), false, 'an outside tap closes it');
    // Drawer: 5 recent chats + More (3), then all 8
    await page.click('#hmore'); await page.click('#menu');
    await page.waitForSelector('#convos .convo');
    assert.equal(await page.locator('#convos .convo').count(), 5);
    assert.equal((await page.textContent('[data-more-chats]')).trim(), '更多 · More (3)');
    await page.click('[data-more-chats]');
    assert.equal(await page.locator('#convos .convo').count(), 8);
    assert.equal(await page.isVisible('#drawer.open'), true, 'More keeps the drawer open');
    await page.click('#convos [data-menu="seedchat0"]');
    await page.waitForSelector('#convoMenu', { state: 'visible' });
    await page.keyboard.press('Escape');
    // The app page carries the shared palette AFTER its own style, so its tokens are the shell's
    const html = await (await fetch(`http://127.0.0.1:${port}/app/owner/tasks/`, { headers: { authorization: 'Bearer ' + sess } })).text();
    const at = html.indexOf('<style id="pa-theme">');
    assert.ok(at > 0 && at > html.lastIndexOf('</style>', at - 1) && html.indexOf('</head>') > at, 'injected at the end of <head>');
    assert.ok(html.includes(read('web/theme-tokens.css')), 'the very same file');
    const src = read('web.mjs');
    assert.match(src, /lastIndexOf\('<\/head>', bodyAt >= 0 \? bodyAt : Infinity\)/, 'the last </head> before <body>, not one quoted in a script');
    assert.match(src, /never before the doctype/, 'no head and no body: after the doctype');
  } finally { await ctxB.close(); }
});

test('closed-up chats: today + yesterday, at most RECENT; none that recent → the newest FALLBACK', () => {
  const mk = (days) => days.map((d, i) => ({ id: 'r' + i, updated: NOW.getTime() - d * DAY }));
  assert.equal(PAHomeLook.recentCount(mk([0, 0, 0, 0, 0, 0, 0]), NOW), PAHomeLook.RECENT, 'capped at RECENT');
  assert.equal(PAHomeLook.recentCount(mk([0, 1, 2, 3]), NOW), 2, 'two-days-old is not recent');
  assert.equal(PAHomeLook.recentCount(mk([4, 5, 6, 7, 8]), NOW), PAHomeLook.FALLBACK, 'CONTROL: nothing recent still shows a few');
  assert.equal(PAHomeLook.recentCount([], NOW), PAHomeLook.FALLBACK);
});
