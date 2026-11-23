// Members get the same one-time first-use tips · 成员同样看到首次使用提示 (F4-7, owner decision 2026-11-23).
// A real browser (R6): a member the owner just added opens their Notes — copied from the starter
// apps — and the first-use tip shows; one tap dismisses it for good (it stays gone on the next open).
// CONTROL (R14): the owner's first open shows a tip the same way.
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

let port, root, web, browser;
before(async () => {
  port = await freePort(); root = mkWebRoot({ port });
  fs.cpSync(path.join(ROOT, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });   // a real install's starters
  fs.cpSync(path.join(ROOT, 'shared-apps', 'notes'), path.join(root, 'shared-apps', 'notes'), { recursive: true });   // the family shelf's Notes
  for (const slug of ['notes']) fs.cpSync(path.join(ROOT, 'workspace.example', 'apps', slug), path.join(root, 'workspace', 'apps', slug), { recursive: true });
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

async function openNotes(token, uid, from = null) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, token);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate((f) => openApp(f || UID, 'notes', 'Notes'), from);
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes(`/app/${uid}/notes/`)) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'the notes frame loaded');
  return { ctx, frame };
}
const tipShown = (frame) => frame.waitForSelector('.pat-tip', { timeout: 15000 }).then(() => true, () => false);

test('a new member sees the first-use tip, and one tap dismisses it for good; the owner too', { skip, timeout: 120000 }, async () => {
  const add = await fetch(`http://127.0.0.1:${port}/api/admin/users`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}` }, body: JSON.stringify({ id: 'mara', name: 'Mara' }) });
  const { token } = await add.json();
  assert.ok(token, 'a member with no password gets a sign-in code');
  const session = (await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })).json()).token;
  let { ctx, frame } = await openNotes(session, 'mara');
  assert.equal(await tipShown(frame), true, 'the member\'s first open shows a tip');
  const id = await frame.evaluate(() => document.querySelector('.pat-tip').dataset.tip);
  await frame.click('.pat-tip');
  await frame.waitForFunction((t) => (window.PATips.seen() || []).includes(t) || [...(window.PATips.seen() || [])].includes(t), id);
  await frame.evaluate(() => window.PATips.whenIdle());   // the seen write reached the server before the tab closes
  await ctx.close();
  ({ ctx, frame } = await openNotes(session, 'mara'));
  await frame.waitForTimeout(2500);
  assert.notEqual(await frame.evaluate(() => document.querySelector('.pat-tip')?.dataset.tip || null), id, 'the dismissed tip stays gone');
  await ctx.close();
  const leo = (await (await fetch(`http://127.0.0.1:${port}/api/admin/users`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}` }, body: JSON.stringify({ id: 'leo', name: 'Leo' }) })).json()).token;
  const leoSession = (await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: leo }) })).json()).token;
  ({ ctx, frame } = await openNotes(leoSession, 'shared', 'shared'));
  assert.equal(await tipShown(frame), true, 'a member opening the family shelf\'s Notes sees the tip too');
  await ctx.close();
  ({ ctx, frame } = await openNotes(OWNER_TOKEN, 'owner'));
  assert.equal(await tipShown(frame), true, 'CONTROL: the owner\'s first open shows a tip');
  await ctx.close();
});
