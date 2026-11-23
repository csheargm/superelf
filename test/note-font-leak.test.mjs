// The typed text layer is sized from the PAGE, never from the device · 文字层只从页面取尺寸
//
// docs/plans/annotation-anchoring.md §4.1. The page is laid out at 816 units and scaled to fit
// the device, so typed text and ink agree everywhere — unless a unit sneaks in that is measured
// from the device instead: `rem` (the host root, 17px × the A-/A+ `--fs`), `vw`/`vh`, or
// `var(--fs)` itself. The sanitizer used to ACCEPT `rem` and `%` on font-size, so one pasted
// paragraph wrapped differently under the same ink on two iPads. Two invariants pin it now:
//   1. no device unit inside any `.pan-textlayer` CSS rule;
//   2. no `rem` / `%` font-size survives the sanitizer — `rem` becomes `em` 1:1, `%` is dropped —
//      and every stored page passes through the sanitizer again on load, so old notes are covered.
// Plus the owner's device readout (§4 ii): one line in the page-settings sheet, format pinned here
// from fake metrics.
// R11 — searched: "SAFE_FSIZE", "FSIZE_REM", "DEV_READOUT", "pan-devro" — all owned by
//   web/note-ui.inline.html; this file only consumes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');

// The same DOM-free slice test/note-paste.test.mjs runs (R3: one extraction boundary).
function coreFrom(engineSrc) {
  const from = engineSrc.indexOf('  const SCHEMA=');
  const to = engineSrc.indexOf('\n  function Note(host, opts){');
  assert.ok(from > 0 && to > from, 'the engine core must stay a DOM-free block above function Note()');
  // eslint-disable-next-line no-new-func
  return new Function(`${engineSrc.slice(from, to)}
    return {STYLE_OK,cleanStyle,bindFontSize,DEV_READOUT,PAGE_W};`)();
}
const G = coreFrom(ENGINE);

// A fake element: only what cleanStyle touches (style.getPropertyValue / setProperty).
const fakeEl = (styles = {}) => {
  const set = {};
  return { set, style: { getPropertyValue: (p) => styles[p] || '', setProperty: (p, v) => { set[p] = v; } } };
};
const cleaned = (fontSize) => { const dst = fakeEl(); G.cleanStyle(dst, fakeEl({ 'font-size': fontSize })); return dst.set['font-size']; };

// ── 1. The text layer's own CSS carries no device unit ───────────────────────────────────────
test('no rem, vw/vh or var(--fs) inside any .pan-textlayer CSS rule', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(ENGINE);
  assert.ok(css, 'the component ships its CSS in one <style> block');
  const rules = css[1].replace(/\/\*[\s\S]*?\*\//g, '').split('}').filter((r) => r.includes('.pan-textlayer'));
  assert.ok(rules.length >= 5, `the text layer rules must be findable (found ${rules.length})`);
  for (const r of rules) {
    assert.doesNotMatch(r, /\d(\.\d+)?rem\b/, `rem is a device unit: ${r.trim().slice(0, 60)}`);
    assert.doesNotMatch(r, /\d(\.\d+)?v(w|h|min|max)\b/, `viewport units are device units: ${r.trim().slice(0, 60)}`);
    assert.doesNotMatch(r, /var\(--fs/, `the A-/A+ scale must not reach the page: ${r.trim().slice(0, 60)}`);
  }
});

// ── 2. The sanitizer binds every font-size to the page ────────────────────────────────────────
test('SAFE_FSIZE accepts px/pt/em only', () => {
  const ok = G.STYLE_OK['font-size'];
  for (const v of ['18px', '12pt', '1.2em', '0.9em']) assert.ok(ok.test(v), `${v} is a page unit`);
  for (const v of ['1.2rem', '120%', '2vw', '3vh', 'larger', 'calc(1em + 2px)']) assert.ok(!ok.test(v), `${v} must be refused`);
});

test('a pasted font-size:1.2rem becomes 1.2em; a % is dropped; px passes untouched', () => {
  assert.equal(G.bindFontSize('1.2rem'), '1.2em');
  assert.equal(G.bindFontSize('2REM'), '2em', 'case-insensitive, as the sanitizer reads it');
  assert.equal(G.bindFontSize('18px'), '18px');
  assert.equal(cleaned('1.2rem'), '1.2em', 'the ratio survives, bound to the page 18px');
  assert.equal(cleaned(' 1.5rem '), '1.5em', 'trimmed first, as every other value is');
  assert.equal(cleaned('120%'), undefined, 'a % inherits — nothing is set');
  assert.equal(cleaned('18px'), '18px');
  assert.equal(cleaned('1.2em'), '1.2em');
});

test('control: the rem conversion is what the test measures (mutation re-admits rem)', () => {
  const M = coreFrom(ENGINE.replace('(px|pt|em)$/i', '(px|pt|em|rem)$/i').replace("v=bindFontSize(v)", 'v=v'));
  const dst = fakeEl(); M.cleanStyle(dst, fakeEl({ 'font-size': '1.2rem' }));
  assert.equal(dst.set['font-size'], '1.2rem', 'without the fix, rem passes through — so the test above is load-bearing');
});

test('the conversion is on the one path every kept element takes, and old pages re-enter it on load', () => {
  assert.match(ENGINE, /if\(prop==='font-size'\) v=bindFontSize\(v\);/, 'cleanStyle binds font-size before the allow-list check');
  assert.match(ENGINE, /function pageTextHtml\(p\)\{[^\n]*\n\s*if\(typeof p\.pageHtml==='string'\) return sanitizeHtml\(p\.pageHtml\);/,
    'a stored pageHtml is re-sanitised on load, so notes saved with rem are converted too');
});

// ── 3. The device readout ─────────────────────────────────────────────────────────────────────
test('the readout line from fake metrics', () => {
  assert.equal(G.PAGE_W, 816);
  assert.equal(G.DEV_READOUT({ w: 1180, h: 820, k: 0.8, textW: 652.8 }),
    'Device 设备: 1180×820 px · scale k=0.8 · text 653px · page 816');
  assert.equal(G.DEV_READOUT({ w: 834, h: 1194, k: 1.02205882, textW: 834 }),
    'Device 设备: 834×1194 px · scale k=1.022 · text 834px · page 816', 'k to 3 decimals, width to whole px');
});

test('the readout lives in the existing page-settings sheet and refreshes when it opens', () => {
  const sheet = /<div class="pan-pop pan-paperpop">'\+([\s\S]*?)'<div class="pan-customlbl">模板 · Template/.exec(ENGINE);
  assert.ok(sheet, 'the page settings sheet must be findable');
  assert.match(sheet[1], /pan-pgtext/, 'the Transcript row is in the same sheet');
  assert.match(sheet[1], /<div class="pan-devro"><\/div>/, 'the readout slot sits in that sheet — no new button');
  assert.match(ENGINE, /paperBtn\.addEventListener\('click',\(\)=>\{ togglePop\(paperPop,paperBtn\); syncDevReadout\(\); \}\);/,
    'opening the sheet refreshes the line');
  assert.match(ENGINE, /el\.textContent=DEV_READOUT\(\{w:window\.innerWidth,h:window\.innerHeight,k:parseFloat\(pageInner\.style\.zoom\)\|\|1,textW:textLayer\.getBoundingClientRect\(\)\.width\}\)/,
    'measured from the live page: the zoom the page was fitted with, the text layer as drawn');
});
