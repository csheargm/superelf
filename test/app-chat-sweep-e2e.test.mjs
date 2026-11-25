// 应用对话自测修复 · App chat self-test fixes (2026-11-24 sweep, F1 F2 F8 F9 F11), through the real web.mjs.
// A member (agent off) uses an app's one chat; the owner asks about an earlier screenshot. The fake `claude`
// keeps the real CLI's permission rule: a member's turn must carry --tools= (no tools) and then may write
// nothing; asked to without it, it fails loudly — so a lane that lost its confinement cannot pass (R14).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { PLAIN_LANE_STATUS } from '../lib/member-lanes.mjs';
import { EDIT_UNCHANGED_NOTE } from '../lib/app-chat-honesty.mjs';

const PAGE = '<!doctype html><html><head><title>T</title></head><body>\n<h1 id="t">Tasks</h1>\n<button id="go" style="background:#0059c9">Add</button>\n<script>var x=1;</script>\n</body></html>\n';
// Plan turn (READ-ONLY system line), build turn (the app contract), else a question.
const FAKE_CLAUDE = `#!/usr/bin/env node
const argv=process.argv.slice(2); const i=argv.indexOf('--append-system-prompt'); const sys=i>=0?argv[i+1]:'';
const member=process.env.PA_FAKE_MEMBER_CHECK!=='0';
let s=''; process.stdin.on('data',(d)=>s+=d).on('end',()=>{
  const out=(t)=>{ process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'sid'})+'\\n'); process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:t,session_id:'sid'})+'\\n'); };
  const owner=/FACT: earlier in this conversation/.test(sys)||/截图/.test(s.split('User:').pop());
  if(!argv.includes('--tools=')&&!owner){ process.stderr.write('a member turn reached claude WITH tools'); process.exit(3); }
  if(/截图/.test(s)) return out(/FACT: earlier in this conversation the user attached 1 picture/.test(sys)?'SAW THE EARLIER SHOT':'我没有看到截图');
  if(/READ-ONLY/.test(sys)&&/做什么/.test(s.split('User:').pop())) return out('这个应用用来记待办。已添加的任务会显示在列表里。');
  if(/READ-ONLY/.test(sys)) return out('I will make the Add button dark green (#2e7d32).\\n[[apply]]');
  const page=${JSON.stringify(PAGE)}.replace('#0059c9','#2e7d32');
  out('The Add button is now dark green.\\n\\n\`\`\`html\\n'+page+'\`\`\`\\n\`\`\`json\\n{"title":"Tasks"}\\n\`\`\`');
}); `;
let port, root, web, kid, mom;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, member_limits: { ai_calls_per_user_per_day: 3 },
    users: [{ id: 'owner', username: 'mom', name: 'Mom', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') },
      { id: 'kid', username: 'kid', name: 'Kid', role: 'member', workspace: 'kidws', passHash: hashPassword('kid-pass-12345') }] } });
  for (const w of ['workspace', 'kidws']) { const d = path.join(root, w, 'apps', 'todo'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'index.html'), PAGE); fs.writeFileSync(path.join(d, 'meta.json'), '{"title":"Tasks"}'); }
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json'); const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE_CLAUDE); fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (root) rmTemp(root); });

const base = () => `http://127.0.0.1:${port}`;
const login = async (u, p) => (await (await fetch(`${base()}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const call = (tok, p, opt = {}) => fetch(`${base()}${p}`, { ...opt, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` } });
async function turn(tok, body) {
  const txt = await (await call(tok, '/api/chat', { method: 'POST', body: JSON.stringify({ edit: 'todo', ...body }) })).text();
  return txt.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
const done = (ev) => ev.find((e) => e.type === 'done');
const streamed = (ev) => ev.filter((e) => e.type === 'delta').map((e) => e.text).join('');
const kidPage = () => fs.readFileSync(path.join(root, 'kidws', 'apps', 'todo', 'index.html'), 'utf8');

let convo;
test('F1 + F8: a member\'s question is answered (streamed, no "not changed" note) and the lane is named', async () => {
  kid = await login('kid', 'kid-pass-12345');
  const ev = await turn(kid, { message: '这个应用是做什么的？' });
  convo = ev.find((e) => e.convoId)?.convoId || ev.find((e) => e.type === 'convo')?.id;
  assert.match(streamed(ev), /记待办/, `the answer reaches the bubble: ${JSON.stringify(ev)}`);
  assert.ok(!streamed(ev).includes(EDIT_UNCHANGED_NOTE) && !done(ev).text.includes(EDIT_UNCHANGED_NOTE), 'a question is not a false change claim');
  assert.ok(ev.some((e) => e.type === 'status' && e.text.startsWith(PLAIN_LANE_STATUS) && e.keep === true), 'F8: the plain-lane status, kept in the log (round 2)');
  assert.equal(done(ev).by, 'Claude', 'F8: the model under the reply');
});

test('F2: a member\'s Apply says in a plain sentence what changed, and the count is the real diff', async () => {
  const plan = await turn(kid, { message: 'make the Add button green', convoId: convo });
  const c = plan.find((e) => e.type === 'app-change-confirm');
  assert.ok(c, JSON.stringify(plan));
  const ap = await turn(kid, { message: c.message, convoId: convo });
  assert.match(kidPage(), /#2e7d32/, 'the page changed');
  const s = streamed(ap);
  assert.match(s, /The Add button is now dark green\./, `the model's sentence is shown: ${s}`);
  assert.match(s, /改动：1 行 · Changed: 1 line/);
  assert.doesNotMatch(s, /index\.html|```/, 'plain words');
});

test('F11: Undo says how many are left (0 hides the button); a cap refusal stores no "took"', async () => {
  const u = await (await call(kid, '/api/apps/todo/undo', { method: 'POST' })).json();
  assert.equal(u.undone, true); assert.equal(u.left, 0);
  assert.equal(kidPage(), PAGE);
  const ev = await turn(kid, { message: 'what is this?', convoId: convo });   // 4th charge: over the cap of 3
  assert.equal(done(ev).ok, false);
  const stored = (await (await call(kid, `/api/convos/${encodeURIComponent(convo)}`)).json()).messages.at(-1);
  assert.equal(stored.ms, undefined, 'no "took" under a refusal');
});

test('F9: an owner\'s later turn knows the screenshot attached earlier', async () => {
  mom = await login('mom', 'owner-pass-123');
  const up = await (await call(mom, '/api/upload', { method: 'POST', body: JSON.stringify({ name: 'screen-todo-1.png', data: 'iVBORw0KGgoAAAANSUhEUg==' }) })).json();
  assert.ok(up.ok, JSON.stringify(up));
  const first = await turn(mom, { message: 'hello', attachments: [{ name: up.name, path: up.path }] });
  const id = first.find((e) => e.convoId)?.convoId || first.find((e) => e.type === 'convo')?.id;
  const ev = await turn(mom, { message: '你从截图里看到了什么？', convoId: id });
  assert.match(done(ev).text, /SAW THE EARLIER SHOT/, JSON.stringify(ev));
});
