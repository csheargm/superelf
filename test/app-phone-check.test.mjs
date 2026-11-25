// Phone check（手机检查）: the static scan the edit gate, the demo maker and app-postcheck share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { phoneProblems, PHONE_FIRST_RULE } from '../lib/app-phone-check.mjs';
import { appHtmlProblems } from '../lib/app-postcheck.mjs';
import { appContract } from '../lib/config.mjs';

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';
const page = (css = '', body = '') => `<!doctype html><html><head>${VIEWPORT}<style>${css}</style></head><body>${body}</body></html>`;

test('a plain phone-safe page passes', () => {
  assert.deepEqual(phoneProblems(page('.a{max-width:900px;width:100%} input{font-size:14px} button{height:30px}')), []);
});

test('each of the three faults is named', () => {
  assert.match(phoneProblems(page('.wide{width:800px}')).join(), /800px/);
  assert.match(phoneProblems(page('', '<div style="min-width:600px"></div>')).join(), /600px/);
  assert.match(phoneProblems(page('input,textarea{font-size:12px !important}')).join(), /16px/);
  assert.match(phoneProblems(page('.bar button{min-height:28px!important}')).join(), /44px/);
});

test('widths only a wider screen sees, comments, and max-width are not faults', () => {
  assert.deepEqual(phoneProblems(page('@media (min-width:700px){.side{width:640px} .x{min-width:500px}} /* width:999px */ .m{max-width:1200px;border-width:2px}')), []);
});

test('the gate the edit lane and the demo maker use carries the phone check', () => {
  assert.ok(appHtmlProblems(page('.w{width:1024px}')).some((t) => /横向滚动/.test(t)));
});

test('every built-in app copy in the repo passes (the gate never blocks an untouched app)', () => {
  for (const d of ['workspace/apps', 'workspace.example/apps', 'shared-apps']) {
    for (const slug of fs.readdirSync(d)) {
      const f = path.join(d, slug, 'index.html');
      if (fs.existsSync(f)) assert.deepEqual(phoneProblems(fs.readFileSync(f, 'utf8')), [], f);
    }
  }
});

test('the app maker is told phone first (superelf.md build rules travel in the prompt)', () => {
  assert.match(appContract(process.cwd()), /Phone first/);
  assert.match(PHONE_FIRST_RULE, /390px/);
});
