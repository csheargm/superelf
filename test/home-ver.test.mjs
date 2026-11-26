// The home's pinned footer names the running version and its release time · 主页底部固定显示版本与更新时间 (R6).
// Owner: the version must sit OUTSIDE the app list, visible without scrolling, English only. web/home-ver.js
// reads the ONE source, the Settings footer #ver-lbl, through web/version-time.js. Real browsers: an owner node
// with ~20 apps (phone + desktop, light + dark) and a demo guest. PA_E2E_ENGINE=webkit runs it in Safari's engine.
// PA_SHOT_DIR=<dir> saves footer-*.png. Without Playwright the browser tests FAIL unless PA_E2E_SKIP=1.
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
import { SHELL_PARTS } from '../lib/shellhtml.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const VERSION = JSON.parse(read('package.json')).version;
const TIME = `${new Date().getUTCFullYear()}-03-04T06:32:09Z`;
const LINE_RE = new RegExp(`^Version ${VERSION.replace(/\./g, '\\.')}\\S* · Updated (Mar \\d{1,2}, \\d{2}:\\d{2})$`);
const SHOTS = process.env.PA_SHOT_DIR || '';

function unit() {
  const el = (id, o) => ({ id, hidden: true, textContent: '', dataset: {}, title: '', removeAttribute(a) { delete this[a]; }, ...o });
  const els = { 'ver-lbl': el('ver-lbl', { textContent: '管家 · v5.30.0+2 · ab12cd3', dataset: { vtime: '2026-11-26T02:30:00Z', vdate: '11-26' } }), hVer: el('hVer') };
  const ctx = vm.createContext({ document: { getElementById: (i) => els[i] || null }, MutationObserver: class { observe() {} }, Intl, Date });
  vm.runInContext(read('web/version-time.js') + read('web/home-ver.js') + ';this.PAHomeVer=PAHomeVer;', ctx);
  return { ...ctx.PAHomeVer, els };
}
test('versionOf/lineOf/whenOf: English only, no v and no build id lost; no time → version only; no version → nothing', () => {
  const { versionOf, lineOf, whenOf, els } = unit();
  assert.equal(versionOf('管家 · v5.30.0+2 · ab12cd3'), 'v5.30.0+2');
  assert.equal(versionOf('管家 · '), '');
  assert.equal(lineOf('v5.1.0', 'Nov 26, 10:30'), 'Version 5.1.0 · Updated Nov 26, 10:30');
  assert.equal(lineOf('v5.1.0', ''), 'Version 5.1.0');
  assert.equal(lineOf('', '11-26'), '');
  const now = new Date(2026, 10, 30);
  assert.equal(whenOf(new Date(2026, 10, 26, 10, 5).toISOString().replace(/\.\d+Z$/, 'Z'), '', now), 'Nov 26, 10:05');
  assert.equal(whenOf(new Date(2025, 0, 2, 9, 0).toISOString().replace(/\.\d+Z$/, 'Z'), '', now), 'Jan 2, 2025, 09:00');
  assert.equal(whenOf('bad', '11-25', now), '11-25', 'no time recorded → the date, never a made-up time');
  assert.equal(els.hVer.hidden, false, 'start() synced at load');
  assert.match(els.hVer.textContent, /^Version 5\.30\.0\+2 · Updated Nov \d{1,2}, \d{2}:\d{2}$/);
  assert.doesNotMatch(els.hVer.textContent, /[\u4e00-\u9fff]/, 'no Chinese text');
  assert.ok(els.hVer.title.startsWith(els.hVer.textContent) && /UTC[+-]/.test(els.hVer.title), 'the full text + zone in the title');
});
test('inlined after version-time.js (no TDZ) and the line sits last in the home', () => {
  const files = SHELL_PARTS.map(([, f]) => f);
  assert.equal(files.indexOf('home-ver.js'), files.indexOf('version-time.js') + 1);
  const html = read('web/index.html');
  assert.ok(html.indexOf('/* PA_HOME_VER_JS */') > html.indexOf('/* PA_VERSION_TIME_JS */'));
  assert.match(html, /<\/main>\s*<p class="home-ver" id="hVer" hidden><\/p>/, 'outside <main>, so outside the scrolling list');
  assert.match(read('web/home-v2.css'), /\.home-ver\{[^}]*font-size:12\.5px/);
  assert.match(read('web/home-v2.css'), /\.home-ver\{[^}]*env\(safe-area-inset-bottom/);
});

let port, root, web, dport, droot, dweb, sb, browser;
before(async () => {
  if (skip) return;
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [{ id: 'owner', name: 'Avery', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' }] } });
  const apps = path.join(root, 'workspace', 'apps');
  fs.cpSync(path.join(REPO, 'workspace.example', 'apps'), apps, { recursive: true });
  for (const slug of fs.readdirSync(apps)) for (const n of [2, 3]) fs.cpSync(path.join(apps, slug), path.join(apps, `${slug}-${n}`), { recursive: true });   // ~27 apps, like the owner's long list
  fs.writeFileSync(path.join(root, 'version-notes.json'), JSON.stringify({ [`v${VERSION}`]: { date: '03-04', time: TIME, notes: [] } }));
  web = startWeb(root); await waitReady(port);
  sb = await startStubSupabase();
  dport = await freePort();
  droot = mkWebRoot({ port: dport, extraConfig: { users: [], demo: { enabled: true, title: 'superelf', new_users_per_ip_per_day: 50,
    auth: { supabase_url: sb.url, supabase_anon_key: 'public-anon', required: true } } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(droot, 'workspace.example'), { recursive: true });
  fs.writeFileSync(path.join(droot, 'version-notes.json'), JSON.stringify({ [`v${VERSION}`]: { date: '03-04', time: TIME, notes: [] } }));
  dweb = startWeb(droot); await waitReady(dport);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); for (const w of [web, dweb]) if (w) await stopWeb(w); if (sb) sb.srv.close(); for (const r of [root, droot]) if (r) rmTemp(r); });

// The footer measured where it is: no scrolling first (top), then with the list scrolled to its end.
async function footer(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#hVer'), r = el.getBoundingClientRect(), es = document.querySelector('#emptyState');
    const hit0 = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const hit = hit0 && hit0.closest('.pat-tip') ? el : hit0;   // a first-use tip bubble floats over anything for a moment
    const cs = getComputedStyle(el), lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    const er = es.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(el); const lines = range.getClientRects().length;
    const ctl = [...document.querySelectorAll('button,a,input,textarea,select,[role=button],.ecard')].filter((c) => {
      const b0 = c.getBoundingClientRect(); if (!b0.width || !b0.height || c.closest('#hVer')) return false;
      const clip = c.closest('#emptyState') ? er : { top: -1e9, bottom: 1e9 };   // a tile scrolled out of the list is clipped, not covered
      const b = { left: b0.left, right: b0.right, top: Math.max(b0.top, clip.top), bottom: Math.min(b0.bottom, clip.bottom), width: b0.width, height: b0.height };
      if (b.bottom <= b.top) return false;
      const x = Math.min(Math.max(r.left + 1, b.left + b.width / 2), r.right - 1), y = Math.min(Math.max(r.top + 1, b.top + b.height / 2), r.bottom - 1);
      return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top && document.elementFromPoint(x, y) === el;
    }).map((c) => c.id || c.className);
    return { text: el.textContent, title: el.title, size: parseFloat(cs.fontSize), lines, h: r.height, lh, top: r.top, bottom: r.bottom, listBottom: er.bottom,
      inView: r.top >= 0 && r.bottom <= innerHeight && r.height > 0, onTop: hit === el, covered: ctl, overflowing: el.scrollWidth > el.clientWidth + 1,
      hScroll: document.documentElement.scrollWidth > innerWidth, scrolls: es.scrollHeight > es.clientHeight + 4 };
  });
}
async function scrollEnd(page) {
  await page.evaluate(() => { const e = document.querySelector('#emptyState'); e.scrollTop = e.scrollHeight; });
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('#eApps .ecard')]; const last = cards[cards.length - 1]; const b = last.getBoundingClientRect();
    const f = document.querySelector('#hVer').getBoundingClientRect(), hit = document.elementFromPoint(b.left + b.width / 2, b.bottom - 4);
    return { cards: cards.length, lastBottom: b.bottom, footTop: f.top, lastOnTop: !!hit && last.contains(hit) };
  });
}
function assertFooter(r, what) {
  assert.ok(r.inView && r.onTop, `${what}: visible without scrolling ${JSON.stringify(r)}`);
  assert.ok(r.size >= 12, `font ${r.size}px`);
  assert.equal(r.lines, 1, `${what}: one line ${JSON.stringify(r)}`); assert.equal(r.overflowing, false, `${what}: not cut off`);
  assert.ok(r.h < r.lh * 2, `${what}: height ≈ one line`);
  assert.deepEqual(r.covered, [], `${what}: covers no control`); assert.ok(r.top >= r.listBottom - 1, `${what}: below the scrolling list`);
  assert.equal(r.hScroll, false); assert.doesNotMatch(r.text, /[\u4e00-\u9fff]/, 'English only');
}
async function owner(viewport, colorScheme) {
  const sess = (await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER_TOKEN }) })).json()).token;
  const c = await browser.newContext({ viewport, colorScheme, timezoneId: 'Asia/Shanghai' });
  await c.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* sandboxed frame */ } }, sess);
  const page = await c.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  return { c, page, errs };
}
for (const [name, viewport] of [['iPhone 390x844', { width: 390, height: 844 }], ['desktop 1280x800', { width: 1280, height: 800 }]]) {
  for (const scheme of ['light', 'dark']) {
    test(`USER FLOW owner ${name} ${scheme}: the footer shows the version without scrolling, outside the app list`, { skip, timeout: 60000 }, async () => {
      const { c, page, errs } = await owner(viewport, scheme);
      try {
        await page.waitForSelector('#eApps .ecard'); await page.waitForSelector('#hVer', { state: 'visible' });
        const tag = `${viewport.width}-${scheme}`;
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `footer-${tag}-top.png`) });
        const r = await footer(page);
        const m = r.text.match(LINE_RE); assert.ok(m, r.text);
        assert.equal(m[1], 'Mar 4, 14:32', 'the release time in the viewer zone (UTC+8)');
        assert.ok(r.title.startsWith(r.text) && /UTC\+08:00/.test(r.title), r.title);
        assertFooter(r, 'top');
        if (viewport.width === 390) assert.ok(r.scrolls, 'the seeded list is longer than the phone screen');
        const e = await scrollEnd(page);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `footer-${tag}-end.png`) });
        assert.ok(e.cards >= 20, `${e.cards} apps`);
        assert.ok(e.lastBottom <= e.footTop + 0.5 && e.lastOnTop, `the last app is not under the footer ${JSON.stringify(e)}`);
        assertFooter(await footer(page), 'scrolled to the end');
        const shown = await page.evaluate(() => document.querySelector('#ver-lbl').textContent.replace(/^管家\s*·\s*/, '').split(' · ')[0].trim().replace(/^v/, ''));
        assert.ok(r.text.startsWith(`Version ${shown} ·`), 'the same version the Settings footer shows');
        await page.evaluate(() => hideEmptyState());   // what opening a chat does
        assert.equal(await page.isVisible('#hVer'), false, 'hidden while a chat is open');
        await page.evaluate(() => showEmptyState());
        assert.equal(await page.isVisible('#hVer'), true, 'back on Home');
        assert.deepEqual(errs, []);
      } finally { await c.close(); }
    });
  }
}
test('USER FLOW demo guest on an iPhone: the footer shows without scrolling, no page errors', { skip, timeout: 60000 }, async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' }); const page = await c.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${dport}/`);
    await waitFor(() => page.evaluate(() => performance.getEntriesByType('navigation')[0].type === 'reload' && !!document.querySelector('#hStart .st')).catch(() => false), 'the boot reload');
    await page.waitForSelector('#hVer', { state: 'visible' });
    const r = await footer(page);
    const m = r.text.match(LINE_RE); assert.ok(m, r.text);
    assert.equal(m[1], 'Mar 3, 22:32', 'Los Angeles: the day before');
    assertFooter(r, 'demo');
    assert.deepEqual(errs, []);
  } finally { await c.close(); }
});
