// The Settings footer shows the release time in the VIEWER's zone · 版本时间按本机时区 (R6, real browser).
// Owner: "we don't know what time exactly the version has" — many releases ship per day.
// tools/bump-version.mjs records `time` (UTC ISO); the footer draws 'MM-DD HH:mm' with a full tooltip,
// and a release without `time` keeps its date only. The footer's TEXT (what PAUpdate compares with
// /api/build) must not change. Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, api } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { ROOT } from './helpers-panote-routing.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const YEAR = new Date().getUTCFullYear();
const TIME = `${YEAR}-03-04T06:32:09Z`;   // 14:32 in Shanghai (UTC+8, no DST), 22:32 the day before in Los Angeles
let browser;
const roots = [], webs = [];
async function node(entry) {
  const port = await freePort(), root = mkWebRoot({ port });
  fs.writeFileSync(path.join(root, 'version-notes.json'), JSON.stringify({ [`v${VERSION}`]: entry }));
  roots.push(root); webs.push(startWeb(root)); await waitReady(port);
  return port;
}
async function footer(port, timezoneId) {
  const ctx = await browser.newContext({ timezoneId }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const r = await page.evaluate(() => { const el = document.querySelector('#ver-lbl'); return { text: el.textContent.trim(), after: getComputedStyle(el, '::after').content, title: el.title, vdate: el.dataset.vdate }; });
  await ctx.close();
  return r;
}
before(async () => { if (!skip) browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); for (const w of webs) await stopWeb(w); for (const r of roots) rmTemp(r); });

test('footer: release time in the viewer zone + full tooltip; text unchanged', { skip, timeout: 60000 }, async () => {
  const port = await node({ date: `${YEAR}-03-04`, time: TIME, features: ['x'], fixes: [] });
  const sh = await footer(port, 'Asia/Shanghai');
  assert.equal(sh.after, '" · 03-04 14:32"', `Shanghai: ${sh.after}`);
  assert.match(sh.title, new RegExp(`^${YEAR}-03-04 14:32:09 UTC\\+08:00 \\(Asia/Shanghai\\)$`), sh.title);
  const la = await footer(port, 'America/Los_Angeles');
  assert.equal(la.after, '" · 03-03 22:32"', `Los Angeles: ${la.after}`);
  const { version } = await (await api(port, '/api/build')).json();
  assert.equal(sh.text, `管家 · ${version}`, 'the footer text is exactly what PAUpdate compares against');
  assert.doesNotMatch(sh.text, /\d\d:\d\d/, 'the time lives outside the text');
});

test('a release without `time` shows its date only — never a made-up time', { skip, timeout: 60000 }, async () => {
  const port = await node({ date: `${YEAR}-03-04`, features: ['x'], fixes: [] });
  const r = await footer(port, 'Asia/Shanghai');
  assert.equal(r.title, '', 'no time: no tooltip');
  assert.doesNotMatch(r.after, /\d\d:\d\d/, `no time shown: ${r.after}`);
  assert.equal(r.after, r.vdate ? `" · ${r.vdate}"` : 'none', 'the date only (the commit date), as before');
});
