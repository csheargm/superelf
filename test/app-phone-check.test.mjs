// Phone check（手机检查）: the static scan the edit gate, the demo maker and app-postcheck share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { phoneProblems, phoneTextProblems, PHONE_FIRST_RULE } from '../lib/app-phone-check.mjs';
import { appHtmlProblems, snapshotApps, appBuildWarnings } from '../lib/app-postcheck.mjs';
import { appContract, agentCapabilities, PHONE_RULE_MARK } from '../lib/config.mjs';
import { buildSystemPrompt } from '../lib/demo-app.mjs';
import { editSystemPrompt } from '../lib/app-edit.mjs';
import { runScopedEdit } from '../lib/app-edit-lane.mjs';

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

test('GPT review: a capped width, a commented-out block and a forced height are not faults', () => {
  assert.deepEqual(phoneProblems(page('.card{width:600px;max-width:100%} button{height:24px !important}')), []);
  assert.deepEqual(phoneProblems(page('', '<!-- <style>.demo{width:800px}</style> -->')), []);
  assert.match(phoneProblems(page('.card{width:600px;max-width:500px}')).join(), /600px/);   // capped above a phone still scrolls
  assert.match(phoneProblems(page('.a{width:600px;max-width:150%}')).join(), /600px/);   // round 2: over 100% does not cap
  assert.match(phoneProblems(page('.a{width:600px;max-width:300px;max-width:none}')).join(), /600px/);   // the last max-width wins
  assert.match(phoneProblems(page('.l::before{content:"<!--"} .wide{width:600px}')).join(), /600px/);   // "<!--" inside CSS is not a comment
  assert.match(phoneProblems(page('.a{width:600px;max-width:none!important;max-width:100%}')).join(), /600px/);   // r3: !important wins
  assert.match(phoneProblems(page('.a{width:600px;max-width:100%;max-width:30rem}')).join(), /600px/);   // r3: a rem cap is not counted
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

test('the ONE rule names each phone fact the owner asked for (2026-11-25)', () => {
  for (const re of [/390px/, /sideways scroll/, /Body text >=16px/, /chat messages 17px/, /labels >=12px/, /inputs 16px/,
    /44px with gaps/, /One column/, /visualViewport/, /safe-area/, /hover-only/, /Dialogs fit the screen/]) assert.match(PHONE_FIRST_RULE, re);
});

// Invariant (enumerate every lane): each prompt that makes or changes an app carries the rule verbatim.
test('every app-making and app-changing lane carries PHONE_FIRST_RULE verbatim', async () => {
  const contract = appContract(process.cwd());
  assert.ok(!contract.includes(PHONE_RULE_MARK), 'the mark is filled, never sent');
  const sent = [], appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-phonelane-'));
  fs.writeFileSync(path.join(appDir, 'index.html'), page());
  await runScopedEdit({ edit: { slug: 'x', dir: appDir, confirmed: true, plan: 'p' }, wsDir: os.tmpdir(), contract,
    ask: async (m) => { sent.push(m.map((x) => x.content).join('\n')); throw new Error('stop'); } }).catch(() => {});
  const lanes = {
    'owner app maker': agentCapabilities('owner', contract),
    'member app maker': agentCapabilities('member', contract),
    'demo app maker': buildSystemPrompt(contract),
    'app edit (confirmed)': editSystemPrompt({ slug: 'x', confirmed: true, plan: 'p' }),
    'app edit Apply (scoped lane)': sent[0] || '',
  };
  for (const [lane, text] of Object.entries(lanes)) assert.ok(text.includes(PHONE_FIRST_RULE), `${lane} lacks the phone-first rule`);
  assert.equal(fs.readFileSync('superelf.md', 'utf8').split(PHONE_RULE_MARK).length, 2, 'superelf.md holds the mark once');
});

test('text faults: a label under 12px, body text under 16px, a hover-only menu', () => {
  assert.match(phoneTextProblems(page('.tag{font-size:11px}')).join(), /12px/);
  assert.match(phoneTextProblems(page('body{font-size:14px}')).join(), /正文/);
  assert.match(phoneTextProblems(page('p,li{font-size:15px}')).join(), /正文/);
  assert.match(phoneTextProblems(page('.m .menu{display:none} .m:hover .menu{display:block}')).join(), /hover/);
  assert.match(phoneTextProblems(page('.del{opacity:0} .row:hover > .del{opacity:1}')).join(), /hover/);
});

test('text faults: what is not one (known limits stated in lib/app-phone-check.mjs)', () => {
  assert.deepEqual(phoneTextProblems(page('html{font-size:calc(17px * var(--fs,1))} .h{font-size:12px} .x{font-size:0} .s{font-size:.6rem}')), []);
  assert.deepEqual(phoneTextProblems(page('button:hover{opacity:.8} a:hover{color:red}')), []);
  assert.deepEqual(phoneTextProblems(page('.m:hover .menu,.m:focus-within .menu{display:block}')), []);
  assert.deepEqual(phoneTextProblems(page('.m:hover .menu{display:block} .m.open .menu{display:block}')), []);
  assert.deepEqual(phoneTextProblems(page('@media (min-width:700px){.side{font-size:10px}}')), []);
});

test('text faults never block an app that already had them: the edit gate drops pre-existing lines', () => {
  const before = page('.tag{font-size:11px}'), after = page('.tag{font-size:11px} .b{font-size:10px}');
  const had = new Set(appHtmlProblems(before));
  assert.deepEqual(appHtmlProblems(after).filter((p) => !had.has(p)), [], 'one more small label is not a new fault');
});

test('app-postcheck: text faults are named for a NEW app only, never for an older app the turn touched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-phonetext-'));
  const put = (slug, html) => { fs.mkdirSync(path.join(dir, slug), { recursive: true }); fs.writeFileSync(path.join(dir, slug, 'index.html'), html); };
  put('old', page('.tag{font-size:11px}'));
  const before = new Map([...snapshotApps(dir)].map(([k]) => [k, 0]));   // 'old' existed, and changed this turn
  put('fresh', page('.tag{font-size:11px}'));
  const w = appBuildWarnings(dir, before);
  assert.match(w, /apps\/fresh: text under 12px/);
  assert.doesNotMatch(w, /apps\/old/);
});

test('every app copy (repo and the owner\'s live/overlay copies when present): text faults never reach the strict check', () => {
  const dirs = ['workspace/apps', 'workspace.example/apps', 'shared-apps',
    '/Applications/mdocs/projects/personal_agent/workspace/apps', '/Applications/mdocs/projects/superelf-mine/workspace/apps'].filter((d) => fs.existsSync(d));
  for (const d of dirs) for (const slug of fs.readdirSync(d)) {
    const f = path.join(d, slug, 'index.html');
    if (!fs.existsSync(f)) continue;
    const html = fs.readFileSync(f, 'utf8');
    assert.deepEqual(appHtmlProblems(html, { text: false }), [], f);
    assert.ok(!phoneTextProblems(html).some((t) => /hover/.test(t)), `no hover-only false hit: ${f}`);
  }
});

test('GPT review: winning font-size, a min-width media block a phone sees, touch fallbacks', () => {
  assert.deepEqual(phoneTextProblems(page('.tag{font-size:10px;font-size:12px}')), []);
  assert.match(phoneTextProblems(page('.tag{font-size:12px !important;font-size:20px} .b{font-size:13px;font-size:9px}')).join(), /12px/);
  assert.match(phoneTextProblems(page('@media (min-width:320px){p{font-size:14px}}')).join(), /正文/);
  assert.deepEqual(phoneTextProblems(page('@media (min-width:768px){p{font-size:14px}}')), []);
  assert.match(phoneProblems(page('@media (min-width:300px){.w{width:900px}}')).join(), /900px/);
  assert.deepEqual(phoneTextProblems(page('.menu{display:none} .row:hover .menu{display:block} @media (hover:none){.menu{display:block}}')), []);
  assert.deepEqual(phoneTextProblems(page('.row:hover .tag{display:inline-block}')), []);
});

