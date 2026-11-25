// Shared harness for the panel-window e2e files (R3): the real web.mjs on a throwaway root, the real shell and
// the shipped Bible in its sandboxed iframe at John 3. useBibleServer() registers the before/after hooks.
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

export { skip };
let port, web, browser, root;
export const SHOTS = process.env.PA_PANEL_SHOTS || '';   // a folder: screenshots for the owner's screen check
export const ctxNew = (o) => browser.newContext(o);
export const rootDir = () => root;
export function useBibleServer() {
  before(async () => {
    if (skip) return;
    port = await freePort(); root = mkWebRoot({ port });
    fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
    const d = path.join(root, 'workspace', 'apps', 'bible'); fs.mkdirSync(d, { recursive: true });
    for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, 'shared-apps', 'bible', f), path.join(d, f));
    web = startWeb(root); await waitReady(port);
    browser = await chromium.launch();
  });
  after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });
}

export const DESK = { width: 1230, height: 1056 };
export async function open({ viewport = DESK, touch = false, ctx = null } = {}) {
  ctx = ctx || await ctxNew({ viewport, hasTouch: touch, isMobile: touch && viewport.width < 600 });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp(UID, 'bible', 'bible'));
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'bible frame loaded');
  await frame.waitForFunction(() => document.querySelectorAll('.verse').length > 5);
  await frame.evaluate(() => goChapter(42, 3));   // John 3
  await frame.waitForFunction(() => chapter === 3 && document.querySelectorAll('.verse').length > 30);
  await frame.evaluate(() => { if (window.PATips && PATips.current()) PATips.dismiss(PATips.current()); });
  const off = await (await frame.frameElement()).boundingBox();
  return { ctx, page, frame, off };
}
// Window state by title key ('chat' | 'note'), read from the page.
export const win = (frame, key) => frame.evaluate((k) => { const w = rail && rail.win(k); if (!w) return null;
  const el = w.el, r = el.getBoundingClientRect(); return { ...w.state(), on: el.classList.contains('on'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }, key);
export const vis = (frame) => frame.evaluate(() => [...document.querySelectorAll('.paw-win.on .paw-t')].map((t) => t.textContent));
// A mouse drag in page coordinates; `mid` runs while still pressed (preview checks).
export async function drag(page, off, from, to, mid) {
  await page.mouse.move(off.x + from.x, off.y + from.y); await page.mouse.down();
  await page.mouse.move(off.x + from.x + 10, off.y + from.y + 10, { steps: 2 });
  await page.mouse.move(off.x + to.x, off.y + to.y, { steps: 8 });
  if (mid) await mid();
  await page.mouse.up();
}
export const barOf = async (frame, key) => frame.evaluate((k) => { const r = rail.win(k).el.querySelector('.paw-t').getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; }, key);
export const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

// Runs FIRST: tipsSeen lives on this server, and any later test's first tap would dismiss it.
