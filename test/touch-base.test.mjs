// Touch base（触屏基础）— web/touch-base.css reaches the shell AND every app page, and its rules are touch-only
// (phone audit 2026-11-24). The browser proof is test/phone-friendly-e2e.test.mjs; this pins the wiring and the
// home's short date (#13) without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers-app.mjs';
import { withServedPages, SYNTHETIC } from './helpers-every-page.mjs';
import { inlineShellParts } from '../lib/shellhtml.mjs';

const CSS = fs.readFileSync(path.join(ROOT, 'web/touch-base.css'), 'utf8');

test('the 16px input and 44px tap floors sit inside @media (pointer:coarse) only (a mouse desktop keeps its sizes)', () => {
  const coarse = CSS.slice(CSS.indexOf('@media (pointer:coarse)'));
  assert.match(coarse, /font-size:max\(16px,1em\) !important/);
  assert.match(coarse, /min-height:var\(--tap-min\) !important; min-width:var\(--tap-min\) !important/);
  assert.ok(!CSS.slice(CSS.indexOf(':root{'), CSS.indexOf('@media (pointer:coarse)')).includes('!important'), 'nothing forced outside the touch block');
});

test('served: every app page carries the touch base inside #pa-theme, after the tokens', async () => {
  await withServedPages([{ slug: 'plain', html: '<!doctype html><html><head><title>t</title></head><body><button>b</button></body></html>' }, ...SYNTHETIC('1')], async (served) => {
    for (const slug of ['plain', 'syn-head-script', 'syn-no-head', 'syn-static']) {
      const html = await served(slug), style = /<style id="pa-theme">([\s\S]*?)<\/style>/.exec(html);
      assert.ok(style, `${slug}: theme style present`);
      assert.ok(style[1].indexOf('--tap-min') > style[1].indexOf('--accent'), `${slug}: touch base after the tokens`);
    }
  });
});

test('the shell inlines the touch base too', () => {
  const html = inlineShellParts(ROOT, fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8'));
  assert.ok(html.includes('--tap-min:44px'), 'shell carries web/touch-base.css');
  assert.ok(!html.includes('/* PA_TOUCH_BASE_CSS */'), 'marker replaced');
});

test('the home date carries the year on every width (owner 2026-11-27, replaces the #13 short form)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web/home-look.js'), 'utf8');
  const NOW = new Date(2026, 10, 24, 20);
  for (const [w, want] of [[390, ['2026年11月24日 周二', 'Tue, Nov 24, 2026']], [1024, ['2026年11月24日 周二', 'Tue, Nov 24, 2026']]]) {
    const ctx = { window: { innerWidth: w }, document: {}, Intl, Date };
    vm.runInNewContext(src + ';this.L=PAHomeLook;', ctx);
    assert.deepEqual([...ctx.L.dateLine(NOW)], want, `${w}px`);
  }
});
