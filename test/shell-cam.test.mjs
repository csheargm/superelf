// PAShellCam (web/shell-cam.js), the main chat's camera, over the REAL PAShotFresh (web/snap.inline.html) and the
// real shell composition (lib/shellhtml.mjs): one shared engine, at most 3 of our shots, a failure attaches nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));   // a URL pathname is /D:/… on Windows
const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const fresh = /\/\* ══ PA_SHOT_FRESH_BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* ══ PA_SHOT_FRESH_END/.exec(read('web/snap.inline.html'))[1];
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function load({ shot = async () => PNG, upload = async (b) => ({ ok: true, path: 'uploads/' + b.name }) } = {}) {
  const ctx = { PASnap: { shot, CAM_SVG: '<svg></svg>' } };
  vm.runInNewContext(fresh + ';' + read('web/shell-cam.js') + ';this.C=PAShellCam;this.F=PAShotFresh;', ctx);
  let atts = []; const said = []; let renders = 0;
  const h = { atts: () => atts, render: () => renders++, say: (t) => said.push(t), upload };
  return { C: ctx.C, F: ctx.F, h, get atts() { return atts; }, said, renders: () => renders,
    send: () => { atts = []; }, switchTo: () => ctx.C.cancel() };
}

test('a tap uploads the drawn PNG and attaches it with its time label', async () => {
  const sent = []; const L = load({ upload: async (b) => { sent.push(b); return { ok: true, path: 'uploads/' + b.name }; } });
  const { C, h } = L; await C.take(h); const atts = L.atts;
  assert.equal(atts.length, 1);
  assert.equal(sent[0].data, 'iVBORw0KGgo=', 'the base64 body of the picture, not the data: prefix');
  assert.match(atts[0].name, /^screen-home-\d+-\d+\.png$/);
  assert.equal(atts[0].thumb, PNG); assert.match(atts[0].label, /^\d\d:\d\d:\d\d$/); assert.equal(atts[0].shot, true);
});
test('the 4th shot drops the oldest of ours; the user\'s own photo stays', async () => {
  const L = load(), { C, h } = L, atts = L.atts;
  atts.push({ name: 'mine.jpg', path: 'uploads/mine.jpg' });
  for (let i = 0; i < 4; i++) await C.take(h);
  assert.equal(atts.filter((a) => a.shot).length, 3);
  assert.equal(atts[0].path, 'uploads/mine.jpg');
});
test('a send or a chat switch during the capture: the picture never lands in the next draft or another chat', async () => {
  let go; const L = load({ upload: (b) => new Promise((r) => { go = () => r({ ok: true, path: 'uploads/' + b.name }); }) });
  let p = L.C.take(L.h); await new Promise((r) => setImmediate(r)); L.send(); go(); await p;
  assert.equal(L.atts.length, 0, 'sent meanwhile: the new draft stays empty');
  p = L.C.take(L.h); await new Promise((r) => setImmediate(r)); L.switchTo(); L.switchTo(); go(); await p;
  assert.equal(L.atts.length, 0, 'another chat opened meanwhile, even A → B → A (same draft array)');
});
test('the label is the time the picture was taken, not when the upload finished', async () => {
  let go; const L = load({ upload: (b) => new Promise((r) => { go = () => r({ ok: true, path: 'uploads/' + b.name }); }) });
  const t0 = Date.now(); const p = L.C.take(L.h); await new Promise((r) => setTimeout(r, 1100)); go(); await p;
  assert.equal(L.atts[0].label, L.F.label(Number(/screen-home-(\d+)-/.exec(L.atts[0].name)[1])));
  assert.ok(Number(/screen-home-(\d+)-/.exec(L.atts[0].name)[1]) - t0 < 500);
});
test('fails closed: an undrawable screen or a failed upload says so and attaches nothing', async () => {
  const a = load({ shot: async () => { throw new Error('tainted'); } });
  await a.C.take(a.h); assert.equal(a.atts.length, 0); assert.equal(a.said[0], a.C.T.fail);
  const b = load({ upload: async () => ({ ok: false, error: 'too big' }) });
  await b.C.take(b.h); assert.equal(b.atts.length, 0); assert.match(b.said[0], /could not be uploaded — too big/);
});
test('the chip escapes what it shows and its × removes by index', () => {
  const { C } = load(), esc = (s) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const html = C.chipHtml({ thumb: 'data:x"><b>', label: '09:00:00' }, 2, esc);
  assert.ok(!html.includes('"><b>')); assert.match(html, /removeChip\(2\)/); assert.match(html, /09:00:00/);
});
test('one engine (R3): the shell carries PASnap + PAShotFresh from snap.inline.html, and the icon has one copy', () => {
  const shell = readShell(ROOT);
  assert.ok(shell.includes('var PASnap = PASnap ||') && shell.includes('var PAShellCam='));
  assert.ok(shell.indexOf('var PASnap = PASnap ||') < shell.indexOf('<script id="pat-script">'), 'PASnap is defined before DOMContentLoaded, where the camera reads it');
  assert.match(shell, /<button class="ibtn" id="cam"/);
  assert.equal((read('web/app-edit-panel.html') + read('web/shell-cam.js')).includes('M4 8h3l2-2.5h6L17 8h3v11H4z'), false, 'the camera icon lives only in snap.inline.html');
  assert.ok(read('web/app-edit-panel.html').includes('svg:PASnap.CAM_SVG'));
  assert.ok(shell.indexOf('var PASnapNoAnswer=true') < shell.indexOf('var PASnap = PASnap ||'), 'the shell never answers a snap request, even framed');
  assert.match(shell, /function setConvo\(id\)\{ convoId=id; if\(window\.PAShellCam\) PAShellCam\.cancel\(\);/, 'every chat switch cancels a capture in flight');
  assert.match(read('web/snap.inline.html'), /typeof PASnapNoAnswer==='undefined'\) addEventListener\('message'/);
});
