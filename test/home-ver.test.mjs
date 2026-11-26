// The home's last line names the running version and its release time · 主页底部显示版本与更新时间 (R6).
// Owner: "put the version and the release date at the end of the home page". web/home-ver.js reads the
// ONE source, the Settings footer #ver-lbl, formatted by web/version-time.js. Real browsers: an owner
// node (phone + desktop, light + dark) and a demo guest. PA_E2E_ENGINE=webkit runs it in Safari's engine.
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
import { SHELL_PARTS } from '../lib/shellhtml.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const VERSION = JSON.parse(read('package.json')).version;
const TIME = `${new Date().getUTCFullYear()}-03-04T06:32:09Z`;
const LINE_RE = new RegExp(`^版本 v${VERSION.replace(/\./g, '\\.')}\\S* · 更新于 (\\d{2}-\\d{2} \\d{2}:\\d{2}) · Version v${VERSION.replace(/\./g, '\\.')}\\S* · Updated \\1$`);

function unit() {
  const el = (id, o) => ({ id, hidden: true, textContent: '', dataset: {}, title: '', removeAttribute(a) { delete this[a]; }, ...o });
  const els = { 'ver-lbl': el('ver-lbl', { textContent: '管家 · v5.30.0+2 · ab12cd3', dataset: { vtime: '2026-11-26T02:30:00Z', vdate: '11-26' } }), hVer: el('hVer') };
  const ctx = vm.createContext({ document: { getElementById: (i) => els[i] || null }, MutationObserver: class { observe() {} }, Intl, Date });
  vm.runInContext(read('web/version-time.js') + read('web/home-ver.js') + ';this.PAHomeVer=PAHomeVer;', ctx);
  return { ...ctx.PAHomeVer, els };
}
test('versionOf/lineOf: the version without the build id; 中文 first; no time → version only; no version → nothing', () => {
  const { versionOf, lineOf, els } = unit();
  assert.equal(versionOf('管家 · v5.30.0+2 · ab12cd3'), 'v5.30.0+2');
  assert.equal(versionOf('管家 · '), '');
  assert.equal(lineOf('v5.1.0', '11-26 10:30'), '版本 v5.1.0 · 更新于 11-26 10:30 · Version v5.1.0 · Updated 11-26 10:30');
  assert.equal(lineOf('v5.1.0', ''), '版本 v5.1.0 · Version v5.1.0');
  assert.equal(lineOf('', '11-26'), '');
  assert.equal(els.hVer.hidden, false, 'start() synced at load');
  assert.match(els.hVer.textContent, /^版本 v5\.30\.0\+2 · 更新于 \d{2}-\d{2} \d{2}:\d{2} · Version v5\.30\.0\+2 · Updated /);
});
test('inlined after version-time.js (no TDZ) and the line sits last in the home', () => {
  const files = SHELL_PARTS.map(([, f]) => f);
  assert.equal(files.indexOf('home-ver.js'), files.indexOf('version-time.js') + 1);
  const html = read('web/index.html');
  assert.ok(html.indexOf('/* PA_HOME_VER_JS */') > html.indexOf('/* PA_VERSION_TIME_JS */'));
  assert.match(html, /id="eApps"><\/div>\s*<p class="home-ver" id="hVer" hidden><\/p>[^\n]*\n\s*<\/div>/);
  assert.match(read('web/home-v2.css'), /\.home-ver\{[^}]*font-size:12\.5px/);
});

let port, root, web, dport, droot, dweb, sb, browser;
before(async () => {
  if (skip) return;
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [{ id: 'owner', name: 'Avery', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' }] } });
  fs.cpSync(path.join(REPO, 'workspace.example', 'apps'), path.join(root, 'workspace', 'apps'), { recursive: true });
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

async function bottomLine(page) {
  await page.waitForSelector('#hStart .st');
  await page.evaluate(() => { const e = document.querySelector('#emptyState'); e.scrollTop = e.scrollHeight; });
  await page.waitForSelector('#hVer', { state: 'visible' });
  return page.evaluate(() => {
    const el = document.querySelector('#hVer'), r = el.getBoundingClientRect(), es = document.querySelector('#emptyState');
    const kids = [...es.children].filter((k) => k.offsetParent !== null);
    const hit0 = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const hit = hit0 && hit0.closest('.pat-tip') ? el : hit0;   // a first-use tip bubble floats over anything for a moment; only fixed chrome counts
    return { text: el.textContent, title: el.title, size: parseFloat(getComputedStyle(el).fontSize), last: kids[kids.length - 1] === el,
      inView: r.top >= 0 && r.bottom <= innerHeight, onTop: hit === el, hScroll: document.documentElement.scrollWidth > innerWidth, color: getComputedStyle(el).color };
  });
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
    test(`USER FLOW owner ${name} ${scheme}: the home ends with the real version + local release time`, { skip, timeout: 60000 }, async () => {
      const { c, page, errs } = await owner(viewport, scheme);
      try {
        const r = await bottomLine(page);
        const m = r.text.match(LINE_RE); assert.ok(m, r.text);
        assert.equal(m[1], '03-04 14:32', 'the release time in the viewer zone (UTC+8)');
        assert.match(r.title, /UTC\+08:00/);
        assert.ok(r.size >= 12, `font ${r.size}px`); assert.ok(r.last, 'last in the home'); assert.ok(r.inView && r.onTop, JSON.stringify(r));
        assert.equal(r.hScroll, false);
        const footer = await page.evaluate(() => document.querySelector('#ver-lbl').textContent.replace(/^管家\s*·\s*/, '').split(' · ')[0].trim());
        assert.ok(r.text.startsWith(`版本 ${footer} ·`), 'the same version the Settings footer shows');
        assert.deepEqual(errs, []);
      } finally { await c.close(); }
    });
  }
}
test('USER FLOW demo guest on an iPhone: the line shows after scrolling, no page errors', { skip, timeout: 60000 }, async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles' }); const page = await c.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${dport}/`);
    await waitFor(() => page.evaluate(() => performance.getEntriesByType('navigation')[0].type === 'reload' && !!document.querySelector('#hStart .st')).catch(() => false), 'the boot reload');
    const r = await bottomLine(page);
    const m = r.text.match(LINE_RE); assert.ok(m, r.text);
    assert.equal(m[1], '03-03 22:32', 'Los Angeles: the day before');
    assert.ok(r.size >= 12 && r.inView && r.onTop && r.last && !r.hScroll, JSON.stringify(r));
    assert.deepEqual(errs, []);
  } finally { await c.close(); }
});
