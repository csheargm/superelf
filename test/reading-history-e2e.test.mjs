// Reading history in a REAL browser (R6), on a throwaway root (test/helpers-web.mjs — never the live node):
//   open Genesis 1 then 2, reload → the Bible opens at Genesis 2; Search with an empty box lists
//   Genesis 2 then Genesis 1 (newest first); a row tap opens that chapter; Clear (two taps) empties it;
//   no horizontal scroll at phone 390x844 and iPad 1180x820, light and dark.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

const SHOTS = process.env.PA_SHOTS || '';   // optional: a directory to save screenshots into
let port, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); const root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  const d = path.join(root, 'workspace', 'apps', 'bible'); fs.mkdirSync(d, { recursive: true });
  for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, 'workspace', 'apps', 'bible', f), path.join(d, f));
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

async function openBible(page) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp(UID, 'bible', 'bible'));
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'bible frame loaded');
  await frame.waitForFunction(() => typeof _booted !== 'undefined' && _booted && document.querySelector('.verse'));
  return frame;
}
const where = (f) => f.evaluate(() => [+document.getElementById('book-sel').value, document.getElementById('ch-label').value]);
// F2-09: a chapter records once READ (scrolled, or open RH_DWELL_MS) — `read` scrolls it, as a reader would.
const read = async (f) => { await f.evaluate(() => { const v = document.getElementById('verses'); v.scrollTop += 200; }); await f.waitForTimeout(150); await f.evaluate(() => RH.idle()); };
const go = async (f, b, c) => { await f.evaluate(([b, c]) => { bookIdx = b; chapter = c; document.getElementById('book-sel').value = b; return load(); }, [b, c]); await read(f); };
const rows = (f) => f.evaluate(() => [...document.querySelectorAll('#search-results .prh-row')].map((r) => r.querySelector('.prh-name').textContent + ' | ' + r.querySelector('.prh-when').textContent));

test('the Bible reopens where you were reading; Search lists the history newest first; tap opens; Clear empties', { skip, timeout: 120000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  try {
    let f = await openBible(page);
    assert.deepEqual(await where(f), [42, '3'], 'control: first ever open is John 3');
    await read(f);
    await go(f, 0, 1); await go(f, 0, 2);
    await page.reload();
    f = await openBible(page);
    assert.deepEqual(await where(f), [0, '2'], 'reopened at Genesis 2');
    await f.evaluate(() => document.getElementById('search-btn').click());
    const list = await rows(f);
    assert.equal(list[0], '创世记 Genesis 第 2 章 | 刚刚 · Just now');
    assert.match(list[1], /^创世记 Genesis 第 1 章 \| /);
    assert.match(list[2], /^约翰福音 John 第 3 章 \| /);
    assert.equal(list.length, 3, 'deduped: Genesis 2 was loaded twice (go + reload) but listed once');
    assert.ok(await f.evaluate(() => document.querySelector('#search-results .sl-hint')), 'the search hint stays above the list');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'history-phone-light.png') });
    // Typing a query hides the list; clearing the box brings it back.
    await f.fill('#search-inp', 'love'); await f.press('#search-inp', 'Enter');
    await f.waitForFunction(() => !document.querySelector('#search-results .prh-row'));
    await f.fill('#search-inp', '');
    await f.waitForFunction(() => document.querySelectorAll('#search-results .prh-row').length === 3);
    // Tap a row → overlay closes, that chapter opens and moves to the top.
    await f.evaluate(() => document.querySelectorAll('#search-results .prh-row')[2].click());
    await f.waitForFunction(() => !document.getElementById('search-overlay').classList.contains('on') && document.getElementById('ch-label').value === '3' && document.querySelector('.verse'));
    assert.deepEqual(await where(f), [42, '3'], 'the tapped row opened John 3');
    await read(f);
    await f.evaluate(() => document.getElementById('search-btn').click());
    assert.match((await rows(f))[0], /^约翰福音 John 第 3 章/, 'and it is now newest');
    // Clear asks first: one tap arms, the second clears.
    await f.evaluate(() => document.querySelector('.prh-clear').click());
    assert.equal((await rows(f)).length, 3, 'one tap only asks');
    assert.match(await f.evaluate(() => document.querySelector('.prh-clear').textContent), /清除\? · Clear\?/);
    await f.evaluate(() => document.querySelector('.prh-clear').click());
    assert.equal((await rows(f)).length, 0, 'cleared');
    await f.evaluate(() => RH.idle());
    await page.reload(); f = await openBible(page);
    assert.deepEqual(await where(f), [42, '3'], 'clearing the list keeps the place you were reading');
    await read(f);
    await f.evaluate(() => document.getElementById('search-btn').click());
    assert.equal((await rows(f)).length, 1, 'only the chapter reopened just now');
  } finally { await ctx.close(); }
});

test('a #b<book>c<chapter> hash still wins over the restored chapter', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* sandboxed frame */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  try {
    let f = await openBible(page); await go(f, 0, 2);
    await f.evaluate(() => { location.hash = '#b18c23'; location.reload(); });
    await page.waitForTimeout(300);
    f = page.frames().find((x) => x.url().includes('/app/owner/bible/'));
    await f.waitForFunction(() => typeof _booted !== 'undefined' && _booted && document.querySelector('.verse'));
    assert.deepEqual(await where(f), [18, '23'], 'Psalm 23 from the hash, not Genesis 2');
  } finally { await ctx.close(); }
});

for (const [w, h] of [[390, 844], [1180, 820]]) for (const scheme of ['light', 'dark']) {
  test(`the history list fits at ${w}x${h} ${scheme}: no horizontal scroll`, { skip, timeout: 60000 }, async () => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
    await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* sandboxed frame */ } }, OWNER_TOKEN);
    const page = await ctx.newPage();
    try {
      const f = await openBible(page); await go(f, 65, 22);
      await f.evaluate(() => document.getElementById('search-btn').click());
      assert.ok((await rows(f)).length >= 1);
      const over = await f.evaluate(() => { const b = document.getElementById('search-results'); return [document.documentElement.scrollWidth - innerWidth, b.scrollWidth - b.clientWidth]; });
      assert.deepEqual(over, [0, 0], 'no horizontal overflow');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `history-${w}x${h}-${scheme}.png`) });
    } finally { await ctx.close(); }
  });
}

test('the first-use tip "Your reading history is in Search" shows beside the Search button at phone width', { skip, timeout: 120000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* sandboxed frame */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  try {
    let got = null;
    for (let i = 0; i < 6 && !got; i++) {       // one tip per open: earlier tips are dismissed, as a reader would
      const f = await openBible(page);
      await f.waitForFunction(() => PATips.current(), null, { timeout: 10000 });
      if (await f.evaluate(() => PATips.current()) === 'bible-history') got = f;
      else await f.evaluate(() => PATips.dismiss());
    }
    assert.ok(got, 'the reading-history tip showed within a few opens');
    const g = await got.evaluate(() => {
      const t = document.querySelector('.pat-tip[data-tip="bible-history"]'), b = document.getElementById('search-btn');
      const r = t.getBoundingClientRect(), a = b.getBoundingClientRect();
      return { text: t.textContent, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && r.width > 0,
        near: Math.abs((r.left + r.right) / 2 - (a.left + a.right) / 2) < innerWidth && Math.min(Math.abs(r.top - a.bottom), Math.abs(a.top - r.bottom)) < 60,
        btnShown: a.width > 0 && a.right <= innerWidth };
    });
    assert.match(g.text, /阅读历史在搜索里 · Your reading history is in Search/);
    assert.ok(g.btnShown && g.inView && g.near, JSON.stringify(g));
  } finally { await ctx.close(); }
});
