// iPhone shell fixes — release-notes sheet (nested native <dialog>) and the
// chat boot-yank scroll gate. Inline shell script is not importable (guard
// style of test/briefings-ui.test.mjs; syntax gated by app-scripts.test.mjs):
// pure builders are extracted and RUN, wiring is asserted in the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readShell(ROOT); // throws if moved — never a vacuous pass (R14)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function extractVerBuilders() {
  const block = html.match(/function verBlock\(v,n,cur\)\{[\s\S]*?\n\}/);
  const sheet = html.match(/function verSheetHtml\(vers,notes,cur\)\{[\s\S]*?\n\}/);
  const recent = html.match(/const RECENT_VERSIONS=(\d+);/);
  const badge = html.match(/^const verBadge=\(t\)=>.*$/m);
  assert.ok(block && sheet && recent && badge, 'verBlock/verSheetHtml/verBadge must stay named top-level pure functions');
  const vt = fs.readFileSync(path.join(ROOT, 'web', 'version-time.js'), 'utf8');   // verBlock formats n.time with it
  const make = new Function('esc', `${vt}\nconst RECENT_VERSIONS=${recent[1]}; ${badge[0]}; ${block[0]}; ${sheet[0]}; return { verSheetHtml, RECENT_VERSIONS };`);
  return make(esc);
}

test('release notes: native nested <dialog> + showModal, Esc/backdrop close, sticky header, wrap-safe width', () => {
  const sheet = html.slice(html.indexOf('function showVerNotes'));
  assert.match(sheet, /document\.createElement\('dialog'\)/, 'a <dialog>, not a hand-rolled overlay div');
  assert.match(sheet, /dlg\.showModal\(\)/, 'showModal → top layer above the open profile dialog');
  assert.match(sheet, /width:min\(100vw - 24px,480px\);max-width:none;box-sizing:border-box/, 'viewport-fitting width');
  assert.match(sheet, /overflow-wrap:anywhere/, 'long note lines wrap — no horizontal scroll on iPhone');
  assert.match(sheet, /position:sticky;top:0/, 'header (with the ✕) stays visible while notes scroll');
  assert.match(sheet, /overflow-y:auto/, 'internal scroll');
  assert.match(sheet, /e\.target===dlg/, 'backdrop-click close (clicks on ::backdrop target the dialog itself)');
  assert.match(sheet, /addEventListener\('close',\(\)=>dlg\.remove\(\)\)/, 'one teardown path — Esc (cancel→close) included');
  // The old hand-rolled sheet is gone.
  assert.ok(!sheet.includes("style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55)"), 'no z-index overlay left');
});

test('release notes: latest 3 versions expanded, the rest behind "更早版本 · Show earlier"', () => {
  const { verSheetHtml, RECENT_VERSIONS } = extractVerBuilders();
  assert.equal(RECENT_VERSIONS, 3);
  const notes = {}; const vers = [];
  for (let i = 9; i >= 5; i--) { vers.push(`v2.4.${i}`); notes[`v2.4.${i}`] = { date: '2026-09-0' + (i - 4), features: [`f${i}`], fixes: [] }; }
  const out = verSheetHtml(vers, notes, 'v2.4.9');
  const earlier = out.slice(out.indexOf('_ver_earlier'));
  for (const v of ['v2.4.9', 'v2.4.8', 'v2.4.7']) assert.ok(out.indexOf(v) < out.indexOf('_ver_more'), `${v} expanded above the toggle`);
  assert.match(out, /更早版本 · Show earlier/);
  assert.match(out, /id="_ver_earlier" style="display:none"/, 'older versions collapsed');
  for (const v of ['v2.4.6', 'v2.4.5']) assert.ok(earlier.includes(v), `${v} inside the collapsed block`);
  // 3 or fewer versions → no toggle at all; none → the bilingual empty state.
  assert.ok(!verSheetHtml(['v1'], { v1: { date: '', features: [], fixes: [] } }, 'v1').includes('_ver_more'));
  assert.match(verSheetHtml([], {}, undefined), /暂无版本记录/);
});

test('chat boot-yank: attachment-image loads re-pin ONLY when already near-bottom (the ↓-button threshold)', () => {
  assert.ok(!/im\.onload=\(\)=>im\.scrollIntoView/.test(html), 'the unconditional scrollIntoView (mid-scroll yank on boot) is gone');
  assert.match(html, /im\.onload=\(\)=>\{ if\(logNearBottom\(\)\) logEl\.scrollTop=logEl\.scrollHeight; \}/, 'gated re-pin');
  assert.match(html, /const NEAR_BOTTOM_PX=120;/, 'one named threshold');
  assert.match(html, /function logNearBottom\(\)\{ return logEl\.scrollHeight-logEl\.scrollTop-logEl\.clientHeight<=NEAR_BOTTOM_PX; \}/);
  assert.match(html, /scrollBtn\.classList\.toggle\('show', !logNearBottom\(\)\)/, 'the ↓ button reuses the SAME predicate (R3)');
});
