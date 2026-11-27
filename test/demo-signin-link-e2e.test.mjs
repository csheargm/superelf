// The magic link explains itself, in a REAL browser (R6) · 登录链接说清楚
// Owner 2026-11-24: a link opened in another browser (no PKCE verifier here) left the page silently
// signed out. Real web.mjs in demo mode + stub Supabase (test/helpers-demo-sb.mjs) + Chromium.
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
import { SIGNIN_LABELS } from '../lib/demo-boot.mjs';
import { zh } from './helpers-lang.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.PA_SHOT_DIR;
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

// A page that opens the link `?code=abc`; `ver` seeds this browser's PKCE verifier (as if it asked).
async function openLink(ver) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (ver) await ctx.addInitScript((v) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('sb_pkce', v); } }, ver);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/?code=abc`);
  return { ctx, page };
}
// The boot reloads once on its first node session: a note must still be there AFTER that reload.
async function settled(page) {
  await waitFor(() => page.evaluate(() => document.readyState === 'complete' && performance.getEntriesByType('navigation')[0].type === 'reload').catch(() => false), 'the boot reload');
}
const shot = (page, name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name) }) : null);
const noteText = (page) => page.locator('#demoAuthNote').textContent();

test('a link opened in another browser (no verifier): a clear notice, the email box ready, ?code gone', { skip }, async () => {
  const { ctx, page } = await openLink(null);
  await settled(page);
  await page.locator('#demoAuth input[type=email]').waitFor({ state: 'visible' });
  assert.equal(await noteText(page), zh(SIGNIN_LABELS.other));
  assert.equal(new URL(page.url()).search, '', 'the ?code is cleaned from the URL');
  assert.ok(!sb.calls.some((c) => c.url.includes('grant_type=pkce')), 'no exchange without a verifier');
  await shot(page, 'other-browser.png');
  await ctx.close();
});

test('an expired or used link: the reason in plain words and the email box', { skip }, async () => {
  sb.replies['/auth/v1/token?grant_type=pkce'] = () => ({ status: 403, body: { error_code: 'flow_state_expired', msg: 'invalid flow state, flow state has expired' } });
  const { ctx, page } = await openLink('verifier-1');
  await settled(page);
  await page.locator('#demoAuth input[type=email]').waitFor({ state: 'visible' });
  assert.equal(await noteText(page), zh(SIGNIN_LABELS.bad));
  assert.ok(sb.calls.some((c) => c.url.includes('grant_type=pkce')), 'CONTROL: the exchange was tried');
  await shot(page, 'expired-link.png');
  delete sb.replies['/auth/v1/token?grant_type=pkce'];
  await ctx.close();
});

test('a good link signs in: the header drops Sign in and shows the account', { skip }, async () => {
  sb.replies['/auth/v1/token?grant_type=pkce'] = () => ({ status: 200, body: { access_token: sb.jwt({ sub: 'link-ok' }), refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600 } });
  const { ctx, page } = await openLink('verifier-2');
  await page.locator('#hAvatar').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#demoSignin').count(), 0, 'no Sign in once signed in');
  assert.equal(await page.locator('#demoAuth').count(), 0, 'no notice on success');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('sb_link_note')), null, 'no stale note kept after success');
  await shot(page, 'signed-in.png');
  delete sb.replies['/auth/v1/token?grant_type=pkce'];
  await ctx.close();
});

test('asking for a link: 429 says "too many, about an hour"; success says open it in this browser', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const b = page.locator('header #demoSignin'); await b.waitFor();
  await settled(page);
  await page.locator('header #demoSignin').click();
  sb.replies['/auth/v1/otp'] = () => ({ status: 429, body: { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' } });
  await page.fill('#demoAuth input[type=email]', 'a@example.com');
  await page.click('#demoAuth button[type=submit]');
  await waitFor(async () => (await page.locator('#demoAuthNote').count()) > 0, 'the note');
  assert.equal(await noteText(page), zh(SIGNIN_LABELS.rate));
  assert.equal(await page.evaluate(() => localStorage.getItem('sb_pkce')), null, 'a refused send stores no verifier (an earlier link stays usable)');
  await shot(page, 'rate-limit.png');
  sb.replies['/auth/v1/otp'] = () => ({ status: 500, body: {} });
  await page.click('#demoAuth button[type=submit]');
  await waitFor(async () => (await noteText(page)) === zh(SIGNIN_LABELS.fail), 'the generic line for an unknown error');
  delete sb.replies['/auth/v1/otp'];
  await page.click('#demoAuth button[type=submit]');
  await page.locator('#demoAuthSame').waitFor();
  assert.equal(await noteText(page), zh(SIGNIN_LABELS.sent));
  assert.equal(await page.locator('#demoAuthSame').textContent(), zh(SIGNIN_LABELS.same));
  assert.ok(await page.evaluate(() => localStorage.getItem('sb_pkce')), 'a sent link stores its verifier');
  await shot(page, 'check-email.png');
  await ctx.close();
});

// Nightly review 2026-11-27: Google and the email link shared ONE verifier key, so starting one flow
// spent the other's outstanding link (and an email reply in another tab spoiled a Google round trip).
test('Google keeps the email link usable: each flow has its own verifier; the boot tries both', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  await page.route(`${sb.url}/auth/v1/authorize**`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'google' }));
  await page.goto(`http://127.0.0.1:${port}/`); await settled(page);
  await page.evaluate(() => localStorage.setItem('sb_pkce', 'email-ver'));
  await page.locator('header #demoSignin').click();
  await page.click('#demoGoogle');
  await page.waitForURL(/authorize/);
  await page.goto(`http://127.0.0.1:${port}/`);   // back on the shell's origin, where the verifiers live
  const kept = await page.evaluate(() => [localStorage.getItem('sb_pkce'), localStorage.getItem('sb_pkce_g')]);
  assert.equal(kept[0], 'email-ver', 'starting Google leaves the email link verifier in place');
  assert.ok(kept[1] && kept[1] !== 'email-ver', 'Google stores its own verifier');
  const tried = [];
  await page.route(`${sb.url}/auth/v1/token?grant_type=pkce`, (r) => { const v = JSON.parse(r.request().postData()).code_verifier; tried.push(v);
    return v === 'email-ver' ? r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ access_token: sb.jwt({ sub: 'email-ok' }), refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600 }) })
      : r.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error_code: 'bad_code_verifier' }) }); });
  await page.evaluate((g) => { localStorage.setItem('sb_pkce', g); localStorage.setItem('sb_pkce_g', 'email-ver'); }, kept[1]);   // the link's verifier is in EITHER key: the boot must try both
  await page.goto(`http://127.0.0.1:${port}/?code=abc`);
  await page.locator('#hAvatar').waitFor({ state: 'visible' });
  assert.deepEqual(tried, [kept[1], 'email-ver'], 'the second verifier is tried after the first is refused');
  assert.equal(await page.evaluate(() => localStorage.getItem('sb_pkce')), kept[1], 'the other flow\'s verifier stays for its own link');
  assert.equal(await page.evaluate(() => localStorage.getItem('sb_pkce_g')), null, 'the verifier used is cleared');
  // GPT r1: the Google verifier's success clears IT (the index once picked the email key).
  await ctx.close();
  const c2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await c2.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('sb_pkce_g', 'email-ver'); localStorage.setItem('sb_pkce', 'keep-me'); } });
  const p2 = await c2.newPage(); tried.length = 0;
  await c2.route(`${sb.url}/auth/v1/token?grant_type=pkce`, (r) => { const v = JSON.parse(r.request().postData()).code_verifier; tried.push(v);
    return r.fulfill({ status: v === 'email-ver' ? 200 : 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(v === 'email-ver' ? { access_token: sb.jwt({ sub: 'g-ok' }), refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600 } : { error_code: 'bad_code_verifier' }) }); });
  await p2.goto(`http://127.0.0.1:${port}/?code=abc`);
  await p2.locator('#hAvatar').waitFor({ state: 'visible' });
  assert.deepEqual(await p2.evaluate(() => [localStorage.getItem('sb_pkce'), localStorage.getItem('sb_pkce_g')]), ['keep-me', null], 'Google\'s success clears its own verifier, never the email one');
  await c2.close();
});
