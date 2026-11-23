// Bible reader fixes in a REAL browser (R6): the real web.mjs on a throwaway root, the real shell and the
// shipped Bible in its sandboxed iframe. Each test names the triage item it covers (overnight 2026-11-23).
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

let port, web, browser, root;
const NOTES = () => path.join(root, 'workspace', 'data', 'bible', 'notes');
before(async () => {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  const d = path.join(root, 'workspace', 'apps', 'bible'); fs.mkdirSync(d, { recursive: true });
  for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, 'workspace', 'apps', 'bible', f), path.join(d, f));
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

const ready = () => document.querySelector('#nav .paab-home') && document.querySelectorAll('.verse').length > 5;
async function open({ viewport = { width: 1100, height: 850 }, touch = false } = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp(UID, 'bible', 'bible'));
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'bible frame loaded');
  await frame.waitForFunction(ready);
  return { ctx, page, frame };
}

// F2-12: a verse with only a highlight is listed as a Highlight row, not as a "Note".
test('F2-12: ☰ lists a highlight-only verse as 高亮 · Highlight; a verse with note text stays Note', { skip, timeout: 90000 }, async () => {
  fs.mkdirSync(NOTES(), { recursive: true });
  fs.writeFileSync(path.join(NOTES(), '1-1.json'), JSON.stringify({ notes: { v2: 'In the beginning — my note' }, marks: { v1: [{ kind: 'hl', color: 'yellow' }] } }));
  const { ctx, frame } = await open();
  try {
    await frame.locator('#log-btn').click();
    await frame.waitForFunction(() => document.querySelectorAll('.pac-lrow').length >= 2);
    const rows = await frame.evaluate(() => [...document.querySelectorAll('.pac-lrow')].map((r) => ({
      title: r.querySelector('.pac-lttl').textContent, chip: (r.querySelector('.pac-lchip') || {}).textContent || '' })));
    const hl = rows.find((r) => /Genesis 1:1$/.test(r.title)), note = rows.find((r) => /my note/.test(r.title));
    assert.ok(hl && note, JSON.stringify(rows));
    assert.equal(hl.chip, '高亮 · Highlight', 'highlight-only verse');
    assert.equal(note.chip, 'Note', 'control: a verse with note text keeps the Note chip');
  } finally { await ctx.close(); }
});

// F2-11: a direct /app/owner/bible/ link with no session lands on the shell's sign-in, then opens the Bible.
test('F2-11: signed-out direct app link → shell sign-in with #open; after sign-in the Bible opens and the hash is cleared', { skip, timeout: 90000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  try {
    const page = await ctx.newPage();
    const resp = await page.goto(`http://127.0.0.1:${port}/app/owner/bible/`);
    assert.equal(new URL(page.url()).hash, '#open=owner/bible', 'redirected to the shell with the return path');
    assert.ok(resp.ok(), 'the shell page, not a bare "not found"');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /^not found$/);
    await page.evaluate((t) => localStorage.setItem('pa_session', t), OWNER_TOKEN);   // stands in for the sign-in step
    await page.reload();
    let frame = null;
    for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
    assert.ok(frame, 'the Bible opened from the link');
    await frame.waitForFunction(ready);
    assert.equal(new URL(page.url()).hash, '', 'the hash is consumed: Home or a reload does not reopen it');
  } finally { await ctx.close(); }
});
