// An unsaved note never lands in another chapter (data integrity), in a REAL browser (R6): the real
// web.mjs on a throwaway root, the real shell and the shipped Bible. SCAR: every chapter change mutated
// bookIdx/chapter before the open pad's pending save ran, and saveAnn() read the LIVE location — so the
// note typed in John 3 was written (with John 3's whole ANN) over the chapter navigated to. Each path
// below types into the note, navigates inside the pad's save debounce, and checks the disk: the text is
// in John 3's file and no other chapter file was created or changed.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1. PA_E2E_ENGINE=webkit runs it in WebKit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium, textMode } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

let port, web, browser, root;
// Both shipped Bibles: the owner's copy (also the shelf's) and the member template, installed side by side.
const COPIES = { bible: path.join('workspace', 'apps', 'bible'), 'bible-member': path.join('workspace.example', 'apps', 'bible') };
const NOTES = (slug) => path.join(root, 'workspace', 'data', slug, 'notes');
const HOME = 'John 3', HOME_FILE = '43-3.json';                       // bookIdx 42, chapter 3
const SEED = { notes: {}, draws: {}, titles: { general: 'seeded — must stay' } };
before(async () => {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port });
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  for (const [slug, from] of Object.entries(COPIES)) {
    const d = path.join(root, 'workspace', 'apps', slug); fs.mkdirSync(d, { recursive: true });
    for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, from, f), path.join(d, f));
    fs.mkdirSync(NOTES(slug), { recursive: true });
    fs.writeFileSync(path.join(NOTES(slug), '43-4.json'), JSON.stringify(SEED));   // John 4 HAS notes: an overwrite would replace them
    fs.writeFileSync(path.join(root, 'workspace', 'data', slug, 'reading.json'),
      JSON.stringify({ v: 1, last: { b: 42, c: 3, at: 1 }, history: [{ b: 42, c: 3, at: 2 }, { b: 42, c: 4, at: 1 }] }));
  }
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); });

async function open(slug) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate((s) => openApp(UID, s, s), slug);
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes(`/app/owner/${slug}/`)) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'bible frame loaded');
  await frame.waitForFunction(() => document.querySelectorAll('.verse').length > 5);
  return { ctx, page, frame };
}
const others = (slug) => Object.fromEntries(fs.readdirSync(NOTES(slug)).filter((f) => f.endsWith('.json') && f !== HOME_FILE).map((f) => [f, fs.readFileSync(path.join(NOTES(slug), f), 'utf8')]));
const homeText = (slug) => { try { return fs.readFileSync(path.join(NOTES(slug), HOME_FILE), 'utf8'); } catch { return ''; } };
const swipeLeft = (frame) => frame.evaluate(() => {
  const el = document.querySelector('#verses .verse') || document.getElementById('verses');   // the text, wherever the rail puts it
  const r = el.getBoundingClientRect(), y = r.top + 5, x0 = r.left + Math.min(400, r.width - 5);
  const mk = (x) => ({ identifier: 1, target: el, clientX: x, clientY: y, touchType: 'direct' });
  const fire = (type, x, live) => { const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(ev, { touches: { value: live ? [mk(x)] : [] }, changedTouches: { value: [mk(x)] } }); el.dispatchEvent(ev); };
  fire('touchstart', x0, true); fire('touchmove', x0 - 150, true); fire('touchend', x0 - 300, false);
});
const blur = (frame) => frame.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
// Each path: how to leave John 3 while the typed text is still inside the pad's debounce.
const PATHS = {
  'nothing (CONTROL: the typed note saves at all)': null,
  'next button': (f) => f.evaluate(() => document.getElementById('end-next').click()),
  'swipe': async (f) => { await blur(f); await swipeLeft(f); },
  'arrow key': async (f) => { await blur(f); await f.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))); },
  'chapter dropdown': (f) => f.locator('#ch-label').selectOption('4'),
  'book picker': (f) => f.locator('#book-sel').selectOption('43'),
  'search result': (f) => f.evaluate(() => { const r = document.getElementById('search-results'); r.innerHTML = '<div class="sr" data-b="43" data-c="4" data-v="1">John 4:1</div>'; r.firstChild.click(); }),
  'reading history': (f) => f.evaluate(() => { document.getElementById('search-btn').click(); const row = [...document.querySelectorAll('.prh-row')].find((r) => r.dataset.c === '4'); row.click(); }),
  'daily reading': (f) => f.evaluate(() => document.getElementById('daily-btn').click()),
  'verse link': (f) => f.evaluate(() => jumpToRef(42, 4, [1])),
};
// Where each path must arrive (review 2026-11-23: "left John 3" alone would pass a path that went nowhere useful).
// null: the daily plan's chapter depends on the date, so only "left John 3" is checked.
const ARRIVE = { 'next button': [42, 4], 'swipe': [42, 4], 'arrow key': [42, 4], 'chapter dropdown': [42, 4], 'book picker': [43, 1],
  'search result': [42, 4], 'reading history': [42, 4], 'daily reading': null, 'verse link': [42, 4] };
// One test per copy (CI skips e2e, and every test is a counted skip there); each path is a subtest-free loop step
// whose assertion messages name the path.
for (const slug of Object.keys(COPIES)) test(`${slug}: an unsaved ${HOME} note stays in ${HOME} whichever way the chapter changes`, { skip, timeout: 600000 }, async () => {
  for (const [name, go] of Object.entries(PATHS)) {
    const { ctx, page, frame } = await open(slug);
    try {
      if (name === 'reading history') await frame.waitForFunction(() => typeof RH !== 'undefined');
      await frame.evaluate(() => { bookIdx = 42; chapter = 3; document.getElementById('book-sel').value = 42; return load(); });
      await frame.waitForFunction(() => document.querySelectorAll('.verse').length > 5);
      const before = others(slug);
      await frame.locator('#top-note').click();
      await textMode(frame); await frame.locator('.pan-textlayer').click();
      const word = `typed-${name.replace(/\W/g, '')}-${Date.now()}`;
      await page.keyboard.type(word);
      if (go) { await go(frame); await frame.waitForFunction(() => !(bookIdx === 42 && chapter === 3)); }   // well inside the 700 ms save debounce
      if (go && ARRIVE[name]) assert.deepEqual(await frame.evaluate(() => [bookIdx, chapter]), ARRIVE[name], `${name}: arrived where it should`);
      for (let i = 0; i < 100 && !homeText(slug).includes(word); i++) await page.waitForTimeout(100);
      await page.waitForTimeout(1500);                                     // any late write to the new chapter would land by now
      assert.ok(homeText(slug).includes(word), `${name}: the note is saved under ${HOME}`);
      const after = others(slug);
      for (const [f, body] of Object.entries(after)) assert.ok(!body.includes(word), `${name}: ${f} must not hold the ${HOME} note`);
      assert.deepEqual(after, before, `${name}: no other chapter file was created or changed`);
      fs.rmSync(path.join(NOTES(slug), HOME_FILE), { force: true }); for (const f of fs.readdirSync(NOTES(slug))) if (f.endsWith('.bak')) fs.rmSync(path.join(NOTES(slug), f));
    } finally { await ctx.close(); }
  }
});

// A photo picked in John 3 whose upload answers after the reader moved to John 4 (review 2026-11-23): the
// pane has reloaded into John 4's note by then, so inserting into page() would put John 3's photo in John 4.
// The upload is held open by a stub PAPhoto; CONTROL: the same held upload, released without moving, lands in John 3.
const PHOTO = 'uploads/held-photo.png';
async function heldPhoto(slug, move) {
  const { ctx, page, frame } = await open(slug);
  try {
    await frame.evaluate(() => { bookIdx = 42; chapter = 3; document.getElementById('book-sel').value = 42; return load(); });
    await frame.waitForFunction(() => document.querySelectorAll('.verse').length > 5 && !ANN_LOADING);
    const before = others(slug);
    await frame.locator('#top-note').click();
    await frame.waitForFunction(() => document.querySelector('.pan-photoopt[data-photo="library"]'));
    await frame.evaluate((p) => {
      window.PAScan = undefined;
      const real = window.PAPhoto;
      window.PAPhoto = Object.assign({}, real, {
        pick: async () => ({ ok: true, files: [new File([new Uint8Array([1, 2, 3])], 'held.png', { type: 'image/png' })] }),
        upload: () => new Promise((r) => { window.__releasePhoto = () => r({ ok: true, path: p }); }),
      });
      document.querySelector('.pan-photoopt[data-photo="library"]').click();
    }, PHOTO);
    await frame.waitForFunction(() => typeof window.__releasePhoto === 'function');
    if (move) {
      await frame.evaluate(() => document.getElementById('end-next').click());
      await frame.waitForFunction(() => bookIdx === 42 && chapter === 4 && !ANN_LOADING);
      await page.waitForTimeout(500);                                     // the pane reloads into John 4's note
    }
    await frame.evaluate(() => window.__releasePhoto());
    for (let i = 0; i < 30 && !(homeText(slug).includes(PHOTO)); i++) await page.waitForTimeout(100);
    await frame.evaluate(() => drawPad.flush && drawPad.flush());
    await page.waitForTimeout(1500);
    const after = others(slug);
    for (const [f, body] of Object.entries(after)) assert.ok(!body.includes(PHOTO), `${f} must not hold the John 3 photo`);
    if (move) assert.deepEqual(after, before, 'no other chapter file was created or changed');
    return homeText(slug).includes(PHOTO);
  } finally {
    await ctx.close();
    fs.rmSync(path.join(NOTES(slug), HOME_FILE), { force: true }); for (const f of fs.readdirSync(NOTES(slug))) if (f.endsWith('.bak')) fs.rmSync(path.join(NOTES(slug), f));
  }
}
test('bible: a photo whose upload answers after a chapter change goes into no other chapter; CONTROL: unmoved, it lands in John 3', { skip, timeout: 120000 }, async () => {
  assert.equal(await heldPhoto('bible', false), true, 'CONTROL: the held upload, released in place, is in John 3');
  await heldPhoto('bible', true);
});
