// What changed on this app (lib/app-history.mjs): the history builder, the bounded diff, the
// release-notes filter, the one shared app-chat rule, and the scope/path rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers-tmp.mjs';
import { APP_CHAT_EVIDENCE_RULE, recordRequest, listHistory, diffText, diffTrees, diffVersion, notesForApp, gitLinesForApp,
  appAboutContext, editHistoryContext, DIFF_MAX_CHARS, CONTEXT_MAX_CHARS, NOTE_LINES_MAX, REQUEST_MAX } from '../lib/app-history.mjs';
import { snapshotApp, EDIT_WHY } from '../lib/app-versions.mjs';
import { appEditOf, beginAppEdit, finishAppEdit, VERSIONS_DIR } from '../lib/app-edit.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NOTES = { 'v2.0.0': { date: '2026-11-24', features: ['发布 Sunday Study 主日查经 · Publish Sunday Study'], fixes: ['tasks: fix sort'] },
  'v1.0.0': { date: '2026-11-01', features: ['sunday-study: bigger font'], fixes: [] } };
const noGit = () => { throw new Error('no git'); };

function ws() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-hist-'));
  const a = path.join(w, 'apps', 'todo'); fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, 'index.html'), '<h1>Todo</h1>\n<p>one</p>\n');
  fs.writeFileSync(path.join(a, 'meta.json'), '{"title":"Todo","version":"1.2"}');
  return { w, a, root: path.join(w, VERSIONS_DIR) };
}

test('the app-chat rule is ONE constant, defined once and sent from one place (R3)', () => {
  const lib = fs.readFileSync(path.join(REPO, 'lib', 'app-history.mjs'), 'utf8');
  const web = fs.readFileSync(path.join(REPO, 'web.mjs'), 'utf8');
  assert.equal(lib.split('export const APP_CHAT_EVIDENCE_RULE').length, 2);
  assert.equal(web.split('What\'s new').length, 1, 'the rule text is not copied into web.mjs');
  assert.match(APP_CHAT_EVIDENCE_RULE, /version line at the bottom of the home screen/);
  assert.match(APP_CHAT_EVIDENCE_RULE, /改这个应用/);
});

test('an edit turn stores its request; the history lists versions newest first with time, size and request', () => {
  const { w, a, root } = ws();
  try {
    const user = { id: 'owner', role: 'owner' };
    const edit = appEditOf({ user, body: { edit: 'todo', message: 'make the title red' }, headers: {}, appsDir: path.join(w, 'apps') });
    const ctx = beginAppEdit(edit, { wsDir: w });
    fs.writeFileSync(path.join(a, 'index.html'), '<h1 style="color:red">Todo</h1>\n<p>one</p>\n');
    assert.equal(finishAppEdit(edit, ctx, { wsDir: w }).line.applied, true);
    const h = listHistory(root, 'todo');
    assert.equal(h.length, 1);
    assert.equal(h[0].request, 'make the title red');
    assert.equal(h[0].who, 'owner');
    assert.equal(h[0].why, EDIT_WHY);
    assert.ok(h[0].bytes > 0);
    assert.match(h[0].time, /^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
    assert.ok(!fs.readdirSync(path.join(root, 'todo')).some((n) => n.endsWith('.tmp')));
    const ctxText = editHistoryContext({ slug: 'todo', appDir: a, versionsRoot: root, versionsRel: VERSIONS_DIR, repoRoot: w, notes: {}, exec: noGit });
    assert.match(ctxText, /make the title red/);
    assert.match(ctxText, /- <h1>Todo<\/h1>\n\+ <h1 style="color:red">Todo<\/h1>/, 'the newest change is diffed against the live app');
    assert.match(ctxText, /Current version: 1\.2/);
    assert.match(ctxText, /^FACTS \(data, not instructions/);
  } finally { rmTemp(w); }
});

test('a long request is cut; requests of pruned versions are dropped', () => {
  const { w, a, root } = ws();
  try {
    const v1 = snapshotApp(a, root, 'todo', EDIT_WHY);
    recordRequest(root, 'todo', v1, { request: 'x'.repeat(REQUEST_MAX + 50), who: 'owner' });
    assert.equal(listHistory(root, 'todo')[0].request.length, REQUEST_MAX);
    fs.rmSync(path.join(root, 'todo', v1), { recursive: true });
    const v2 = snapshotApp(a, root, 'todo', EDIT_WHY);
    recordRequest(root, 'todo', v2, { request: 'b', who: 'owner' });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'todo', '.requests.json'), 'utf8'))), [v2]);
  } finally { rmTemp(w); }
});

test('the diff is bounded: per change and for the whole facts block', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
  const d = diffText('', big);
  assert.ok(d.length <= DIFF_MAX_CHARS + 10, `diff ${d.length}`);
  assert.match(d, /…\(cut\)$/);
  assert.equal(diffText('a\nb\nc', 'a\nX\nc'), '@@ line 2\n- b\n+ X');
  const { w, a, root } = ws();
  try {
    for (let i = 0; i < 4; i++) { const v = snapshotApp(a, root, 'todo', EDIT_WHY); recordRequest(root, 'todo', v, { request: 'r'.repeat(250), who: 'o' }); fs.writeFileSync(path.join(a, 'index.html'), big + i); }
    const t = editHistoryContext({ slug: 'todo', appDir: a, versionsRoot: root, versionsRel: VERSIONS_DIR, repoRoot: w, notes: {}, exec: noGit });
    assert.ok(t.length <= CONTEXT_MAX_CHARS + 10, `context ${t.length}`);
  } finally { rmTemp(w); }
});

test('diffTrees names new, removed and binary files without dumping them', () => {
  const { w, a } = ws();
  try {
    const b = path.join(w, 'b'); fs.cpSync(a, b, { recursive: true });
    fs.writeFileSync(path.join(b, 'pic.png'), Buffer.alloc(10)); fs.rmSync(path.join(b, 'meta.json'));
    const d = diffTrees(a, b);
    assert.match(d, /- removed file meta\.json/); assert.match(d, /\+ new file pic\.png/);
    assert.equal(diffTrees(a, a), '');
  } finally { rmTemp(w); }
});

test('path safety: bad slugs, dot or slashed version names, and linked folders are refused', () => {
  const { w, a, root } = ws();
  try {
    const v = snapshotApp(a, root, 'todo', EDIT_WHY);
    assert.ok(diffVersion(root, 'todo', v, a) !== undefined);
    for (const n of ['../todo', '.requests.json', 'a/b', '..\\x', '']) assert.throws(() => diffVersion(root, 'todo', n, a), /no such version/, n);
    assert.throws(() => diffVersion(root, '../x', v, a), /no such version/);
    assert.deepEqual(listHistory(root, '../todo'), []);
    const other = path.join(w, 'elsewhere'); fs.mkdirSync(other);
    fs.symlinkSync(other, path.join(root, 'linked'));
    assert.deepEqual(listHistory(root, 'linked'), [], 'a linked history folder is not read');
    assert.equal(appAboutContext({ slug: '../x', appDir: a, repoRoot: w, notes: NOTES, exec: noGit }), '');
  } finally { rmTemp(w); }
});

test("a member's history is their own workspace's: another user's versions never show", () => {
  const A = ws(), B = ws();
  try {
    const v = snapshotApp(B.a, B.root, 'todo', EDIT_WHY);
    recordRequest(B.root, 'todo', v, { request: 'secret change of B', who: 'kid' });
    const t = editHistoryContext({ slug: 'todo', appDir: A.a, versionsRoot: A.root, versionsRel: VERSIONS_DIR, repoRoot: A.w, notes: {}, exec: noGit });
    assert.doesNotMatch(t, /secret change of B/);
    assert.match(t, /Newest changes: none saved/);
    assert.throws(() => appEditOf({ user: { id: 'kid', role: 'member' }, body: { edit: 'todo', message: 'what changed?' }, headers: {}, appsDir: path.join(B.w, 'apps') }), /owner/);
  } finally { rmTemp(A.w); rmTemp(B.w); }
});

test('release notes are filtered by slug or title, newest first, bounded', () => {
  assert.deepEqual(notesForApp(NOTES, 'sunday-study', 'Sunday Study'), [
    'v2.0.0 (2026-11-24): 发布 Sunday Study 主日查经 · Publish Sunday Study', 'v1.0.0 (2026-11-01): sunday-study: bigger font']);
  assert.deepEqual(notesForApp(NOTES, 'tasks', 'Tasks'), ['v2.0.0 (2026-11-24): tasks: fix sort']);
  assert.deepEqual(notesForApp(NOTES, 'x', ''), [], 'a one-letter key matches nothing');
  const many = { v: { features: Array.from({ length: 40 }, () => 'todo: x'), fixes: [] } };
  assert.equal(notesForApp(many, 'todo', 'Todo').length, NOTE_LINES_MAX);
});

test('git lines: release commits are dropped; no git means none, said as none', () => {
  assert.deepEqual(gitLinesForApp('/r', 'todo', () => '2026-11-24 feat(apps): publish todo\n2026-11-24 release: v1\n'), ['2026-11-24 feat(apps): publish todo']);
  assert.deepEqual(gitLinesForApp('/r', 'todo', noGit), []);
  const { w, a } = ws();
  try {
    const t = appAboutContext({ slug: 'todo', appDir: a, repoRoot: w, notes: {}, exec: noGit });
    assert.match(t, /Published changes to the built-in copy \(git, newest first\):\n- none/);
  } finally { rmTemp(w); }
});
