// 说「好」也能改 · Many changes in ONE app-edit conversation (owner report 2026-11-24, Red Flags, R6).
// Live: purple title → Apply worked; every later change answered "the Edit tool is disabled in this session".
// Cause: the Apply turn's session became the conversation's; the next read-only plan turn RESUMED it, and the
// model, whose transcript showed it editing, tried Edit again (absent from --tools) instead of planning.
// The fake CLI keeps the real semantics that matter: --tools limits what it may do (helpers-fake-claude-perms),
// --resume continues a stored session (an unknown id → "No conversation found"), and a session that has
// edited, resumed into a read-only turn, says exactly what the real model said.
// Also pinned: a typed "yes" applies the plan; an owner's in-app chat reply naming the panel carries its button,
// a member's never does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, api, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { FAKE_PERMS_SRC } from './helpers-fake-claude-perms.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';
import { CHANGE_APP_LABEL } from '../lib/app-chat-honesty.mjs';

const PAGE = '<!doctype html><html><body><h1 id="t" style="color:black">Todo</h1></body></html>';
const KID_TOKEN = 'kid-token-abcdefghijkl';
const FAKE = `#!/usr/bin/env node
${FAKE_PERMS_SRC}
let s = ''; process.stdin.on('data', (d) => s += d).on('end', async () => {
  const fs = await import('node:fs'), path = await import('node:path'), crypto = await import('node:crypto');
  const argv = process.argv.slice(2), sys = argv.join(' '), p = perms(argv);
  const store = process.env.FAKE_SESSIONS; fs.mkdirSync(store, { recursive: true });
  const ri = argv.indexOf('--resume'), resumed = ri >= 0 ? argv[ri + 1] : null;
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  let sess = { edited: false };
  if (resumed) { try { sess = JSON.parse(fs.readFileSync(path.join(store, resumed), 'utf8')); } catch { out({ type: 'result', subtype: 'error', is_error: true, result: 'No conversation found with session ID: ' + resumed }); process.exit(1); } }
  const sid = resumed || crypto.randomUUID();
  const cur = s.split('[Current message:]').pop();
  const colour = (cur.match(/make (?:the title|it) (\\w+)/) || [])[1];
  let say = 'The title is black.';
  if (/READ-ONLY/.test(sys)) {
    if (sess.edited && colour) say = "I couldn't make the change. The Edit tool is disabled in this session.";   // what the real resumed model said
    else if (colour) say = 'I will set the title colour to ' + colour + '.\\n[[apply]]';
  } else if (/do it now\\):\\s*I will set the title colour to (\\w+)/.test(sys)) {
    const c = sys.match(/do it now\\):\\s*I will set the title colour to (\\w+)/)[1];
    const page = p.read('index.html');
    const ok = page !== null && p.write('index.html', page.replace(/color:\\w+/, 'color:' + c));
    if (ok) sess.edited = true;
    say = ok ? 'I set the title colour to ' + c + '.' : 'The Edit tool is disabled in this session.';
  } else if (/CANNOT change this app/.test(sys)) {
    say = "No. This chat can't change this app. To change it, tap **${CHANGE_APP_LABEL}** under my reply.";
  }
  fs.writeFileSync(path.join(store, sid), JSON.stringify(sess));
  out({ type: 'system', subtype: 'init', session_id: sid });
  p.text(say);
  out({ type: 'result', subtype: 'success', result: say, session_id: sid });
});
`;

let port, root, web;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'kid', name: 'Kid', role: 'member', agent: true, token: KID_TOKEN, workspace: 'ws-kid' }] } });
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  for (const ws of ['workspace', 'ws-kid']) {
    const app = path.join(root, ws, 'apps', 'todo'); fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'index.html'), PAGE);
    fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Todo' }));
  }
  process.env.FAKE_SESSIONS = path.join(root, 'fake-sessions');   // inherited by the server, then by the fake CLI
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (root) rmTemp(root); });

async function turn(body, { token = OWNER_TOKEN, fromApp = false } = {}) {
  const headers = { authorization: `Bearer ${token}`, ...(fromApp ? { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE } : {}) };
  const res = await api(port, '/api/chat', { method: 'POST', headers, body: JSON.stringify(body) });
  const lines = (await res.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  if (process.env.DBG) console.log(JSON.stringify(lines));
  const done = lines.find((l) => l.type === 'done') || {};
  return { status: res.status, convoId: (lines.find((l) => l.type === 'convo') || {}).id, text: done.text || '',
    apply: (lines.find((l) => l.type === 'app-change-confirm') || {}).message || null, offer: lines.find((l) => l.type === 'app-change') || null };
}
const colour = () => /color:(\w+)/.exec(fs.readFileSync(path.join(root, 'workspace', 'apps', 'todo', 'index.html'), 'utf8'))[1];

// The fake's jail models POSIX rule paths (Edit(//abs/**)); on Windows the CLI's own rules differ, so the write half is POSIX-only.
test('one conversation: plan → Apply → plan → typed yes → plan → Apply, every change applied, no tool talk', { skip: process.platform === 'win32' && 'the fake jail models POSIX rule paths' }, async () => {
  let t = await turn({ edit: 'todo', message: 'make the title purple' });
  const convoId = t.convoId;
  assert.ok(t.apply, `plan 1 offers Apply: ${t.text}`);
  t = await turn({ edit: 'todo', message: t.apply, convoId });
  assert.equal(colour(), 'purple', t.text);
  for (const [want, confirm] of [['red', 'yes'], ['blue', null], ['green', '好的']]) {
    t = await turn({ edit: 'todo', message: `make the title ${want}`, convoId });
    assert.doesNotMatch(t.text, /Edit tool|session/, `no tool talk on a later plan: ${t.text}`);
    assert.ok(t.apply, `a later plan offers Apply: ${t.text}`);
    t = await turn({ edit: 'todo', message: confirm || t.apply, convoId });
    assert.equal(colour(), want, `${confirm ? `typed "${confirm}"` : 'tapped Apply'} applied ${want}: ${t.text}`);
  }
  t = await turn({ edit: 'todo', message: 'yes', convoId });
  assert.equal(colour(), 'green', 'a yes with no pending plan changes nothing');
  t = await turn({ edit: 'todo', message: 'make the title pink', convoId });
  assert.ok(t.apply);
  await turn({ edit: 'todo', message: 'no, leave it as is', convoId });
  await turn({ edit: 'todo', message: 'yes', convoId });
  assert.equal(colour(), 'green', 'a plan answered with "no" is retired: a later yes applies nothing');
});

test("an app's own chat: the owner's reply naming the panel carries a working button; a member gets none and no promise", async () => {
  const o = await turn({ app: 'todo', message: 'Can y can you modify this app?' }, { fromApp: true });
  assert.equal(o.offer && o.offer.label, CHANGE_APP_LABEL, `owner: ${o.text}`);
  const k = await turn({ app: 'todo', message: 'Can you modify this app?' }, { token: KID_TOKEN, fromApp: true });
  assert.equal(k.offer, null, `member: no button (${k.status})`);
  assert.match(k.text, /There is no Change this app button here/, `member: the reply says so: ${k.text}`);
});
