// App faces（应用面孔）— live information on a home tile, end to end.
//
// THE CONSTRAINT THAT DECIDED THE DESIGN: the shelf is rendered by the SHELL, and an app is a
// sandboxed iframe at an opaque origin that is NOT running while the shelf is on screen. So a
// face can never be read out of an app. It is data the app DECLARES (meta.json "face".label,
// which is also the switch) and WRITES (data/<slug>/face.json {value, ts}), and the shell reads
// on its way past — one small file per app, no model call, no network, no app code running.
//
// The three things this guards, because each one is a way the feature could ship broken:
//   1. the read is CHEAP and REFUSES what is not cheap (size cap, no parse above it);
//   2. every failure mode DEGRADES to today's plain tile and nothing else (R5) — no face, no
//      declaration, damaged JSON, an oversized file, another member's app;
//   3. a stale face can never look live: the shell always receives a timestamp and always
//      renders an age past the freshness window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';
import { APP_DATA_DIR } from '../lib/appdata.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');   // throws if moved (R14)

// ── the server half: readFace, extracted from web.mjs and run for real ─────────────────────
// Extracted rather than re-implemented: a copy of the rule here would pass while the shipped
// one broke, which is the whole failure mode this repo keeps writing tests about.
function extractFn(src, name, deps = {}) {
  const m = src.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} must stay a named top-level function — the harness runs it headless`);
  const keys = Object.keys(deps);
  return new Function(...keys, `${m[0]}\nreturn ${name};`)(...keys.map((k) => deps[k]));
}
const CAPS = WEB.match(/const FACE_MAX_BYTES = (\d+);[\s\S]*?const FACE_TEXT_MAX = (\d+);/);
assert.ok(CAPS, 'FACE_MAX_BYTES / FACE_TEXT_MAX must stay named constants in web.mjs');
const FACE_MAX_BYTES = Number(CAPS[1]);
const FACE_TEXT_MAX = Number(CAPS[2]);
const readFace = extractFn(WEB, 'readFace', {
  fs, path, APP_DATA_DIR,
  wsDir: (u) => u.workspace,
  FACE_MAX_BYTES, FACE_TEXT_MAX,
});

function tmpUser(slug, faceFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-face-'));
  if (faceFile !== undefined) {
    fs.mkdirSync(path.join(dir, 'data', slug), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', slug, 'face.json'), faceFile);
  }
  return { workspace: dir };
}
const LABEL = { label: 'open' };

test('a declared face with a written value reaches the shelf', () => {
  const u = tmpUser('tasks', JSON.stringify({ value: '3', ts: 1757000000000 }));
  assert.deepEqual(readFace(u, 'tasks', { face: LABEL }), { label: 'open', value: '3', ts: 1757000000000 });
});

test('the declaration is the switch — a file with no meta.json face renders nothing', () => {
  // Otherwise a leftover face.json from a deleted feature would keep publishing a number that
  // nothing is updating any more.
  const u = tmpUser('tasks', JSON.stringify({ value: '3' }));
  assert.equal(readFace(u, 'tasks', {}), null, 'absent declaration');
  assert.equal(readFace(u, 'tasks', { face: false }), null, '"deliberately no face"');
  assert.equal(readFace(u, 'tasks', { face: { label: '  ' } }), null, 'a blank label declares nothing');
  assert.equal(readFace(u, 'tasks', { face: 'open' }), null, 'a bare string is not the declared shape');
});

test('every unusable face degrades to the plain tile, never to an error', () => {
  for (const [what, file] of [
    ['no file at all', undefined],
    ['not JSON', 'not json at all'],
    ['JSON but not an object', '"3"'],
    ['an array', '[1,2,3]'],
    ['no value', JSON.stringify({ ts: 1 })],
    ['a blank value', JSON.stringify({ value: '   ' })],
    ['a null value', JSON.stringify({ value: null })],
  ]) {
    const u = tmpUser('tasks', file);
    assert.equal(readFace(u, 'tasks', { face: LABEL }), null, `${what}: must read as no face`);
  }
});

test('an oversized face is refused without being parsed — the shelf stays cheap', () => {
  // The cap is the whole "cheap or nothing" rule. Without it an app could put a megabyte behind
  // the home screen and every home view would pay for it.
  const big = JSON.stringify({ value: '3', pad: 'x'.repeat(FACE_MAX_BYTES) });
  assert.ok(big.length > FACE_MAX_BYTES);
  assert.equal(readFace(tmpUser('tasks', big), 'tasks', { face: LABEL }), null);
  // …and one just inside the cap still works, so the guard is a cap and not an off switch (R14).
  const ok = JSON.stringify({ value: '3', pad: 'x'.repeat(FACE_MAX_BYTES - 40) });
  assert.ok(ok.length < FACE_MAX_BYTES);
  assert.equal(readFace(tmpUser('tasks', ok), 'tasks', { face: LABEL }).value, '3');
});

test('a face always carries a timestamp, even when the app did not send one', () => {
  // The shell renders the age from this. An app that omits ts must not therefore look
  // permanently fresh — the file's own mtime is the fallback and it is never absent.
  const u = tmpUser('tasks', JSON.stringify({ value: '7' }));
  const f = readFace(u, 'tasks', { face: LABEL });
  assert.equal(f.value, '7');
  assert.ok(Number.isFinite(f.ts) && f.ts > 0, 'mtime fallback');
  const skewed = readFace(tmpUser('tasks', JSON.stringify({ value: '7', ts: 'yesterday' })), 'tasks', { face: LABEL });
  assert.ok(Number.isFinite(skewed.ts), 'a non-numeric ts falls back too, rather than reaching the shell');
});

test('label and value are clamped — a tile cannot be turned into a paragraph', () => {
  const u = tmpUser('tasks', JSON.stringify({ value: 'v'.repeat(200) }));
  const f = readFace(u, 'tasks', { face: { label: 'l'.repeat(200) } });
  assert.equal(f.value.length, FACE_TEXT_MAX);
  assert.equal(f.label.length, FACE_TEXT_MAX);
});

test('only the owner of an app gets its face — sharing an app never shares the readings', () => {
  // listApps (own apps) calls readFace; listFamilyApps and listShared must not, or a member's
  // numbers would be published onto another member's home screen.
  const own = WEB.match(/function listApps\(u\)[\s\S]*?\n\}/)[0];
  assert.match(own, /readFace\(u,/, 'own apps carry their face');
  for (const name of ['listFamilyApps', 'listShared']) {
    const m = WEB.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    if (!m) continue;                       // listShared lives in lib/sharedapps.mjs
    assert.doesNotMatch(m[0], /readFace/, `${name} must not expose another account's face`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'lib/sharedapps.mjs'), 'utf8'), /readFace|face\.json/);
});

// ── the shell half: faceAge / faceHtml, extracted from the shell as served ────────────────
function extractShellFn(name, deps = {}) {
  const m = SHELL.match(new RegExp(`\\nfunction ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} must stay a named top-level function in web/index.html`);
  const keys = Object.keys(deps);
  return new Function(...keys, `${m[0]}\nreturn ${name};`)(...keys.map((k) => deps[k]));
}
const FRESH = Number(SHELL.match(/const FACE_FRESH_MS=(\d+);/)[1]);
const faceAge = extractShellFn('faceAge', { FACE_FRESH_MS: FRESH });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const faceHtml = extractShellFn('faceHtml', { esc, faceAge, FACE_FRESH_MS: FRESH });

test('a fresh face shows no age; a stale one always does', () => {
  const now = 1_757_000_000_000;
  assert.equal(faceAge(now - 60_000, now), '', 'a minute old reads as now');
  assert.equal(faceAge(now - (FRESH - 1), now), '', 'just inside the window');
  assert.equal(faceAge(now - FRESH, now), '1h', 'the moment it leaves the window it says so');
  assert.equal(faceAge(now - 5 * FRESH, now), '5h');
  assert.equal(faceAge(now - 25 * FRESH, now), '1d');
  assert.equal(faceAge(now - 50 * FRESH, now), '2d');
  assert.equal(faceAge(now + FRESH, now), '', 'a future timestamp says nothing, never "-1h"');
  assert.equal(faceAge(undefined, now), '', 'a missing timestamp says nothing');
});

test('faceHtml renders the value and escapes it; no face renders nothing', () => {
  assert.equal(faceHtml({}), '', 'no face → empty, so the caller falls back to the description');
  assert.equal(faceHtml({ face: { value: '', label: 'open' } }), '');
  const h = faceHtml({ face: { value: '3', label: 'open', ts: Date.now() } });
  assert.match(h, /<b>3<\/b> open/);
  assert.doesNotMatch(h, /<i>/, 'a fresh face carries no age');
  const stale = faceHtml({ face: { value: '3', label: 'open', ts: Date.now() - 3 * FRESH } });
  assert.match(stale, /<i>· 3h<\/i>/);
  // The value is app-supplied and lands in innerHTML on the home screen.
  const evil = faceHtml({ face: { value: '<img src=x onerror=1>', label: '<b>x', ts: Date.now() } });
  assert.doesNotMatch(evil, /<img/);
  assert.doesNotMatch(evil, /<b>x/);
});

test('the tile falls back to the description when there is no face', () => {
  // The one line of the shelf that has to get this right: face OR description, never neither.
  const card = SHELL.match(/const card=\(uid,a,badge\)=>[^\n]*/)[0];
  assert.match(card, /\$\{faceHtml\(a\)\|\|`<small>\$\{esc\(a\.desc\|\|a\.name\)\}<\/small>`\}/,
    'the plain tile must remain the fallback, so a missing face is invisible rather than blank');
});

// ── the wired app: tasks, end to end ──────────────────────────────────────────────────────
test('tasks declares a face and writes it through the ordinary save-data path', () => {
  const dir = path.join(ROOT, 'workspace.example/apps/tasks');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.deepEqual(meta.face, { label: 'open' }, 'the declaration ships with the app');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /kind:'save-data',path,data/, 'writes through save-data — no new API for a face');
  assert.match(html, /paSaveData\('face\.json',\{value:String\(openCount\(\)\),ts:Date\.now\(\)\}\)/);
  // Written on BOTH edges: a face refreshed only on save goes stale as soon as tasks.md is
  // edited by the assistant or by hand, which is most of the time for this file.
  assert.ok(html.match(/writeFace\(\)/g).length >= 3, 'declared once, called on save AND on load');
  // The count itself, run for real against the app's own filter.
  const openCount = new Function('lines', `${html.match(/function openCount\(\)\{[^\n]*\n/)[0]}\nreturn openCount();`);
  assert.equal(openCount([{ kind: 'task', done: false }, { kind: 'task', done: true },
    { kind: 'heading' }, { kind: 'task', done: false }]), 2);
  assert.equal(openCount([]), 0, 'an empty list is a real answer, not a missing face');
});
