// The ask-first home · 先问主页 (web/home-v2.js, web/home-v2.css) (R6): unit checks on the pure helpers,
// then real browsers on throwaway nodes — an owner node (owner + member) and a demo node (guest).
// Without Playwright the browser tests FAIL unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, waitFor, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { startStubSupabase } from './helpers-demo-sb.mjs';
import { demoHomeHide } from '../lib/demo-boot.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const ctx = vm.createContext({ window: {}, document: {} });
vm.runInContext(read('web/icons.js') + read('web/home-look.js') + read('web/home-v2.js') + ';this.PAHome=PAHome;this.PAIcons=PAIcons;', ctx);
const { PAHome, PAIcons } = ctx;
const app = (name, title, extra = {}) => ({ name, title, ...extra });
const OWN = [app('allergy', '花粉 Allergy & Pollen'), app('bible', '圣经 Bible'), app('bible-values', '圣经价值观 Biblical Values'),
  app('diabetes', '糖尿病 Diabetes'), app('notes', '手写 Journal'), app('tasks', '待办 Tasks', { face: { value: '3', label: 'open' } })];
const names = (xs) => [...xs].map((s) => (s.make ? '+make' : (s.app || s).name));

test('titles split into 中文 and English; old built-in titles still read bilingual', () => {
  assert.deepEqual([...PAHome.label('花粉 Allergy & Pollen')], ['花粉', 'Allergy & Pollen']);
  assert.deepEqual([...PAHome.label('Bible 圣经')], ['圣经', 'Bible']);
  assert.deepEqual([...PAHome.label('Biblical Values')], ['圣经价值观', 'Biblical Values'], 'an installed copy keeps its old meta.json');
  assert.deepEqual([...PAHome.label('My Timer')], ['My Timer', ''], 'a one-language title stays one line');
});

test('layout: guest starts with Bible, Journal, Make an app; no app twice; hidden slugs never shown', () => {
  const g = PAHome.layout(OWN, [], { guest: true, hide: ['diabetes'] });
  assert.deepEqual(names(g.start), ['bible', 'notes', '+make']);
  const all = [...names(g.start), ...names(g.dock)];
  assert.equal(new Set(all).size, all.length, 'no app repeated');
  assert.ok(!all.includes('diabetes'), 'the demo hides Diabetes');
  const m = PAHome.layout(OWN, [], { guest: false, hide: [], mru: ['tasks', 'allergy'] });
  assert.deepEqual(names(m.start), ['allergy', 'tasks', 'bible'], 'signed in: the most-used first, then the starters');
  const full = PAHome.layout(OWN, [], { guest: false, hide: [], mru: ['diabetes', 'allergy', 'bible-values'] });
  assert.deepEqual(names(full.start), ['allergy', 'bible-values', 'diabetes'], 'three used apps: in the shelf (MRU) order');
  const fresh = PAHome.layout(OWN, [], { guest: false, hide: [], mru: [] });
  assert.deepEqual(names(fresh.start), ['bible', 'notes', 'tasks'], 'no history yet: the familiar starters');
  assert.ok(!names(fresh.dock).some((n) => ['bible', 'notes', 'tasks'].includes(n)));
  assert.deepEqual(names(PAHome.layout([], [], { guest: false }).start), ['+make'], 'no apps: Make an app');
});

test('chips: the open-task count first, from the app faces', () => {
  const c = PAHome.chips([app('sunday-study', '主日查经 Sunday Study', { face: { value: '周日' } }), ...OWN]);
  assert.equal(c[0].zh, '3 件待办'); assert.equal(c[0].en, '3 tasks');
  assert.equal(c[1].zh, '主日查经 周日');
});

test('distinct dock icons: Bible ≠ Biblical Values; Pollen is a flower', () => {
  assert.notEqual(PAIcons.appIcon(OWN[1]).icon, PAIcons.appIcon(OWN[2]).icon);
  assert.equal(PAIcons.appIcon(OWN[0]).icon, 'flower');
});

test('demo config demo.home_hide is a slug list; anything else is dropped', () => {
  assert.deepEqual(demoHomeHide({ demo: { home_hide: ['diabetes', '../x', 3] } }), ['diabetes']);
  assert.deepEqual(demoHomeHide({ demo: {} }), []);
  assert.match(read('ops/demo/config.demo.json'), /"home_hide": \["diabetes"\]/);
});

const MEMBER_TOKEN = 'home-member-token-0123456789abcdef';
let port, root, web, dport, droot, dweb, sb, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [
    { id: 'owner', name: 'Avery', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'mia', name: 'Mia', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-mia' }] } });
  for (const ws of ['workspace', 'workspace-mia']) fs.cpSync(path.join(REPO, 'workspace.example', 'apps'), path.join(root, ws, 'apps'), { recursive: true });
  const face = path.join(root, 'workspace', 'data', 'tasks'); fs.mkdirSync(face, { recursive: true });
  fs.writeFileSync(path.join(face, 'face.json'), JSON.stringify({ value: '3', ts: Date.now() }));
  web = startWeb(root); await waitReady(port);
  if (skip) return;
  sb = await startStubSupabase();
  dport = await freePort();
  droot = mkWebRoot({ port: dport, extraConfig: { users: [], demo: { enabled: true, title: 'superelf', home_hide: ['diabetes'], new_users_per_ip_per_day: 50,
    auth: { supabase_url: sb.url, supabase_anon_key: 'public-anon', required: true } } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(droot, 'workspace.example'), { recursive: true });
  dweb = startWeb(droot); await waitReady(dport);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); for (const w of [web, dweb]) if (w) await stopWeb(w); if (sb) sb.srv.close(); for (const r of [root, droot]) if (r) rmTemp(r); });

async function signedIn(token, opts = {}) {
  const sess = (await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })).json()).token;
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  await c.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* sandboxed frame */ } }, sess);
  const page = await c.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#hStart .st');
  return { c, page };
}
const homeApps = (page) => page.evaluate(() => [...document.querySelectorAll('#hStart [data-es],#eApps [data-es]')].map((e) => e.dataset.es));

test('USER FLOW owner: name + task chip, ⋯ holds every moved control, alert dot on ⋯, no app twice', { skip, timeout: 60000 }, async () => {
  const { c, page } = await signedIn(OWNER_TOKEN);
  try {
    assert.match(await page.textContent('#hHello'), /Avery/);
    assert.match(await page.textContent('#hChips'), /3 件待办 · 3 tasks/);
    assert.equal(await page.isVisible('#hAvatar'), true); assert.equal(await page.isVisible('#homeForm #box'), true, 'the ask ring holds the one composer');
    const apps = await homeApps(page); assert.equal(new Set(apps).size, apps.length, `no app twice: ${apps}`);
    assert.equal(await page.isVisible('#hTip'), true, 'first-use tip beside ⋯');
    assert.equal(await page.isVisible('#settings'), false);
    await page.click('#hmore');
    assert.equal(await page.isVisible('#hTip'), false, 'opening ⋯ retires the tip');
    for (const s of ['#menu', 'header .aa-btn', '#reload', '#settings', '#newSession']) assert.equal(await page.isVisible(s), true, `${s} in ⋯`);
    await page.keyboard.press('Escape'); assert.equal(await page.isVisible('#hmenu'), false);
    await page.evaluate(() => { const d = document.createElement('span'); d.className = 'oa-dot'; document.querySelector('#menu').appendChild(d); });
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('#hmore'), '::after').content), 'none', 'the owner-alert dot shows on ⋯');
    await page.click('#hmore'); await page.click('#menu'); await page.waitForSelector('#drawer.open');
  } finally { await c.close(); }
});

test('USER FLOW member: own greeting, no owner chips, Start here opens an app, the ask box sends', { skip, timeout: 60000 }, async () => {
  const { c, page } = await signedIn(MEMBER_TOKEN);
  try {
    assert.match(await page.textContent('#hHello'), /Mia/);
    assert.equal((await page.textContent('#hChips')).trim(), '', 'no task face in her workspace');
    const first = await page.getAttribute('#hStart .st', 'data-es');
    await page.click('#hStart .st'); await page.waitForSelector('#frame', { state: 'visible' });
    assert.equal(await page.textContent('#ftitle'), await page.evaluate((s) => document.querySelector(`#hStart [data-es="${s}"]`).dataset.et, first));
  } finally { await c.close(); }
});

test('USER FLOW demo guest: welcome, Sign in in the header, Diabetes hidden, Make an app starts the ask box, phone fits, reduced motion', { skip, timeout: 60000 }, async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }); const page = await c.newPage();
  try {
    await page.goto(`http://127.0.0.1:${dport}/`);
    await waitFor(() => page.evaluate(() => performance.getEntriesByType('navigation')[0].type === 'reload' && !!document.querySelector('#hStart .st')).catch(() => false), 'the boot reload');
    await page.waitForSelector('#hStart .st');
    assert.equal(await page.isVisible('#hWelcome'), true); assert.equal(await page.isVisible('#hKeep'), true);
    assert.equal(await page.isVisible('header #demoSignin'), true);
    assert.equal(await page.isVisible('#hAvatar'), false); assert.equal(await page.isVisible('#newSession'), false);
    assert.deepEqual((await homeApps(page)).slice(0, 2), ['bible', 'notes']);
    assert.ok(!(await homeApps(page)).includes('diabetes'), 'demo.home_hide');
    await page.click('[data-make]');
    assert.match(await page.inputValue('#box'), /^帮我做一个应用/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'box');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('header .mark .spark')).animationName), 'none', 'reduced motion: no twinkle');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll at 390');
    const clipped = await page.evaluate(() => [...document.querySelectorAll('#eApps .dk b')].filter((b) => b.scrollWidth > b.parentElement.clientWidth + 12).length);
    assert.equal(clipped, 0, 'dock labels fit');
  } finally { await c.close(); }
});
