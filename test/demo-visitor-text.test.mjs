// Visitor-facing demo text never names scripturetolife (owner 2026-11-22: accounts are shared with it
// behind the scenes, but naming it confused visitors). Scans what a visitor can see: the served demo
// shell (web/index.html + lib/demo-boot.mjs injection, with the shipped demo config), the shipped
// demo config's visitor fields, and the starter apps a demo workspace is seeded with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectDemoBoot, SIGNIN_LABELS, DEMO_APP_TIP } from '../lib/demo-boot.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BANNED = /scripturetolife/i;
const demoCfg = JSON.parse(fs.readFileSync(path.join(REPO, 'ops/demo/config.demo.json'), 'utf8'));

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

test('the served demo shell and its labels never name scripturetolife', () => {
  const shell = injectDemoBoot(fs.readFileSync(path.join(REPO, 'web/index.html'), 'utf8'), demoCfg);
  assert.ok(shell.includes(JSON.stringify(DEMO_APP_TIP)), 'the injection ran');
  assert.doesNotMatch(shell, BANNED);
  for (const [k, v] of Object.entries(SIGNIN_LABELS)) assert.doesNotMatch(v, BANNED, `label ${k}`);
});

test('the shipped demo config visitor text never names scripturetolife', () => {
  assert.doesNotMatch(JSON.stringify({ title: demoCfg.demo?.title, notice: demoCfg.demo?.notice }), BANNED);
});

test('the starter apps never name scripturetolife', () => {
  const files = filesUnder(path.join(REPO, 'workspace.example/apps')).filter((f) => /\.(html|js|mjs|json|md|css)$/.test(f));
  assert.ok(files.length > 0, 'starter apps found');
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), BANNED, path.relative(REPO, f));
});

test('the app tip and the notice sit INSIDE the fixed input bar, so neither hides under the input', () => {
  const shell = injectDemoBoot(fs.readFileSync(path.join(REPO, 'web/index.html'), 'utf8'), demoCfg);
  assert.ok(shell.includes("t.id='demoTip'") && shell.includes('f.insertBefore(t,f.firstChild)'), 'tip: first child, above the chip');
  assert.ok(shell.includes("n.id='demoNotice'") && shell.includes('f.appendChild(n)'), 'notice: last child, below the input');
});
