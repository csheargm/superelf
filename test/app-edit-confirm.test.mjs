// 一个应用一个对话 · The one app chat (ADR 0042): the server-held 改 · Apply gate and the members' no-tools lane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers-tmp.mjs';
import { mintConfirm, consumeConfirm, applyIdOf, applyMessage, planOffer, PLAN_MARKER, CONFIRM_TTL_MS } from '../lib/app-edit-confirm.mjs';
import { appEditOf, confirmEdit, beginAppEdit, finishAppEdit, editSystemPrompt } from '../lib/app-edit.mjs';
import { writeScopedFile, scopedLane, runScopedEdit, flattenForClaude } from '../lib/app-edit-lane.mjs';

const OWNER = { id: 'owner', role: 'owner' };
const KID = { id: 'kid', role: 'member' };
const PAGE = '<!doctype html><html><body><h1>Hi</h1><script>let n=1;</script></body></html>';
function ws() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-confirm-'));
  fs.mkdirSync(path.join(w, 'apps', 'todo'), { recursive: true });
  fs.writeFileSync(path.join(w, 'apps', 'todo', 'index.html'), PAGE);
  return w;
}
const ed = (w, message, user = OWNER, members = true) => appEditOf({ user, body: { edit: 'todo', message }, headers: {}, appsDir: path.join(w, 'apps'), members });
const code = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.code; } };
const page = (w) => fs.readFileSync(path.join(w, 'apps', 'todo', 'index.html'), 'utf8');

test('a confirm id is single use and bound to the user, the app and time', () => {
  const id = mintConfirm({ who: 'kid', slug: 'todo', plan: 'make it red' });
  assert.equal(applyIdOf(applyMessage(id)), id);
  assert.equal(applyIdOf('改 · Apply'), null, 'the label alone carries no id');
  assert.equal(code(() => consumeConfirm(id, { who: 'other', slug: 'todo' })), 'bad_confirm', 'wrong user');
  assert.equal(code(() => consumeConfirm(id, { who: 'kid', slug: 'todo' })), 'bad_confirm', 'a refused try burns it too');
  const id2 = mintConfirm({ who: 'kid', slug: 'todo', plan: 'p' });
  assert.equal(code(() => consumeConfirm(id2, { who: 'kid', slug: 'notes' })), 'bad_confirm', 'wrong app');
  const t = Date.now(); const id3 = mintConfirm({ who: 'kid', slug: 'todo', plan: 'p' }, t);
  assert.equal(code(() => consumeConfirm(id3, { who: 'kid', slug: 'todo' }, t + CONFIRM_TTL_MS + 1)), 'bad_confirm', 'expired');
  const id4 = mintConfirm({ who: 'kid', slug: 'todo', plan: 'blue' });
  assert.deepEqual(consumeConfirm(id4, { who: 'kid', slug: 'todo' }), { plan: 'blue', request: '' });
  assert.equal(code(() => consumeConfirm(id4, { who: 'kid', slug: 'todo' })), 'bad_confirm', 'single use');
  assert.equal(code(() => consumeConfirm('forged-id-000000', { who: 'kid', slug: 'todo' })), 'bad_confirm', 'never minted');
});

test('the plan marker is stripped and only then offered', () => {
  assert.deepEqual(planOffer(`I will make the title red.\n${PLAN_MARKER}`), { text: 'I will make the title red.', offered: true });
  assert.deepEqual(planOffer('The title is blue.'), { text: 'The title is blue.', offered: false });
});

test('no confirm, no write: an unconfirmed turn that changed the app is rolled back', () => {
  const w = ws();
  try {
    const e = confirmEdit(ed(w, 'make it red'));
    assert.equal(e.confirmed, false);
    assert.match(editSystemPrompt(e), /READ-ONLY/);
    const ctx = beginAppEdit(e, { wsDir: w });
    fs.writeFileSync(path.join(w, 'apps', 'todo', 'index.html'), PAGE.replace('Hi', 'Red'));
    const r = finishAppEdit(e, ctx, { wsDir: w });
    assert.deepEqual([r.line.applied, r.line.unconfirmed], [false, true]);
    assert.equal(page(w), PAGE, 'the app is as it was');
  } finally { rmTemp(w); }
});

test('Done only after a confirmed write: the Apply turn applies, with the plan as its request', () => {
  const w = ws();
  try {
    const id = mintConfirm({ who: 'owner', slug: 'todo', plan: 'make it red\n\nI will make the title red.', request: 'make it red' });
    const e = confirmEdit(ed(w, applyMessage(id)));
    assert.deepEqual([e.confirmed, e.request], [true, 'make it red'], 'the history keeps the user\'s words');
    assert.match(editSystemPrompt(e), /make it red/);
    const ctx = beginAppEdit(e, { wsDir: w });
    fs.writeFileSync(path.join(w, 'apps', 'todo', 'index.html'), PAGE.replace('Hi', 'Red'));
    assert.equal(finishAppEdit(e, ctx, { wsDir: w }).line.applied, true);
    assert.equal(code(() => confirmEdit(ed(w, applyMessage(id)))), 'bad_confirm', 'the same tap twice does not write twice');
  } finally { rmTemp(w); }
});

test('roles are decided on the server: members only where allowed, never "change superelf", never others\' apps', () => {
  const w = ws();
  try {
    assert.equal(code(() => ed(w, 'x', KID, false)), 'edit_owner_only', 'the demo passes members:false');
    assert.equal(ed(w, 'x', KID).scoped, true, 'a member gets the scoped lane');
    assert.equal(ed(w, 'x', OWNER).scoped, false);
    assert.equal(code(() => ed(w, 'change superelf: bigger buttons', KID)), 'edit_superelf_owner_only');
    assert.equal(ed(w, 'change superelf: bigger buttons', OWNER).superelf, true);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-other-'));
    try { assert.equal(code(() => appEditOf({ user: KID, body: { edit: 'todo', message: 'x' }, headers: {}, appsDir: path.join(other, 'apps'), members: true })), 'no_app', 'only apps in the caller\'s own apps/'); }
    finally { rmTemp(other); }
    const id = mintConfirm({ who: 'owner', slug: 'todo', plan: 'p' });
    assert.equal(code(() => confirmEdit(ed(w, applyMessage(id), KID))), 'bad_confirm', "another user's id does not confirm");
  } finally { rmTemp(w); }
});

test('the scoped lane is Ollama or Claude, never Codex', () => {
  assert.deepEqual(scopedLane({ provider: 'codex', model: 'gpt' }), { provider: 'claude' });
  assert.deepEqual(scopedLane(null), { provider: 'claude' });
  const o = { provider: 'ollama', model: 'm' };
  assert.equal(scopedLane(o), o);
});

test('the scoped writer writes only index.html/meta.json in the own app, never through a link', () => {
  const w = ws();
  try {
    for (const name of ['.env', 'CLAUDE.md', 'AGENTS.md', '../x.html', 'data.json', '.hidden'])
      assert.throws(() => writeScopedFile(w, 'todo', name, 'x'), /not an app file/, name);
    assert.throws(() => writeScopedFile(w, '../todo', 'index.html', 'x'), /bad app name/);
    assert.throws(() => writeScopedFile(w, 'nope', 'index.html', 'x'), /no such app/);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-out-'));
    try {
      fs.writeFileSync(path.join(out, 'index.html'), PAGE);
      fs.symlinkSync(out, path.join(w, 'apps', 'linked'));
      assert.throws(() => writeScopedFile(w, 'linked', 'index.html', 'x'), /bad app path/);
      assert.equal(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), PAGE, 'the link target is untouched');
    } finally { rmTemp(out); }
    writeScopedFile(w, 'todo', 'index.html', 'NEW');
    assert.equal(page(w), 'NEW');
  } finally { rmTemp(w); }
});

const BUILT = '```json\n{"slug":"todo","title":"Todo"}\n```\n```html\n<!doctype html><html><body><h1>Red</h1></body></html>\n```';

test('scoped turn: unconfirmed answers with no write; confirmed writes the page; one model call each', async () => {
  const w = ws();
  try {
    let calls = 0;
    const e1 = confirmEdit(ed(w, 'make the title red', KID));
    const r1 = await runScopedEdit({ edit: e1, wsDir: w, message: 'make the title red', prior: [], contract: 'C', ask: async (m) => { calls++; assert.match(m[0].content, /READ-ONLY/); return `I will make it red.\n${PLAN_MARKER}`; } });
    assert.match(r1.text, /red/); assert.equal(page(w), PAGE); assert.equal(calls, 1);
    const id = mintConfirm({ who: 'kid', slug: 'todo', plan: 'make the title red' });
    const e2 = confirmEdit(ed(w, applyMessage(id), KID));
    const r2 = await runScopedEdit({ edit: e2, wsDir: w, message: applyMessage(id), prior: [], contract: 'C', ask: async () => { calls++; return BUILT; } });
    assert.equal(r2.ok, true); assert.match(page(w), /Red/); assert.equal(calls, 2);
    const e3 = Object.assign(confirmEdit(ed(w, 'x', KID)), { confirmed: true, plan: 'p' });
    const r3 = await runScopedEdit({ edit: e3, wsDir: w, message: 'x', prior: [], contract: 'C', ask: async () => 'no page here' });
    assert.equal(r3.ok, false, 'a reply with no page twice is a failure, never a silent pass');
  } finally { rmTemp(w); }
});

test('flattenForClaude keeps the system line apart', () => {
  const f = flattenForClaude([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }, { role: 'assistant', content: 'A' }]);
  assert.equal(f.system, 'S'); assert.match(f.prompt, /User: U[\s\S]*Assistant: A/);
});

test('GPT review pins: unconfirmed edit turns only read (Read/Glob/Grep), Verify never runs on an edit turn, a blocked member keeps the app chat', () => {
  const web = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
  assert.match(web, /jailed \? appJailArgs\(baseArgs, appCwd, readable\)\n\s*: appCwd \? appReadArgs\(baseArgs, readable\) : agentArgs\(user, baseArgs, origin\)/, 'unconfirmed: read-only tools in the app folder; confirmed: the jail');
  assert.match(web, /if \(assess && !edit && agentAllowed\(user\)\)/);
  assert.match(web, /if \(ml\.blocked && !\(edit && edit\.scoped\)\)/);
});

test('GPT review r3: a long request never pushes out the plan; an attachment after the tap still applies', () => {
  const long = 'x'.repeat(5000);
  const id = mintConfirm({ who: 'owner', slug: 'todo', plan: 'I will make the title red.', request: long });
  assert.equal(applyIdOf(`${applyMessage(id)}\n\n[attached: shot.png]`), id, 'trailing attachment text keeps the id');
  assert.equal(applyIdOf(`${applyMessage(id)}x`), null, 'no id with junk glued on');
  const w = ws();
  try {
    const e = confirmEdit(ed(w, applyMessage(id)));
    assert.match(e.plan, /I will make the title red\.$/, 'the plan the user saw is always in');
  } finally { rmTemp(w); }
});

test('GPT review r3: a Stop during a confirmed change rolls it back', () => {
  const w = ws();
  try {
    const id = mintConfirm({ who: 'owner', slug: 'todo', plan: 'p', request: 'r' });
    const e = confirmEdit(ed(w, applyMessage(id)));
    const ctx = beginAppEdit(e, { wsDir: w });
    fs.writeFileSync(path.join(w, 'apps', 'todo', 'index.html'), PAGE.replace('Hi', 'Half'));
    e.stopped = true;
    const r = finishAppEdit(e, ctx, { wsDir: w });
    assert.deepEqual([r.line.applied, r.line.stopped], [false, true]);
    assert.equal(page(w), PAGE);
  } finally { rmTemp(w); }
});

test('GPT review r3: the member lane keeps the page out of the system line and never writes after a Stop', async () => {
  const w = ws();
  try {
    const e1 = confirmEdit(ed(w, 'q', KID));
    await runScopedEdit({ edit: e1, wsDir: w, message: 'q', prior: [], contract: 'C', ask: async (m) => {
      assert.doesNotMatch(m[0].content, /<h1>Hi/); assert.match(m[1].content, /PAGE \(index.html\) START[\s\S]*<h1>Hi/); return 'ok'; } });
    const ac = new AbortController();
    const id = mintConfirm({ who: 'kid', slug: 'todo', plan: 'p' });
    const e2 = confirmEdit(ed(w, applyMessage(id), KID));
    const r = await runScopedEdit({ edit: e2, wsDir: w, message: 'x', prior: [], contract: 'C', signal: ac.signal, ask: async () => { ac.abort(); return BUILT; } });
    assert.equal(r.ok, false); assert.equal(page(w), PAGE, 'nothing written after the Stop');
  } finally { rmTemp(w); }
});

test('GPT review r4: words on the Apply line itself are not a tap; an over-long plan offers no Apply', () => {
  const id = mintConfirm({ who: 'owner', slug: 'todo', plan: 'p' });
  assert.equal(applyIdOf(`${applyMessage(id)} — do not apply`), null);
  const WEB = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
  const OFFER = fs.readFileSync(new URL('../lib/app-edit-offer.mjs', import.meta.url), 'utf8');
  assert.match(OFFER, /o\.text\.length > PLAN_MAX\) return/, 'offerApply refuses a plan it would have to cut');
  assert.match(WEB, /cancel\.signal\.aborted \? \{ ok: false, text: CANCELLED_TEXT \} : runClaude/, 'a member turn stopped while queued never spawns');
  assert.equal((WEB.match(/if \(edit && cancel && cancel\.signal\.aborted\) edit\.stopped = true;/g) || []).length, 2, 'both the done and the crash path mark a Stop');
});

test('GPT review r5: share and delete refuse while an edit runs, so its rollback cannot undo them', async () => {
  const { editBusyBody } = await import('../lib/app-edit.mjs');
  const w = ws();
  try {
    const e = confirmEdit(ed(w, 'make it red'));
    assert.equal(editBusyBody(w, 'todo'), null);
    const ctx = beginAppEdit(e, { wsDir: w });
    assert.equal(JSON.parse(editBusyBody(w, 'todo')).code, 'edit_busy');
    finishAppEdit(e, ctx, { wsDir: w });
    assert.equal(editBusyBody(w, 'todo'), null, 'free again after the turn');
    const WEB = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
    assert.equal((WEB.match(/editBusyBody\(wsDir\(user\), slug\)/g) || []).length, 3, 'the share, the update and the delete route');
  } finally { rmTemp(w); }
});

// 说「好」也能改 · Owner report 2026-11-24 (Red Flags): a typed yes and tool talk.
import { isTypedConfirm, pendingConfirm, toolTalkReplacement, saysNo, REOFFER_LINE, ASK_AGAIN_LINE } from '../lib/app-edit-confirm.mjs';
test('a short typed yes counts as the tap; anything more stays a normal turn (known limits)', () => {
  for (const t of ['yes', 'Yes!', 'ok', 'go ahead', 'do it', 'apply', 'yes please.', 'ok, do it', '好', '好的', '可以', '改吧', '确认', '好的，改吧', '嗯 好'])
    assert.equal(isTypedConfirm(t), true, t);
  for (const t of ['no', '不好', '不要', 'yes but bigger', '好，再大一点', 'Yes, I want the size of the fonts to suit the iPhone', '是什么', '', 'okay '.repeat(10), 'thanks', '谢谢', 'Apply?', '好吗？', 'please', 'gogo', 'okayokay'])
    assert.equal(isTypedConfirm(t), false, t);
});
test('a typed yes applies the newest plan of THIS conversation only, once', () => {
  const w = ws();
  try {
    const key = { who: 'owner', slug: 'todo' };
    mintConfirm({ ...key, convo: 'c1', plan: 'old plan' });
    mintConfirm({ ...key, convo: 'c1', plan: 'make it red' });
    mintConfirm({ ...key, convo: 'c2', plan: 'other chat' });
    const yes = (convo, message = 'yes') => appEditOf({ user: OWNER, body: { edit: 'todo', message, convoId: convo }, headers: {}, appsDir: path.join(w, 'apps') });
    assert.equal(confirmEdit(yes('c9')).confirmed, false, 'another conversation has no plan');
    const e = confirmEdit(yes('c1'));
    assert.deepEqual([e.confirmed, e.plan], [true, 'make it red']);
    assert.equal(pendingConfirm({ ...key, convo: 'c1' }), null, 'the revised-away plan went when the new one was minted; the applied one is gone (single use)');
    assert.equal(confirmEdit(yes('c1')).confirmed, false, 'a second yes applies nothing');
    assert.equal(confirmEdit(appEditOf({ user: KID, body: { edit: 'todo', message: 'yes', convoId: 'c2' }, headers: {}, appsDir: path.join(w, 'apps'), members: true })).confirmed, false, 'another user');
  } finally { rmTemp(w); }
});
test('tool/session talk in a plan turn is replaced: the pending plan + its button, or a plain ask', () => {
  const key = { who: 'owner', slug: 'notes', convo: 'c7' };
  assert.equal(toolTalkReplacement('The title is blue.', key), null);
  assert.equal(toolTalkReplacement('Answer in plain words: never write tool-call syntax.', key), null, 'our own prompt words are not tool talk');
  assert.deepEqual(toolTalkReplacement("I still can't edit index.html. The Edit tool is still disabled in this session.", key), { text: ASK_AGAIN_LINE, id: null });
  const id = mintConfirm({ ...key, plan: 'Base text 18px.' });
  for (const t of ['Write tool is off', "the block is in the session's tool setup", 'the session’s tool list', 'Editing needs to be re-enabled'])
    assert.deepEqual(toolTalkReplacement(t, key), { text: `Base text 18px.\n\n${REOFFER_LINE}`, id }, t);
  assert.deepEqual(toolTalkReplacement('Edit tool is off', key, false), { text: ASK_AGAIN_LINE, id: null }, 'never re-offered after a no');
  for (const m of ['no, leave it as is', "don't", '不要改', '算了']) assert.equal(saysNo(m), true, m);
  for (const m of ['Yes, I want the size of the fonts suitable for iPhone', 'make it bigger', '好']) assert.equal(saysNo(m), false, m);
});
test('the plan prompt forbids tool talk and asks for a plan with the marker on every change request', () => {
  const p = editSystemPrompt({ slug: 'todo', confirmed: false });
  assert.match(p, /Never mention tools, sessions, permissions/);
  assert.match(p, /even again or the same one again/);
});
