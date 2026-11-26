// Browser Back from an open app (owner report v5.22.4: mouse Back → an empty grey page with only
// the sheet handle). The real web.mjs on a throwaway root, the real shell, a real app in its
// sandboxed frame (R6). Invariant: Back from an open app shows Home fully rendered (frame hidden,
// any menu closed); Forward reopens the app; a frame navigation never leaves a history entry of
// its own; a deep link's Back leaves the shell. Desktop chromium + an iPhone-sized WebKit.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

const SHOTS = process.env.PA_BACK_SHOTS || '';
let port, web, root;
before(async () => {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  for (const [slug, title] of [['todo', 'Todo'], ['sums', 'Sums']]) {
    const d = path.join(root, 'workspace', 'apps', slug); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.html'), `<!doctype html><html><body><h1 id="h">${title}</h1></body></html>`);
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ title }));
  }
  const d = path.join(root, 'workspace', 'apps', 'bible'); fs.mkdirSync(d, { recursive: true });
  for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, 'workspace', 'apps', 'bible', f), path.join(d, f));
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });

// The engine is PA_E2E_ENGINE's (chromium by default; webkit = Safari): each runs at both sizes.
const ENGINES = [['desktop', () => chromium, { viewport: { width: 1100, height: 850 } }],
  ['iPhone', () => chromium, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]];

async function boot(engine, opts, url = '/') {
  const browser = await engine().launch();
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/blank-before`).catch(() => {});   // a page BEFORE the shell: Back must never leave it from inside an app
  await page.goto(`http://127.0.0.1:${port}${url}`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  return { browser, page };
}
const frameApp = (page, slug) => page.waitForFunction((s) => {
  const f = document.querySelector('#fr'); return getComputedStyle(document.querySelector('#frame')).display !== 'none' && f && ((f.getAttribute('src') || '') + (f.getAttribute('data-app') || '')).includes('/' + s + '/');
}, slug, { timeout: 10000 });
const homeState = (page) => page.evaluate(() => ({ url: location.href, st: JSON.stringify(history.state), frame: getComputedStyle(document.querySelector('#frame')).display, inert: document.querySelector('main').hasAttribute('inert'), menu: [...document.querySelectorAll('.cmenu-pop')].filter((m) => !m.hidden).map((m) => m.id), len: history.length }));
const homeShown = async (page) => { try { await homeWait(page); } catch (e) { throw new Error(e.message + ' ' + JSON.stringify(await homeState(page).catch((x) => String(x)))); } };
const homeWait = (page) => page.waitForFunction(() => getComputedStyle(document.querySelector('#frame')).display === 'none'
  && !document.querySelector('main').hasAttribute('inert') && ![...document.querySelectorAll('.cmenu-pop')].some((m) => !m.hidden) && location.pathname === '/', null, { timeout: 10000 });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

for (const [label, engine, opts] of ENGINES) {
  test(`${label}: Back from an app shows Home; Forward reopens it; Back twice; menus close`, { skip, timeout: 90000 }, async () => {
    const { browser, page } = await boot(engine, opts);
    try {
      const len0 = await page.evaluate(() => history.length);
      await page.evaluate(() => openApp(UID, 'todo', 'Todo')); await frameApp(page, 'todo');
      await page.waitForTimeout(400);
      await page.goBack({ waitUntil: 'commit' }).catch(() => {});
      await page.waitForTimeout(300);
      await shot(page, label.replace(/ /g, '-') + '-after-back');
      await homeShown(page);
      assert.match(page.url(), new RegExp(`127.0.0.1:${port}/$`), 'Back stays on the shell');
      await page.goForward({ waitUntil: 'commit' }).catch(() => {}); await frameApp(page, 'todo');
      await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await homeShown(page);
      // app → another app → Back → Back: home, then the page before
      await page.evaluate(() => openApp(UID, 'todo', 'Todo')); await frameApp(page, 'todo');
      await page.evaluate(() => openApp(UID, 'sums', 'Sums')); await frameApp(page, 'sums');
      await page.waitForTimeout(300);
      await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await homeShown(page);
      await page.goBack({ waitUntil: 'commit' }).catch(() => {});
      await page.waitForURL(/\/blank-before$/, { timeout: 10000 });   // Back twice: Home, then the page before
      await page.goForward({ waitUntil: 'commit' }).catch(() => {});
      await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
      // a menu open over the app: Back closes it and goes Home
      await page.evaluate(() => openApp(UID, 'todo', 'Todo')); await frameApp(page, 'todo');
      await page.evaluate(() => { const m = document.createElement('div'); m.id = 'appMenu'; m.className = 'cmenu-pop'; document.body.appendChild(m); });
      await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await homeShown(page);
      // Home's own control leaves no stale app entry: Back after goHome does not reopen anything blank
      await page.evaluate(() => openApp(UID, 'todo', 'Todo')); await frameApp(page, 'todo');
      await page.evaluate(() => goHome()); await homeShown(page);
      assert.ok(await page.evaluate(() => history.length) <= len0 + 2, 'frame loads add no history entries');
      await page.goBack({ waitUntil: 'commit' }).catch(() => {});
      await page.waitForTimeout(300);
      assert.ok(/\/blank-before$/.test(page.url()) || await page.evaluate(() => getComputedStyle(document.querySelector('#frame')).display === 'none'), 'never an app left open with nothing in it');
    } finally { await browser.close(); }
  });

  test(`${label}: Back from Bible (own bar) shows Home`, { skip, timeout: 90000 }, async () => {
    const { browser, page } = await boot(engine, opts);
    try {
      await page.evaluate(() => openApp(UID, 'bible', 'Bible')); await frameApp(page, 'bible');
      await page.waitForTimeout(1500);   // the Bible's own navigation inside the frame, if any, has run
      await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await homeShown(page);
    } finally { await browser.close(); }
  });

  // Live check 2026-11-26: Tasks, Back, then Bible, Back → a blank screen. The fresh frame Home left had
  // loaded about:blank, so the next app's srcdoc (the offline route) added a history entry of the
  // frame's own, and Back blanked the frame instead of going Home. Pinned on BOTH routes.
  test(`${label}: a second app after Back — Back again shows Home (src and srcdoc routes)`, { skip, timeout: 90000 }, async () => {
    const { browser, page } = await boot(engine, opts);
    try {
      await page.evaluate(() => openApp(UID, 'todo', 'Todo')); await frameApp(page, 'todo');
      await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await homeShown(page);
      await page.waitForFunction(() => PASW.route() === 'srcdoc', null, { timeout: 15000 });   // the offline route is up
      await page.waitForTimeout(500);
      const len = await page.evaluate(() => history.length);
      await page.evaluate(() => openApp(UID, 'sums', 'Sums')); await frameApp(page, 'sums');
      await page.waitForFunction(() => document.querySelector('#fr').hasAttribute('srcdoc'), null, { timeout: 10000 });
      await page.waitForTimeout(500);
      assert.ok(await page.evaluate(() => history.length) <= len, 'the srcdoc load added no history entry of the frame\'s own');
      await page.goBack({ waitUntil: 'commit' }).catch(() => {}); await homeShown(page);
    } finally { await browser.close(); }
  });

  test(`${label}: an app opened by deep link — Back leaves the shell to the page before`, { skip, timeout: 90000 }, async () => {
    const { browser, page } = await boot(engine, opts, '/#open=owner/todo');
    try {
      await frameApp(page, 'todo');
      await page.goBack({ waitUntil: 'commit' }).catch(() => {});
      await page.waitForURL(/\/blank-before$/, { timeout: 10000 });   // a link's Back leaves the shell, as any link's does
    } finally { await browser.close(); }
  });
  test(`${label}: an app opened by deep link — in-app Home stays on the shell`, { skip, timeout: 90000 }, async () => {
    const { browser, page } = await boot(engine, opts, '/#open=owner/todo');
    try {
      await frameApp(page, 'todo');
      await page.evaluate(() => goHome());
      await homeShown(page);
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(!/\/blank-before$/.test(page.url()), 'Home from a link\'s app never leaves the site');
      assert.equal(await page.evaluate(() => history.state && history.state.paApp), null);
    } finally { await browser.close(); }
  });
}
