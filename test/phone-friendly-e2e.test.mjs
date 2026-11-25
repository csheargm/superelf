// Phone-friendly base（手机友好基础）e2e — the shell and EVERY built-in app (workspace.example/apps), in WebKit at
// iPhone 390x844 and iPad 820x1180 (touch, DPR 3), measured with test/helpers-phone-check.mjs:
//   no sideways page scroll; no input under 16px (iOS would zoom); no button under 44px; no first-use tip over a
//   title / header (phone audit #2); a Pencil-only tip never shows to a finger (#3).
// And the CONTROL (R14): desktop Chromium with a mouse keeps the desktop sizes (the touch rules are pointer:coarse only).
// Run: PA_PLAYWRIGHT=/path/to/playwright/index.mjs node --test test/phone-friendly-e2e.test.mjs
// Known limits: emulated WebKit, not a real iPhone (env(safe-area-inset-*) is 0 here); fixed edge bars are reported only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { missingReason, resolveSkip } from './helpers-e2e-gate.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { ROOT } from './helpers-app.mjs';
import { checkSurface, overlaps } from './helpers-phone-check.mjs';

const pw = await (async () => { try { return process.env.PA_PLAYWRIGHT ? await import(pathToFileURL(process.env.PA_PLAYWRIGHT).href) : await import('playwright'); } catch { return null; } })();
const skip = resolveSkip(await missingReason(pw && pw.webkit));
const DEVICES = { iPhone: { width: 390, height: 844 }, iPad: { width: 820, height: 1180 } };
const APPS = fs.readdirSync(path.join(ROOT, 'workspace.example/apps')).filter((s) => fs.existsSync(path.join(ROOT, 'workspace.example/apps', s, 'index.html')));
const SETTLE_MS = 1500;
const OUT = process.env.PA_PHONE_REPORT || '';   // optional JSON of every measurement (before/after numbers)
const report = [];
const SHOTS = process.env.PA_SHOTS || '';   // optional folder: one screenshot per surface

let port, root, web, wk, cr;
before(async () => {
  port = await freePort(); root = mkWebRoot({ port });
  fs.cpSync(path.join(ROOT, 'workspace.example/apps'), path.join(root, 'workspace/apps'), { recursive: true });
  web = startWeb(root); await waitReady(port);
  if (!skip) { wk = await pw.webkit.launch(); cr = await pw.chromium.launch(); }
});
after(async () => { if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); if (wk) await wk.close(); if (cr) await cr.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

async function open(browser, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await home(page);
  return { ctx, page };
}
// A fresh home, as a person opening the app from the home screen gets it (the home ⋯ tip is on screen).
async function home(page) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'), null, { timeout: 20000 });
  await page.waitForTimeout(SETTLE_MS);
}
// Titles a tip must leave clear: every h1 / header / banner on the surface.
const heads = (t) => t.evaluate(() => [...document.querySelectorAll('h1,header,[role=banner]')].map((e) => e.getBoundingClientRect())
  .filter((r) => r.width > 0 && r.height > 0 && r.height < innerHeight / 2).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })));
const tipRects = (t) => t.evaluate(() => [...document.querySelectorAll('.pat-tip')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.tip, left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }));

function judge(where, m, bad) {
  report.push({ where, ...m });
  if (m.hScroll) bad.push(`${where}: page scrolls sideways by ${m.hScroll}px`);
  if (m.smallInputs.length) bad.push(`${where}: inputs under 16px ${m.smallInputs.join(', ')}`);
  for (const c of m.covered) if (/under div\.pat-tip/.test(c)) bad.push(`${where}: a tip covers ${c}`);
  if (m.smallTaps.length) bad.push(`${where}: taps under 44px ${m.smallTaps.slice(0, 6).join(', ')}${m.smallTaps.length > 6 ? ` (+${m.smallTaps.length - 6})` : ''}`);
}
// Round 2 (iPad 820 Bible): the 44px floor widened the nav, so the book picker shrank to 2px and A+ ran past the edge.
const squeezed = (t) => t.evaluate(() => [...document.querySelectorAll('button,select,input,a[href],[role=button]')].filter((e) => {
  const r = e.getBoundingClientRect(), s = getComputedStyle(e);
  return r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && r.top < innerHeight && (r.right > innerWidth + 1 || (r.width > 0 && r.width < 12));
}).map((e) => (e.id || e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().width) + 'px'));
// Runs in the page: each visible row of every open .cmenu-pop, with its icon (svg, or the leading text glyph box) and label rects.
function menuRows() {
  const box = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  return [...document.querySelectorAll('.cmenu-pop:not([hidden]) button')].filter((b) => b.getClientRects().length && !b.closest('.aa-set,[hidden]'))
    .map((b) => { const ic = b.querySelector(':scope > svg'), lb = b.querySelector(':scope > .hm-l,:scope > .lbl');
      return { id: b.id || b.className, h: b.getBoundingClientRect().height, icon: ic ? box(ic) : null,
        label: lb && lb.getClientRects().length && lb.textContent.trim() ? box(lb) : (!lb && b.textContent.trim() ? box(b) : null) }; });
}
async function tipsClear(where, t, bad) {
  const [h, tips] = [await heads(t), await tipRects(t)];
  for (const tip of tips) for (const r of h) if (overlaps(tip, r)) bad.push(`${where}: tip ${tip.id} covers a title/header`);
  if (tips.some((x) => /pen|pencil/.test(x.id || ''))) bad.push(`${where}: a Pencil tip shows to a finger`);
}

for (const [dev, viewport] of Object.entries(DEVICES)) test(`${dev}: shell + every built-in app pass the phone check`, { skip, timeout: 300000 }, async () => {
  assert.ok(APPS.length >= 5, `the sweep must find the built-in apps (R14): ${APPS.length}`);
  const { ctx, page } = await open(wk, { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const bad = [];
  try {
    judge(`${dev} home`, await checkSurface(page), bad); await tipsClear(`${dev} home`, page, bad);
    // Menu rows（菜单行）: every row of an open .cmenu-pop is icon left + label right on ONE line, 44px+ tall, labelled.
    // Owner 2026-11-25 (v5.20.2): `.cmenu-pop button{display:block}` beat .ibtn's inline-flex, so each icon sat above its label.
    await page.evaluate(() => document.querySelectorAll('.pat-tip').forEach((t) => t.remove()));
    await page.click('#hmore'); await page.waitForSelector('#hmenu:not([hidden])');
    const rows = await page.evaluate(menuRows); report.push({ where: `${dev} home menu`, rows });
    assert.ok(rows.length >= 4, `the menu scan saw its rows (R14): ${rows.length}`);
    for (const r of rows) {
      if (!r.label) bad.push(`${dev} menu: a row with no visible label ${r.id}`);
      if (r.h < 43.5) bad.push(`${dev} menu: row ${r.id} is ${r.h}px tall`);
      if (r.icon && r.label && (r.icon.bottom <= r.label.top || r.label.bottom <= r.icon.top)) bad.push(`${dev} menu: ${r.id} icon and label on different lines`);
      if (r.icon && r.label && r.icon.right > r.label.left) bad.push(`${dev} menu: ${r.id} icon not left of its label`);
    }
    await page.keyboard.press('Escape');
    await page.evaluate(() => openDrawer()); await page.waitForTimeout(SETTLE_MS);
    judge(`${dev} drawer`, await checkSurface(page, { skip: 'main,#emptyState,header' }), bad);   // what the drawer covers is not on screen to a finger
    for (const slug of APPS) {
      await home(page);   // every app opened from a fresh home, with its unseen tips
      await page.evaluate((s) => openApp('owner', s, s), slug);
      // The shell may load the page as srcdoc (offline-first), so find it by element; wait for the NEW page's controls.
      let fr = null, m = null;
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(250);
        fr = await (await page.$('#fr')).contentFrame();
        m = fr && await checkSurface(fr).catch(() => null);   // a frame still loading: try again
        if (m && m.controls + m.inputs > 0 && await fr.evaluate(() => document.readyState === 'complete').catch(() => false)) break;
      }
      await page.waitForTimeout(SETTLE_MS); m = await checkSurface(fr);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${dev}-${slug}.png`) });
      assert.ok(m.controls + m.inputs > 0, `${slug}: the scan saw controls (R14)`);
      judge(`${dev} ${slug}`, m, bad); await tipsClear(`${dev} ${slug}`, fr, bad);
      for (const c of await squeezed(fr)) bad.push(`${dev} ${slug}: control squeezed or past the edge ${c}`);
      // A SHELL tip over the open app (audit #2: the home ⋯ tip sat on every app's title bar): measured in the
      // app's own coordinates, against the app's titles and controls.
      const box = await page.locator('#fr').boundingBox(), shellTips = await tipRects(page);
      const inApp = await fr.evaluate(() => [...document.querySelectorAll('h1,header,[role=banner],button,input,select,textarea,a[href],[role=button]')]
        .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0 && r.height < innerHeight / 2).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })));
      report.push({ where: `${dev} ${slug} shell-tips`, shellTips });
      for (const t of shellTips) { const r = { left: t.left - box.x, top: t.top - box.y, right: t.right - box.x, bottom: t.bottom - box.y };
        if (inApp.some((a) => overlaps(r, a))) bad.push(`${dev} ${slug}: shell tip ${t.id} covers the app's title or controls`); }
    }
  } finally { await ctx.close(); }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('desktop mouse (CONTROL): the touch floor stays off — the home avatar keeps its 36px', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await open(cr, { viewport: { width: 1568, height: 721 } });
  try {
    const coarse = await page.evaluate(() => matchMedia('(pointer:coarse)').matches);
    assert.equal(coarse, false, 'the desktop context is a mouse');
    const w = await page.evaluate(() => document.getElementById('hAvatar').getBoundingClientRect().width);
    assert.equal(Math.round(w), 36, 'desktop sizes untouched');
  } finally { await ctx.close(); }
});
