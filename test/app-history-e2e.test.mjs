// What changed on this app — the real /api/chat flow (R6). A FAKE `claude` edits the app on
// "make it red" and otherwise ECHOES the system line it was given, so the test sees exactly the
// facts the model would see: the panel's "what changed?" carries the saved version, the request
// that caused it and the diff; an app's own chat carries the release-notes lines and the rule.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const FAKE = `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', async () => {
  const fs = await import('node:fs');
  const cur = s.split('[Current message:]').pop();
  const i = process.argv.indexOf('--append-system-prompt');
  let say = 'SYSTEM:' + (i > 0 ? process.argv[i + 1] : '');
  if (/READ-ONLY/.test(say) && /make it red/.test(cur)) say = 'I will make it red.\\n[[apply]]';   // unconfirmed: plan only (ADR 0042)
  else if (/confirmed this change \\(do it now\\):\\s*make it red/.test(say)) { const f = 'apps/todo/index.html'; fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('<h1>', '<h1 style="color:red">')); say = 'Made it red.'; }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-h' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: say, session_id: 'sid-h' }) + '\\n');
});
`;

let port, root, web;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1 } });
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  for (const [slug, title] of [['todo', 'Todo'], ['sunday-study', 'Sunday Study']]) {
    const d = path.join(root, 'workspace', 'apps', slug); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.html'), '<!doctype html><html><body><h1>Hi</h1></body></html>');
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ title }));
  }
  // The test root holds no repo notes: the REAL version-notes.json is copied in (it names Sunday Study).
  fs.copyFileSync(new URL('../version-notes.json', import.meta.url), path.join(root, 'version-notes.json'));
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (root) rmTemp(root); });

async function chatLines(body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}`, ...headers }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.clone().text());
  return (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
async function chat(body, headers = {}) {
  const lines = await chatLines(body, headers);
  return lines.filter((l) => l.type === 'done' || l.type === 'reply' || l.type === 'delta' || l.text).map((l) => l.text || '').join('\n');
}

test('Change this app: "what changed?" is answered from the saved version, its request and the diff', { timeout: 60000 }, async () => {
  const apply = await chatLines({ message: 'make it red', edit: 'todo' });
  const offer = apply.find((l) => l.type === 'app-change-confirm');
  assert.ok(offer, 'a change is planned first, with 改 · Apply');
  await chat({ message: offer.message, edit: 'todo' });
  const out = await chat({ message: 'what has been changed on this app?', edit: 'todo' });
  assert.match(out, /SYSTEM:/, 'the fake echoed its system line');
  assert.match(out, /Saved versions of this app/);
  assert.match(out, /copy from BEFORE the change asked as: "make it red" by "owner"/);
  assert.match(out, /- <!doctype html><html><body><h1>Hi<\/h1>/);
  assert.match(out, /\+ <!doctype html><html><body><h1 style="color:red">Hi<\/h1>/);
  assert.match(out, /answer from the FACTS below/);
});

test("an app's own chat gets the about-this-app facts with release-notes lines, and the no-invented-UI rule", { timeout: 60000 }, async () => {
  const out = await chat({ message: 'what was published just now?', app: 'sunday-study' }, { 'x-superelf-origin': 'app' });
  assert.match(out, /App: "Sunday Study" \(sunday-study\)/);
  assert.match(out, /Release-notes lines naming this app[^\n]*\n- "v[\d.]+[^\n]*Sunday Study/, 'a real release-notes line (version-notes.json) names the app');
  assert.match(out, /version line at the bottom of the home screen/);
  assert.doesNotMatch(out, /Saved versions of this app/, 'the version list belongs to the edit panel');
});
