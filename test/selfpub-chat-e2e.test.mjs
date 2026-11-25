// 改 superelf from the owner's main chat, in a real browser (docs/adr/0044 phase 2–3, R6). A throwaway node, a
// throwaway "public repo" (a local bare git with the real web/), a FAKE GitHub and a FAKE `claude` that keeps the
// real CLI's permission model (test/helpers-fake-claude-perms.mjs). The render check is REAL (headless Chromium).
// Flow: "make the home title a bit larger" → the main agent hands it over (marker) → the core lane edits the
// checkout → server checks + iPhone render → "可以发布 · Ready to publish" + 发布 · Publish → preview (before/after)
// → Publish → PR on the fake → CI → merge → release, said on the line. Then a second request in the same chat, a
// typed "publish", a member refused plainly, and the main agent's write to served code denied.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { FAKE_PERMS_SRC } from './helpers-fake-claude-perms.mjs';
import { startFakeGitHub, FAKE_TOKEN } from './helpers-fake-github.mjs';
import { selfpubFixture, tgit } from './helpers-selfpub.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';
const POSIX_ONLY = process.platform === 'win32' && 'the core lane runs on Linux/macOS nodes; its jail rule paths, fake CLI permissions and checkout are POSIX (docs/adr/0044)';

const SHOTS = process.env.PA_SHOTS || '';
const KID = 'kid-token-abcdefghijkl';
const FAKE = `#!/usr/bin/env node
${FAKE_PERMS_SRC}
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const path = process.getBuiltinModule('node:path');
  const argv = process.argv.slice(2), sys = argv.join(' '), p = perms(argv), tools = [];
  let say = 'ok';
  if (/git checkout of superelf/.test(sys)) {
    const f = 'web/home-v2.css', cur = p.read(f), px = /more|again/.test(s) ? 30 : 26;
    tools.push({ type: 'tool_use', name: 'Edit', input: { file_path: path.join(process.cwd(), f) } });
    const ok = cur !== null && p.write(f, cur + '\\n/* selfpub e2e */ header h1{font-size:' + px + 'px}\\n');
    say = ok ? 'I made the home title ' + px + 'px in web/home-v2.css.' : 'I could not write web/home-v2.css.';
  } else if (/edit the served file/.test(s)) {
    const target = path.resolve(process.cwd(), '..', 'superelf.md');
    tools.push({ type: 'tool_use', name: 'Edit', input: { file_path: target } });
    say = p.write(target, 'sneaky\\n') ? 'WROTE the served file' : 'BLOCKED: permission denied for ' + path.basename(target);
  } else if (/home title/.test(s)) say = 'PA_CHANGE_SUPERELF: ' + (/more/.test(s) ? 'make the home title even more larger' : 'make the home title a bit larger');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-s' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [...tools, { type: 'text', text: say }] } }) + '\\n');
  p.text(say);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: say, session_id: 'sid-s' }) + '\\n');
});
`;

let port, root, web, gh, fx, browser;
before(async () => {
  fx = selfpubFixture({ web: true });
  gh = await startFakeGitHub({ onMerge: (pr) => fx.doMerge(pr) });
  gh.st.commits.set(tgit(fx.bare, 'rev-parse', 'main').trim(), { tree: { sha: 'basetree' }, parents: [] });
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, selfpub_root: path.join(fx.d, 'src'), selfpub_clone_url: fx.bare,
    github_publish_token: FAKE_TOKEN, github_api_url: gh.url, publish_remote_url: fx.bare, publish_poll_ms: 100, publish_max_polls: 50,
    users: [{ id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') },
      { id: 'kid', name: 'Kid', role: 'member', token: KID, workspace: 'ws-kid', passHash: hashPassword('kid-pass-12345') }] } });
  const cfgPath = path.join(root, 'config.json'), cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE); fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(root, 'privacy-terms.txt'), 'Zorblax\n');
  fs.writeFileSync(path.join(root, 'workspace', 'identity-denylist.txt'), 'Quux Town\n');
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); if (gh) await gh.close(); if (fx) rmTemp(fx.d); });

async function chat(token, message, convoId) {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ message, convoId }) });
  return (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('a member typing "change superelf:" is refused plainly; no checkout is made', async () => {
  const ev = await chat(KID, 'change superelf: make it purple');
  const done = ev.find((e) => e.type === 'done');
  assert.equal(done.ok, false); assert.match(done.text, /^只有节点主人可以修改 superelf 本身 · Only the node's owner can change superelf itself$/);
  assert.ok(!ev.some((e) => e.type === 'selfpub'));
  assert.ok(!fs.existsSync(path.join(fx.d, 'src', 'repo')), 'no checkout');
});

test('the main agent cannot write served code: its args deny it and the file is unchanged', { skip: POSIX_ONLY }, async () => {
  const before = fs.readFileSync(path.join(root, 'superelf.md'), 'utf8');
  const ev = await chat(OWNER_TOKEN, 'please edit the served file superelf.md directly');
  const done = ev.find((e) => e.type === 'done');
  assert.ok(done, JSON.stringify(ev).slice(0, 2000)); assert.match(done.text, /^BLOCKED/);
  assert.equal(fs.readFileSync(path.join(root, 'superelf.md'), 'utf8'), before);
});

for (const [name, vp] of [['iPhone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 860 }]]) {
  test(`${name}: home title request → ready + Publish → preview → PR → CI → merged and released; again; typed publish`, { skip, timeout: 240000 }, async () => {
    gh.st.commits.set(tgit(fx.bare, 'rev-parse', 'main').trim(), { tree: { sha: 'basetree' }, parents: [] });   // the PR's parent: main as it is now
    const sent = gh.st.requests.length;
    const ctx = await browser.newContext({ viewport: vp }); const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`); await page.waitForSelector('#login[open]');
    await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
    await page.waitForFunction(() => !document.querySelector('#login[open]'));
    const ask = async (q) => { await page.fill('#box', q); await page.click('#send'); };
    await ask('make the home title a bit larger');
    const go = page.locator('.sp-row .sp-go').last(); await go.waitFor({ timeout: 90000 });
    const reply = await page.locator('#log .msg').last().textContent();
    assert.match(reply, /可以发布 · Ready to publish — 改了 1 个文件 · 1 file\(s\) changed; 测试 1\/1 通过/);
    assert.match(reply, /Rendered at iPhone width \(390\)/); assert.match(reply, /merges only on green CI/);
    assert.match(reply, /I made the home title 26px/); assert.doesNotMatch(reply, /PA_CHANGE_SUPERELF|已上线|fixed/);
    assert.equal(gh.st.requests.length, sent, 'nothing reached GitHub before the tap');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `selfpub-ready-${name}.png`) });
    await go.click();
    await page.locator('#pubSheet #spFiles').waitFor({ timeout: 30000 });
    assert.match(await page.locator('#spFiles').textContent(), /web\/home-v2\.css/);
    await page.waitForFunction(() => document.querySelectorAll('#spShots img').length === 2, null, { timeout: 30000 });
    assert.match(await page.locator('#spChecks').textContent(), /测试 1\/1 通过.*iPhone width \(390\): before \/ after.*Privacy scan clean/s);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `selfpub-preview-${name}.png`) });
    await page.click('#pubSheet #pubGo');
    await page.waitForFunction(() => /Released v\d+\.\d+\.\d+ — waiting for deploy/.test((document.querySelector('.sp-row:last-of-type .sp-state') || document.querySelector('#spSheetState') || {}).textContent || '')
      || [...document.querySelectorAll('.sp-state')].some((e) => /Released v/.test(e.textContent)), null, { timeout: 90000 });
    const pr = gh.st.pulls[gh.st.pulls.length - 1];
    assert.match(pr.head, /^self\/\d{8}-[a-z0-9]+$/); assert.match(String(gh.files(pr)['web/home-v2.css']), /header h1\{font-size:26px\}/);
    assert.equal(await page.locator('.sp-row .sp-go').count(), 0, 'no second tap on a change on its way');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `selfpub-released-${name}.png`) });
    await page.click('#pubSheet #pubClose').catch(() => { /* the sheet may be closed already */ });
    await ask('make the home title more larger');   // a second change in the same conversation
    await page.waitForFunction(() => document.querySelectorAll('.sp-row .sp-go').length === 1, null, { timeout: 90000 });
    assert.match(await page.locator('#log .msg').last().textContent(), /I made the home title 30px/);
    await ask('make the home title more larger again');   // a follow-up builds on the open change; the earlier row says so
    await page.waitForFunction(() => document.querySelectorAll('.sp-row').length === 3 && /Folded into the newer change/.test(document.querySelectorAll('.sp-row')[1].textContent), null, { timeout: 90000 });
    assert.equal(await page.locator('.sp-row .sp-go').count(), 1, 'only the newest change can be published');
    await ask('publish');   // typed: opens the same preview, sends nothing
    await page.locator('#pubSheet #spFiles').waitFor({ timeout: 30000 });
    assert.match(await page.locator('#log .msg').last().textContent(), /Opening the publish preview/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `selfpub-typed-publish-${name}.png`) });
    const sw = await page.evaluate(() => document.documentElement.scrollWidth); assert.ok(sw <= vp.width, `no sideways scroll (${sw})`);
    await page.click('#pubSheet [data-sp="discard"]');   // the owner says no: the checkout is clean for the next run
    await page.waitForFunction(() => /已丢弃 · Discarded/.test(document.querySelectorAll('.sp-row')[2].textContent), null, { timeout: 15000 });
    await ctx.close();
  });
}
