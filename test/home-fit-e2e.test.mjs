// 主页在每个宽度都整齐 · The home fits at every width (R6), a real browser on a throwaway DEMO node (no live data,
// no session on try.superelf.app). Owner 2026-11-27 (2000px desktop Chrome, v5.38.3): the language tip ran off
// the right edge and read as cut text; the iPhone date had no year; the disclaimer showed both languages (its
// live text is English-first, which PALang did not split). Checks per width, in 中文 and English: every overlay
// fits (test/helpers-visual.mjs), the date line carries the year, the disclaimer is one language.
// The harness engine (`chromium` export): Chromium at 390/820/1280/1920/2000; PA_E2E_ENGINE=webkit (iPhone Safari's
// engine, CI's macOS job) at 390x844. PA_SHOTS=<dir> saves pictures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, waitFor, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { assertFits } from './helpers-visual.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.PA_SHOTS || '';
// The live demo's wording, English first (as try.superelf.app serves it).
const NOTICE = "AI answers come from third-party cloud models (Ollama). Don't enter sensitive personal information. · AI 回答来自第三方云端模型（Ollama），请勿输入敏感个人信息。";
const DEMO = { enabled: true, auth: { required: false }, ai_calls_per_user_per_day: 80, ai_calls_per_ip_per_day: 800, new_users_per_ip_per_day: 50,
  app_builds_per_user_per_day: 20, user_disk_mb: 20, total_disk_gb: 5, notice: NOTICE };
const ENGINE = chromium && typeof chromium.name === 'function' ? chromium.name() : 'chromium';
const ALL = [[390, 844], [820, 1180], [1280, 800], [1920, 1080], [2000, 1100]];
const WIDTHS = (ENGINE === 'webkit' ? ALL.slice(0, 1) : ALL).map(([w, h]) => [ENGINE, w, h]);
const YEAR = String(new Date().getFullYear());
let port, root, web, oport, oroot, oweb; const browsers = {};

before(async () => {
  if (skip) return;
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [], demo: DEMO } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  web = startWeb(root); await waitReady(port);
  oport = await freePort(); oroot = mkWebRoot({ port: oport });   // a signed-in account: the home shows the date line
  fs.cpSync(path.join(REPO, 'workspace.example', 'apps'), path.join(oroot, 'workspace', 'apps'), { recursive: true });
  oweb = startWeb(oroot); await waitReady(oport);
  browsers[ENGINE] = await chromium.launch();
});
after(async () => { for (const b of Object.values(browsers)) await b.close(); if (web) await stopWeb(web); if (root) rmTemp(root); if (oweb) await stopWeb(oweb); if (oroot) rmTemp(oroot); });

// Dismiss the tips ahead of the language tip (one shows at a time), so the ⋯ tip itself is measured.
async function toLangTip(page) {
  await waitFor(() => page.evaluate(() => !!window.PATips && !!PATips.current()).catch(() => false), 'a first-use tip');
  for (let i = 0; i < 20; i++) {
    if (await page.evaluate(() => PATips.current()) === 'tip:lang-switch') break;
    await page.evaluate(() => PATips.dismiss()); await page.waitForTimeout(120);
  }
  assert.equal(await page.evaluate(() => PATips.current()), 'tip:lang-switch', 'the language tip is on screen');
  await page.waitForTimeout(300);   // its fade
}

for (const [engine, w, h] of WIDTHS) for (const locale of ['en-US', 'zh-CN']) {
  test(`${engine} ${w}px ${locale}: the ⋯ tip fits, the date has the year, the disclaimer is one language`, { skip, timeout: 90000 }, async () => {
    const c = await browsers[engine].newContext({ viewport: { width: w, height: h }, locale, hasTouch: w < 500 });
    try {
      const page = await c.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('#hStart .st');
      await toLangTip(page);
      await assertFits(page, `${engine} ${w} ${locale}`);
      const tip = await page.evaluate(() => { const t = document.querySelector('.pat-tip'), r = t.getBoundingClientRect(), a = document.querySelector('#hmore').getBoundingClientRect();
        return { right: r.right, left: r.left, W: document.documentElement.clientWidth, aRight: a.right, text: t.innerText }; });
      assert.ok(tip.right <= tip.W - 8 + 0.5 && tip.left >= 8 - 0.5, `the tip keeps an 8px margin: ${JSON.stringify(tip)}`);
      assert.ok(tip.right <= tip.aRight + 0.5, 'a right-side anchor: the tip grows inward, not past the ⋯ button');
      assert.ok(!/[⋯…]\s*✕?\s*$/.test(tip.text.replace('✕', '').trim()), `the text does not end in an ellipsis-like ⋯: ${tip.text}`);
      const notice = await page.evaluate(() => document.querySelector('#hNotice').innerText.trim());
      assert.ok(notice.length > 0, 'the disclaimer shows');
      if (locale === 'en-US') assert.doesNotMatch(notice, /[一-鿿]/, `English only: ${notice}`);
      else assert.doesNotMatch(notice, /[A-Za-z]{4,} [a-z]{3,}/, `中文 only: ${notice}`);
      assert.ok(!notice.includes(' · '), 'no joined pair');
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `home-${engine}-${w}-${locale}.png`) }); }
    } finally { await c.close(); }
  });
}

for (const [engine, w, h] of WIDTHS.filter(([, w]) => w === 390 || w === 1280)) for (const [locale, want] of [['en-US', `, ${YEAR}`], ['zh-CN', `${YEAR}年`]]) {
  test(`${engine} ${w}px ${locale}: a signed-in home's date line carries the year; the ⋯ tip fits`, { skip, timeout: 90000 }, async () => {
    const sess = (await (await fetch(`http://127.0.0.1:${oport}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER_TOKEN }) })).json()).token;
    const c = await browsers[engine].newContext({ viewport: { width: w, height: h }, locale, hasTouch: w < 500 });
    try {
      await c.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* no storage: the test fails on the date below */ } }, sess);
      const page = await c.newPage(); await page.goto(`http://127.0.0.1:${oport}/`);
      await page.waitForSelector('#hStart .st');
      const date = await page.evaluate(() => document.querySelector('#hHello .en').innerText.trim());
      assert.ok(date.includes(want), `the date carries the year (${want}): ${date}`);
      await page.evaluate((u) => fetch('/api/profile', { method: 'PUT', headers: { authorization: 'Bearer ' + u, 'content-type': 'application/json' }, body: JSON.stringify({ tipsSeen: [] }) }), sess);
      await toLangTip(page);
      await assertFits(page, `owner ${engine} ${w} ${locale}`);
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `owner-${engine}-${w}-${locale}.png`) });
    } finally { await c.close(); }
  });
}
