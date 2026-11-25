// No dev overlay for users（不向用户显示调试面板）— owner iPhone 2026-11-25: triple-tapping the header title
// (easy by accident) covered the home chat with raw "standalone: / innerH: / vv.height:" text. The tool is
// deleted; this pins that no tap pattern on the title, nor common interactions, shows raw dev labels.
// Known limits: emulated WebKit; checks the shell page only, plus a static scan of web/ and shared-apps/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { missingReason, resolveSkip } from './helpers-e2e-gate.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const DEV_LABELS = /innerH:|vv\.height|vv\.offsetTop|viewTop offset|standalone: (true|false)/;   // rendered text
// The same labels as quoted string literals in source (code reading vv.height is fine; printing it is not).
const SRC_LABELS = /['"`](?:innerH: |vv\.height: |vv\.offsetTop: |viewTop offset|standalone: )/;
const pw = await (async () => { try { return process.env.PA_PLAYWRIGHT ? await import(pathToFileURL(process.env.PA_PLAYWRIGHT).href) : await import('playwright'); } catch { return null; } })();
const skip = resolveSkip(await missingReason(pw && pw.webkit));

test('no shipped page source carries the viewport debug overlay', () => {
  const root = path.join(import.meta.dirname, '..'), hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); }
    else if (/\.(html|js|mjs)$/.test(e.name) && SRC_LABELS.test(fs.readFileSync(f, 'utf8'))) hits.push(path.relative(root, f));
  } };
  walk(path.join(root, 'web')); walk(path.join(root, 'shared-apps'));
  assert.deepEqual(hits, []);
});

let port, root, web, wk;
before(async () => { port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port); if (!skip) wk = await pw.webkit.launch(); });
after(async () => { if (wk) await wk.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

test('triple-tapping the header title shows no dev overlay', { skip, timeout: 60000 }, async () => {
  const ctx = await wk.newContext({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* no storage: the page still loads */ } }, OWNER_TOKEN);
  try {
    const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => document.querySelector('#dot.ok'), null, { timeout: 20000 });
    const h1 = page.locator('header h1'); await h1.waitFor();
    for (let i = 0; i < 3; i++) await h1.click();               // the old trigger (CONTROL that the title is there)
    for (let i = 0; i < 6; i++) await h1.tap();
    await page.locator('#q, textarea').first().fill('hello').catch(() => { /* no composer on this layout: taps still checked */ });
    await page.waitForTimeout(300);
    const r = await page.evaluate((src) => ({ dbg: !!document.getElementById('dbg'), dev: new RegExp(src).test(document.body.innerText) }), DEV_LABELS.source);
    assert.deepEqual(r, { dbg: false, dev: false });
  } finally { await ctx.close(); }
});
