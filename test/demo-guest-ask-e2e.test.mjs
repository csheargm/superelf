// A signed-out demo guest asks the AI · 演示访客未登录时提问 (F1-8, owner decision 2026-11-23).
// Overnight 2026-11-23: the guest's typed question vanished from the chat (only a red line stayed), and
// the sign-in / waiting-list popovers had no title, no close ✕, and a send button that read as plain
// text. Now the question stays in the chat with an inline "登录后获得回答 · Sign in to get an answer"
// button, and both popovers carry a title, a ✕ and a real (filled) button.
// Real web.mjs in demo mode + Chromium (R6). Without Playwright the file FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { startStubSupabase } from './helpers-demo-sb.mjs';
import { SIGNIN_LABELS } from '../lib/demo-boot.mjs';
import { POP_TITLES } from '../lib/demo-pop.mjs';
import { JOIN_EVENT } from '../lib/demo-waitlist-ui.mjs';
import { zh } from './helpers-lang.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = fs.readFileSync(path.join(REPO, 'web/index.html'), 'utf8');
let sb, web, root, port, browser;
before(async () => {
  if (skip) return;
  sb = await startStubSupabase(); port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [], demo: { enabled: true, title: 'superelf', new_users_per_ip_per_day: 50, auth: { supabase_url: sb.url, supabase_anon_key: 'public-anon', required: true } } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  web = startWeb(root); await waitReady(port); browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (sb) sb.srv.close(); if (root) rmTemp(root); });

test('R3: the shell\'s answer-button label is the demo\'s own', () => {
  assert.ok(SHELL.includes(`DEMO_SIGNIN_ANSWER='${SIGNIN_LABELS.answer}'`));
  assert.match(SIGNIN_LABELS.answer, /^登录后获得回答 · Sign in to get an answer$/);
});

// The boot reloads the page once when it first gets a node session (as test/demo-account-ui-e2e.test.mjs).
async function settled(page) {
  await waitFor(() => page.evaluate(() => document.readyState === 'complete' && performance.getEntriesByType('navigation')[0].type === 'reload')
    .catch(() => false /* mid-navigation: ask again */), 'the boot reload');
  await page.waitForSelector('header #demoSignin');
}
const filled = (loc) => loc.evaluate((b) => { const c = getComputedStyle(b).backgroundColor; return c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'; });

test('the question stays in the chat with an inline sign-in button; the popover has a title, ✕ and a real button', { skip, timeout: 60000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await settled(page);
    // The home ⋯ tip (top-most, PATips) would sit over the popover's ✕ at 390 on a 中文 device: close it first (docs/TODO.md).
    const tip = page.locator('.pat-tip[data-tip="tip:home-more"] .pat-x');
    if (await tip.waitFor({ timeout: 5000 }).then(() => true, () => false)) { await tip.click(); await page.evaluate(() => window.PATips.whenIdle()); }
    await page.fill('#box', 'make me an app for my groceries');
    await page.keyboard.press('Enter');
    const ans = page.locator('#log .msg button.demo-answer');
    await ans.waitFor();
    assert.equal(await ans.innerText(), SIGNIN_LABELS.answer);   // inside #log: the chat log is never switched (docs/TODO.md known limits)
    assert.match(await page.locator('#log .msg.me').last().innerText(), /make me an app for my groceries/, 'the typed question stays in the chat');
    const pop = page.locator('#demoAuth');
    await pop.waitFor();   // the refusal still opens the sign-in popover by itself
    assert.equal(await pop.locator('.demo-pop-h span').innerText(), zh(POP_TITLES.signin));
    assert.ok(await filled(pop.locator('button[type=submit]')), 'the send button is a filled button, not plain text');
    await pop.locator('.demo-pop-x').click();
    await pop.waitFor({ state: 'detached' });
    await ans.click();
    await pop.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  } finally { await page.close(); }
});

test('the waiting-list popover has a title, ✕ and a real button too', { skip, timeout: 60000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await settled(page);
    await page.evaluate((ev) => dispatchEvent(new Event(ev)), JOIN_EVENT);
    const pop = page.locator('#demoWait');
    await pop.waitFor();
    assert.equal(await pop.locator('.demo-pop-h span').innerText(), zh(POP_TITLES.join));
    assert.ok(await filled(pop.locator('button[type=submit]')));
    await pop.locator('.demo-pop-x').click();
    await pop.waitFor({ state: 'detached' });
  } finally { await page.close(); }
});
