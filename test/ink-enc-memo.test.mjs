// The enclosure memo is keyed by the font too (PAInkFrame.followEnclosures, web/ink-frame.inline.html).
// GPT review 2026-11-25: it was keyed by the stored widths only, so a font-size change on an open chapter
// reused the measurement (or failure) taken on the old font. Runs the shipped engine in a bare VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers-app.mjs';

const src = fs.readFileSync(path.join(ROOT, 'web/ink-frame.inline.html'), 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
const win = {}; vm.runInNewContext(src, { window: win, Math, Object, Map, WeakMap });
const F = win.PAInkFrame;

test('a font change re-measures the enclosure; the same font reuses it', () => {
  const p = []; for (let i = 0; i <= 20; i++) { const a = i / 20 * 2 * Math.PI; p.push([100 + 80 * Math.cos(a), 50 + 30 * Math.sin(a)]); }
  const g = { verse: 4, lang: 'zh', ww: 820, strokes: [{ p }], charStart: 0, charEnd: 4, w: 60, dx: 0, dy: 0 };
  assert.ok(F.isEnclosure(g));
  let calls = 0, font = 'a';
  const el = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const env = { lineEl: () => el, local: (r) => r, colW: () => 1000, fontKey: () => font, encMemo: new WeakMap(), nowMemo: new WeakMap(),
    enclosedAt: () => { calls++; return null; }, runNow: () => null };
  const placed = [{ g, at: { ox: 0, oy: 0, s: 1 }, orphan: false }];
  F.followEnclosures(placed, [g], env); F.followEnclosures(placed, [g], env);
  const sameFont = calls; font = 'b'; F.followEnclosures(placed, [g], env);
  assert.ok(sameFont >= 1 && calls > sameFont, `same font reuses (${sameFont}), new font re-measures (${calls})`);
});
