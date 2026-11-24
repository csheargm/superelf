// Settings closes from the TOP, wherever the page is scrolled (owner report 2026-11-23: "I have to
// go all the way down to the bottom of the page to close this page"). Real shell, real browser,
// phone / iPad / desktop sizes; PA_E2E_ENGINE=webkit runs it in iPad Safari's engine (R6).
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const SHOTS = process.env.PA_SHOTS_DIR || '';   // optional: where to save a screenshot per size
const SIZES = [{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1280, height: 800 }];
let port, root, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

async function openSettings(viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* frames without storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector('#dot.ok'));
  await page.click('#hmore'); await page.click('#settings');
  await page.waitForSelector('#addU');   // the owner's Family list has rendered: the page is at full length
  return { ctx, page };
}
const isOpen = (page) => page.evaluate(() => document.querySelector('#cfg').open);
const scrollToBottom = (page) => page.evaluate(() => { const d = document.querySelector('#cfg'); d.scrollTop = d.scrollHeight; return d.scrollTop; });

for (const vp of SIZES) {
  test(`${vp.width}x${vp.height}: scrolled to the bottom, the top ✕ is in view and closes Settings`, { skip, timeout: 60000 }, async () => {
    const { ctx, page } = await openSettings(vp);
    try {
      const top = await scrollToBottom(page);
      assert.ok(top > 0, `CONTROL: the page really scrolls (scrollTop ${top})`);
      const x = page.locator('#cfgClose');
      const box = await x.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= vp.height && box.x + box.width <= vp.width, `✕ inside the viewport: ${JSON.stringify(box)}`);
      assert.ok(box.height >= 44 && box.width >= 44, `a 44px touch target: ${JSON.stringify(box)}`);
      const head = await page.locator('#cfgHead').boundingBox();
      assert.ok(head.y <= 1, `the bar is flush with the top, nothing scrolls above it: y=${head.y}`);
      assert.match(await page.locator('#cfgTitle').innerText(), /^设置 · Settings$/);
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${process.env.PA_E2E_ENGINE || 'chromium'}-${vp.width}x${vp.height}-bottom.png`) }); }
      await x.click();
      await page.waitForFunction(() => !document.querySelector('#cfg').open);
    } finally { await ctx.close(); }
  });
}

test('Escape closes Settings', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await openSettings(SIZES[2]);
  try {
    await scrollToBottom(page);
    assert.equal(await isOpen(page), true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#cfg').open);
  } finally { await ctx.close(); }
});

test('one close control: no second Close button at the bottom', () => {
  const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'settings-dialog.html'), 'utf8');
  assert.equal((html.match(/value="cancel"/g) || []).length, 1, 'exactly one cancel control');
  assert.match(html, /id="cfgClose"[^>]*value="cancel"|value="cancel"[^>]*id="cfgClose"/);
});

test('Save sits in the top bar, lights up only on an edit, and ✕ with an unsaved edit asks first', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await openSettings(SIZES[0]);
  const asked = [];
  page.on('dialog', async (d) => { asked.push(d.message()); if (asked.length === 1) await d.dismiss(); else await d.accept(); });
  try {
    const save = page.locator('#cfgHead #pSave');
    assert.match(await save.innerText(), /^保存 · Save$/);
    assert.equal(await save.isDisabled(), true, 'nothing edited: Save is not lit');
    await page.fill('#pAbout', 'likes short answers');
    assert.equal(await save.isDisabled(), false, 'an edit lights Save');
    await scrollToBottom(page);
    await page.click('#cfgClose');
    await page.waitForTimeout(200);
    assert.match(asked[0] || '', /^有未保存的更改/, 'asked, 中文 first');
    assert.equal(await isOpen(page), true, 'Cancel keeps Settings and the edit');
    assert.equal(await page.inputValue('#pAbout'), 'likes short answers');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#cfg').open);
    assert.equal(asked.length, 2, 'Escape asks too; OK discards');
  } finally { await ctx.close(); }
});

test('the profile, family and shelf labels read 中文 first', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await openSettings(SIZES[2]);
  try {
    const t = await page.locator('#cfg').innerText();
    for (const s of ['你的资料 · Your profile', '名字 · Name', '关于你（助手会读）', '回复风格 · Reply style', '高级：AI 系统提示', '角色：所有者 · role: owner',
      '家庭账号 · Family accounts', '所有者 · owner', '添加成员 · Add member', '共享应用（家庭书架）', '活动记录 · Activity log', '退出登录 · Sign out', '修改密码（可选）']) assert.ok(t.includes(s), `shows "${s}"`);
    assert.ok(!/\bClose\b/.test(await page.locator('#cfg form > div:last-of-type').innerText()), 'no bottom Close');
  } finally { await ctx.close(); }
});

test('shelf Roll back / Remove are type="button": they never submit Settings\' dialog form past the discard guard', () => {
  const js = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'settings.js'), 'utf8');
  for (const attr of ['data-rb=', 'data-un=']) assert.match(js, new RegExp(`<button type="button"[^>]*${attr}`), `${attr} button has type="button"`);
});

test('a slow Save: one PUT only, an edit typed meanwhile keeps Settings open and dirty; a discarded password draft is gone on reopen', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await openSettings(SIZES[0]);
  page.on('dialog', (d) => d.accept());
  // Slow the PUT in the page itself (a Playwright route did not see this fetch in WebKit).
  await page.evaluate(() => {
    const f = window.fetch; window.__puts = 0; window.__slow = true;
    window.fetch = async (u, o) => {
      if (o && o.method === 'PUT' && String(u).includes('/api/profile')) { window.__puts++; if (window.__slow) await new Promise((r) => setTimeout(r, 800)); }
      return f(u, o);
    };
  });
  const puts = () => page.evaluate(() => window.__puts);
  try {
    await page.fill('#pAbout', 'first');
    await page.click('#pSave');
    assert.equal(await page.locator('#pSave').isDisabled(), true, 'Save is off while the PUT runs');
    await page.evaluate(() => document.querySelector('#pSave').click());   // a second tap does nothing
    await page.fill('#pAbout', 'typed during save');
    await page.waitForFunction(() => !document.querySelector('#pSave').disabled);
    assert.equal(await puts(), 1, 'exactly one PUT');
    assert.equal(await isOpen(page), true, 'still open: the later edit was not sent');
    assert.equal(await page.inputValue('#pAbout'), 'typed during save');
    await page.evaluate(() => { window.__slow = false; });
    await page.fill('#pPin', 'draftpass123');
    await page.click('#cfgClose');   // dialog accepted: discard
    await page.waitForFunction(() => !document.querySelector('#cfg').open);
    await page.click('#hmore'); await page.click('#settings');
    await page.waitForSelector('#addU');
    assert.equal(await page.inputValue('#pPin'), '', 'password draft cleared on open');
    assert.equal(await page.inputValue('#pAbout'), 'first', 'the saved value, not the discarded one');
  } finally { await ctx.close(); }
});
