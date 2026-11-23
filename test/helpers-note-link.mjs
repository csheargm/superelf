// The real-browser harness for the note-link suites · 笔记链接的真实浏览器测试工具
//
// Shared by test/note-link-e2e.test.mjs (the Link button, end to end) and
// test/note-link-gate-e2e.test.mjs (which apps may open links). One server per test FILE: the REAL
// web.mjs on a throwaway root (test/helpers-web.mjs — never the live node, never live data), the
// real shell in Chromium, and the shipped Journal (shared-apps/notes) in the shell's sandboxed iframe.
//
// Playwright is NOT a dependency of this repo (no node_modules, by design). Set PA_PLAYWRIGHT to an
// installed copy's index.mjs, e.g.
//   PA_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node --test test/note-link-e2e.test.mjs
// Without a loadable Playwright AND its browser binary the e2e files FAIL at import (R14: a skip
// that looks like a clean run is vacuous success). Opt out explicitly with PA_E2E_SKIP=1 (CI does,
// as it installs no dependencies); then the tests SKIP and say why. Setup: docs/TODO.md "E2E setup".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { missingReason, resolveSkip } from './helpers-e2e-gate.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, waitFor, OWNER_TOKEN } from './helpers-web.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
async function loadChromium() {
  const spec = process.env.PA_PLAYWRIGHT;
  if (spec) return (await import(pathToFileURL(spec).href)).chromium;   // asked for, so a failure is loud
  try { return (await import('playwright')).chromium; } catch { return null; /* reported by missingReason() below */ }
}
export const chromium = await loadChromium();
export const skip = resolveSkip(await missingReason(chromium));

export const TARGET = 'https://example.com/';           // never fetched: the context routes it to a stub
export const SAVED = `<a href="${TARGET}" target="_blank" rel="noopener noreferrer">example</a>`;
export let port;                                         // live binding: set by setup()
let root, web, browser;

// The Journal, as shipped, under each slug in `slugs` (a slug off the link list is a control).
export async function setup({ slugs = ['notes'] } = {}) {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port });
  for (const slug of slugs) {
    const app = path.join(root, 'workspace', 'apps', slug);
    fs.mkdirSync(app, { recursive: true });
    for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(REPO, 'shared-apps', 'notes', f), path.join(app, f));
  }
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
}
export async function teardown() { if (browser) await browser.close(); if (web) await stopWeb(web); }

// Every page's pageHtml in every note the Journal wrote to THIS root's disk.
export function savedPages() {
  const out = [];
  const walk = (d) => { if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.json')) { try { const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (Array.isArray(j.pages)) for (const pg of j.pages) out.push(String(pg.pageHtml || '')); } catch { /* a half-written file: read again on the next poll */ } }
    } };
  walk(path.join(root, 'workspace', 'data'));
  return out.join('\n');
}
export const onDisk = (pred, what) => waitFor(() => pred(savedPages()), what, { timeoutMs: 10000 });
// The Journal's note index (written 600 ms after a note's first save): a reload before it lands
// reopens on a blank page, as it would for a user who closed the app that fast.
export const indexed = () => waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'data', 'notes', 'journal.json'), 'utf8')).entries.length > 0; }
  catch { return false; /* not written yet */ } }, 'the Journal index lists the note', { timeoutMs: 10000 });

export async function newContext(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 }, ...opts });
  // The shell's session, as a sign-in would leave it. Throws in the sandboxed app frame (opaque origin).
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the app's sandboxed frame has no storage */ } }, OWNER_TOKEN);
  await ctx.route('https://example.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>stub</p>' }));
  return ctx;
}
export async function openJournal(page, { touch = false, slug = 'notes' } = {}) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  // The shell's list of apps that may open links (LINK_APPS) is loaded: a tap before it is refused.
  await page.waitForFunction(() => LINK_APPS.size > 0);
  await page.evaluate((s) => openApp('owner', s, 'Journal'), slug);
  let frame = null;
  await page.waitForFunction((s) => document.querySelector('#fr').src.includes(`/app/owner/${s}/`), slug);
  for (let i = 0; i < 100 && !frame; i++) { frame = page.frames().find((f) => f.url().includes(`/app/owner/${slug}/`)) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'the Journal frame loaded');
  await frame.waitForFunction(() => window.PANote && document.querySelector('.pan-mtext') && !document.querySelector('.pan-lock.on'));
  await page.waitForTimeout(300);                                            // the note's load settles
  // These flows test links, not the bar: hold it shown so its idle hide (ADR 0035, which gives the bar's
  // height back and moves the page) cannot shift a word between measuring it and tapping it.
  await frame.evaluate(() => { if (window.PAAppBar && PAAppBar.state().mounted) PAAppBar.hold(true); });
  // A Journal with notes opens with its list docked beside the page, and the first tap anywhere
  // closes it — shifting the page under the finger. A user taps once to put it away; so does this.
  if (await frame.evaluate(() => !!document.querySelector('.pac-drawerhost.on'))) {
    const box = await page.locator('#fr').boundingBox();
    const at = { x: box.x + box.width - 40, y: box.y + box.height / 2 };   // empty paper, clear of the bars
    if (touch) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
    await frame.waitForFunction(() => !document.querySelector('.pac-drawerhost.on'));
    await page.waitForTimeout(300);
  }
  return frame;
}
// Page coordinates of a word (or of the first link) inside the app frame.
export async function wordAt(page, frame, word) {
  const box = await page.locator('#fr').boundingBox();
  const r = await frame.evaluate((w) => {
    const tl = document.querySelector('.pan-textlayer');
    const it = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT);
    for (let n; (n = it.nextNode());) { const i = n.nodeValue.indexOf(w); if (i < 0) continue;
      const rg = document.createRange(); rg.setStart(n, i); rg.setEnd(n, i + w.length);
      const b = rg.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }
    return null; }, word);
  assert.ok(r, `"${word}" is on the page`);
  return { x: box.x + r.x, y: box.y + r.y };
}
export const layerHtml = (frame) => frame.evaluate(() => document.querySelector('.pan-textlayer').innerHTML);
export const flashText = (frame) => frame.evaluate(() => { const f = document.querySelector('.pan-flash.on'); return f ? f.textContent : ''; });
export const linking = (frame) => frame.evaluate(() => document.querySelector('.pan-linkpop').classList.contains('on'));
export const lit = (frame, sel) => frame.evaluate((s) => document.querySelector(s).classList.contains('on'), sel);
// The Text mode button is a toggle, and a mostly-text note now OPENS in Text (openToolFor, d6af038):
// press it only when the page is not already editing, or the press would leave Text mode.
export async function textMode(frame) {
  if (!(await frame.evaluate(() => !!document.querySelector('.pan-textlayer.pan-txted')))) await frame.locator('.pan-mtext').click();
  await frame.waitForSelector('.pan-textlayer.pan-txted');
}
// Draw mode, the way a user gets there from a note that opened in Text: one press of Draw.
export async function drawMode(frame) {
  if (await frame.evaluate(() => !!document.querySelector('.pan-textlayer.pan-txted'))) await frame.locator('.pan-mdraw').click();
  await frame.waitForFunction(() => !document.querySelector('.pan-textlayer.pan-txted'));
}
export async function selectWord(page, frame, word) { const p = await wordAt(page, frame, word); await page.mouse.dblclick(p.x, p.y); }
