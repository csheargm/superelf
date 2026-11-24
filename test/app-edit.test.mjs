// 改这个应用 · Change this app, the server half (lib/app-edit.mjs, lib/app-versions.mjs; ADR 0040).
// Who may open an edit turn, the undo history, and the inline checks that keep a broken change out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers-tmp.mjs';
import { appEditOf, editChecks, beginAppEdit, finishAppEdit, undoAppEdit, editSystemPrompt, VERSIONS_DIR } from '../lib/app-edit.mjs';
import { snapshotApp, listVersions, undoLastEdit, restoreVersion, VERSIONS_KEPT } from '../lib/app-versions.mjs';
import { convoTag, convoReachable, agentConfined, APP_ORIGIN_HEADER } from '../lib/agent-origin.mjs';

const OWNER = { id: 'owner', role: 'owner' };
const MEMBER = { id: 'kid', role: 'member' };
const PAGE = '<!doctype html><html><body><h1>Hi</h1><script>let n=1;</script></body></html>';

function ws() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-edit-'));
  fs.mkdirSync(path.join(w, 'apps', 'todo'), { recursive: true });
  fs.writeFileSync(path.join(w, 'apps', 'todo', 'index.html'), PAGE);
  fs.writeFileSync(path.join(w, 'apps', 'todo', 'meta.json'), '{"title":"Todo"}');
  fs.mkdirSync(path.join(w, 'data', 'todo'), { recursive: true });
  fs.writeFileSync(path.join(w, 'data', 'todo', 'items.json'), '[1,2]');
  return w;
}
const ed = (w, body, user = OWNER, headers = {}) => appEditOf({ user, body, headers, appsDir: path.join(w, 'apps') });
const code = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.code; } };

test('an ordinary chat is not an edit turn', () => {
  const w = ws();
  try { assert.equal(ed(w, { message: 'hi' }), null); } finally { rmTemp(w); }
});

test('only the owner, never from an app, only an existing own app, only a valid slug', () => {
  const w = ws();
  try {
    assert.equal(code(() => ed(w, { edit: 'todo', message: 'x' }, MEMBER)), 'edit_owner_only');
    assert.equal(code(() => ed(w, { edit: 'todo', message: 'x' }, OWNER, { [APP_ORIGIN_HEADER]: 'app' })), 'edit_from_app');
    assert.equal(code(() => ed(w, { edit: 'todo', app: 'todo', message: 'x' })), 'edit_from_app', 'an app slug in the body is an app turn too');
    assert.equal(code(() => ed(w, { edit: '../todo', message: 'x' })), 'bad_slug');
    assert.equal(code(() => ed(w, { edit: 'nope', message: 'x' })), 'no_app');
    fs.symlinkSync(path.join(w, 'apps', 'todo'), path.join(w, 'apps', 'linked'));
    assert.equal(code(() => ed(w, { edit: 'linked', message: 'x' })), 'no_app', 'a linked app folder is not edited');
    const e = ed(w, { edit: 'todo', message: 'make the title red' });
    assert.deepEqual([e.slug, e.superelf, e.undo], ['todo', false, false]);
    assert.equal(ed(w, { edit: 'todo', message: 'change superelf: bigger buttons' }).superelf, true);
    for (const m of ['undo', 'Undo that', '撤销', 'undo.']) assert.equal(ed(w, { edit: 'todo', message: m }).undo, true, m);
    assert.equal(ed(w, { edit: 'todo', message: 'undo the colour change and make it blue' }).undo, false, 'only a bare undo skips the model');
  } finally { rmTemp(w); }
});

test('an edit turn is the owner lane but its own surface: app-edit:<slug>', () => {
  const origin = { fromApp: false, edit: 'todo' };
  assert.equal(agentConfined(OWNER, origin), false, 'the owner panel runs the full agent');
  assert.equal(agentConfined(MEMBER, origin), true);
  assert.equal(convoTag(origin), 'app-edit:todo');
  assert.equal(convoReachable({ app: undefined }, origin), false, 'cannot resume a composer conversation');
  assert.equal(convoReachable({ app: 'todo' }, origin), false, "cannot resume the app's own chat");
  assert.equal(convoReachable({ app: 'app-edit:todo' }, { fromApp: false }), false, 'the composer cannot resume it');
  assert.equal(convoReachable({ app: 'app-edit:todo' }, origin), true);
  assert.match(editSystemPrompt({ slug: 'todo' }), /apps\/todo\//);
});

test('a change that passes the checks is applied and undo puts the old app back', () => {
  const w = ws();
  try {
    const e = ed(w, { edit: 'todo', message: 'x' });
    const ctx = beginAppEdit(e, { wsDir: w });
    fs.writeFileSync(path.join(w, 'apps', 'todo', 'index.html'), PAGE.replace('Hi', 'Hello'));
    const out = finishAppEdit(e, ctx, { wsDir: w });
    assert.deepEqual([out.line.changed, out.line.applied], [true, true]);
    const u = undoAppEdit(e, { wsDir: w });
    assert.equal(u.line.undone, true);
    assert.equal(fs.readFileSync(path.join(w, 'apps', 'todo', 'index.html'), 'utf8'), PAGE);
    assert.equal(undoAppEdit(e, { wsDir: w }).line.undone, undefined, 'one edit, one undo: then nothing to undo');
    assert.ok(listVersions(path.join(w, VERSIONS_DIR), 'todo').some((n) => n.endsWith('-undo')), 'what undo replaced is kept');
  } finally { rmTemp(w); }
});

test('a change that breaks the app is NOT applied: the app is rolled back and the reply says why', () => {
  const w = ws();
  try {
    const e = ed(w, { edit: 'todo', message: 'x' });
    for (const [bad, why] of [[PAGE.replace('let n=1;', 'let n=;'), /script 1 does not run/], ['', /empty/], [PAGE.replace('<h1>', '<form><h1>'), /form/]]) {
      const ctx = beginAppEdit(e, { wsDir: w });
      fs.writeFileSync(path.join(w, 'apps', 'todo', 'index.html'), bad);
      const out = finishAppEdit(e, ctx, { wsDir: w });
      assert.equal(out.line.applied, false);
      assert.match(out.line.problems.join('\n'), why);
      assert.match(out.note, /未应用/);
      assert.equal(fs.readFileSync(path.join(w, 'apps', 'todo', 'index.html'), 'utf8'), PAGE, 'rolled back');
    }
    const ctx = beginAppEdit(e, { wsDir: w });
    fs.writeFileSync(path.join(w, 'data', 'todo', 'items.json'), '[1,');
    fs.writeFileSync(path.join(w, 'apps', 'todo', 'index.html'), PAGE.replace('Hi', 'Yo'));
    assert.match(finishAppEdit(e, ctx, { wsDir: w }).line.problems.join(), /no longer reads/, 'its saved data must still read');
  } finally { rmTemp(w); }
});

test('a problem the app already had does not block a change; an unchanged turn leaves no undo step', () => {
  const w = ws();
  try {
    fs.writeFileSync(path.join(w, 'apps', 'todo', 'index.html'), PAGE.replace('let n=1;', 'let n=;'));
    const e = ed(w, { edit: 'todo', message: 'x' });
    let ctx = beginAppEdit(e, { wsDir: w });
    fs.writeFileSync(path.join(w, 'apps', 'todo', 'index.html'), PAGE.replace('let n=1;', 'let n=;').replace('Hi', 'Hey'));
    assert.equal(finishAppEdit(e, ctx, { wsDir: w }).line.applied, true);
    const before = listVersions(path.join(w, VERSIONS_DIR), 'todo').length;
    ctx = beginAppEdit(e, { wsDir: w });
    assert.equal(finishAppEdit(e, ctx, { wsDir: w }).line.changed, false);
    assert.equal(listVersions(path.join(w, VERSIONS_DIR), 'todo').length, before);
    assert.equal(beginAppEdit({ ...e, undo: true }, { wsDir: w }), null);
    assert.equal(beginAppEdit({ ...e, superelf: true }, { wsDir: w }), null);
  } finally { rmTemp(w); }
});

test('editChecks: module/json scripts are not compiled; meta.json must parse', () => {
  const w = ws();
  try {
    const d = path.join(w, 'apps', 'todo');
    fs.writeFileSync(path.join(d, 'index.html'), '<script type="application/json">{not js</script><script type="module">import x from "y"</script><p>ok</p>');
    assert.deepEqual(editChecks(d, path.join(w, 'data', 'todo')), []);
    fs.writeFileSync(path.join(d, 'meta.json'), '{');
    assert.match(editChecks(d, path.join(w, 'data', 'todo')).join(), /meta\.json/);
  } finally { rmTemp(w); }
});

test('app-versions: links are stripped, history is capped, names sort newest first', () => {
  const w = ws();
  try {
    const root = path.join(w, VERSIONS_DIR), app = path.join(w, 'apps', 'todo');
    fs.symlinkSync('/etc/hosts', path.join(app, 'peek.html'));
    const n = snapshotApp(app, root, 'todo', 'edit');
    assert.equal(fs.existsSync(path.join(root, 'todo', n, 'peek.html')), false, 'a link never travels');
    for (let i = 0; i < VERSIONS_KEPT + 3; i++) snapshotApp(app, root, 'todo', 'edit');
    const v = listVersions(root, 'todo');
    assert.equal(v.length, VERSIONS_KEPT);
    assert.deepEqual(v, [...v].sort().reverse());
    assert.throws(() => restoreVersion(app, root, 'todo', '../x'));
    assert.throws(() => listVersions(root, '../x'));
    assert.equal(typeof undoLastEdit(app, root, 'todo'), 'string');
  } finally { rmTemp(w); }
});

test('GPT review 2026-11-24: one edit per app at a time; undo waits; a data-only write is caught; linked apps/ and version folders are refused', () => {
  const w = ws();
  try {
    const e = ed(w, { edit: 'todo', message: 'x' });
    const ctx = beginAppEdit(e, { wsDir: w });
    assert.equal(code(() => beginAppEdit(e, { wsDir: w })), 'edit_busy', 'a second turn on the same app waits');
    assert.equal(undoAppEdit(e, { wsDir: w }).ok, false, 'undo cannot take the in-flight copy');
    fs.writeFileSync(path.join(w, 'data', 'todo', 'items.json'), '[1,2,3]');
    const out = finishAppEdit(e, ctx, { wsDir: w });
    assert.equal(out.line.applied, false, 'a turn that wrote only data is not a clean change');
    assert.match(out.note, /data\/todo/);
    assert.notEqual(code(() => beginAppEdit(e, { wsDir: w })), 'edit_busy', 'released after finish');
    const w2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-edit-l-'));
    fs.symlinkSync(path.join(w, 'apps'), path.join(w2, 'apps'));
    assert.equal(code(() => appEditOf({ user: OWNER, body: { edit: 'todo', message: 'x' }, headers: {}, appsDir: path.join(w2, 'apps') })), 'no_app', 'a linked apps/ is refused');
    rmTemp(w2);
    const w3 = ws(); fs.symlinkSync(os.tmpdir(), path.join(w3, VERSIONS_DIR));
    assert.throws(() => beginAppEdit(ed(w3, { edit: 'todo', message: 'x' }), { wsDir: w3 }), /linked/);
    assert.throws(() => beginAppEdit(ed(w3, { edit: 'todo', message: 'x' }), { wsDir: w3 }), /linked/, 'a refused begin does not leave the app busy');
    fs.unlinkSync(path.join(w3, VERSIONS_DIR)); rmTemp(w3);
  } finally { rmTemp(w); }
});

test('GPT review 2026-11-24: VERSIONS_KEPT edits give VERSIONS_KEPT undos; an unchanged turn costs no undo point', () => {
  const w = ws();
  try {
    const e = ed(w, { edit: 'todo', message: 'x' });
    const page = path.join(w, 'apps', 'todo', 'index.html');
    for (let i = 0; i < VERSIONS_KEPT; i++) { const c = beginAppEdit(e, { wsDir: w }); fs.writeFileSync(page, PAGE.replace('Hi', 'v' + i)); finishAppEdit(e, c, { wsDir: w }); }
    finishAppEdit(e, beginAppEdit(e, { wsDir: w }), { wsDir: w });   // no change
    let n = 0; while (undoAppEdit(e, { wsDir: w }).line.undone) n += 1;
    assert.equal(n, VERSIONS_KEPT);
    assert.equal(fs.readFileSync(page, 'utf8'), PAGE);
  } finally { rmTemp(w); }
});
