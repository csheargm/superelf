// 经文顺序 Verse order in a REAL browser (R6): the real web.mjs on a throwaway root, the real shell and the
// shipped Bible in its sandboxed iframe. Owner 2026-11-24: show the Chinese verse (和合本) first, then the
// English (BSB); one tick in ⚙ Settings puts English first, remembered on the account.
//   1. default: every verse's 中文 line is above its English line (phone and both iPad widths);
//   2. the ⚙ tick flips it at once, and a reopen (a new browser context) keeps it: it is on the account;
//   3. ink and highlights written in ONE order stay over the SAME words after the order flips, both ways,
//      at iPad portrait and landscape widths, and the stored chapter file is byte-for-byte unchanged.
// CONTROL (R14): each ink check first proves the flip moved the line (its top changed by more than a
// line), so "the offset to the word did not change" cannot pass on a page that did not flip.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

const PHONE = { width: 390, height: 844 }, PORTRAIT = { width: 820, height: 1180 }, LANDSCAPE = { width: 1180, height: 820 };
const SHOTS = process.env.ZH_FIRST_SHOTS || '';   // optional: a folder for screenshots
const TOL = 2;                                     // px an ink placement may differ by, relative to its word
let port, web, browser, root;
const FILE = () => path.join(root, 'workspace', 'data', 'bible', 'notes', '43-3.json');
const notesDir = () => path.join(root, 'workspace', 'data', 'bible', 'notes');
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

const ready = () => typeof INK === 'object' && document.querySelectorAll('.verse').length > 5 && !ANN_LOADING;
async function open(viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp(UID, 'bible', 'bible'));
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/bible/')) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'bible frame loaded');
  await frame.waitForFunction(ready, null, { timeout: 90000 });
  await frame.evaluate(() => PAAppPrefs.whenIdle());
  await frame.waitForTimeout(300);                 // the boot readOrder() reply
  await frame.evaluate(() => { if (window.PATips) PATips.dismiss(); return PAAppPrefs.whenIdle(); });   // its tipsSeen write settles first: a pending prefs write racing a ⚙ Save is docs/TODO.md
  return { ctx, page, frame };
}
// Which line is first in each of the first verses: 'zh' or 'en', by DOM order AND by what is drawn higher.
const orders = (frame) => frame.evaluate(() => [...document.querySelectorAll('#verses .verse')].slice(0, 5).map((v) => {
  const en = v.querySelector('.ven'), zh = v.querySelector('.vzh'), dom = (zh.compareDocumentPosition(en) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'zh' : 'en';
  const y = zh.getBoundingClientRect().top < en.getBoundingClientRect().top ? 'zh' : 'en';
  return dom === y ? dom : `mismatch ${dom}/${y}`;
}));
const setOrder = async (frame, englishFirst) => { const r = await frame.evaluate((ef) => PAAppPrefs.patch({ englishFirst: ef }), englishFirst); assert.ok(r && r.ok, JSON.stringify(r)); };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); } };

test('default: 中文 first in every verse, at phone, iPad portrait and iPad landscape', { skip, timeout: 120000 }, async () => {
  for (const [vp, name] of [[PHONE, 'phone'], [PORTRAIT, 'ipad-portrait'], [LANDSCAPE, 'ipad-landscape']]) {
    const { ctx, page, frame } = await open(vp);
    try {
      assert.deepEqual(await orders(frame), ['zh', 'zh', 'zh', 'zh', 'zh'], name);
      assert.ok(await frame.evaluate(() => { const v = document.querySelector('#verses .verse'); return getComputedStyle(v.querySelector('.vzh')).color !== getComputedStyle(v.querySelector('.ven')).color; }), `${name}: the second line is muted`);
      await shot(page, `default-zh-first-${name}.png`);
    } finally { await ctx.close(); }
  }
});

test('⚙ Settings: the 经文顺序 tick (with its first-use tip) puts English first at once, Save keeps it on the account, untick brings 中文 back', { skip, timeout: 120000 }, async () => {
  let ctx;
  // Every other tip already seen (one tip per page open, ADR 0030), so THIS open is the new row's.
  ({ ctx } = await (async () => { const o = await open(PHONE); const r = await o.frame.evaluate(() => PAAppPrefs.patch({ tipsSeen: [...new Set(['app-own-bar', 'settings-openAi', ...PATips.registered().map((t) => t.id)])].filter((id) => id !== 'settings-englishFirst') }));
    assert.ok(r && r.ok); return o; })()); await ctx.close();
  let page, frame; ({ ctx, page, frame } = await open(PHONE));
  const tickAndSave = async (on, tip = false) => {
    await frame.locator('.pag-gear').click();
    const box = frame.locator('label.pag-chk', { hasText: '经文顺序' }).locator('input');
    await box.waitFor();
    if (tip) {   // the first-use tip beside the new row (one at a time: the older row's tip may come first)
      await frame.waitForFunction(() => PATips.current() === 'settings-englishFirst', null, { timeout: 10000 }).catch(() => {});
      assert.equal(await frame.evaluate(() => PATips.current()), 'settings-englishFirst', 'the new row shows its first-use tip');
      assert.match(await frame.evaluate(() => document.querySelector('.pat-tip').textContent), /经文默认中文在前/);
      await frame.waitForFunction(() => { const t = document.querySelector('.pat-tip.on'); return t && getComputedStyle(t).opacity === '1'; });
      assert.ok(await frame.evaluate(() => { const t = document.querySelector('.pat-tip').getBoundingClientRect(), e = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2); return !!(e && e.closest('.pat-tip')); }), 'the tip is on top, visible');
      await shot(page, 'settings-row-tip.png');
      await frame.evaluate(() => { PATips.dismiss(); return PAAppPrefs.whenIdle(); });
    }
    await frame.waitForFunction(() => !document.querySelector('.pag-go').disabled);
    if ((await box.isChecked()) !== on) await box.click();
    await shot(page, `settings-row-${on ? 'on' : 'off'}.png`);
    await frame.locator('.pag-go').click();
    await frame.waitForFunction(() => !document.querySelector('.pag-ov.on'));
  };
  try {
    await tickAndSave(true, true);
    await frame.waitForFunction(() => document.querySelector('#verses .verse .vnum + .ven'));
    assert.deepEqual(await orders(frame), ['en', 'en', 'en', 'en', 'en'], 'flipped at once, no reload');
  } finally { await ctx.close(); }
  ({ ctx, page, frame } = await open(PHONE));
  try {
    assert.deepEqual(await orders(frame), ['en', 'en', 'en', 'en', 'en'], 'remembered (a new context: the account, not the device)');
    await shot(page, 'english-first-phone.png');
    await tickAndSave(false);
    await frame.waitForFunction(() => document.querySelector('#verses .verse .vnum + .vzh'));
    assert.deepEqual(await orders(frame), ['zh', 'zh', 'zh', 'zh', 'zh']);
  } finally { await ctx.close(); }
});

// Word rect in the ink's own coordinates (PAInkAnchor's local(): the list's content space).
const wordAt = (frame, n, lang, word) => frame.evaluate(([n, lang, word]) => {
  const el = document.querySelector(`#verses .verse[data-n="${n}"] ${lang === 'zh' ? '.vzh' : '.ven'}`), c = document.getElementById('verses'), cr = c.getBoundingClientRect();
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let t, at = -1;
  while ((t = walk.nextNode())) { at = t.data.indexOf(word); if (at >= 0) break; }
  const r = document.createRange(); r.setStart(t, at); r.setEnd(t, at + word.length); const b = r.getClientRects()[0];
  const loc = (x, y) => ({ x: x - cr.left - c.clientLeft + c.scrollLeft, y: y - cr.top - c.clientTop + c.scrollTop });
  return { ...loc(b.left, b.top), w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2, l: b.left, r: b.right, b: b.bottom, lineTop: el.getBoundingClientRect().top - cr.top + c.scrollTop };
}, [n, lang, word]);
// A Pencil underline low across the word (client px; inside its row, so the PAD never reaches the next row), pointerdown on the line, moves + up on the window.
const underline = (frame, w, id) => frame.evaluate(([w, id]) => {
  const y = w.cy + (w.b - w.cy) * 0.5, el = document.elementFromPoint(w.l + 1, w.cy);
  const ev = (t, x) => new PointerEvent(t, { bubbles: true, cancelable: true, pointerType: 'pen', pointerId: id, clientX: x, clientY: y, pressure: 0.6 });
  el.dispatchEvent(ev('pointerdown', w.l)); for (const f of [0.25, 0.5, 0.75, 1]) window.dispatchEvent(ev('pointermove', w.l + (w.r - w.l) * f)); window.dispatchEvent(ev('pointerup', w.r));
}, [w, id]);
const TARGETS = [[1, 'en', 'Nicodemus'], [1, 'zh', '尼哥底母'], [2, 'en', 'teacher'], [2, 'zh', '师傅']];   // John 3, where the Bible opens
const MARKS = { v1: [{ kind: 'hl', color: 'yellow', lang: 'en', quote: 'Pharisees', start: 27, end: 36 }, { kind: 'hl', color: 'green', lang: 'zh', quote: '法利赛人', start: 3, end: 7 }],
  v2: [{ kind: 'hl', color: 'blue', lang: 'zh', quote: '耶稣', start: 6, end: 8 }] };
// Each ink record's placement minus its word's top-left, and each highlight's text + line.
async function measure(frame, { reflow = true } = {}) {
  if (reflow) await frame.evaluate(() => INK.reflow());
  const words = []; for (const [n, lang, w] of TARGETS) words.push(await wordAt(frame, n, lang, w));
  const at = await frame.evaluate(() => INK.placements().map((p) => p.at && { ox: p.at.ox, oy: p.at.oy, verse: p.g.verse, lang: p.g.lang, quote: p.g.quote }));
  const ink = TARGETS.map(([n, lang], i) => { const p = at.find((a) => a && a.verse === n && a.lang === lang); assert.ok(p, `ink on ${n}/${lang}: ${JSON.stringify(at)}`); return { dx: p.ox - words[i].x, dy: p.oy - words[i].y, quote: p.quote }; });
  const marks = await frame.evaluate(() => [...document.querySelectorAll('#verses mark.pvm')].map((m) => `${m.closest('.verse').dataset.n}/${m.closest('.ven') ? 'en' : 'zh'}:${m.textContent}`).sort());
  return { ink, marks, lineTops: words.map((w) => w.lineTop) };
}

for (const [vp, name] of [[PORTRAIT, 'ipad-portrait'], [LANDSCAPE, 'ipad-landscape']]) {
  for (const writtenEnFirst of [true, false]) {
    const from = writtenEnFirst ? 'English first (the old order)' : '中文 first';
    test(`${name}: ink + highlights written with ${from} stay on the same words after the order flips; nothing stored changes`, { skip, timeout: 150000 }, async () => {
      fs.rmSync(notesDir(), { recursive: true, force: true }); fs.mkdirSync(notesDir(), { recursive: true });
      fs.writeFileSync(FILE(), JSON.stringify({ marks: MARKS }));
      let { ctx, page, frame } = await open(vp);
      let before;
      try {
        await setOrder(frame, writtenEnFirst);
      } finally { await ctx.close(); }
      ({ ctx, page, frame } = await open(vp));
      try {
        assert.equal((await orders(frame))[0], writtenEnFirst ? 'en' : 'zh', 'written in this order');
        let id = 40; for (const [n, lang, w] of TARGETS) { await underline(frame, await wordAt(frame, n, lang, w), id++); await frame.waitForTimeout(1800); }   // apart: no handwriting burst joins them
        await frame.waitForFunction((k) => INK.groups().length === k, TARGETS.length);
        let last = '';
        for (let i = 0; i < 100; i++) { const s = fs.readFileSync(FILE(), 'utf8'); if (s === last && /"ink"/.test(s)) break; last = s; await frame.waitForTimeout(150); }
        before = { bytes: fs.readFileSync(FILE(), 'utf8'), ...(await measure(frame)) };
        // Each stroke pinned to the word it was drawn on. WebKit's caret geometry pins a wider run after a
        // CJK word near a row end (the anchoring engine as on origin/main; this change does not touch it),
        // so the pin must START at the word; the flip checks below are exact either way.
        before.ink.forEach((x, i) => assert.ok(x.quote.startsWith(TARGETS[i][2]), `stroke ${i} pinned to "${TARGETS[i][2]}": ${x.quote}`));
        assert.deepEqual(before.marks, ['1/en:Pharisees', '1/zh:法利赛人', '2/zh:耶稣']);
        await shot(page, `ink-${name}-written-${writtenEnFirst ? 'en' : 'zh'}-first.png`);
        await setOrder(frame, !writtenEnFirst);
        // LIVE flip, the path a ⚙ Save takes (onSave → readOrder), on the open page: the ink is redrawn at
        // once (INK.render runs) and sits on the same words with no reflow forced by the test.
        const renders = await frame.evaluate(async () => { let n = 0; const r = INK.render; INK.render = function (...a) { n++; return r.apply(this, a); }; await readOrder(); INK.render = r; return n; });
        assert.ok(renders >= 1, 'the flip redraws the ink');
        assert.equal((await orders(frame))[0], writtenEnFirst ? 'zh' : 'en', 'flipped live');
        const live = await measure(frame, { reflow: false });
        live.ink.forEach((x, i) => assert.ok(Math.abs(x.dx - before.ink[i].dx) <= TOL && Math.abs(x.dy - before.ink[i].dy) <= TOL, `live: ink on "${TARGETS[i][2]}" kept its place: ${JSON.stringify(before.ink[i])} -> ${JSON.stringify(x)}`));
        assert.deepEqual(live.marks, before.marks, 'live: highlights on the same words');
        await frame.waitForTimeout(1500);
        assert.equal(fs.readFileSync(FILE(), 'utf8'), before.bytes, 'live: the flip writes nothing');
      } finally { await ctx.close(); }
      ({ ctx, page, frame } = await open(vp));
      try {
        assert.equal((await orders(frame))[0], writtenEnFirst ? 'zh' : 'en', 'the order flipped');
        const now = await measure(frame);
        await shot(page, `ink-${name}-after-flip-to-${writtenEnFirst ? 'zh' : 'en'}-first.png`);
        now.lineTops.forEach((t, i) => assert.ok(Math.abs(t - before.lineTops[i]) > 10, `CONTROL: line ${TARGETS[i].join('/')} moved (${before.lineTops[i]} -> ${t})`));
        now.ink.forEach((x, i) => {
          assert.ok(Math.abs(x.dx - before.ink[i].dx) <= TOL && Math.abs(x.dy - before.ink[i].dy) <= TOL, `ink on "${TARGETS[i][2]}" kept its place on the word: ${JSON.stringify(before.ink[i])} -> ${JSON.stringify(x)}`);
        });
        assert.deepEqual(now.marks, before.marks, 'highlights on the same words');
        assert.equal(fs.readFileSync(FILE(), 'utf8'), before.bytes, 'the chapter file is byte-for-byte unchanged by the flip');
        assert.equal(await frame.evaluate(() => INK.placements().filter((p) => p.orphan).length), 0, 'no orphaned ink');
      } finally { await ctx.close(); }
    });
  }
}

// The member template (workspace.example) carries the same rule, and its ⚙ dialog opens: it handed the
// dialog chatData.system (a function), which cannot cross postMessage, so the dialog never loaded there.
test('workspace.example copy: 中文 first, and its ⚙ dialog opens with the 经文顺序 row', { skip, timeout: 120000 }, async () => {
  { const o = await open(PHONE); try { await setOrder(o.frame, false); } finally { await o.ctx.close(); } }   // the default, whatever the tests above left
  const served = path.join(root, 'workspace', 'apps', 'bible', 'index.html'), keep = fs.readFileSync(served);
  fs.copyFileSync(path.join(ROOT, 'workspace.example', 'apps', 'bible', 'index.html'), served);
  const { ctx, frame } = await open(PHONE);
  try {
    assert.deepEqual(await orders(frame), ['zh', 'zh', 'zh', 'zh', 'zh']);
    await frame.locator('.pag-gear').click();
    await frame.locator('label.pag-chk', { hasText: '经文顺序' }).locator('input').waitFor();
    await frame.waitForFunction(() => !document.querySelector('.pag-go').disabled && !document.querySelector('.pag-msg.pag-err'));
  } finally { await ctx.close(); fs.writeFileSync(served, keep); }
});
