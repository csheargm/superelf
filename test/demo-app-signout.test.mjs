// Demo guest boot vs. the app-page sign-out · 演示访客启动与应用页退出 (ADR 0037).
// Overnight 2026-11-23: every guest load drew a 403 from POST /app/-/signout — the signed-out shell posts
// it at boot, and the demo allow-list (lib/demo.mjs) lacked it. It is now allowed and answered by the same
// route as on an owner node, which still clears the app cookie. Real browser (R6); without Playwright the
// browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { demoRouteAllowed } from '../lib/demo.mjs';
import { APP_SIGNOUT_PATH } from '../lib/app-page-access.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the demo allow-list lets the signed-out shell post /app/-/signout (POST only)', () => {
  assert.equal(demoRouteAllowed('POST', APP_SIGNOUT_PATH), true);
  assert.equal(demoRouteAllowed('POST', `${APP_SIGNOUT_PATH}x`), false);
});

let open, browser;
before(async () => {
  if (skip) return;
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig: { users: [], demo: { enabled: true, new_users_per_ip_per_day: 50 } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  open = { port, root, web: startWeb(root) }; await waitReady(port);
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (open) { await stopWeb(open.web); rmTemp(open.root); }
});

test('a guest load draws no 403 from /app/-/signout and the cookie is still cleared', { skip }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const bad = []; page.on('response', (r) => { if (new URL(r.url()).pathname === APP_SIGNOUT_PATH && !r.ok()) bad.push(r.status()); });
  const seen = []; page.on('request', (r) => { if (new URL(r.url()).pathname === APP_SIGNOUT_PATH) seen.push(r.method()); });
  await page.goto(`http://127.0.0.1:${open.port}/`);
  await waitFor(() => page.evaluate(() => !!localStorage.getItem('pa_session')).catch(() => false), 'a demo session');
  await page.waitForTimeout(1500);
  assert.ok(seen.length >= 1, 'the guest boot does post the sign-out (else this test proves nothing)');
  assert.deepEqual(bad, []);
  const r = await fetch(`http://127.0.0.1:${open.port}${APP_SIGNOUT_PATH}`, { method: 'POST', headers: { cookie: 'pa_app=x' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') || '', /pa_app=;.*Max-Age=0/);
  await ctx.close();
});
