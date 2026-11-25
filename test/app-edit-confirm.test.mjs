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
  assert.deepEqual(consumeConfirm(id4, { who: 'kid', slug: 'todo' }), { plan: 'blue', request: 'blue' });
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

test('GPT review pins: unconfirmed edit turns plan with no tools, Verify never runs on an edit turn, a blocked member keeps the app chat', () => {
  const web = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
  assert.match(web, /edit && !edit\.confirmed && !edit\.superelf \? \[\.\.\.baseArgs, \.\.\.NO_TOOLS_ARGS\]/);
  assert.match(web, /if \(assess && !edit && agentAllowed\(user\)\)/);
  assert.match(web, /if \(ml\.blocked && !\(edit && edit\.scoped\)\)/);
});
