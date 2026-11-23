// The Journal header on iPad portrait, in a REAL browser · 日记顶栏（真实浏览器）
// The TEMPLATE Journal (workspace.example/apps/notes: ownBar, so Home · A- · A+ join the header) with its
// list docked at 820px — the overflow the overnight tester hit (F3-02). Throwaway root (helpers-note-link).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { skip, setup, teardown, newContext, openJournal, textMode, onDisk, indexed, port } from './helpers-note-link.mjs';

before(() => setup({ from: path.join('workspace.example', 'apps', 'notes') }));
after(teardown);

test('F3-02: iPad portrait, list docked, app bar shown: Print stays on screen and nothing covers it', { skip, timeout: 120000 }, async () => {
  let ctx = await newContext(); let page = await ctx.newPage();
  let frame = await openJournal(page);
  await textMode(frame); await frame.locator('.pan-textlayer').click(); await page.keyboard.type('A note so the list docks');
  await onDisk((h) => h.includes('list docks'), 'saved'); await indexed(); await ctx.close();
  ctx = await newContext({ viewport: { width: 820, height: 1180 } }); page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp('owner', 'notes', 'Journal'));
  await page.waitForFunction(() => document.querySelector('#fr').src.includes('/app/owner/notes/'));
  frame = null; for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/notes/')) || null; if (!frame) await page.waitForTimeout(50); }
  await frame.waitForFunction(() => window.PANote && document.querySelector('.pan-mtext') && document.querySelector('.pac-lrow'));
  assert.equal(await frame.evaluate(() => !!document.querySelector('.pac-drawerhost.on')), true, 'CONTROL: the list is docked');
  await frame.waitForFunction(() => !!(window.PAAppBar && PAAppBar.state().mounted), null, { timeout: 10000 });   // CONTROL: the app bar is in the header
  await frame.evaluate(() => PAAppBar.hold(true)); await page.waitForTimeout(400);
  for (const mode of ['text', 'draw']) {
    if (mode === 'draw') await frame.evaluate(() => document.querySelector('.pan-mdraw').click());
    await page.waitForTimeout(200);
    await frame.evaluate(() => document.querySelectorAll('.pat-tip').forEach((t) => t.remove()));   // first-use tips are F3-06's; here only the header layout counts
    const m = await frame.evaluate(() => { const b = document.querySelector('.pan-hprint').getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { right: Math.round(b.right), w: b.width, vw: document.documentElement.clientWidth, hit: !!(hit && hit.closest('.pan-hprint')) }; });
    assert.ok(m.w > 0 && m.right <= m.vw, `${mode}: Print inside the frame (right ${m.right} <= ${m.vw})`);
    assert.equal(m.hit, true, `${mode}: nothing covers Print`);
    const clear = await frame.evaluate(() => Math.round(document.querySelector('.pan-textlayer').getBoundingClientRect().top - document.querySelector('.pan-top').getBoundingClientRect().bottom));
    assert.ok(clear >= -1, `${mode}: the page starts below the (wrapped) header (gap ${clear}px)`);
  }
  await ctx.close();
});
