// The ONE test that runs Apple Vision for real: tools/panote-ocr compiled by lib/note-ocr.mjs
// ensureBuilt, a PNG of printed text rendered by the tool's own `text` mode, read back through
// ocrImage. Gated: on a Mac with swiftc (or an already built tool) it runs; anywhere else it is
// SKIPPED with the reason — a skip, never a vacuous pass (R14). No fixture image is committed and no
// owner page is read: the words are this test's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ocrPossible, ensureBuilt, runTool, ocrImage, ocrInk } from '../lib/note-ocr.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skipBecause } from './helpers-skip.mjs';

const available = process.platform === 'darwin' && ocrPossible();
const WHY = process.platform !== 'darwin' ? 'Apple Vision needs macOS' : 'no swiftc on PATH and no built tools/panote-ocr';

test('real Vision: the tool builds, OCRs printed text it rendered itself, and reads real ink strokes', { skip: available ? false : skipBecause('darwin-only', WHY), timeout: 240000 }, async () => {
  const built = await ensureBuilt();
  assert.equal(built.ok, true, `ensureBuilt: ${built.error || ''}`);
  assert.ok(fs.existsSync(built.bin), 'the binary is on disk (gitignored build dir)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-vision-'));
  try {
    const png = path.join(dir, 'printed.png');
    const made = await runTool(['text', 'Meeting with Yue about ores Friday', png]);
    assert.equal(made.ok, true, `text mode: ${made.error || ''}`);
    assert.ok(fs.statSync(png).size > 0);
    const r = await ocrImage(png);
    assert.equal(r.ok, true, `ocrImage: ${r.error || ''}`);
    assert.match(r.text.toLowerCase(), /meeting/, `the printed word comes back; got: ${JSON.stringify(r.text)}`);
    assert.match(r.text.toLowerCase(), /friday/);
    assert.ok(r.lines.every((l) => l.box.length === 4 && l.box.every((n) => n >= 0 && n <= 1)), 'boxes are normalised');
    assert.ok(Array.isArray(r.labels), 'labels come back as a list (what Vision calls a page of text is its own business)');
    assert.ok(r.ms >= 0 && r.ms < 30000);
    // Ink: a synthetic "I" and "—" are not words; the contract under test is that two passes run on
    // real strokes without failing and the union is a string. Accuracy is measured on real pages
    // outside the suite (docs/adr/0023-note-search.md, phase 2).
    const strokes = [{ c: '#141414', w: 0.004, p: Array.from({ length: 20 }, (_, i) => [0.3, 0.1 + i * 0.01, 0.5]) },
      { c: '#141414', w: 0.004, p: Array.from({ length: 20 }, (_, i) => [0.2 + i * 0.01, 0.3, 0.5]) }];
    const ink = await ocrInk(strokes);
    assert.equal(ink.ok, true, `ocrInk: ${ink.error || ''}`);
    assert.equal(typeof ink.text, 'string');
    assert.ok(ink.lines.every((l) => l.pass === 'zh' || l.pass === 'en'));
  } finally { rmTemp(dir); }
});
