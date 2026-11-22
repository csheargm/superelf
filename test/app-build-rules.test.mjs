// App build rules（应用生成规则）— the contract the agent gets, and the node's backstop scan.
//
// SCAR (e2e 2026-11-13): 1 of 4 generated apps fully worked. The contract sent to the agent
// (appContract) carried neither the PAStore API nor "`not-found` = first run", and the section it
// did send spelled the code `not_found`, so three apps never saved. The to-do app used a <form>,
// which the sandbox (no allow-forms) blocks. The agent said "done" over both, having run only
// `node --check`. These tests pin each rule IN THE TEXT THE AGENT RECEIVES, and drive the real
// server with a fake CLI that writes a broken app, to prove the reply then names the problem.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appContract } from '../lib/config.mjs';
import { snapshotApps, appBuildWarnings, APP_CHECKS } from '../lib/app-postcheck.mjs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { ROOT } from './helpers-app.mjs';

const CONTRACT = appContract(ROOT);

test('the contract carries the PAStore API and "not-found = first run"', () => {
  assert.match(CONTRACT, /### PAStore/);
  assert.match(CONTRACT, /PAStore\.file\(/);
  assert.match(CONTRACT, /code:'not-found'\}` — hyphen — and that alone means FIRST RUN/);
});

test('the contract forbids <form> and says why (sandbox without allow-forms)', () => {
  assert.match(CONTRACT, /\*\*No `<form>` element\.\*\*/);
  assert.match(CONTRACT, /allow-forms/);
  assert.match(CONTRACT, /Enter `keydown`/);
});

test('the contract makes the per-requirement self-check mandatory', () => {
  assert.match(CONTRACT, /Self-check before saying done — mandatory/);
  assert.match(CONTRACT, /For each feature asked for, read your code/);
  assert.match(CONTRACT, /node smoke check/);
});

test('every not_found the agent reads is either forbidden or labelled as another kind\'s code', () => {
  const lines = CONTRACT.split('\n').filter((l) => l.includes('not_found'));
  assert.ok(lines.length >= 1, 'the forbidden spelling is named, so it can be recognised');
  for (const l of lines) assert.ok(/Never test|this kind's own codes/.test(l), `unlabelled not_found: ${l}`);
  assert.doesNotMatch(CONTRACT, /flags[^\n]*not_found/, 'nothing claims the node scans for not_found (that scan was removed)');
});

test('the shell relay really answers not-found (the spelling the contract teaches)', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  assert.match(shell, /return \{ok:false,code:'not-found',status:404/);
});

// ── the backstop scan, on fixtures ─────────────────────────────────────────────────────────
function appsFixture(apps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-postcheck-'));
  for (const [slug, html] of Object.entries(apps)) {
    fs.mkdirSync(path.join(dir, slug));
    fs.writeFileSync(path.join(dir, slug, 'index.html'), html);
  }
  return dir;
}

test('scan: a real <form> tag is warned; one in a comment or a JS string is not', () => {
  const dir = appsFixture({});
  const before = snapshotApps(dir);
  const put = (slug, html) => { fs.mkdirSync(path.join(dir, slug)); fs.writeFileSync(path.join(dir, slug, 'index.html'), html); };
  put('bad', `<form id=f><button>Add</button></form>`);
  put('comment', `<!-- no <form> here: the sandbox blocks it --><button type="button">Add</button>`);
  put('jsstring', `<button type="button">Add</button><script>const help = 'never use <form> or "<form id=x>"';</script>`);
  const w = appBuildWarnings(dir, before).split('\n');
  assert.equal(w.length, APP_CHECKS.length, w.join('\n'));
  assert.ok(w.every((l) => l.startsWith('⚠ apps/bad: ')), w.join('\n'));
});

test('scan: an app that handles note-page-image\'s documented not_found gets no warning', () => {
  const dir = appsFixture({});
  const before = snapshotApps(dir);
  fs.mkdirSync(path.join(dir, 'pages'));
  fs.writeFileSync(path.join(dir, 'pages', 'index.html'), `<button type="button">Show</button><script>if (r.code === 'not_found') showNoPage();</script>`);
  assert.equal(appBuildWarnings(dir, before), '');
  assert.ok(!APP_CHECKS.some((c) => /not_found/.test(c.text)), 'no rule claims a not_found scan');
});

test('scan: an app this turn did not touch is not re-reported; a missing apps dir is empty', () => {
  const dir = appsFixture({ old: '<form></form>' });
  assert.equal(appBuildWarnings(dir, snapshotApps(dir)), '');
  assert.equal(snapshotApps(path.join(dir, 'nope')).size, 0);
});

// ── user flow: the real server, a fake CLI that writes a <form> app ────────────────────────
let port, root, web;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1 } });
  const bin = path.join(root, 'fake-claude.mjs');
  const app = path.join(root, 'workspace', 'apps', 'todo');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
fs.mkdirSync(${JSON.stringify(app)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(path.join(app, 'index.html'))}, '<form><input><button>Add</button></form>');
process.stdin.resume().on('end', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'Built the to-do app.' }) + '\\n'));
`);
  fs.chmodSync(bin, 0o755);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = bin;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });

test('flow: a chat turn that writes a <form> app gets the warning in its reply and stored message', async () => {
  const res = await api(port, '/api/chat', { method: 'POST', headers: { authorization: `Bearer ${OWNER_TOKEN}` }, body: JSON.stringify({ message: 'make a to-do app' }) });
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  const done = lines.find((l) => l.type === 'done');
  assert.ok(done && done.ok, JSON.stringify(lines).slice(0, 400));
  assert.match(done.text, /^Built the to-do app\.\n\n⚠ apps\/todo: <form> element/);
  const convo = lines.find((l) => l.type === 'convo');
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'conversations', `${convo.id}.json`), 'utf8'));
  assert.match(stored.messages.at(-1).text, /⚠ apps\/todo: <form> element/);
});
