// Owner report 2026-11-25 (School Helper, iPhone): Publish on a copied app opened a dead-end refusal over the
// app's header, and the app's own chat promised a "Change this app" button "under my reply" that was not there.
// Invariants, pinned for every site (not the one reported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { CHANGE_PATHS, APP_CHAT_NO_CHANGE_RULE, CHANGE_APP_LABEL } from '../lib/app-chat-honesty.mjs';

const read = (f) => fs.readFileSync(f, 'utf8');

test('every menu asks PAPublish.item(slug): the fork gate lives in ONE place', () => {
  const files = execFileSync('git', ['grep', '-l', 'PAPublish.item', '--', 'web'], { encoding: 'utf8' }).trim().split('\n');
  for (const f of files) {
    const calls = read(f).match(/PAPublish\.item\([^)]*\)/g) || [];
    for (const c of calls) assert.notEqual(c, 'PAPublish.item()', `${f}: ${c} skips the fork gate`);
  }
  assert.doesNotMatch(read('web/index.html'), /!forked\?PAPublish/, 'no second fork rule beside the gate');
});

function loadPublish(forks, role = 'member') {
  const ctx = { FORK_APPS: new Set(forks), ROLE: role, $: () => null, api: () => null, esc: (s) => s, _SEEN: new Set(), localStorage: null };
  vm.createContext(ctx); vm.runInContext(`${read('web/publish.js')}\nthis.P=PAPublish;`, ctx);
  return ctx.P;
}
test('a member\'s copy gets no Publish item, only a true line (no "ask the original author")', () => {
  const P = loadPublish(['school-mine']);
  const f = P.item('school-mine');
  assert.doesNotMatch(f, /pubItem|<button/, 'no button that can only refuse');
  assert.match(f, /^<div id="pubFork">?.*发布只对节点主人开放 · Only the node's owner can publish/, '中文 first, then English');
  assert.doesNotMatch(f, /original author/);
});

test('the owner\'s copy gets Publish held off until the server names where it goes (copy-target.mjs)', () => {
  const P = loadPublish(['school-mine'], 'owner');
  assert.match(P.item('mine'), /id="pubItem">/, 'an own app: on at once');
  assert.match(P.item('school-mine'), /id="pubItem" disabled style="opacity:\.5;pointer-events:none"/);
});

test('the publish sheet sits at the bottom, never over the app header', () => {
  const s = read('web/publish.js');
  assert.doesNotMatch(s, /top:64px/);
  assert.match(s, /s\.style\.cssText='[^']*bottom:calc\(8px \+ env\(safe-area-inset-bottom\)\)/);
});

test('the app chat names only the control it renders, calmly', () => {
  for (const [role, p] of Object.entries(CHANGE_PATHS)) {
    assert.doesNotMatch(p, /under (your|my|the) reply|⋯|menu →/i, `${role}: no control that may not be on screen`);
  }
  assert.ok(CHANGE_PATHS.owner.includes(`"${CHANGE_APP_LABEL}" button is shown right below your reply`));
  assert.doesNotMatch(CHANGE_PATHS.member + CHANGE_PATHS.demo, /改这个应用|change this app/i, 'no button for those who get none');
  assert.match(APP_CHAT_NO_CHANGE_RULE, /calm.*never argue, blame or say anyone is wrong/);
  assert.doesNotMatch(APP_CHAT_NO_CHANGE_RULE, /whatever model/);
});

test('no prompt or shipped string promises a control "under my/your reply" (R11 grep, pinned)', () => {
  let hits = '';
  try { hits = execFileSync('git', ['grep', '-n', '-i', '-E', 'under (your|my) reply', '--', 'lib', 'web', 'web.mjs', 'superelf.md', 'workspace.example', 'shared-apps'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (e) { if (e.status !== 1) throw e; /* git grep exits 1 on zero matches: the clean result (GPT review) */ }
  const code = hits.split('\n').filter((l) => l && !/^[^:]+:\d+:\s*\/\//.test(l));   // a comment that quotes the scar is fine
  assert.deepEqual(code, []);
});

test('the offer is stored with the reply and a reopened chat shows the button again', () => {
  const w = read('web.mjs');
  assert.match(w, /\.\.\.\(r\.offer \? \{ offer: \{ type: 'app-change', label: r\.offer\.label \} \} : \{\}\)/);
  assert.match(w, /const canEditHere = user\.role === 'owner' && typeof app === 'string' && slugOk\(app\) && appEditable\(appsDir\(user\), app\)/);
  assert.match(w, /canEdit: origin\.fromApp && canEditHere && appEditable\(appsDir\(user\), app\)/, 're-checked after the model');
  assert.match(w, /chatRole = user\.role !== 'owner' \? 'member' : canEditHere \? 'owner' : 'ownerShared'/, 'the prompt names the button only when it is sent');
  const c = read('web/chat-ui.inline.html');
  assert.equal((c.match(/if\(mm\.offer&&mm\.offer\.type==='app-change'\) addChangeApp\(ae,\{type:'app-change',label:mm\.offer\.label,request:''\}\)/g) || []).length, 2, 'both history loaders');
  assert.match(read('web/app-edit.js'), /m\.request!==''&&!\(offers\.get\(fr\)/, 'a stored button opens the panel empty; only a live offer may prefill');
});

test('appEditable: the one editable test refuses a linked index.html (GPT review)', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { appEditable } = await import('../lib/app-edit.mjs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-')); const apps = path.join(ws, 'apps');
  fs.mkdirSync(path.join(apps, 'real'), { recursive: true }); fs.writeFileSync(path.join(apps, 'real', 'index.html'), 'x');
  fs.mkdirSync(path.join(apps, 'linked')); fs.writeFileSync(path.join(ws, 'elsewhere.html'), 'x');
  fs.symlinkSync(path.join(ws, 'elsewhere.html'), path.join(apps, 'linked', 'index.html'));
  assert.equal(appEditable(apps, 'real'), true);
  assert.equal(appEditable(apps, 'linked'), false);
  assert.equal(appEditable(apps, 'absent'), false);
  fs.rmSync(ws, { recursive: true, force: true });
});
