// The demo's new-visitor limit screen · 新访客上限页, and a quiet guest boot.
// Overnight 2026-11-23: a refused first visit wiped the page to one English-first line (no next step) and
// threw "Cannot set properties of null". Real browser (R6). Without Playwright these FAIL unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { QUOTA_MESSAGES } from '../lib/demo-quota.mjs';
import { LIMIT_LABELS } from '../lib/demo-boot.mjs';
import { WAITLIST_LABELS } from '../lib/demo-waitlist-ui.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = 'https://example.org/front';
const SHOTS = process.env.PA_SHOTS || '';

test('the new-visitor refusal reads 中文 first', () => {
  assert.match(QUOTA_MESSAGES.new_user, /^今天来自你网络的新访客太多 · Too many new visitors today/);
});

let full, browser;
async function node(extra) {
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig: { users: [], demo: { enabled: true, title: 'superelf', home_url: HOME, ...extra } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  const web = startWeb(root); await waitReady(port);
  return { port, root, web };
}
before(async () => {
  if (skip) return;
  full = await node({ new_users_per_ip_per_day: 0, auth: { supabase_url: 'http://127.0.0.1:9', supabase_anon_key: 'public-anon', required: false } });
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  for (const n of [full]) if (n) { await stopWeb(n.web); rmTemp(n.root); }
});

test('refused first visit: 中文-first card with sign-in, waiting list and tomorrow; no page error', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(`http://127.0.0.1:${full.port}/`);
  const card = page.locator('#demoStop');
  await card.waitFor({ state: 'visible' });
  assert.match(await card.innerText(), /^今天来自你网络的新访客太多 · Too many new visitors today/);
  assert.equal(await page.locator('#demoStopJoin').innerText(), LIMIT_LABELS.join);
  assert.equal(await page.locator('#demoStopSignin').innerText(), LIMIT_LABELS.signin);
  assert.ok((await card.innerText()).includes(LIMIT_LABELS.tomorrow));
  assert.ok(await page.locator('#drawer').count(), 'the shell stays in the page (no wiped body)');
  await page.waitForTimeout(800);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'demo-limit-screen.png') });
  assert.deepEqual(errors, []);
  await page.locator('#demoStopSignin').click();   // the next step really opens the shell's sign-in
  await page.locator('#demoAuth input[type=email]').waitFor({ state: 'visible' });
  assert.equal(await card.count(), 0);
  await ctx.close();
});

test('refused first visit: the waiting-list button opens the form, which sends with no session', { skip }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${full.port}/`);
  await page.locator('#demoStopJoin').click();
  assert.equal(await page.locator('#demoStop').count(), 0);
  await page.locator('#demoWait input[type=email]').fill('limit-visitor@example.org');
  await page.locator('#demoWait button[type=submit]').click();
  await page.waitForFunction((t) => document.querySelector('#demoWait')?.textContent.includes(t), WAITLIST_LABELS.thanks);
  assert.equal(await page.evaluate(() => localStorage.getItem('pa_session')), null, 'sent with no node session');
  await ctx.close();
});

test('refused first visit: Escape does not close the limit card', { skip }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${full.port}/`);
  const card = page.locator('#demoStop'); await card.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  assert.ok(await card.evaluate((d) => d.open), 'the card stays open');
  await ctx.close();
});
