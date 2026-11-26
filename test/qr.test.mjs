import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { qrMatrix } from '../lib/qr.mjs';
import { skipBecause } from './helpers-skip.mjs';

// Structural guards for the dependency-free encoder, PLUS an automated
// end-to-end decode proof against the OS decoder (CoreImage CIDetector) —
// see the "empirical decode proof" tests below (skip-with-note off macOS).

test('short text → version 1 (21x21); realistic setup payload fits ≤ v6', () => {
  const m = qrMatrix('HELLO WORLD');
  assert.equal(m.size, 21);
  const setup = qrMatrix(JSON.stringify({ u: 'http://superelf-host.tail1234.ts.net:8787/api/health/ingest', t: 'A'.repeat(32) }));
  assert.ok(setup && setup.size <= 41, 'must fit the supported versions');
});

test('finder patterns + timing pattern + dark module are in place', () => {
  const { size, rows } = qrMatrix('test');
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(rows[r0][c0], 1, 'finder corner dark');
    assert.equal(rows[r0 + 3][c0 + 3], 1, 'finder center dark');
    assert.equal(rows[r0 + 1][c0 + 1], 0, 'finder inner ring light');
  }
  for (let i = 8; i < size - 8; i++) assert.equal(rows[6][i], i % 2 === 0 ? 1 : 0, 'timing row alternates');
  assert.equal(rows[size - 8][8], 1, 'fixed dark module');
});

test('deterministic output; cells are strictly 0/1', () => {
  const a = qrMatrix('determinism'), b = qrMatrix('determinism');
  assert.deepEqual(a.rows.map((r) => [...r]), b.rows.map((r) => [...r]));
  for (const row of a.rows) for (const v of row) assert.ok(v === 0 || v === 1);
});

test('over-capacity text → null (caller falls back to copyable text, never a broken code)', () => {
  assert.equal(qrMatrix('x'.repeat(200)), null);
  assert.ok(qrMatrix('x'.repeat(130)), 'v6 capacity still encodes');
});

// ── Empirical decode proof (R6/R14) ───────────────────────────────────────────
// The R13 review claimed placeFormat writes the 15 format-info bits in REVERSED
// index order ("real scanners cannot decode it"). Settled empirically below:
// the OS decoder round-trips the EXACT text at v1/v5/v6, and the same matrix
// rewritten with the reviewer's reversed order does NOT decode (so the harness
// has teeth — it is not vacuously passing). Why the code is correct: each of
// placeFormat's two lines writes HALF of ISO 18004's copy-1 and HALF of copy-2
// (line 1 = col 8: rows 0-8 carry bits 0-7 of copy-1, bottom rows size-7..size-1
// carry bits 8-14 of copy-2; line 2 = row 8: right cols carry bits 0-7 of
// copy-2, left cols 7,5..0 carry bits 8-14 of copy-1) — the same layout as the
// reference (Nayuki) encoder, just merged by bit index instead of by copy.

// Minimal grayscale PNG writer (no deps) — enough for the detector.
function crc32(buf) {
  let c; const table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function matrixToPng(m, scale = 8, quiet = 4) {
  const px = (m.size + quiet * 2) * scale;
  const raw = Buffer.alloc(px * (px + 1), 0xff);   // each row prefixed with filter byte 0
  for (let y = 0; y < px; y++) {
    const row = y * (px + 1); raw[row] = 0;
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - quiet;
      raw[row + 1 + x] = (my >= 0 && my < m.size && mx >= 0 && mx < m.size && m.rows[my][mx] === 1) ? 0 : 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0); ihdr.writeUInt32BE(px, 4); ihdr[8] = 8; ihdr[9] = 0;   // 8-bit grayscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

const JXA_DECODER = `
ObjC.import('Cocoa'); ObjC.import('CoreImage'); ObjC.import('Quartz');
function run(argv) {
  const img = $.CIImage.imageWithContentsOfURL($.NSURL.fileURLWithPath(argv[0]));
  if (img.isNil()) return 'ERROR: cannot load image';
  const det = $.CIDetector.detectorOfTypeContextOptions($.CIDetectorTypeQRCode, $.CIContext.context,
    $({ CIDetectorAccuracy: 'CIDetectorAccuracyHigh' }));
  const feats = det.featuresInImage(img);
  if (feats.count == 0) return 'NO_DECODE';
  return 'DECODED:' + ObjC.unwrap(feats.objectAtIndex(0).messageString);
}`;

// Decode one matrix with the OS detector. Returns { text } or { unavailable }
// (non-macOS / osascript missing / frameworks unavailable → callers skip-with-note).
function osDecode(m) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-decode-'));
  const img = path.join(dir, 'qr.png'); fs.writeFileSync(img, matrixToPng(m));
  const js = path.join(dir, 'decode.js'); fs.writeFileSync(js, JXA_DECODER);
  const r = spawnSync('osascript', ['-l', 'JavaScript', js, img], { encoding: 'utf8', timeout: 30000 });
  if (r.error || r.status !== 0 || !r.stdout) return { unavailable: true, detail: (r.error && r.error.message) || (r.stderr || '').trim() };
  return { text: r.stdout.trim() };
}
const SETUP_PAYLOAD = JSON.stringify({ u: 'http://superelf-host.tail1234.ts.net:8787/api/health/ingest', t: 'A'.repeat(32) });

test('empirical decode proof: OS decoder round-trips the exact text (v1 / realistic v5 payload / v6)', (t) => {
  for (const text of ['HELLO WORLD', SETUP_PAYLOAD, 'x'.repeat(130)]) {
    const d = osDecode(qrMatrix(text));
    if (d.unavailable) return t.skip(skipBecause('darwin-only', `macOS CIDetector unavailable here (${d.detail || 'no osascript'}) — decode proof runs on macOS only`));
    assert.equal(d.text, 'DECODED:' + text);
  }
});

test('decode-proof teeth: the review\'s "reversed format bits" variant must NOT decode (and blank must not)', (t) => {
  const m = qrMatrix(SETUP_PAYLOAD);
  // Read the format bits back through placeFormat's own layout, then rewrite
  // BOTH copies in reversed index order — exactly the ordering the review
  // claimed the spec requires. A real decoder must reject it.
  const bits = [];
  for (let i = 0; i < 15; i++) bits.push(i < 6 ? m.rows[i][8] : i < 8 ? m.rows[i + 1][8] : m.rows[m.size - 15 + i][8]);
  const rev = [...bits].reverse();
  for (let i = 0; i < 15; i++) {
    const v = rev[i];
    if (i < 6) m.rows[i][8] = v; else if (i < 8) m.rows[i + 1][8] = v; else m.rows[m.size - 15 + i][8] = v;
    if (i < 8) m.rows[8][m.size - i - 1] = v; else if (i < 9) m.rows[8][15 - i] = v; else m.rows[8][15 - i - 1] = v;
  }
  const d = osDecode(m);
  if (d.unavailable) return t.skip(skipBecause('darwin-only', 'macOS CIDetector unavailable — teeth check runs on macOS only'));
  assert.equal(d.text, 'NO_DECODE', 'reversed order is NOT valid — the shipped order is the correct one');
  const blank = { size: 21, rows: Array.from({ length: 21 }, () => new Uint8Array(21)) };
  assert.equal(osDecode(blank).text, 'NO_DECODE', 'detector does not hallucinate successes');
});
