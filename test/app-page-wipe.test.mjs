// 问 AI 不能丢 · The post-check that refuses a page wiping its own Ask AI mount (lib/app-postcheck.mjs), the
// lane that says why (lib/app-edit-lane.mjs), the mount that survives an older page's wipe (lib/demo-askai.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pageWipeProblems, appHtmlProblems, PAGE_WIPE_TEXT } from '../lib/app-postcheck.mjs';
import { editChecks } from '../lib/app-edit.mjs';
import { runScopedEdit, SCOPED_FAILED, WORKING_RULE } from '../lib/app-edit-lane.mjs';
import { KEEP_WAY_BACK_RULE, buildSystemPrompt } from '../lib/demo-app.mjs';
import { ensureAskAi, askAiMount } from '../lib/demo-askai.mjs';

const page = (js) => `<!doctype html><html><body><main id="app"></main><script>${js}</script></body></html>`;

test('a script that replaces the whole page is caught, in every known form', () => {
  for (const js of ['document.body.innerHTML = "x"', 'document.body.innerHTML+="x"', 'document.body.textContent=""', 'document.body.replaceChildren(a)',
    'document.documentElement.innerHTML="x"', 'document.write("<p>")', 'document.open()', "document.getElementById('pa-askai').remove()", 'document.body.outerHTML = s'])
    assert.deepEqual(pageWipeProblems(page(js)), [PAGE_WIPE_TEXT], js);
});
test('rendering into your own element, a comparison, a comment, markup text or an external script is not a wipe', () => {
  for (const html of [page('document.getElementById("app").innerHTML = "x"'), page('if (document.body.innerHTML == "") go()'), page('// document.body.innerHTML = 1\nrun()'),
    page('/* document.write(1) */'), '<p>document.body.innerHTML = 1</p>', '<script src="x.js">document.write(1)</script>', page('var u = "http://x"; app.innerHTML = u'), ensureAskAi(page('go()'), 'T')])
    assert.deepEqual(pageWipeProblems(html), [], html);
});
test('the same rule is in the shared gate: the demo maker and every edit lane (owner, member, guest) refuse it', () => {
  assert.ok(appHtmlProblems(page('document.body.innerHTML="x"')).includes(PAGE_WIPE_TEXT));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wipe-')), dir = path.join(ws, 'apps', 'a');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), page('document.body.innerHTML="x"'));
    assert.ok(editChecks(dir, path.join(ws, 'data', 'a')).includes(PAGE_WIPE_TEXT));
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
test('the lane retries with the reason, then says it — never a silent generic failure', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wipe-')), dir = path.join(ws, 'apps', 'a');
  try {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'index.html'), page('go()'));
    const seen = [];
    const ask = async (m) => { seen.push(m); return '```html\n' + page('document.body.innerHTML="x"') + '\n```'; };
    const r = await runScopedEdit({ edit: { slug: 'a', dir, confirmed: true, plan: 'p' }, wsDir: ws, message: 'yes', prior: [], contract: '', ask });
    assert.equal(r.ok, false);
    assert.ok(r.text.startsWith(SCOPED_FAILED) && r.text.includes('removes the Ask AI button'), r.text);
    assert.match(seen[1].at(-1).content, /That was refused: .*Ask AI/);
    assert.ok(seen[0][1].content.includes(KEEP_WAY_BACK_RULE) && seen[0][1].content.includes(WORKING_RULE), 'the edit prompt asks to keep the way back and to check every control');
    assert.match(WORKING_RULE, /Year view shows all 12 months/);
    assert.equal(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), page('go()'), 'nothing written');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
test('the build prompt carries the rule; the mount hangs off <html> and puts itself back', () => {
  assert.ok(buildSystemPrompt('c').includes(KEEP_WAY_BACK_RULE));
  const m = askAiMount('T');
  assert.match(m, /document\.documentElement\.appendChild\(b\)/);
  assert.match(m, /new MutationObserver\(keep\)/);
  assert.doesNotMatch(m, /document\.body\.appendChild\(b\)/);
});
test('the demo lets the shell reach the panel, the change count and Undo — nothing else under /api/apps/', async () => {
  const { demoRouteAllowed } = await import('../lib/demo.mjs');
  assert.ok(demoRouteAllowed('GET', '/api/app-edit/panel') && demoRouteAllowed('GET', '/api/apps/calendar-planner/edits') && demoRouteAllowed('POST', '/api/apps/calendar-planner/undo'));
  for (const [m, p] of [['PATCH', '/api/apps/a/share'], ['POST', '/api/apps/a/edits'], ['POST', '/api/apps/../undo'], ['DELETE', '/api/apps/a'], ['POST', '/api/apps/a/undo/x']]) assert.equal(demoRouteAllowed(m, p), false, `${m} ${p}`);
});
