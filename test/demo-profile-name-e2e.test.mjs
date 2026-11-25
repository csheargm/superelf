// Settings name and reply style for a signed-in demo visitor, in a REAL browser (R6) · 演示设置名字与回复风格
// Google user (user_metadata.full_name) → Settings shows that name; email user → empty name box with
// a "type your name" hint, not the placeholder record name; the reply-style box is never prefilled.
// Without Playwright the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-e2e-gate.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { startStubSupabase } from './helpers-demo-sb.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let sb, web, root, port, browser;

before(async () => {
  if (skip) return;
  sb = await startStubSupabase();
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [], demo: { enabled: true, title: 'superelf', new_users_per_ip_per_day: 50, auth: { supabase_url: sb.url, supabase_anon_key: 'public-anon', required: true } } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (sb) sb.srv.close(); if (root) rmTemp(root); });

async function settings(claims) {
  const ctx = await browser.newContext();
  const a = sb.jwt(claims);
  await ctx.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('sb_session', s); } },
    JSON.stringify({ a, r: 'refresh', e: Math.floor(Date.now() / 1000) + 3600 }));
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await waitFor(() => page.evaluate(() => document.readyState === 'complete' && performance.getEntriesByType('navigation')[0].type === 'reload')
    .catch(() => false /* mid-navigation: ask again */), 'the boot reload');
  await page.waitForSelector('#demoDel', { state: 'attached' });
  await page.click('#hmore'); await page.click('#settings');
  await page.locator('#pName').waitFor({ state: 'visible' });
  await waitFor(() => page.evaluate(() => typeof ME === 'object' && !!ME.id), 'the profile load');
  return { ctx, page };
}

test('Google sign-in: Settings shows the account name; reply style is empty', { skip }, async () => {
  const { ctx, page } = await settings({ sub: 'g-user', email: 'ada@example.com', user_metadata: { full_name: 'Ada Lovelace', name: 'Ada' } });
  assert.equal(await page.inputValue('#pName'), 'Ada Lovelace');
  assert.equal(await page.inputValue('#pPrefs'), '');
  assert.doesNotMatch(await page.getAttribute('#pPrefs', 'placeholder'), /no preamble|EN \+ 中文/);
  await ctx.close();
});

test('email sign-in: empty name box with a type-your-name hint, never the placeholder name', { skip }, async () => {
  const { ctx, page } = await settings({ sub: 'e-user', email: 'bo@example.com', user_metadata: {} });
  assert.equal(await page.inputValue('#pName'), '');
  assert.match(await page.getAttribute('#pName', 'placeholder'), /name/i);
  assert.equal(await page.inputValue('#pPrefs'), '');
  await ctx.close();
});
