// Settings > Node settings: API keys folded under 高级 · Advanced (F5-12, owner decision 2026-11-23).
// The owner met six secret fields (Tavily, Exa, Firecrawl, AgentMail, Google id/secret) with no word on
// what they are for. They now sit in a closed fold, each with a one-line purpose; everyday values stay
// on top. Real browser (R6); without Playwright the test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

let port, root, web, browser;
before(async () => {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

test('API keys are in a closed Advanced fold with a purpose line each; values stay on top', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => document.querySelector('#dot.ok'));
    await page.click('#settings');
    await page.click('#nodeCfgWrap > summary');
    await page.waitForSelector('#cfgAdv');
    const adv = page.locator('#cfgAdv');
    assert.equal(await adv.evaluate((d) => d.open), false, 'closed by default');
    assert.match(await page.locator('#cfgAdv > summary').innerText(), /^高级 · Advanced/);
    assert.equal(await page.locator('#cfgAdv > summary').evaluate((s) => s.classList.contains('pa-new')), true, 'new-feature dot on first sight');
    for (const k of ['tavily_key', 'exa_key', 'firecrawl_key', 'agentmail_key', 'google_client_id', 'google_client_secret']) {
      assert.equal(await page.locator(`#cfgAdv [data-ck="${k}"]`).count(), 1, `${k} is in the fold`);
    }
    assert.equal(await page.locator('#cfgAdv [data-ck="max_concurrent"]').count(), 0, 'everyday values stay outside');
    assert.equal(await page.locator('#nodeCfgList [data-ck="max_concurrent"]').isVisible(), true);
    await page.click('#cfgAdv > summary');
    assert.equal(await page.locator('#cfgAdv [data-ck="tavily_key"]').isVisible(), true);
    assert.match(await page.locator('#cfgAdv [data-cpurpose="tavily_key"]').innerText(), /[一-鿿].* · [A-Za-z]/, 'a bilingual purpose line');
    await page.fill('#cfgAdv [data-ck="tavily_key"]', 'tvly-test-0000');
    await page.click('#cfgAdv [data-cs="tavily_key"]');
    await page.waitForSelector('#cfgAdv [data-cc="tavily_key"]');
    assert.equal(await adv.evaluate((d) => d.open), true, 'a save re-renders the list but keeps the fold open');
    const sx = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert.ok(sx, 'no horizontal scroll at phone width');
  } finally { await ctx.close(); }
});
