// The publish card tells the truth (owner 2026-11-26, R6): a throwaway node, a throwaway "public repo" with the real
// web/, a FAKE `claude` that keeps the real CLI's permission model, the REAL render check (headless Chromium).
//   1. the owner's version-line change (3 files) → the card lists all 3 above the shots, and After shows the line;
//   2. a reply that names a file the change does not have → said plainly, no Publish;
//   3. a change Home does not draw → "改动在截图里看不出 · Change not visible in screenshots", no pictures as proof.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { FAKE_PERMS_SRC } from './helpers-fake-claude-perms.mjs';
import { selfpubFixture } from './helpers-selfpub.mjs';
import { VERLINE_EDITS, VERLINE_CSS, VERLINE_FILES } from './helpers-selfpub-verline.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

const SHOTS = process.env.PA_SHOTS || '';
// Writes go through perms().write, so a write the real CLI would deny fails here too.
const FAKE = `#!/usr/bin/env node
${FAKE_PERMS_SRC}
const EDITS = ${JSON.stringify(VERLINE_EDITS)}, CSS = ${JSON.stringify(VERLINE_CSS)};
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const path = process.getBuiltinModule('node:path');
  const argv = process.argv.slice(2), sys = argv.join(' '), p = perms(argv), tools = [];
  const edit = (f, fn) => { tools.push({ type: 'tool_use', name: 'Edit', input: { file_path: path.join(process.cwd(), f) } }); const cur = p.read(f); return cur !== null && p.write(f, fn(cur)); };
  let say = 'ok';
  if (/git checkout of superelf/.test(sys)) {
    if (/version line/.test(s)) {
      let ok = true;
      for (const [k, [from, to]] of Object.entries(EDITS)) ok = edit(k.split('#')[0], (c) => c.replace(from, () => to)) && ok;
      ok = edit('web/home-v2.css', (c) => c + CSS) && ok;
      say = ok ? 'Changes: web/index.html new <p class="home-ver" id="hVer"> after the app grid; web/home-v2.js new syncVer() called from render(); web/home-v2.css small muted centred style for .home-ver.' : 'could not write';
    } else if (/claims more/.test(s)) {
      edit('web/home-v2.css', (c) => c + '\\nheader h1{font-size:27px}\\n');
      say = 'Changes: web/home-v2.css larger title; web/settings.js new toggle.';
    } else if (/invisible/.test(s)) {
      edit('web/home-v2.css', (c) => c + '\\n.nowhere-on-home{color:red}\\n');
      say = 'Changes: web/home-v2.css new .nowhere-on-home rule.';
    }
  }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-c' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [...tools, { type: 'text', text: say }] } }) + '\\n');
  p.text(say);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: say, session_id: 'sid-c' }) + '\\n');
});
`;

let port, root, web, fx, browser, page, ctx;
before(async () => {
  fx = selfpubFixture({ web: true });
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, selfpub_root: path.join(fx.d, 'src'), selfpub_clone_url: fx.bare,
    github_publish_token: 'fake-token-never-used', github_api_url: 'http://127.0.0.1:9', publish_remote_url: fx.bare,
    users: [{ id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  const cfgPath = path.join(root, 'config.json'), cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE); fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(root, 'privacy-terms.txt'), 'Zorblax\n');
  fs.writeFileSync(path.join(root, 'workspace', 'identity-denylist.txt'), 'Quux Town\n');
  web = startWeb(root); await waitReady(port);
  if (skip) return;
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`); await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); if (fx) rmTemp(fx.d); });

// One request in a fresh chat; resolves with the reply text once the turn ended and its row is under it.
async function ask(q) {
  await page.evaluate(() => document.querySelectorAll('.sp-row').forEach((r) => r.remove()));
  await page.fill('#box', q); await page.click('#send');
  await page.waitForFunction(() => document.querySelector('.sp-row') && !document.querySelector('#log .pa-think'), null, { timeout: 180000 });
  return page.locator('#log .msg').last().textContent();
}
const discardOpen = async () => { await page.click('#pubSheet [data-sp="discard"]'); await page.waitForFunction(() => !document.getElementById('pubSheet')); };
const discardRow = async () => { await page.click('.sp-row .sp-drop'); await page.waitForFunction(() => /已丢弃 · Discarded/.test(document.querySelector('.sp-row').textContent)); };

test('the version-line change: all 3 files listed ABOVE the shots, and After differs from Before', { skip, timeout: 300000 }, async () => {
  const reply = await ask('change superelf: add a version line on the home page');
  assert.match(reply, /可以发布 · Ready to publish — 改了 3 个文件 · 3 file\(s\) changed/);
  assert.doesNotMatch(reply, /Change not visible/);
  await page.click('.sp-row .sp-go');
  await page.locator('#pubSheet #spFiles').waitFor({ timeout: 30000 });
  assert.deepEqual(await page.locator('#spFiles code').allTextContents(), VERLINE_FILES);
  assert.match(await page.locator('#pubSheet').textContent(), /Files changed \(3\)/);
  await page.waitForFunction(() => document.querySelectorAll('#spShots img').length === 2, null, { timeout: 30000 });
  const order = await page.evaluate(() => !!(document.getElementById('spFiles').compareDocumentPosition(document.getElementById('spShots')) & Node.DOCUMENT_POSITION_FOLLOWING));
  assert.ok(order, 'the file list comes before the shots, never below the fold under them');
  const shots = await page.evaluate(() => Promise.all([...document.querySelectorAll('#spShots img')].map(async (i) => [...new Uint8Array(await (await fetch(i.src)).arrayBuffer())].join(','))));
  assert.notEqual(shots[0], shots[1], 'After shows the version line');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'selfpub-card-verline.png') });
  await discardOpen();
});

test('a reply naming a file the change does not have: said plainly, no Publish', { skip, timeout: 300000 }, async () => {
  const reply = await ask('change superelf: claims more than it changed');
  assert.match(reply, /^未通过检查 · Checks failed/);
  assert.match(reply, /回复说改了 web\/settings\.js，但改动里没有，不能发布 · The reply names web\/settings\.js, which the change does not contain: cannot publish/);
  assert.equal(await page.locator('.sp-row .sp-go').count(), 0, 'no Publish button');
  await discardRow();
});

test('a change Home does not draw: "Change not visible in screenshots", and no pictures shown as proof', { skip, timeout: 300000 }, async () => {
  const reply = await ask('change superelf: invisible rule');
  assert.match(reply, /改动在截图里看不出 · Change not visible in screenshots/);
  await page.click('.sp-row .sp-go');
  await page.locator('#pubSheet #spFiles').waitFor({ timeout: 30000 });
  assert.match(await page.locator('#spChecks').textContent(), /改动在截图里看不出 · Change not visible in screenshots/);
  await page.waitForTimeout(1500);   // the shots would have loaded by now
  assert.equal(await page.locator('#spShots img').count(), 0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'selfpub-card-invisible.png') });
  await discardOpen();
});
